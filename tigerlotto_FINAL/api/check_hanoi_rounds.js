const mysql = require('mysql2/promise');
async function run() {
  const conn = await mysql.createConnection('mysql://root:PvVMLMHgnWmiXMycGqljKExWDAaDVjFe@ballast.proxy.rlwy.net:23694/railway');
  
  const [rounds] = await conn.execute(`
    SELECT r.id, r.round_code, r.status, r.open_at, r.close_at, lt.code, lt.name
    FROM lottery_rounds r
    JOIN lottery_types lt ON r.lottery_type_id = lt.id
    WHERE lt.code IN ('hanoi','hanoi_vip','hanoi_special')
    ORDER BY r.close_at DESC
    LIMIT 10
  `);
  console.log('--- Hanoi Rounds ---');
  console.log(JSON.stringify(rounds, null, 2));
  await conn.end();
}
run().catch(e => console.error(e.message));
