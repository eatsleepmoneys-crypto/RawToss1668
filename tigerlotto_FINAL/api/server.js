// ⚠️ ต้อง set TZ ก่อน require ทุกอย่าง — มิฉะนั้น new Date() จะใช้ UTC
process.env.TZ = 'Asia/Bangkok';

require('dotenv').config();
require('express-async-errors'); // auto-catch async route errors → prevents 502 hangs
const express    = require('express');
// cors package replaced by manual CORS middleware (see below)
const helmet     = require('helmet');
const morgan     = require('morgan');
const compress   = require('compression');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const cron       = require('node-cron');

const app = express();

// ─── Trust Proxy (Railway / Heroku sit behind a load balancer) ────────────────
// Required so express-rate-limit can read X-Forwarded-For without throwing
app.set('trust proxy', 1);

// ─── Security Headers ─────────────────────────────
// Disable CORP/COEP to allow cross-origin API access from Cloudflare Pages
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,     // Allow cross-origin fetch
  crossOriginOpenerPolicy: false,       // Don't restrict opener
  crossOriginEmbedderPolicy: false,     // Don't require COEP on clients
}));

// ─── CORS ─────────────────────────────────────────
// Manual middleware: ชัดเจนกว่า cors() package และ handle OPTIONS ก่อน rate limiter
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // ตั้ง ACAO: ถ้ามี origin ใช้ตัวนั้น, ถ้าไม่มีใช้ wildcard
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With,Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  // OPTIONS preflight → ตอบ 204 ทันที ไม่ผ่าน rate limiter
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// ─── Parsers ──────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compress());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Static files ────────────────────────────────
// Uploads (slip images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Frontend static files — serve เว็บหน้าบ้านจาก backend (same-origin, no CORS needed)
// Railway clones full repo: api/ is at tigerlotto_FINAL/api/, frontend is at tigerlotto_FINAL/frontend/
const FRONTEND_PATH = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend');
if (require('fs').existsSync(FRONTEND_PATH)) {
  app.use(express.static(FRONTEND_PATH));
  console.log('📁 Serving frontend from:', FRONTEND_PATH);
}

// ─── Global Rate Limit ────────────────────────────
const globalLimit = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000,
  max:       process.env.RATE_LIMIT_MAX || 200,
  message:   { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
});
app.use('/api/', globalLimit);

// ─── Routes ───────────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/members',      require('./routes/members'));
app.use('/api/lottery',      require('./routes/lottery'));
app.use('/api/bets',         require('./routes/bets'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/admin',        require('./routes/admin'));
app.use('/api/settings',     require('./routes/settings'));
app.use('/api/agent',        require('./routes/agent'));

// ─── Health Check ─────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'TigerLotto API running', ts: new Date().toISOString() });
});

