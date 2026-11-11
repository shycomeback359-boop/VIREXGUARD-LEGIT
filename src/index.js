require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const db = require('./db');
const app = express();
class SQLiteSessionStore extends session.Store {
  get(sid, cb) { try { const row = db.prepare('SELECT sess,expire FROM sessions WHERE sid=?').get(sid); if (!row || row.expire <= now()) { if (row) db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); return cb(null, null); } cb(null, JSON.parse(row.sess)); } catch (e) { cb(e); } }
  set(sid, sess, cb = () => {}) { try { const expire = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : now() + 7 * 86400000; db.prepare('INSERT INTO sessions(sid,sess,expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expire=excluded.expire').run(sid, JSON.stringify(sess), expire); cb(null); } catch (e) { cb(e); } }
  destroy(sid, cb = () => {}) { try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(null); } catch (e) { cb(e); } }
  touch(sid, sess, cb = () => {}) { try { const expire = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : now() + 7 * 86400000; db.prepare('UPDATE sessions SET expire=? WHERE sid=?').run(expire, sid); cb(null); } catch (e) { cb(e); } }
}

const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'scripts');
fs.mkdirSync(uploadDir, { recursive: true });
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || process.env.SESSION_SECRET === 'CHANGE_ME_BEFORE_DEPLOYMENT')) throw new Error('Set a unique SESSION_SECRET of at least 32 characters');
if (process.env.NODE_ENV === 'production' && !BASE.startsWith('https://')) throw new Error('Set BASE_URL to the public HTTPS application URL');
if (process.env.NODE_ENV === 'production' && process.env.DISCORD_REDIRECT_URI && !process.env.DISCORD_REDIRECT_URI.startsWith('https://')) throw new Error('DISCORD_REDIRECT_URI must use HTTPS in production');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({ store: new SQLiteSessionStore(), name: 'vg.sid', secret: process.env.SESSION_SECRET || 'local-development-only-secret-change-this', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000 } }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/', rateLimit({ windowMs: 60000, limit: 100, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again shortly.' } });
app.use(['/auth/discord', '/auth/discord/callback'], authLimiter);
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) { try { if (new URL(origin).origin !== new URL(BASE).origin && !(BASE.startsWith('http://localhost') && new URL(origin).origin === BASE)) return res.status(403).json({ error: 'Request origin not allowed' }); } catch { return res.status(403).json({ error: 'Invalid request origin' }); } }
  next();
});
const storage = multer.diskStorage({ destination: uploadDir, filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.lua`) });
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, /\.lua$/i.test(file.originalname)) });
const now = () => Date.now();
const sessionCleanup = setInterval(() => { try { db.prepare('DELETE FROM sessions WHERE expire<=?').run(now()); } catch (e) { console.error('Session cleanup:', e.message); } }, 60 * 60 * 1000);
sessionCleanup.unref();
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const boundedInt = (value, min, max) => Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
const isAdmin = id => (process.env.ADMIN_DISCORD_IDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(String(id));
const user = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Login with Discord first' });
const admin = (req, res, next) => req.session.user && isAdmin(req.session.user.id) ? next() : res.status(403).json({ error: 'Admin access required' });
const audit = (actor, action, detail = '') => db.prepare('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)').run(String(actor || 'system'), action, String(detail).slice(0, 1000), now());
const getScript = id => db.prepare('SELECT * FROM scripts WHERE id=? OR slug=?').get(String(id), String(id));
function saveUser(p) { db.prepare('INSERT INTO users(id,username,avatar,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,avatar=excluded.avatar').run(p.id, p.username || p.global_name || 'Discord User', p.avatar || null, now()); }
function issueKey(scriptId, days, issuer, redeemedBy = null) { const key = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO keys(key,script_id,days,uses_left,created_by,redeemed_by,created_at) VALUES(?,?,?,?,?,?,?)').run(key, scriptId, days, 1, issuer || null, redeemedBy, now()); return key; }

app.get('/bot/invite', (_req, res) => {
  if (!process.env.DISCORD_CLIENT_ID) return res.status(503).send('Discord application ID is not configured.');
  const permissions = '268454912'; // Manage Roles + View Channels + Send Messages + Embed Links
  const query = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, permissions, scope: 'bot applications.commands' });
  res.redirect(`https://discord.com/oauth2/authorize?${query}`);
});
app.get('/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !process.env.DISCORD_REDIRECT_URI) return res.status(503).send('Discord OAuth is not configured.');
  const state = crypto.randomBytes(24).toString('hex'); req.session.oauthState = state;
  const q = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, redirect_uri: process.env.DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify', state });
  res.redirect(`https://discord.com/oauth2/authorize?${q}`);
});
app.get('/auth/discord/callback', async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || !req.session.oauthState || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid OAuth state');
    delete req.session.oauthState;
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: process.env.DISCORD_REDIRECT_URI }), signal: AbortSignal.timeout(10000) });
    const token = await tokenRes.json(); if (!tokenRes.ok || !token.access_token) return res.status(401).send('Discord login failed');
    const profileRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000) });
    const p = await profileRes.json(); if (!profileRes.ok || !p.id) return res.status(401).send('Could not read Discord profile');
    saveUser(p);
    req.session.regenerate(err => { if (err) return res.status(500).send('Session error'); req.session.user = { id: p.id, username: p.username, avatar: p.avatar }; res.redirect('/dashboard.html'); });
  } catch (e) { console.error('OAuth callback:', e); res.status(500).send('Login error'); }
});
app.post('/api/logout', user, (req, res) => req.session.destroy(err => { if (err) return res.status(500).json({ error: 'Could not end session' }); res.clearCookie('vg.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }); res.json({ ok: true }); }));
app.get('/api/me', (req, res) => { if (!req.session.user) return res.json({ user: null }); const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id); res.json({ user: req.session.user, premium: !!u && u.premium_until > now(), premiumUntil: u?.premium_until || 0, admin: isAdmin(req.session.user.id) }); });
app.get('/api/dashboard', user, (req, res) => {
  const uid = req.session.user.id, u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!u) return res.status(401).json({ error: 'Account record missing. Sign out and sign in again.' });
  const scripts = db.prepare('SELECT id,name,slug,enabled,executions,downloads,created_at FROM scripts WHERE owner_id=? ORDER BY created_at DESC').all(uid);
  const guilds = db.prepare('SELECT count(*) n FROM guilds').get().n;
  const access = db.prepare('SELECT e.script_id,e.expires_at,s.name,s.slug FROM entitlements e JOIN scripts s ON s.id=e.script_id WHERE e.user_id=? AND e.expires_at>? AND s.enabled=1 ORDER BY e.expires_at DESC').all(uid, now());
  res.json({ scripts, access, stats: { scripts: scripts.length, downloads: scripts.reduce((a, s) => a + (s.downloads || 0), 0), servers: guilds }, premium: u.premium_until > now(), premiumUntil: u.premium_until, limit: u.premium_until > now() ? 8 : 3 });
});
app.post('/api/scripts', user, (req, res, next) => upload.single('script')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a .lua file' });
  const uid = req.session.user.id;
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Script name is required' }); }
  const id = crypto.randomUUID(), slug = crypto.randomBytes(12).toString('hex');
  try {
    db.transaction(() => {
      const u = db.prepare('SELECT premium_until FROM users WHERE id=?').get(uid);
      if (!u) throw new Error('ACCOUNT_NOT_FOUND');
      const count = db.prepare('SELECT count(*) n FROM scripts WHERE owner_id=?').get(uid).n;
      const limit = u.premium_until > now() ? 8 : 3;
      if (count >= limit) throw new Error('PLAN_LIMIT');
      db.prepare('INSERT INTO scripts(id,owner_id,name,slug,source_path,created_at) VALUES(?,?,?,?,?,?)').run(id, uid, name, slug, req.file.path, now());
      audit(uid, 'script.create', `${id}:${name}`);
    })();
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    if (e.message === 'PLAN_LIMIT') return res.status(403).json({ error: 'Your plan has reached its script limit' });
    if (e.message === 'ACCOUNT_NOT_FOUND') return res.status(401).json({ error: 'Account record missing. Sign out and sign in again.' });
    console.error('Script upload save failed:', e);
    return res.status(500).json({ error: 'Could not save script. Please retry.' });
  }
  res.json({ ok: true, id, name, slug });
});
app.patch('/api/scripts/:id', user, (req, res) => { const s = db.prepare('SELECT * FROM scripts WHERE id=? AND owner_id=?').get(req.params.id, req.session.user.id); if (!s) return res.status(404).json({ error: 'Script not found' }); const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name'); const hasEnabled = Object.prototype.hasOwnProperty.call(req.body, 'enabled'); if (hasEnabled && typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' }); const name = hasName ? String(req.body.name || '').trim().slice(0, 60) : s.name; if (hasName && !name) return res.status(400).json({ error: 'Script name cannot be empty' }); if (!hasName && !hasEnabled) return res.status(400).json({ error: 'No supported changes supplied' }); db.transaction(() => { if (hasName) db.prepare('UPDATE scripts SET name=? WHERE id=?').run(name, s.id); if (hasEnabled) db.prepare('UPDATE scripts SET enabled=? WHERE id=?').run(req.body.enabled ? 1 : 0, s.id); audit(req.session.user.id, 'script.update', s.id); })(); res.json({ ok: true }); });
app.delete('/api/scripts/:id', user, (req, res) => { const s = db.prepare('SELECT * FROM scripts WHERE id=? AND owner_id=?').get(req.params.id, req.session.user.id); if (!s) return res.status(404).json({ error: 'Script not found' }); db.transaction(() => { db.prepare('DELETE FROM hwids WHERE script_id=?').run(s.id); db.prepare('DELETE FROM entitlements WHERE script_id=?').run(s.id); db.prepare('DELETE FROM keys WHERE script_id=?').run(s.id); db.prepare('DELETE FROM buyer_roles WHERE script_id=?').run(s.id); db.prepare('DELETE FROM scripts WHERE id=?').run(s.id); audit(req.session.user.id, 'script.delete', s.id); })(); try { fs.unlinkSync(s.source_path); } catch {} res.json({ ok: true }); });
app.post('/api/redeem', user, (req, res) => {
  const key = String(req.body.key || '').trim();
  if (key.length < 16 || key.length > 128) return res.status(400).json({ error: 'Invalid key format' });
  const row = db.prepare('SELECT * FROM keys WHERE key=?').get(key);
  if (!row || row.uses_left < 1 || (row.redeemed_by && row.redeemed_by !== req.session.user.id)) return res.status(400).json({ error: 'Invalid, used, or assigned key' });
  const script = db.prepare('SELECT * FROM scripts WHERE id=? AND enabled=1').get(row.script_id); if (!script) return res.status(404).json({ error: 'Script unavailable' });
  const expiry = now() + row.days * 86400000;
  const tx = db.transaction(() => {
    const claimed = db.prepare('UPDATE keys SET uses_left=0,redeemed_by=? WHERE key=? AND uses_left>0 AND redeemed_by IS NULL').run(req.session.user.id, key);
    if (claimed.changes !== 1) throw new Error('KEY_ALREADY_CLAIMED');
    db.prepare('INSERT INTO entitlements(user_id,script_id,expires_at) VALUES(?,?,?) ON CONFLICT(user_id,script_id) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)').run(req.session.user.id, row.script_id, expiry);
    audit(req.session.user.id, 'key.redeem', row.script_id);
  });
  try { tx(); } catch (e) { return res.status(409).json({ error: e.message === 'KEY_ALREADY_CLAIMED' ? 'This key has already been redeemed' : 'Key redemption conflict; try again' }); }
  res.json({ ok: true, message: 'Key redeemed', expiresAt: expiry, script: script.name });
});
// Download-only delivery: source files are never remotely executed by this service.
app.get('/api/scripts/:id/download', user, (req, res) => {
  const s = db.prepare('SELECT * FROM scripts WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Script not found' });
  const uid = req.session.user.id;
  const owner = s.owner_id === uid;
  const entitled = !!db.prepare('SELECT 1 FROM entitlements WHERE user_id=? AND script_id=? AND expires_at>?').get(uid, s.id, now());
  if (!owner && (!s.enabled || !entitled)) return res.status(403).json({ error: 'Active access required' });
  const resolved = path.resolve(s.source_path);
  const root = path.resolve(uploadDir) + path.sep;
  if (!resolved.startsWith(root) || !fs.existsSync(resolved)) return res.status(404).json({ error: 'Stored file is unavailable' });
  res.set('Cache-Control', 'private, no-store');
  res.download(resolved, `${s.slug}.lua`, err => {
    if (err) { console.error('Script download:', err); if (!res.headersSent) res.status(500).json({ error: 'Download failed' }); return; }
    try { db.prepare('UPDATE scripts SET downloads=downloads+1 WHERE id=?').run(s.id); }
    catch (e) { console.error('Download counter update:', e.message); }
  });
});
app.get('/api/admin/overview', admin, (_req, res) => res.json({ users: db.prepare('SELECT count(*) n FROM users').get().n, scripts: db.prepare('SELECT count(*) n FROM scripts').get().n, keys: db.prepare('SELECT count(*) n FROM keys').get().n, activeEntitlements: db.prepare('SELECT count(*) n FROM entitlements WHERE expires_at>?').get(now()).n, guilds: db.prepare('SELECT count(*) n FROM guilds').get().n, recentAudit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 20').all() }));
app.get('/api/admin/scripts', admin, (_req, res) => res.json({ scripts: db.prepare('SELECT s.*,u.username owner_name FROM scripts s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.created_at DESC').all() }));
app.get('/api/admin/users', admin, (_req, res) => res.json({ users: db.prepare('SELECT id,username,avatar,premium_until,created_at FROM users ORDER BY created_at DESC LIMIT 200').all() }));
app.post('/api/admin/keys', admin, (req, res) => { const s = getScript(req.body.scriptId); if (!s) return res.status(404).json({ error: 'Script not found' }); const count = boundedInt(req.body.count, 1, 100), days = boundedInt(req.body.days, 1, 3650); if (!count || !days) return res.status(400).json({ error: 'count must be 1–100 and days must be 1–3650 whole days' }); const created = []; const tx = db.transaction(() => { for (let i = 0; i < count; i++) created.push(issueKey(s.id, days, req.session.user.id)); audit(req.session.user.id, 'admin.keys.create', `${s.id}:${count}:${days}`); }); tx(); res.json({ ok: true, keys: created }); });
app.post('/api/admin/premium', admin, (req, res) => { const uid = String(req.body.userId || '').trim(); const days = boundedInt(req.body.days, 1, 3650); if (!/^\d{17,20}$/.test(uid)) return res.status(400).json({ error: 'Enter a valid Discord user ID' }); if (!days) return res.status(400).json({ error: 'days must be a whole number from 1 to 3650' }); if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid)) return res.status(404).json({ error: 'User not found' }); const until = now() + days * 86400000; db.transaction(() => { db.prepare('UPDATE users SET premium_until=max(premium_until,?) WHERE id=?').run(until, uid); audit(req.session.user.id, 'admin.premium.grant', `${uid}:${days}`); })(); res.json({ ok: true, premiumUntil: until }); });
app.post('/api/admin/scripts/:id/toggle', admin, (req, res) => { const s = getScript(req.params.id); if (!s) return res.status(404).json({ error: 'Script not found' }); if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' }); const enabled = req.body.enabled ? 1 : 0; db.transaction(() => { db.prepare('UPDATE scripts SET enabled=? WHERE id=?').run(enabled, s.id); audit(req.session.user.id, 'admin.script.toggle', `${s.id}:${enabled}`); })(); res.json({ ok: true, enabled: !!enabled }); });
app.get('/health', (_req, res) => res.json({ ok: true, service: 'VIREX GUARD', time: new Date().toISOString() }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
if (require.main === module) app.listen(PORT, () => { console.log(`VIREX GUARD listening on ${PORT}`); if (process.env.DISCORD_BOT_TOKEN) { const bot = fork(path.join(__dirname, '..', 'bot', 'bot.js'), [], { env: process.env, stdio: 'inherit' }); bot.on('exit', code => console.error(`Discord bot exited with code ${code}`)); } });
module.exports = app;
