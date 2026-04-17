/**
 * seed-history.js
 * ─────────────────────────────────────────────────────────────────
 * เพิ่มงวดหวยย้อนหลัง 1 งวด (ทุกประเภท ยกเว้น YEEKEE)
 * พร้อมผลรางวัลจำลองที่เหมือนจริง
 *
 * รัน: node database/seed-history.js
 * หรือ: npm run seed:history
 *
 * หมายเหตุ: ใช้ INSERT IGNORE — รันซ้ำได้ไม่มีผลข้างเคียง
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mysql = require('mysql2/promise');

/* ─── DB Connection (same pattern as migrate.js) ─── */
function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: parseInt(u.port)||3306, user: u.username, password: u.password, database: u.pathname.replace('/','') };
  } catch { return null; }
}

/* ─── ข้อมูลงวดย้อนหลัง ─────────────────────────────────── */
// draw_date = วันออกผล (ที่ผ่านมาแล้ว)
const HISTORY = [
  {
    code       : 'TH_GOV',
    round_code : 'TH_GOV-20260401',
    round_name : 'งวดวันที่ 1 เมษายน 2569',
    draw_date  : '2026-04-01',
    close_at   : '2026-04-01 14:30:00',
    announced_at: '2026-04-01 15:30:00',
    total_bet  : 158000,
    total_win  : 73500,
    bet_count  : 312,
    result: {
      prize_1st    : '916894',
      prize_last_2 : '17',
      prize_front_3: ['293', '635'],
      prize_last_3 : ['149', '274'],
    },
  },
  {
    code       : 'TH_GOV',
    round_code : 'TH_GOV-20260416',
    round_name : 'งวดวันที่ 16 เมษายน 2569',
    draw_date  : '2026-04-16',
    close_at   : '2026-04-16 14:30:00',
    announced_at: '2026-04-16 15:30:00',
    total_bet  : 214000,
    total_win  : 98500,
    bet_count  : 427,
    result: {
      prize_1st    : '483621',
      prize_last_2 : '54',
      prize_front_3: ['512', '867'],
      prize_last_3 : ['321', '048'],
    },
  },
  {
    code       : 'LA_GOV',
    round_code : 'LA_GOV-20260416',
    round_name : 'งวดวันที่ 16 เมษายน 2569',
    draw_date  : '2026-04-16',
    close_at   : '2026-04-16 20:00:00',
    announced_at: '2026-04-16 20:45:00',
    total_bet  : 42500,
    total_win  : 18200,
    bet_count  : 98,
    result: {
      prize_1st    : '85241',
      prize_last_2 : '41',
      prize_front_3: [],
      prize_last_3 : ['241'],
    },
  },
  {
    code       : 'VN_HAN',
    round_code : 'VN_HAN-20260416',
    round_name : 'งวดวันที่ 16 เมษายน 2569',
    draw_date  : '2026-04-16',
    close_at   : '2026-04-16 18:15:00',
    announced_at: '2026-04-16 18:45:00',
    total_bet  : 35000,
    total_win  : 14700,
    bet_count  : 76,
    result: {
      prize_1st    : '72638',
      prize_last_2 : '38',
      prize_front_3: [],
      prize_last_3 : ['638'],
    },
  },
  {
    code       : 'TH_STK',
    round_code : 'TH_STK-20260416',
    round_name : 'งวดวันที่ 16 เมษายน 2569',
    draw_date  : '2026-04-16',
    close_at   : '2026-04-16 17:00:00',
    announced_at: '2026-04-16 17:30:00',
    total_bet  : 29500,
    total_win  : 11200,
    bet_count  : 65,
    result: {
      prize_1st    : '438712',
      prize_last_2 : '12',
      prize_front_3: [],
      prize_last_3 : ['712'],
    },
  },
  {
    code       : 'CN_STK',
    round_code : 'CN_STK-20260415',
    round_name : 'งวดวันที่ 15 เมษายน 2569',
    draw_date  : '2026-04-15',
    close_at   : '2026-04-15 15:30:00',
    announced_at: '2026-04-15 16:00:00',
    total_bet  : 22000,
    total_win  : 8900,
    bet_count  : 51,
    result: {
      prize_1st    : '307524',
      prize_last_2 : '24',
      prize_front_3: [],
      prize_last_3 : ['524'],
    },
  },
  {
    code       : 'MY_STK',
    round_code : 'MY_STK-20260416',
    round_name : 'งวดวันที่ 16 เมษายน 2569',
    draw_date  : '2026-04-16',
    close_at   : '2026-04-16 17:30:00',
    announced_at: '2026-04-16 18:00:00',
    total_bet  : 18500,
    total_win  : 7200,
    bet_count  : 43,
    result: {
      prize_1st    : '619083',
      prize_last_2 : '83',
      prize_front_3: [],
      prize_last_3 : ['083'],
    },
  },
  {
    code       : 'SG_STK',
    round_code : 'SG_STK-20260415',
    round_name : 'งวดวันที่ 15 เมษายน 2569',
    draw_date  : '2026-04-15',
    close_at   : '2026-04-15 18:00:00',
    announced_at: '2026-04-15 18:30:00',
    total_bet  : 16000,
    total_win  : 6100,
    bet_count  : 38,
    result: {
      prize_1st    : '524167',
      prize_last_2 : '67',
      prize_front_3: [],
      prize_last_3 : ['167'],
    },
  },
];

