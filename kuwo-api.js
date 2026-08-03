'use strict';
// 酷我音乐 (Kuwo) 后端模块
// 由 Mineradio-KW kw-dec 分支移植到 Mineradio 2.1 架构。
// 覆盖: 自制 DES (ylzsxkwm / kwks&@69)、账号密码登录、搜索、取链 (含 320k/无损/Hi-Res 降级回退)、
//       至臻 mflac (QMCv2) 取链、歌词 (mlyric 主源 + H5 兜底)、封面兜底、我的歌单、歌单详情、私人电台。

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- HTTP 助手

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// requestText 会把响应当 utf8 处理, 会破坏二进制 (zlib) 负载, 故歌词单独走 Buffer 版。
function kwRequestBuffer(targetUrl, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: opts.method || 'GET', headers: opts.headers || {} }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (response.statusCode >= 400) { const e = new Error('HTTP ' + response.statusCode); e.statusCode = response.statusCode; reject(e); return; }
        resolve(buf);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

// ---------------------------------------------------------------- 音质通用工具

function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['jymaster', 'master', 'studio', 'svip', 'zhizhen', 'zply'].includes(raw)) return 'jymaster';
  if (['hires', 'hi-res', 'highres', 'zhenyin', 'spatial'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  return 'hires';
}

function qualityCandidatesFrom(target, candidates) {
  target = normalizeQualityPreference(target);
  let start = candidates.findIndex(item => item.level === target);
  if (start < 0) start = 0;
  return candidates.slice(start);
}

function playbackRestriction(provider, category, message, action, extra) {
  return { provider, category, action: action || '', message, ...(extra || {}) };
}

// ---------------------------------------------------------------- 酷我 DES (ylzsxkwm / kwks&@69)

// —— 酷我自实现 DES(ECB) 置换表 (取自 APK 常量数组, 与 kw-dec 原版逐字一致) ——
const KW_IP = [57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,
  63,55,47,39,31,23,15,7,56,48,40,32,24,16,8,0,58,50,42,34,26,18,10,2,
  60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6];
const KW_E = [31,0,1,2,3,4,-1,-1,3,4,5,6,7,8,-1,-1,7,8,9,10,11,12,-1,-1,11,12,13,14,15,16,-1,-1,
  15,16,17,18,19,20,-1,-1,19,20,21,22,23,24,-1,-1,23,24,25,26,27,28,-1,-1,27,28,29,30,31,30,-1,-1];
const KW_P = [15,6,19,20,28,11,27,16,0,14,22,25,4,17,30,9,1,7,23,13,31,26,2,8,18,12,29,5,21,10,3,24];
const KW_FP = [39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,
  35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25,32,0,40,8,48,16,56,24];
const KW_PC1 = [56,48,40,32,24,16,8,0,57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,
  62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,60,52,44,36,28,20,12,4,27,19,11,3];
const KW_PC2 = [13,16,10,23,0,4,-1,-1,2,27,14,5,20,9,-1,-1,22,18,11,3,25,7,-1,-1,15,6,26,19,12,1,-1,-1,
  40,51,30,36,46,54,-1,-1,29,39,50,44,32,47,-1,-1,43,48,38,55,33,52,-1,-1,45,41,49,35,28,31,-1,-1];
const KW_SHIFT = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const KW_MROT = [0n, 1048577n, 3145731n];
const KW_MASK64 = (1n << 64n) - 1n;
const KW_MASK32 = 0xffffffffn;
const KW_BIT = [];
for (let n = 0; n < 64; n++) KW_BIT.push(1n << BigInt(n));
const KW_G = [
  [14,4,3,15,2,13,5,3,13,14,6,9,11,2,0,5,4,1,10,12,15,6,9,10,1,8,12,7,8,11,7,0,
   0,15,10,5,14,4,9,10,7,8,12,3,13,1,3,6,15,12,6,11,2,9,5,0,4,2,11,14,1,7,8,13],
  [15,0,9,5,6,10,12,9,8,7,2,12,3,13,5,2,1,14,7,8,11,4,0,3,14,11,13,6,4,1,10,15,
   3,13,12,11,15,3,6,0,4,10,1,7,8,4,11,14,13,8,0,6,2,15,9,5,7,1,10,12,14,2,5,9],
  [10,13,1,11,6,8,11,5,9,4,12,2,15,3,2,14,0,6,13,1,3,15,4,10,14,9,7,12,5,0,8,7,
   13,1,2,4,3,6,12,11,0,13,5,14,6,8,15,2,7,10,8,15,4,9,11,5,9,0,14,3,10,7,1,12],
  [7,10,1,15,0,12,11,5,14,9,8,3,9,7,4,8,13,6,2,1,6,11,12,2,3,0,5,14,10,13,15,4,
   13,3,4,9,6,10,1,12,11,0,2,5,0,13,14,2,8,15,7,4,15,1,10,7,5,6,12,11,3,8,9,14],
  [2,4,8,15,7,10,13,6,4,1,3,12,11,7,14,0,12,2,5,9,10,13,0,3,1,11,15,5,6,8,9,14,
   14,11,5,6,4,1,3,10,2,12,15,0,13,2,8,5,11,8,0,15,7,14,9,4,12,7,10,9,1,13,6,3],
  [12,9,0,7,9,2,14,1,10,15,3,4,6,12,5,11,1,14,13,0,2,8,7,13,15,5,4,10,8,3,11,6,
   10,4,6,11,7,9,0,6,4,2,13,1,9,15,3,8,15,3,1,14,12,5,11,0,2,12,14,7,5,10,8,13],
  [4,1,3,10,15,12,5,0,2,11,9,6,8,7,6,9,11,4,12,15,0,3,10,5,14,13,7,8,13,14,1,2,
   13,6,14,9,4,1,2,14,11,13,5,0,1,10,8,3,0,11,3,5,9,4,15,2,7,8,12,15,10,7,6,12],
  [13,7,10,0,6,9,5,15,8,4,3,10,11,14,12,5,2,11,9,6,15,12,0,3,4,1,14,13,1,2,7,8,
   1,2,12,15,10,4,0,3,13,14,6,9,7,8,9,6,15,1,5,12,3,10,14,5,8,7,11,0,4,13,2,11]
];

function kwPermute(table, n, val) {
  let out = 0n;
  for (let idx = 0; idx < n; idx++) {
    const t = table[idx];
    if (t >= 0 && (KW_BIT[t] & val) !== 0n) out |= KW_BIT[idx];
  }
  return out;
}

function kwKeySchedule(keyBytes, decryptMode) {
  let j2 = 0n;
  for (let i = 0; i < 8; i++) j2 |= BigInt(keyBytes[i] & 0xff) << BigInt(i * 8);
  const sub = new Array(16);
  let jA = kwPermute(KW_PC1, 56, j2);
  for (let r = 0; r < 16; r++) {
    const m = KW_MROT[KW_SHIFT[r]];
    const s = BigInt(KW_SHIFT[r]);
    jA = (((jA & (~m & KW_MASK64)) >> s) | ((m & jA) << (28n - s))) & KW_MASK64;
    sub[r] = kwPermute(KW_PC2, 64, jA);
  }
  if (decryptMode) for (let i = 0; i < 8; i++) { const t = sub[i]; sub[i] = sub[15 - i]; sub[15 - i] = t; }
  return sub;
}

function kwDesBlock(sub, blk) {
  let p = kwPermute(KW_IP, 64, blk);
  let s0 = p & KW_MASK32;
  let s1 = (p >> 32n) & KW_MASK32;
  for (let r = 0; r < 16; r++) {
    let rr = kwPermute(KW_E, 64, s1);
    rr ^= sub[r];
    let u = 0n;
    for (let i = 7; i >= 0; i--) {
      const t = Number((rr >> BigInt(i * 8)) & 0xffn);
      u <<= 4n;
      u |= BigInt(KW_G[i][t]);
    }
    rr = kwPermute(KW_P, 32, u);
    const q = s0;
    s0 = s1;
    s1 = (q ^ rr) & KW_MASK32;
  }
  let out = ((s0 << 32n) & KW_MASK64) | (s1 & KW_MASK32);
  return kwPermute(KW_FP, 64, out);
}

// 加密: ECB, 每块小端装配, 末尾恒追加由 len%8 字节构成的尾块
function kwEncrypt(bytes, keyStr) {
  const sub = kwKeySchedule(Buffer.from(keyStr || 'ylzsxkwm', 'ascii'));
  const n = bytes.length;
  const full = (n / 8) | 0;
  const blocks = [];
  for (let i = 0; i < full; i++) {
    let v = 0n;
    for (let j = 0; j < 8; j++) v |= BigInt(bytes[i * 8 + j] & 0xff) << BigInt(j * 8);
    blocks.push(kwDesBlock(sub, v));
  }
  let v = 0n;
  const rem = n % 8;
  for (let j = 0; j < rem; j++) v |= BigInt(bytes[full * 8 + j] & 0xff) << BigInt(j * 8);
  blocks.push(kwDesBlock(sub, v));
  const out = Buffer.alloc(blocks.length * 8);
  for (let i = 0; i < blocks.length; i++)
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((blocks[i] >> BigInt(j * 8)) & 0xffn);
  return out;
}

const KW_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function kwB64encode(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 3) {
    const n = buf.length - i;
    const b0 = buf[i], b1 = n > 1 ? buf[i + 1] : 0, b2 = n > 2 ? buf[i + 2] : 0;
    out += KW_B64[b0 >> 2] + KW_B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += n > 1 ? KW_B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += n > 2 ? KW_B64[b2 & 63] : '=';
  }
  return out;
}
const KW_B64REV = (() => { const m = {}; for (let i = 0; i < 64; i++) m[KW_B64[i]] = i; return m; })();
function kwB64decode(str) {
  const s = String(str).replace(/=+$/, '');
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const c0 = KW_B64REV[s[i]], c1 = KW_B64REV[s[i + 1]] || 0;
    const c2 = i + 2 < s.length ? KW_B64REV[s[i + 2]] : 0;
    const c3 = i + 3 < s.length ? KW_B64REV[s[i + 3]] : 0;
    out.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < s.length) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (i + 3 < s.length) out.push(((c2 & 3) << 6) | c3);
  }
  return Buffer.from(out);
}