// ─── Debug: list DB tables ────────────────────────
app.get('/api/debug/tables', async (req, res) => {
  try {
    const { query } = require('./config/db');
    const rows = await query(
      `SELECT TABLE_NAME, TABLE_ROWS
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME`
    );
    res.json({ success: true, database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'railway', tables: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Manual migration trigger (admin use) ─────────
app.post('/api/debug/migrate', async (req, res) => {
  try {
    const { runMigration } = require('./database/migrate');
    // Capture console output by temporarily overriding
    const logs = [];
    const origLog  = console.log;
    const origWarn = console.warn;
    console.log  = (...a) => { origLog(...a);  logs.push(a.join(' ')); };
    console.warn = (...a) => { origWarn(...a); logs.push('⚠️  ' + a.join(' ')); };
    await runMigration();
    console.log  = origLog;
    console.warn = origWarn;
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── SPA Fallback: admin ──────────────────────────
app.get('/admin', (req, res) => {
  const adminPath = path.join(FRONTEND_PATH, 'admin/index.html');
  if (require('fs').existsSync(adminPath)) return res.sendFile(adminPath);
  res.status(404).json({ message: 'Admin panel not found' });
});

// ─── SPA Fallback: root ───────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
  }
  const indexPath = path.join(FRONTEND_PATH, 'index.html');
  if (require('fs').existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).json({ success: false, message: 'Frontend not found' });
});

// ─── Error Handler ────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message, // TODO: hide in production after debugging
  });
});

// ─── Cron Jobs ────────────────────────────────────
// Cron ทั้งหมดถูกจัดการโดย roundManager.js (startRoundManager)
// ซึ่งจะถูกเรียกใน startServer() หลัง migration+seed เสร็จ

// ─── Start Server (with auto-migrate) ────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Auto-run DB migration on startup (idempotent — safe to run every time)
    console.log('📦 Running DB migration...');
    const { runMigration } = require('./database/migrate');
    await runMigration();
    console.log('✅ DB migration complete');
  } catch (err) {
    console.warn('⚠️  Migration warning (continuing):', err.message);
  }

  // ─── Always ensure superadmin exists with correct password ───────────────────
  try {
    const bcrypt = require('bcryptjs');
    const { query } = require('./config/db');
    const hash = await bcrypt.hash('Admin@1234', 12);
    await query(
      `INSERT INTO admins (uuid, name, email, password, role, is_active, login_attempts)
       VALUES ('00000000-0000-0000-0000-000000000001','Super Admin','superadmin@tigerlotto.com',?,\'superadmin\',1,0)
       ON DUPLICATE KEY UPDATE password=?, login_attempts=0, locked_until=NULL, is_active=1`,
      [hash, hash]
    );
    console.log('✅ Superadmin seed OK');
  } catch (e) {
    console.warn('⚠️  Superadmin seed failed (table may not exist yet):', e.message);
  }

  // ─── อัปเดตชื่อ lottery_types ที่เปลี่ยนแปลง (ทำทุกครั้ง — idempotent) ────
  try {
    const { query } = require('./config/db');
    await Promise.all([
      query(`UPDATE lottery_types SET name='ลาวพัฒนา'     WHERE code='LA_GOV'     AND name != 'ลาวพัฒนา'`),
      query(`UPDATE lottery_types SET name='ฮานอยปกติ'    WHERE code='VN_HAN'     AND name != 'ฮานอยปกติ'`),
      query(`UPDATE lottery_types SET name='ฮานอยพิเศษ'   WHERE code='VN_HAN_SP'  AND name != 'ฮานอยพิเศษ'`),
      query(`UPDATE lottery_types SET name='ฮานอย VIP'    WHERE code='VN_HAN_VIP' AND name != 'ฮานอย VIP'`),
    ]);
    console.log('✅ Lottery type names updated (ลาวพัฒนา / ฮานอยปกติ / ฮานอยพิเศษ / ฮานอย VIP)');
  } catch (e) {
    console.warn('⚠️  Lottery type name update failed:', e.message);
  }

  // ─── Start Round Manager (auto-open/close/announce) ─────────────
  try {
    const { startRoundManager } = require('./services/roundManager');
    startRoundManager();
    console.log('✅ Round Manager started (yeekee auto-rounds + auto-announce ON)');
  } catch (e) {
    console.warn('⚠️  Round Manager start failed:', e.message);
  }

  // ─── Start Lottery Fetcher (TH_GOV / LA_GOV / VN_HAN auto-fetch) ─
  try {
    const { startLotteryFetcher } = require('./services/lotteryFetcher');
    startLotteryFetcher();
    console.log('✅ Lottery Fetcher started (TH_GOV/LA_GOV/VN_HAN auto-fetch ON)');
  } catch (e) {
    console.warn('⚠️  Lottery Fetcher start failed:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`\n🐯 TigerLotto API started`);
    console.log(`   Port    : ${PORT}`);
    console.log(`   Env     : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Docs    : http://localhost:${PORT}/api/health\n`);
  });
}

startServer();

module.exports = app;
