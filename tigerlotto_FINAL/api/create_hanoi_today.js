const mysql = require('mysql2/promise');
async function run() {
  const conn = await mysql.createConnection('mysql://root:PvVMLMHgnWmiXMycGqljKExWDAaDVjFe@ballast.proxy.rlwy.net:23694/railway');
  
  const schedule = [
    { code: 'hanoi_special', name: 'ฮานอยพิเศษ',  openH: 9, openM: 0, closeH: 17, closeM: 0 },
    { code: 'hanoi',         name: 'ฮานอยปกติ',   openH: 9, openM: 0, closeH: 18, closeM: 0 },
    { code: 'hanoi_vip',     name: 'ฮานอย VIP',   openH: 9, openM: 0, closeH: 19, closeM: 0 },
  ];

  const now = new Date();
  const ict = new Date(now.getTime() + 7 * 3600 * 1000);
  const yyyy = ict.getUTCFullYear();
  const mm   = String(ict.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ict.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}${mm}${dd}`;

  for (const s of schedule) {
    const [ltRows] = await conn.execute('SELECT id FROM lottery_types WHERE code=?', [s.code]);
    if (!ltRows.length) { console.log(`[SKIP] type ${s.code} not found`); continue; }
    const ltId = ltRows[0].id;

    const roundCode = `${s.code.toUpperCase()}-${dateStr}`;
    const [existing] = await conn.execute('SELECT id FROM lottery_rounds WHERE round_code=?', [roundCode]);
    if (existing.length) { console.log(`[SKIP] ${roundCode} already exists`); continue; }

    const openAt  = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), s.openH  - 7, s.openM));
    const closeAt = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), s.closeH - 7, s.closeM));

    await conn.execute(
      `INSERT INTO lottery_rounds (lottery_type_id, round_code, round_name, open_at, close_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'open', NULL)`,
      [ltId, roundCode, `${s.name} ${dd}/${mm}/${yyyy}`, openAt, closeAt]
    );
    console.log(`[CREATED] ${roundCode} | close: ${closeAt.toISOString()}`);
  }

  const [rounds] = await conn.execute(`
    SELECT r.id, r.round_code, r.status, r.close_at, lt.name
    FROM lottery_rounds r JOIN lottery_types lt ON r.lottery_type_id=lt.id
    WHERE lt.code IN ('hanoi','hanoi_vip','hanoi_special')
    ORDER BY r.close_at
  `);
  console.log('\n--- Hanoi Rounds Today ---');
  console.log(JSON.stringify(rounds, null, 2));
  await conn.end();
}
run().catch(e => console.error(e.message));
