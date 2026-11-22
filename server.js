// Local usage server for the Xeneon Edge widgets (Claude, ChatGPT/Codex, Antigravity).
// Zero dependencies. Listens on 127.0.0.1 only. Login tokens are read from each tool's own
// login on this machine and are only ever sent to that tool's own service.
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 8787;
const DEMO = process.env.DEMO === '1';
const CACHE_MS = 60_000; // each service is polled at most once a minute

class WidgetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const inH = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const clamp = (n) => Math.max(0, Math.min(100, n));

// The server runs without a window, so what it reports also goes to data/server.log (~1 MB, one old copy kept).
const LOG_FILE = path.join(__dirname, 'data', 'server.log');
function log(...parts) {
  const line = `${new Date().toLocaleString('sv-SE')} ${parts.filter((p) => p !== undefined && p !== '').join(' ')}`;
  console.error(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.statSync(LOG_FILE, { throwIfNoEntry: false })?.size > 1_000_000) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never take the server down */ }
}
// Log why the process is going down; the watchdog task (autostart.ps1) starts it again.
process.on('uncaughtException', (e) => { log('crash:', e?.stack || e); process.exit(1); });
process.on('unhandledRejection', (e) => { log('crash (promise):', e?.stack || e); process.exit(1); });

// Every provider returns { raw, limits: [{ key, label?, used (0-100), resetsAt }], resets, credits: null | { amount, currency? } }
// resets: null when the service does not say, else the limit-reset passes: [{ name, count?, expiresAt? }]
// (no count = one pass).

// ───────────────────────── Claude ─────────────────────────
const CLAUDE_CRED = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client id

function readClaudeCreds() {
  let text;
  try { text = fs.readFileSync(CLAUDE_CRED, 'utf8'); }
  catch { throw new WidgetError('no_login', 'Claude credentials file not found'); }
  const all = JSON.parse(text);
  if (!all.claudeAiOauth?.accessToken) throw new WidgetError('no_login', 'no Claude login in credentials file');
  return all;
}

async function refreshClaude(all) {
  const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: all.claudeAiOauth.refreshToken, client_id: CLAUDE_CLIENT_ID }),
  });
  if (!res.ok) throw new WidgetError('expired', `Claude token refresh failed (${res.status})`);
  const t = await res.json();
  // Re-read so we don't clobber anything Claude Code wrote meanwhile, then replace atomically.
  const fresh = JSON.parse(fs.readFileSync(CLAUDE_CRED, 'utf8'));
  fresh.claudeAiOauth = {
    ...fresh.claudeAiOauth,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || all.claudeAiOauth.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  const tmp = CLAUDE_CRED + '.edgewidget.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 });
  fs.renameSync(tmp, CLAUDE_CRED);
  return fresh.claudeAiOauth.accessToken;
}

async function claudeToken(forceRefresh = false) {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const all = readClaudeCreds();
  const o = all.claudeAiOauth;
  const stale = forceRefresh || (o.expiresAt && o.expiresAt < Date.now() + 60_000);
  if (!stale) return o.accessToken;
  if (!o.refreshToken) throw new WidgetError('expired', 'Claude token expired');
  return refreshClaude(all);
}

// The plan in the credentials file is written at login and stays the same after an upgrade or
// downgrade, so it is read from the account profile; the file is only the fallback.
const PROFILE_MS = 10 * 60_000;
let claudeProfile = { at: 0, plan: null };

async function claudeProfilePlan(token) {
  const raw = await okJson(await fetch('https://api.anthropic.com/api/oauth/profile', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  }));
  const org = raw.organization || {};
  const type = org.organization_type?.replace(/^claude_/, ''); // claude_max -> max
  if (!type) return null;
  const mult = /_(\d+)x$/.exec(org.rate_limit_tier || '')?.[1]; // default_claude_max_20x -> 20
  return mult ? `${type} ${mult}×` : type;
}

// Limit-reset passes ("Full reset", "Fable reset", ...) are the grants in the usage response's
// cedar_ember block, which the service only adds when asked with ?cedar_ember=1, and only lists for
// a client it recognises: with Node's own User-Agent it answers ineligible_reason "surface", so the
// usage call goes out with Claude Code's (as the ChatGPT call goes out as codex-cli).
const CLAUDE_UA = 'claude-cli/2.1.322 (external, cli)';
const CLAUDE_RESET_NAMES = { session: '5-hour reset', weekly: 'Weekly reset', fable: 'Fable reset', full: 'Full reset' };

