'use strict';
/*
 * Polygon custom-token Refer & Earn Airdrop Bot — built for Render
 *  - users / balances / settings live in PostgreSQL (survive restarts)
 *  - auto-pay: the bot signs an ERC-20 transfer on Polygon from a hot wallet and broadcasts it
 *  - the token contract, RPC, texts and amounts are set from the /admin panel
 */
const http = require('http');
const he = require('he');
const { Pool } = require('pg');
const { ethers } = require('ethers'); // v6
const { toHTML } = require('@telegraf/entity');
const { Telegraf, session, Scenes } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { BaseScene: Scene, Stage } = Scenes;

/* ====================================================================
 *  CONFIG  (secrets come from Render environment variables)
 * ==================================================================== */
const CONFIG = {
  BOT_TOKEN: (process.env.BOT_TOKEN || 'PASTE_NEW_BOT_TOKEN_HERE').trim(),
  DATABASE_URL: (process.env.DATABASE_URL || '').trim(),
  DATABASE_SSL: process.env.DATABASE_SSL === 'true', // true only if you use Render's EXTERNAL db url

  // Hot wallet private key (create one with: node gen-wallet.js). It pays withdrawals.
  PRIVATE_KEY: (process.env.PRIVATE_KEY || '').trim(),

  // Polygon RPC. Can also be changed in /admin -> Withdraw Settings -> RPC Url
  POLYGON_RPC: (process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com').trim(),
  CHAIN_ID: 137,
  MIN_PRIORITY_GWEI: Number(process.env.MIN_PRIORITY_GWEI) || 30, // Polygon needs at least 25 gwei
  MAX_WITHDRAW_PER_TX: 0 // max tokens per withdrawal request, 0 = no limit
};

/* ====================================================================
 *  Pure helpers
 * ==================================================================== */
// round DOWN so we never pay more than was deducted
function floorTo(n, d) {
  const f = Math.pow(10, d);
  return Math.floor(Number(n) * f + 1e-9) / f;
}

module.exports = { floorTo }; // exported for tests

if (require.main !== module) return; // when imported by a test, stop here

if (CONFIG.BOT_TOKEN.startsWith('PASTE_') || !CONFIG.DATABASE_URL) {
  console.error('Set the BOT_TOKEN and DATABASE_URL environment variables first.');
  process.exit(1);
}

// default settings (seed). After first start the live copy is kept in the database.
let data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

const options = [
  'Welcome Message', 'Wallet Message', 'Information', 'Bonus', 'Refer', 'Withdraw', 'Currency',
  'Broad Speed', 'Add Check', 'Remove Check', 'Withdraw Settings', 'Add Admin', 'Remove Admin',
  'Bot Off Text', 'On / Off Bot'
];
const withdraw_options = ['Auto Instant', 'Manual', 'Token Contract', 'RPC Url', 'Block-Chain Url', 'Payout Channel', 'Wallet Balance', '⬅️ Back'];

const slug = (w) => w.replace(/ /g, '-').toLowerCase();
const cb = (w) => 'adhymn_' + slug(w);
const chunk2 = (arr) => { const r = []; for (let i = 0; i < arr.length; i += 2) r.push(arr.slice(i, i + 2)); return r; };
const adminRows = () => chunk2(options.map((w) => ({ text: w, callback_data: cb(w) })));
const wdRows = () => chunk2(withdraw_options.map((w) => ({
  text: (w.includes('Auto') || w.includes('Manual')) ? (slug(w) === data.with_type ? w + '✅' : w + '❌') : w,
  callback_data: cb(w)
})));

const isAdmin = (id) => data.bot_admin.includes(id);
const round8 = (n) => Math.round(Number(n) * 1e8) / 1e8;
const fmt = (n) => Number(n || 0).toFixed(8).replace(/\.?0+$/, '');
const isNumeric = (n) => !isNaN(parseFloat(n)) && isFinite(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortMsg = (e) => String((e && (e.shortMessage || e.message)) || e).replace(/\s+/g, ' ').slice(0, 200);
const tokenDecimals = () => (data.token_decimals === undefined || data.token_decimals === null ? 18 : Number(data.token_decimals));
const payDecimals = () => Math.min(8, tokenDecimals()); // balances are kept with up to 8 decimals
const txLink = (hash) => (String(data.block_url).includes('{txid}') ? String(data.block_url).replace('{txid}', hash) : data.block_url + hash);

/* ====================================================================
 *  PostgreSQL
 * ==================================================================== */
const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: CONFIG.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 8
});
pool.on('error', (e) => console.log('DB pool error:', e.message));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      reset BOOLEAN NOT NULL DEFAULT false,
      ref_count INT GENERATED ALWAYS AS (
        CASE WHEN jsonb_typeof(data->'ref') = 'array' THEN jsonb_array_length(data->'ref') ELSE 0 END
      ) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_address_uq ON users ((data->>'address')) WHERE data->>'address' IS NOT NULL;
    CREATE INDEX IF NOT EXISTS users_ref_idx ON users (ref_count DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY, user_id BIGINT, address TEXT, amount NUMERIC,
      txid TEXT, status TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function loadSettings() {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'config'");
  const seed = data; // values from data.json
  if (r.rows[0]) {
    const saved = r.rows[0].value;
    data = { ...seed, ...saved, but: seed.but }; // button layout always comes from data.json
    data.bot_admin = [...new Set([...seed.bot_admin, ...(data.bot_admin || [])])]; // seed admins can't be locked out
    // raise "seed_version" in data.json to make the texts in data.json replace the saved ones
    if ((seed.seed_version || 0) > (saved.seed_version || 0)) {
      data.welcome = seed.welcome;
      data.address = seed.address;
      data.info = seed.info;
      data.seed_version = seed.seed_version;
      await saveData();
    }
  } else await saveData();
}
const saveData = () => pool.query(
  "INSERT INTO settings(key, value) VALUES('config', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [data]);

async function getUserData(id) {
  const r = await pool.query('SELECT data FROM users WHERE id = $1', [id]);
  return r.rows[0] ? r.rows[0].data : {};
}

/*
 * Safe read-modify-write on one user inside a transaction with a row lock.
 * fn(user) mutates `user` in place and may return a value. If the user doesn't exist,
 * fn gets null (or a new empty user when create = true).
 */
async function withUser(id, fn, create = false) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let r = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [id]);
    let u = null;
    if (r.rows.length) u = r.rows[0].data;
    else if (create) {
      await c.query('INSERT INTO users(id, data) VALUES($1, $2) ON CONFLICT (id) DO NOTHING', [id, {}]);
      r = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [id]);
      u = r.rows[0].data;
    }
    const result = await fn(u);
    if (u) await c.query('UPDATE users SET data = $2 WHERE id = $1', [id, u]);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Telegraf session (scene state) stored in the database so restarts don't break flows
