const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const zlib = require('zlib');
const db = require('./db');
const VCard = require('./public/vcard');
const geo = require('./geo');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const IP_SALT = process.env.IP_SALT || crypto.randomBytes(16).toString('hex');

// Only trust X-Forwarded-* from a reverse proxy on this machine.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' })); // vCard photos are sent as data URLs

// ---------- helpers ----------

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(len = 7) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function validUrl(value) {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const HEX = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
function qrOptions(q) {
  const color = (c, d) => (c && HEX.test(c) ? (c.startsWith('#') ? c : '#' + c) : d);
  const ecc = ['L', 'M', 'Q', 'H'].includes(String(q.ecc).toUpperCase()) ? String(q.ecc).toUpperCase() : 'M';
  const width = Math.min(Math.max(parseInt(q.size, 10) || 512, 64), 2048);
  const margin = Math.min(Math.max(parseInt(q.margin, 10) || 0, 0), 16);
  return {
    errorCorrectionLevel: ecc,
    width,
    margin: q.margin === undefined ? 2 : margin,
    color: { dark: color(q.dark, '#000000'), light: color(q.light, '#ffffff') },
  };
}

function parseUA(ua = '') {
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)
    ? 'Tablet'
    : /Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua)
      ? 'Mobile'
      : ua ? 'Desktop' : 'Unknown';
  const os = /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /CrOS/i.test(ua) ? 'ChromeOS'
    : /Linux/i.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /SamsungBrowser/i.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/i.test(ua) ? 'Firefox'
    : /Chrome|CriOS/i.test(ua) ? 'Chrome'
    : /Safari/i.test(ua) ? 'Safari' : 'Other';
  return { device, os, browser };
}

