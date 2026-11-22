// Usage widget (shared by the Claude, ChatGPT and Antigravity packages; build.js copies it into each).
// Runs both inside iCUE (as an .icuewidget) and in a browser served by server.js.
//
// The DOM is built once per set of limits (build) and afterwards only its values change (update),
// so the CSS transitions and animations in widget.css are never cut off by a re-render.
'use strict';
const PROVIDER = document.body.dataset.provider;
// Inside iCUE the page is not served over http, so talk to the local server by absolute URL.
const API = location.protocol.startsWith('http') ? '' : 'http://localhost:8787';
const POLL_MS = 30000;
const DAY_MS = 24 * 3600000;
const ENTER_MS = 2600; // how long body.enter stays on: the longest entrance animation, with margin

const LABELS = {
  five_hour: 'ลิมิต 5 ชั่วโมง',
  seven_day: 'ลิมิตรายสัปดาห์',
};
const NO_LOGIN = {
  claude: 'ยังไม่พบการเข้าสู่ระบบ Claude Code<br>เปิดเทอร์มินัลแล้วรัน <b>claude</b> จากนั้นพิมพ์ <b>/login</b>',
  chatgpt: 'ยังไม่พบการเข้าสู่ระบบ Codex<br>เปิดเทอร์มินัลแล้วรัน <b>codex login</b>',
  antigravity: 'ไม่พบ Antigravity ที่กำลังทำงาน<br>เปิด Antigravity แล้วรอสักครู่',
};
const ERRORS = {
  no_login: NO_LOGIN[PROVIDER],
  expired: 'การเข้าสู่ระบบหมดอายุ<br>เข้าสู่ระบบใหม่อีกครั้ง',
  rate_limited: 'เรียกข้อมูลถี่เกินไป กำลังรอลองใหม่',
  upstream: 'เซิร์ฟเวอร์ตอบกลับผิดพลาด กำลังรอลองใหม่',
  network: 'เชื่อมต่อเซิร์ฟเวอร์ในเครื่องไม่ได้<br>รัน <b>start.cmd</b> แล้วรอสักครู่',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let state = null;
let ui = null; // elements of the current build: { hero: {...}, rows: [{...}] }
let shape = ''; // what the current build was made for; a different shape means a rebuild
let enterTimer = 0;

// The server may name a limit itself (model names); otherwise known keys get Thai labels,
// and per-model weekly limits (seven_day_<model>) get a generated one.
function labelFor(l) {
  if (l.label) return esc(l.label);
  if (LABELS[l.key]) return LABELS[l.key];
  const model = (l.key.match(/^seven_day_(.+)$/) || [])[1];
  const pretty = (model || l.key).replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
  return model ? `รายสัปดาห์ · ${esc(pretty)}` : esc(pretty);
}

function duration(sec) {
  let s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d} วัน ${h} ชม.`;
  if (h) return `${h} ชม. ${m} นาที`;
  return `${m} นาที ${String(s % 60).padStart(2, '0')} วินาที`;
}
// Compact countdown for the ring centre: [number, unit], "4:12" ชม. or "2:36" นาที.
function countdown(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h ? [`${h}:${String(m).padStart(2, '0')}`, 'ชม.'] : [`${m}:${String(s % 60).padStart(2, '0')}`, 'นาที'];
}
const hhmm = (d) => d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

// "เวลา 14:00 น." today, otherwise with the day.
function clock(iso) {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return today ? `เวลา ${hhmm(d)} น.` : `${d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(d)} น.`;
}

// A pass's expiry, short enough for one line: the day ("26 พ.ย."), or the time when that is today.
function expiry(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? `${hhmm(d)} น.` : d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}

function view(l) {
  const left = Math.round(100 - l.used);
  const secsLeft = l.resetsAt ? (new Date(l.resetsAt) - Date.now()) / 1000 : null;
  // How far through the window we are, and whether usage is running ahead of the clock.
  let elapsed = null; let fast = null;
  if (secsLeft != null && l.windowSec) {
    elapsed = Math.max(0, Math.min(1, 1 - secsLeft / l.windowSec));
    if (elapsed > 0.03 && l.used > elapsed * 100 + 5 && l.used < 100) {
      const secsToEmpty = (100 - l.used) / (l.used / (elapsed * l.windowSec));
      if (secsToEmpty < secsLeft) fast = secsToEmpty;
    }
  }
  // Out: nothing left to use until the window resets (0% as shown, so 99.5% used counts too).
  const out = left <= 0;
  const until = secsLeft != null ? `รีเซ็ตใน <b>${duration(secsLeft)}</b>` : '';
  return {
    left, elapsed, fast, secsLeft, out,
    cls: out ? 'crit out' : left < 20 ? 'crit' : left < 50 ? 'low' : '',
    name: labelFor(l),
    reset: out ? `<em>หมดแล้ว</em>${until ? ` · ${until}` : ''}` : `${left < 20 ? 'ใกล้หมด · ' : ''}${until}`,
    at: l.resetsAt ? clock(l.resetsAt) : '',
  };
}

// ── small DOM helpers: write only what changed, so nothing flickers on the one-second tick ──
function setHtml(el, html) {
  if (el._html !== html) { el._html = html; el.innerHTML = html; }
}
function setClass(el, cls) {
  if (el.className !== cls) el.className = cls;
}
// Counts a number up or down to its new value.
function count(el, to, instant) {
  if (el._to === to) return;
  el._to = to;
  cancelAnimationFrame(el._raf);
  const from = el._now ?? 0;
  if (instant || document.hidden) { el._now = to; el.textContent = to; return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 1200);
    el._now = from + (to - from) * (1 - (1 - k) ** 3);
    el.textContent = Math.round(el._now);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// Long limit names: narrow the letters (the font has a width axis) before giving up and
// cutting the name short. The hero name may wrap instead, so it only narrows if that keeps it on one line.
function squeeze(el) {
  for (const s of ['', '87.5%', '75%', '62.5%']) {
    el.style.fontStretch = s;
    if (el.scrollWidth <= el.clientWidth) return true;
  }
  return false;
}
function squeezeNames() {
  if (!ui) return;
  for (const r of ui.rows) squeeze(r.name);
  const name = ui.hero.name;
  name.style.whiteSpace = 'nowrap';
  if (!squeeze(name)) name.style.fontStretch = '';
  name.style.whiteSpace = '';
}

// ── markup, built empty (gauges at zero) and filled in by update() ──

// Ring gauge: 60 ticks, the coloured part is what is left; the white tick marks where
// the remaining quota would be if it were used evenly over the window. A highlight
// (mask "spark") circles round and shows only on the coloured part (mask "left").
function heroShell() {
  // One rotated group so every circle starts at 12 o'clock. A userSpaceOnUse mask is drawn in the
  // user space of the element it masks, which includes that element's own transform: a rotation on
  // both the masked circle and the mask circle would add up (the arc used to start at 9 o'clock).
  const circle = 'cx="100" cy="100" r="86" fill="none" stroke-width="18"';
  const ticks = `${circle} pathLength="120" stroke-dasharray="1.45 .55"`;
  const box = 'maskUnits="userSpaceOnUse" x="-10" y="-10" width="220" height="220"';
  return `<div class="ring" role="img">
    <svg viewBox="0 0 200 200">
      <g transform="rotate(-90 100 100)">
        <mask id="left" ${box}><circle class="arc" ${circle} stroke="#fff" pathLength="100" style="stroke-dasharray:0 100"/></mask>
        <mask id="spark" ${box}><circle class="spark" ${circle} stroke="#fff" pathLength="100" stroke-dasharray="7 93"/></mask>
        <circle class="track" ${ticks}/>
        <circle class="prog" ${ticks} mask="url(#left)"/>
        <g mask="url(#left)"><circle class="shine" ${ticks} mask="url(#spark)"/></g>
      </g>
      <line class="pace" x1="100" y1="1" x2="100" y2="27"/>
    </svg>
    <div class="center"><div class="num"><span class="v">0</span><i>%</i></div><div class="left">เหลือ</div></div>
  </div>
  <div class="info">
    <div class="name"></div>
    <div class="reset"></div>
    <div class="at"></div>
    <div class="chip" hidden></div>
  </div>`;
}

function rowShell(_, i) {
  return `<div class="row" style="--i:${i + 4}">
    <div class="label"><div class="name"></div><div class="reset"></div></div>
    <div class="mid gauge" role="img"><div class="meter"><div class="fill"></div></div><span class="mark" hidden></span></div>
    <div class="end num"><span class="v">0</span><i>%</i></div>
  </div>`;
}

// Remaining quota of the hero limit over the last 24 hours.
function trend(l) {
  const pts = state.trend || [];
  const head = `<div class="head"><b>แนวโน้ม 24 ชม.</b><span>${labelFor(l)}</span></div>`;
  const now = Date.now();
  const xy = pts.filter(([t]) => now - t <= DAY_MS).map(([t, used]) => [(1 - (now - t) / DAY_MS) * 300, Math.max(0, Math.min(100, used))]);
  if (xy.length < 3) return `${head}<div class="plot"><div class="wait">กำลังเก็บข้อมูลแนวโน้ม</div></div>`;
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = xy[xy.length - 1];
  const area = `${xy[0][0].toFixed(1)},100 ${line} ${lastX.toFixed(1)},100`;
  const svg = 'viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true"';
  return `${head}<div class="plot">
    <div class="canvas">
      <svg ${svg}><line class="grid" x1="0" y1="0" x2="300" y2="0"/><line class="grid mid" x1="0" y1="50" x2="300" y2="50"/><line class="grid" x1="0" y1="100" x2="300" y2="100"/></svg>
      <svg class="data" ${svg}>
        <defs><linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100"><stop class="fade-a" offset="0"/><stop class="fade-b" offset="1"/></linearGradient></defs>
        <polygon class="area" points="${area}"/><polyline class="curve" points="${line}"/>
      </svg>
      <i class="now" style="left:${(lastX / 3).toFixed(2)}%;top:${lastY.toFixed(2)}%"></i>
    </div>
    <span class="axis" style="top:0">100%</span><span class="axis" style="bottom:0">0%</span>
  </div>`;
}

// Limit-reset passes and credits; the row only appears when the server has either.
function extras() {
  const resets = state.resets || [];
  const c = state.credits;
  if (!resets.length && !c) return '';
  const amount = c && (c.currency
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: c.currency, maximumFractionDigits: c.amount % 1 ? 2 : 0 }).format(c.amount)
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(c.amount));
  // A pass without a count is one pass. Passes the server groups by kind (count) or dates are listed
  // by name; anonymous ones (ChatGPT's "Limit reset") only add to the total.
  const total = resets.reduce((n, r) => n + (r.count ?? 1), 0);
  const named = resets.filter((r) => r.expiresAt || r.count);
  // resets === null means the provider does not report passes at all: then the row is just credits.
  const label = state.resets
    ? `<div class="name">สิทธิ์รีเซ็ตลิมิต</div><div class="reset">${total ? `ใช้ได้ <b>${total} ครั้ง</b>` : 'ไม่มีสิทธิ์เหลือ'}</div>`
    : '<div class="name">เครดิต</div><div class="reset">ใช้เมื่อเกินลิมิต</div>';
  return `<div class="label">${label}</div>
    <div class="mid items">${named.map((r) => `<div><b>${esc(r.name)}${r.count > 1 ? ` ×${r.count}` : ''}</b><span>${r.expiresAt ? `หมดอายุ ${expiry(r.expiresAt)}` : ''}</span></div>`).join('')}</div>
    <div class="end credit">${c ? `<div class="num">${amount}</div><span>เครดิตคงเหลือ</span>` : ''}</div>`;
}

// Some providers report many limits. Drop rows from the bottom until the column fits its slot.
function fit() {
  const side = $('side');
  if (!side.clientHeight) return; // not laid out yet (iCUE's assignment view)
  const rows = [...side.querySelectorAll('.row:not(.extras)')];
  while (rows.length && side.scrollHeight > side.clientHeight + 1) rows.pop().remove();
}

// Writes the current numbers into the built DOM. Runs every second (countdowns) and on new data.
function update(instant) {
  const [first, ...rest] = state.limits;
  const v = view(first);
  const h = ui.hero;
  // Used up with a known reset: the ring turns into a countdown to the next window. The arc is the
  // time left in this window and drains to the reset; the number is that time.
  const wait = v.out && v.secsLeft != null;
  setClass(h.ring, `ring ${v.cls}${wait ? ' wait' : ''}`);
  h.ring.setAttribute('aria-label', wait ? `หมดแล้ว รีเซ็ตใน ${duration(v.secsLeft)}` : `เหลือ ${v.left}%`);
  h.arc.style.strokeDasharray = `${wait ? (v.elapsed == null ? 0 : (1 - v.elapsed) * 100).toFixed(2) : v.left} 100`;
  h.pace.style.display = v.elapsed == null || wait ? 'none' : '';
  if (v.elapsed != null) h.pace.style.transform = `rotate(${((1 - v.elapsed) * 360).toFixed(2)}deg)`;
  if (wait) {
    const [n, unit] = countdown(v.secsLeft);
    cancelAnimationFrame(h.num._raf);
    h.num._to = null; h.num._now = 0; // when the window resets, the percentage counts up from zero
    if (h.num.textContent !== n) h.num.textContent = n;
    setHtml(h.unit, unit);
    setHtml(h.caption, 'จนถึงรอบใหม่');
  } else {
    if (h.num._to === null) h.num.textContent = 0; // leaving the countdown: no "4:11%" frame before the count starts
    count(h.num, v.left, instant);
    setHtml(h.unit, '%');
    setHtml(h.caption, 'เหลือ');
  }
  setHtml(h.name, v.name);
  setHtml(h.reset, wait ? '<em>หมดแล้ว</em> · รอรอบใหม่' : v.reset); // the ring already counts down
  setHtml(h.at, v.at);
  h.chip.hidden = v.elapsed == null || v.out; // the pace forecast means nothing once it is used up
  setClass(h.chip, v.fast != null ? 'chip fast' : 'chip');
  setHtml(h.chip, `<span class="dot"></span>${v.fast != null ? `อัตรานี้จะหมดใน ${duration(v.fast).replace(/ \d+ วินาที$/, '')}` : 'พอใช้ถึงรอบรีเซ็ต'}`);

  rest.forEach((l, i) => {
    const r = ui.rows[i];
    const w = view(l);
    setClass(r.row, `row ${w.cls}`);
    r.gauge.setAttribute('aria-label', `เหลือ ${w.left}%`);
    r.fill.style.width = `${w.left}%`;
    r.mark.hidden = w.elapsed == null;
    if (w.elapsed != null) r.mark.style.left = `${((1 - w.elapsed) * 100).toFixed(1)}%`;
    count(r.num, w.left, instant);
    setHtml(r.name, w.name);
    setHtml(r.reset, w.reset);
  });
}

// The parts that only change when new data arrives: the chart and the passes / credits row.
function refresh() {
  $('trend').innerHTML = trend(state.limits[0]);
  if (ui.extras) setHtml(ui.extras, extras());
}

// Builds everything from scratch. `animate` plays the entrance and lets the gauges sweep up from
// zero; without it (resize) the new layout simply appears with its final values.
function build(animate) {
  const body = document.body;
  const [first, ...rest] = state.limits;
  clearTimeout(enterTimer);
  // `enter` goes on only after fit() has measured: the entrance starts rows shifted down,
  // which would count as overflow and cost a row.
  body.classList.remove('enter');
  body.classList.add('instant');
  if (!first) {
    ui = null;
    $('hero').innerHTML = `<div id="msg"><div>${ERRORS[state.error] || 'ไม่มีข้อมูลโควตา'}</div></div>`;
    $('trend').innerHTML = $('side').innerHTML = '';
  } else {
    const hero = $('hero'); const side = $('side');
    hero.innerHTML = heroShell();
    side.innerHTML = rest.map(rowShell).join('') + (extras() ? `<div class="row extras" style="--i:${rest.length + 4}"></div>` : '');
    const q = (root, sel) => root.querySelector(sel);
    ui = {
      hero: { ring: q(hero, '.ring'), arc: q(hero, '.arc'), pace: q(hero, '.pace'), num: q(hero, '.v'), unit: q(hero, '.center i'), caption: q(hero, '.center .left'), name: q(hero, '.name'), reset: q(hero, '.reset'), at: q(hero, '.at'), chip: q(hero, '.chip') },
      rows: [...side.querySelectorAll('.row:not(.extras)')].map((row) => ({ row, gauge: q(row, '.gauge'), fill: q(row, '.fill'), mark: q(row, '.mark'), num: q(row, '.v'), name: q(row, '.name'), reset: q(row, '.reset') })),
      extras: q(side, '.extras'),
    };
    refresh();
    // Fill in the texts first so fit() measures real rows; the gauges are still at zero, and the
    // reflow in between is what makes them animate from there.
    update(true);
    squeezeNames();
    fit();
    if (animate) {
      body.classList.add('enter');
      for (const el of [ui.hero.num, ...ui.rows.map((r) => r.num)]) { el._to = el._now = 0; el.textContent = 0; }
      ui.hero.arc.style.strokeDasharray = '0 100';
      for (const r of ui.rows) r.fill.style.width = '0';
      void body.offsetWidth;
      body.classList.remove('instant');
      update(false);
    }
  }
  if (animate) body.classList.add('enter');
  void body.offsetWidth;
  body.classList.remove('instant');
  if (animate) enterTimer = setTimeout(() => body.classList.remove('enter'), ENTER_MS);
}

// why: 'data' after a poll, 'resize' after the slot changed size, undefined for the one-second tick.
function render(why) {
  if (!state) return;
  const body = document.body;
  body.classList.toggle('stale', !state.ok);
  const [first] = state.limits;
  body.classList.toggle('empty', !first);
  const next = first ? JSON.stringify([state.limits.map((l) => l.key), !!extras()]) : `empty:${state.error}`;
  if (next !== shape) {
    // Animate when content appears (first load, or data after an error screen), not when a limit comes or goes.
    const animate = !shape || !first || shape.startsWith('empty:');
    shape = next;
    build(animate);
  } else if (why === 'resize') {
    build(false);
  } else if (first) {
    if (why === 'data') refresh();
    update(false);
  }
  const plan = $('plan');
  plan.hidden = !state.plan;
  plan.textContent = state.plan || '';
  const t = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const text = state.ok ? `อัปเดต ${t}`
    : first ? `ข้อมูลเก่า ${t} · ${(ERRORS[state.error] || ERRORS.network).split('<')[0]}` : 'ยังไม่มีข้อมูล';
  setHtml($('status'), `<span class="dot"></span>${esc(text)}`);
}

async function poll() {
  try {
    state = await (await fetch(`${API}/api/${PROVIDER}`)).json();
  } catch (e) {
    // Server down, or the localhost permission was denied in iCUE: keep the last numbers, flagged stale.
    state = { ...state, ok: false, error: 'network', fetchedAt: (state && state.fetchedAt) || null, limits: (state && state.limits) || [] };
  }
  render('data');
}

poll();
setInterval(poll, POLL_MS);
setInterval(() => render(), 1000); // keeps the reset countdowns ticking
window.addEventListener('resize', () => render('resize'));
document.fonts.ready.then(squeezeNames); // names were measured with the fallback font if it loaded late
