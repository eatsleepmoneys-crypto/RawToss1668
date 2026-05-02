/**
 * TigerLotto â Full Backend Server
 * Node.js 20 + Express 4 + MySQL 8
 *
 * Routes:
 *   POST   /api/v1/auth/register
 *   POST   /api/v1/auth/login
 *   POST   /api/v1/auth/otp/send
 *   POST   /api/v1/auth/otp/verify
 *   GET    /api/v1/me
 *   PUT    /api/v1/me
 *   PUT    /api/v1/me/password
 *   GET    /api/v1/me/kyc
 *   POST   /api/v1/me/kyc            (multipart/form-data)
 *   GET    /api/v1/me/banks
 *   POST   /api/v1/me/banks
 *   PUT    /api/v1/me/banks/:id/default
 *   DELETE /api/v1/me/banks/:id
 *   GET    /api/v1/wallet
 *   POST   /api/v1/wallet/deposit
 *   POST   /api/v1/wallet/withdraw
 *   GET    /api/v1/wallet/transactions
 *   GET    /api/v1/lottery/types
 *   GET    /api/v1/lottery/rounds
 *   GET    /api/v1/lottery/rounds/:id
 *   GET    /api/v1/lottery/rounds/:id/result
 *   GET    /api/v1/lottery/bet-types
 *   GET    /api/v1/lottery/results
 *   GET    /api/v1/slips
 *   GET    /api/v1/slips/:id
 *   POST   /api/v1/slips
 *   DELETE /api/v1/slips/:id
 *   GET    /api/v1/notifications
 *   PUT    /api/v1/notifications/:id/read
 *   PUT    /api/v1/notifications/read-all
 *   GET    /api/v1/promotions
 *   POST   /api/v1/promotions/:id/claim
 *   GET    /api/v1/agent/dashboard
 *   GET    /api/v1/agent/members
 *   GET    /api/v1/agent/sub-agents
 *   GET    /api/v1/agent/commissions
 *   POST   /api/v1/agent/withdraw-commission
 *   GET    /api/v1/agent/referral-link
 *   GET    /api/v1/admin/dashboard
 *   GET    /api/v1/admin/users
 *   PUT    /api/v1/admin/users/:id/status
 *   GET    /api/v1/admin/transactions
 *   PUT    /api/v1/admin/transactions/:id/approve
 *   POST   /api/v1/admin/lottery/rounds/:id/result
 *   GET    /api/v1/admin/kyc
 *   PUT    /api/v1/admin/kyc/:id/approve
 *   PUT    /api/v1/admin/kyc/:id/reject
 *   GET    /api/v1/admin/hot-numbers
 *   GET    /api/v1/admin/settings
 *   PUT    /api/v1/admin/settings/:key
 *   GET    /api/v1/admin/reports/monthly
 *   GET    /health
 */

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const path        = require('path');
const http        = require('http');
const { Server }  = require('socket.io');
const fs          = require('fs');

// Prevent unhandled rejections from crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);
});

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://courageous-fairy-114078.netlify.app',
  'https://rawtoss1668-production.up.railway.app',
  'https://rawtoss1668.pages.dev',
  'https://rawtoss1668.com',
  'https://www.rawtoss1668.com',
  'http://localhost:3000',
  'http://localhost:5173',
];
const corsOriginFn = (origin, callback) => {
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.includes(origin) || /\.netlify\.app$/.test(origin) || /\.pages\.dev$/.test(origin)) {
    return callback(null, true);
  }
  callback(new Error('Not allowed by CORS'));
};

const io     = new Server(server, {
  cors: { origin: corsOriginFn, credentials: true },
  transports: ['websocket', 'polling'],
});
global.io = io;

// ââ Middleware ââââââââââââââââââââââââââââââââââââââââââââââââ
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: corsOriginFn, credentials: true }));
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

const logDir = path.join(__dirname, '../logs');
fs.mkdirSync(logDir, { recursive: true });
app.use(morgan('combined', {
  stream: fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' }),
}));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/auth/', rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'RATE_LIMIT', message: 'à¸ªà¹à¸à¸à¸³à¸à¸­à¸à¸µà¹à¹à¸à¸´à¸à¹à¸' } }));

// Static
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, '../frontend')));

// ââ Import Controllers âââââââââââââââââââââââââââââââââââââââââ
const authCtrl   = require('./controllers/authController');
const walletCtrl = require('./controllers/walletController');
const slipCtrl   = require('./controllers/slipController');
const resultCtrl = require('./controllers/resultController');
const agentCtrl  = require('./controllers/agentController');
const kycCtrl    = require('./controllers/kycController');
const bankCtrl   = require('./controllers/bankController');
const { auth, adminOnly, agentOnly } = require('./middleware/auth');
const { query, queryOne } = require('./config/db');

// ââ V1 Router âââââââââââââââââââââââââââââââââââââââââââââââââ
const v1 = express.Router();

/* AUTH */
v1.post('/auth/register',   authCtrl.register);
v1.post('/auth/login',      authCtrl.login);
v1.post('/auth/otp/send',   authCtrl.sendOTP);
v1.post('/auth/otp/verify', authCtrl.verifyOTP);