function serialize(row, req, { full = false } = {}) {
  let vcard;
  if (row.type === 'vcard') {
    vcard = JSON.parse(row.payload || '{}');
    if (!full) { vcard.hasPhoto = !!vcard.photo; delete vcard.photo; } // keep list responses small
  }
  return {
    id: row.id,
    code: row.code,
    type: row.type || 'url',
    vcard,
    name: row.name,
    targetUrl: row.target_url,
    active: !!row.active,
    style: JSON.parse(row.style || '{}'),
    shortUrl: `${baseUrl(req)}/r/${row.code}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalScans: row.total_scans ?? undefined,
    uniqueScans: row.unique_scans ?? undefined,
    lastScan: row.last_scan ?? undefined,
  };
}

function cleanStyle(style) {
  if (!style || typeof style !== 'object') return {};
  const out = {};
  for (const k of ['dark', 'light']) if (HEX.test(style[k] || '')) out[k] = style[k];
  if (['L', 'M', 'Q', 'H'].includes(style.ecc)) out.ecc = style.ecc;
  if (Number.isInteger(style.margin)) out.margin = Math.min(Math.max(style.margin, 0), 16);
  return out;
}

// ---------- optional admin auth ----------
// If ADMIN_PASSWORD is set, the dashboard & API require HTTP Basic auth.
// The /r/:code redirect is always public so printed codes keep working.
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="QR Platform"').status(401).send('Authentication required');
}

// ---------- public redirect (the "dynamic" part) ----------

const findByCode = db.prepare('SELECT * FROM dynamic_codes WHERE code = ?');
const insertScan = db.prepare(`INSERT INTO scans (code_id, visitor, device, os, browser, referrer, language, country, region, city)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function liveCode(req, res) {
  const row = findByCode.get(req.params.code);
  if (!row) { res.status(404).send(page('QR code not found', 'This code does not exist or was deleted.')); return null; }
  if (!row.active) { res.status(410).send(page('QR code paused', 'The owner of this QR code has paused it.')); return null; }
  return row;
}

// .vcf download for vCard codes (not counted as a scan)
app.get('/r/:code/vcf', (req, res) => {
  const row = liveCode(req, res);
  if (!row) return;
  if (row.type !== 'vcard') return res.status(404).send(page('Not found', 'This QR code is not a contact card.'));
  const card = JSON.parse(row.payload || '{}');
  const file = VCard.fullName(card).replace(/[^\w .-]+/g, '').trim().replace(/\s+/g, '_') || 'contact';
  res.set('Cache-Control', 'no-store');
  res.type('text/vcard; charset=utf-8').attachment(`${file}.vcf`).send(VCard.build(card));
});

app.get('/r/:code', (req, res) => {
  const row = liveCode(req, res);
  if (!row) return;

  const ua = req.get('user-agent') || '';
  const { device, os, browser } = parseUA(ua);
  const visitor = crypto.createHash('sha256').update(IP_SALT + (req.ip || '') + ua).digest('hex').slice(0, 16);
  const loc = geo.lookup(req.ip) || {};
  try {
    insertScan.run(row.id, visitor, device, os, browser,
      (req.get('referer') || '').slice(0, 300) || null,
      (req.get('accept-language') || '').split(',')[0].slice(0, 20) || null,
      loc.country || null, loc.region || null, loc.city || null);
  } catch (e) { console.error('scan log failed', e); }

  res.set('Cache-Control', 'no-store');
  if (row.type === 'vcard') {
    // Hosted contact card. No scripts at all, so lock it down with a strict CSP.
    res.set('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    return res.type('html').send(VCard.renderPage(JSON.parse(row.payload || '{}'), `/r/${row.code}/vcf`));
  }
  res.redirect(302, row.target_url);
});

function page(title, msg) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0;color:#334">
  <div style="text-align:center;padding:24px"><h1 style="font-size:22px">${title}</h1><p>${msg}</p></div></body>`;
}

// ---------- QR rendering (static & dynamic) ----------

app.get('/api/qr', requireAdmin, async (req, res) => {
  const data = String(req.query.data || '');
  if (!data) return res.status(400).json({ error: 'data is required' });
  if (data.length > 2900) return res.status(400).json({ error: 'data too long for a QR code' });
  const opts = qrOptions(req.query);
  try {
    if (req.query.format === 'svg') {
      const svg = await QRCode.toString(data, { ...opts, type: 'svg' });
      res.type('image/svg+xml').send(svg);
    } else if (req.query.format === 'eps') {
      res.type('application/postscript').send(toEps(data, opts));
    } else if (req.query.format === 'pdf') {
      res.type('application/pdf').send(toPdf(data, opts));
    } else {
      const buf = await QRCode.toBuffer(data, { ...opts, type: 'png' });
      res.type('image/png').send(buf);
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- vector formats (EPS, PDF) ----------
// The QR grid as rectangles, with adjacent dark modules in a row merged so files stay small.
// Coordinates are in modules with a bottom-left origin, which both PostScript and PDF use.
function qrVector(data, opts) {
  const qr = QRCode.create(data, { errorCorrectionLevel: opts.errorCorrectionLevel });
  const n = qr.modules.size, m = opts.margin, total = n + m * 2;
  const rows = [];
  for (let r = 0; r < n; r++) {
    const y = total - 1 - (r + m);
    const runs = [];
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) { c++; continue; }
      const start = c;
      while (c < n && qr.modules.get(r, c)) c++;
      runs.push([start + m, y, c - start]);
    }
    if (runs.length) rows.push(runs);
  }
  const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(' ');
  return {
    total, rows,
    size: opts.width, // output size in points
    dark: rgb(opts.color.dark),
    light: rgb(opts.color.light),
    transparentBg: opts.color.light.length === 9 && opts.color.light.slice(7).toLowerCase() === '00',
  };
}

// EPS for print shops / Illustrator / CorelDRAW.
function toEps(data, opts) {
  const v = qrVector(data, opts), W = v.size;
  const out = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${W} ${W}`,
    `%%HiResBoundingBox: 0 0 ${W}.000 ${W}.000`,
    '%%Title: QR code',
    '%%Creator: QR Platform',
    `%%CreationDate: ${new Date().toISOString()}`,
    '%%LanguageLevel: 2',
    '%%Pages: 1',
    '%%EndComments',
    '%%BeginProlog',
    '/R { rectfill } bind def',
    '%%EndProlog',
    '%%Page: 1 1',
    'gsave',
    `${(W / v.total).toFixed(6)} dup scale`,
  ];
  if (!v.transparentBg) out.push(`${v.light} setrgbcolor`, `0 0 ${v.total} ${v.total} R`);
  out.push(`${v.dark} setrgbcolor`);
  for (const runs of v.rows) out.push(runs.map(([x, y, w]) => `${x} ${y} ${w} 1 R`).join(' '));
  out.push('grestore', 'showpage', '%%EOF', '');
  return out.join('\n');
}

// Single-page vector PDF (PDF 1.4), page size = QR size.
function toPdf(data, opts) {
  const v = qrVector(data, opts), W = v.size;
  const ops = ['q', `${(W / v.total).toFixed(6)} 0 0 ${(W / v.total).toFixed(6)} 0 0 cm`];
  if (!v.transparentBg) ops.push(`${v.light} rg`, `0 0 ${v.total} ${v.total} re f`);
  ops.push(`${v.dark} rg`);
  for (const runs of v.rows) ops.push(runs.map(([x, y, w]) => `${x} ${y} ${w} 1 re`).join(' '));
  ops.push('f', 'Q');
  const content = zlib.deflateSync(Buffer.from(ops.join('\n')));
  const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${W}] /Resources << >> /Contents 4 0 R >>`,
    null, // content stream, binary
    `<< /Title (QR code) /Creator (QR Platform) /Producer (QR Platform) /CreationDate (D:${d}Z) >>`,
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const xref = [];
  objs.forEach((body, i) => {
    xref.push(offset);
    const chunk = body === null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream\nendobj\n')])
      : Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(chunk);
    offset += chunk.length;
  });
  const table = [`xref\n0 ${objs.length + 1}\n`, '0000000000 65535 f \n',
    ...xref.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${offset}\n%%EOF\n`].join('');
  parts.push(Buffer.from(table));
  return Buffer.concat(parts);
}