// 解密: ECB, 反转子密钥, 仅处理整块 (登录回包用我们发出去的 sx 作为 key)
function kwDecrypt(bytes, keyStr) {
  const sub = kwKeySchedule(Buffer.from(keyStr, 'ascii'), true);
  const full = (bytes.length / 8) | 0;
  const out = Buffer.alloc(full * 8);
  for (let i = 0; i < full; i++) {
    let v = 0n;
    for (let j = 0; j < 8; j++) v |= BigInt(bytes[i * 8 + j] & 0xff) << BigInt(j * 8);
    const b = kwDesBlock(sub, v);
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((b >> BigInt(j * 8)) & 0xffn);
  }
  return out;
}

// 明文参数串 -> q (取链 key 默认 ylzsxkwm; 登录 key 传 kwks&@69)
function kwMakeQ(plain, keyStr) {
  return kwB64encode(kwEncrypt(Buffer.from(plain, 'utf8'), keyStr || 'ylzsxkwm'));
}

// ---------------------------------------------------------------- 账号/设备配置

const KW_ACCOUNT_FILE = process.env.KW_ACCOUNT_FILE || path.join(__dirname, '.kw-account');
const KW_PROD = 'kwplayer_ar_12.1.2.1';
const KW_SRC = 'kwplayer_ar_8.5.5.0_apk_keluze.apk';
const KW_UA_APK = 'Dalvik/2.1.0 (Linux; U; Android 15; Build/MTXC)';
const KW_UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const KW_UA_H5 = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

const kwAccount = (() => {
  const acc = {
    deviceId: crypto.randomBytes(8).toString('hex'),
    appuid: String(2000000000 + Math.floor(Math.random() * 900000000)),
    loginUid: '0',
    loginSid: '0',
    username: '',
    password: '',
    nickname: '',
    avatar: '',
    vipType: 0,
  };
  try {
    if (fs.existsSync(KW_ACCOUNT_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(KW_ACCOUNT_FILE, 'utf8'));
      ['deviceId', 'appuid', 'loginUid', 'loginSid', 'nickname', 'avatar'].forEach(k => {
        if (cfg && cfg[k] != null && cfg[k] !== '') acc[k] = String(cfg[k]);
      });
    }
  } catch (e) { console.warn('[Kuwo] 读取 .kw-account 失败:', e.message); }
  return acc;
})();

function saveKwAccount() {
  try {
    fs.writeFileSync(KW_ACCOUNT_FILE, JSON.stringify({
      deviceId: kwAccount.deviceId,
      appuid: kwAccount.appuid,
      loginUid: kwAccount.loginUid,
      loginSid: kwAccount.loginSid,
      nickname: kwAccount.nickname,
      avatar: kwAccount.avatar,
    }, null, 2), { mode: 0o600 });
  } catch (e) { console.warn('[Kuwo] 写入 .kw-account 失败:', e.message); }
}

function kwHasAccount() { return kwAccount.loginUid && kwAccount.loginUid !== '0' && kwAccount.loginSid && kwAccount.loginSid !== '0'; }

function kwCommonParams() {
  const dev = kwAccount.deviceId;
  return (
    `user=${dev}&android_id=${dev}&prod=${KW_PROD}&corp=kuwo&newver=3` +
    `&vipver=12.1.2.1&source=${KW_SRC}&p2p=1` +
    `&loginUid=${kwAccount.loginUid}&loginSid=${kwAccount.loginSid}` +
    `&appuid=${kwAccount.appuid}&allpay=0&notrace=0`
  );
}

function kwParseKv(text) {
  const o = {};
  String(text).split('\n').forEach(line => {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return o;
}

// ---------------------------------------------------------------- 账号密码登录

const KW_LOGIN_KEY = 'kwks&@69';
const KW_LOGIN_SX = 'mr8kw3sx';
const KW_LOGIN_BASE = 'http://ar.i.kuwo.cn/US_NEW/kuwo/';
const KW_LOGIN_COOLDOWN = 60 * 1000;
let kwLastLogin = 0;
let kwLoginInflight = null;

async function kwPostLogin(pathSeg, plain) {
  const q = kwMakeQ(plain, KW_LOGIN_KEY);
  const text = await requestText(KW_LOGIN_BASE + pathSeg + '?f=ar&q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': 'okhttp/3.10.0' },
  });
  const raw = String(text || '').trim();
  const dec = kwDecrypt(kwB64decode(raw), KW_LOGIN_SX).toString('utf8').replace(/ +$/, '').replace(/ +$/, '');
  try { return JSON.parse(dec); }
  catch (e) {
    const m = {};
    dec.replace(/"?(\w+)"?\s*[:=]\s*"?([^",&}]+)"?/g, (_, k, v) => (m[k] = v));
    return m;
  }
}

