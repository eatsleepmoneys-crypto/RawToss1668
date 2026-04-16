require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const compress   = require('compression');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const cron       = require('node-cron');

const app = express();

// ─── Security Headers ─────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ─── CORS ─────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // ไม่มี origin = same-origin หรือ curl → อนุญาต
    if (!origin) return cb(null, true);
    // Railway URLs: *.up.railway.app → อนุญาตทั้งหมด
    if (origin.endsWith('.railway.app') || origin.endsWith('.up.railway.app')) return cb(null, true);
    // Cloudflare Pages: *.pages.dev → อนุญาต
    if (origin.endsWith('.pages.dev')) return cb(null, true);
    // whitelist จาก .env
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, true); // dev mode: อนุญาตทุก origin (เปลี่ยนเป็น false ใน production จริง)
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE'],
}));

// ─── Parsers ──────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compress());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Static files ────────────────────────────────
// Uploads (slip images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Frontend static files (tigerlotto/) — serve เว็บหน้าบ้านจาก backend
// วางโฟลเดอร์ tigerlotto/ ไว้ข้างๆ tigerlotto-backend/
const FRONTEND_PATH = process.env.FRONTEND_PATH || path.join(__dirname, '../tigerlotto');
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