const pgSessionStore = {
  async get(key) { const r = await pool.query('SELECT value FROM sessions WHERE key = $1', [key]); return r.rows[0] ? r.rows[0].value : undefined; },
  async set(key, value) { await pool.query('INSERT INTO sessions(key, value) VALUES($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, value]); },
  async delete(key) { await pool.query('DELETE FROM sessions WHERE key = $1', [key]); }
};

const logWithdrawal = async (uid, addr, amt, status) =>
  (await pool.query('INSERT INTO withdrawals(user_id, address, amount, status) VALUES($1,$2,$3,$4) RETURNING id', [uid, addr, amt, status])).rows[0].id;
const updateWithdrawal = (id, status, txid, err) =>
  pool.query('UPDATE withdrawals SET status = $2, txid = $3, error = $4 WHERE id = $1', [id, status, txid || null, err || null]);

async function refund(uid, amt) {
  await withUser(uid, (u) => { u.bal = round8((Number(u.bal) || 0) + Number(amt)); });
}

/* ====================================================================
 *  Polygon: provider, hot wallet, token, ERC-20 transfer
 * ==================================================================== */
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
];
const erc20 = new ethers.Interface(ERC20_ABI);
const polyNet = ethers.Network.from(CONFIG.CHAIN_ID);

let provider = null;
let hotWallet = null;
let nextNonce = 0;

const rpcUrl = () => String(data.rpc_url || CONFIG.POLYGON_RPC).trim();
function setupProvider() {
  provider = new ethers.JsonRpcProvider(rpcUrl(), polyNet, { staticNetwork: polyNet });
}
function setupWallet() {
  if (!CONFIG.PRIVATE_KEY) return;
  try {
    hotWallet = new ethers.Wallet(CONFIG.PRIVATE_KEY.startsWith('0x') ? CONFIG.PRIVATE_KEY : '0x' + CONFIG.PRIVATE_KEY);
  } catch (e) {
    console.error('PRIVATE_KEY is not a valid private key:', shortMsg(e));
  }
}

// errors where we are SURE nothing was sent get safe = true (balance can be refunded automatically)
const safeError = (msg) => Object.assign(new Error(msg), { safe: true });

async function readToken(addr) {
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const decimals = Number(await c.decimals());
  let symbol = 'TOKEN';
  let name = '';
  try { symbol = await c.symbol(); } catch (e) { /* some tokens do not follow the standard */ }
  try { name = await c.name(); } catch (e) { /* ignore */ }
  return { decimals, symbol, name };
}

function hintFor(msg) {
  const m = String(msg);
  if (/PRIVATE_KEY/i.test(m)) return 'Add the PRIVATE_KEY environment variable in Render (hot wallet key from gen-wallet.js), then redeploy.';
  if (/Token contract is not set/i.test(m)) return 'Set it: /admin -> Withdraw Settings -> Token Contract.';
  if (/token balance/i.test(m)) return 'The hot wallet has too few tokens. Send the token to the hot wallet address (on Polygon).';
  if (/POL for gas|gas/i.test(m) && /Insufficient/i.test(m)) return 'The hot wallet needs POL for gas fees. Send a small amount of POL (Polygon) to the hot wallet address.';
  if (/RPC problem|could not|timeout|network|ECONN|ENOTFOUND|SERVER_ERROR/i.test(m)) return 'The Polygon RPC is not answering. Try again, or set another one: /admin -> Withdraw Settings -> RPC Url.';
  if (/would fail|revert/i.test(m)) return 'The token contract refuses this transfer (blocked address, paused token, or not enough balance).';
  return '';
}

async function doSendToken(to, units) {
  if (!hotWallet) throw safeError('Hot wallet key (PRIVATE_KEY) is not configured');
  if (!data.token_contract) throw safeError('Token contract is not set');
  const dataHex = erc20.encodeFunctionData('transfer', [to, units]);
  let nonce, gasLimit, maxFee, tip;
  try {
    const token = new ethers.Contract(data.token_contract, ERC20_ABI, provider);
    const bal = await token.balanceOf(hotWallet.address);
    if (bal < units) {
      throw safeError('Insufficient token balance in hot wallet (has ' + ethers.formatUnits(bal, tokenDecimals()) + ', needs ' + ethers.formatUnits(units, tokenDecimals()) + ')');
    }
    let est;
    try { est = await provider.estimateGas({ from: hotWallet.address, to: data.token_contract, data: dataHex }); }
    catch (e) { throw safeError('Transfer would fail: ' + shortMsg(e)); }
    gasLimit = (est * 130n) / 100n;
    const blk = await provider.getBlock('latest');
    const fd = await provider.getFeeData();
    const minTip = ethers.parseUnits(String(CONFIG.MIN_PRIORITY_GWEI), 'gwei');
    tip = fd.maxPriorityFeePerGas && fd.maxPriorityFeePerGas > minTip ? fd.maxPriorityFeePerGas : minTip;
    const base = (blk && blk.baseFeePerGas) || 0n;
    maxFee = base * 2n + tip;
    const pol = await provider.getBalance(hotWallet.address);
    if (pol < gasLimit * maxFee) throw safeError('Insufficient POL for gas in hot wallet (has ' + ethers.formatEther(pol) + ' POL)');
    const chainNonce = await provider.getTransactionCount(hotWallet.address, 'pending');
    nonce = Math.max(chainNonce, nextNonce);
  } catch (e) {
    if (e.safe) throw e;
    throw safeError('Polygon RPC problem: ' + shortMsg(e)); // nothing was signed or sent yet
  }

  const signed = await hotWallet.signTransaction({
    type: 2, chainId: CONFIG.CHAIN_ID, to: data.token_contract, data: dataHex, value: 0n,
    nonce, gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip
  });
  const hash = ethers.Transaction.from(signed).hash;
  try {
    await provider.broadcastTransaction(signed);
  } catch (e) {
    const m = shortMsg(e);
    if (/already known|known transaction/i.test(m)) { nextNonce = nonce + 1; return hash; } // same tx is already in the pool
    if (/insufficient funds|nonce too low|underpriced|exceeds|intrinsic gas|revert/i.test(m) ||
        ['INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED', 'UNPREDICTABLE_GAS_LIMIT'].includes(e && e.code)) {
      throw safeError('Broadcast rejected: ' + m);
    }
    // unknown: maybe it went through. Check by hash before giving up.
    await sleep(4000);
    const seen = await provider.getTransaction(hash).catch(() => null);
    if (seen) { nextNonce = nonce + 1; return hash; }
    throw Object.assign(new Error('Broadcast outcome unknown: ' + m), { safe: false, hash });
  }
  nextNonce = nonce + 1;
  return hash;
}

// one transaction at a time, so two payouts never use the same nonce
let sendQueue = Promise.resolve();
function sendToken(to, amt) {
  const units = ethers.parseUnits(floorTo(amt, payDecimals()).toFixed(payDecimals()), tokenDecimals());
  const p = sendQueue.then(() => doSendToken(to, units));
  sendQueue = p.catch(() => {});
  return p;
}

async function waitReceipt(hash, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const rc = await provider.getTransactionReceipt(hash);
      if (rc) return rc;
    } catch (e) { /* RPC hiccup, keep polling */ }
    await sleep(1500);
  }
  return null;
}