async function kwDoLogin(username, password) {
  const explicit = !!(username || password);
  const user = String(username || kwAccount.username || '').trim();
  const pass = String(password || kwAccount.password || '');
  if (!user || !pass) return { ok: false, error: 'MISSING_CREDENTIALS' };
  if (!explicit && kwLoginInflight) return kwLoginInflight;
  const run = (async () => {
    const pw = kwB64encode(Buffer.from(pass, 'utf8'));
    const plain =
      'username=' + encodeURIComponent(user) +
      '&password=' + encodeURIComponent(pw) +
      '&dev_id=' + (kwAccount.appuid || '0') + '&dev_name=' + KW_PROD + '&urlencode=0&src=' + KW_SRC +
      '&devResolution=1080*2400&from=android&devType=PJZ110&sx=' + KW_LOGIN_SX + '&version=12.1.2.1';
    let r;
    try { r = await kwPostLogin('login_kw', plain); }
    catch (e) { return { ok: false, error: 'LOGIN_REQUEST_FAILED', message: e.message }; }
    kwLastLogin = Date.now();
    const ok = r && (r.result === 'succ' || r.ret === 'succ');
    if (ok && (r.sid || r.userid || r.uid)) {
      const ui = (r && r.userInfo) || {};
      kwAccount.username = user;
      kwAccount.password = pass;
      kwAccount.loginUid = String(r.uid || r.userid || ui.uid || kwAccount.loginUid);
      kwAccount.loginSid = String(r.sid || kwAccount.loginSid);
      kwAccount.nickname = String(ui.nickName || r.nick || ui.name || r.name || '').trim();
      kwAccount.avatar = String(r.head || ui.pic120 || ui.pic || ui.pic300 || '').trim();
      kwAccount.vipType = Number(r.vip_type || r.vip_lev || ui.vipType || 0) || 0;
      KW_URL_CACHE.clear();
      saveKwAccount();
      return { ok: true, uid: kwAccount.loginUid, sid: kwAccount.loginSid, nickname: kwAccount.nickname, avatar: kwAccount.avatar };
    }
    return { ok: false, error: 'LOGIN_FAILED', message: (r && (r.msg || r.tips || r.result || r.ret)) || '账号或密码错误', raw: r };
  })();
  if (!explicit) { kwLoginInflight = run; run.finally(() => { if (kwLoginInflight === run) kwLoginInflight = null; }); }
  return run;
}

async function kwTryRelogin() {
  if (!kwAccount.username || !kwAccount.password) return false;
  if (Date.now() - kwLastLogin < KW_LOGIN_COOLDOWN) return false;
  const r = await kwDoLogin();
  return !!(r && r.ok);
}

function kwLoginStatus() {
  const on = kwHasAccount();
  return {
    provider: 'kw',
    loggedIn: on,
    userId: on ? kwAccount.loginUid : '',
    nickname: on ? (kwAccount.nickname || ('酷我用户 ' + kwAccount.loginUid)) : '酷我音乐',
    avatar: on ? (kwAccount.avatar || '') : '',
    vipType: on ? (Number(kwAccount.vipType) || 0) : 0,
    hasAccount: !!(kwAccount.username && kwAccount.password),
    username: kwAccount.username || '',
  };
}

function kwLogout() {
  kwAccount.loginUid = '0';
  kwAccount.loginSid = '0';
  kwAccount.username = '';
  kwAccount.password = '';
  kwAccount.nickname = '';
  kwAccount.avatar = '';
  kwAccount.vipType = 0;
  KW_URL_CACHE.clear();
  saveKwAccount();
  return { provider: 'kw', ok: true, loggedIn: false };
}

// ---------------------------------------------------------------- 取链音质候选

const KW_QUALITY_CANDIDATES = [
  { level: 'hires',    br: '4000kflac', format: 'flac', label: 'Hi-Res', bitrate: 4000000 },
  { level: 'lossless', br: '2000kflac', format: 'flac', label: '无损',   bitrate: 2000000 },
  { level: 'exhigh',   br: '320kmp3',   format: 'mp3',  label: '320k',   bitrate: 320000 },
  { level: 'standard', br: '128kmp3',   format: 'mp3',  label: '128k',   bitrate: 128000 },
];

function kwResolveLevel(kv) {
  const b = Number(kv.bitrate) || 0;
  const f = String(kv.format || '').toLowerCase();
  if (f === 'flac') return b >= 2800 ? 'hires' : 'lossless';
  if (b >= 320) return 'exhigh';
  return 'standard';
}

// ---------------------------------------------------------------- 搜索

function kwDecodeText(value) {
  let s = String(value || '');
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return decodeHtmlEntities(s).replace(/\s+/g, ' ').trim();
}

