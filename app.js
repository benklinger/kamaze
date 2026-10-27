// כמה עולה? – daily price-guessing game. Static, no build step.
const BASE = location.pathname.replace(/[^/]*$/, '');
const SHARE_URL = location.origin + BASE;
const STORAGE_KEY = 'kamaze.v1';

const app = document.getElementById('app');
const footer = document.getElementById('footer');
const toastEl = document.getElementById('toast');

// ---------- storage ----------
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { results: {} }; }
  catch { return { results: {} }; }
}
function saveState(s) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {} }
function getResult(date, type) { return loadState().results[`${date}:${type}`]; }
function setResult(date, type, r) {
  const s = loadState();
  if (!s.results[`${date}:${type}`]) { s.results[`${date}:${type}`] = r; saveState(s); }
}

// ---------- dates ----------
const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const HE_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
function todayIL() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function toDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(iso, n) { const d = toDate(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function fmtLong(iso) { const d = toDate(iso); return `${d.getDate()} ב${HE_MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function fmtShort(iso) { const [y, m, d] = iso.split('-'); return `${Number(d)}.${Number(m)}.${y}`; }
function dayName(iso) { return HE_DAYS[toDate(iso).getDay()]; }
function relDay(iso) {
  const t = todayIL();
  if (iso === t) return 'היום';
  if (iso === addDays(t, -1)) return 'אתמול';
  return fmtLong(iso);
}

// ---------- money ----------
function fmtPrice(agorot) {
  const s = Math.floor(agorot / 100), a = agorot % 100;
  return `₪${s}<span class="agorot">${String(a).padStart(2, '0')}</span>`;
}
function fmtPlain(agorot) { return `₪${(agorot / 100).toFixed(2)}`; }
const toAgorot = x => Math.round(Number(x) * 100);

// ---------- scoring ----------
function accuracyDots(guess, actual) {
  const err = Math.abs(guess - actual) / actual;
  if (err <= 0.02) return 5; if (err <= 0.05) return 4; if (err <= 0.10) return 3;
  if (err <= 0.20) return 2; if (err <= 0.35) return 1; return 0;
}
const dotsStr = n => '🟩'.repeat(n) + '⬜'.repeat(5 - n);

// ---------- data ----------
const cache = {};
async function fetchJSON(path) {
  if (cache[path]) return cache[path];
  const res = await fetch(`${path}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return (cache[path] = await res.json());
}
const getIndex = () => fetchJSON('data/index.json');
const getDay = date => fetchJSON(`data/days/${date}.json`);

function itemFor(day, type) {
  if (type === 'product') {
    const p = day.products[0];
    return { title: p.name, products: [p] };
  }
  const prods = day.basket.products.map(id => day.products.find(p => p.id === id)).filter(Boolean);
  return { title: day.basket.name, products: prods };
}
function totals(products) {
  return products.reduce((t, p) => ({
    min: t.min + toAgorot(p.min), max: t.max + toAgorot(p.max), price: t.price + toAgorot(p.price)
  }), { min: 0, max: 0, price: 0 });
}

// ---------- stats ----------
function computeStats() {
  const results = loadState().results;
  const entries = Object.entries(results).map(([k, r]) => ({ date: k.split(':')[0], type: k.split(':')[1], ...r }));
  const dates = [...new Set(entries.map(e => e.date))].sort();
  const t = todayIL();
  let streak = 0, cursor = dates.includes(t) ? t : addDays(t, -1);
  while (dates.includes(cursor)) { streak++; cursor = addDays(cursor, -1); }
  let best = 0, run = 0, prev = null;
  for (const d of dates) { run = (prev && addDays(prev, 1) === d) ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  const errs = entries.map(e => Math.abs(e.guess - e.actual) / e.actual);
  const avgErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0;
  const dist = [0, 0, 0, 0, 0, 0];
  entries.forEach(e => dist[accuracyDots(e.guess, e.actual)]++);
  return { games: entries.length, days: dates.length, streak, best, avgErr, dist };
}

// ---------- ui helpers ----------
function setFooter(day) {
  footer.innerHTML = day ? `המחיר נכון ל${relDay(day.date)},<br>ב${day.store}` : '';
}
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); setTimeout(() => toastEl.classList.remove('show'), 2200); }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function render(node) { app.replaceChildren(node); window.scrollTo(0, 0); }
function renderError(msg) {
  render(el(`<div class="view"><div class="error-message">${esc(msg)}</div><p class="center" style="margin-top:16px"><a class="btn" href="#/">לדף הראשי</a></p></div>`));
  setFooter(null);
}

// ---------- views ----------
async function viewHome(date) {
  const index = await getIndex();
  const t = todayIL();
  if (!date) date = index.days.find(d => d.date === t) ? t : index.days[0]?.date;
  if (!date) return renderError('עדיין אין משחק להיום. נסו שוב מאוחר יותר.');
  let day;
  try { day = await getDay(date); } catch { return renderError(`לא נמצא משחק לתאריך ${fmtShort(date)}.`); }

  const v = el(`<div class="view">
    <h1>${date === t ? 'המשחק של היום' : `המשחק של יום ${dayName(date)}, ${fmtShort(date)}`}</h1>
    <p class="tagline">כמה זה עולה ב${esc(day.chainName)}? גררו, נחשו, ושתפו.</p>
    <div class="options"></div>
    <div class="stats-strip"></div>
    <p class="center" style="margin-top:14px"><a href="#/archive" class="muted">פספסתם יום? לארכיון ←</a></p>
  </div>`);
  const opts = v.querySelector('.options');
  for (const type of ['product', 'basket']) {
    const item = itemFor(day, type);
    const r = getResult(date, type);
    const label = type === 'product' ? 'המוצר' : 'הסל';
    const a = el(`<a class="option-button ${r ? 'done' : ''}" href="#/d/${date}/${type}${r ? '/r' : ''}">
      <img class="option-thumb" src="${esc(item.products[0].image)}" alt="" loading="lazy">
      <div class="option-text">
        <div class="option-title">${esc(item.title)}</div>
        <div class="option-subtitle">${label} של יום ${dayName(date)}, ${fmtShort(date)}${type === 'basket' ? ` · ${item.products.length} מוצרים` : ''}</div>
        ${r ? `<div class="option-result">${dotsStr(accuracyDots(r.guess, r.actual))} שיחקתם · לתוצאה</div>` : ''}
      </div><div>${r ? '✓' : '←'}</div></a>`);
    opts.appendChild(a);
  }
  const s = computeStats();
  v.querySelector('.stats-strip').innerHTML = `
    <div class="stat"><b>${s.streak}</b><span>רצף ימים 🔥</span></div>
    <div class="stat"><b>${s.games}</b><span>משחקים</span></div>
    <div class="stat"><b>${s.games ? Math.round((1 - s.avgErr) * 100) + '%' : '–'}</b><span>דיוק ממוצע</span></div>`;
  render(v); setFooter(day);
}

async function viewGame(date, type) {
  let day;
  try { day = await getDay(date); } catch { return renderError(`לא נמצא משחק לתאריך ${fmtShort(date)}.`); }
  if (getResult(date, type)) { location.replace(`#/d/${date}/${type}/r`); return; }
  const item = itemFor(day, type);
  if (!item.products.length) return renderError('אין מוצרים במשחק הזה.');
  const { min, max, price } = totals(item.products);
  const multi = item.products.length > 1;

  const v = el(`<div class="view">
    <h1 id="product-title">${esc(item.title)}</h1>
    <h3 id="product-subtitle">${multi ? esc(item.products[0].name) : `${esc(day.chainName)} · ${relDay(date)}`}</h3>
    <div class="product-image-wrap"><img id="product-image" class="product-image" src="${esc(item.products[0].image)}" alt="${esc(item.products[0].name)}"></div>
    ${multi ? '<div class="dots-container"></div><ul class="basket-list"></ul>' : ''}
    <p class="hint">${multi ? 'כמה עולים כל המוצרים ביחד? ' : ''}גררו את הכפתור ימינה ושמאלה, ולחצו לאישור</p>
    <button id="confirm-button" class="price-button" aria-label="אשרו את הניחוש">זה עולה <span id="button-price"></span></button>
    <div class="range-labels"><span>${fmtPlain(min)}</span><span>${fmtPlain(max)}</span></div>
  </div>`);
  render(v); setFooter(day);

  // --- gallery for baskets ---
  const img = v.querySelector('#product-image');
  let idx = 0;
  if (multi) {
    const dots = v.querySelector('.dots-container'), list = v.querySelector('.basket-list');
    item.products.forEach((p, i) => {
      const d = el(`<span class="dot ${i === 0 ? 'active' : ''}" role="button" aria-label="מוצר ${i + 1}"></span>`);
      d.addEventListener('click', () => go(i)); dots.appendChild(d);
      const li = el(`<li class="${i === 0 ? 'active' : ''}">${esc(p.name)}</li>`); li.addEventListener('click', () => go(i)); list.appendChild(li);
      new Image().src = p.image;
    });
    const sub = v.querySelector('#product-subtitle');
    function go(i, dir) {
      if (i === idx) return;
      dir = dir || (i > idx ? 'left' : 'right');
      idx = (i + item.products.length) % item.products.length;
      const p = item.products[idx];
      sub.textContent = p.name;
      [...dots.children].forEach((d, k) => d.classList.toggle('active', k === idx));
      [...list.children].forEach((d, k) => d.classList.toggle('active', k === idx));
      const out = dir === 'left' ? 'slide-out-left' : 'slide-out-right', inn = dir === 'left' ? 'slide-in-right' : 'slide-in-left';
      img.classList.remove('slide-in-left', 'slide-in-right', 'slide-out-left', 'slide-out-right');
      img.classList.add(out);
      img.addEventListener('animationend', function h() {
        img.removeEventListener('animationend', h);
        img.classList.remove(out); img.src = p.image; img.alt = p.name; img.classList.add(inn);
        img.addEventListener('animationend', () => img.classList.remove(inn), { once: true });
      }, { once: true });
    }
    img.addEventListener('click', () => go(idx + 1, 'left'));
    let sx = 0;
    img.addEventListener('touchstart', e => { sx = e.changedTouches[0].screenX; }, { passive: true });
    img.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].screenX - sx;
      if (Math.abs(dx) > 50) go(dx > 0 ? idx - 1 : idx + 1, dx > 0 ? 'right' : 'left');
    }, { passive: true });
  }

  // --- slider button ---
  let step = 10, n = (max - min) / step;
  if (n < 20) step = Math.max(10, Math.ceil((max - min) / 20 / 10) * 10);
  if (n > 400) step = Math.ceil((max - min) / 400 / 10) * 10;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const btn = v.querySelector('#confirm-button'), out = v.querySelector('#button-price');
  let value = lo;
  function show(val) {
    value = val; out.innerHTML = fmtPrice(val);
    const pct = ((val - lo) / (hi - lo)) * 100;
    btn.style.background = `linear-gradient(to right, var(--green-dark) 0%, var(--green-dark) ${pct}%, var(--green-light) ${pct}%, var(--green-light) 100%)`;
  }
  show(lo);
  // intro animation to the middle
  const mid = Math.round((lo + hi) / 2 / step) * step;
  const t0 = performance.now();
  (function anim(now) {
    const k = Math.min(1, (now - t0) / 600);
    show(Math.round((lo + (mid - lo) * (1 - Math.pow(1 - k, 3))) / step) * step);
    if (k < 1) requestAnimationFrame(anim);
  })(t0);

  let dragging = false, dragged = false, startX = 0;
  btn.addEventListener('pointerdown', e => { e.preventDefault(); dragging = true; dragged = false; startX = e.clientX; btn.setPointerCapture(e.pointerId); });
  btn.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (!dragged && Math.abs(e.clientX - startX) > 5) dragged = true;
    if (!dragged) return;
    const r = btn.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const snapped = Math.round((lo + pct * (hi - lo)) / step) * step;
    if (snapped !== value) show(Math.max(lo, Math.min(hi, snapped)));
  });
  const end = e => { if (dragging) { dragging = false; try { btn.releasePointerCapture(e.pointerId); } catch {} } };
  btn.addEventListener('pointerup', end); btn.addEventListener('pointercancel', end);
  btn.addEventListener('click', e => {
    e.preventDefault();
    if (dragged) { dragged = false; return; }
    setResult(date, type, { guess: value, actual: price, ts: Date.now() });
    location.hash = `#/d/${date}/${type}/r`;
  });
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') show(Math.max(lo, value - step));
    if (e.key === 'ArrowRight') show(Math.min(hi, value + step));
  });
}

