'use strict';
// متجر MA Professional Perfume على Vercel: دالة واحدة + قاعدة بيانات Turso (libSQL)
const crypto = require('crypto');
const { createClient } = require('@libsql/client');
const PHONE = /^01[0-25]\d{8}$/;
let db;
const rows = r => r.rows.map(x => Object.fromEntries(r.columns.map((c, i) => [c, x[i]])));
const q = async (sql, args = []) => rows(await db.execute({ sql, args }));
const one = async (sql, args) => (await q(sql, args))[0] || null;
const run = (sql, args = []) => db.execute({ sql, args });
const hash = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const verify = (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(p, s, 32)); };

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,phone TEXT UNIQUE,pass TEXT,role TEXT DEFAULT 'customer',points INTEGER DEFAULT 0,created TEXT DEFAULT CURRENT_TIMESTAMP)",
  'CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER)',
  'CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT,section TEXT,gender TEXT,p10 INTEGER,p30 INTEGER,p50 INTEGER,p100 INTEGER,image TEXT,active INTEGER DEFAULT 1,cat TEXT DEFAULT \'perfume\')',
  "CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,code TEXT UNIQUE,user_id INTEGER,name TEXT,phone TEXT,wa TEXT,gov TEXT,addr TEXT,items TEXT,subtotal INTEGER,discount INTEGER,pts INTEGER DEFAULT 0,total INTEGER,pay TEXT,notes TEXT,status TEXT DEFAULT 'new',created TEXT DEFAULT CURRENT_TIMESTAMP)",
  'CREATE TABLE IF NOT EXISTS codes(code TEXT PRIMARY KEY,value INTEGER,uses INTEGER,expires TEXT,phone TEXT,label TEXT)',
  'CREATE TABLE IF NOT EXISTS plog(id INTEGER PRIMARY KEY,user_id INTEGER,delta INTEGER,note TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP)',
  'CREATE TABLE IF NOT EXISTS attempts(k TEXT,t INTEGER)',
  'CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT)',
  'CREATE TABLE IF NOT EXISTS bottles(id INTEGER PRIMARY KEY,name TEXT UNIQUE,size TEXT,shape TEXT,descr TEXT,image TEXT,sort INTEGER DEFAULT 0,active INTEGER DEFAULT 1)'
];
const VERSION = '2026-11-22-dedupe-v2';
const dedupe = async () => {
  const before = (await one('SELECT COUNT(*) AS n FROM products')).n;
  const cols = ['p10', 'p30', 'p50', 'p100'].map(k => k + '=COALESCE(' + k + ',(SELECT MAX(p.' + k + ') FROM products p WHERE p.name=products.name AND p.gender=products.gender))').join(',');
  await db.batch([
    'UPDATE products SET ' + cols + ',image=COALESCE(image,(SELECT p.image FROM products p WHERE p.name=products.name AND p.gender=products.gender AND p.image IS NOT NULL LIMIT 1)) WHERE id IN (SELECT MIN(id) FROM products GROUP BY name,gender HAVING COUNT(*)>1)',
    'DELETE FROM products WHERE id NOT IN (SELECT MIN(id) FROM products GROUP BY name,gender)',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_products_name_gender ON products(name,gender)'
  ], 'write');
  const after = (await one('SELECT COUNT(*) AS n FROM products')).n;
  return { before, after, removed: before - after };
};
let ready;
const init = () => ready || (ready = (async () => {
  db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  await db.batch(SCHEMA, 'write');
  // ترقية قواعد بيانات قديمة: لو عمود 100 مل اتضاف لأول مرة، ننقل الأسعار للعطور اللي لسه من غير أسعار
  try { await run('ALTER TABLE products ADD COLUMN p100 INTEGER'); await db.batch(require('../seed.json').filter(p => p.p10).map(p => ({ sql: 'UPDATE products SET p10=?,p30=?,p50=?,p100=? WHERE name=? AND p10 IS NULL AND p30 IS NULL AND p50 IS NULL', args: [p.p10 || null, p.p30 || null, p.p50 || null, p.p100 || null, p.name] })), 'write'); } catch (e) { /* العمود موجود */ }
  for (const m of ["ALTER TABLE products ADD COLUMN cat TEXT DEFAULT 'perfume'", 'ALTER TABLE orders ADD COLUMN notes TEXT']) { try { await run(m); } catch (e) { /* موجود */ } }
  await dedupe().catch(e => console.error('dedupe', e));
  const ph = process.env.ADMIN_PHONE || '01030602998', pw = process.env.ADMIN_PASSWORD || 'HODA';
  // نقل رقم الأدمن القديم للرقم الجديد (بنفس كلمة السر) لو الرقم الجديد مش مستخدم
  await run("UPDATE users SET phone=? WHERE phone='01284993980' AND role='admin' AND NOT EXISTS (SELECT 1 FROM users WHERE phone=?)", [ph, ph]);
  if (!(await one('SELECT 1 AS x FROM users WHERE phone=?', [ph]))) await run("INSERT OR IGNORE INTO users(name,phone,pass,role) VALUES('الأدمن',?,?,'admin')", [ph, hash(pw)]);
  if (!(await one('SELECT 1 AS x FROM products'))) await db.batch(require('../seed.json').map(p => ({ sql: 'INSERT OR IGNORE INTO products(name,section,gender,p10,p30,p50,p100,image) VALUES(?,?,?,?,?,?,?,?)', args: [p.name, p.section, p.gender, p.p10 || null, p.p30 || null, p.p50 || null, p.p100 || null, p.image || null] })), 'write');
  // صور العطور الجاهزة: بتتحط بس للعطور اللي لسه من غير صورة
  const withImg = require('../seed.json').filter(p => p.image);
  if (withImg.length) {
    const need = await q('SELECT name FROM products WHERE image IS NULL AND name IN (' + withImg.map(() => '?').join(',') + ')', withImg.map(p => p.name));
    for (const r of need) await run('UPDATE products SET image=? WHERE name=? AND image IS NULL', [withImg.find(p => p.name === r.name).image, r.name]);
  }
  if (!(await one('SELECT 1 AS x FROM bottles'))) await db.batch(require('../bottles.json').map(b => ({ sql: 'INSERT OR IGNORE INTO bottles(name,size,shape,descr,image,sort) VALUES(?,?,?,?,?,?)', args: [b.name, b.size, b.shape, b.descr, b.image || null, b.sort || 0] })), 'write');
  await run('DELETE FROM attempts WHERE t<?', [Date.now() - 6e5]);
})().catch(e => { ready = null; throw e; }));

