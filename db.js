// SQLite storage using Node's built-in driver (no native build step).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'qr.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS dynamic_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    target_url  TEXT    NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    style       TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id     INTEGER NOT NULL REFERENCES dynamic_codes(id) ON DELETE CASCADE,
    scanned_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    visitor     TEXT,
    device      TEXT,
    os          TEXT,
    browser     TEXT,
    referrer    TEXT,
    language    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scans_code ON scans(code_id, scanned_at);

  -- Static codes are generated in the browser; they're saved here so the dashboard can list them.
  -- content_hash dedupes re-downloads of the same code.
  CREATE TABLE IF NOT EXISTS static_codes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    content_type  TEXT    NOT NULL,
    payload       TEXT    NOT NULL,
    fields        TEXT    NOT NULL DEFAULT '{}',
    style         TEXT    NOT NULL DEFAULT '{}',
    content_hash  TEXT    NOT NULL,
    downloads     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_static_hash ON static_codes(content_hash);

  -- Previous slugs of dynamic codes. Printed QRs still contain the old link, so it keeps working.
  CREATE TABLE IF NOT EXISTS code_aliases (
    alias       TEXT    PRIMARY KEY,
    code_id     INTEGER NOT NULL REFERENCES dynamic_codes(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS url_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id     INTEGER NOT NULL REFERENCES dynamic_codes(id) ON DELETE CASCADE,
    target_url  TEXT    NOT NULL,
    changed_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- migrations for databases created by earlier versions ---
const cols = db.prepare('PRAGMA table_info(dynamic_codes)').all().map((c) => c.name);
// type: 'url' (redirect) or 'vcard' (hosted contact card); payload: JSON for non-url types
if (!cols.includes('type')) db.exec("ALTER TABLE dynamic_codes ADD COLUMN type TEXT NOT NULL DEFAULT 'url'");
if (!cols.includes('payload')) db.exec('ALTER TABLE dynamic_codes ADD COLUMN payload TEXT');

// scan location (from offline GeoIP; the IP itself is never stored)
const scanCols = db.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
for (const col of ['country', 'region', 'city']) {
  if (!scanCols.includes(col)) db.exec(`ALTER TABLE scans ADD COLUMN ${col} TEXT`);
}

module.exports = db;
