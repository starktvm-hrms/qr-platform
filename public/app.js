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

// ---------- navigation (hash routes: #dashboard, #static, #vcard, #dynamic, #qr/d/12, #qr/s/5) ----------
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
}
function route() {
  const h = location.hash.slice(1) || 'dashboard';
  const m = h.match(/^qr\/([ds])\/(\d+)$/);
  if (m) { showView('detail'); scrollTo({ top: 0 }); return openDetail(m[1] === 'd' ? 'dynamic' : 'static', Number(m[2])); }
  const view = $(`.tab[data-view="${h}"]`) ? h : 'dashboard';
  showView(view);
  if (view === 'dynamic') loadDynamic();
  if (view === 'dashboard') loadDashboard();
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
$$('.tab').forEach((b) => b.addEventListener('click', () => go('#' + b.dataset.view)));

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

  const file = logo && $('[data-logo]', container), prev = logo && $('[data-logo-preview]', container), clear = logo && $('[data-logo-clear]', container);
  if (logo) {
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
      if (logo) {
        state.logo = style.logo || null; file.value = '';
        if (state.logo) prev.src = state.logo;
        prev.hidden = clear.hidden = !state.logo;
      }
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

// EPS and PDF are rendered by the server as pure vector. A center logo (raster) isn't included.
async function renderVector(fmt, data, style) {
  const res = await fetch(qrUrl(data, style, fmt, style.size || 1024));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not render ${fmt.toUpperCase()}`);
  if (style.logo) toast(`Note: the center logo is not included in ${fmt.toUpperCase()} files`);
  return res.blob();
}
const renderEps = (data, style) => renderVector('eps', data, style);
const renderPdf = (data, style) => renderVector('pdf', data, style);

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

let staticPayload = '', previewUrl, staticEditId = null, staticSavedFor = '';
const updateStatic = debounce(async () => {
  staticPayload = STATIC_TYPES[staticType].build(readForm(staticForm)) || '';
  $('#static-save').disabled = !staticPayload;
  if (staticSavedFor !== staticType + staticPayload) setStaticSaved(staticEditId ? 'editing' : '');
  const style = staticDesign.get();
  $('#static-payload').textContent = staticPayload;
  $('#static-warn').textContent = staticPayload ? contrastWarning(style) : '';
  $('#static-png').disabled = $('#static-svg').disabled = $('#static-eps').disabled = $('#static-pdf').disabled = !staticPayload;
  const img = $('#static-preview');
  $('#static-empty').hidden = !!staticPayload;
  if (!staticPayload) { img.removeAttribute('src'); return; }
  try {
    const blob = await renderPng(staticPayload, { ...style, size: 512 });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    img.src = previewUrl = URL.createObjectURL(blob);
  } catch (e) { $('#static-warn').textContent = e.message; }
});

function setStaticSaved(state, id) {
  const el = $('#static-saved');
  if (state === 'saved') el.innerHTML = `✓ Saved to dashboard · <a href="#qr/s/${id}">View</a>`;
  else if (state === 'editing') el.innerHTML = `Editing a saved code · <a href="#" data-static-new>Save as a new code instead</a>`;
  else el.textContent = '';
  $('#static-save').textContent = staticEditId ? 'Save changes' : 'Save to dashboard';
}
$('#static-saved').addEventListener('click', (e) => {
  if (!e.target.closest('[data-static-new]')) return;
  e.preventDefault(); staticEditId = null; staticSavedFor = ''; setStaticSaved('');
});
async function saveStatic({ download: dl = false } = {}) {
  if (!staticPayload) return;
  const r = await api('/static', { method: 'POST', body: {
    id: staticEditId || undefined, name: $('#static-name').value.trim(), contentType: staticType,
    payload: staticPayload, fields: readForm(staticForm), style: staticDesign.get(), download: dl,
  } });
  staticSavedFor = staticType + staticPayload;
  if (staticEditId) staticEditId = r.id;
  setStaticSaved('saved', r.id);
  return r;
}
$('#static-save').addEventListener('click', () => saveStatic().then(() => toast('Saved to dashboard')).catch((e) => toast(e.message)));

const staticFile = () => slugify($('#static-name').value || 'qr-' + staticType);
for (const [fmt, render] of [['png', renderPng], ['pdf', renderPdf], ['eps', renderEps], ['svg', renderSvg]]) {
  $('#static-' + fmt).addEventListener('click', async () => {
    try {
      const blob = await render(staticPayload, staticDesign.get());
      download(URL.createObjectURL(blob), `${staticFile()}.${fmt}`);
      saveStatic({ download: true }).catch(() => {}); // downloads are kept on the dashboard
    } catch (e) { toast(e.message); }
  });
}

// Open a saved static code in the generator to change it.
function editStatic(c) {
  if (c.contentType === 'vcard') return editStaticVcard(c);
  staticEditId = c.id;
  go('#static');
  setStaticType(c.contentType);
  for (const el of staticForm.elements) {
    if (!el.name || !(el.name in (c.fields || {}))) continue;
    if (el.type === 'checkbox') el.checked = !!c.fields[el.name]; else el.value = c.fields[el.name];
  }
  $('#static-name').value = c.name;
  staticDesign.set(c.style || {});
  staticSavedFor = '';
  setStaticSaved('editing');
  updateStatic();
  scrollTo({ top: 0 });
}

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
  const list = dynCodes.filter((c) => !q || [c.name, c.targetUrl, c.code, c.vcard ? VCard.fullName(c.vcard) : ''].some((s) => s.toLowerCase().includes(q)));
  const el = $('#dyn-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${dynCodes.length ? 'No codes match your search.' : 'No dynamic codes yet. Create your first one on the left.'}</div>`;
    return;
  }
  el.innerHTML = list.map((c) => `
    <div class="card" data-id="${c.id}">
      <img src="${qrUrl(c.shortUrl, styleOf(c), 'png', 160)}" alt="" loading="lazy" />
      <div style="min-width:0">
        <div class="title">${esc(c.name)} ${c.type === 'vcard' ? '<span class="badge vc">vCard</span>' : ''}<span class="badge ${c.active ? '' : 'off'}">${c.active ? 'Active' : 'Paused'}</span></div>
        ${c.type === 'vcard'
          ? `<div class="meta">Contact card · ${esc(VCard.fullName(c.vcard))}${c.vcard.company ? ' · ' + esc(c.vcard.company) : ''}</div>`
          : `<div class="meta">→ <a href="${esc(c.targetUrl)}" target="_blank" rel="noopener">${esc(c.targetUrl)}</a></div>`}
        <div class="meta">${esc(c.shortUrl)}</div>
      </div>
      <div class="scans"><b>${c.totalScans}</b> scans</div>
      <div class="actions">
        <button class="btn sm" data-act="open">${c.type === 'vcard' ? 'Stats' : 'Edit &amp; stats'}</button>
        ${c.type === 'vcard' ? '<button class="btn sm" data-act="editvc">Edit vCard</button>' : ''}
        <button class="btn sm" data-act="copy">Copy link</button>
        <button class="btn sm" data-act="png">PNG</button>
        <button class="btn sm" data-act="svg">SVG</button>
        <button class="btn sm" data-act="eps">EPS</button>
        <button class="btn sm" data-act="pdf">PDF</button>
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
    if (act === 'open') return go(`#qr/d/${c.id}`);
    if (act === 'editvc') return editVcard(c.id);
    if (act === 'copy') { await navigator.clipboard.writeText(c.shortUrl); return toast('Link copied'); }
    if (act === 'png') return download(URL.createObjectURL(await renderPng(c.shortUrl, { ...styleOf(c), size: 1024 })), `${slugify(c.name)}.png`);
    if (act === 'svg') return download(URL.createObjectURL(await renderSvg(c.shortUrl, styleOf(c))), `${slugify(c.name)}.svg`);
    if (act === 'eps') return download(URL.createObjectURL(await renderEps(c.shortUrl, { ...styleOf(c), size: 1024 })), `${slugify(c.name)}.eps`);
    if (act === 'pdf') return download(URL.createObjectURL(await renderPdf(c.shortUrl, { ...styleOf(c), size: 1024 })), `${slugify(c.name)}.pdf`);
    if (act === 'toggle') { await api(`/dynamic/${c.id}`, { method: 'PATCH', body: { active: !c.active } }); toast(c.active ? 'Paused' : 'Resumed'); }
    if (act === 'delete') {
      if (!confirm(`Delete "${c.name}"? Printed copies of this QR will stop working.`)) return;
      await api(`/dynamic/${c.id}`, { method: 'DELETE' }); toast('Deleted');
      if (vcEditId === c.id) resetVcard();
      if (location.hash === `#qr/d/${c.id}`) return go('#dashboard');
    }
    if (location.hash === `#qr/d/${c.id}`) return openDetail('dynamic', c.id);
    await loadDynamic();
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
    go(`#qr/d/${c.id}`);
  } catch (err) { $('#dyn-error').textContent = err.message; }
});