function kwSplitListItems(body, listKey) {
  const at = body.indexOf("'" + listKey + "':[");
  if (at < 0) return [];
  const items = [];
  let i = body.indexOf('{', at);
  while (i >= 0 && i < body.length) {
    let depth = 0, end = -1;
    for (let k = i; k < body.length; k++) {
      if (body[k] === '{') depth++;
      else if (body[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) break;
    items.push(body.slice(i, end + 1));
    const nextBrace = body.indexOf('{', end + 1);
    const listEnd = body.indexOf(']', end + 1);
    if (nextBrace < 0 || (listEnd >= 0 && listEnd < nextBrace)) break;
    i = nextBrace;
  }
  return items;
}
function kwSplitAbslistItems(body) { return kwSplitListItems(body, 'abslist'); }
function kwField(raw, key) {
  const m = new RegExp("'" + key + "':'([^']*)'").exec(raw);
  return m ? m[1] : '';
}
function kwSongCover(webAlbumpicShort) {
  const short = String(webAlbumpicShort || '').trim();
  if (!short) return '';
  return 'https://img1.kuwo.cn/star/albumcover/' + short.replace(/^\d+\//, '500/');
}
function kwUpsizeCover(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  return u.replace(/(\/star\/albumcover\/)\d+\//, '$1500/');
}
function kwArtistHead(webArtistpicShort) {
  const short = String(webArtistpicShort || '').trim();
  if (!short) return '';
  return 'https://img1.kuwo.cn/star/starheads/' + short.replace(/^\d+\//, '500/');
}

function kwMapSearchSong(raw) {
  const rid = (kwField(raw, 'DC_TARGETID') || kwField(raw, 'MUSICRID').replace(/^MUSIC_/, '')).trim();
  if (!rid || !/^\d+$/.test(rid)) return null;
  const name = kwDecodeText(kwField(raw, 'NAME') || kwField(raw, 'SONGNAME'));
  if (!name) return null;
  const artist = kwDecodeText(kwField(raw, 'ARTIST'));
  const album = kwDecodeText(kwField(raw, 'ALBUM'));
  const durationSec = Number(kwField(raw, 'DURATION')) || 0;
  const formats = kwField(raw, 'FORMATS') || '';
  const hasFlac = /FLAC|ALFLAC/i.test(formats);
  const artists = artist
    ? artist.split(/\s*&\s*|\s*、\s*|\s*\/\s*|\s*,\s*/).map(n => ({ name: n.trim() })).filter(a => a.name)
    : [];
  return {
    provider: 'kw', source: 'kw', type: 'kw',
    id: rid, rid, name,
    artist: artist || (artists.map(a => a.name).join(' / ')),
    artists: artists.length ? artists : (artist ? [{ name: artist }] : []),
    artistId: kwField(raw, 'ARTISTID') || '',
    album, albumId: kwField(raw, 'ALBUMID') || '',
    cover: kwSongCover(kwField(raw, 'web_albumpic_short')),
    duration: durationSec * 1000,
    fee: 0, formats, hasFlac, playable: false,
  };
}

function kwMapArtistSong(raw) {
  const rid = (kwField(raw, 'musicrid') || kwField(raw, 'MUSICRID')).replace(/^MUSIC_/, '').trim();
  if (!rid || !/^\d+$/.test(rid)) return null;
  const name = kwDecodeText(kwField(raw, 'name') || kwField(raw, 'SONGNAME') || kwField(raw, 'NAME'));
  if (!name) return null;
  const artist = kwDecodeText(kwField(raw, 'artist') || kwField(raw, 'ARTIST'));
  const album = kwDecodeText(kwField(raw, 'album') || kwField(raw, 'ALBUM'));
  const durationSec = Number(kwField(raw, 'duration') || kwField(raw, 'DURATION')) || 0;
  const formats = kwField(raw, 'formats') || kwField(raw, 'FORMATS') || '';
  const artists = artist
    ? artist.split(/\s*&\s*|\s*、\s*|\s*\/\s*|\s*,\s*/).map(n => ({ name: n.trim() })).filter(a => a.name)
    : [];
  return {
    provider: 'kw', source: 'kw', type: 'kw',
    id: rid, rid, name,
    artist: artist || (artists.map(a => a.name).join(' / ')),
    artists: artists.length ? artists : (artist ? [{ name: artist }] : []),
    artistId: kwField(raw, 'artistid') || kwField(raw, 'ARTISTID') || '',
    album, albumId: kwField(raw, 'albumid') || kwField(raw, 'ALBUMID') || '',
    cover: kwSongCover(kwField(raw, 'web_albumpic_short')),
    duration: durationSec * 1000,
    fee: 0, formats, hasFlac: /FLAC|ALFLAC/i.test(formats), playable: false,
  };
}

async function handleKwArtistSongs(artistId, limit) {
  const id = String(artistId || '').trim();
  if (!/^\d+$/.test(id)) return { provider: 'kw', error: 'MISSING_ARTIST_ID', artist: { id: '', name: '' }, songs: [] };
  const rn = Math.max(1, Math.min(50, Number(limit) || 30));
  const url = 'http://search.kuwo.cn/r.s?stype=artist2music&sortby=0&alflac=1&pn=0&rn=' + rn +
    '&artistid=' + encodeURIComponent(id) + '&encoding=utf8&rformat=json&vipver=1';
  let body = '';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { body = await requestText(url, { headers: { 'User-Agent': KW_UA_WEB, Referer: 'http://www.kuwo.cn/' } }); break; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
  }
  if (!body) throw lastErr || new Error('KW_ARTIST_EMPTY');
  const nameMatch = /'artist':'([^']*)'/.exec(body);
  const artistName = kwDecodeText(nameMatch ? nameMatch[1] : '');
  const picMatch = /'web_artistpic_short':'([^']*)'/.exec(body);
  const avatar = kwArtistHead(picMatch ? picMatch[1] : '');
  const seen = new Set();
  const songs = kwSplitListItems(body, 'musiclist')
    .map(kwMapArtistSong)
    .filter(Boolean)
    .filter(s => { if (seen.has(s.rid)) return false; seen.add(s.rid); return true; });
  return { provider: 'kw', artist: { id, name: artistName, avatar }, songs };
}

async function handleKwSearch(keywords, limit) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const rn = Math.max(1, Math.min(30, Number(limit) || 15));
  const url = 'http://search.kuwo.cn/r.s?all=' + encodeURIComponent(kw) +
    '&ft=music&itemset=web_2013&client=kt&pn=0&rn=' + rn +
    '&rformat=json&encoding=utf8&vipver=1&show_copyright_off=0&pcmp4=1&newver=1&audiotype=0';
  let body = '';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { body = await requestText(url, { headers: { 'User-Agent': KW_UA_WEB, Referer: 'http://www.kuwo.cn/' } }); break; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
  }
  if (!body) throw lastErr || new Error('KW_SEARCH_EMPTY');
  const seen = new Set();
  return kwSplitAbslistItems(body)
    .filter(raw => /'DC_TARGETTYPE':'music'/.test(raw) || /'MUSICRID':'MUSIC_/.test(raw))
    .map(kwMapSearchSong)
    .filter(song => {
      if (!song) return false;
      if (seen.has(song.rid)) return false;
      seen.add(song.rid);
      return true;
    });
}

// ---------------------------------------------------------------- 取链

const KW_URL_CACHE = new Map(); // key: rid|quality -> { url, level, br, exp }
const KW_URL_TTL = 4 * 60 * 1000;
let kwLastReq = 0;
const KW_MIN_GAP = 300;

async function kwRateGate() {
  const gap = KW_MIN_GAP - (Date.now() - kwLastReq);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  kwLastReq = Date.now();
}

async function kwFetchOnce(rid, candidate) {
  await kwRateGate();
  const plain =
    kwCommonParams() +
    `&type=convert_url2&br=${candidate.br}&format=${candidate.format}&sig=0&rid=${rid}` +
    `&priority=bitrate&loginUid=${kwAccount.loginUid}&network=WIFI` +
    `&loginSid=${kwAccount.loginSid}&mode=audition&uid=${kwAccount.appuid}`;
  const url = 'http://nmobi.kuwo.cn/mobi.s?f=kuwo&q=' + kwMakeQ(plain);
  let body = '';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { body = await requestText(url, { headers: { 'User-Agent': KW_UA_APK, Accept: '*/*' } }); break; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
  }
  if (!body) throw lastErr || new Error('KW_URL_HTTP_FAIL');
  return kwParseKv(body);
}

async function kwFetchMusicUrl(rid, quality) {
  const candidates = qualityCandidatesFrom(quality, KW_QUALITY_CANDIDATES);
  const wantFlac = candidates[0] && candidates[0].format === 'flac';
  let throttled = false;
  let lastReason = '未获取到播放地址';
  const triedBr = new Set();
  for (const c of candidates) {
    if (triedBr.has(c.br)) continue;
    triedBr.add(c.br);
    const kv = await kwFetchOnce(rid, c);
    if (!kv.url) { lastReason = '酷我接口未返回 url'; continue; }
    if ((kv.rid && kv.rid !== String(rid)) || /\/lx\/resource\//.test(kv.url) || kv.bitrate === '6') {
      lastReason = '版权受限或会话无效, 酷我仅返回试听替换';
      throttled = true;
      continue;
    }
    if (c.format === 'flac' && String(kv.format || '').toLowerCase() !== 'flac') {
      lastReason = `该曲无 ${c.br} 档, 返回 ${kv.bitrate}k ${kv.format}`;
      continue;
    }
    const level = kwResolveLevel(kv);
    return { url: kv.url, level, br: (Number(kv.bitrate) || c.bitrate / 1000) * 1000, format: kv.format || c.format, bitrate: Number(kv.bitrate) || 0 };
  }
  const err = new Error(lastReason);
  err.throttled = throttled;
  err.wantFlac = wantFlac;
  throw err;
}

function classifyKwRestriction(throttled) {
  if (throttled) {
    return playbackRestriction('kw', 'vip_required',
      kwHasAccount() ? '酷我会员会话可能失效, 该曲仅返回试听片段' : '酷我该曲版权受限, 游客仅可试听 · 可换其它平台版本',
      'switch_source', { missingPlaybackKey: !kwHasAccount() });
  }
  return playbackRestriction('kw', 'url_unavailable', '酷我没有返回可播放地址, 可能受版权或地区限制', 'switch_source');
}

// ---------------------------------------------------------------- 至臻音质 (QMCv2 mflac)

const KW_ENC_KEY = 'kuwo_enc_key';
const KW_OAID = crypto.randomBytes(16).toString('hex').toUpperCase() + crypto.randomBytes(16).toString('hex');
const KW_SRC_PAY = 'kwplayer_ar_12.1.2.1_40.apk';
const KW_UA_PAY = 'Dalvik/2.1.0 (Linux; U; Android 15; MTxiaocheng Build/MTXC)';

function kwJfenc(plain) {
  const k = Buffer.from(KW_ENC_KEY, 'utf8');
  const b = Buffer.from(String(plain), 'utf8');
  const o = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b[i] ^ k[i % k.length];
  return o.toString('base64');
}

async function kwGetWithRetry(u, headers) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    await kwRateGate();
    try { return await requestText(u, { headers }); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
  }
  throw lastErr || new Error('KW_HTTP_FAIL');
}