const J = (res, code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...h }); res.end(JSON.stringify(o)); };
const who = async req => {
  const m = /(?:^|; )sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  return await one('SELECT u.id,u.name,u.phone,u.role,u.points FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', [m[1], Date.now()]);
};
const body = async req => {
  let b = req.body;
  if (b === undefined || b === null) b = await new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => ok(s)); req.on('error', no); });
  if (typeof b === 'string' || Buffer.isBuffer(b)) { b = String(b); return b ? JSON.parse(b) : {}; }
  return b;
};
const ip = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const limited = async k => (await one('SELECT COUNT(*) AS n FROM attempts WHERE k=? AND t>?', [k, Date.now() - 6e5])).n >= 8;
const fail = k => run('INSERT INTO attempts VALUES(?,?)', [k, Date.now()]);
const sess = async (req, uid) => {
  const t = crypto.randomBytes(24).toString('hex');
  await run('INSERT INTO sessions VALUES(?,?,?)', [t, uid, Date.now() + 30 * 864e5]);
  return { 'set-cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}` + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '') };
};
const plog = (id, d, n) => run('INSERT INTO plog(user_id,delta,note) VALUES(?,?,?)', [id, d, n]);

const R = [];
const on = (m, p, a, f) => R.push([m, new RegExp('^' + p + '$'), a, f]);

on('POST', '/api/signup', 0, async (req, res, b) => {
  const name = String(b.name || '').trim(), phone = String(b.phone || ''), pw = String(b.password || '');
  if (name.length < 2 || !PHONE.test(phone) || pw.length < 6) return J(res, 400, { error: 'راجع الاسم ورقم الموبايل وكلمة السر (6 حروف على الأقل)' });
  if (await one('SELECT 1 AS x FROM users WHERE phone=?', [phone])) return J(res, 409, { error: 'الرقم ده مسجّل قبل كده' });
  const r = await run('INSERT INTO users(name,phone,pass) VALUES(?,?,?)', [name, phone, hash(pw)]);
  J(res, 200, { ok: 1 }, await sess(req, Number(r.lastInsertRowid)));
});
on('POST', '/api/login', 0, async (req, res, b) => {
  const phone = String(b.phone || ''), k = ip(req) + phone;
  if (await limited(k)) return J(res, 429, { error: 'محاولات كتير، استنى شوية وجرّب تاني' });
  const u = await one('SELECT * FROM users WHERE phone=?', [phone]);
  if (!u || !verify(String(b.password || ''), u.pass)) { await fail(k); return J(res, 401, { error: 'الرقم أو كلمة السر غلط' }); }
  if (b.admin && u.role !== 'admin') { await fail(k); return J(res, 403, { error: 'مش مسموح' }); }
  J(res, 200, { ok: 1, role: u.role }, await sess(req, u.id));
});
on('POST', '/api/logout', 0, async (req, res) => {
  const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (m) await run('DELETE FROM sessions WHERE token=?', [m[1]]);
  J(res, 200, { ok: 1 }, { 'set-cookie': 'sid=; Max-Age=0; Path=/' });
});
on('GET', '/api/me', 0, async (req, res) => {
  const u = await who(req); if (!u) return J(res, 200, { user: null });
  J(res, 200, { user: u, orders: await q('SELECT code,total,status,created FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 20', [u.id]) });
});
on('GET', '/api/products', 0, async (req, res) => J(res, 200, await q('SELECT id,name,section,gender,cat,p10,p30,p50,p100,image IS NOT NULL AS img FROM products WHERE active=1 AND id IN (SELECT MIN(id) FROM products GROUP BY name,gender) ORDER BY id')));
on('GET', '/img/(\\d+)', 0, async (req, res, b, m) => {
  const r = await one('SELECT image FROM products WHERE id=?', [+m[1]]);
  const x = r && r.image && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.image);
  if (!x) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': x[1], 'cache-control': 'public,max-age=3600' }); res.end(Buffer.from(x[2], 'base64'));
});

