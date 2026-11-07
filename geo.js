// Offline IP geolocation for scan stats (country / region / city).
// Visitors' IPs are looked up in a local database and never sent to a third party,
// and only the resulting place names are stored, never the IP itself.
//
// Database: DB-IP "IP to City Lite" (CC BY 4.0, https://db-ip.com), downloaded
// automatically into DATA_DIR/geo and refreshed monthly. Alternatively set
// GEOIP_DB to one or more comma-separated .mmdb files (e.g. MaxMind GeoLite2-City).
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const maxmind = require('maxmind');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GEO_DIR = path.join(DATA_DIR, 'geo');
const AUTO_FILE = path.join(GEO_DIR, 'dbip-city-lite.mmdb');
const CUSTOM = (process.env.GEOIP_DB || '').split(',').map((s) => s.trim()).filter(Boolean);
const AUTO_UPDATE = !CUSTOM.length && process.env.GEOIP_AUTO_UPDATE !== 'off';
const MAX_AGE_MS = 32 * 864e5;

let readers = [];
const state = { enabled: false, source: null, updatedAt: null, error: null };
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

function countryName(code) {
  if (!code) return null;
  try { return regionNames.of(code) || code; } catch { return code; }
}

// Accepts both the official DB-IP/MaxMind layout and the flat ip-location-db layout.
function normalize(rec) {
  if (!rec) return null;
  let country, region, city;
  if (rec.country && typeof rec.country === 'object') {
    country = rec.country.iso_code;
    region = rec.subdivisions?.[0]?.names?.en;
    city = rec.city?.names?.en;
  } else {
    country = rec.country_code;
    region = rec.state1;
    city = rec.city;
  }
  if (!country) return null;
  return { country: String(country).toUpperCase().slice(0, 2), region: region || null, city: city || null };
}

function lookup(ip) {
  if (!readers.length || !ip) return null;
  ip = ip.replace(/^::ffff:/, '');
  if (!maxmind.validate(ip)) return null;
  for (const r of readers) {
    try {
      const hit = normalize(r.get(ip));
      if (hit) return hit;
    } catch { /* address family not in this file */ }
  }
  return null;
}

async function load() {
  const files = CUSTOM.length ? CUSTOM : [AUTO_FILE];
  const next = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try { next.push(await maxmind.open(f, { watchForUpdates: false })); }
    catch (e) { state.error = `Could not open ${path.basename(f)}: ${e.message}`; }
  }
  readers = next;
  state.enabled = next.length > 0;
  if (state.enabled) {
    state.error = null;
    state.source = CUSTOM.length ? CUSTOM.map((f) => path.basename(f)).join(', ') : 'DB-IP City Lite';
    state.updatedAt = fs.statSync(files.find((f) => fs.existsSync(f))).mtime.toISOString();
  }
}

function fetchTo(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'qr-platform-geoip-updater' } }, async (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      try { await pipeline(res, zlib.createGunzip(), fs.createWriteStream(dest)); resolve(); }
      catch (e) { reject(e); }
    }).on('error', reject).setTimeout(120000, function () { this.destroy(new Error('timeout')); });
  });
}

async function update() {
  fs.mkdirSync(GEO_DIR, { recursive: true });
  const tmp = AUTO_FILE + '.download';
  const now = new Date();
  // The current month's file appears early in the month; fall back to last month's.
  const months = [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return d.toISOString().slice(0, 7);
  });
  let lastErr;
  for (const m of months) {
    try {
      await fetchTo(`https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz`, tmp);
      await maxmind.open(tmp); // sanity check before replacing the working file
      fs.renameSync(tmp, AUTO_FILE);
      console.log(`GeoIP: installed DB-IP City Lite ${m}`);
      return load();
    } catch (e) { lastErr = e; fs.rmSync(tmp, { force: true }); }
  }
  throw lastErr;
}

async function init() {
  await load();
  if (!AUTO_UPDATE) return;
  const check = async () => {
    const stale = !fs.existsSync(AUTO_FILE) || Date.now() - fs.statSync(AUTO_FILE).mtimeMs > MAX_AGE_MS;
    if (!stale) return;
    try { await update(); }
    catch (e) {
      state.error = `GeoIP download failed: ${e.message}`;
      console.error(state.error, '(scans are still recorded, without location)');
    }
  };
  check(); // in the background, so startup isn't delayed
  setInterval(check, 864e5).unref();
}

module.exports = { init, lookup, countryName, state, normalize };
