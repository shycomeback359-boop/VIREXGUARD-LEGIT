const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virex-guard-migration-'));
const dbPath = path.join(tempDir, 'legacy.sqlite');
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar TEXT, premium_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE scripts(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, source_path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, executions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE keys(key TEXT PRIMARY KEY, script_id TEXT NOT NULL, days INTEGER NOT NULL, uses_left INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at INTEGER NOT NULL);
  INSERT INTO users(id,username,created_at) VALUES('legacy-user','Legacy',1);
  INSERT INTO scripts(id,owner_id,name,slug,source_path,created_at) VALUES('legacy-script','legacy-user','Legacy Script','legacy','/tmp/legacy.lua',1);
  INSERT INTO keys(key,script_id,days,uses_left,created_at) VALUES('legacy-key','legacy-script',30,1,1);
`);
legacy.close();
process.env.DB_PATH = dbPath;
const db = require('../src/db');

test('legacy database receives redeemed_by and downloads migrations without losing data', () => {
  const keyColumns = db.prepare('PRAGMA table_info(keys)').all().map(x => x.name);
  const scriptColumns = db.prepare('PRAGMA table_info(scripts)').all().map(x => x.name);
  assert.ok(keyColumns.includes('redeemed_by'));
  assert.ok(scriptColumns.includes('downloads'));
  assert.equal(db.prepare('SELECT key FROM keys WHERE key=?').get('legacy-key').key, 'legacy-key');
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(x => x.name);
  assert.ok(indexes.includes('keys_script_redeemer_idx'));
});

test.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