async function viewResult(date, type) {
  let day;
  try { day = await getDay(date); } catch { return renderError(`לא נמצא משחק לתאריך ${fmtShort(date)}.`); }
  const r = getResult(date, type);
  if (!r) { location.replace(`#/d/${date}/${type}`); return; }
  const item = itemFor(day, type);
  const diff = r.actual - r.guess;
  const dots = accuracyDots(r.guess, r.actual);
  const verdict = diff === 0 ? 'בול! ניחשתם את המחיר המדויק' : diff > 0 ? `הניחוש שלכם היה נמוך ב-${fmtPlain(diff)}` : `הניחוש שלכם היה גבוה ב-${fmtPlain(-diff)}`;
  const pct = Math.round(Math.abs(diff) / r.actual * 100);
  const accText = ['רחוק מאוד', 'לא רע', 'קרוב', 'קרוב מאוד', 'כמעט מדויק', 'מושלם'][dots];
  const other = type === 'product' ? 'basket' : 'product';
  const otherItem = itemFor(day, other);
  const otherDone = getResult(date, other);
  const index = await getIndex();
  const prev = index.days.find(d => d.date < date);

  const v = el(`<div class="view">
    <div class="result-card">
      <div class="price-label">${esc(item.title)} עולה</div>
      <div class="actual-price">${fmtPrice(r.actual)}</div>
      <div class="verdict ${diff === 0 ? 'correct' : ''}">${verdict}</div>
      <div class="accuracy">${dotsStr(dots)}</div>
      <div class="accuracy-text">${accText} · סטייה של ${pct}% · ניחשתם ${fmtPlain(r.guess)}</div>
      ${item.products.length > 1 ? `<ul class="breakdown">${item.products.map(p => `<li><span>${esc(p.name)}</span><span>${fmtPlain(toAgorot(p.price))}</span></li>`).join('')}</ul>` : ''}
      <div class="btn-row"><button class="btn primary" id="share-btn">שיתוף 📤</button><a class="btn" href="#/stats">סטטיסטיקה</a></div>
    </div>
    <hr>
    <h2>${otherDone ? 'עוד משחקים' : 'עוד לא סיימתם'}</h2>
    <div class="options">
      <a class="option-button ${otherDone ? 'done' : ''}" href="#/d/${date}/${other}${otherDone ? '/r' : ''}">
        <img class="option-thumb" src="${esc(otherItem.products[0].image)}" alt="">
        <div class="option-text"><div class="option-title">${esc(otherItem.title)}</div>
        <div class="option-subtitle">${other === 'product' ? 'המוצר' : 'הסל'} של ${relDay(date)}</div>
        ${otherDone ? `<div class="option-result">${dotsStr(accuracyDots(otherDone.guess, otherDone.actual))}</div>` : ''}</div><div>${otherDone ? '✓' : '←'}</div></a>
      ${prev ? `<a class="option-button" href="#/d/${prev.date}">
        <div class="option-text"><div class="option-title">המשחק של יום ${dayName(prev.date)}</div>
        <div class="option-subtitle">${esc(prev.product)} · ${esc(prev.basket)}</div></div><div>←</div></a>` : ''}
      <a class="option-button" href="#/archive"><div class="option-text"><div class="option-title">ארכיון</div><div class="option-subtitle">כל המשחקים הקודמים</div></div><div>←</div></a>
    </div>
  </div>`);
  render(v); setFooter(day);

  v.querySelector('#share-btn').addEventListener('click', async () => {
    const emoji = type === 'product' ? '🛒' : '🧺';
    const text = `כמה עולה? · ${fmtShort(date)}\n${emoji} ${item.title}\n${dotsStr(dots)} ${accText} (${pct}%)\n${SHARE_URL}#/d/${date}/${type}`;
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text); toast('הועתק! הדביקו בוואטסאפ 📋');
    } catch { toast('לא הצלחנו לשתף'); }
  });
}