/* ====================================================================
 *  Bot + scenes
 * ==================================================================== */
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const stage = new Stage();
const botStartTime = Date.now();

const address = new Scene('address');
const onWithdraw = new Scene('onWithdraw');
const getMsg = new Scene('getMsg');
stage.register(address, onWithdraw, getMsg);

bot.use(session({ store: pgSessionStore }));
bot.use(stage.middleware());

async function notifyAdmins(text) {
  for (const id of data.bot_admin) bot.telegram.sendMessage(id, text, { disable_web_page_preview: true }).catch(() => {});
}

bot.on('message', async (ctx, next) => {
  if (ctx.chat.type !== 'private' || ctx.message.date * 1000 < botStartTime - 10 * 60 * 1000) return;
  if (ctx.message.text === '/cancel') {
    ctx.replyWithMarkdown('*Done*');
    ctx.scene.leave();
    return;
  }
  const fwd = ctx.message.forward_from_chat || (ctx.message.forward_origin && ctx.message.forward_origin.chat);
  if (fwd && isAdmin(ctx.from.id)) { // helper: forward any post of a channel to get its numeric ID
    return ctx.reply('📢 ' + (fwd.title || '') + '\nChat ID: ' + fwd.id + (fwd.username ? '\nUsername: @' + fwd.username : '') +
      '\n\nUse /admin -> Add Check and send this ' + (fwd.username ? 'username' : 'ID') + ' to enforce joining.');
  }
  if (data.bot || isAdmin(ctx.from.id)) return next();
  ctx.replyWithHTML(data.bot_text);
});

async function check(ctx, next) {
  const u = await getUserData(ctx.from.id);
  if (!u.address) return ctx.replyWithMarkdown('*Register Now With /start*');
  await next();
}

/* ---------------- registration: /start -> Join Airdrop -> wallet address -> home ---------------- */
bot.start(async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return;
    const uid = ctx.from.id;
    const ref = Number(ctx.startPayload);
    let validRef = false;
    if (ref && ref !== uid) validRef = !!(await getUserData(ref)).address; // referrer must be registered

    const isNew = await withUser(uid, (u) => {
      if (u.bal !== undefined) return false;
      u.bal = 0; // the signup bonus is paid when the wallet address is submitted
      u.ref = [];
      if (validRef) u.pendref = ref;
      return true;
    }, true);

    if (isNew && validRef) {
      bot.telegram.sendMessage(ref,
        '<a href="tg://user?id=' + uid + '"><b>' + he.encode(ctx.from.first_name) + '</b></a> <b>Has started bot with your refer link.</b>\n<i>You will be rewarded when he complete his registration</i>',
        { parse_mode: 'HTML' }).catch(() => {});
    }
    ctx.reply(data.welcome, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '✅ Join Airdrop', callback_data: 'next' }]] }
    });
  } catch (e) { console.log(e); }
});

bot.action('next', async (ctx) => {
  try {
    for (const ch of data.check) { // optional channel check (empty list = no check)
      let status;
      try {
        status = (await bot.telegram.getChatMember(/^-?\d+$/.test(String(ch)) ? Number(ch) : ch, ctx.from.id)).status;
      } catch (e) {
        console.log('Cannot verify ' + ch + ' (is the bot admin there?): ' + e.message);
        continue;
      }
      if (!['creator', 'administrator', 'member'].includes(status)) {
        await ctx.answerCbQuery().catch(() => {});
        return ctx.replyWithMarkdown('*Must Join All Channels First*');
      }
    }
    await ctx.answerCbQuery().catch(() => {});
    const u = await getUserData(ctx.from.id);
    if (u.bal === undefined) return ctx.reply('Register with /start first');
    ctx.deleteMessage().catch(() => {});
    await ctx.reply(data.address, { parse_mode: 'HTML', disable_web_page_preview: true });
    ctx.scene.enter('address');
  } catch (e) { console.log(e); }
});