/* ─── Main ─────────────────────────────────────────────────── */
async function seedHistory() {
  console.log('\n🌱 TigerLotto — Seed Historical Rounds\n');

  const dbUrl  = process.env.DATABASE_URL || process.env.MYSQL_URL;
  const parsed = dbUrl ? parseDbUrl(dbUrl) : null;

  const connConfig = {
    host    : parsed?.host     || process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
    port    : parsed?.port     || process.env.DB_PORT     || process.env.MYSQLPORT     || 3306,
    database: parsed?.database || process.env.DB_NAME     || process.env.MYSQLDATABASE || 'railway',
    user    : parsed?.user     || process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
    password: parsed?.password || process.env.DB_PASS     || process.env.MYSQLPASSWORD || '',
    charset : 'utf8mb4',
    ssl     : process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };

  console.log(`   DB: ${connConfig.host}:${connConfig.port} / ${connConfig.database}\n`);

  const conn = await mysql.createConnection(connConfig);

  // ── ดึง lottery_type id ทั้งหมดที่ต้องการ ──────────────────────
  const codes = HISTORY.map(h => h.code);
  const [typeRows] = await conn.query(
    `SELECT id, code FROM lottery_types WHERE code IN (${codes.map(()=>'?').join(',')})`,
    codes
  );
  const typeMap = {};
  typeRows.forEach(r => { typeMap[r.code] = r.id; });

  let ok = 0, skip = 0, fail = 0;

  for (const h of HISTORY) {
    const lotteryId = typeMap[h.code];
    if (!lotteryId) {
      console.warn(`   ⚠️  ไม่พบ lottery_type code="${h.code}" — ข้าม`);
      skip++;
      continue;
    }

    try {
      await conn.beginTransaction();

      // 1. Insert round (INSERT IGNORE — ข้ามถ้ามีแล้ว)
      const [rRes] = await conn.execute(
        `INSERT IGNORE INTO lottery_rounds
           (uuid, lottery_id, round_code, round_name, draw_date, close_at,
            status, total_bet, total_win, bet_count)
         VALUES (UUID(), ?, ?, ?, ?, ?, 'announced', ?, ?, ?)`,
        [lotteryId, h.round_code, h.round_name, h.draw_date, h.close_at,
         h.total_bet, h.total_win, h.bet_count]
      );

      if (rRes.affectedRows === 0) {
        await conn.rollback();
        console.log(`   ⏩  ${h.code} — งวด ${h.round_code} มีอยู่แล้ว (ข้าม)`);
        skip++;
        continue;
      }

      const roundId = rRes.insertId;

      // 2. Insert result (INSERT IGNORE)
      await conn.execute(
        `INSERT IGNORE INTO lottery_results
           (round_id, prize_1st, prize_last_2, prize_front_3, prize_last_3, announced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [roundId,
         h.result.prize_1st,
         h.result.prize_last_2,
         JSON.stringify(h.result.prize_front_3),
         JSON.stringify(h.result.prize_last_3),
         h.announced_at]
      );

      await conn.commit();
      console.log(`   ✅  ${h.code} — ${h.round_name} (prize_1st: ${h.result.prize_1st}, ท้าย 2: ${h.result.prize_last_2})`);
      ok++;

    } catch (e) {
      await conn.rollback();
      console.error(`   ❌  ${h.code} — ERROR: ${e.message}`);
      fail++;
    }
  }

  await conn.end();

  console.log(`\n─────────────────────────────────────`);
  console.log(`   ✅ สำเร็จ : ${ok} งวด`);
  if (skip) console.log(`   ⏩ ข้าม   : ${skip} งวด (มีอยู่แล้ว)`);
  if (fail) console.log(`   ❌ ผิดพลาด: ${fail} งวด`);
  console.log(`─────────────────────────────────────\n`);

  process.exit(fail > 0 ? 1 : 0);
}

seedHistory().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
