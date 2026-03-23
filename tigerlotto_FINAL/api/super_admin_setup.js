/**
 * super_admin_setup.js
 * Creates or updates a superadmin user in the TigerLotto database.
 *
 * Usage:
 *   node super_admin_setup.js
 *
 * Requires the same .env as server.js (DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME)
 *
 * Credentials created:
 *   phone:    0800000001
 *   password: Tiger@2024!
 *   role:     superadmin
 */

require('dotenv').config();
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const PHONE     = '0800000001';
const PASSWORD  = 'Tiger@2024!';
const FIRSTNAME = 'Super';
const LASTNAME  = 'Admin';
const ROLE      = 'superadmin';

async function main() {
  const pool = mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || 3306),
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 3,
    charset: 'utf8mb4',
    timezone: '+07:00',
  });

  try {
    const hash = await bcrypt.hash(PASSWORD, 12);
    const [[existing]] = await pool.execute('SELECT id, phone, role FROM users WHERE phone = ?', [PHONE]);

    if (existing) {
      await pool.execute(
        "UPDATE users SET password_hash = ?, role = ?, first_name = ?, last_name = ?, is_verified = 1, vip_tier = 'diamond' WHERE phone = ?",
        [hash, ROLE, FIRSTNAME, LASTNAME, PHONE]
      );
      console.log(`✅ Updated existing user (id=${existing.id}) to role=${ROLE}`);
    } else {
      const uuid     = uuidv4();
      const refCode  = 'SADMIN-' + Math.random().toString(36).substr(2, 6).toUpperCase();
      const [result] = await pool.execute(
        `INSERT INTO users (uuid, phone, password_hash, first_name, last_name, referral_code, role, vip_tier, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'diamond', 1)`,
        [uuid, PHONE, hash, FIRSTNAME, LASTNAME, refCode, ROLE]
      );
      const userId = result.insertId;
      // Create wallet for the new user
      await pool.execute('INSERT INTO wallets (user_id, balance) VALUES (?, 0)', [userId]);
      console.log(`✅ Created superadmin user (id=${userId})`);
    }

    console.log('');
    console.log('══════════════════════════════════');
    console.log(' Super Admin Credentials');
    console.log('══════════════════════════════════');
    console.log(` Phone:    ${PHONE}`);
    console.log(` Password: ${PASSWORD}`);
    console.log(` Role:     ${ROLE}`);
    console.log('══════════════════════════════════');
    console.log('');
    console.log('Login at: index.html (use phone + password)');
    console.log('Admin panel: admin.html');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