// One entry per kind (each launch or tenure reward is its own grant), with the soonest expiry.
// The kind is worked out the way Claude Code does it: a grant that gives back what Fable used is a Fable reset.
function claudeResets(ce) {
  // No block, or an account the feature is not offered to: unknown (null) rather than none.
  if (!ce || (!ce.eligible && !ce.grants?.length)) return null;
  const byName = new Map();
  for (const g of ce.grants || []) {
    if (!(g?.resets_left > 0)) continue;
    const clears = g.clears || [];
    const hour5 = clears.includes('five_hour'); const other = clears.some((c) => c !== 'five_hour');
    const kind = g.gives_back_weekly ? 'fable' : g.type || (hour5 && !other ? 'session' : other && !hour5 ? 'weekly' : 'full');
    const name = CLAUDE_RESET_NAMES[kind];
    if (!byName.has(name)) byName.set(name, { name, count: 0, expiresAt: null });
    const r = byName.get(name);
    r.count += g.resets_left;
    if (g.ends_at && (!r.expiresAt || Date.parse(g.ends_at) < Date.parse(r.expiresAt))) r.expiresAt = g.ends_at;
  }
  return [...byName.values()];
}

async function claude() {
  const call = (token) => fetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': CLAUDE_UA },
  });
  let token = await claudeToken();
  let res = await call(token);
  if (res.status === 401 && !process.env.CLAUDE_CODE_OAUTH_TOKEN) res = await call(token = await claudeToken(true));
  const raw = await okJson(res);
  const limits = [];
  // Current shape: a `limits` list (session, whole week, and one entry per model-scoped weekly limit).
  for (const l of raw.limits || []) {
    if (typeof l.percent !== 'number') continue;
    const model = l.scope?.model?.display_name;
    limits.push({
      key: l.kind === 'session' ? 'five_hour' : l.kind === 'weekly_all' ? 'seven_day' : `seven_day_${model || l.kind}`,
      used: clamp(l.percent),
      resetsAt: l.resets_at || null,
      windowSec: l.group === 'session' ? 18000 : l.group === 'weekly' ? 604800 : null,
    });
  }
  // Older shape: top-level five_hour / seven_day / seven_day_<model> objects.
  for (const [key, v] of limits.length ? [] : Object.entries(raw)) {
    if (v && typeof v === 'object' && typeof v.utilization === 'number') {
      const windowSec = key.startsWith('five_hour') ? 18000 : key.startsWith('seven_day') ? 604800 : null;
      limits.push({ key, used: clamp(v.utilization), resetsAt: v.resets_at || null, windowSec });
    }
  }
  if (Date.now() - claudeProfile.at > PROFILE_MS) {
    const p = await claudeProfilePlan(token).catch((e) => log('claude profile:', e.message));
    if (p) claudeProfile = { at: Date.now(), plan: p };
  }
  let plan = claudeProfile.plan;
  if (!plan) try { plan = readClaudeCreds().claudeAiOauth.subscriptionType || null; } catch { /* token came from the environment */ }
  // Usage credits: `spend.balance` is null when there are none. (Its shape when present is assumed
  // to match `spend.used`: { amount_minor, currency, exponent }.)
  const money = (m) => (m && typeof m.amount_minor === 'number' ? m.amount_minor / 10 ** (m.exponent ?? 2) : 0);
  const credits = raw.spend ? { amount: money(raw.spend.balance), currency: raw.spend.balance?.currency || raw.spend.used?.currency || 'USD' } : null;
  return { raw, plan, limits, resets: claudeResets(raw.cedar_ember), credits };
}

// ───────────────────────── ChatGPT (Codex plan limits) ─────────────────────────
const CODEX_AUTH = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');