on('POST', '/api/order', 0, async (req, res, b) => {
  const u = await who(req), name = String(b.name || '').trim(), phone = String(b.phone || ''), wa = String(b.wa || '');
  if (name.length < 2 || !PHONE.test(phone) || !PHONE.test(wa) || !b.gov || String(b.addr || '').trim().length < 5) return J(res, 400, { error: 'بيانات الطلب ناقصة أو غلط' });
  if (!['cod', 'wallet', 'insta'].includes(b.pay)) return J(res, 400, { error: 'اختار طريقة الدفع' });
  const items = []; let sub = 0;
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
    const n = Math.min(Math.max(+it.q | 0, 1), 20), s = [10, 30, 50, 100].includes(+it.size) ? +it.size : 0;
    if (it.mix) {
      const g = id => one("SELECT * FROM products WHERE id=? AND active=1 AND cat='perfume'", [+id]), A = await g(it.mix.a), B = await g(it.mix.b), r = [30, 50, 70].includes(+it.mix.r) ? +it.mix.r : 50;
      if (!A || !B || A.id === B.id || !s || !A['p' + s] || !B['p' + s]) return J(res, 400, { error: 'الميكس مش متاح' });
      const price = Math.round((A['p' + s] * r + B['p' + s] * (100 - r)) / 100);
      items.push({ name: 'ميكس: ' + A.name + ' ' + r + '% + ' + B.name + ' ' + (100 - r) + '%', size: s, q: n, price }); sub += price * n; continue;
    }
    const p = await one('SELECT * FROM products WHERE id=? AND active=1', [+it.id]), per = p && p.cat === 'perfume', k = per ? s : 10;
    if (!p || !p['p' + k] || (per && !s)) return J(res, 400, { error: 'منتج مش متاح: ' + (p ? p.name : '') });
    items.push({ name: p.name, size: per ? s : 0, q: n, price: p['p' + k] }); sub += p['p' + k] * n;
  }
  if (!items.length) return J(res, 400, { error: 'السلة فاضية' });
  let pts = 0, disc = 0, claimed = null;
  const undo = async () => { if (claimed) await run('UPDATE codes SET uses=uses+1 WHERE code=?', [claimed]); if (pts) await run('UPDATE users SET points=points+? WHERE id=?', [pts, u.id]); };
  if (u) {
    pts = Math.max(0, Math.min(+b.points | 0, u.points, sub)); disc = pts;
    if (b.code) {
      const cd = String(b.code).trim().toUpperCase(), c = await one('SELECT * FROM codes WHERE code=?', [cd]);
      if (!c || c.uses < 1 || (c.expires && c.expires < new Date().toISOString().slice(0, 10)) || (c.phone && c.phone !== u.phone)) return J(res, 400, { error: 'الكود مش صالح' });
      if ((await run('UPDATE codes SET uses=uses-1 WHERE code=? AND uses>0', [cd])).rowsAffected !== 1) return J(res, 400, { error: 'الكود مش صالح' });
      claimed = cd; disc += Math.min(c.value, sub - pts);
    }
    if (pts) {
      if ((await run('UPDATE users SET points=points-? WHERE id=? AND points>=?', [pts, u.id, pts])).rowsAffected !== 1) { const k = pts; pts = 0; await undo(); pts = k; return J(res, 400, { error: 'رصيد النقاط مش كفاية' }); }
    }
  } else if (b.points || b.code) return J(res, 401, { error: 'سجّل دخول علشان تستخدم النقاط والأكواد' });
  let code = null;
  for (let i = 0; i < 5 && !code; i++) {
    const c = 'ATH-' + (100000 + crypto.randomInt(900000));
    try { await run('INSERT INTO orders(code,user_id,name,phone,wa,gov,addr,items,subtotal,discount,pts,total,pay,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [c, u ? u.id : null, name, phone, wa, String(b.gov), String(b.addr).trim(), JSON.stringify(items), sub, disc, pts, sub - disc, b.pay, String(b.notes || '').slice(0, 300)]); code = c; } catch (e) { /* كود مكرر: جرّب تاني */ }
  }
  if (!code) { await undo(); return J(res, 500, { error: 'حصلت مشكلة، جرّب تاني' }); }
  if (pts) await plog(u.id, -pts, 'طلب ' + code);
  await notifyOwner(['🛒 طلب جديد ' + code, 'الاسم: ' + name, 'الموبايل: ' + phone, 'واتساب: ' + wa, 'المحافظة: ' + b.gov, 'العنوان: ' + String(b.addr).trim(), 'الدفع: ' + ({ cod: 'عند الاستلام', wallet: 'محفظة', insta: 'إنستا باي' })[b.pay], ...items.slice(0, 15).map(i => '- ' + i.name + (i.size ? ' (' + i.size + ' مل)' : '') + ' × ' + i.q + ' = ' + i.price * i.q), 'الإجمالي: ' + (sub - disc) + ' ج.م', ...(b.notes ? ['ملاحظات: ' + String(b.notes).slice(0, 150)] : [])].join('\n'));
  J(res, 200, { ok: 1, code, total: sub - disc });
});
on('POST', '/api/track', 0, async (req, res, b) => {
  const k = 'tr' + ip(req); if (await limited(k)) return J(res, 429, { error: 'محاولات كتير' }); await fail(k);
  const o = await one('SELECT code,status,total,created,items FROM orders WHERE code=? AND phone=?', [String(b.code || '').trim().toUpperCase(), String(b.phone || '')]);
  o ? J(res, 200, { ...o, items: JSON.parse(o.items) }) : J(res, 404, { error: 'مفيش طلب بالبيانات دي' });
});

on('GET', '/api/admin/orders', 1, async (req, res) => J(res, 200, (await q('SELECT * FROM orders ORDER BY id DESC LIMIT 500')).map(o => ({ ...o, items: JSON.parse(o.items) }))));
on('POST', '/api/admin/status', 1, async (req, res, b) => {
  const o = await one('SELECT * FROM orders WHERE id=?', [+b.id]);
  if (!o || !['new', 'confirmed', 'shipped', 'delivered', 'cancelled'].includes(b.status) || o.status === 'cancelled') return J(res, 400, { error: 'مش ممكن' });
  if ((await run("UPDATE orders SET status=? WHERE id=? AND status!='cancelled'", [b.status, o.id])).rowsAffected !== 1) return J(res, 400, { error: 'مش ممكن' });
  if (b.status === 'cancelled' && o.pts && o.user_id) { await run('UPDATE users SET points=points+? WHERE id=?', [o.pts, o.user_id]); await plog(o.user_id, o.pts, 'استرجاع إلغاء ' + o.code); }
  J(res, 200, { ok: 1 });
});
on('GET', '/api/admin/customers', 1, async (req, res) => J(res, 200, await q("SELECT u.id,u.name,u.phone,u.points,u.created,COUNT(o.id) AS orders FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.role='customer' GROUP BY u.id ORDER BY u.id DESC")));
on('POST', '/api/admin/points', 1, async (req, res, b) => {
  const u = await one("SELECT * FROM users WHERE phone=? AND role='customer'", [String(b.phone || '')]), d = +b.delta | 0;
  if (!u || !d || (await run('UPDATE users SET points=points+? WHERE id=? AND points+?>=0', [d, u.id, d])).rowsAffected !== 1) return J(res, 400, { error: 'العميل مش موجود أو الرقم غلط' });
  await plog(u.id, d, String(b.note || '').slice(0, 100)); J(res, 200, { ok: 1, points: u.points + d });
});
on('GET', '/api/admin/codes', 1, async (req, res) => J(res, 200, await q('SELECT * FROM codes ORDER BY rowid DESC')));
on('POST', '/api/admin/code', 1, async (req, res, b) => {
  const v = +b.value | 0, uses = Math.max(+b.uses | 0, 1); if (v < 1) return J(res, 400, { error: 'قيمة الخصم مطلوبة' });
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || crypto.randomBytes(3).toString('hex').toUpperCase();
  const exp = +b.days > 0 ? new Date(Date.now() + b.days * 864e5).toISOString().slice(0, 10) : null;
  try { await run('INSERT INTO codes VALUES(?,?,?,?,?,?)', [code, v, uses, exp, b.phone || null, String(b.label || '').slice(0, 60)]); } catch (e) { return J(res, 409, { error: 'الكود موجود' }); }
  J(res, 200, { ok: 1, code });
});
on('POST', '/api/admin/code-del', 1, async (req, res, b) => { await run('DELETE FROM codes WHERE code=?', [String(b.code)]); J(res, 200, { ok: 1 }); });
on('GET', '/api/admin/products', 1, async (req, res) => J(res, 200, await q('SELECT id,name,section,gender,cat,p10,p30,p50,p100,image IS NOT NULL AS img,active FROM products ORDER BY id DESC')));
on('POST', '/api/admin/product', 1, async (req, res, b) => {
  const n = x => (+x > 0 ? +x | 0 : null), name = String(b.name || '').trim();
  if (!name || !['designer', 'niche'].includes(b.section) || !['m', 'f', 'u'].includes(b.gender) || !['perfume', 'wood', 'print'].includes(b.cat)) return J(res, 400, { error: 'بيانات ناقصة' });
  const img = typeof b.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) ? b.image : null;
  try {
    if (b.id) { await run('UPDATE products SET name=?,section=?,gender=?,cat=?,p10=?,p30=?,p50=?,p100=?,active=? WHERE id=?', [name, b.section, b.gender, b.cat, n(b.p10), n(b.p30), n(b.p50), n(b.p100), b.active ? 1 : 0, +b.id]); if (img) await run('UPDATE products SET image=? WHERE id=?', [img, +b.id]); }
    else await run('INSERT INTO products(name,section,gender,cat,p10,p30,p50,p100,image) VALUES(?,?,?,?,?,?,?,?,?)', [name, b.section, b.gender, b.cat, n(b.p10), n(b.p30), n(b.p50), n(b.p100), img]);
  } catch (e) { return J(res, 409, { error: 'العطر ده موجود قبل كده بنفس الاسم والفئة' }); }
  J(res, 200, { ok: 1 });
});
on('POST', '/api/admin/product-del', 1, async (req, res, b) => { await run('DELETE FROM products WHERE id=?', [+b.id]); J(res, 200, { ok: 1 }); });
on('GET', '/api/admin/stats', 1, async (req, res, b, m, sp) => {
  const days = Math.min(Math.max(+sp.get('days') || 30, 1), 365), since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const os = await q('SELECT * FROM orders WHERE created>=?', [since]), ok = os.filter(o => o.status !== 'cancelled'), top = {}, daily = {};
  ok.forEach(o => { JSON.parse(o.items).forEach(i => { const k = i.name + (i.size ? ' ' + i.size + ' مل' : ''), t = top[k] || (top[k] = { name: k, qty: 0, sales: 0 }); t.qty += i.q; t.sales += i.q * i.price; }); const d = o.created.slice(0, 10); daily[d] = (daily[d] || 0) + o.total; });
  const sum = (a, f) => a.reduce((s, o) => s + f(o), 0);
  J(res, 200, { orders: os.length, sales: sum(ok, o => o.total), delivered: sum(ok.filter(o => o.status === 'delivered'), o => o.total), avg: ok.length ? Math.round(sum(ok, o => o.total) / ok.length) : 0, cancelled: os.length - ok.length, discounts: sum(ok, o => o.discount), daily, top: Object.values(top).sort((a, b) => b.qty - a.qty).slice(0, 10) });
});