address.on('text', async (ctx) => {
  try {
    const uid = ctx.from.id;
    const raw = ctx.message.text.trim();
    if (!ethers.isAddress(raw)) {
      return ctx.replyWithMarkdown('❌ *Not a valid Polygon wallet address.*\nIt must be 0x followed by 40 hex characters. Please send it again.');
    }
    const addr = ethers.getAddress(raw); // checksummed form
    let refId = null;
    try {
      refId = await withUser(uid, (u) => {
        u.address = addr;
        if (!u.bonus_given) { // signup bonus, only once
          u.bal = round8((Number(u.bal) || 0) + Number(data.bonus || 0));
          u.bonus_given = true;
        }
        const r = u.pendref;
        delete u.pendref;
        if (r && !u.invited) { u.invited = r; return r; }
        return null;
      }, true);
    } catch (e) {
      if (e.code === '23505') { // unique index: address already used by another account
        return ctx.replyWithMarkdown('❌ *This address is already registered by another account.* Please send a different one.');
      }
      throw e;
    }
    await ctx.scene.leave();

    if (refId) {
      const ok = await withUser(refId, (r) => {
        if (!r || r.bal === undefined) return false;
        r.bal = round8((Number(r.bal) || 0) + Number(data.reffer_bonus || 0));
        r.ref = r.ref || [];
        if (!r.ref.includes(uid)) r.ref.push(uid);
        return true;
      });
      if (ok) {
        bot.telegram.sendMessage(refId,
          '*🎯 A New Referral has registered the bot using your referral link :* [' + ctx.from.first_name.replace(/[\[\]_*`]/g, '') + '](tg://user?id=' + uid + ')',
          { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
    ctx.replyWithMarkdown('*🎉 Welcome In Our ' + data.bot_cur + ' Airdrop*',
      { disable_web_page_preview: true, reply_markup: { keyboard: data.but, resize_keyboard: true } });
  } catch (e) { console.log(e); }
});

/* ---------------- user menu ---------------- */
bot.hears('📊 Statistics', check, async (ctx) => {
  const u = await getUserData(ctx.from.id);
  const pos = await pool.query('SELECT COUNT(*) + 1 AS p FROM users WHERE ref_count > (SELECT ref_count FROM users WHERE id = $1)', [ctx.from.id]);
  const inv = u.invited ? '<a href="tg://user?id=' + u.invited + '"><b>' + u.invited + '</b></a>' : '<b>N/A</b>';
  ctx.reply(`<b>👋Hello <a href="tg://user?id=${ctx.from.id}"><b>${he.encode(ctx.from.first_name)}</b></a> Here is your statistics </b>

<b>===============================
🔗 You are invited by</b> ${inv}
<b>👫 Referral :</b> ${(u.ref || []).length}
<b>📊 Airdrop balance:</b> ${fmt(u.bal)} ${he.encode(data.bot_cur)}
<b>🏆 Your position:</b> ${pos.rows[0].p}
<b>🙇‍♀️ Your personal referral link:</b> <code>https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}</code>

<b>===============================

👨‍✈️ Telegram:</b> <a href="tg://user?id=${ctx.from.id}"><b>${ctx.from.id}</b></a>
<b>📥 Wallet: </b> <code>${he.encode(u.address || 'N/A')}</code>

<b><i>‼️ If your submitted data is wrong you can restart the bot with /start and resubmit it before the airdrop ends.</i></b>`,
    { parse_mode: 'HTML', disable_web_page_preview: true });
});

// ℹ️ Information: text set by the admin (/admin -> Information), plus the token contract if one is set
bot.hears('ℹ️ Information', async (ctx) => {
  let text = data.info || 'No information has been added yet.';
  if (data.token_contract) {
    text += '\n\n<b>🪙 Token:</b> ' + he.encode((data.token_name ? data.token_name + ' ' : '') + '(' + (data.token_symbol || data.bot_cur) + ')') +
      '\n<b>🌐 Network:</b> Polygon\n<b>📄 Contract:</b> <code>' + data.token_contract + '</code>';
  }
  ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => ctx.reply(text.replace(/<[^>]+>/g, '')));
});

bot.hears('/stat', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const r = await pool.query('SELECT COUNT(*) AS n FROM users');
  ctx.replyWithMarkdown('*Total : ' + r.rows[0].n + ' Users*');
});

/* ---------------- withdraw (auto-pay on Polygon) ---------------- */
bot.hears('📤 Withdraw', check, async (ctx) => {
  const u = await getUserData(ctx.from.id);
  const bal = Number(u.bal) || 0;
  if (bal < data.min_wd) {
    return ctx.reply('🔐 To withdraw, you need to complete the following missions:\n\n👥 At least ' + data.min_wd + ' ' + data.bot_cur + ' in Balance\n🌀 Status: ' + fmt(bal) + ' / ' + data.min_wd);
  }
  await ctx.reply('*📤 Enter the amount to be withdrawn to your wallet*\n\n*Address*\n`' + u.address + '`\n\n*Available for withdrawal*\n`' + fmt(bal) + ' ' + data.bot_cur + '`',
    { parse_mode: 'Markdown', reply_markup: { keyboard: [['Back 🔙']], resize_keyboard: true } });
  ctx.scene.enter('onWithdraw');
});

bot.hears('Back 🔙', check, (ctx) =>
  ctx.replyWithMarkdown('_Welcome Back_', { reply_markup: { keyboard: data.but, resize_keyboard: true } }));

onWithdraw.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const kb = { keyboard: data.but, resize_keyboard: true };
  try {
    await ctx.scene.leave();
    const text = ctx.message.text.trim();
    if (text === 'Back 🔙') return ctx.replyWithMarkdown('_Welcome Back_', { reply_markup: kb });
    if (!isNumeric(text)) return ctx.replyWithMarkdown('❌ _Send a value that is numeric or a number_', { reply_markup: kb });
    const amt = floorTo(Number(text), payDecimals());

    if (data.with_type !== 'manual' && (!hotWallet || !data.token_contract)) { // nothing is deducted
      notifyAdmins('⚠️ A user tried to withdraw but auto-pay is not ready (token contract or PRIVATE_KEY missing). Run /diag');
      return ctx.reply('⚠️ Withdrawals are not available right now. Please try again later.', { reply_markup: kb });
    }

    // check + deduct in ONE locked transaction, so it can never be spent twice
    const r = await withUser(uid, (u) => {
      const bal = Number(u.bal) || 0;
      if (!u.address) return { err: 'noreg' };
      if (amt <= 0 || amt < data.min_wd || amt > bal) return { err: 'range', bal };
      if (CONFIG.MAX_WITHDRAW_PER_TX > 0 && amt > CONFIG.MAX_WITHDRAW_PER_TX) return { err: 'max' };
      u.bal = round8(bal - amt);
      return { wallet: u.address };
    });
    if (r.err === 'noreg') return ctx.replyWithMarkdown('*Register Now With /start*');
    if (r.err === 'range') {
      return ctx.replyWithMarkdown('😐 Send a value of at least *' + data.min_wd + ' ' + data.bot_cur + '* and not greater than *' + fmt(r.bal) + ' ' + data.bot_cur + '*', { reply_markup: kb });
    }
    if (r.err === 'max') return ctx.replyWithMarkdown('😐 Maximum per withdrawal is *' + CONFIG.MAX_WITHDRAW_PER_TX + ' ' + data.bot_cur + '*', { reply_markup: kb });

    if (data.with_type === 'manual') {
      await logWithdrawal(uid, r.wallet, amt, 'manual');
      bot.telegram.sendMessage(data.payout, '<code>' + r.wallet + ',' + fmt(amt) + '</code>', { parse_mode: 'HTML' }).catch(() => {});
      return ctx.replyWithMarkdown('*Withdraw Request Successfully Sent*', { reply_markup: kb });
    }
    await payInstant(ctx, uid, r.wallet, amt, kb);
  } catch (e) { console.log(e); }
});

async function payInstant(ctx, uid, wallet, amt, kb) {
  const wid = await logWithdrawal(uid, wallet, amt, 'pending');
  await ctx.reply('⏳ Sending your withdrawal...', { reply_markup: kb }).catch(() => {});
  try {
    const hash = await sendToken(wallet, amt); // signed + broadcast immediately
    await updateWithdrawal(wid, 'sent', hash);
    const link = txLink(hash);
    const rc = await waitReceipt(hash, 45000); // Polygon blocks take about 2 seconds
    if (rc && rc.status === 0) { // mined but failed on-chain: nothing was received, give the balance back
      await refund(uid, amt);
      await updateWithdrawal(wid, 'reverted_refunded', hash, 'transaction reverted on-chain');
      ctx.reply('❌ The transfer failed on the network. Your balance has been restored, please try again later.').catch(() => {});
      return notifyAdmins('⚠️ Transfer REVERTED on-chain (refunded): user ' + uid + ', ' + fmt(amt) + ' ' + data.bot_cur + '\n' + link + '\nCheck the token contract / hot wallet with /diag');
    }
    await updateWithdrawal(wid, rc ? 'confirmed' : 'sent', hash);
    ctx.reply((rc ? '✅ Withdraw Successful' : '✅ Withdrawal sent (waiting for network confirmation)') + '\n\n💰 Amount: ' + fmt(amt) + ' ' + data.bot_cur + '\n🏧 Transaction: ' + link, { disable_web_page_preview: true }).catch(() => {});
    const payText = '<b><u>🚀 New Withdrawal Paid!</u>\n\n🔰 User :</b> <a href="tg://user?id=' + uid + '"><b>' + he.encode(ctx.from.first_name) + '</b></a>\n<b>🔎 Address :</b> <code>' + wallet + '</code>\n<b>💲 Amount : ' + fmt(amt) + ' $' + he.encode(data.bot_cur) + '</b>\n<b>Payout Hash</b>: <a href="' + link + '"><b>' + hash + '</b></a>\n\n<b>🔃 Bot Link : @' + ctx.botInfo.username + '</b>';
    bot.telegram.sendMessage(data.payout, payText, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  } catch (err) {
    console.log('Withdraw error:', err.message);
    if (err.safe) { // nothing was broadcast -> give the balance back
      await refund(uid, amt);
      await updateWithdrawal(wid, 'failed_refunded', null, err.message);
      ctx.reply('❌ Withdrawal could not be processed right now. Your balance has been restored, please try again later.').catch(() => {});
      notifyAdmins('⚠️ Withdraw failed (refunded): user ' + uid + ', ' + fmt(amt) + ' ' + data.bot_cur + '\nReason: ' + err.message + (hintFor(err.message) ? '\n\n👉 ' + hintFor(err.message) : '') + '\n\nRun /diag for a full check.');
    } else { // unknown outcome: NOT refunded automatically, to avoid paying twice
      await updateWithdrawal(wid, 'review', err.hash || null, err.message);
      ctx.reply('⏳ Your withdrawal is being verified by the team. You will be notified shortly.').catch(() => {});
      notifyAdmins('🚨 MANUAL REVIEW needed\nWithdrawal #' + wid + '\nUser: ' + uid + '\nAmount: ' + fmt(amt) + ' ' + data.bot_cur + '\nAddress: ' + wallet + (err.hash ? '\nTx: ' + txLink(err.hash) : '') + '\nError: ' + err.message +
        '\n\nCheck the transaction on Polygonscan. If NOT paid: /resolve ' + wid + ' refund\nIf paid: /resolve ' + wid + ' paid');
    }
  }
}

/* ---------------- admin: /diag = full auto-pay self-check in plain words ---------------- */
bot.command('diag', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const L = ['🔎 Auto-pay check', ''];
  L.push('Mode: ' + (data.with_type === 'manual' ? 'MANUAL (requests go to the payout channel, nothing is sent automatically)' : 'AUTO INSTANT'));
  L.push(hotWallet ? '✅ Hot wallet key loaded: ' + hotWallet.address : '❌ PRIVATE_KEY is missing or invalid in Render -> Environment');
  L.push('RPC: ' + rpcUrl());
  try {
    const net = await provider.getNetwork();
    const bn = await provider.getBlockNumber();
    L.push('✅ Polygon RPC works (chain ' + net.chainId + ', block ' + bn + ')');
  } catch (e) {
    L.push('❌ RPC problem: ' + shortMsg(e));
    L.push('👉 ' + hintFor('RPC problem'));
  }
  if (!data.token_contract) L.push('❌ Token contract is NOT set: /admin -> Withdraw Settings -> Token Contract');
  else L.push('✅ Token: ' + (data.token_name || '') + ' (' + (data.token_symbol || '?') + '), ' + tokenDecimals() + ' decimals\n    ' + data.token_contract);
  if (hotWallet) {
    try {
      const pol = await provider.getBalance(hotWallet.address);
      L.push((pol > ethers.parseEther('0.05') ? '✅' : '⚠️') + ' POL for gas: ' + ethers.formatEther(pol).slice(0, 8) + ' POL' + (pol > ethers.parseEther('0.05') ? '' : '  (send a little POL for gas fees)'));
      if (data.token_contract) {
        const token = new ethers.Contract(data.token_contract, ERC20_ABI, provider);
        const tb = Number(ethers.formatUnits(await token.balanceOf(hotWallet.address), tokenDecimals()));
        const owedRow = (await pool.query("SELECT COALESCE(SUM((data->>'bal')::numeric), 0) AS s FROM users WHERE data ? 'bal'")).rows[0];
        const owed = owedRow ? Number(owedRow.s) : 0;
        L.push((tb > 0 ? '✅' : '❌') + ' Token in hot wallet: ' + fmt(tb) + ' ' + data.bot_cur);
        if (tb < owed) L.push('⚠️ Users together hold ' + fmt(owed) + ' ' + data.bot_cur + ', more than the wallet has. Top up before they withdraw.');
      }
    } catch (e) {
      L.push('❌ ' + shortMsg(e));
    }
  }
  ctx.reply(L.join('\n'), { disable_web_page_preview: true });
});

/* ---------------- admin: withdrawals, balances, delete data ---------------- */
bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const r = await pool.query("SELECT id, user_id, amount, address, status, txid, error FROM withdrawals WHERE status IN ('pending','review') ORDER BY id");
  if (!r.rows.length) return ctx.reply('No unresolved withdrawals ✅');
  ctx.reply(r.rows.map((w) => `#${w.id} user ${w.user_id}\n${fmt(w.amount)} ${data.bot_cur} -> ${w.address}\n${w.txid ? txLink(w.txid) + '\n' : ''}${w.status}: ${w.error || ''}`).join('\n\n'), { disable_web_page_preview: true });
});
bot.command('resolve', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id, action] = ctx.message.text.trim().split(/\s+/);
  if (!/^\d+$/.test(id || '') || !['refund', 'paid'].includes(action)) return ctx.reply('Usage: /resolve <id> refund|paid');
  const r = await pool.query("UPDATE withdrawals SET status = $2 WHERE id = $1 AND status IN ('pending','review') RETURNING user_id, amount",
    [id, action === 'refund' ? 'refunded' : 'paid_manual']);
  if (!r.rows[0]) return ctx.reply('Not found, or already resolved.');
  if (action === 'refund') await refund(r.rows[0].user_id, r.rows[0].amount);
  ctx.reply('Withdrawal #' + id + ' marked ' + action + '.');
});

// /addbal <telegram id> <amount>   -> add to a user's balance (negative amount removes)
bot.command('addbal', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id, amt] = ctx.message.text.trim().split(/\s+/);
  if (!/^\d+$/.test(id || '') || !isNumeric(amt)) return ctx.reply('Usage: /addbal <telegram id> <amount>\nExample: /addbal 5028581330 5');
  const n = round8(Number(amt));
  const res = await withUser(id, (u) => {
    if (!u || u.bal === undefined) return null;
    const nb = round8((Number(u.bal) || 0) + n);
    if (nb < 0) return 'neg';
    u.bal = nb;
    return nb;
  });
  if (res === null) return ctx.reply('User not found. They must press /start in the bot first.');
  if (res === 'neg') return ctx.reply('Balance cannot go below 0.');
  ctx.reply('✅ Balance of ' + id + ' is now ' + fmt(res) + ' ' + data.bot_cur);
});

// /deluser <telegram id>   -> removes one user so they can register again
bot.command('deluser', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = (ctx.message.text.split(/\s+/)[1] || '').trim();
  if (!/^\d+$/.test(id)) return ctx.reply('Usage: /deluser <telegram id>\nExample: /deluser 123456789');
  const r = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  await pool.query('DELETE FROM sessions WHERE key LIKE $1', [id + ':%']);
  ctx.reply(r.rows.length ? '🗑 User ' + id + ' deleted.' : 'User ' + id + ' not found.');
});