async function chatgpt() {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8')); }
  catch { throw new WidgetError('no_login', 'Codex auth.json not found'); }
  const t = auth.tokens;
  if (!t?.access_token) throw new WidgetError('no_login', 'no ChatGPT login in Codex auth.json');
  // account_id is optional in auth.json; the access token carries it as a claim.
  let account = t.account_id;
  if (!account) {
    try { account = JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url'))['https://api.openai.com/auth']?.chatgpt_account_id; } catch { /* not a JWT */ }
  }
  const headers = { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'codex-cli', Accept: 'application/json' };
  if (account) headers['chatgpt-account-id'] = account;
  // The token is never refreshed here: Codex owns it, and rotating it underneath Codex would sign it out.
  const raw = await okJson(await fetch('https://chatgpt.com/backend-api/wham/usage', { headers }));

  const limits = [];
  const add = (w, name) => {
    if (!w || typeof w.used_percent !== 'number') return;
    // Which window is "5-hour" or "weekly" is told by its length, not by primary/secondary.
    const secs = w.limit_window_seconds;
    const key = secs === 18000 ? 'five_hour' : secs === 604800 ? 'seven_day' : `window_${secs}`;
    const at = w.reset_at ? new Date(w.reset_at * 1000).toISOString()
      : typeof w.reset_after_seconds === 'number' ? new Date(Date.now() + w.reset_after_seconds * 1000).toISOString() : null;
    const span = secs === 18000 ? '5h' : secs === 604800 ? 'weekly' : `${Math.round(secs / 3600)}h`;
    limits.push({ key: name ? `${name}_${key}` : key, label: name ? `${name} · ${span}` : undefined, used: clamp(w.used_percent), resetsAt: at, windowSec: secs || null });
  };
  add(raw.rate_limit?.primary_window);
  add(raw.rate_limit?.secondary_window);
  for (const extra of raw.additional_rate_limits || []) { // per-model / per-feature limits
    add(extra.rate_limit?.primary_window, extra.limit_name);
    add(extra.rate_limit?.secondary_window, extra.limit_name);
  }
  const c = raw.credits;
  const credits = c && !c.unlimited && c.balance != null ? { amount: Number(c.balance) || 0 } : null;
  const passes = raw.rate_limit_reset_credits?.available_count || 0;
  const resets = Array.from({ length: passes }, () => ({ name: 'Limit reset' }));
  return { raw, plan: raw.plan_type || null, limits, resets, credits };
}

// ───────────────────────── Antigravity ─────────────────────────
// Antigravity has no public quota API; its own UI asks the language server it runs locally.
// We do the same: find that process, read its CSRF token from the command line, and call it on 127.0.0.1.
let agConn = null; // { port, token, tls }

function findAntigravity() {
  const script = `
    # agy.exe since Antigravity 2.6; language_server*.exe before that
    $p = Get-CimInstance Win32_Process -Filter "Name = 'agy.exe' or Name like 'language_server%'" |
      Where-Object { $_.CommandLine -match 'csrf_token' -and $_.CommandLine -match 'antigravity|--hub' } | Select-Object -First 1
    if ($p) {
      $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
      @{ cmd = $p.CommandLine; ports = $ports } | ConvertTo-Json -Compress
    }`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      if (err) return reject(new WidgetError('upstream', 'process lookup failed'));
      if (!out.trim()) return reject(new WidgetError('no_login', 'Antigravity language server is not running'));
      let found; // a throw here would be outside any promise and end the whole server
      try { found = JSON.parse(out); } catch { return reject(new WidgetError('upstream', 'unreadable process lookup output')); }
      const { cmd, ports } = found;
      const token = (cmd.match(/--csrf_token[= ]+"?([\w-]+)/) || [])[1];
      if (!token) return reject(new WidgetError('upstream', 'no csrf token on the language server command line'));
      resolve({ token, ports: [].concat(ports || []) });
    });
  });
}