async function kwMusicPay(rid, quality) {
  if (!kwHasAccount()) return null;
  const dev = kwAccount.deviceId;
  const enc = kwJfenc(dev);
  const u = 'http://musicpay.kuwo.cn/music.pay?newver=2&clienttimestamp=' + Date.now() +
    '&uid=' + encodeURIComponent(kwAccount.loginUid) + '&sid=' + encodeURIComponent(kwAccount.loginSid) +
    '&android_id=' + encodeURIComponent(enc) + '&from=ar&deviceid=' + encodeURIComponent(enc) +
    '&ver=12.1.2.1&src=' + KW_SRC_PAY + '&appuid=' + kwAccount.appuid + '&allpay=0&notrace=0' +
    '&oaid=' + encodeURIComponent(kwJfenc(KW_OAID)) +
    '&op=query&action=play&signver=new&filter=no&apiversion=4&local=0&quality=' + encodeURIComponent(quality || 'ZPLY') +
    '&preload=1&ids=' + encodeURIComponent(rid) + '&jfencv=android_id,deviceid,oaid';
  const cookie = kwJfenc('user=' + dev + ',ct=11,cv=12121,chid=40,os_ver=36,newdevice=1');
  const body = await kwGetWithRetry(u, { 'User-Agent': KW_UA_PAY, encvCookies: cookie, Accept: '*/*' });
  let j; try { j = JSON.parse(body); } catch (e) { throw new Error('music.pay 非 JSON'); }
  const song = (j && j.songs && j.songs[0]) || null;
  if (!song || j.errorcode !== 0) throw new Error('music.pay errorcode=' + (j && j.errorcode));
  return { token: song.token || {}, payInfo: song.payInfo || {} };
}

async function kwFetchZhizhen(rid) {
  let pay;
  try { pay = await kwMusicPay(rid, 'ZPLY'); }
  catch (e) { return null; }
  if (!pay) return 'no-zhizhen';
  if (!pay.token || !pay.token.ZPLY) return 'no-zhizhen';
  const plain = kwCommonParams() +
    '&type=convert_url_with_sign&br=20900kmflac&format=mp3|aac&sig=0&rid=' + rid +
    '&priority=bitrate&network=WIFI&localUid=-1&mode=audition' +
    '&token=' + pay.token.ZPLY + '&bc_token=' + (pay.token.BCMS || '') +
    '&timestamp=' + Math.floor(Date.now() / 1000) + '&uid=' + kwAccount.appuid +
    '&downloadPay=' + (pay.payInfo.ndown || '111111111111') +
    '&playPay=' + (pay.payInfo.nplay || '111111111111') +
    '&payUid=' + kwAccount.loginUid + '&isstar=false&surl=1&apiv=1';
  const url = 'http://nmobi.kuwo.cn/mobi.s?f=kuwo&q=' + kwMakeQ(plain);
  let body;
  try { body = await kwGetWithRetry(url, { 'User-Agent': KW_UA_APK, Accept: '*/*' }); }
  catch (e) { return null; }
  let j; try { j = JSON.parse(body); } catch (e) { return null; }
  const d = j && j.data;
  if (!d || !d.url || !d.ekey || String(d.format || '').toLowerCase() !== 'mflac') return null;
  return { url: d.url, ekey: d.ekey, level: 'zhizhen', br: (Number(d.bitrate) || 20900) * 1000, format: 'mflac', bitrate: Number(d.bitrate) || 20900 };
}

async function handleKwSongUrl(rid, qualityPreference) {
  const songRid = String(rid || '').replace(/^MUSIC_/, '').trim();
  if (!songRid) return { provider: 'kw', url: '', playable: false, error: 'MISSING_RID', message: '缺少酷我歌曲 id' };
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  if (requestedQuality === 'jymaster' && kwHasAccount()) {
    const zzKey = songRid + '|zhizhen';
    const zc = KW_URL_CACHE.get(zzKey);
    if (zc && zc.exp > Date.now()) {
      if (!zc.empty) {
        return { provider: 'kw', url: zc.url, ekey: zc.ekey, mflac: true, trial: false, playable: true, level: 'zhizhen', quality: 'zhizhen', br: zc.br, format: 'mflac', requestedQuality };
      }
    } else {
      let zz = null;
      try { zz = await kwFetchZhizhen(songRid); } catch (e) { /* 回落普通取链 */ }
      if (zz && typeof zz === 'object') {
        KW_URL_CACHE.set(zzKey, { url: zz.url, ekey: zz.ekey, br: zz.br, exp: Date.now() + KW_URL_TTL });
        return { provider: 'kw', url: zz.url, ekey: zz.ekey, mflac: true, trial: false, playable: true, level: 'zhizhen', quality: 'zhizhen', br: zz.br, format: 'mflac', requestedQuality };
      }
      if (zz === 'no-zhizhen') KW_URL_CACHE.set(zzKey, { empty: true, exp: Date.now() + KW_URL_TTL });
    }
  }
  const cacheKey = songRid + '|' + requestedQuality;
  const cached = KW_URL_CACHE.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    return { provider: 'kw', url: cached.url, trial: false, playable: true, level: cached.level, quality: cached.level, br: cached.br, format: cached.format, requestedQuality };
  }
  let lastErr;
  let relogged = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await kwFetchMusicUrl(songRid, requestedQuality);
      KW_URL_CACHE.set(cacheKey, { url: r.url, level: r.level, br: r.br, format: r.format, exp: Date.now() + KW_URL_TTL });
      return { provider: 'kw', url: r.url, trial: false, playable: true, level: r.level, quality: r.level, br: r.br, format: r.format, requestedQuality };
    } catch (e) {
      lastErr = e;
      if (!e.throttled) break;
      if (!relogged && attempt >= 1 && kwAccount.username && kwAccount.password) {
        relogged = true;
        if (await kwTryRelogin()) continue;
      }
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  const restriction = classifyKwRestriction(!!(lastErr && lastErr.throttled));
  return {
    provider: 'kw', url: '', playable: false,
    error: 'KW_URL_UNAVAILABLE', restriction,
    reason: restriction.category, message: restriction.message, requestedQuality,
  };
}