// /resetall CONFIRM   -> deletes ALL users and balances (settings and withdrawal history are kept)
bot.command('resetall', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  if ((ctx.message.text.split(/\s+/)[1] || '') !== 'CONFIRM') {
    return ctx.reply('⚠️ This deletes ALL users, balances and referrals and cannot be undone.\nTo continue send exactly:\n/resetall CONFIRM');
  }
  await pool.query('TRUNCATE users, sessions');
  ctx.reply('🗑 All users deleted. The bot is now empty (settings were kept).');
});

/* ---------------- broadcast ---------------- */
bot.command('broad', (ctx) => { if (isAdmin(ctx.from.id)) ctx.scene.enter('getMsg'); });
getMsg.enter((ctx) => ctx.replyWithMarkdown(' *Okay Admin 👮‍♂, Send your broadcast message*'));
getMsg.hears('⬅️ Back', (ctx) => ctx.scene.leave());
getMsg.on('text', async (ctx) => {
  await ctx.scene.leave();
  if (ctx.message.text.length > 3000) return ctx.reply('Message may not exceed 3000 characters.');
  globalBroadCast(ctx);
});

async function globalBroadCast(ctx) {
  const users = (await pool.query('SELECT id FROM users')).rows.map((r) => Number(r.id));
  const html = toHTML(ctx.message);
  let fail = 0;
  ctx.reply('Your message is queued and will be posted to all of your subscribers soon. Total subscribers: ' + users.length);
  for (const id of users) {
    try { await bot.telegram.sendMessage(id, html, { parse_mode: 'HTML' }); } catch (e) { fail++; }
    await sleep(data.broad_speed);
  }
  bot.telegram.sendMessage(ctx.from.id, '<b>Your message has been posted to all of your subscribers.</b>\n\n<b>Total User:</b> ' + users.length + '\n<b>Total Sent:</b> ' + (users.length - fail) + '\n<b>Total Failed:</b> ' + fail, { parse_mode: 'HTML' });
}