// ---------- QR code types ----------
const TYPE_META = {
  url: { label: 'URL', icon: 'web' }, vcard: { label: 'vCard', icon: 'person' }, wifi: { label: 'Wi-Fi', icon: 'wifi' },
  text: { label: 'Text', icon: 'text' }, email: { label: 'Email', icon: 'mail' }, sms: { label: 'SMS', icon: 'sms' },
  phone: { label: 'Phone', icon: 'phone' }, geo: { label: 'Location', icon: 'pin' },
};
const EXTRA_ICONS = {
  person: '<path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5z"/>',
  wifi: '<path d="M12 17.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM12 12.5c2.3 0 4.4.9 6 2.4l-1.5 1.5A6.4 6.4 0 0 0 12 14.6a6.4 6.4 0 0 0-4.5 1.8L6 14.9a8.5 8.5 0 0 1 6-2.4zm0-5c3.7 0 7.1 1.5 9.6 3.9l-1.5 1.5A11.4 11.4 0 0 0 12 9.6a11.4 11.4 0 0 0-8.1 3.3l-1.5-1.5A13.5 13.5 0 0 1 12 7.5z"/>',
  text: '<path d="M4 5h16v2.5h-6.7V19h-2.6V7.5H4z"/>',
  sms: '<path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2zm2 6v2h2V9H7zm4 0v2h2V9h-2zm4 0v2h2V9h-2z"/>',
};
function typeIcon(t, size = 16) {
  const name = (TYPE_META[t] || TYPE_META.url).icon;
  return EXTRA_ICONS[name]
    ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${EXTRA_ICONS[name]}</svg>`
    : VCard.icon(name, size);
}
const typeLabel = (t) => (TYPE_META[t] || { label: t }).label;
const typeBadge = (t) => `<span class="tb tb-${esc(t)}">${typeIcon(t, 13)}${esc(typeLabel(t))}</span>`;
const kindBadge = (k) => `<span class="kb kb-${k}">${k === 'dynamic' ? 'Dynamic' : 'Static'}</span>`;
const dateOnly = (s) => (s || '').slice(0, 10);

// ---------- dashboard: every QR code ----------
let allCodes = [], dashKind = 'all', dashType = 'all';
async function loadDashboard() {
  try {
    const [codes, ov] = await Promise.all([api('/codes'), api('/overview')]);
    allCodes = codes;
    $('#dash-stats').innerHTML = [
      ['QR codes', codes.length], ['Dynamic', ov.dynamicCodes], ['Static', ov.staticCodes], ['Total scans', ov.totalScans],
    ].map(([k, v]) => `<div class="stat"><b>${v.toLocaleString()}</b><span>${k}</span></div>`).join('');
    renderDash();
  } catch (e) { toast(e.message); }
}
function renderDash() {
  // type chips with counts (within the selected kind)
  const inKind = allCodes.filter((c) => dashKind === 'all' || c.kind === dashKind);
  const counts = {};
  inKind.forEach((c) => { counts[c.contentType] = (counts[c.contentType] || 0) + 1; });
  if (dashType !== 'all' && !counts[dashType]) dashType = 'all';
  $('#dash-types').innerHTML = `<button class="chip ${dashType === 'all' ? 'active' : ''}" data-type="all">All types <span class="n">${inKind.length}</span></button>` +
    Object.keys(TYPE_META).filter((t) => counts[t]).map((t) =>
      `<button class="chip ${dashType === t ? 'active' : ''}" data-type="${t}">${typeIcon(t, 14)} ${typeLabel(t)} <span class="n">${counts[t]}</span></button>`).join('');

  const q = $('#dash-search').value.trim().toLowerCase();
  const sort = $('#dash-sort').value;
  const list = inKind
    .filter((c) => dashType === 'all' || c.contentType === dashType)
    .filter((c) => !q || [c.name, c.summary, c.data, typeLabel(c.contentType)].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => sort === 'old' ? (a.createdAt > b.createdAt ? 1 : -1)
      : sort === 'name' ? a.name.localeCompare(b.name)
      : sort === 'scans' ? (b.totalScans || 0) - (a.totalScans || 0)
      : (a.createdAt < b.createdAt ? 1 : -1));

  const grid = $('#dash-grid');
  if (!allCodes.length) {
    grid.innerHTML = `<div class="empty">No QR codes yet.<br />Create a <a href="#static">static QR</a>, a <a href="#vcard">vCard</a> or a <a href="#dynamic">dynamic QR</a>. They'll all show up here.</div>`;
    return;
  }
  if (!list.length) { grid.innerHTML = '<div class="empty">No QR codes match these filters.</div>'; return; }
  grid.innerHTML = list.map((c) => {
    const href = `#qr/${c.kind === 'dynamic' ? 'd' : 's'}/${c.id}`;
    const meta = c.kind === 'dynamic'
      ? `${(c.totalScans || 0).toLocaleString()} scan${c.totalScans === 1 ? '' : 's'} · created ${dateOnly(c.createdAt)}`
      : `Not tracked · created ${dateOnly(c.createdAt)}`;
    return `<article class="qcard" data-key="${c.kind}-${c.id}">
      <a class="qlink" href="${href}">
        <span class="qthumb"><img src="${qrUrl(c.data, styleOf(c), 'png', 220)}" alt="" loading="lazy" /></span>
        <span class="qbody">
          <span class="qname">${esc(c.name)}</span>
          <span class="badges">${kindBadge(c.kind)}${typeBadge(c.contentType)}${c.kind === 'dynamic' && !c.active ? '<span class="badge off">Paused</span>' : ''}</span>
          <span class="qsum">${esc(c.summary || '')}</span>
          <span class="qmeta">${meta}</span>
        </span>
      </a>
      <div class="qact">
        <a class="btn sm" href="${href}">Open</a>
        <button class="btn sm" data-dl="png">PNG</button><button class="btn sm" data-dl="svg">SVG</button>
        <button class="btn sm" data-dl="pdf">PDF</button><button class="btn sm" data-dl="eps">EPS</button>
      </div>
    </article>`;
  }).join('');
}
$('#dash-kind').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]'); if (!b) return;
  dashKind = b.dataset.kind;
  $$('#dash-kind button').forEach((x) => x.classList.toggle('active', x === b));
  renderDash();
});
$('#dash-types').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { dashType = b.dataset.type; renderDash(); } });
$('#dash-search').addEventListener('input', renderDash);
$('#dash-sort').addEventListener('change', renderDash);
$('#dash-grid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dl]'); if (!b) return;
  const [kind, id] = b.closest('.qcard').dataset.key.split('-');
  try {
    // static codes may carry a centre logo, which the list leaves out, so fetch the full code
    const c = kind === 'static' ? await api(`/static/${id}`) : allCodes.find((x) => x.kind === kind && String(x.id) === id);
    await downloadCode(c.data, styleOf(c), b.dataset.dl, c.name);
  } catch (err) { toast(err.message); }
});