function agCall({ port, token, tls }, method = 'GetUserStatus') {
  const body = JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });
  const lib = tls ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      host: '127.0.0.1', port, method: 'POST', timeout: 5000,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      rejectUnauthorized: false, // the language server uses a self-signed certificate on loopback
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': token, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.on('error', reject); // connection dropped mid-answer (Antigravity closing or updating)
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function antigravity() {
  let raw;
  if (agConn) raw = await agCall(agConn).catch(() => { agConn = null; });
  if (!raw) {
    const { token, ports } = await findAntigravity();
    // The process listens on several ports; only one speaks this API.
    for (const port of ports) {
      for (const tls of [true, false]) {
        raw = await agCall({ port, token, tls }).catch(() => null);
        if (raw) { agConn = { port, token, tls }; break; }
      }
      if (raw) break;
    }
    if (!raw) throw new WidgetError('upstream', 'Antigravity language server did not answer');
  }
  // Newer builds report grouped 5-hour / weekly buckets; older ones only per-model quotas.
  const summary = await agCall(agConn, 'RetrieveUserQuotaSummary').catch(() => null);
  const groups = summary?.response?.groups || summary?.groups || [];
  let limits = groups.flatMap((g) => (g.buckets || [])
    .filter((b) => !b.disabled && typeof b.remainingFraction === 'number')
    .map((b) => ({
      key: b.bucketId,
      label: [g.displayName, /-5h$/.test(b.bucketId) ? '5 ชม.' : /-weekly$/.test(b.bucketId) ? 'รายสัปดาห์' : b.displayName].filter(Boolean).join(' · '),
      used: clamp(100 - b.remainingFraction * 100),
      resetsAt: b.resetTime || null,
      windowSec: /-5h$/.test(b.bucketId) ? 18000 : /-weekly$/.test(b.bucketId) ? 604800 : null,
    })));
  if (!limits.length) {
    limits = (raw.userStatus?.cascadeModelConfigData?.clientModelConfigs || [])
      .filter((m) => typeof m.quotaInfo?.remainingFraction === 'number') // missing means unknown, not empty
      .map((m) => ({
        key: m.modelOrAlias?.model || m.label,
        label: m.label,
        used: clamp(100 - m.quotaInfo.remainingFraction * 100),
        resetsAt: m.quotaInfo.resetTime || null,
      }));
  }
  // Most-used first, so the tightest quota is the big number; ties go to the shorter window.
  limits.sort((a, b) => b.used - a.used || (a.windowSec || Infinity) - (b.windowSec || Infinity));
  const plan = raw.userStatus?.planStatus?.planInfo?.planName || null;
  return { raw: { userStatus: raw, quotaSummary: summary }, plan, limits, resets: [], credits: null };
}

// ───────────────────────── shared ─────────────────────────
async function okJson(res) {
  if (res.status === 401 || res.status === 403) throw new WidgetError('expired', `unauthorized (${res.status})`);
  if (res.status === 429) throw new WidgetError('rate_limited', 'rate limited');
  if (!res.ok) throw new WidgetError('upstream', `service returned ${res.status}`);
  return res.json();
}

// ───────────────────────── usage history (for the trend chart) ─────────────────────────
// One sample per fetch, kept for 24 hours and saved to disk so a restart does not empty the chart.
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const DAY_MS = 24 * 3600_000;
let history = {};
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }

function record(name, limits) {
  const now = Date.now();
  const h = (history[name] ||= {});
  for (const l of limits) (h[l.key] ||= []).push([now, Math.round(l.used * 10) / 10]);
  for (const key of Object.keys(h)) {
    h[key] = h[key].filter(([t]) => now - t < DAY_MS);
    if (!h[key].length) delete h[key];
  }
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) { log('history not saved:', e.message); }
}