const DEF = { wa: process.env.STORE_WA || '201030602998', phone: '01030602998', wallet: process.env.WALLET_NO || '01030602998', insta: process.env.INSTAPAY || '01224213116' };
const cfgAll = async () => { const m = Object.fromEntries((await q('SELECT k,v FROM settings')).map(r => [r.k, r.v])); return { wa: m.wa || DEF.wa, phone: m.phone || DEF.phone, wallet: m.wallet || DEF.wallet, insta: m.insta || DEF.insta }; };
on('GET', '/api/config', 0, async (req, res) => J(res, 200, await cfgAll()));

// ---------- إشعار واتساب بزنس (Meta Cloud API) لصاحب المتجر عند كل طلب ----------
const waCfg = async () => {
  const m = Object.fromEntries((await q("SELECT k,v FROM settings WHERE k IN ('notify_phone','wa_phone_id','wa_token','wa_template','wa_lang')")).map(r => [r.k, r.v]));
  return { id: m.wa_phone_id || process.env.WA_PHONE_NUMBER_ID || '', token: m.wa_token || process.env.WA_TOKEN || '', tpl: m.wa_template || process.env.WA_TEMPLATE || '', lang: m.wa_lang || process.env.WA_TEMPLATE_LANG || 'ar', to: String(m.notify_phone || process.env.NOTIFY_PHONE || DEF.wa).replace(/\D/g, ''), ver: process.env.WA_API_VERSION || 'v25.0' };
};
const notifyOwner = async text => {
  try {
    const c = await waCfg();
    if (!c.id || !c.token) return { sent: false, status: 0, info: 'بيانات واتساب بزنس لسه مش متسجلة' };
    const body = c.tpl
      ? { messaging_product: 'whatsapp', to: c.to, type: 'template', template: { name: c.tpl, language: { code: c.lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n\s*/g, ' | ').replace(/ {2,}/g, ' ').slice(0, 900) }] }] } }
      : { messaging_product: 'whatsapp', to: c.to, type: 'text', text: { body: text.slice(0, 3500) } };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4500);
    try {
      const r = await fetch('https://graph.facebook.com/' + c.ver + '/' + c.id + '/messages', { method: 'POST', headers: { authorization: 'Bearer ' + c.token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const j = await r.json().catch(() => ({})), e = j.error || {};
      let info = r.ok ? 'اتبعتت' : (e.message || 'فشل الإرسال') + (e.code ? ' (#' + e.code + ')' : '');
      if (e.code === 131047) info += ' — فات أكتر من 24 ساعة من آخر رسالة منك لرقم المتجر. استخدم قالب (Template) معتمد أو ابعت أي رسالة لرقم المتجر الأول.';
      if (e.code === 190) info += ' — التوكن منتهي أو غلط.';
      return { sent: r.ok, status: r.status, info };
    } finally { clearTimeout(t); }
  } catch (e) { console.error('notify', e); return { sent: false, status: 0, info: 'تعذّر الاتصال بخدمة واتساب' }; }
};


on('POST', '/api/admin/password', 1, async (req, res, b) => {
  const u = await who(req), r = await one('SELECT pass FROM users WHERE id=?', [u.id]), k = 'pw' + u.id;
  if (await limited(k)) return J(res, 429, { error: 'محاولات كتير، استنى شوية' });
  if (!verify(String(b.old || ''), r.pass)) { await fail(k); return J(res, 400, { error: 'كلمة السر الحالية غلط' }); }
  const n = String(b.new || ''); if (n.length < 10) return J(res, 400, { error: 'كلمة السر الجديدة لازم تكون 10 حروف على الأقل' });
  await run('UPDATE users SET pass=? WHERE id=?', [hash(n), u.id]); await run('DELETE FROM sessions WHERE user_id=?', [u.id]);
  J(res, 200, { ok: 1 }, await sess(req, u.id));
});

// ---------- إدارة الموقع من لوحة الأدمن ----------
on('GET', '/api/admin/settings', 1, async (req, res) => {
  const c = await waCfg();
  J(res, 200, { ...(await cfgAll()), notify_phone: c.to, wa_phone_id: c.id, wa_template: c.tpl, wa_lang: c.lang, wa_token_set: !!c.token });
});
on('POST', '/api/admin/settings', 1, async (req, res, b) => {
  const d = x => String(x || '').replace(/\D/g, '').slice(0, 20), t = x => String(x || '').trim().slice(0, 60), v = { wa: d(b.wa), phone: d(b.phone), wallet: t(b.wallet), insta: t(b.insta) };
  for (const [k, val] of Object.entries(v)) await run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, val]);
  const dg = x => String(x || '').replace(/\D/g, '').slice(0, 30), up = (k, val) => run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, val]);
  if (b.notify_phone !== undefined) await up('notify_phone', dg(b.notify_phone));
  if (b.wa_phone_id !== undefined) await up('wa_phone_id', dg(b.wa_phone_id));
  if (b.wa_template !== undefined) await up('wa_template', String(b.wa_template).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 60));
  if (b.wa_lang !== undefined) await up('wa_lang', /^[a-z]{2}(_[A-Z]{2})?$/.test(String(b.wa_lang).trim()) ? String(b.wa_lang).trim() : 'ar');
  if (String(b.wa_token || '').trim()) await up('wa_token', String(b.wa_token).trim().slice(0, 600));
  J(res, 200, { ok: 1, ...(await cfgAll()) });
});
on('POST', '/api/admin/notify-test', 1, async (req, res) => J(res, 200, await notifyOwner('✅ رسالة تجربة من متجر MA Professional Perfume. لو وصلتك يبقى إشعارات الطلبات شغالة.')));
on('POST', '/api/admin/product-quick', 1, async (req, res, b) => {
  const n = x => (+x > 0 ? +x | 0 : null);
  await run('UPDATE products SET p10=?,p30=?,p50=?,p100=?,active=? WHERE id=?', [n(b.p10), n(b.p30), n(b.p50), n(b.p100), b.active ? 1 : 0, +b.id]); J(res, 200, { ok: 1 });
});
on('POST', '/api/admin/product-image', 1, async (req, res, b) => {
  if (b.remove) { await run('UPDATE products SET image=NULL WHERE id=?', [+b.id]); return J(res, 200, { ok: 1 }); }
  const img = typeof b.image === 'string' && b.image.length < 7e5 && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) ? b.image : null;
  if (!img) return J(res, 400, { error: 'الصورة مش صالحة أو حجمها كبير' });
  await run('UPDATE products SET image=? WHERE id=?', [img, +b.id]); J(res, 200, { ok: 1 });
});
on('POST', '/api/admin/prices-bulk', 1, async (req, res, b) => {
  if (!['designer', 'niche'].includes(b.section)) return J(res, 400, { error: 'اختار القسم' });
  const n = x => (+x > 0 ? +x | 0 : null), cols = ['p10', 'p30', 'p50', 'p100'].filter(k => n(b[k]));
  if (!cols.length) return J(res, 400, { error: 'اكتب سعر واحد على الأقل' });
  const r = await run('UPDATE products SET ' + cols.map(k => k + '=?').join(',') + " WHERE section=? AND cat='perfume'", [...cols.map(k => n(b[k])), b.section]);
  J(res, 200, { ok: 1, count: r.rowsAffected });
});
on('GET', '/api/admin/customer', 1, async (req, res, b, m, sp) => {
  const u = await one("SELECT id,name,phone,points,created FROM users WHERE id=? AND role='customer'", [+sp.get('id')]);
  if (!u) return J(res, 404, { error: 'العميل مش موجود' });
  J(res, 200, { user: u, log: await q('SELECT delta,note,created FROM plog WHERE user_id=? ORDER BY id DESC LIMIT 50', [u.id]), orders: await q('SELECT code,total,status,created FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 20', [u.id]) });
});
on('GET', '/api/admin/plog', 1, async (req, res) => J(res, 200, await q('SELECT l.delta,l.note,l.created,u.name,u.phone FROM plog l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 40')));
on('POST', '/api/admin/points-all', 1, async (req, res, b) => {
  const d = +b.delta | 0; if (!d) return J(res, 400, { error: 'اكتب عدد النقاط' });
  const us = await q("SELECT id FROM users WHERE role='customer' AND points+?>=0 LIMIT 1000", [d]), note = String(b.note || '').slice(0, 100);
  if (!us.length) return J(res, 400, { error: 'مفيش عملاء' });
  await db.batch(us.flatMap(u => [{ sql: 'UPDATE users SET points=points+? WHERE id=?', args: [d, u.id] }, { sql: 'INSERT INTO plog(user_id,delta,note) VALUES(?,?,?)', args: [u.id, d, note] }]), 'write');
  J(res, 200, { ok: 1, count: us.length });
});