async function downloadCode(data, style, fmt, name) {
  const render = { png: renderPng, svg: renderSvg, pdf: renderPdf, eps: renderEps }[fmt];
  const blob = await render(data, { ...style, size: 1024 });
  download(URL.createObjectURL(blob), `${slugify(name)}.${fmt}`);
}

// ---------- detail page: one QR code ----------
const TYPE_EXPLAIN = {
  dynamic: {
    url: 'Scanning opens a short link on your server that redirects to the destination below. You can change the destination at any time, pause the code, and every scan is tracked.',
    vcard: 'Scanning opens a hosted contact card with an Add to contacts button. You can edit the details or template at any time, and every scan is tracked.',
  },
  static: {
    url: 'The link is stored inside the QR code itself.',
    text: 'The text is stored inside the QR code itself and shown when scanned.',
    wifi: 'The Wi-Fi network details are stored inside the QR code; scanning offers to join the network.',
    email: 'A pre-filled email is stored inside the QR code; scanning opens the mail app.',
    sms: 'A pre-filled text message is stored inside the QR code; scanning opens the messaging app.',
    phone: 'The phone number is stored inside the QR code; scanning offers to call it.',
    geo: 'The map location is stored inside the QR code; scanning opens it in a maps app.',
    vcard: 'The contact details are stored inside the QR code; scanning offers to save the contact (without a photo).',
  },
};
const STATIC_NOTE = ' It works offline, but it can’t be changed or tracked after printing.';
const kvl = (rows) => `<dl class="kvl">${rows.filter((r) => r && r[1] !== '' && r[1] != null)
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const safeLink = (u) => /^https?:\/\//i.test(u || '') ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>` : esc(u);
const pre = (t) => t ? `<pre class="ptext">${esc(t)}</pre>` : '';

function contactRows(card) {
  return [
    ['Name', esc(VCard.fullName(card))],
    ['Company', esc(card.company || '')],
    ['Job title', esc(card.jobTitle || '')],
    ...(card.phones || []).map((ph) => [`Phone (${(VCard.PHONE_TYPES[ph.type] || {}).label || 'Phone'})`, `<a href="tel:${esc(ph.number.replace(/[^\d+]/g, ''))}">${esc(ph.number)}</a>`]),
    ...(card.emails || []).map((e) => ['Email', `<a href="mailto:${esc(e)}">${esc(e)}</a>`]),
    ...(card.websites || []).map((w) => ['Website', safeLink(w)]),
    ['Address', esc(card.address || '')],
    ['Birthday', esc(card.birthday || '')],
    ...Object.entries(card.socials || {}).map(([k, u]) => [(VCard.SOCIALS[k] || {}).label || k, safeLink(u)]),
    ['About', card.about ? `<span class="pre-line">${esc(card.about)}</span>` : ''],
  ];
}

