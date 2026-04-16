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

// ─── Health Check ─────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'TigerLotto API running', ts: new Date().toISOString() });
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
    message: process.env.NODE_ENV === 'production' ? 'เกิดข้อผิดพลาดภายในระบบ' : err.message,
  });
});

// ─── Cron Jobs ────────────────────────────────────
// Auto-close rounds past close_at time (every minute)
cron.schedule('* * * * *', async () => {
  try {
    const { query } = require('./config/db');
    await query(`
      UPDATE lottery_rounds SET status = 'closed'
      WHERE status = 'open' AND close_at <= NOW()
    `);
  } catch (e) { /* silent */ }
});

// Yee-kee: auto-open rounds every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  // Logic for Yee-kee auto rounds can be added here
});

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

  app.listen(PORT, () => {
    console.log(`\n🐯 TigerLotto API started`);
    console.log(`   Port    : ${PORT}`);
    console.log(`   Env     : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Docs    : http://localhost:${PORT}/api/health\n`);
  });
}

startServer();

module.exports = app;