// ---------- الزجاجات ----------
on('GET', '/api/bottles', 0, async (req, res) => J(res, 200, await q('SELECT id,name,size,shape,descr,image IS NOT NULL AS img FROM bottles WHERE active=1 ORDER BY sort,id')));
on('GET', '/bimg/(\\d+)', 0, async (req, res, b, m) => {
  const r = await one('SELECT image FROM bottles WHERE id=?', [+m[1]]);
  const x = r && r.image && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.image);
  if (!x) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': x[1], 'cache-control': 'public,max-age=600' }); res.end(Buffer.from(x[2], 'base64'));
});
on('GET', '/api/admin/bottles', 1, async (req, res) => J(res, 200, await q('SELECT id,name,size,shape,descr,sort,active,image IS NOT NULL AS img FROM bottles ORDER BY sort,id')));
on('POST', '/api/admin/bottle', 1, async (req, res, b) => {
  const name = String(b.name || '').trim().slice(0, 80); if (!name) return J(res, 400, { error: 'اكتب اسم الزجاجة' });
  const f = [name, String(b.size || '').replace(/[^\d ./]/g, '').slice(0, 20), String(b.shape || '').trim().slice(0, 120), String(b.descr || '').trim().slice(0, 400), +b.sort | 0, b.active ? 1 : 0];
  const img = typeof b.image === 'string' && b.image.length < 7e5 && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) ? b.image : null;
  try {
    if (b.id) { await run('UPDATE bottles SET name=?,size=?,shape=?,descr=?,sort=?,active=? WHERE id=?', [...f, +b.id]); if (img) await run('UPDATE bottles SET image=? WHERE id=?', [img, +b.id]); }
    else await run('INSERT INTO bottles(name,size,shape,descr,sort,active,image) VALUES(?,?,?,?,?,?,?)', [...f, img]);
  } catch (e) { return J(res, 409, { error: 'فيه زجاجة بنفس الاسم' }); }
  J(res, 200, { ok: 1 });
});
on('POST', '/api/admin/bottle-del', 1, async (req, res, b) => { await run('DELETE FROM bottles WHERE id=?', [+b.id]); J(res, 200, { ok: 1 }); });

on('GET', '/api/version', 0, async (req, res) => J(res, 200, { v: VERSION }));
on('POST', '/api/admin/dedupe', 1, async (req, res) => {
  try { J(res, 200, { ok: 1, ...(await dedupe()) }); } catch (e) { console.error('dedupe', e); J(res, 500, { error: 'فشل التنظيف: ' + String(e.message || e).slice(0, 160) }); }
});

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x'), pth = url.searchParams.get('r') || url.pathname;
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'same-origin');
  try {
    if (!process.env.TURSO_DATABASE_URL) return J(res, 500, { error: 'متغير TURSO_DATABASE_URL مش متضبط' });
    await init();
    for (const [m, re, adm, f] of R) {
      const mm = m === req.method && re.exec(pth); if (!mm) continue;
      if (adm) { const u = await who(req); if (!u || u.role !== 'admin') return J(res, 401, { error: 'مش مسموح' }); }
      let b = {};
      if (m === 'POST') { if (!/application\/json/.test(req.headers['content-type'] || '')) return J(res, 415, { error: 'bad type' }); b = await body(req); }
      return await f(req, res, b, mm, url.searchParams);
    }
    J(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); if (!res.headersSent) J(res, 500, { error: 'خطأ في السيرفر' }); }
};