// 音频代理用: 酷我 CDN 需要的请求头 (Referer + APK UA)。供 server 的 /api/audio 复用。
function kwAudioHeaders(audioUrl, range) {
  const headers = { 'User-Agent': KW_UA_APK, Referer: 'http://www.kuwo.cn/' };
  if (range) headers.Range = range;
  return headers;
}

// ---------------------------------------------------------------- 歌词

function kwFmtLrcTime(sec) {
  const s = parseFloat(sec) || 0;
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(2);
  return `[${String(m).padStart(2, '0')}:${r.padStart(5, '0')}]`;
}

const KW_LRC_BASE = 'http://mlyric.kuwo.cn/mobi.s?f=kuwo&q=';

function kwXorYeelion(buf) {
  const key = Buffer.from('yeelion', 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}

function kwParseLyricResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  const head = (sep >= 0 ? buf.slice(0, sep) : buf).toString('utf8');
  if (/^TP=none/.test(head)) return { kind: 'none' };
  if (/^TP=list/.test(head)) {
    const ids = [];
    const txt = buf.toString('utf8');
    const re = /PATH=(\d+)/g; let m;
    while ((m = re.exec(txt))) ids.push(m[1]);
    return { kind: 'list', ids };
  }
  if (!/^TP=content/.test(head) || sep < 0) return { kind: 'other' };
  const isLrcx = /lrcx=1/.test(head);
  const payload = buf.slice(sep + 4);
  let inflated;
  try { inflated = zlib.inflateSync(payload); }
  catch (e) { try { inflated = zlib.gunzipSync(payload); } catch (e2) { return { kind: 'other' }; } }
  let text = inflated.toString('utf8');
  if (isLrcx) {
    try { text = kwXorYeelion(Buffer.from(text.replace(/\s/g, ''), 'base64')).toString('utf8'); }
    catch (e) { return { kind: 'other' }; }
  }
  return { kind: 'content', text };
}

function kwLrcxToLyric(raw) {
  const text = String(raw || '');
  let c = 1, d = 1;
  const km = text.match(/\[kuwo:\s*([^\]\s]+)/);
  if (km) {
    const v = parseInt(km[1], 8);
    if (Number.isFinite(v)) { const cc = Math.floor(v / 10), dd = v % 10; if (cc > 0) c = cc; if (dd > 0) d = dd; }
  }
  const lrc = [], yrc = []; let anyWords = false;
  for (const line of text.split(/\r?\n/)) {
    const tm = line.match(/^\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\](.*)$/);
    if (!tm) continue;
    const stamp = `[${tm[1]}:${tm[2]}${tm[3] ? '.' + tm[3] : ''}]`;
    const lineStart = ((+tm[1]) * 60 + (+tm[2])) * 1000 + (tm[3] ? parseInt((tm[3] + '00').slice(0, 3), 10) : 0);
    const body = tm[4] || '';
    const wre = /<(-?\d+),(-?\d+)(?:,-?\d+)?>([^<]*)/g; let wm;
    const words = []; let plain = '', lineEnd = 0;
    while ((wm = wre.exec(body))) {
      const g1 = +wm[1], g2 = +wm[2], ch = wm[3];
      if (!ch) continue;
      let st = Math.round((g1 + g2) / (2 * c));
      let du = Math.round((g1 - g2) / (2 * d));
      if (st < 0) st = 0;
      if (du < 0) du = 0;
      words.push({ st, du, ch });
      plain += ch; lineEnd = Math.max(lineEnd, st + du);
    }
    if (!words.length) {
      const t = body.replace(/<-?\d+,-?\d+(?:,-?\d+)?>/g, '').trim();
      if (t) { lrc.push(stamp + t); yrc.push(`[${lineStart},0]${t}`); }
      continue;
    }
    for (let i = 0; i < words.length - 1; i++) {
      const gap = words[i + 1].st - words[i].st;
      if (gap >= 0 && words[i].du > gap) words[i].du = gap;
    }
    anyWords = true;
    lrc.push(stamp + plain);
    let y = `[${lineStart},${Math.max(1, lineEnd)}]`;
    for (const w of words) y += `(${lineStart + w.st},${w.du},0)${w.ch}`;
    yrc.push(y);
  }
  return { lyric: lrc.join('\n'), yrc: anyWords ? yrc.join('\n') : '' };
}

async function kwLyricCall(plain) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await kwRequestBuffer(KW_LRC_BASE + encodeURIComponent(kwMakeQ(plain)), { headers: { 'User-Agent': KW_UA_APK } }); }
    catch (e) { lastErr = e; if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
  }
  throw lastErr || new Error('KW_LYRIC_HTTP_FAIL');
}

async function handleKwLyric(rid, name, artist, duration) {
  const songRid = String(rid || '').replace(/^MUSIC_/, '').trim();
  if (!songRid && !name) return { provider: 'kw', error: 'MISSING_RID', lyric: '' };
  const base = kwCommonParams();
  const dur = Math.max(0, Math.round(Number(duration) || 0));
  const tryLyric = async (plain, id) => {
    try {
      const r = kwParseLyricResponse(await kwLyricCall(plain));
      if (r.kind !== 'content') return null;
      const out = kwLrcxToLyric(r.text);
      return out.lyric ? out : null;
    } catch (e) { console.warn('[KwLyric] mlyric 取词失败:', e.message); return null; }
  };
  if (/^\d+$/.test(songRid)) {
    const out = await tryLyric(`${base}&type=lyric&req=2&lrcx=1&rid=${songRid}&encode=utf8`);
    if (out) return { provider: 'kw', id: songRid, lyric: out.lyric, tlyric: '', yrc: out.yrc, source: 'kw-mobi-rid' };
  }
  if (name) {
    let list = { kind: 'none' };
    try {
      const q = `${base}&type=lyric&songname=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist || '')}` +
        `&filename=&duration=${dur}&req=1&lrcx=1&encode=utf8`;
      list = kwParseLyricResponse(await kwLyricCall(q));
    } catch (e) { console.warn('[KwLyric] mlyric 搜词失败:', e.message); }
    if (list.kind === 'list') {
      for (const pid of list.ids.slice(0, 3)) {
        const out = await tryLyric(`${base}&type=lyric&req=2&lrcx=1&rid=${pid}&encode=utf8`);
        if (out) return { provider: 'kw', id: songRid, lyric: out.lyric, tlyric: '', yrc: out.yrc, source: 'kw-mobi-search', lyricId: pid };
      }
    }
  }
  if (/^\d+$/.test(songRid)) {
    const h5 = await handleKwLyricH5(songRid);
    if (h5 && h5.lyric) return h5;
  }
  return { provider: 'kw', id: songRid, lyric: '', tlyric: '', yrc: '', source: 'kw-empty' };
}