// ---------- dynamic code management API ----------

const api = express.Router();
api.use(requireAdmin);

const listStmt = db.prepare(`
  SELECT d.*, COUNT(s.id) AS total_scans, COUNT(DISTINCT s.visitor) AS unique_scans, MAX(s.scanned_at) AS last_scan
  FROM dynamic_codes d LEFT JOIN scans s ON s.code_id = d.id
  GROUP BY d.id ORDER BY d.created_at DESC, d.id DESC`);
const getStmt = db.prepare(`
  SELECT d.*, (SELECT COUNT(*) FROM scans WHERE code_id = d.id) AS total_scans,
         (SELECT COUNT(DISTINCT visitor) FROM scans WHERE code_id = d.id) AS unique_scans,
         (SELECT MAX(scanned_at) FROM scans WHERE code_id = d.id) AS last_scan
  FROM dynamic_codes d WHERE d.id = ?`);

api.get('/dynamic', (req, res) => {
  res.json(listStmt.all().map((r) => serialize(r, req)));
});

api.post('/dynamic', (req, res) => {
  const type = req.body.type === 'vcard' ? 'vcard' : 'url';
  let name = String(req.body.name || '').trim().slice(0, 120);
  let url = '', payload = null;
  if (type === 'vcard') {
    const { card, errors } = VCard.normalize(req.body.vcard);
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });
    payload = JSON.stringify(card);
    name = name || VCard.fullName(card).slice(0, 120);
  } else {
    url = validUrl(req.body.targetUrl);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!url) return res.status(400).json({ error: 'Destination must be a valid http(s) URL' });
  }

  let code = String(req.body.code || '').trim();
  if (code) {
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: 'Custom slug: 3-32 letters, numbers, - or _' });
    if (findByCode.get(code)) return res.status(409).json({ error: 'That slug is already taken' });
  } else {
    do { code = newCode(); } while (findByCode.get(code));
  }
  const info = db.prepare('INSERT INTO dynamic_codes (code, name, target_url, style, type, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, name, url, JSON.stringify(cleanStyle(req.body.style)), type, payload);
  if (type === 'url') db.prepare('INSERT INTO url_history (code_id, target_url) VALUES (?, ?)').run(info.lastInsertRowid, url);
  res.status(201).json(serialize(getStmt.get(info.lastInsertRowid), req, { full: true }));
});