// At most ~120 points for the chart.
function trend(name, key) {
  const pts = history[name]?.[key] || [];
  const step = Math.ceil(pts.length / 120);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

function demoTrend(usedNow) {
  const now = Date.now();
  return Array.from({ length: 97 }, (_, i) => {
    const hoursAgo = (96 - i) / 4;
    const phase = ((2.6 - hoursAgo) % 5 + 5) % 5; // hours into a 5-hour window
    return [now - hoursAgo * 3600_000, Math.round(Math.min(100, (phase / 2.6) * usedNow * (0.6 + 0.4 * Math.sin(i / 9) ** 2)))];
  });
}

const DEMO_DATA = {
  claude: () => ({
    plan: 'pro',
    limits: [
      { key: 'five_hour', used: 38, resetsAt: inH(2.4), windowSec: 18000 },
      { key: 'seven_day', used: 35, resetsAt: inH(75), windowSec: 604800 },
      { key: 'seven_day_fable', used: 88, resetsAt: inH(75), windowSec: 604800 },
    ],
    resets: [{ name: 'Full reset', count: 1, expiresAt: inH(24 * 30) }, { name: 'Fable reset', count: 2, expiresAt: inH(24 * 6) }],
    credits: { amount: 0, currency: 'USD' },
  }),
  chatgpt: () => ({
    plan: 'plus',
    limits: [{ key: 'five_hour', used: 64, resetsAt: inH(3.5), windowSec: 18000 }, { key: 'seven_day', used: 16, resetsAt: inH(122), windowSec: 604800 }],
    resets: [{ name: 'Limit reset' }],
    credits: { amount: 0 },
  }),
  antigravity: () => ({
    plan: 'Pro',
    limits: ['Gemini Models · 5 ชม.', 'Claude and GPT models · 5 ชม.', 'Gemini Models · รายสัปดาห์', 'Claude and GPT models · รายสัปดาห์', 'Gemini 4 Argon · รายสัปดาห์', 'Extra · รายสัปดาห์']
      .map((label, i) => ({ key: label, label, used: [80, 55, 42, 30, 12, 0][i], resetsAt: inH(i < 2 ? 1.2 : 130), windowSec: i < 2 ? 18000 : 604800 })),
    resets: [],
    credits: null,
  }),
};
const PROVIDERS = { claude, chatgpt, antigravity };
const state = {}; // per provider: { at, body, raw, inflight }

async function getUsage(name) {
  const s = (state[name] ||= {});
  if (s.body && Date.now() - s.at < CACHE_MS) return s.body;
  s.inflight ||= (async () => {
    let body;
    try {
      const { raw, ...data } = DEMO ? { raw: null, ...DEMO_DATA[name]() } : await PROVIDERS[name]();
      s.raw = raw;
      if (!DEMO) record(name, data.limits);
      const first = data.limits[0];
      const points = !first ? [] : DEMO ? demoTrend(first.used) : trend(name, first.key);
      body = { ok: true, fetchedAt: Date.now(), ...data, trend: points };
    } catch (e) {
      // Anything that is not one of our own errors (no internet, a dropped connection, a bad answer) counts as
      // 'upstream'. The widget keeps 'network' for when it cannot reach this server itself.
      const error = e instanceof WidgetError ? e.code : 'upstream';
      log(name, error, e.message, e.cause?.code || e.cause?.message);
      // Keep showing the last good numbers, flagged as stale.
      body = { ...s.body, ok: false, error, fetchedAt: s.body?.fetchedAt || null, limits: s.body?.limits || [] };
    }
    Object.assign(s, { at: Date.now(), body, inflight: null });
    return body;
  })();
  return s.inflight;
}

// The built widget folders, so the same pages can be opened in a browser for testing.
const WIDGETS = { claude: 'ClaudeUsage', chatgpt: 'ChatGPTUsage', antigravity: 'AntigravityUsage' };
const FILES = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'styles/widget.css': ['styles/widget.css', 'text/css; charset=utf-8'],
  'scripts/widget.js': ['scripts/widget.js', 'text/javascript; charset=utf-8'],
  'resources/icon.svg': ['resources/icon.svg', 'image/svg+xml'],
  'resources/logo.png': ['resources/logo.png', 'image/png'],
  'resources/logo.svg': ['resources/logo.svg', 'image/svg+xml'],
  'resources/fonts/NotoSansThai.ttf': ['resources/fonts/NotoSansThai.ttf', 'font/ttf'],
};
const json = (res, data, cors) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(cors && { 'Access-Control-Allow-Origin': '*' }) });
  res.end(JSON.stringify(data, null, 2));
};

async function handle(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'api' && PROVIDERS[parts[1]]) {
    const body = await getUsage(parts[1]);
    // Widgets inside iCUE are not served from this origin, so they need CORS to read the numbers.
    if (parts[2] === 'raw') json(res, state[parts[1]].raw); // unprocessed service response, for mapping new fields
    else json(res, body, true);
  } else if (WIDGETS[parts[0]] && FILES[parts.slice(1).join('/')]) {
    if (parts.length === 1 && !req.url.split('?')[0].endsWith('/')) { res.writeHead(302, { Location: `/${parts[0]}/` }).end(); return; }
    const [file, type] = FILES[parts.slice(1).join('/')];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(__dirname, 'widgets', WIDGETS[parts[0]], file)).on('error', () => res.end()).pipe(res);
  } else if (parts.length === 0) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(Object.keys(WIDGETS).map((n) => `<p><a href="/${n}/">${n}</a></p>`).join(''));
  } else {
    res.writeHead(404).end();
  }
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => {
  log('request', req.url, e.message);
  if (!res.headersSent) res.writeHead(500);
  res.end();
}));
server.on('error', (e) => {
  // Another copy already serves this port: the watchdog task starts one every few minutes and it should just leave.
  if (e.code === 'EADDRINUSE') process.exit(0);
  log('server:', e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  log(`started on port ${PORT}${DEMO ? ' (DEMO data)' : ''}, pid ${process.pid}, node ${process.version}`);
  console.log(`Usage widgets: http://localhost:${PORT}${DEMO ? '  (DEMO data)' : ''}`);
});
