/* QR Platform front-end (vanilla JS, no build step) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function qrUrl(data, style = {}, format = 'png', size = 512) {
  const p = new URLSearchParams({ data, format, size: String(size) });
  if (style.dark) p.set('dark', style.dark.replace('#', ''));
  if (style.light) p.set('light', style.light.replace('#', ''));
  if (style.ecc) p.set('ecc', style.ecc);
  if (style.margin !== undefined) p.set('margin', String(style.margin));
  return '/api/qr?' + p;
}

function download(href, filename) {
  const a = document.createElement('a');
  a.href = href; a.download = filename; document.body.append(a); a.click(); a.remove();
}
const slugify = (s) => (s || 'qr-code').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'qr-code';

// ---------- tabs ----------
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'dynamic') loadDynamic();
  history.replaceState(null, '', '#' + b.dataset.view);
}));

// ---------- reusable design controls ----------
function designControls(container, { logo = false, onChange }) {
  container.innerHTML = `
    <div class="design">
      <div class="grid2">
        <label>Foreground<input type="color" data-k="dark" value="#111827" /></label>
        <label>Background<input type="color" data-k="light" value="#ffffff" /></label>
      </div>
      <div class="grid2">
        <label>Error correction
          <select data-k="ecc">
            <option value="L">Low (7%)</option>
            <option value="M" selected>Medium (15%)</option>
            <option value="Q">Quartile (25%)</option>
            <option value="H">High (30%)</option>
          </select>
        </label>
        <label>Quiet zone <span class="muted" data-out="margin">2</span><input type="range" data-k="margin" min="0" max="8" value="2" /></label>
      </div>
      ${logo ? `
      <label>Download size <span class="muted" data-out="size">1024 px</span><input type="range" data-k="size" min="256" max="2048" step="128" value="1024" /></label>
      <div>
        <label style="margin-bottom:6px">Center logo <span class="muted">(optional · forces high error correction)</span></label>
        <div class="logo-row">
          <input type="file" accept="image/*" data-logo />
          <img data-logo-preview hidden alt="" />
          <button type="button" class="btn sm" data-logo-clear hidden>Remove</button>
        </div>
      </div>` : ''}
      <label class="inline"><input type="checkbox" data-transparent /> Transparent background</label>
    </div>`;

  const state = { dark: '#111827', light: '#ffffff', ecc: 'M', margin: 2, size: 1024, logo: null };
  const fire = () => onChange && onChange();

  $$('[data-k]', container).forEach((el) => el.addEventListener('input', () => {
    const k = el.dataset.k;
    state[k] = el.type === 'range' ? Number(el.value) : el.value;
    const out = $(`[data-out="${k}"]`, container);
    if (out) out.textContent = k === 'size' ? `${el.value} px` : el.value;
    fire();
  }));
  $('[data-transparent]', container).addEventListener('change', fire);

  if (logo) {
    const file = $('[data-logo]', container), prev = $('[data-logo-preview]', container), clear = $('[data-logo-clear]', container);
    file.addEventListener('change', () => {
      const f = file.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { state.logo = r.result; prev.src = r.result; prev.hidden = clear.hidden = false; fire(); };
      r.readAsDataURL(f);
    });
    clear.addEventListener('click', () => { state.logo = null; file.value = ''; prev.hidden = clear.hidden = true; fire(); });
  }

  return {
    get() {
      const transparent = $('[data-transparent]', container).checked;
      return {
        dark: state.dark,
        light: transparent ? state.light + '00' : state.light,
        ecc: state.logo ? 'H' : state.ecc,
        margin: state.margin,
        size: state.size,
        logo: state.logo,
      };
    },
    set(style = {}) {
      for (const k of ['dark', 'ecc', 'margin']) if (style[k] !== undefined) {
        state[k] = style[k];
        const el = $(`[data-k="${k}"]`, container); if (el) el.value = style[k];
      }
      if (style.light) {
        state.light = style.light.slice(0, 7);
        $('[data-k="light"]', container).value = state.light;
        $('[data-transparent]', container).checked = style.light.length === 9;
      }
      const out = $('[data-out="margin"]', container); if (out) out.textContent = state.margin;
    },
  };
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastWarning(style) {
  const d = luminance(style.dark), l = luminance(style.light.slice(0, 7));
  if (d > l) return 'Light-on-dark codes are not supported by every scanner app.';
  const ratio = (l + 0.05) / (d + 0.05);
  if (ratio < 4) return 'Low contrast between colors — the code may be hard to scan.';
  return '';
}

// ---------- rendering with optional logo ----------
const loadImg = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });

async function renderPng(data, style) {
  const size = style.size || 1024;
  const res = await fetch(qrUrl(data, style, 'png', size));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not render QR');
  const blob = await res.blob();
  if (!style.logo) return blob;

  const [qr, logo] = await Promise.all([loadImg(URL.createObjectURL(blob)), loadImg(style.logo)]);
  const c = document.createElement('canvas');
  c.width = c.height = qr.width;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  const box = qr.width * 0.22, pad = box * 0.12, x = (qr.width - box) / 2;
  ctx.fillStyle = style.light.length === 9 ? '#ffffff' : style.light;
  ctx.beginPath(); ctx.roundRect(x - pad, x - pad, box + pad * 2, box + pad * 2, pad); ctx.fill();
  const scale = Math.min(box / logo.width, box / logo.height);
  const w = logo.width * scale, h = logo.height * scale;
  ctx.drawImage(logo, (qr.width - w) / 2, (qr.width - h) / 2, w, h);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}

async function renderSvg(data, style) {
  const res = await fetch(qrUrl(data, style, 'svg'));
  if (!res.ok) throw new Error('Could not render QR');
  let svg = await res.text();
  if (style.logo) {
    const n = Number((svg.match(/viewBox="0 0 (\d+)/) || [])[1] || 0);
    if (n) {
      const box = n * 0.22, pad = box * 0.12, x = (n - box) / 2;
      const bg = style.light.length === 9 ? '#ffffff' : style.light;
      svg = svg.replace('</svg>',
        `<rect x="${x - pad}" y="${x - pad}" width="${box + pad * 2}" height="${box + pad * 2}" rx="${pad}" fill="${bg}"/>` +
        `<image href="${style.logo}" x="${x}" y="${x}" width="${box}" height="${box}" preserveAspectRatio="xMidYMid meet"/></svg>`);
    }
  }
  return new Blob([svg], { type: 'image/svg+xml' });
}

// ---------- STATIC generator ----------
const STATIC_TYPES = {
  url: {
    fields: `<label>Website URL<input name="url" placeholder="https://example.com" /></label>`,
    build: (f) => { const u = f.url.trim(); return u && (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u); },
  },
  text: {
    fields: `<label>Text<textarea name="text" placeholder="Any text up to ~2,900 characters"></textarea></label>`,
    build: (f) => f.text,
  },
  wifi: {
    fields: `
      <label>Network name (SSID)<input name="ssid" /></label>
      <div class="grid2">
        <label>Security<select name="auth"><option value="WPA">WPA/WPA2/WPA3</option><option value="WEP">WEP</option><option value="nopass">None</option></select></label>
        <label>Password<input name="pass" /></label>
      </div>
      <label class="inline"><input type="checkbox" name="hidden" /> Hidden network</label>`,
    build: (f) => {
      if (!f.ssid) return '';
      const e = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
      return `WIFI:T:${f.auth};S:${e(f.ssid)};${f.auth !== 'nopass' ? `P:${e(f.pass)};` : ''}${f.hidden ? 'H:true;' : ''};`;
    },
  },
  vcard: {
    fields: `
      <div class="grid2"><label>First name<input name="first" /></label><label>Last name<input name="last" /></label></div>
      <div class="grid2"><label>Company<input name="org" /></label><label>Job title<input name="title" /></label></div>
      <div class="grid2"><label>Phone<input name="tel" type="tel" /></label><label>Email<input name="email" type="email" /></label></div>
      <label>Website<input name="url" /></label>
      <label>Address<input name="adr" placeholder="Street, City, Country" /></label>`,
    build: (f) => {
      if (!f.first && !f.last && !f.org) return '';
      const e = (s) => String(s || '').replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
      return ['BEGIN:VCARD', 'VERSION:3.0',
        `N:${e(f.last)};${e(f.first)};;;`, `FN:${e([f.first, f.last].filter(Boolean).join(' ') || f.org)}`,
        f.org && `ORG:${e(f.org)}`, f.title && `TITLE:${e(f.title)}`,
        f.tel && `TEL;TYPE=CELL:${f.tel}`, f.email && `EMAIL:${f.email}`,
        f.url && `URL:${f.url}`, f.adr && `ADR:;;${e(f.adr)};;;;`, 'END:VCARD'].filter(Boolean).join('\n');
    },
  },
  email: {
    fields: `
      <label>To<input name="to" type="email" /></label>
      <label>Subject<input name="subject" /></label>
      <label>Message<textarea name="body"></textarea></label>`,
    build: (f) => {
      if (!f.to) return '';
      const p = new URLSearchParams();
      if (f.subject) p.set('subject', f.subject);
      if (f.body) p.set('body', f.body);
      const q = p.toString().replace(/\+/g, '%20');
      return `mailto:${f.to}${q ? '?' + q : ''}`;
    },
  },
  sms: {
    fields: `<label>Phone number<input name="tel" type="tel" placeholder="+1 555 123 4567" /></label><label>Message<textarea name="msg"></textarea></label>`,
    build: (f) => f.tel && `SMSTO:${f.tel.replace(/[^\d+]/g, '')}:${f.msg}`,
  },
  phone: {
    fields: `<label>Phone number<input name="tel" type="tel" placeholder="+1 555 123 4567" /></label>`,
    build: (f) => f.tel && `tel:${f.tel.replace(/[^\d+]/g, '')}`,
  },
  geo: {
    fields: `<div class="grid2"><label>Latitude<input name="lat" placeholder="40.7128" /></label><label>Longitude<input name="lng" placeholder="-74.0060" /></label></div>
      <button type="button" class="btn sm" data-geo>Use my location</button>`,
    build: (f) => {
      const lat = parseFloat(f.lat), lng = parseFloat(f.lng);
      return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? `geo:${lat},${lng}` : '';
    },
  },
};

let staticType = 'url';
const staticForm = $('#static-form');
const staticDesign = designControls($('#static-design'), { logo: true, onChange: () => updateStatic() });

function readForm(form) {
  const out = {};
  for (const el of form.elements) if (el.name) out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return out;
}

function setStaticType(type) {
  staticType = type;
  $$('#static-types .chip').forEach((c) => c.classList.toggle('active', c.dataset.type === type));
  staticForm.innerHTML = STATIC_TYPES[type].fields;
  const geo = $('[data-geo]', staticForm);
  if (geo) geo.addEventListener('click', () => navigator.geolocation?.getCurrentPosition((p) => {
    staticForm.lat.value = p.coords.latitude.toFixed(6); staticForm.lng.value = p.coords.longitude.toFixed(6); updateStatic();
  }, () => toast('Location unavailable')));
  updateStatic();
}
$$('#static-types .chip').forEach((c) => c.addEventListener('click', () => setStaticType(c.dataset.type)));
staticForm.addEventListener('input', () => updateStatic());
staticForm.addEventListener('submit', (e) => e.preventDefault());

let staticPayload = '', previewUrl;
const updateStatic = debounce(async () => {
  staticPayload = STATIC_TYPES[staticType].build(readForm(staticForm)) || '';
  const style = staticDesign.get();
  $('#static-payload').textContent = staticPayload;
  $('#static-warn').textContent = staticPayload ? contrastWarning(style) : '';
  $('#static-png').disabled = $('#static-svg').disabled = !staticPayload;
  const img = $('#static-preview');
  $('#static-empty').hidden = !!staticPayload;
  if (!staticPayload) { img.removeAttribute('src'); return; }
  try {
    const blob = await renderPng(staticPayload, { ...style, size: 512 });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    img.src = previewUrl = URL.createObjectURL(blob);
  } catch (e) { $('#static-warn').textContent = e.message; }
});

$('#static-png').addEventListener('click', async () => {
  const blob = await renderPng(staticPayload, staticDesign.get());
  download(URL.createObjectURL(blob), `qr-${staticType}.png`);
});
$('#static-svg').addEventListener('click', async () => {
  const blob = await renderSvg(staticPayload, staticDesign.get());
  download(URL.createObjectURL(blob), `qr-${staticType}.svg`);
});

setStaticType('url');

// ---------- DYNAMIC ----------
const dynDesign = designControls($('#dyn-design'), {});
let dynCodes = [];

const styleOf = (c) => ({ dark: '#111827', light: '#ffffff', ...c.style });

async function loadDynamic() {
  try {
    const [codes, ov] = await Promise.all([api('/dynamic'), api('/overview')]);
    dynCodes = codes;
    $('#overview').innerHTML = [
      ['Dynamic codes', ov.dynamicCodes], ['Active', ov.activeCodes], ['Total scans', ov.totalScans], ['Scans today', ov.scansToday],
    ].map(([k, v]) => `<div class="stat"><b>${v.toLocaleString()}</b><span>${k}</span></div>`).join('');
    renderList();
  } catch (e) { toast(e.message); }
}

function renderList() {
  const q = $('#dyn-search').value.trim().toLowerCase();
  const list = dynCodes.filter((c) => !q || [c.name, c.targetUrl, c.code].some((s) => s.toLowerCase().includes(q)));
  const el = $('#dyn-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${dynCodes.length ? 'No codes match your search.' : 'No dynamic codes yet. Create your first one on the left.'}</div>`;
    return;
  }
  el.innerHTML = list.map((c) => `
    <div class="card" data-id="${c.id}">
      <img src="${qrUrl(c.shortUrl, styleOf(c), 'png', 160)}" alt="" loading="lazy" />
      <div style="min-width:0">
        <div class="title">${esc(c.name)} <span class="badge ${c.active ? '' : 'off'}">${c.active ? 'Active' : 'Paused'}</span></div>
        <div class="meta">→ <a href="${esc(c.targetUrl)}" target="_blank" rel="noopener">${esc(c.targetUrl)}</a></div>
        <div class="meta">${esc(c.shortUrl)}</div>
      </div>
      <div class="scans"><b>${c.totalScans}</b> scans</div>
      <div class="actions">
        <button class="btn sm" data-act="open">Edit &amp; stats</button>
        <button class="btn sm" data-act="copy">Copy link</button>
        <button class="btn sm" data-act="png">PNG</button>
        <button class="btn sm" data-act="svg">SVG</button>
        <button class="btn sm" data-act="toggle">${c.active ? 'Pause' : 'Resume'}</button>
        <button class="btn sm danger" data-act="delete">Delete</button>
      </div>
    </div>`).join('');
}
$('#dyn-search').addEventListener('input', renderList);

$('#dyn-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const c = dynCodes.find((x) => x.id === Number(btn.closest('.card').dataset.id));
  codeAction(btn.dataset.act, c);
});

async function codeAction(act, c) {
  try {
    if (act === 'open') return openDrawer(c.id);
    if (act === 'copy') { await navigator.clipboard.writeText(c.shortUrl); return toast('Link copied'); }
    if (act === 'png') return download(URL.createObjectURL(await renderPng(c.shortUrl, { ...styleOf(c), size: 1024 })), `${slugify(c.name)}.png`);
    if (act === 'svg') return download(URL.createObjectURL(await renderSvg(c.shortUrl, styleOf(c))), `${slugify(c.name)}.svg`);
    if (act === 'toggle') { await api(`/dynamic/${c.id}`, { method: 'PATCH', body: { active: !c.active } }); toast(c.active ? 'Paused' : 'Resumed'); }
    if (act === 'delete') {
      if (!confirm(`Delete "${c.name}"? Printed copies of this QR will stop working.`)) return;
      await api(`/dynamic/${c.id}`, { method: 'DELETE' }); toast('Deleted'); closeDrawer();
    }
    await loadDynamic();
    if (!$('#drawer').hidden && act === 'toggle') openDrawer(c.id);
  } catch (err) { toast(err.message); }
}

$('#dyn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = readForm(e.target);
  let url = f.targetUrl.trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const { dark, light, ecc, margin } = dynDesign.get();
  $('#dyn-error').textContent = '';
  try {
    const c = await api('/dynamic', { method: 'POST', body: { name: f.name, targetUrl: url, code: f.code || undefined, style: { dark, light, ecc, margin } } });
    e.target.reset();
    toast('Dynamic QR created');
    await loadDynamic();
    openDrawer(c.id);
  } catch (err) { $('#dyn-error').textContent = err.message; }
});

// ---------- detail drawer ----------
function closeDrawer() { $('#drawer').hidden = $('#drawer-backdrop').hidden = true; }
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

function barChart(series) {
  const W = 520, H = 140, pad = 18, max = Math.max(1, ...series.map((d) => d.scans));
  const bw = (W - pad) / series.length;
  const bars = series.map((d, i) => {
    const h = (d.scans / max) * (H - pad - 8);
    return `<rect class="bar" x="${pad + i * bw + 1}" y="${H - pad - h}" width="${Math.max(bw - 2, 1)}" height="${h}" rx="1.5"><title>${d.day}: ${d.scans} scans (${d.unique} unique)</title></rect>`;
  }).join('');
  const label = (i, a = 'middle') => `<text x="${a === 'end' ? W : a === 'start' ? pad : pad + i * bw + bw / 2}" y="${H - 4}" text-anchor="${a}">${series[i].day.slice(5)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${pad}" x2="${W}" y1="${H - pad}" y2="${H - pad}" />
    <text x="0" y="12">${max}</text>${bars}${label(0, 'start')}${label(Math.floor(series.length / 2))}${label(series.length - 1, 'end')}</svg>`;
}

function breakdown(title, rows) {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return `<div><h3>${title}</h3>${rows.length ? rows.map((r) => `
    <div class="bd-item"><span>${esc(r.label)}</span><span class="muted">${Math.round((r.count / total) * 100)}%</span>
    <span class="track"><i style="width:${(r.count / total) * 100}%"></i></span></div>`).join('') : '<p class="muted small">No data yet</p>'}</div>`;
}

async function openDrawer(id) {
  let d;
  try { d = await api(`/dynamic/${id}?days=30`); } catch (e) { return toast(e.message); }
  const s = d.stats;
  $('#drawer-body').innerHTML = `
    <div class="drawer-head">
      <div><h2>${esc(d.name)}</h2><span class="badge ${d.active ? '' : 'off'}">${d.active ? 'Active' : 'Paused'}</span></div>
      <button class="btn sm" data-close>Close</button>
    </div>
    <div class="qr-big">
      <img src="${qrUrl(d.shortUrl, styleOf(d), 'png', 320)}" alt="QR code" />
      <div class="kv">
        <span class="muted">Short link</span><code>${esc(d.shortUrl)}</code>
        <span class="muted">Created</span><span>${esc(d.createdAt)} UTC</span>
        <div class="row" style="margin-top:6px">
          <button class="btn sm" data-act="copy">Copy</button>
          <button class="btn sm" data-act="png">PNG</button>
          <button class="btn sm" data-act="svg">SVG</button>
          <button class="btn sm" data-act="toggle">${d.active ? 'Pause' : 'Resume'}</button>
        </div>
      </div>
    </div>

    <form class="fields" id="edit-form">
      <label>Name<input name="name" value="${esc(d.name)}" required maxlength="120" /></label>
      <label>Destination URL <span class="muted">— change it any time, the printed QR stays the same</span>
        <input name="targetUrl" value="${esc(d.targetUrl)}" required /></label>
      <p class="error" id="edit-error"></p>
      <div class="row"><button class="btn primary" type="submit">Save changes</button>
        <button class="btn danger" type="button" data-act="delete">Delete</button></div>
    </form>

    <h3>Scans · last 30 days</h3>
    <div class="row" style="gap:24px;margin-bottom:8px">
      <div><b style="font-size:22px">${d.totalScans}</b> <span class="muted small">total</span></div>
      <div><b style="font-size:22px">${d.uniqueScans}</b> <span class="muted small">unique</span></div>
      <div><span class="muted small">Last scan: ${d.lastScan ? esc(d.lastScan) + ' UTC' : '—'}</span></div>
    </div>
    ${barChart(s.series)}
    <div class="breakdowns">${breakdown('Device', s.devices)}${breakdown('OS', s.os)}${breakdown('Browser', s.browsers)}</div>

    <h3>Recent scans</h3>
    ${s.recent.length ? `<table><tr><th>Time (UTC)</th><th>Device</th><th>OS</th><th>Browser</th></tr>
      ${s.recent.map((r) => `<tr><td>${esc(r.scanned_at)}</td><td>${esc(r.device)}</td><td>${esc(r.os)}</td><td>${esc(r.browser)}</td></tr>`).join('')}</table>
      <p><a href="/api/dynamic/${d.id}/scans.csv">Export all scans (CSV)</a></p>` : '<p class="muted small">No scans yet. Scan the code with your phone to test it.</p>'}

    <h3>Destination history</h3>
    <table>${d.history.map((h) => `<tr><td class="muted" style="white-space:nowrap">${esc(h.changed_at)}</td><td style="word-break:break-all">${esc(h.target_url)}</td></tr>`).join('')}</table>`;

  $('#drawer').hidden = $('#drawer-backdrop').hidden = false;
  $('[data-close]', $('#drawer')).addEventListener('click', closeDrawer);
  $$('[data-act]', $('#drawer')).forEach((b) => b.addEventListener('click', () => codeAction(b.dataset.act, d)));
  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = readForm(e.target);
    let url = f.targetUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      await api(`/dynamic/${d.id}`, { method: 'PATCH', body: { name: f.name, targetUrl: url } });
      toast('Saved'); await loadDynamic(); openDrawer(d.id);
    } catch (err) { $('#edit-error').textContent = err.message; }
  });
}

// deep link to tab
if (location.hash === '#dynamic') $('.tab[data-view="dynamic"]').click();
