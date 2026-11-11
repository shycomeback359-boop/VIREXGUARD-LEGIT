const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virex-guard-test-'));
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
const db = require('../src/db');

test('database creates the expected core tables and indexes', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
  for (const name of ['users','scripts','keys','entitlements','hwids','sessions','audit','guilds','buyer_roles']) assert.ok(tables.includes(name), `missing ${name}`);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(x => x.name);
  assert.ok(indexes.includes('entitlements_user_expiry_idx'));
  const scriptColumns = db.prepare('PRAGMA table_info(scripts)').all().map(x => x.name);
  assert.ok(scriptColumns.includes('downloads'), 'missing downloads counter');
});

test('a key can only be claimed once and entitlement update is atomic', () => {
  const now = Date.now();
  db.prepare('INSERT INTO users(id,username,created_at) VALUES(?,?,?)').run('user-1','Tester',now);
  db.prepare('INSERT INTO scripts(id,owner_id,name,slug,source_path,created_at) VALUES(?,?,?,?,?,?)').run('script-1','user-1','Test Script','test-script','/tmp/test.lua',now);
  db.prepare('INSERT INTO keys(key,script_id,days,uses_left,created_at) VALUES(?,?,?,?,?)').run('key-1','script-1',30,1,now);
  const claim = db.transaction(() => {
    const result = db.prepare('UPDATE keys SET uses_left=0,redeemed_by=? WHERE key=? AND uses_left>0 AND redeemed_by IS NULL').run('user-1','key-1');
    if (result.changes !== 1) throw new Error('KEY_ALREADY_CLAIMED');
    db.prepare('INSERT INTO entitlements(user_id,script_id,expires_at) VALUES(?,?,?) ON CONFLICT(user_id,script_id) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)').run('user-1','script-1',now+30*86400000);
  });
  claim();
  assert.equal(db.prepare('SELECT uses_left FROM keys WHERE key=?').get('key-1').uses_left,0);
  assert.ok(db.prepare('SELECT expires_at FROM entitlements WHERE user_id=? AND script_id=?').get('user-1','script-1').expires_at > now);
  assert.throws(() => claim(), /KEY_ALREADY_CLAIMED/);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n,1);
  db.prepare('UPDATE scripts SET downloads=downloads+1 WHERE id=?').run('script-1');
  assert.equal(db.prepare('SELECT downloads FROM scripts WHERE id=?').get('script-1').downloads,1);
});

test('script slugs are unique', () => {
  assert.throws(() => db.prepare('INSERT INTO scripts(id,owner_id,name,slug,source_path,created_at) VALUES(?,?,?,?,?,?)').run('script-2','user-1','Duplicate','test-script','/tmp/other.lua',Date.now()));
});

test.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
