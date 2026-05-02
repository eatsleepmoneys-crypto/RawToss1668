const mysql = require('mysql2/promise');
async function run() {
  const conn = await mysql.createConnection('mysql://root:PvVMLMHgnWmiXMycGqljKExWDAaDVjFe@ballast.proxy.rlwy.net:23694/railway');

  const now = new Date();
  const ict = new Date(now.getTime() + 7 * 3600 * 1000);
  const yyyy = ict.getUTCFullYear();
  const mm   = String(ict.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ict.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}${mm}${dd}`;

  const [[lt]] = await conn.execute("SELECT id FROM lottery_types WHERE code='laos'");
  if (!lt) { console.log('laos type not found'); await conn.end(); return; }

  const roundCode = `LAOS-${dateStr}`;
  const [[existing]] = await conn.execute('SELECT id FROM lottery_rounds WHERE round_code=?', [roundCode]);
  
  if (existing) {
    console.log(`[SKIP] ${roundCode} already exists (id=${existing.id})`);
  } else {
    const openAt  = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), 9  - 7, 0));
    const closeAt = new Date(Date.UTC(yyyy, ict.getUTCMonth(), ict.getUTCDate(), 19 - 7, 20));
    await conn.execute(
      `INSERT INTO lottery_rounds (lottery_type_id, round_code, round_name, open_at, close_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'open', NULL)`,
      [lt.id, roundCode, `หวยลาว ${dd}/${mm}/${yyyy}`, openAt, closeAt]
    );
    console.log(`[CREATED] ${roundCode} | close: ${closeAt.toISOString()}`);
  }

  const [rounds] = await conn.execute(`
    SELECT r.id, r.round_code, r.status, r.open_at, r.close_at
    FROM lottery_rounds r JOIN lottery_types lt ON r.lottery_type_id=lt.id
    WHERE lt.code='laos' ORDER BY r.close_at DESC LIMIT 3
  `);
  console.log('\n--- Lao Rounds ---');
  console.log(JSON.stringify(rounds, null, 2));
  await conn.end();
}
run().catch(e => console.error(e.message));