/* ADMIN SETUP â à¸ªà¸£à¹à¸²à¸ Admin Account (à¹à¸à¹ ADMIN_SETUP_KEY à¸à¸µà¹à¸à¸³à¸«à¸à¸à¹à¸ env) */
v1.post('/auth/setup-admin', async (req, res) => {
  try {
    const { setup_key, phone, password, first_name, last_name } = req.body;
    const expectedKey = process.env.ADMIN_SETUP_KEY;
    if (!expectedKey || setup_key !== expectedKey)
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid setup key' });
    if (!phone || !password || !first_name || !last_name)
      return res.status(422).json({ error: 'VALIDATION', message: 'à¸à¹à¸­à¸¡à¸¹à¸¥à¹à¸¡à¹à¸à¸£à¸' });
    const { v4: uuidv4 } = require('uuid');
    const bcrypt = require('bcryptjs');
    const jwt = require('jsonwebtoken');
    const exists = await queryOne('SELECT id FROM users WHERE phone=?', [phone]);
    if (exists) {
      // Update existing user to admin
      await query("UPDATE users SET role='superadmin', password_hash=? WHERE phone=?", [await bcrypt.hash(password, 12), phone]);
      const user = await queryOne('SELECT id,uuid,phone,first_name,last_name,role FROM users WHERE phone=?', [phone]);
      const token = jwt.sign({ id: user.id, uuid: user.uuid, role: user.role, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({ message: 'à¸­à¸±à¸à¹à¸à¸ superadmin à¸ªà¸³à¹à¸£à¹à¸', token, user });
    }
    const hash = await bcrypt.hash(password, 12);
    const uuid = uuidv4();
    const refCode = 'ADMIN-' + Math.random().toString(36).substr(2,6).toUpperCase();
    const [row] = await query(
      `INSERT INTO users (uuid,phone,password_hash,first_name,last_name,referral_code,role,vip_tier,is_verified) VALUES (?,?,?,?,?,?,'superadmin','diamond',1)`,
      [uuid, phone, hash, first_name, last_name, refCode]
    );
    await query('INSERT INTO wallets (user_id,balance) VALUES (?,0)', [row.insertId]);
    const user = await queryOne('SELECT id,uuid,phone,first_name,last_name,role FROM users WHERE id=?', [row.insertId]);
    const token = jwt.sign({ id: user.id, uuid: user.uuid, role: user.role, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'à¸ªà¸£à¹à¸²à¸ superadmin à¸ªà¸³à¹à¸£à¹à¸', token, user });
  } catch (err) {
    console.error('setup-admin error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/* ME */
v1.get('/me',               auth, async (req,res) => {
  const user = await queryOne(
    'SELECT id,uuid,phone,email,first_name,last_name,role,vip_tier,vip_points,referral_code,is_verified,last_login_at,created_at FROM users WHERE id=?',
    [req.user.id]
  );
  res.json(user);
});
v1.put('/me',               auth, async (req,res) => {
  const { first_name, last_name, email, display_name } = req.body;
  await query('UPDATE users SET first_name=?,last_name=?,email=?,display_name=? WHERE id=?',
    [first_name, last_name, email, display_name, req.user.id]);
  res.json({ success: true });
});
v1.put('/me/password',      auth, async (req,res) => {
  const bcrypt = require('bcryptjs');
  const { old_password, new_password } = req.body;
  if (!new_password || new_password.length < 8)
    return res.status(422).json({ error: 'VALIDATION', message: 'à¸£à¸«à¸±à¸ªà¸à¹à¸²à¸à¹à¸«à¸¡à¹à¸à¹à¸­à¸à¸¡à¸µà¸­à¸¢à¹à¸²à¸à¸à¹à¸­à¸¢ 8 à¸à¸±à¸§' });
  const user = await queryOne('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!await bcrypt.compare(old_password, user.password_hash))
    return res.status(422).json({ error: 'WRONG_PASSWORD', message: 'à¸£à¸«à¸±à¸ªà¸à¹à¸²à¸à¹à¸à¸´à¸¡à¹à¸¡à¹à¸à¸¹à¸à¸à¹à¸­à¸' });
  await query('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(new_password, 12), req.user.id]);
  res.json({ success: true });
});

/* KYC */
v1.get('/me/kyc',           auth, kycCtrl.getKYCStatus);
v1.post('/me/kyc',          auth, kycCtrl.upload.fields([
  { name: 'id_card_image', maxCount: 1 },
  { name: 'selfie_image',  maxCount: 1 },
]), kycCtrl.submitKYC);

/* BANK ACCOUNTS */
v1.get('/me/banks',              auth, bankCtrl.list);
v1.post('/me/banks',             auth, bankCtrl.add);
v1.put('/me/banks/:id/default',  auth, bankCtrl.setDefault);
v1.delete('/me/banks/:id',       auth, bankCtrl.remove);

/* WALLET */
v1.get('/wallet',                auth, walletCtrl.getWallet);
v1.post('/wallet/deposit',       auth, walletCtrl.deposit);
v1.post('/wallet/withdraw',      auth, walletCtrl.withdraw);
v1.get('/wallet/transactions',   auth, walletCtrl.getTransactions);

/* LOTTERY */
v1.get('/lottery/types', async (req,res) => {
  const all = req.query.all === '1';
  const where = all ? '' : 'WHERE is_active=1';
  res.json({ data: await query(`SELECT * FROM lottery_types ${where} ORDER BY sort_order`) });
});
// Public: bank account info for deposit form
v1.get('/settings/bank', async (req,res) => {
  const keys = ['bank_name','bank_account_number','bank_account_name','bank_code','deposit_qr_url','min_deposit','max_deposit'];
  const rows = await query(
    `SELECT setting_key, value FROM system_settings WHERE setting_key IN (${keys.map(()=>'?').join(',')})`,
    keys
  );
  const data = {};
  rows.forEach(r => { data[r.setting_key] = r.value; });
  // defaults if not configured
  res.json({
    bank_name:           data.bank_name           || 'ขอให้ Admin ตั้งค่าธนาคาร',
    bank_account_number: data.bank_account_number || '-',
    bank_account_name:   data.bank_account_name   || '-',
    bank_code:           data.bank_code           || '',
    deposit_qr_url:      data.deposit_qr_url      || '',
    min_deposit:         parseFloat(data.min_deposit  || 50),
    max_deposit:         parseFloat(data.max_deposit  || 100000),
  });
});
v1.get('/lottery/rounds', async (req,res) => {
  const { lottery_type, lottery_type_id, status = 'open' } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 90);
  let sql = `SELECT r.*, lt.name, lt.code, lt.icon FROM lottery_rounds r JOIN lottery_types lt ON r.lottery_type_id=lt.id WHERE r.status=?`;
  const params = [status];
  if (lottery_type_id) { sql += ' AND r.lottery_type_id=?'; params.push(parseInt(lottery_type_id)); }
  else if (lottery_type) { sql += ' AND LOWER(lt.code)=LOWER(?)'; params.push(lottery_type); }
  sql += ` ORDER BY r.close_at ASC LIMIT ${limit}`;
  try {
    res.json({ data: await query(sql, params) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
v1.get('/lottery/rounds/:id', async (req,res) => {
  const row = await queryOne(
    'SELECT r.*,lt.name,lt.icon FROM lottery_rounds r JOIN lottery_types lt ON r.lottery_type_id=lt.id WHERE r.id=?',
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(row);
});
v1.get('/lottery/rounds/:id/result', async (req,res) => {
  const row = await queryOne('SELECT * FROM lottery_results WHERE round_id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND', message: 'à¸¢à¸±à¸à¹à¸¡à¹à¸¡à¸µà¸à¸¥' });
  res.json(row);
});
v1.get('/lottery/bet-types', async (req,res) => {
  const { lottery_type_id } = req.query;
  let sql = 'SELECT * FROM bet_types WHERE is_active=1';
  const params = [];
  if (lottery_type_id) { sql += ' AND lottery_type_id=?'; params.push(lottery_type_id); }
  res.json({ data: await query(sql, params) });
});
v1.get('/lottery/results', async (req,res) => {
  const { lottery_type, page = 1, limit = 10 } = req.query;
  const offset = (parseInt(page)-1)*parseInt(limit);
  let sql = `SELECT lr.*,r.round_code,lt.name AS lottery_name FROM lottery_results lr
    JOIN lottery_rounds r ON lr.round_id=r.id JOIN lottery_types lt ON r.lottery_type_id=lt.id WHERE 1=1`;
  const params = [];
  if (lottery_type) { sql += ' AND lt.code=?'; params.push(lottery_type); }
  sql += ` ORDER BY lr.created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
  res.json({ data: await query(sql, params) });
});

/* LOTTERY RESULTS HISTORY */
v1.get('/lottery/results/history', async (req, res) => {
  const { lottery_type_id, date, page = 1, limit = 30 } = req.query;
  const pageNum   = Math.max(1, parseInt(page) || 1);
  const limitNum  = Math.min(100, Math.max(1, parseInt(limit) || 30));
  const offset    = (pageNum - 1) * limitNum;
  const dateStr   = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : new Date().toISOString().slice(0, 10);

  let sql = `
    SELECT r.id AS round_id, r.round_code, r.round_name, r.close_at, r.result_at, r.status,
           lt.id AS lottery_type_id, lt.name AS lottery_name, lt.code AS lottery_code, lt.icon AS lottery_icon,
           res.id AS result_id, res.result_first, res.result_2_back,
           res.result_3_back1, res.result_3_back2, res.result_3_front1, res.result_3_front2,
           res.entered_at
    FROM lottery_rounds r
    JOIN lottery_types lt ON r.lottery_type_id = lt.id
    LEFT JOIN lottery_results res ON res.round_id = r.id
    WHERE r.status IN ('resulted','closed')
      AND DATE(r.close_at) = ?`;
  const params = [dateStr];
  if (lottery_type_id) { sql += ' AND r.lottery_type_id = ?'; params.push(parseInt(lottery_type_id)); }
  sql += ` ORDER BY r.close_at DESC LIMIT ${limitNum} OFFSET ${offset}`;
  try {
    const data = await query(sql, params);
    res.json({ data, date: dateStr, page: pageNum });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

/* SLIPS */
v1.get('/slips',             auth, slipCtrl.getSlips);
v1.get('/slips/:id',         auth, slipCtrl.getSlip);
v1.post('/slips',            auth, slipCtrl.createSlip);
v1.delete('/slips/:id',      auth, slipCtrl.cancelSlip);

/* NOTIFICATIONS */
v1.get('/notifications',            auth, async (req,res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  let sql = 'SELECT * FROM notifications WHERE user_id=?';
  const params = [req.user.id];
  const is_read = req.query.is_read;
  if (is_read !== undefined && is_read !== '') { sql += ' AND is_read=?'; params.push(is_read === '1' ? 1 : 0); }
  sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const [data, unread] = await Promise.all([
    query(sql, params),
    queryOne('SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0',[req.user.id]),
  ]);
  res.json({ data, unread_count: unread.c });
});
v1.put('/notifications/read-all',   auth, async (req,res) => {
  await query('UPDATE notifications SET is_read=1,read_at=NOW() WHERE user_id=?',[req.user.id]);
  res.json({ success:true });
});
v1.put('/notifications/:id/read',   auth, async (req,res) => {
  await query('UPDATE notifications SET is_read=1,read_at=NOW() WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  res.json({ success:true });
});

/* PROMOTIONS */
v1.get('/promotions', async (req,res) => {
  res.json({ data: await query('SELECT * FROM promotions WHERE is_active=1 ORDER BY is_featured DESC') });
});
v1.post('/promotions/:id/claim', auth, async (req,res) => {
  const promo = await queryOne('SELECT * FROM promotions WHERE id=? AND is_active=1',[req.params.id]);
  if (!promo) return res.status(404).json({ error:'NOT_FOUND' });
  const already = await queryOne('SELECT id FROM user_promotions WHERE user_id=? AND promotion_id=?',[req.user.id,req.params.id]);
  if (already) return res.status(409).json({ error:'ALREADY_CLAIMED' });
  const amount = parseFloat(promo.max_amount||0);
  await query('INSERT INTO user_promotions (user_id,promotion_id,amount_received) VALUES (?,?,?)',[req.user.id,req.params.id,amount]);
  if (amount>0) await query('UPDATE wallets SET balance=balance+?,bonus_balance=bonus_balance+? WHERE user_id=?',[amount,amount,req.user.id]);
  res.json({ success:true, amount_received:amount });
});

/* AGENT */
v1.get('/agent/dashboard',          auth, agentOnly, agentCtrl.getDashboard);
v1.get('/agent/members',            auth, agentOnly, agentCtrl.getMembers);
v1.get('/agent/sub-agents',         auth, agentOnly, agentCtrl.getSubAgents);
v1.get('/agent/commissions',        auth, agentOnly, agentCtrl.getCommissions);
v1.post('/agent/withdraw-commission',auth, agentOnly, agentCtrl.withdrawCommission);
v1.get('/agent/referral-link',      auth, agentOnly, agentCtrl.getReferralLink);

/* ADMIN */
v1.get('/admin/dashboard', auth, adminOnly, async (req,res) => {
  const [members,active,withdraw,revenue,pending_kyc] = await Promise.all([
    queryOne('SELECT COUNT(*) AS c FROM users WHERE role="member"'),
    queryOne('SELECT COUNT(*) AS c FROM users WHERE DATE(last_login_at)=CURDATE()'),
    queryOne('SELECT SUM(amount) AS t FROM transactions WHERE type="withdraw" AND status="pending"'),
    queryOne('SELECT SUM(amount) AS t FROM transactions WHERE type="bet" AND DATE(created_at)=CURDATE()'),
    queryOne('SELECT COUNT(*) AS c FROM user_kyc WHERE status="pending"'),
  ]);
  res.json({ total_members:members.c, active_today:active.c, pending_withdraw:withdraw.t||0, revenue_today:revenue.t||0, pending_kyc:pending_kyc.c });
});
v1.get('/admin/users', auth, adminOnly, async (req,res) => {
  const { page=1, limit=50, role, is_active } = req.query;
  const offset = (parseInt(page)-1)*parseInt(limit);
  let sql = 'SELECT id,phone,first_name,last_name,role,vip_tier,is_active,is_verified,created_at FROM users WHERE 1=1';
  const params = [];
  if (role) { sql+=' AND role=?'; params.push(role); }
  if (is_active!==undefined) { sql+=' AND is_active=?'; params.push(is_active); }
  sql+=` ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
  res.json({ data: await query(sql,params) });
});
v1.put('/admin/users/:id/status', auth, adminOnly, async (req,res) => {
  const { is_active, is_banned } = req.body;
  await query('UPDATE users SET is_active=?,is_banned=? WHERE id=?',[is_active,is_banned,req.params.id]);
  res.json({ success:true });
});
v1.get('/admin/transactions', auth, adminOnly, async (req,res) => {
  const { type, status, page=1, limit=50 } = req.query;
  const offset=(parseInt(page)-1)*parseInt(limit);
  let sql = `SELECT t.*,u.first_name,u.last_name,u.phone FROM transactions t JOIN users u ON t.user_id=u.id WHERE 1=1`;
  const params=[];
  if (type) { sql+=' AND t.type=?'; params.push(type); }
  if (status) { sql+=' AND t.status=?'; params.push(status); }
  sql+=` ORDER BY t.created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
  res.json({ data: await query(sql,params) });
});
v1.put('/admin/transactions/:id/approve', auth, adminOnly, async (req,res) => {
  const tx = await queryOne("SELECT * FROM transactions WHERE id=? AND status='pending' AND type IN ('withdraw','deposit')",[req.params.id]);
  if (!tx) return res.status(404).json({ error:'NOT_FOUND', message:'ไม่พบรายการหรืออัพเดทไม่ได้' });
  if (tx.type === 'withdraw') {
    await query("UPDATE transactions SET status='success',processed_by=?,processed_at=NOW() WHERE id=?",[req.user.id,req.params.id]);
    await query('UPDATE wallets SET locked_balance=locked_balance-? WHERE user_id=?',[tx.amount,tx.user_id]);
  } else {
    // deposit: call approveDeposit to add balance
    const walletCtrl = require('./controllers/walletController');
    await walletCtrl.approveDeposit(tx.id, tx.user_id, tx.amount);
  }
  res.json({ success:true });
});
v1.put('/admin/transactions/:id/reject', auth, adminOnly, async (req,res) => {
  const tx = await queryOne("SELECT * FROM transactions WHERE id=? AND status='pending'",[req.params.id]);
  if (!tx) return res.status(404).json({ error:'NOT_FOUND' });
  const note = req.body.note || 'ถูกปฏิเสธ';
  if (tx.type === 'withdraw') {
    // คืนเงินกลับ
    await query(
      "UPDATE transactions SET status='rejected',processed_by=?,processed_at=NOW(),note=? WHERE id=?",
      [req.user.id, note, req.params.id]
    );
    await query(
      'UPDATE wallets SET balance=balance+?,locked_balance=locked_balance-?,total_withdraw=total_withdraw-? WHERE user_id=?',
      [tx.amount, tx.amount, tx.amount, tx.user_id]
    );
  } else {
    await query(
      "UPDATE transactions SET status='rejected',processed_by=?,processed_at=NOW(),note=? WHERE id=?",
      [req.user.id, note, req.params.id]
    );
  }
  res.json({ success:true });
});
v1.get('/admin/transactions/:id/slip', auth, adminOnly, async (req,res) => {
  const tx = await queryOne('SELECT slip_image FROM transactions WHERE id=?', [req.params.id]);
  if (!tx || !tx.slip_image) return res.status(404).json({ error:'NOT_FOUND', message:'ไม่พบสลิป' });
  const img = tx.slip_image;
  // If stored as base64 data URL (data:image/jpeg;base64,...)
  const dataUrlMatch = img.match(/^data:(image\/\w+);base64,(.+)$/);
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1];
    const buf = Buffer.from(dataUrlMatch[2], 'base64');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  }
  // If stored as file path, serve redirect
  res.redirect(img);
});
/* ADMIN ROUND MANAGEMENT */
v1.get('/admin/lottery/rounds', auth, adminOnly, async (req, res) => {
  const { status, lottery_type_id, limit = 50 } = req.query;
  let sql = `SELECT r.*, lt.name AS lottery_name, lt.icon AS lottery_icon, lt.code AS lottery_code
    FROM lottery_rounds r JOIN lottery_types lt ON r.lottery_type_id=lt.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND r.status=?'; params.push(status); }
  if (lottery_type_id) { sql += ' AND r.lottery_type_id=?'; params.push(lottery_type_id); }
  sql += ` ORDER BY r.close_at DESC LIMIT ${parseInt(limit)}`;
  res.json({ data: await query(sql, params) });
});
v1.post('/admin/lottery/rounds', auth, adminOnly, async (req, res) => {
  const { lottery_type_id, round_code, round_name, open_at, close_at } = req.body;
  if (!lottery_type_id || !round_code || !open_at || !close_at)
    return res.status(422).json({ error:'VALIDATION', message:'กรุณาระบุข้อมูลให้ครบ' });
  const existing = await queryOne('SELECT id FROM lottery_rounds WHERE round_code=?', [round_code]);
  if (existing) return res.status(409).json({ error:'DUPLICATE', message:'รหัสงวดนี้มีอยู่แล้ว' });
  await query(
    `INSERT INTO lottery_rounds (lottery_type_id,round_code,round_name,open_at,close_at,status,created_by)
     VALUES (?,?,?,?,?,'open',?)`,
    [lottery_type_id, round_code, round_name||round_code, open_at, close_at, req.user.id]
  );
  res.json({ success:true, message:'สร้างงวดแล้ว' });
});
v1.put('/admin/lottery/rounds/:id/close', auth, adminOnly, async (req, res) => {
  const round = await queryOne('SELECT id,status FROM lottery_rounds WHERE id=?', [req.params.id]);
  if (!round) return res.status(404).json({ error:'NOT_FOUND', message:'ไม่พบงวด' });
  if (['closed','resulted'].includes(round.status))
    return res.status(409).json({ error:'ALREADY_CLOSED', message:'งวดนี้ปิดรับแล้ว' });
  await query("UPDATE lottery_rounds SET status='closed',close_at=NOW() WHERE id=?", [req.params.id]);
  res.json({ success:true, message:'ปิดรับงวดแล้ว' });
});
v1.put('/admin/lottery/rounds/:id/open', auth, adminOnly, async (req, res) => {
  const round = await queryOne('SELECT id FROM lottery_rounds WHERE id=?', [req.params.id]);
  if (!round) return res.status(404).json({ error:'NOT_FOUND' });
  await query("UPDATE lottery_rounds SET status='open' WHERE id=?", [req.params.id]);
  res.json({ success:true });
});
v1.post('/admin/lottery/rounds/:id/result', auth, adminOnly, resultCtrl.enterResult);
v1.get('/admin/kyc',             auth, adminOnly, kycCtrl.adminListKYC);
v1.put('/admin/kyc/:id/approve', auth, adminOnly, kycCtrl.approveKYC);
v1.put('/admin/kyc/:id/reject',  auth, adminOnly, kycCtrl.rejectKYC);
v1.get('/admin/hot-numbers', auth, adminOnly, async (req,res) => {
  const { round_id, bet_type_id, limit=20 } = req.query;
  let sql = 'SELECT * FROM hot_numbers WHERE 1=1';
  const params=[];
  if (round_id) { sql+=' AND round_id=?'; params.push(round_id); }
  if (bet_type_id) { sql+=' AND bet_type_id=?'; params.push(bet_type_id); }
  sql+=` ORDER BY total_amount DESC LIMIT ${parseInt(limit)}`;
  res.json({ data: await query(sql,params) });
});
v1.put('/admin/lottery-types/:id', auth, adminOnly, async (req, res) => {
  const { is_active, name, icon, description, rounds_per_day } = req.body;
  const fields = [];
  const vals   = [];
  if (is_active     !== undefined) { fields.push('is_active=?');      vals.push(is_active ? 1 : 0); }
  if (name          !== undefined) { fields.push('name=?');           vals.push(name); }
  if (icon          !== undefined) { fields.push('icon=?');           vals.push(icon); }
  if (description   !== undefined) { fields.push('description=?');    vals.push(description); }
  if (rounds_per_day!== undefined) { fields.push('rounds_per_day=?'); vals.push(rounds_per_day); }
  if (!fields.length) return res.status(422).json({ error:'NO_FIELDS' });
  vals.push(req.params.id);
  await query(`UPDATE lottery_types SET ${fields.join(',')} WHERE id=?`, vals);
  res.json({ success:true });
});
v1.get('/admin/settings', auth, adminOnly, async (req,res) => {
  res.json({ data: await query('SELECT * FROM system_settings ORDER BY group_name, setting_key') });
});
v1.put('/admin/settings/:key', auth, adminOnly, async (req,res) => {
  await query("UPDATE system_settings SET value=?,updated_by=?,updated_at=NOW() WHERE setting_key=?",[req.body.value,req.user.id,req.params.key]);
  res.json({ success:true });
});
v1.get('/admin/reports/monthly', auth, adminOnly, async (req,res) => {
  const { year=new Date().getFullYear(), month=new Date().getMonth()+1 } = req.query;
  const [revenue,payout,members,bets] = await Promise.all([
    queryOne(`SELECT SUM(amount) AS t FROM transactions WHERE type='deposit' AND status='success' AND YEAR(created_at)=? AND MONTH(created_at)=?`,[year,month]),
    queryOne(`SELECT SUM(amount) AS t FROM transactions WHERE type='win' AND YEAR(created_at)=? AND MONTH(created_at)=?`,[year,month]),
    queryOne(`SELECT COUNT(*) AS c FROM users WHERE YEAR(created_at)=? AND MONTH(created_at)=?`,[year,month]),
    queryOne(`SELECT SUM(amount) AS t FROM transactions WHERE type='bet' AND YEAR(created_at)=? AND MONTH(created_at)=?`,[year,month]),
  ]);
  res.json({ year,month, revenue:revenue.t||0, payout:payout.t||0, profit:(revenue.t||0)-(payout.t||0), new_members:members.c, total_bets:bets.t||0 });
});

// ─── New API Routes (routes/ directory) ─────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/lottery',       require('./routes/lottery'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/agents',        require('./routes/agent'));
app.use('/api/bets',          require('./routes/bets'));
app.use('/api/transactions',  require('./routes/transactions'));
app.use('/api/members',       require('./routes/members'));
app.use('/api/settings',      require('./routes/settings'));
app.use('/api/promotions',    require('./routes/promotions'));
app.use('/api/articles',      require('./routes/articles'));
app.use('/api/number-limits', require('./routes/numberLimits'));
app.use('/api/webhooks/line', require('./routes/lineWebhook'));
// ─────────────────────────────────────────────────────────────────────────────

app.use('/api/v1', v1);

/* HEALTH */
app.get('/health', async (req,res) => {
  try {
    const { pool } = require('./config/db');
    await pool.execute('SELECT 1');
    res.json({ status:'ok', db:'connected', uptime:process.uptime(), ts:new Date(), v:'auto-migrate' });
  } catch { res.status(503).json({ status:'error', db:'disconnected' }); }
});

/* SPA Fallback */
app.get('*', (req,res) => {
  const idx = path.join(__dirname,'../frontend/index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).json({ error:'NOT_FOUND' });
});

/* Error Handler */
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status||500).json({ error: err.code||'SERVER_ERROR', message: err.message });
});

/* WebSocket */
io.on('connection', socket => {
  socket.on('join_round', id => socket.join(`round:${id}`));
  socket.on('join_user',  id => socket.join(`user:${id}`));
});

/* AUTO-CLOSE SCHEDULER */
// ทุก 60 วินาที ตรวจงวดที่หมดเวลา → ปิดรับ + ออกผลยี่กี่อัตโนมัติ
async function autoCloseExpiredRounds() {
  try {
    const expired = await query(
      `SELECT r.id, r.round_code, lt.code AS type_code
       FROM lottery_rounds r
       JOIN lottery_types lt ON r.lottery_type_id = lt.id
       WHERE r.status='open' AND r.close_at <= NOW()`
    );
    if (!expired.length) return;
    const ids = expired.map(r => r.id);
    await query(
      `UPDATE lottery_rounds SET status='closed' WHERE id IN (${ids.map(()=>'?').join(',')})`,
      ids
    );
    expired.forEach(r => console.log(`[AUTO-CLOSE] งวด ${r.round_code} (id:${r.id}) ปิดรับอัตโนมัติ`));

    // Auto-result Yeekee rounds immediately after closing
    const yeekeeRounds = expired.filter(r => /yeekee|ยี่กี/.test(r.type_code || ''));
    for (const r of yeekeeRounds) {
      await autoResultYeekeeRound(r.id, r.round_code);
    }
  } catch(err) {
    console.error('[AUTO-CLOSE] Error:', err.message);
  }
}

/* AUTO-RESULT YEEKEE */
async function autoResultYeekeeRound(roundId, roundCode) {
  try {
    // Check not already resulted
    const existing = await queryOne('SELECT id FROM lottery_results WHERE round_id=?', [roundId]);
    if (existing) return;

    // Generate random results
    const r5 = () => String(Math.floor(Math.random() * 100000)).padStart(5, '0');
    const r3 = () => String(Math.floor(Math.random() * 1000)).padStart(3, '0');

    const result_first   = r5();
    const result_2_back  = result_first.slice(-2);
    const result_3_back1 = r3();
    const result_3_back2 = r3();
    const result_3_front1= r3();
    const result_3_front2= r3();

    await query(
      `INSERT INTO lottery_results
       (round_id,result_first,result_2_back,result_3_back1,result_3_back2,result_3_front1,result_3_front2,entered_at)
       VALUES (?,?,?,?,?,?,?,NOW())`,
      [roundId, result_first, result_2_back, result_3_back1, result_3_back2, result_3_front1, result_3_front2]
    );
    await query("UPDATE lottery_rounds SET status='resulted', result_at=NOW() WHERE id=?", [roundId]);

    console.log(`[AUTO-RESULT] ยี่กี่ ${roundCode} → ${result_first} (id:${roundId})`);

    // Process payouts async
    resultCtrl.processPayouts(roundId, {
      result_first, result_2_back, result_3_back1, result_3_back2,
      result_3_front1, result_3_front2
    }).catch(err => console.error(`[AUTO-RESULT] Payout error round ${roundId}:`, err.message));
  } catch(err) {
    console.error(`[AUTO-RESULT] Error round ${roundId}:`, err.message);
  }
}

/* AUTO-RESULT MISSED YEEKEE (closed but not resulted) */
async function autoResultMissedYeekeeRounds() {
  try {
    const missed = await query(
      `SELECT r.id, r.round_code
       FROM lottery_rounds r
       JOIN lottery_types lt ON r.lottery_type_id = lt.id
       LEFT JOIN lottery_results res ON res.round_id = r.id
       WHERE r.status = 'closed'
         AND res.id IS NULL
         AND (LOWER(lt.code) LIKE '%yeekee%' OR lt.name LIKE '%ยี่กี%')
       LIMIT 20`
    );
    for (const r of missed) {
      await autoResultYeekeeRound(r.id, r.round_code);
    }
  } catch(err) {
    console.error('[AUTO-RESULT-MISSED] Error:', err.message);
  }
}

/* AUTO-CREATE GOV LOTTERY ROUND (วันที่ 1 และ 16 ของเดือน) */
async function autoCreateGovRound() {
  try {
    const ict = new Date(Date.now() + 7 * 3600 * 1000);
    const d   = ict.getUTCDate();
    if (d !== 1 && d !== 16) return; // ไม่ใช่วันออกหวย

    const yyyy = ict.getUTCFullYear();
    const mm   = String(ict.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d).padStart(2, '0');

    const lt = await queryOne("SELECT id FROM lottery_types WHERE code='gov'");
    if (!lt) return;

    const roundCode = `GOV-${yyyy}${mm}${dd}`;
    const existing  = await queryOne('SELECT id FROM lottery_rounds WHERE round_code=?', [roundCode]);
    if (existing) return;

    // เปิด 00:00 / ปิด 15:00 ICT
    const openAt  = new Date(Date.UTC(yyyy, ict.getUTCMonth(), d, 0  - 7 + 24, 0));
    const closeAt = new Date(Date.UTC(yyyy, ict.getUTCMonth(), d, 15 - 7,      0));

    await query(
      `INSERT INTO lottery_rounds (lottery_type_id, round_code, round_name, open_at, close_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'open', NULL)`,
      [lt.id, roundCode, `หวยรัฐบาล ${dd}/${mm}/${yyyy}`, openAt, closeAt]
    );
    console.log(`[GOV-CREATE] Created ${roundCode}`);
  } catch (err) {
    console.error('[GOV-CREATE] Error:', err.message);
  }
}

/* AUTO-CREATE LAO ROUND (ทุกวัน) */
async function autoCreateLaoRound() {
  try {
    const now = new Date();
    const ict = new Date(now.getTime() + 7 * 3600 * 1000);
    const yyyy = ict.getUTCFullYear();
    const mm   = String(ict.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(ict.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    const lt = await queryOne("SELECT id FROM lottery_types WHERE code='laos'");
    if (!lt) return;

    const roundCode = `LAOS-${dateStr}`;
    const existing  = await queryOne('SELECT id FROM lottery_rounds WHERE round_code=?', [roundCode]);
    if (existing) return;

    // เปิด 09:00 / ปิด 19:20 ICT
    const openAt  = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), 9  - 7, 0));
    const closeAt = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), 19 - 7, 20));

    await query(
      `INSERT INTO lottery_rounds (lottery_type_id, round_code, round_name, open_at, close_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'open', NULL)`,
      [lt.id, roundCode, `หวยลาว ${dd}/${mm}/${yyyy}`, openAt, closeAt]
    );
    console.log(`[LAO-CREATE] Created ${roundCode} | close: ${closeAt.toISOString()}`);
  } catch (err) {
    console.error('[LAO-CREATE] Error:', err.message);
  }
}

/* AUTO-CREATE HANOI ROUNDS (3 ประเภท ทุกวัน) */
async function autoCreateHanoiRounds() {
  // เวลาเปิด/ปิดแต่ละประเภท (ICT = UTC+7)
  const schedule = [
    { code: 'hanoi_special', name: 'ฮานอยพิเศษ',  openH: 9,  openM: 0,  closeH: 17, closeM: 0  },
    { code: 'hanoi',         name: 'ฮานอยปกติ',   openH: 9,  openM: 0,  closeH: 18, closeM: 0  },
    { code: 'hanoi_vip',     name: 'ฮานอย VIP',   openH: 9,  openM: 0,  closeH: 19, closeM: 0  },
  ];

  // วันนี้ (ICT)
  const now = new Date();
  const ict = new Date(now.getTime() + 7 * 3600 * 1000);
  const yyyy = ict.getUTCFullYear();
  const mm   = String(ict.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ict.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}${mm}${dd}`;

  try {
    for (const s of schedule) {
      // หา lottery_type_id
      const lt = await queryOne('SELECT id FROM lottery_types WHERE code=?', [s.code]);
      if (!lt) { console.log(`[HANOI-CREATE] type ${s.code} not found`); continue; }

      const roundCode = `${s.code.toUpperCase()}-${dateStr}`;

      // ตรวจว่ามีแล้วหรือยัง
      const existing = await queryOne('SELECT id FROM lottery_rounds WHERE round_code=?', [roundCode]);
      if (existing) continue;

      // สร้าง timestamp ICT → UTC
      const openAt  = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), s.openH  - 7, s.openM));
      const closeAt = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), s.closeH - 7, s.closeM));

      await query(
        `INSERT INTO lottery_rounds (lottery_type_id, round_code, round_name, open_at, close_at, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'open', NULL)`,
        [lt.id, roundCode, `${s.name} ${dd}/${mm}/${yyyy}`, openAt, closeAt]
      );
      console.log(`[HANOI-CREATE] Created ${roundCode}`);
    }
  } catch (err) {
    console.error('[HANOI-CREATE] Error:', err.message);
  }
}

/* AUTO-CREATE YEEKEE ROUNDS */
async function autoCreateYeekeeRounds() {
  try {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const dd   = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;
    const likePattern = `YEEKEE-${dateStr}-%`;

    const [countRow] = await query(
      'SELECT COUNT(*) AS c FROM lottery_rounds WHERE round_code LIKE ?',
      [likePattern]
    );
    if (countRow.c > 0) return; // Already created today

    const typeRow = await queryOne(
      "SELECT id FROM lottery_types WHERE code='yeekee' OR code LIKE '%yeekee%' LIMIT 1"
    );
    if (!typeRow) { console.warn('[AUTO-CREATE-YK] lottery_type yeekee not found'); return; }

    const typeId = typeRow.id;
    const midnight = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
    const INTERVAL_MS  = 16 * 60 * 1000;       // 16 minutes
    const CLOSE_OFFSET = 15 * 60 * 1000 + 30 * 1000; // 15m30s
    const RESULT_OFFSET= CLOSE_OFFSET + 30 * 1000;    // +30s

    function toMySQLDT(d) {
      return d.toISOString().replace('T', ' ').slice(0, 19);
    }

    for (let rr = 1; rr <= 90; rr++) {
      const rrStr   = String(rr).padStart(2, '0');
      const code    = `YEEKEE-${dateStr}-${rrStr}`;
      const name    = `ยี่กี่ รอบที่ ${rr} (${dateStr})`;
      const openAt  = new Date(midnight.getTime() + (rr - 1) * INTERVAL_MS);
      const closeAt = new Date(openAt.getTime() + CLOSE_OFFSET);
      const resultAt= new Date(openAt.getTime() + RESULT_OFFSET);
      const status  = closeAt <= now ? 'closed' : 'open';

      await query(
        `INSERT IGNORE INTO lottery_rounds (lottery_type_id,round_code,round_name,open_at,close_at,result_at,status)
         VALUES (?,?,?,?,?,?,?)`,
        [typeId, code, name, toMySQLDT(openAt), toMySQLDT(closeAt), toMySQLDT(resultAt), status]
      );
    }
    console.log(`[AUTO-CREATE-YK] สร้าง 90 รอบยี่กี่สำหรับ ${dateStr} เรียบร้อย`);
  } catch(err) {
    console.error('[AUTO-CREATE-YK] Error:', err.message);
  }
}

/* Daily scheduler: re-create rounds each day at 00:01 ICT */
let _lastYkCreateDate = '';
function scheduleDailyYeekeeCreate() {
  setInterval(() => {
    const now = new Date();
    // Always use ICT (UTC+7) for day-boundary check
    const ict = new Date(now.getTime() + 7 * 3600 * 1000);
    const dateKey = `${ict.getUTCFullYear()}-${ict.getUTCMonth()}-${ict.getUTCDate()}`;
    if (ict.getUTCHours() === 0 && ict.getUTCMinutes() >= 1 && dateKey !== _lastYkCreateDate) {
      _lastYkCreateDate = dateKey;
      autoCreateYeekeeRounds();
      autoCreateHanoiRounds();
      autoCreateLaoRound();
      autoCreateGovRound();
    }
  }, 60_000);
}

/* Start */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🐯 TigerLotto API  :${PORT}  [${process.env.NODE_ENV||'development'}]`);
  // ── Run full DB migration on every startup (idempotent) ───────────────────
  const { runMigration } = require('./database/migrate');
  runMigration().catch(e => console.error('[startup] Migration error:', e.message));
  // Migrate slip_image column to MEDIUMTEXT to support base64 image strings
  const { pool } = require('./config/db');
  pool.execute("ALTER TABLE transactions MODIFY COLUMN slip_image MEDIUMTEXT").catch(() => {});
  // ── Ensure new tables exist (safe: CREATE TABLE IF NOT EXISTS) ─────────────
  pool.execute(`CREATE TABLE IF NOT EXISTS \`line_messages\` (
    \`id\`           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`msg_id\`       VARCHAR(50) NOT NULL,
    \`source_id\`    VARCHAR(100) NOT NULL DEFAULT '',
    \`sender_id\`    VARCHAR(50) NOT NULL DEFAULT '',
    \`message_text\` TEXT NOT NULL,
    \`parsed\`       TINYINT(1) NOT NULL DEFAULT 0,
    \`received_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_msg_id\` (\`msg_id\`),
    INDEX \`idx_lm_received\` (\`received_at\`),
    INDEX \`idx_lm_source\` (\`source_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(e => console.warn('[startup] line_messages table:', e.message));
  // ── Seed 109 new lottery sub-types (INSERT IGNORE via pool — idempotent) ──
  (async () => {
    try {
      // Add category + fix sort_order column
      await pool.execute("ALTER TABLE `lottery_types` ADD COLUMN `category` VARCHAR(50) NOT NULL DEFAULT 'other' AFTER `flag`").catch(()=>{});
      await pool.execute("ALTER TABLE `lottery_types` MODIFY COLUMN `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0").catch(()=>{});
      const newTypes = [
        ['JP_STK_AM','นิคเคอิเช้า','🇯🇵',211],['JP_STK_PM','นิคเคอิบ่าย','🇯🇵',212],
        ['CN_STK_AM','จีนเช้า','🇨🇳',221],['CN_STK_PM','จีนบ่าย','🇨🇳',222],
        ['HK_STK','ฮั่งเส็ง','🇭🇰',230],['HK_STK_AM','ฮั่งเส็งเช้า','🇭🇰',231],['HK_STK_PM','ฮั่งเส็งบ่าย','🇭🇰',232],
        ['IN_STK','อินเดีย','🇮🇳',270],['DE_STK','เยอรมัน','🇩🇪',280],['RU_STK','รัสเซีย','🇷🇺',290],['UK_STK','อังกฤษ','🇬🇧',300],
        ['JP_VIP_AM','นิคเคอิ VIP เช้า','🇯🇵',311],['JP_VIP_PM','นิคเคอิ VIP บ่าย','🇯🇵',312],
        ['CN_VIP_AM','จีน VIP เช้า','🇨🇳',321],['CN_VIP_PM','จีน VIP บ่าย','🇨🇳',322],
        ['HK_VIP_AM','ฮั่งเส็ง VIP เช้า','🇭🇰',331],['HK_VIP_PM','ฮั่งเส็ง VIP บ่าย','🇭🇰',332],
        ['TW_VIP','ไต้หวัน VIP','🇹🇼',340],['KR_VIP','เกาหลี VIP','🇰🇷',350],['SG_VIP','สิงคโปร์ VIP','🇸🇬',360],
        ['UK_VIP','อังกฤษ VIP','🇬🇧',370],['DE_VIP','เยอรมัน VIP','🇩🇪',380],['RU_VIP','รัสเซีย VIP','🇷🇺',390],
        ['JP_SP_AM','นิคเคอิพิเศษเช้า','🇯🇵',411],['JP_SP_PM','นิคเคอิพิเศษบ่าย','🇯🇵',412],
        ['CN_SP_AM','จีนพิเศษเช้า','🇨🇳',421],['CN_SP_PM','จีนพิเศษบ่าย','🇨🇳',422],
        ['HK_SP_AM','ฮั่งเส็งพิเศษเช้า','🇭🇰',431],['HK_SP_PM','ฮั่งเส็งพิเศษบ่าย','🇭🇰',432],
        ['VN_SP_AM','เวียดนามพิเศษเช้า','🇻🇳',441],['VN_SP_PM','เวียดนามพิเศษบ่าย','🇻🇳',442],
        ['TW_SP','ไต้หวันพิเศษ','🇹🇼',450],['KR_SP','เกาหลีพิเศษ','🇰🇷',460],['SG_SP','สิงคโปร์พิเศษ','🇸🇬',470],
        ['RU_SP','รัสเซียพิเศษ','🇷🇺',480],['DE_SP','เยอรมันพิเศษ','🇩🇪',481],['DJ_SP','ดาวโจนส์พิเศษ','🇺🇸',490],['EU_SP','ยูโร','🇪🇺',495],
        ['JP_VISA_AM','นิคเคอิวีซ่าเช้า','🇯🇵',511],['JP_VISA_PM','นิคเคอิวีซ่าบ่าย','🇯🇵',512],
        ['CN_VISA_AM','จีนวีซ่าเช้า','🇨🇳',521],['CN_VISA_PM','จีนวีซ่าบ่าย','🇨🇳',522],
        ['HK_VISA_AM','ฮั่งเส็งวีซ่าเช้า','🇭🇰',531],['HK_VISA_PM','ฮั่งเส็งวีซ่าบ่าย','🇭🇰',532],
        ['HK_VISA','ฮ่องกงวีซ่า','🇭🇰',533],['VN_VISA','ฮานอยวีซ่า','🇻🇳',540],
        ['LA_VISA_SAL','ลาววีซ่าสาละวัน','🇱🇦',551],['LA_VISA_LPB','ลาววีซ่าหลวงพระบาง','🇱🇦',552],
        ['LA_VISA_VTE','ลาววีซ่าเวียงจันทน์','🇱🇦',553],['LA_VISA','ลาววีซ่า','🇱🇦',554],
        ['UK_VISA','อังกฤษวีซ่า','🇬🇧',560],['DE_VISA','เยอรมันวีซ่า','🇩🇪',561],['RU_VISA','รัสเซียวีซ่า','🇷🇺',562],
        ['VN_HAN_AM','ฮานอยเช้า','🇻🇳',601],['VN_HAN_ASEAN','ฮานอยอาเซียน','🇻🇳',602],
        ['VN_HAN_HD','ฮานอย HD','🇻🇳',603],['VN_HAN_STAR','ฮานอยสตาร์','🇻🇳',604],
        ['VN_HAN_TV','ฮานอยทีวี','🇻🇳',605],['VN_HAN_RC','ฮานอยกาชาด','🇻🇳',606],
        ['VN_HAN_SPEC','ฮานอยเฉพาะกิจ','🇻🇳',607],['VN_HAN_SAM','ฮานอยสามัคคี','🇻🇳',608],
        ['VN_HAN_ONLINE','เวียดนามปกติออนไลน์','🇻🇳',609],['VN_VIP_ONLINE','เวียดนาม VIP ออนไลน์','🇻🇳',610],
        ['VN_HAN_DEV','ฮานอยพัฒนา','🇻🇳',611],['VN_HAN_4D','ฮานอย 4D','🇻🇳',612],
        ['VN_HAN_EXTRA','ฮานอย Extra','🇻🇳',613],['VN_HAN_NIGHT','ฮานอยดึก','🇻🇳',614],
        ['LA_GATE','ลาวประตูชัย','🇱🇦',702],['LA_PEACE','ลาวสันติภาพ','🇱🇦',703],
        ['LA_PEOPLE','ประชาชนลาว','🇱🇦',704],['LA_AM','ลาวเช้า','🇱🇦',705],
        ['LA_EXTRA','ลาว Extra','🇱🇦',706],['LA_TV','ลาวทีวี','🇱🇦',707],
        ['LA_RICH','ลาวมั่งคั่ง','🇱🇦',708],['LA_SP_NOON','ลาวพิเศษเที่ยง','🇱🇦',709],
        ['LA_SP','ลาวพิเศษ','🇱🇦',710],['LA_PLUS','ลาวพลัส','🇱🇦',711],
        ['LA_SABAI','ลาวสบายดี','🇱🇦',712],['LA_GOV_NOON','ลาวพัฒนาเที่ยง','🇱🇦',713],
        ['LA_PROGRESS','ลาวก้าวหน้า','🇱🇦',714],['LA_HD','ลาว HD','🇱🇦',715],
        ['LA_CHERN','ลาวเจริญ','🇱🇦',716],['LA_NKL','ลาวนครหลวง','🇱🇦',717],
        ['LA_STABLE','ลาวมั่นคง','🇱🇦',718],['LA_STAR','ลาวสตาร์','🇱🇦',719],
        ['LA_NIYOM','ลาวนิยม','🇱🇦',720],['LA_RICH2','ลาวร่ำรวย','🇱🇦',721],
        ['LA_MONGKOL','ลาวมงคล','🇱🇦',722],['LA_SUPER','ลาวซูเปอร์','🇱🇦',723],
        ['LA_UNITY','ลาวสามัคคี','🇱🇦',724],['LA_ASEAN','ลาวอาเซียน','🇱🇦',725],
        ['LA_UNITY_VIP','ลาวสามัคคี VIP','🇱🇦',726],['LA_PROSPER','ลาวรุ่งเรือง','🇱🇦',727],
        ['LA_VIP','ลาว VIP','🇱🇦',728],['LA_STAR_VIP','ลาวสตาร์ VIP','🇱🇦',729],
        ['LA_AIYARA','ลาวไอยรา','🇱🇦',730],['LA_RC','ลาวกาชาด','🇱🇦',731],['LA_GOV_VIP','ลาวพัฒนา VIP','🇱🇦',732],
        ['MK_TODAY','แม่โขงทูเดย์','🇱🇦',801],['MK_HD','แม่โขง HD','🇱🇦',802],
        ['MK_MEGA','แม่โขงเมก้า','🇱🇦',803],['MK_STAR','แม่โขงสตาร์','🇱🇦',804],
        ['MK_PLUS','แม่โขงพลัส','🇱🇦',805],['MK_SP','แม่โขงพิเศษ','🇱🇦',806],
        ['MK_NORMAL','แม่โขงปกติ','🇱🇦',807],['MK_VIP','แม่โขง VIP','🇱🇦',808],
        ['MK_DEV','แม่โขงพัฒนา','🇱🇦',809],['MK_GOLD','แม่โขงโกลด์','🇱🇦',810],['MK_NIGHT','แม่โขงไนท์','🇱🇦',811],
      ];
      let seeded = 0;
      for (const [code, name, flag, sort_order] of newTypes) {
        const [r] = await pool.execute(
          'INSERT IGNORE INTO `lottery_types` (`code`,`name`,`flag`,`sort_order`,`rate_3top`,`rate_3tod`,`rate_2top`,`rate_2bot`,`rate_run_top`,`rate_run_bot`,`max_bet`) VALUES (?,?,?,?,720,115,90,85,3.0,4.0,5000)',
          [code, name, flag, sort_order]
        );
        if (r.affectedRows > 0) seeded++;
      }
      if (seeded > 0) console.log(`[startup] Seeded ${seeded} new lottery types`);
    } catch (e) { console.warn('[startup] Lottery seed error:', e.message); }
  })();
  setTimeout(() => {
    autoCreateGovRound();
    autoCreateLaoRound();
    autoCreateHanoiRounds();
    autoCreateYeekeeRounds();
    autoCloseExpiredRounds();
    autoResultMissedYeekeeRounds();
    setInterval(async () => {
      await autoCloseExpiredRounds();
      await autoResultMissedYeekeeRounds();
    }, 60_000);
    scheduleDailyYeekeeCreate();

    // ── หวยฮานอย: DISABLED — ใช้ LINE Webhook แทน ────────────
    // (บอทในกลุ่ม LINE แจ้งผลครบทุกหวย จึงไม่จำเป็นต้องใช้ scraper)
    // ─────────────────────────────────────────────────────────

    // ── หวยลาว: DISABLED — ใช้ LINE Webhook แทน ───────────────
    // (บอทในกลุ่ม LINE แจ้งผลครบทุกหวย จึงไม่จำเป็นต้องใช้ scraper)

    // ── หวยรัฐบาล: DISABLED — ใช้ LINE Webhook แทน ────────────
    // (บอทในกลุ่ม LINE แจ้งผลครบทุกหวย จึงไม่จำเป็นต้องใช้ scraper)
    // ─────────────────────────────────────────────────────────────

    // ── Round Manager (auto-create/open/close/announce) ──────────
    const { startRoundManager } = require('./services/roundManager');
    startRoundManager();
    console.log('[ROUND_MGR] Started — auto-create/open/close/announce rounds');
    // ─────────────────────────────────────────────────────────────
  }, 5_000);
});