// What's inside the code, shown according to its type.
function typeDetails(kind, type, c) {
  const f = c.fields || {};
  if (kind === 'dynamic' && type === 'url') return ['Destination', kvl([['Opens', safeLink(c.targetUrl)], ['Short link', `<code>${esc(c.shortUrl)}</code>`]])];
  if (kind === 'dynamic' && type === 'vcard') {
    return ['Contact', kvl([...contactRows(c.vcard), ['Card template', esc((VCard.TEMPLATES[c.vcard.template] || 'Classic'))],
      ['Card page', `<a href="${esc(c.shortUrl)}" target="_blank" rel="noopener">${esc(c.shortUrl)}</a>`]])];
  }
  switch (type) {
    case 'url': return ['Link', kvl([['Opens', safeLink(c.data)]])];
    case 'text': return ['Text', pre(f.text || c.data)];
    case 'wifi': return ['Wi-Fi network', kvl([
      ['Network name (SSID)', esc(f.ssid || '')],
      ['Security', esc({ WPA: 'WPA / WPA2 / WPA3', WEP: 'WEP', nopass: 'None (open network)' }[f.auth] || f.auth || '')],
      ['Password', f.auth !== 'nopass' && f.pass ? `<span class="secret" data-secret="${esc(f.pass)}">••••••••</span> <button type="button" class="btn sm" data-reveal>Show</button>` : ''],
      ['Hidden network', f.hidden ? 'Yes' : 'No'],
    ])];
    case 'email': return ['Email', kvl([['To', f.to ? `<a href="mailto:${esc(f.to)}">${esc(f.to)}</a>` : ''], ['Subject', esc(f.subject || '')], ['Message', f.body ? `<span class="pre-line">${esc(f.body)}</span>` : '']])];
    case 'sms': return ['Text message', kvl([['To', esc(f.tel || '')], ['Message', f.msg ? `<span class="pre-line">${esc(f.msg)}</span>` : '']])];
    case 'phone': return ['Phone call', kvl([['Number', f.tel ? `<a href="tel:${esc(f.tel.replace(/[^\d+]/g, ''))}">${esc(f.tel)}</a>` : esc(c.data.replace(/^tel:/, ''))]])];
    case 'geo': {
      const [lat, lng] = c.data.replace(/^geo:/, '').split(',');
      return ['Location', kvl([['Latitude', esc(lat)], ['Longitude', esc(lng)],
        ['Map', `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + ',' + lng)}" target="_blank" rel="noopener">Open in Google Maps</a>`]])];
    }
    case 'vcard': return ['Contact', kvl(contactRows(f))];
    default: return ['Content', pre(c.data)];
  }
}

function detailShell(kind, type, c, { badges = '', meta = [], actions = '', edit = '', below = '' }) {
  const explain = (TYPE_EXPLAIN[kind] || {})[type] || '';
  const [detailsTitle, detailsHtml] = typeDetails(kind, type, c);
  return `
    <header class="dhead">
      <span class="type-hero tb-${esc(type)}">${typeIcon(type, 30)}</span>
      <div class="dtitle">
        <p class="eyebrow">${kind === 'dynamic' ? 'Dynamic' : 'Static'} QR code · ${esc(typeLabel(type))}</p>
        <h1>${esc(c.name)}</h1>
        <div class="badges">${kindBadge(kind)}${typeBadge(type)}${badges}</div>
      </div>
    </header>
    <div class="dgrid">
      <div class="panel dqr">
        <div class="dqr-img"><img src="${qrUrl(c.data, styleOf(c), 'png', 480)}" alt="QR code for ${esc(c.name)}" /></div>
        <div class="row dl">
          <button class="btn primary" data-dl="png">PNG</button><button class="btn" data-dl="svg">SVG</button>
          <button class="btn" data-dl="pdf">PDF</button><button class="btn" data-dl="eps">EPS</button>
        </div>
        ${actions ? `<div class="row">${actions}</div>` : ''}
      </div>
      <div class="panel dinfo">
        <h2>QR code type</h2>
        <div class="typebox tb-${esc(type)}">
          <span class="ic">${typeIcon(type, 22)}</span>
          <div><b>${kind === 'dynamic' ? 'Dynamic' : 'Static'} · ${esc(typeLabel(type))}</b>
            <p>${esc(explain + (kind === 'static' ? STATIC_NOTE : ''))}</p></div>
        </div>
        <h2>${esc(detailsTitle)}</h2>
        ${detailsHtml}
        <details class="raw"><summary>${kind === 'dynamic' ? 'Encoded in the QR (short link)' : 'Encoded in the QR'}</summary><pre class="payload">${esc(c.data)}</pre></details>
        ${kvl(meta)}
        ${edit}
      </div>
    </div>
    ${below}`;
}

async function openDetail(kind, id) {
  const body = $('#detail-body');
  body.innerHTML = '<p class="muted">Loading…</p>';
  let c;
  try { c = await api(kind === 'dynamic' ? `/dynamic/${id}?days=30` : `/static/${id}`); }
  catch (e) {
    body.innerHTML = `<div class="empty">This QR code wasn't found. It may have been deleted.<br /><a href="#dashboard">Back to all QR codes</a></div>`;
    return;
  }
  if (location.hash !== `#qr/${kind === 'dynamic' ? 'd' : 's'}/${id}`) return; // navigated away meanwhile
  if (kind === 'dynamic') renderDynamicDetail({ ...c, data: c.shortUrl });
  else renderStaticDetail(c);
  $$('[data-dl]', body).forEach((b) => b.addEventListener('click', () => downloadCode(c.kind === 'static' ? c.data : c.shortUrl, styleOf(c), b.dataset.dl, c.name).catch((e) => toast(e.message))));
  $$('[data-reveal]', body).forEach((b) => b.addEventListener('click', () => {
    const sEl = b.previousElementSibling, shown = b.textContent === 'Hide';
    sEl.textContent = shown ? '••••••••' : sEl.dataset.secret; b.textContent = shown ? 'Show' : 'Hide';
  }));
}

