#!/usr/bin/env node
/**
 * migrate_hd.js — Run HuayDragon lottery types migration
 * Usage (from project root): node api/scripts/migrate_hd.js
 * Reads .env from project root automatically.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs    = require('fs');
const path  = require('path');
const mysql = require('mysql2/promise');

const SQL_FILE = path.join(__dirname, '../database/migrate_hd_types.sql');

async function run() {
  if (!process.env.DB_USER || !process.env.DB_NAME) {
    console.error('[MIGRATE] ❌ DB_USER / DB_NAME not set — ตรวจสอบ .env');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host:               process.env.DB_HOST     || 'localhost',
    port:               parseInt(process.env.DB_PORT || 3306),
    user:               process.env.DB_USER,
    password:           process.env.DB_PASS,
    database:           process.env.DB_NAME,
    charset:            'utf8mb4',
    multipleStatements: false,
  });

  try {
    console.log(`[MIGRATE] ✅ Connected → ${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME}`);

    const raw = fs.readFileSync(SQL_FILE, 'utf8');

    // Split on semicolons, strip comment-only lines
    const stmts = raw
      .split(';')
      .map(s => s.replace(/--[^\n]*/g, '').trim())
      .filter(s => s.length > 5);

    let inserted = 0, skipped = 0, errors = 0;

    for (const stmt of stmts) {
      const preview = stmt.replace(/\s+/g, ' ').substring(0, 80);
      try {
        const [result] = await conn.execute(stmt);
        const affected = result.affectedRows ?? 0;
        if (affected > 0) {
          inserted += affected;
          console.log(`  ✅ +${affected} rows  |  ${preview}...`);
        } else {
          skipped++;
          console.log(`  ⏭  already exists  |  ${preview}...`);
        }
      } catch (err) {
        errors++;
        console.error(`  ❌ ${err.message}`);
        console.error(`     → ${preview}...`);
      }
    }

    console.log('');
    console.log(`[MIGRATE] สรุป: inserted=${inserted} | skipped=${skipped} | errors=${errors}`);
    if (errors === 0) {
      console.log('[MIGRATE] ✅ Migration สำเร็จ — พร้อม deploy!');
    } else {
      console.log('[MIGRATE] ⚠️  มีบาง error — ดูด้านบน');
    }
  } finally {
    await conn.end();
  }
}

run().catch(err => {
  console.error('[MIGRATE] Fatal:', err.message);
  process.exit(1);
});
