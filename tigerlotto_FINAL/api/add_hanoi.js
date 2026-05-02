const mysql = require('mysql2/promise');
async function run() {
  const conn = await mysql.createConnection('mysql://root:PvVMLMHgnWmiXMycGqljKExWDAaDVjFe@ballast.proxy.rlwy.net:23694/railway');
  
  // เช็คก่อนว่ามีอยู่แล้วไหม
  const [existing] = await conn.execute("SELECT id, code, name FROM lottery_types WHERE code IN ('hanoi_vip','hanoi_special','hanoi')");
  console.log('Existing hanoi types:', JSON.stringify(existing, null, 2));

  // เพิ่ม 3 ประเภท (ถ้ายังไม่มี)
  const types = [
    { code: 'hanoi', name: 'หวยฮานอยปกติ' },
    { code: 'hanoi_vip', name: 'หวยฮานอย VIP' },
    { code: 'hanoi_special', name: 'หวยฮานอยพิเศษ' },
  ];

  for (const t of types) {
    const [found] = await conn.execute("SELECT id FROM lottery_types WHERE code=?", [t.code]);
    if (found.length > 0) {
      console.log(`[SKIP] ${t.code} already exists`);
    } else {
      await conn.execute(
        "INSERT INTO lottery_types (code, name, is_active) VALUES (?, ?, 1)",
        [t.code, t.name]
      );
      console.log(`[ADDED] ${t.code} - ${t.name}`);
    }
  }

  const [all] = await conn.execute("SELECT id, code, name FROM lottery_types ORDER BY id");
  console.log('All lottery_types:', JSON.stringify(all, null, 2));
  await conn.end();
}
run().catch(e => console.error(e.message));