api.get('/dynamic/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const id = row.id;
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  const daily = db.prepare(`
    SELECT date(scanned_at) AS day, COUNT(*) AS scans, COUNT(DISTINCT visitor) AS unique_scans
    FROM scans WHERE code_id = ? AND scanned_at >= datetime('now', ?)
    GROUP BY day ORDER BY day`).all(id, `-${days - 1} days`);
  const series = [];
  const byDay = Object.fromEntries(daily.map((d) => [d.day, d]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    series.push({ day: d, scans: byDay[d]?.scans || 0, unique: byDay[d]?.unique_scans || 0 });
  }
  const breakdown = (col) => db.prepare(
    `SELECT ${col} AS label, COUNT(*) AS count FROM scans WHERE code_id = ? GROUP BY ${col} ORDER BY count DESC LIMIT 8`
  ).all(id);
  // Location breakdowns. Scans without a known location are grouped as "Unknown".
  const place = (r) => [r.city, r.region, r.country && geo.countryName(r.country)].filter(Boolean).join(', ') || 'Unknown';
  const countries = db.prepare(`SELECT country, COUNT(*) AS count FROM scans WHERE code_id = ?
    GROUP BY country ORDER BY count DESC LIMIT 8`).all(id)
    .map((r) => ({ label: r.country ? geo.countryName(r.country) : 'Unknown', code: r.country, count: r.count }));
  const regions = db.prepare(`SELECT region, country, COUNT(*) AS count FROM scans WHERE code_id = ?
    GROUP BY region, country ORDER BY count DESC LIMIT 8`).all(id)
    .map((r) => ({ label: r.region ? `${r.region}${r.country ? ', ' + r.country : ''}` : 'Unknown', code: r.country, count: r.count }));
  const cities = db.prepare(`SELECT city, region, country, COUNT(*) AS count FROM scans WHERE code_id = ?
    GROUP BY city, region, country ORDER BY count DESC LIMIT 8`).all(id)
    .map((r) => ({ label: r.city ? `${r.city}${r.country ? ', ' + r.country : ''}` : 'Unknown', code: r.country, count: r.count }));

  res.json({
    ...serialize(row, req, { full: true }),
    stats: {
      series,
      devices: breakdown('device'),
      os: breakdown('os'),
      browsers: breakdown('browser'),
      countries, regions, cities,
      recent: db.prepare('SELECT scanned_at, device, os, browser, language, country, region, city FROM scans WHERE code_id = ? ORDER BY id DESC LIMIT 15')
        .all(id).map((r) => ({ ...r, location: place(r) })),
    },
    geo: { ...geo.state },
    history: db.prepare('SELECT target_url, changed_at FROM url_history WHERE code_id = ? ORDER BY id DESC LIMIT 20').all(id),
  });
});

api.patch('/dynamic/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 120) : row.name;
  if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
  let url = row.target_url;
  let payload = row.payload;
  if (row.type === 'vcard' && req.body.vcard !== undefined) {
    const { card, errors } = VCard.normalize(req.body.vcard);
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });
    payload = JSON.stringify(card);
  }
  if (row.type !== 'vcard' && req.body.targetUrl !== undefined) {
    url = validUrl(req.body.targetUrl);
    if (!url) return res.status(400).json({ error: 'Destination must be a valid http(s) URL' });
  }
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : row.active;
  const style = req.body.style !== undefined ? JSON.stringify(cleanStyle(req.body.style)) : row.style;

  db.prepare(`UPDATE dynamic_codes SET name = ?, target_url = ?, active = ?, style = ?, payload = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, url, active, style, payload, row.id);
  if (url !== row.target_url) db.prepare('INSERT INTO url_history (code_id, target_url) VALUES (?, ?)').run(row.id, url);
  res.json(serialize(getStmt.get(row.id), req, { full: true }));
});

api.delete('/dynamic/:id', (req, res) => {
  const info = db.prepare('DELETE FROM dynamic_codes WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

api.get('/dynamic/:id/scans.csv', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).send('Not found');
  const rows = db.prepare('SELECT scanned_at, device, os, browser, language, referrer, country, region, city FROM scans WHERE code_id = ? ORDER BY id').all(row.id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['scanned_at_utc,country_code,country,region,city,device,os,browser,language,referrer',
    ...rows.map((r) => [r.scanned_at, r.country, r.country && geo.countryName(r.country), r.region, r.city,
      r.device, r.os, r.browser, r.language, r.referrer].map(esc).join(','))].join('\n');
  res.type('text/csv').attachment(`${row.code}-scans.csv`).send(csv);
});

api.get('/overview', (req, res) => {
  res.json({
    dynamicCodes: db.prepare('SELECT COUNT(*) AS n FROM dynamic_codes').get().n,
    activeCodes: db.prepare('SELECT COUNT(*) AS n FROM dynamic_codes WHERE active = 1').get().n,
    totalScans: db.prepare('SELECT COUNT(*) AS n FROM scans').get().n,
    scansToday: db.prepare("SELECT COUNT(*) AS n FROM scans WHERE date(scanned_at) = date('now')").get().n,
  });
});

app.use('/api', api);

// ---------- dashboard UI ----------
app.use(requireAdmin, express.static(path.join(__dirname, 'public')));

geo.init().catch((e) => console.error('GeoIP init failed:', e.message));

app.listen(PORT, HOST, () => {
  console.log(`QR Platform running on http://${HOST}:${PORT}`);
  if (!process.env.BASE_URL) console.log('Tip: set BASE_URL to your public domain so dynamic codes point to it.');
  if (!ADMIN_PASSWORD) console.log('Tip: set ADMIN_PASSWORD to protect the dashboard.');
});