async function viewArchive() {
  const index = await getIndex();
  const v = el(`<div class="view"><h1>ארכיון</h1><p class="tagline">כל המשחקים, מהחדש לישן.</p><ul class="archive-list"></ul></div>`);
  const ul = v.querySelector('ul');
  for (const d of index.days) {
    const rp = getResult(d.date, 'product'), rb = getResult(d.date, 'basket');
    const marks = [rp && dotsStr(accuracyDots(rp.guess, rp.actual)), rb && dotsStr(accuracyDots(rb.guess, rb.actual))].filter(Boolean).join(' ');
    ul.appendChild(el(`<li><a href="#/d/${d.date}"><div><div class="archive-date">יום ${dayName(d.date)}, ${fmtShort(d.date)}</div>
      <div class="archive-meta">${esc(d.product)} · ${esc(d.basket)} · ${esc(d.chainName)}</div></div>
      <div class="archive-mark">${marks || '←'}</div></a></li>`));
  }
  render(v); setFooter(null);
}

function viewStats() {
  const s = computeStats();
  const labels = ['רחוק', 'לא רע', 'קרוב', 'קרוב מאוד', 'כמעט', 'מושלם'];
  const maxN = Math.max(1, ...s.dist);
  const v = el(`<div class="view"><h1>הסטטיסטיקה שלכם</h1>
    <div class="stats-grid">
      <div class="stat"><b>${s.streak}</b><span>רצף נוכחי 🔥</span></div>
      <div class="stat"><b>${s.best}</b><span>הרצף הכי ארוך</span></div>
      <div class="stat"><b>${s.games}</b><span>משחקים</span></div>
      <div class="stat"><b>${s.games ? Math.round((1 - s.avgErr) * 100) + '%' : '–'}</b><span>דיוק ממוצע</span></div>
    </div>
    <div class="histogram"><h2>התפלגות הדיוק</h2>
      ${s.dist.map((n, i) => `<div class="row"><span class="lbl">${dotsStr(i).slice(0, 10)}</span><div class="bar" style="width:${(n / maxN) * 60}%"></div><span>${n} · ${labels[i]}</span></div>`).reverse().join('')}
    </div>
    <p class="muted" style="margin-top:20px;font-size:.85rem">הנתונים נשמרים בדפדפן הזה בלבד.</p>
    <p class="center"><a class="btn" href="#/">למשחק של היום</a></p></div>`);
  render(v); setFooter(null);
}

// ---------- router ----------
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'archive') return await viewArchive();
    if (parts[0] === 'stats') return viewStats();
    if (parts[0] === 'd' && /^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '')) {
      const [, date, type, r] = parts;
      if (type === 'product' || type === 'basket') return r === 'r' ? await viewResult(date, type) : await viewGame(date, type);
      return await viewHome(date);
    }
    return await viewHome();
  } catch (e) {
    console.error(e); renderError('שגיאה בטעינת הנתונים. נסו שוב מאוחר יותר.');
  }
}
window.addEventListener('hashchange', route);
route();