/* ---------------- admin panel ---------------- */
bot.command('admin', (ctx) => {
  if (isAdmin(ctx.from.id)) ctx.replyWithMarkdown('*Welcome admin :)*\n\n_Here Is Your Admin Panel._', { reply_markup: { inline_keyboard: adminRows() } });
});

// helper: a one-input admin scene. apply() returns an error string, or nothing on success.
function adminScene(name, doneMsg, apply, panel = 'main') {
  const sc = new Scene(name);
  sc.on('text', async (ctx) => {
    const txt = ctx.message.text.trim();
    if (txt === '/cancel') { await ctx.replyWithMarkdown('*Done*'); return ctx.scene.leave(); }
    const err = await apply(txt, ctx);
    if (err) return ctx.replyWithMarkdown(err);
    await saveData();
    await ctx.scene.leave();
    ctx.replyWithMarkdown('*' + doneMsg + '*\n\n_Here Is Your Admin Panel._',
      { reply_markup: { inline_keyboard: panel === 'wd' ? wdRows() : adminRows() } });
  });
  stage.register(sc);
}

const num = (txt) => (isNumeric(txt) && Number(txt) >= 0 ? null : '*Invalid Amount*');
adminScene('bonuss', 'Bonus Amount Has Updated :)', (t) => num(t) || void (data.bonus = Number(t)));
adminScene('referam', 'Refer Amount Has Updated :)', (t) => num(t) || void (data.reffer_bonus = Number(t)));
adminScene('minwd', 'Minimum Withdraw Amount Has Updated :)', (t) => num(t) || void (data.min_wd = Number(t)));
adminScene('broad', 'Broadcast Speed Updated :)', (t) => {
  if (!isNumeric(t) || Number(t) <= 0) return '*Invalid Amount*';
  if (Number(t) > 15) return 'Sorry, *Max 15 Users* per sec broadcast can be set.';
  data.broad_speed = 1000 / Number(t);
});
adminScene('addadmin', 'User Had Promoted :)', (t) => {
  if (!isNumeric(t)) return '*Invalid User ID*';
  if (data.bot_admin.includes(Number(t))) return 'This user is already admin';
  data.bot_admin.push(Number(t));
});
adminScene('rmvadmin', 'User Had Demoted :)', (t) => {
  if (!isNumeric(t)) return '*Invalid User ID*';
  if (!data.bot_admin.includes(Number(t))) return 'This user is not admin';
  data.bot_admin = data.bot_admin.filter((id) => id !== Number(t));
});
const chanVal = (t) => (/^-?\d+$/.test(t) ? Number(t) : (t.startsWith('@') ? t : null));
adminScene('acheck', 'Channel Has Added In Check :)', (t) => {
  const v = chanVal(t);
  if (v === null) return '*Invalid.* Send @username, or the numeric ID (like -100123...) for a private channel.';
  if (data.check.includes(v)) return 'This channel is already in check';
  data.check.push(v);
});
adminScene('rcheck', 'Channel Has Removed From Check :)', (t) => {
  const v = chanVal(t);
  if (v === null) return '*Invalid.* Send @username or numeric ID.';
  if (!data.check.includes(v)) return 'This channel is not in check';
  data.check = data.check.filter((c) => c !== v);
});
adminScene('currency', 'Your Currency Name Has Updated :)', (t) => { data.bot_cur = t; });
adminScene('blockurl', 'Your Block Chain URL Has Updated :)', (t) => { data.block_url = t; }, 'wd');
adminScene('payout', 'Your Payout Channel Has Updated :)', (t) => {
  if (!t.startsWith('@')) return '*Invalid Username*';
  data.payout = t;
}, 'wd');
adminScene('botoff', 'Bot Turned Off Message Has Updated :)', (t, ctx) => { data.bot_text = toHTML(ctx.message); });
adminScene('welcomemsg', 'Welcome Message Has Updated :)', (t, ctx) => { data.welcome = toHTML(ctx.message); });
adminScene('walletmsg', 'Wallet Message Has Updated :)', (t, ctx) => { data.address = toHTML(ctx.message); });
adminScene('infomsg', 'Information Has Updated :)', (t, ctx) => { data.info = toHTML(ctx.message); });

