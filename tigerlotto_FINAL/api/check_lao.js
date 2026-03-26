const mysql = require('mysql2/promise');
async function run() {
  const conn = await mysql.createConnection('mysql://root:PvVMLMHgnWmiXMycGqljKExWDAaDVjFe@ballast.proxy.rlwy.net:23694/railway');
  
  const [rounds] = await conn.execute(`
    SELECT r.id, r.round_code, r.round_name, r.status, r.open_at, r.close_at, lt.code, lt.name
    FROM lottery_rounds r
    JOIN lottery_types lt ON r.lottery_type_id = lt.id
    WHERE lt.code = 'laos'
    ORDER BY r.close_at DESC
    LIMIT 5
  `);
  console.log('--- Lao Rounds (latest 5) ---');
  console.log(JSON.stringify(rounds, null, 2));

  const [results] = await conn.execute(`
    SELECT lr.*, r.round_code FROM lottery_results lr
    JOIN lottery_rounds r ON lr.round_id = r.id
    JOIN lottery_types lt ON r.lottery_type_id = lt.id
    WHERE lt.code = 'laos'
    ORDER BY lr.entered_at DESC
    LIMIT 3
  `);
  console.log('--- Lao Results (latest 3) ---');
  console.log(JSON.stringify(results, null, 2));

  await conn.end();
}
run().catch(e => console.error(e.message));
