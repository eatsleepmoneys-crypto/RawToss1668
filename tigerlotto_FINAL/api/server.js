/**
 * TigerLotto — Full Backend Server
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

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://courageous-fairy-114078.netlify.app',
  'https://rawtoss1668-production.up.railway.app',
  'http://localhost:3000',
];
const corsOriginFn = (origin, callback) => {
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.includes(origin) || /\.netlify\.app$/.test(origin)) {
    return callback(null, true);
  }
  callback(new Error('Not allowed by CORS'));
};

const io     = new Server(server, {
  cors: { origin: corsOriginFn, credentials: true },
  transports: ['websocket', 'polling'],
});
global.io = io;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: corsOriginFn, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const logDir = path.join(__dirname, '../logs');
fs.mkdirSync(logDir, { recursive: true });
app.use(morgan('combined', {
  stream: fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' }),
}));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/auth/', rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'RATE_LIMIT', message: 'ส่งคำขอถี่เกินไป' } }));

// Static
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Import Controllers ─────────────────────────────────────────
const authCtrl   = require('./controllers/authController');
const walletCtrl = require('./controllers/walletController');
const slipCtrl   = require('./controllers/slipController');
const resultCtrl = require('./controllers/resultController');
const agentCtrl  = require('./controllers/agentController');
const kycCtrl    = require('./controllers/kycController');
const bankCtrl   = require('./controllers/bankController');
const { auth, adminOnly, agentOnly } = require('./middleware/auth');
const { query, queryOne } = require('./config/db');

// ── V1 Router ─────────────────────────────────────────────────
const v1 = express.Router();

/* AUTH */
v1.post('/auth/register',   authCtrl.register);
v1.post('/auth/login',      authCtrl.login);
v1.post('/auth/otp/send',   authCtrl.sendOTP);
v1.post('/auth/otp/verify', authCtrl.verifyOTP);

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
    return res.status(422).json({ error: 'VALIDATION', message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัว' });
  const user = await queryOne('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!await bcrypt.compare(old_password, user.password_hash))
    return res.status(422).json({ error: 'WRONG_PASSWORD', message: 'รหัสผ่านเดิมไม่ถูกต้อง' });
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
  res.json({ data: await query('SELECT * FROM lottery_types WHERE is_active=1 ORDER BY sort_order') });
});
v1.get('/lottery/rounds', async (req,res) => {
  const { lottery_type, status = 'open' } = req.query;
  let sql = `SELECT r.*, lt.name, lt.icon FROM lottery_rounds r JOIN lottery_types lt ON r.lottery_type_id=lt.id WHERE r.status=?`;
  const params = [status];
  if (lottery_type) { sql += ' AND lt.code=?'; params.push(lottery_type); }
  sql += ' ORDER BY r.close_at ASC';
  res.json({ data: await query(sql, params) });
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
  if (!row) return res.status(404).json({ error: 'NOT_FOUND', message: 'ยังไม่มีผล' });
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
  sql += ' ORDER BY lr.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);
  res.json({ data: await query(sql, params) });
});

/* SLIPS */
v1.get('/slips',             auth, slipCtrl.getSlips);
v1.get('/slips/:id',         auth, slipCtrl.getSlip);
v1.post('/slips',            auth, slipCtrl.createSlip);
v1.delete('/slips/:id',      auth, slipCtrl.cancelSlip);

/* NOTIFICATIONS */
v1.get('/notifications',            auth, async (req,res) => {
  const { is_read, page=1, limit=20 } = req.query;
  const offset = (parseInt(page)-1)*parseInt(limit);
  let sql = 'SELECT * FROM notifications WHERE user_id=?';
  const params = [req.user.id];
  if (is_read !== undefined) { sql += ' AND is_read=?'; params.push(parseInt(is_read)); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);
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
  sql+=' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit),offset);
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
  sql+=' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit),offset);
  res.json({ data: await query(sql,params) });
});
v1.put('/admin/transactions/:id/approve', auth, adminOnly, async (req,res) => {
  const tx = await queryOne("SELECT * FROM transactions WHERE id=? AND type='withdraw' AND status='pending'",[req.params.id]);
  if (!tx) return res.status(404).json({ error:'NOT_FOUND' });
  await query("UPDATE transactions SET status='success',processed_by=?,processed_at=NOW() WHERE id=?",[req.user.id,req.params.id]);
  await query('UPDATE wallets SET locked_balance=locked_balance-? WHERE user_id=?',[tx.amount,tx.user_id]);
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
  sql+=' ORDER BY total_amount DESC LIMIT ?'; params.push(parseInt(limit));
  res.json({ data: await query(sql,params) });
});
v1.get('/admin/settings', auth, adminOnly, async (req,res) => {
  res.json({ data: await query('SELECT * FROM system_settings ORDER BY group_name,`key`') });
});
v1.put('/admin/settings/:key', auth, adminOnly, async (req,res) => {
  await query("UPDATE system_settings SET value=?,updated_by=?,updated_at=NOW() WHERE `key`=?",[req.body.value,req.user.id,req.params.key]);
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

app.use('/api/v1', v1);

/* HEALTH */
app.get('/health', async (req,res) => {
  try {
    const { pool } = require('./config/db');
    await pool.execute('SELECT 1');
    res.json({ status:'ok', db:'connected', uptime:process.uptime(), ts:new Date() });
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

/* Start */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🐯 TigerLotto API  :${PORT}  [${process.env.NODE_ENV||'development'}]`);
});