async function handleKwLyricH5(rid) {
  const songRid = String(rid || '').replace(/^MUSIC_/, '').trim();
  if (!songRid) return { provider: 'kw', error: 'MISSING_RID', lyric: '' };
  const url = `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${songRid}&httpsStatus=1`;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const text = await requestText(url, {
        headers: { 'User-Agent': KW_UA_H5, Referer: 'https://m.kuwo.cn/', csrf: 'kw', Cookie: 'kw_token=kw' },
      });
      const data = JSON.parse(text);
      const list = data && data.data && data.data.lrclist;
      if (data && data.status === 200 && Array.isArray(list) && list.length) {
        const lyric = list.map(it => kwFmtLrcTime(it.time) + (it.lineLyric || '')).join('\n');
        return { provider: 'kw', id: songRid, lyric, tlyric: '', yrc: '', source: 'kw-h5' };
      }
      lastErr = new Error('酷我歌词接口 status=' + (data && data.status));
    } catch (e) { lastErr = e; }
    if (attempt < 4) await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
  }
  return { provider: 'kw', id: songRid, lyric: '', tlyric: '', yrc: '', source: 'kw-empty', error: lastErr && lastErr.message };
}

// ---------------------------------------------------------------- 封面兜底

async function handleKwPic(rid) {
  const songRid = String(rid || '').replace(/^MUSIC_/, '').trim();
  if (!songRid) return { provider: 'kw', cover: '' };
  const url = 'http://artistpicserver.kuwo.cn/pic.web?type=rid_pic&pictype=url&content=list&size=500' +
    `&rid=${songRid}&user=${kwAccount.deviceId}&prod=${KW_PROD}&corp=kuwo&source=${KW_SRC}`;
  try {
    const body = await requestText(url, { headers: { 'User-Agent': KW_UA_APK } });
    const first = String(body || '').trim().split('\n')[0].trim();
    if (/^https?:\/\//.test(first)) return { provider: 'kw', cover: first };
  } catch (e) {}
  return { provider: 'kw', cover: '' };
}

// ---------------------------------------------------------------- 我的歌单

const KW_PL_BASE = 'http://nplserver.kuwo.cn/pl.svc';

async function kwGetJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = await requestText(url, { headers: { 'User-Agent': KW_UA_APK } });
      return JSON.parse(body);
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 350 * (attempt + 1))); }
  }
  throw lastErr || new Error('KW_PL_HTTP_FAIL');
}

async function handleKwUserPlaylists() {
  if (!kwHasAccount()) return { provider: 'kw', loggedIn: false, playlists: [] };
  const uid = kwAccount.loginUid;
  const url = `${KW_PL_BASE}?op=getlistbyuid&uid=${encodeURIComponent(uid)}&pn=0&rn=100&encode=utf-8&keyset=pl2012&vipver=1&newver=1`;
  const data = await kwGetJSON(url);
  const plist = (data && Array.isArray(data.plist)) ? data.plist : [];
  const playlists = plist
    .filter(p => p && p.id && !p.hidden)
    .map(p => ({
      provider: 'kw', source: 'kw', id: String(p.id), name: p.title || '未命名歌单',
      cover: p.pic || '', trackCount: Number(p.musicnum) || 0, playCount: Number(p.playnum) || 0,
      creator: kwAccount.nickname || '酷我用户', subscribed: false, favorite: p.type === 'MYFAVORITE',
    }))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite));
  return { provider: 'kw', loggedIn: true, userId: uid, playlists };
}

function kwMapPlaylistTrack(m) {
  m = m || {};
  const rid = String(m.id || m.musicrid || '').replace(/^MUSIC_/, '').trim();
  if (!rid || !/^\d+$/.test(rid)) return null;
  const name = kwDecodeText(m.name || m.songname || m.FSONGNAME || '');
  if (!name) return null;
  const artist = kwDecodeText(m.artist || m.FARTIST || '');
  const album = kwDecodeText(m.album || m.FALBUM || '');
  const cover = kwUpsizeCover(m.albumpic || m.musicPic || m.web_albumpic || '') || (m.web_albumpic_short ? kwSongCover(m.web_albumpic_short) : '');
  const artists = artist
    ? artist.split(/\s*&\s*|\s*、\s*|\s*\/\s*|\s*,\s*/).map(n => ({ name: n.trim() })).filter(a => a.name)
    : [];
  const offline = m.online != null && String(m.online) === '0';
  return {
    provider: 'kw', source: 'kw', type: 'kw', id: rid, rid, name,
    artist: artist || (artists.map(a => a.name).join(' / ')),
    artists: artists.length ? artists : (artist ? [{ name: artist }] : []),
    artistId: m.artistid || '', album, albumId: m.albumid || '',
    cover: cover || '', duration: (Number(m.duration) || 0) * 1000,
    fee: 0, formats: m.formats || '', hasFlac: /FLAC|ALFLAC/i.test(m.formats || ''),
    offline, playable: false,
  };
}

async function kwGetPlaylistFull(pid) {
  if (!kwHasAccount()) return null;
  const dev = kwAccount.deviceId;
  const params = new URLSearchParams({
    op: 'pl3_getlist', pid: String(pid), sig: '0',
    uid: kwAccount.loginUid, sid: kwAccount.loginSid,
    encode: 'utf-8', plat: 'ar',
    devid: kwJfenc(kwAccount.appuid), user: kwJfenc(dev), imei: kwJfenc(dev), oaid: kwJfenc(KW_OAID),
    prod: KW_PROD, source: KW_SRC_PAY, corp: 'kuwo',
    locationid: '1', approval: 'false', allpay: '0', notrace: '0',
    ttime: String(Date.now()), pn: '0', jfencv: 'devid,user,imei,oaid',
  });
  try {
    const data = await kwGetJSON(`${KW_PL_BASE}?${params.toString()}`);
    if (data && data.errcode === 0 && data.info && Array.isArray(data.info.musiclist)) return data.info;
  } catch (e) { console.warn('[Kuwo] pl3_getlist 失败, 回退 getlistinfo:', e.message); }
  return null;
}

