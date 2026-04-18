const mysql = require('mysql2/promise');
require('dotenv').config();

// ─── Railway DATABASE_URL support ───
// Railway MySQL ให้ DATABASE_URL แบบ:
// mysql://user:pass@host:port/dbname
function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return {
      host    : u.hostname,
      port    : parseInt(u.port) || 3306,
      database: u.pathname.replace('/', ''),
      user    : u.username,
      password: u.password,
    };
  } catch {
    return null;
  }
}

const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
const dbConfig = dbUrl ? parseDbUrl(dbUrl) : null;

const pool = mysql.createPool({
  host    : dbConfig?.host     || process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
  port    : dbConfig?.port     || process.env.DB_PORT     || process.env.MYSQLPORT     || 3306,
  database: dbConfig?.database || process.env.DB_NAME     || process.env.MYSQLDATABASE || 'tigerlotto',
  user    : dbConfig?.user     || process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
  password: dbConfig?.password || process.env.DB_PASS     || process.env.MYSQLPASSWORD || '',

  waitForConnections : true,
  connectionLimit    : 20,
  queueLimit         : 0,
  charset            : 'utf8mb4',
  timezone           : '+07:00',
  decimalNumbers     : true,

  // Railway ต้องการ SSL บางครั้ง
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

// ─── Set session timezone on every connection ───
// mysql2's `timezone` pool option only affects JS Date serialisation;
// it does NOT set MySQL's server-side NOW() timezone.
// We must explicitly set time_zone so that NOW() returns Bangkok time,
// which matches the Bangkok-time strings stored in open_at / close_at.
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+07:00'", (err) => {
    if (err) console.warn('⚠️  Failed to set session time_zone:', err.message);
  });
});

// ─── Test connection ───
pool.getConnection()
  .then(conn => {
    const dbName = dbConfig?.database || process.env.DB_NAME || 'tigerlotto';
    console.log('✅ MySQL connected:', dbName);
    conn.release();
  })
  .catch(err => {
    console.error('❌ MySQL connection error:', err.message);
    process.exit(1);
  });

// ─── Helpers ───
const query = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

const transaction = async (callback) => {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

// ─── queryOne — returns first row or null ───
const queryOne = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows[0] || null;
};

module.exports = { pool, query, queryOne, transaction };