// token contract: validated against the chain, then symbol / decimals are read automatically
adminScene('tokencontract', 'Token Contract Has Updated :)', async (t, ctx) => {
  if (!ethers.isAddress(t)) return '*Invalid contract address.* It must be 0x followed by 40 hex characters.';
  let info;
  try { info = await readToken(ethers.getAddress(t)); }
  catch (e) { return '❌ *Could not read this token on Polygon.* Check that the address is a token contract on the Polygon network, and that the RPC works (/diag).'; }
  data.token_contract = ethers.getAddress(t);
  data.token_decimals = info.decimals;
  data.token_symbol = info.symbol;
  data.token_name = info.name;
  data.bot_cur = info.symbol; // shown everywhere; change it with the Currency button if you want another label
  await ctx.reply('✅ Token found: ' + (info.name || '') + ' (' + info.symbol + '), ' + info.decimals + ' decimals.\nCurrency name was set to ' + info.symbol + '.');
}, 'wd');

adminScene('rpcurl', 'RPC Url Has Updated :)', async (t) => {
  if (!/^https?:\/\//i.test(t)) return '*Invalid URL.* It must start with https://';
  try {
    const p = new ethers.JsonRpcProvider(t, polyNet, { staticNetwork: polyNet });
    const net = await p.getNetwork();
    await p.getBlockNumber();
    if (Number(net.chainId) !== CONFIG.CHAIN_ID) return '❌ This RPC is not Polygon mainnet.';
    p.destroy();
  } catch (e) { return '❌ *This RPC did not answer.* Try another URL.'; }
  data.rpc_url = t;
  setupProvider();
}, 'wd');

const prompts = {
  'welcome-message': ['Ok good, send me a new already formatted welcome text', 'welcomemsg'],
  'wallet-message': ['Ok good, send me the text that asks users for their wallet address (formatted, e.g. USDC (Polygon) wallet)', 'walletmsg'],
  'information': ['Ok good, send me the Information text (token details, links...). Formatting is kept. The token contract is added automatically.', 'infomsg'],
  'bonus': ['Ok good, send me the new signup bonus amount', 'bonuss'],
  'refer': ['Ok good, send me new refer amount', 'referam'],
  'withdraw': ['Ok good, send me new minimum withdraw amount', 'minwd'],
  'add-admin': ['Ok good, send me user id of user whom you wanna promote as admin', 'addadmin'],
  'remove-admin': ['Ok good, send me user id of user whom you wanna demote from admin', 'rmvadmin'],
  'broad-speed': ['Ok good, send me to how many users you wanna send broadcast per sec.', 'broad'],
  'currency': ['Ok good, send me currency name', 'currency'],
  'token-contract': ['Ok good, send me the token contract address on Polygon (0x...)', 'tokencontract'],
  'rpc-url': ['Ok good, send me a Polygon RPC URL (https://...)', 'rpcurl'],
  'block-chain-url': ['Ok good, send me the explorer TX link. Either end it where the txid goes (https://polygonscan.com/tx/) or put {txid} inside it', 'blockurl'],
  'payout-channel': ['Ok good, send me your payout channel username with @', 'payout'],
  'bot-off-text': ['Ok good, give me text to send to users when bot is off', 'botoff'],
  'add-check': ['Ok good, send the channel @username (or numeric ID like -100123... for a private channel) to add in check', 'acheck'],
  'remove-check': ['Ok good, send the channel @username or numeric ID to remove from check', 'rcheck']
};

bot.action(/adhymn_/, async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not allowed');
    ctx.answerCbQuery().catch(() => {});
    const edit = ctx.callbackQuery.data.split('_')[1];
    const safeEdit = (text, extra) => ctx.editMessageText(text, extra).catch(() => {});
    const safeMarkup = (rows) => ctx.editMessageReplyMarkup({ inline_keyboard: rows }).catch(() => {});

    if (prompts[edit]) {
      await safeEdit(prompts[edit][0]);
      return ctx.scene.enter(prompts[edit][1]);
    }
    if (edit === 'on-/-off-bot') {
      data.bot = !data.bot;
      await saveData();
      return safeEdit('*Bot Has ' + (data.bot ? 'Turned On' : 'Turned Off') + ' :)*\n\n_Here Is Your Admin Panel._', { reply_markup: { inline_keyboard: adminRows() }, parse_mode: 'Markdown' });
    }
    if (edit === '⬅️-back') return safeMarkup(adminRows());
    if (edit === 'withdraw-settings') return safeMarkup(wdRows());
    if (edit === 'auto-instant' || edit === 'manual') {
      data.with_type = edit;
      await saveData();
      return safeMarkup(wdRows());
    }
    if (edit === 'wallet-balance') {
      if (!hotWallet) return ctx.reply('❌ PRIVATE_KEY is not set, auto-pay is off.');
      try {
        const pol = ethers.formatEther(await provider.getBalance(hotWallet.address)).slice(0, 8);
        let line = '';
        if (data.token_contract) {
          const token = new ethers.Contract(data.token_contract, ERC20_ABI, provider);
          line = '\n' + data.bot_cur + ': ' + fmt(ethers.formatUnits(await token.balanceOf(hotWallet.address), tokenDecimals()));
        }
        const owedRow = (await pool.query("SELECT COALESCE(SUM((data->>'bal')::numeric), 0) AS s FROM users WHERE data ? 'bal'")).rows[0];
        ctx.reply('💼 Hot wallet (Polygon)\nAddress: ' + hotWallet.address + '\nPOL (gas): ' + pol + line + '\n\n👥 Total user balances: ' + fmt(owedRow ? owedRow.s : 0) + ' ' + data.bot_cur);
      } catch (e) {
        ctx.reply('❌ ' + shortMsg(e) + (hintFor(shortMsg(e)) ? '\n\n👉 ' + hintFor(shortMsg(e)) : ''));
      }
    }
  } catch (e) { console.log(e); }
});