async function handleKwPlaylistTracks(pid, limit, offset) {
  const id = String(pid || '').trim();
  if (!id) return { provider: 'kw', error: 'MISSING_PID', tracks: [] };
  const want = Math.max(1, Math.min(1000, Number(limit) || 300));
  const start = Math.max(0, Number(offset) || 0);
  let list = [];
  let title = '';
  let cover = '';
  let total = 0;
  const full = await kwGetPlaylistFull(id);
  if (full && full.musiclist.length) {
    list = full.musiclist;
    total = list.length;
  } else {
    const rn = Math.max(1, Math.min(1000, Math.max(want, start + want)));
    const url = `${KW_PL_BASE}?op=getlistinfo&pid=${encodeURIComponent(id)}&pn=0&rn=${rn}&encode=utf-8&keyset=pl2012&vipver=1&newver=1`;
    const data = await kwGetJSON(url);
    list = (data && Array.isArray(data.musiclist)) ? data.musiclist : [];
    title = kwDecodeText(data && data.title) || '';
    cover = (data && data.pic) || '';
    total = Number(data && data.total) || list.length;
  }
  const all = list.map(kwMapPlaylistTrack).filter(Boolean);
  const tracks = all.slice(start, start + want);
  const nextOffset = start + tracks.length;
  const hasMore = nextOffset < total;
  const playlist = {
    provider: 'kw', id, name: title || '酷我歌单',
    cover: cover || (tracks[0] && tracks[0].cover) || '',
    trackCount: total || all.length,
  };
  return { provider: 'kw', playlist, tracks, total: total || all.length, nextOffset, hasMore };
}

// ---------------------------------------------------------------- 私人电台

const KW_RADIO_BASE = 'http://gxh2.kuwo.cn/newradio.nr';
const KW_RADIO_CHANNELS = [
  { fid: '-26711', title: '私人FM' },
  { fid: '-58595', title: '开车时刻' },
  { fid: '-33924', title: '轻音助眠' },
  { fid: '-20484', title: '工作必备' },
  { fid: '-28622', title: '学习自习' },
  { fid: '-18249', title: '儿童热门' },
  { fid: '-58537', title: '相声曲艺' },
];

function kwRadioTitle(fid) {
  const c = KW_RADIO_CHANNELS.find(x => x.fid === String(fid));
  return (c && c.title) || '私人电台';
}

function kwMapRadioTrack(m) {
  m = m || {};
  const rid = String(m.id || m.rid || m.musicrid || '').replace(/^MUSIC_/, '').trim();
  if (!rid || !/^\d+$/.test(rid)) return null;
  const name = kwDecodeText(m.songname || m.name || '');
  if (!name) return null;
  const artist = kwDecodeText(m.artist || '');
  const album = kwDecodeText(m.album || '');
  const formats = m.mediacode || m.formats || '';
  const artists = artist
    ? artist.split(/\s*&\s*|\s*、\s*|\s*\/\s*|\s*,\s*/).map(n => ({ name: n.trim() })).filter(a => a.name)
    : [];
  return {
    provider: 'kw', source: 'kw', type: 'kw', id: rid, rid, name,
    artist: artist || (artists.map(a => a.name).join(' / ')),
    artists: artists.length ? artists : (artist ? [{ name: artist }] : []),
    artistId: m.artistid || '', album, albumId: m.albumid || '',
    cover: '', duration: (Number(m.duration) || 0) * 1000,
    fee: 0, formats, hasFlac: /FLAC|ALFLAC/i.test(formats),
    traceId: m.traceid || '', playable: false,
  };
}

async function kwRadioFetchBatch(fid, offset) {
  const params = new URLSearchParams({
    type: '4', login: kwHasAccount() ? '1' : '0',
    uid: kwHasAccount() ? kwAccount.loginUid : '0', kid: kwAccount.appuid,
    ver: KW_SRC_PAY, fid: String(fid), size: '20', mid: '0', cover_rid: '0',
    version: '3', locationid: '1', play_dur: '0', paytag: '1', m: '1',
    encode: 'utf8', allpay: '0', notrace: '0', offset: String(offset || 0),
    oaid: kwJfenc(KW_OAID), jfencv: 'oaid',
  });
  const cookie = kwJfenc('user=' + kwAccount.deviceId + ',ct=11,cv=12121,chid=40,os_ver=36,newdevice=1');
  const body = await requestText(KW_RADIO_BASE + '?' + params.toString(), {
    headers: { 'User-Agent': KW_UA_PAY, Accept: '*/*', encvCookies: cookie },
  });
  try { return JSON.parse(body); } catch (e) { throw new Error('newradio.nr 非 JSON'); }
}

async function kwFillRadioCovers(tracks) {
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
  await Promise.allSettled(tracks.map(async t => {
    if (t.cover) return;
    const r = await withTimeout(handleKwPic(t.rid).catch(() => null), 3000);
    if (r && r.cover) t.cover = r.cover;
  }));
  return tracks;
}

async function handleKwRadio(fid, size, offset) {
  const channelFid = String(fid || '-26711').trim() || '-26711';
  const want = Math.max(1, Math.min(30, Number(size) || 15));
  let cursor = Number(offset) || 0;
  const tracks = [];
  const seen = new Set();
  const maxBatches = Math.ceil(want / 5) + 2;
  for (let batches = 0; tracks.length < want && batches < maxBatches; batches++) {
    let j;
    try { j = await kwRadioFetchBatch(channelFid, cursor); }
    catch (e) { console.warn('[KwRadio] 批次失败:', e.message); break; }
    if (!j || j.state !== 'success' || !Array.isArray(j.lists) || !j.lists.length) break;
    cursor = Number(j.offset) || (cursor + j.lists.length);
    for (const raw of j.lists) {
      const t = kwMapRadioTrack(raw);
      if (t && !seen.has(t.rid)) { seen.add(t.rid); tracks.push(t); }
    }
  }
  await kwFillRadioCovers(tracks);
  return {
    provider: 'kw',
    radio: { fid: channelFid, title: kwRadioTitle(channelFid), loggedIn: kwHasAccount() },
    tracks, offset: cursor, hasMore: tracks.length > 0,
  };
}

async function handleKwRadioReport(fid, rid, taste, playtime, duration) {
  const songRid = String(rid || '').replace(/^MUSIC_/, '').trim();
  if (!songRid || !/^\d+$/.test(songRid)) return { ok: false, error: 'MISSING_RID' };
  const params = new URLSearchParams({
    type: '6', login: kwHasAccount() ? '1' : '0',
    uid: kwHasAccount() ? kwAccount.loginUid : '0', kid: kwAccount.appuid,
    ver: KW_SRC_PAY, fid: String(fid || '-26711'), mid: songRid,
    mtaste: String(taste == null || taste === '' ? -2 : taste),
    playtime: String(Math.max(0, Math.round(Number(playtime) || 0))),
    duration: String(Math.max(0, Math.round(Number(duration) || 0))),
  });
  try {
    const body = await requestText(KW_RADIO_BASE + '?' + params.toString(), {
      headers: { 'User-Agent': KW_UA_PAY, Accept: '*/*' },
    });
    return { ok: /success/i.test(body) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------------------------------------------------------- 导出

module.exports = {
  // 鉴权/账号
  kwDoLogin,
  kwLoginStatus,
  kwLogout,
  kwHasAccount,
  kwDecrypt,
  kwAudioHeaders,
  KW_RADIO_CHANNELS,
  // 搜索/歌手
  handleKwSearch,
  handleKwArtistSongs,
  // 取链/至臻
  handleKwSongUrl,
  // 歌词/封面
  handleKwLyric,
  handleKwLyricH5,
  handleKwPic,
  // 歌单/电台
  handleKwUserPlaylists,
  handleKwPlaylistTracks,
  handleKwRadio,
  handleKwRadioReport,
};
