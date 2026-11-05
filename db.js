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

module.exports = db;