bot.catch((err) => console.log('Bot error:', err));

/* ====================================================================
 *  Start-up: database, health endpoint (keeps Render awake), bot
 * ==================================================================== */
async function main() {
  await initDb();
  await loadSettings();
  setupProvider();
  setupWallet();

  const PORT = process.env.PORT || 10000;
  http.createServer(async (req, res) => {
    if (req.url === '/health') {
      try { await pool.query('SELECT 1'); res.end('ok'); } catch (e) { res.statusCode = 500; res.end('db error'); }
    } else res.end('Token airdrop bot is running');
  }).listen(PORT, () => console.log('Health endpoint on port ' + PORT));

  // Render injects RENDER_EXTERNAL_URL; pinging ourselves counts as inbound traffic (best effort —
  // an external pinger such as UptimeRobot on /health is the more reliable backup).
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {}), 9 * 60 * 1000);
  }

  bot.launch().catch((e) => { console.error('Launch failed:', e.message); process.exit(1); });
  console.log('Bot is running...');

  if (hotWallet) {
    console.log('Hot wallet address: ' + hotWallet.address);
    try { console.log('Polygon RPC OK (block ' + (await provider.getBlockNumber()) + ')'); }
    catch (e) { console.log('⚠️ Polygon RPC check failed: ' + shortMsg(e)); }
  } else console.log('⚠️ PRIVATE_KEY not set: use Manual withdraw mode or set the key.');
  if (!data.token_contract) console.log('⚠️ Token contract not set yet: /admin -> Withdraw Settings -> Token Contract');

  const stuck = await pool.query("SELECT COUNT(*) AS n FROM withdrawals WHERE status IN ('pending','review')");
  if (Number(stuck.rows[0].n) > 0) notifyAdmins('⚠️ ' + stuck.rows[0].n + ' withdrawal(s) need attention. Send /pending');
}

main().catch((e) => { console.error('Fatal start-up error:', e); process.exit(1); });

const shutdown = (sig) => { try { bot.stop(sig); } catch (e) { /* not started */ } pool.end().finally(() => process.exit(0)); };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