function renderStaticDetail(c) {
  const body = $('#detail-body');
  body.innerHTML = detailShell('static', c.contentType, c, {
    meta: [['Created', esc(c.createdAt) + ' UTC'], ['Last updated', esc(c.updatedAt) + ' UTC'], ['Downloads', String(c.downloads)],
      ['Centre logo', c.hasLogo ? 'Yes' : '']],
    edit: `<form class="fields" id="edit-form">
        <label>Name<input name="name" value="${esc(c.name)}" required maxlength="120" /></label>
        <p class="error" id="edit-error"></p>
        <div class="row"><button class="btn primary" type="submit">Save name</button>
          <button class="btn" type="button" data-edit>Edit content &amp; design</button>
          <button class="btn danger" type="button" data-delete>Delete</button></div>
        <p class="muted small" style="margin:0">Editing a static code creates a new image: reprint it after changing the content.</p>
      </form>`,
  });
  $('[data-edit]', body).addEventListener('click', () => editStatic(c));
  $('[data-delete]', body).addEventListener('click', async () => {
    if (!confirm(`Remove "${c.name}" from the dashboard? Printed copies keep working; static codes don't depend on the server.`)) return;
    try { await api(`/static/${c.id}`, { method: 'DELETE' }); toast('Deleted'); if (staticEditId === c.id) staticEditId = null; go('#dashboard'); }
    catch (e) { toast(e.message); }
  });
  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/static/${c.id}`, { method: 'PATCH', body: { name: readForm(e.target).name } }); toast('Saved'); openDetail('static', c.id); }
    catch (err) { $('#edit-error').textContent = err.message; }
  });
}

function renderDynamicDetail(d) {
  const s = d.stats;
  const body = $('#detail-body');
  body.innerHTML = detailShell('dynamic', d.type, d, {
    badges: `<span class="badge ${d.active ? '' : 'off'}">${d.active ? 'Active' : 'Paused'}</span>`,
    actions: `<button class="btn sm" data-act="copy">Copy link</button>
      <button class="btn sm" data-act="toggle">${d.active ? 'Pause' : 'Resume'}</button>
      ${d.type === 'vcard' ? `<a class="btn sm" href="${esc(d.shortUrl)}" target="_blank" rel="noopener">View card page</a>` : ''}`,
    meta: [['Created', esc(d.createdAt) + ' UTC'], ['Total scans', `<b>${d.totalScans}</b> (${d.uniqueScans} unique)`],
      ['Last scan', d.lastScan ? esc(d.lastScan) + ' UTC' : '—'],
      ['Old links (still working)', d.aliases.length ? `<ul class="aliases">${d.aliases.map((a) => `<li><code>${esc(a.url)}</code>
        <button type="button" class="btn sm" data-unalias="${esc(a.alias)}">Remove</button></li>`).join('')}</ul>` : '']],
    edit: `<form class="fields" id="edit-form">
        <label>Name<input name="name" value="${esc(d.name)}" required maxlength="120" /></label>
        <label>Short link
          <span class="slug-input"><span class="slug-base">${esc(d.shortUrl.slice(0, d.shortUrl.length - d.code.length).replace(/^https?:\/\//, ''))}</span><input name="code" value="${esc(d.code)}" required maxlength="32" spellcheck="false" autocomplete="off" /></span>
          <span class="muted small" style="font-weight:400">3–32 letters, numbers, - or _. Changing it changes the QR image; codes already printed keep working because the old link keeps redirecting.</span>
        </label>
        ${d.type === 'vcard' ? '' : `<label>Destination URL <span class="muted">— change it any time, the printed QR stays the same</span>
          <input name="targetUrl" value="${esc(d.targetUrl)}" required /></label>`}
        <p class="error" id="edit-error"></p>
        <div class="row"><button class="btn primary" type="submit">Save changes</button>
          ${d.type === 'vcard' ? '<button class="btn" type="button" data-act="editvc">Edit vCard details</button>' : ''}
          <button class="btn danger" type="button" data-act="delete">Delete</button></div>
      </form>`,
    below: `<div class="panel dstats">
      <h2>Scans · last 30 days</h2>
      ${barChart(s.series)}
      <div class="breakdowns">${breakdown('Device', s.devices)}${breakdown('OS', s.os)}${breakdown('Browser', s.browsers)}</div>
      <h3 class="sec">Location</h3>
      ${d.geo.enabled ? '' : `<p class="muted small geo-note">${d.geo.error ? esc(d.geo.error) + '. ' : 'Location lookup is getting ready (the location database is downloading). '}Scans are still counted; their location shows as Unknown.</p>`}
      <div class="breakdowns">${breakdown('Country', s.countries)}${breakdown('Region / State', s.regions)}${breakdown('City', s.cities)}</div>
      <p class="muted small" style="margin-top:4px">Approximate location from the scanner's IP address (city-level, not GPS). IP addresses are not stored.
        <a href="https://db-ip.com" target="_blank" rel="noopener">IP Geolocation by DB-IP</a></p>
      <h3>Recent scans</h3>
      ${s.recent.length ? `<table><tr><th>Time (UTC)</th><th>Location</th><th>Device</th><th>OS</th></tr>
        ${s.recent.map((r) => `<tr><td>${esc(r.scanned_at)}</td><td>${flag(r.country)}${esc(r.location)}</td><td>${esc(r.device)}</td><td>${esc(r.os)}</td></tr>`).join('')}</table>
        <p><a href="/api/dynamic/${d.id}/scans.csv">Export all scans (CSV)</a></p>` : '<p class="muted small">No scans yet. Scan the code with your phone to test it.</p>'}
      ${d.type === 'vcard' ? '' : `<h3>Destination history</h3>
      <table>${d.history.map((h) => `<tr><td class="muted" style="white-space:nowrap">${esc(h.changed_at)}</td><td style="word-break:break-all">${esc(h.target_url)}</td></tr>`).join('')}</table>`}
    </div>`,
  });
  $$('[data-act]', body).forEach((b) => b.addEventListener('click', () => codeAction(b.dataset.act, d)));
  $$('[data-unalias]', body).forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.unalias;
    if (!confirm(`Stop the old link /r/${a} from working?\n\nAny QR code printed with it will show "not found" after this.`)) return;
    try { await api(`/dynamic/${d.id}/aliases/${encodeURIComponent(a)}`, { method: 'DELETE' }); toast('Old link removed'); openDetail('dynamic', d.id); }
    catch (err) { toast(err.message); }
  }));
  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = readForm(e.target);
    const payload = { name: f.name };
    const slug = (f.code || '').trim();
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(slug)) { $('#edit-error').textContent = 'Short link: use 3–32 letters, numbers, - or _ (no spaces).'; return; }
    if (slug !== d.code) {
      if (!confirm(`Change the short link to ${d.shortUrl.slice(0, d.shortUrl.length - d.code.length)}${slug}?\n\n`
        + `The QR image will change, so download it again for new prints. Codes already printed keep working: `
        + `the old link /r/${d.code} keeps redirecting.`)) return;
      payload.code = slug;
    }
    if (d.type !== 'vcard') {
      payload.targetUrl = f.targetUrl.trim();
      if (payload.targetUrl && !/^https?:\/\//i.test(payload.targetUrl)) payload.targetUrl = 'https://' + payload.targetUrl;
    }
    try { await api(`/dynamic/${d.id}`, { method: 'PATCH', body: payload }); toast('Saved'); openDetail('dynamic', d.id); }
    catch (err) { $('#edit-error').textContent = err.message; }
  });
}

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

const flag = (cc) => /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) + ' ' : '';
function breakdown(title, rows) {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return `<div><h3>${title}</h3>${rows.length ? rows.map((r) => `
    <div class="bd-item"><span>${flag(r.code)}${esc(r.label)}</span><span class="muted">${Math.round((r.count / total) * 100)}%</span>
    <span class="track"><i style="width:${(r.count / total) * 100}%"></i></span></div>`).join('') : '<p class="muted small">No data yet</p>'}</div>`;
}

// ---------- vCARD ----------
const COUNTRIES = [
  ['IN', '+91', '🇮🇳'], ['US', '+1', '🇺🇸'], ['GB', '+44', '🇬🇧'], ['AE', '+971', '🇦🇪'], ['SA', '+966', '🇸🇦'],
  ['QA', '+974', '🇶🇦'], ['KW', '+965', '🇰🇼'], ['OM', '+968', '🇴🇲'], ['BH', '+973', '🇧🇭'], ['SG', '+65', '🇸🇬'],
  ['MY', '+60', '🇲🇾'], ['AU', '+61', '🇦🇺'], ['CA', '+1', '🇨🇦'], ['DE', '+49', '🇩🇪'], ['FR', '+33', '🇫🇷'],
  ['LK', '+94', '🇱🇰'], ['NP', '+977', '🇳🇵'], ['BD', '+880', '🇧🇩'], ['ZA', '+27', '🇿🇦'], ['NZ', '+64', '🇳🇿'],
];
const vcForm = $('#vc-form');
const vcDesign = designControls($('#vc-design'), { onChange: () => updateVcard() });
let vcEditId = null, vcShortUrl = '', vcPhoto = '', vcSubmitted = false, vcPreview = 'card', vcQrUrl, vcTemplate = 'classic';

// ----- template picker (mini mock-ups drawn in CSS, tinted with the card colour) -----
const MINIS = {
  classic: '<i class="hd"></i><i class="av"></i><i class="ln a"></i><i class="ln s b"></i><i class="q q1"></i><i class="q q2"></i><i class="q q3"></i><i class="ln r1"></i><i class="ln r2"></i><i class="ln r3"></i>',
  banner: '<i class="pn"></i><i class="av"></i><i class="ln a"></i><i class="ln s b"></i><i class="bar"></i><i class="dot d1"></i><i class="dot d2"></i><i class="dot d3"></i><i class="ln r1"></i><i class="ln r2"></i><i class="ln r3"></i>',
  bold: '<i class="av"></i><i class="ln a"></i><i class="ln s b"></i><i class="bx x1"></i><i class="bx x2"></i><i class="bx x3"></i><i class="ft"></i>',
  bubbles: '<i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="av"></i><i class="ln a"></i><i class="ln s b"></i><i class="dot d1"></i><i class="dot d2"></i><i class="dot d3"></i><i class="ln r1"></i><i class="ln r2"></i><i class="ln r3"></i>',
  cover: '<i class="cv"></i><i class="wv"></i><i class="vl"></i><i class="ln a"></i><i class="ln b"></i><i class="ln r1"></i><i class="ln r2"></i>',
};
$('#vc-templates').innerHTML = Object.entries(VCard.TEMPLATES).map(([k, label]) =>
  `<button type="button" class="tpl" role="radio" data-tpl="${k}" aria-checked="false"><span class="mini m-${k}">${MINIS[k]}</span>${label}</button>`).join('');
$$('#vc-templates [data-tpl]').forEach((b) => b.addEventListener('click', () => { setTemplate(b.dataset.tpl); updateVcard(); }));
function setTemplate(t) {
  vcTemplate = VCard.TEMPLATES[t] ? t : 'classic';
  $$('#vc-templates [data-tpl]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tpl === vcTemplate)));
}
function tintMinis() {
  const c = $('#vc-color').value, p = VCard.palette(c);
  $$('#vc-templates .mini').forEach((m) => { m.style.setProperty('--c', c); m.style.setProperty('--c2', p.c2); m.style.setProperty('--t', p.tint); });
}
$$('[data-soc-icon]').forEach((el) => { el.innerHTML = VCard.icon(el.dataset.socIcon, 20); });

const plusBtn = (kind, first) => first
  ? `<button type="button" class="icon-btn" data-add="${kind}" title="Add another" aria-label="Add another">+</button>`
  : `<button type="button" class="icon-btn minus" data-del title="Remove" aria-label="Remove">−</button>`;

function phoneRow(first, p = {}) {
  // split a stored "+91 98470 12345" back into country code + local number
  let cc = 'IN', num = p.number || '';
  const m = COUNTRIES.filter(([, code]) => num.startsWith(code + ' ') || num.startsWith(code))
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (m) { cc = m[0]; num = num.slice(m[1].length).trim(); } else if (num.startsWith('+')) cc = '';
  return `<div class="phone-row" data-row="phone">
    <div class="fl"><select data-f="type">${Object.entries(VCard.PHONE_TYPES).map(([k, v]) =>
      `<option value="${k}" ${k === (p.type || 'mobile') ? 'selected' : ''}>${v.label}</option>`).join('')}</select><span>Phone Type</span></div>
    <div class="fl num">
      <select class="cc" data-f="cc" aria-label="Country code">${COUNTRIES.map(([iso, code, flag]) =>
        `<option value="${iso}" ${iso === cc ? 'selected' : ''}>${flag} ${code}</option>`).join('')}
        <option value="" ${cc === '' ? 'selected' : ''}>🌐 other</option></select>
      <input type="tel" data-f="number" placeholder="Phone number" value="${esc(num)}" maxlength="25" />
      ${plusBtn('phone', first)}
    </div></div>`;
}
const textRow = (kind, label, help, first, value = '') => `<div class="fl" data-row="${kind}">
  <input type="${kind === 'email' ? 'email' : 'url'}" data-f="v" placeholder=" " value="${esc(value)}" maxlength="${kind === 'email' ? 254 : 300}" />
  <span>${label}</span>${first ? `<i class="help" title="${help}">?</i>` : ''}${plusBtn(kind, first)}</div>`;

const ROWS = {
  phone: { el: '#vc-phones', make: (first, v) => phoneRow(first, v) },
  email: { el: '#vc-emails', make: (first, v) => textRow('email', 'Email', 'Up to 5 email addresses.', first, v) },
  website: { el: '#vc-websites', make: (first, v) => textRow('website', 'Website', 'Up to 5 links: website, LinkedIn, portfolio…', first, v) },
};
function setRows(kind, values) {
  const r = ROWS[kind], list = values && values.length ? values : [undefined];
  $(r.el).innerHTML = list.map((v, i) => r.make(i === 0, v)).join('');
  syncAddButtons();
}
function syncAddButtons() {
  for (const kind of Object.keys(ROWS)) {
    const add = $(`[data-add="${kind}"]`, vcForm);
    if (add) add.disabled = $$(`[data-row="${kind}"]`, vcForm).length >= VCard.MAX_ITEMS;
  }
}
vcForm.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]'), del = e.target.closest('[data-del]');
  if (add) {
    const kind = add.dataset.add, r = ROWS[kind];
    $(r.el).insertAdjacentHTML('beforeend', r.make(false));
    $(r.el).lastElementChild.querySelector('input').focus();
  } else if (del) {
    del.closest('[data-row]').remove();
  } else return;
  syncAddButtons(); updateVcard();
});

function readVcard() {
  const f = vcForm.elements;
  return {
    firstName: f.firstName.value, lastName: f.lastName.value, company: f.company.value, jobTitle: f.jobTitle.value,
    birthday: f.birthday.value, address: f.address.value, color: f.color.value, photo: vcPhoto,
    about: f.about.value, template: vcTemplate,
    socials: Object.fromEntries(Object.keys(VCard.SOCIALS).map((k) => [k, f['soc_' + k].value])),
    phones: $$('[data-row="phone"]', vcForm).map((r) => {
      const number = $('[data-f="number"]', r).value.trim();
      const code = (COUNTRIES.find(([iso]) => iso === $('[data-f="cc"]', r).value) || [])[1];
      return { type: $('[data-f="type"]', r).value, number: number && code && !number.startsWith('+') ? `${code} ${number}` : number };
    }),
    emails: $$('[data-row="email"] input', vcForm).map((i) => i.value),
    websites: $$('[data-row="website"] input', vcForm).map((i) => i.value),
  };
}

// ----- photo: resize in the browser so the stored card stays small -----
async function resizePhoto(file) {
  const img = await loadImg(URL.createObjectURL(file));
  for (const [max, q] of [[480, 0.86], [360, 0.8], [256, 0.72]]) {
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 280 * 1024) return url;
  }
  throw new Error('That image is too large. Try a smaller one.');
}
function setPhoto(url) {
  vcPhoto = url || '';
  $('#vc-photo-empty').hidden = !!vcPhoto;
  $('#vc-photo-set').hidden = !vcPhoto;
  if (vcPhoto) $('#vc-photo-img').src = vcPhoto;
  updateVcard();
}
$('#vc-photo-btn').addEventListener('click', () => $('#vc-photo-input').click());
$('#vc-photo-change').addEventListener('click', () => $('#vc-photo-input').click());
$('#vc-photo-remove').addEventListener('click', () => setPhoto(''));
$('#vc-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try { setPhoto(await resizePhoto(file)); } catch (err) { toast(err.message); }
});

$('#vc-color').addEventListener('input', (e) => { $('#vc-color-hex').textContent = e.target.value.toUpperCase(); tintMinis(); });
$('#vc-dob').max = new Date().toISOString().slice(0, 10);
vcForm.addEventListener('input', () => updateVcard());
vcForm.addEventListener('change', () => updateVcard());
vcForm.addEventListener('submit', (e) => e.preventDefault());
$('#vc-static').addEventListener('change', () => { if ($('#vc-static').checked) setVcPreview('qr'); updateVcard(); });
$('#vc-static-info').addEventListener('click', (e) => {
  e.preventDefault(); // inside the <label>: don't toggle the checkbox
  const help = $('#vc-static-help'); help.hidden = !help.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!help.hidden));
});
$$('#vc-preview-tabs button').forEach((b) => b.addEventListener('click', () => setVcPreview(b.dataset.p)));
function setVcPreview(p) {
  vcPreview = p;
  $$('#vc-preview-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.p === p));
  $('#vc-card-wrap').hidden = p !== 'card';
  $('#vc-qr-wrap').hidden = p !== 'qr';
}

function vcActions(html) {
  $('#vc-actions').innerHTML = html;
  $$('#vc-actions [data-vc]').forEach((b) => b.addEventListener('click', () => vcAction(b.dataset.vc)));
}

let vcState = { card: null, errors: [], text: '' };
const updateVcard = debounce(async () => {
  const isStatic = $('#vc-static').checked;
  const { card, errors } = VCard.normalize(readVcard());
  const text = VCard.build(card, { photo: false });
  vcState = { card, errors, text };

  // highlight invalid rows; only nag about the name after the first save attempt
  const shown = errors.filter((e) => vcSubmitted || !/^Enter a first name/.test(e));
  $('#vc-error').textContent = shown.join('. ');
  $$('.fl', vcForm).forEach((el) => el.classList.remove('invalid'));
  errors.forEach((e) => {
    const bad = e.split(': ')[1];
    if (bad) $$('[data-row] input', vcForm).filter((i) => i.value && bad.startsWith(i.value.trim().slice(0, 60)))
      .forEach((i) => i.closest('.fl').classList.add('invalid'));
  });

  $('#vc-card').srcdoc = VCard.renderPage(card, '#');
  $('#vc-name-wrap span').textContent = isStatic ? 'File name (optional)' : 'Name your QR (optional)';

  const img = $('#vc-qr'), empty = $('#vc-qr-empty'), note = $('#vc-qr-note');
  const style = vcDesign.get();
  const qrData = isStatic ? text : vcShortUrl;
  if (isStatic) {
    note.textContent = (vcEditId ? `Static copy: a separate QR made from these details. Your dynamic QR and its link ${vcShortUrl.replace(/^https?:\/\//, '')} aren't changed. ` : '') +
      `${text.length} characters stored in the code. The photo isn't included in static codes.` +
      (text.length > 600 ? ' Long contacts make a dense code: print it at least 3 cm wide.' : '');
  } else {
    note.innerHTML = vcShortUrl ? `Points to <a href="${esc(vcShortUrl)}" target="_blank" rel="noopener">${esc(vcShortUrl)}</a>. Edits update the card without changing the code.` : '';
  }
  empty.textContent = qrData ? '' : 'Create the vCard QR to get its code.';
  if (!qrData || (isStatic && errors.length)) img.removeAttribute('src');
  else {
    try {
      const blob = await renderPng(qrData, { ...style, size: 512 });
      if (vcQrUrl) URL.revokeObjectURL(vcQrUrl);
      img.src = vcQrUrl = URL.createObjectURL(blob);
    } catch (err) { note.textContent = err.message; img.removeAttribute('src'); }
  }

  if (isStatic) {
    vcActions(`<button type="button" class="btn primary" data-vc="png">Download PNG</button>
      <button type="button" class="btn" data-vc="svg">SVG</button><button type="button" class="btn" data-vc="eps">EPS</button><button type="button" class="btn" data-vc="pdf">PDF</button>
      <button type="button" class="btn" data-vc="vcf">.vcf file</button><button type="button" class="btn" data-vc="savestatic">${vcStaticEditId ? 'Save changes' : vcEditId ? 'Save static copy to dashboard' : 'Save to dashboard'}</button>`);
  } else if (vcEditId) {
    vcActions(`<button type="button" class="btn primary" data-vc="save">Save changes</button>
      <button type="button" class="btn" data-vc="png">PNG</button><button type="button" class="btn" data-vc="svg">SVG</button>
      <button type="button" class="btn" data-vc="eps">EPS</button><button type="button" class="btn" data-vc="pdf">PDF</button>
      <button type="button" class="btn" data-vc="new">New vCard</button>`);
  } else {
    vcActions(`<button type="button" class="btn primary" data-vc="create">Create vCard QR</button>`);
  }
}, 200);

function vcFileName() { return slugify(vcForm.elements.qrName.value || VCard.fullName(vcState.card || {})); }

async function vcAction(act) {
  const { card, errors, text } = vcState;
  try {
    if (act === 'new') return resetVcard();
    if (['create', 'save'].includes(act) || $('#vc-static').checked) {
      if (errors.length) { vcSubmitted = true; updateVcard(); $('#vc-error').scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    }
    const style = vcDesign.get();
    const isStatic = $('#vc-static').checked;
    const qrData = isStatic ? text : vcShortUrl;
    const render = { png: renderPng, svg: renderSvg, eps: renderEps, pdf: renderPdf }[act];
    if (render) {
      download(URL.createObjectURL(await render(qrData, { ...style, size: 1024 })), `${vcFileName()}.${act}`);
      if (isStatic) saveStaticVcard({ download: true }).catch(() => {}); // keep static vCards on the dashboard
      return;
    }
    if (act === 'vcf') return download(URL.createObjectURL(new Blob([VCard.build(card)], { type: 'text/vcard' })), `${vcFileName()}.vcf`);
    if (act === 'savestatic') { await saveStaticVcard(); toast('Saved to dashboard'); return; }
    const { dark, light, ecc, margin } = style;
    const body = { type: 'vcard', name: vcForm.elements.qrName.value.trim(), vcard: readVcard(), style: { dark, light, ecc, margin } };
    if (act === 'create') {
      const c = await api('/dynamic', { method: 'POST', body });
      vcEditId = c.id; vcShortUrl = c.shortUrl;
      if (!body.name) vcForm.elements.qrName.value = c.name;
      $('#vc-title').textContent = `Editing: ${c.name}`;
      toast('vCard QR created');
      setVcPreview('qr');
    } else if (act === 'save') {
      if (!body.name) delete body.name;
      const c = await api(`/dynamic/${vcEditId}`, { method: 'PATCH', body });
      $('#vc-title').textContent = `Editing: ${c.name}`;
      toast('Saved. The printed QR now shows the new details');
    }
    updateVcard();
  } catch (err) { $('#vc-error').textContent = err.message; }
}

let vcStaticEditId = null;
async function saveStaticVcard({ download: dl = false } = {}) {
  const { card, text } = vcState;
  const { dark, light, ecc, margin } = vcDesign.get();
  const r = await api('/static', { method: 'POST', body: {
    id: vcStaticEditId || undefined, name: vcForm.elements.qrName.value.trim(), contentType: 'vcard',
    payload: text, fields: card, style: { dark, light, ecc, margin }, download: dl,
  } });
  if (vcStaticEditId) vcStaticEditId = r.id;
  $('#vc-qr-note').innerHTML += ` <span class="saved-note">✓ Saved to dashboard · <a href="#qr/s/${r.id}">View</a></span>`;
  return r;
}
function editStaticVcard(c) {
  vcEditId = null; vcShortUrl = ''; vcStaticEditId = c.id;
  $('#vc-title').textContent = `Editing: ${c.name}`;
  fillVcard(c.fields || {}, { name: c.name, style: c.style });
  $('#vc-static').checked = true;
  setVcPreview('qr');
  go('#vcard');
  updateVcard();
  scrollTo({ top: 0 });
}

function fillVcard(card = {}, { name = '', style } = {}) {
  vcForm.reset();
  for (const k of ['firstName', 'lastName', 'company', 'jobTitle', 'birthday', 'address', 'about']) vcForm.elements[k].value = card[k] || '';
  for (const k of Object.keys(VCard.SOCIALS)) vcForm.elements['soc_' + k].value = (card.socials || {})[k] || '';
  vcForm.elements.color.value = card.color || '#4f46e5';
  setTemplate(card.template || 'classic');
  tintMinis();
  $('#vc-color-hex').textContent = vcForm.elements.color.value.toUpperCase();
  vcForm.elements.qrName.value = name;
  setRows('phone', card.phones); setRows('email', card.emails); setRows('website', card.websites);
  if (style) vcDesign.set(style);
  vcSubmitted = false;
  setPhoto(card.photo || '');
}
function resetVcard() {
  vcEditId = null; vcShortUrl = ''; vcStaticEditId = null;
  $('#vc-title').textContent = 'vCard QR code';
  fillVcard();
  setVcPreview('card');
}
async function editVcard(id) {
  try {
    const d = await api(`/dynamic/${id}`);
    vcEditId = d.id; vcShortUrl = d.shortUrl;
    vcStaticEditId = null;
    $('#vc-static').checked = false;
    $('#vc-title').textContent = `Editing: ${d.name}`;
    fillVcard(d.vcard, { name: d.name, style: d.style });
    go('#vcard');
    scrollTo({ top: 0 });
  } catch (err) { toast(err.message); }
}
resetVcard();

document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]'); if (!g) return;
  e.preventDefault(); go('#' + g.dataset.goto);
});
addEventListener('hashchange', route);
route();
