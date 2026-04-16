// Run: node database/migrate.js
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ─── รองรับ Railway DATABASE_URL ───
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
  } catch { return null; }
}

async function migrate() {
  console.log('🔄 Running TigerLotto DB migration...');

  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  const parsed = dbUrl ? parseDbUrl(dbUrl) : null;

  const connConfig = {
    host    : parsed?.host     || process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
    port    : parsed?.port     || process.env.DB_PORT     || process.env.MYSQLPORT     || 3306,
    database: parsed?.database || process.env.DB_NAME     || process.env.MYSQLDATABASE || 'railway',
    user    : parsed?.user     || process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
    password: parsed?.password || process.env.DB_PASS     || process.env.MYSQLPASSWORD || '',
    multipleStatements: true,
    charset : 'utf8mb4',
    ssl     : process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };

  console.log(`   Host: ${connConfig.host}:${connConfig.port}`);
  console.log(`   DB  : ${connConfig.database}`);

  const conn = await mysql.createConnection(connConfig);
  const sql  = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await conn.query(sql);

  console.log('✅ Migration complete!');
  console.log('   Default admin: superadmin@tigerlotto.com / Admin@1234');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
