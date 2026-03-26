/**
 * seed_historical.js
 * ดึงผลหวยย้อนหลัง 1 ปี แล้วบันทึกเข้า DB
 * รัน: node seed_historical.js
 */

const axios = require('axios');
const mysql = require('mysql2/promise');

const DB_URL = 'mysql://root:PvVMLMHgnWmiXMycGqljKExWDAaDVjFe@ballast.proxy.rlwy.net:23694/railway';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toMySQLDT(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

// ── parse articleBody จาก Sanook JSON-LD ─────────────────────
function parseArticleBody(html) {
  const m = html.match(/"articleBody"\s*:\s*"([\s\S]+?)"\s*,\s*"author"/);
  if (!m) return null;
  // unescape JSON string
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch(e) {
    return m[1].replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/&nbsp;/g, ' ');
  }
}

// ── หวยรัฐบาล ──────────────────────────────────────────────
async function fetchGovResult(d, m, y) {
  const thYear = y + 543;
  const url = `https://news.sanook.com/lotto/check/${String(d).padStart(2,'0')}${String(m).padStart(2,'0')}${thYear}`;
  const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  const body = parseArticleBody(r.data);
  if (!body) return null;

  const firstMatch  = body.match(/รางวัลที่ 1[^\r\n]*[\r\n]+(\d{6})/);
  const back2Match  = body.match(/เลขท้าย 2 ตัว[^\r\n]*[\r\n]+(\d{2})/);
  const back3Match  = body.match(/เลขท้าย 3 ตัว[^\r\n]*[\r\n]+([\d\s]+)/);
  const front3Match = body.match(/เลขหน้า 3 ตัว[^\r\n]*[\r\n]+([\d\s&;nbsp]+)/);

  if (!firstMatch) return null;

  const back3nums  = back3Match?.[1]?.replace(/&nbsp;/g,' ').trim().split(/\s+/).filter(n => n.match(/^\d{3}$/)) || [];
  const front3nums = front3Match?.[1]?.replace(/&nbsp;/g,' ').trim().split(/\s+/).filter(n => n.match(/^\d{3}$/)) || [];

  return {
    result_first:   firstMatch[1],
    result_2_back:  back2Match?.[1]  || firstMatch[1].slice(-2),
    result_3_back1: back3nums[0]     || firstMatch[1].slice(-3),
    result_3_back2: back3nums[1]     || null,
    result_3_front1: front3nums[0]   || null,
    result_3_front2: front3nums[1]   || null,
  };
}

// ── หวยลาว ─────────────────────────────────────────────────
async function fetchLaoResult(d, m, y) {
  const thYear = y + 543;
  const dd = String(d).padStart(2,'0'), mm = String(m).padStart(2,'0');
  const url = `https://www.sanook.com/news/archive/laolotto/?date=${dd}%2F${mm}%2F${thYear}`;
  const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = r.data;
  const match4    = html.match(/เลข\s*4\s*ตัว\s*:\s*(\d{4})/);
  const match2back = html.match(/เลข\s*2\s*ตัวล่าง\s*:\s*(\d{2})/);
  if (!match4) return null;
  const first = match4[1];
  return {
    result_first:   first,
    result_2_back:  match2back?.[1] || first.slice(-2),
    result_3_back1: first.slice(-3),
    result_3_back2: null,
    result_3_front1: first.slice(0,3),
    result_3_front2: null,
  };
}

// ── หวยฮานอย ───────────────────────────────────────────────
async function fetchHanoiResult(d, m, y) {
  const thYear = y + 543;
  const dd = String(d).padStart(2,'0'), mm = String(m).padStart(2,'0');
  // ลอง sanook hanoi archive
  const url = `https://www.sanook.com/news/archive/hanoi-lottery/?date=${dd}%2F${mm}%2F${thYear}`;
  const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = r.data;
  const pattern4    = /เลข\s*4\s*ตัว\s*:\s*(\d{4})/g;
  const pattern2back = /เลข\s*2\s*ตัวล่าง\s*:\s*(\d{2})/g;
  const matches4    = [...html.matchAll(pattern4)];
  const matches2back = [...html.matchAll(pattern2back)];
  if (matches4.length < 4) return null;
  const make = (idx) => ({
    result_first:    matches4[idx][1],
    result_2_back:   matches2back[idx]?.[1] || matches4[idx][1].slice(-2),
    result_3_back1:  matches4[idx][1].slice(-3),
    result_3_back2:  null,
    result_3_front1: matches4[idx][1].slice(0,3),
    result_3_front2: null,
  });
  return { special: make(1), normal: make(2), vip: make(3) };
}

// ── insert round + result ────────────────────────────────────
async function insertRoundAndResult(conn, typeCode, roundCode, roundName, openAt, closeAt, result) {
  const [[lt]] = await conn.execute('SELECT id FROM lottery_types WHERE code=?', [typeCode]);
  if (!lt) return false;

  let [[existing]] = await conn.execute('SELECT id FROM lottery_rounds WHERE round_code=?', [roundCode]);
  let roundId;
  if (existing) {
    roundId = existing.id;
  } else {
    const [ins] = await conn.execute(
      `INSERT INTO lottery_rounds (lottery_type_id, round_code, round_name, open_at, close_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'resulted', NULL)`,
      [lt.id, roundCode, roundName, toMySQLDT(openAt), toMySQLDT(closeAt)]
    );
    roundId = ins.insertId;
  }

  const [[existingResult]] = await conn.execute('SELECT id FROM lottery_results WHERE round_id=?', [roundId]);
  if (existingResult) return false;

  await conn.execute(
    `INSERT INTO lottery_results
     (round_id,result_first,result_2_back,result_3_back1,result_3_back2,result_3_front1,result_3_front2,entered_by,entered_at)
     VALUES (?,?,?,?,?,?,?,0,?)`,
    [roundId,
     result.result_first, result.result_2_back||null,
     result.result_3_back1||null, result.result_3_back2||null,
     result.result_3_front1||null, result.result_3_front2||null,
     toMySQLDT(closeAt)]
  );
  await conn.execute("UPDATE lottery_rounds SET status='resulted', result_at=? WHERE id=?", [toMySQLDT(closeAt), roundId]);
  return true;
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  const conn = await mysql.createConnection(DB_URL);
  console.log('✅ Connected to DB');

  const endDate   = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);

  let govCount = 0, laoCount = 0, hanoiCount = 0, errors = 0;
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));

  while (cursor <= endDate) {
    const y  = cursor.getUTCFullYear();
    const m  = cursor.getUTCMonth() + 1;
    const d  = cursor.getUTCDate();
    const dd = String(d).padStart(2,'0');
    const mm = String(m).padStart(2,'0');
    const yyyymmdd = `${y}${mm}${dd}`;
    const dateLabel = `${dd}/${mm}/${y}`;
    const dow = cursor.getDay(); // 0=sun,6=sat

    // ── หวยรัฐบาล (1 และ 16) ──
    if (d === 1 || d === 16) {
      try {
        process.stdout.write(`[GOV] ${dateLabel} `);
        const res = await fetchGovResult(d, m, y);
        if (res) {
          const ok = await insertRoundAndResult(conn, 'gov',
            `GOV-${yyyymmdd}`, `หวยรัฐบาล ${dateLabel}`,
            new Date(Date.UTC(y,m-1,d,0,0,0)),
            new Date(Date.UTC(y,m-1,d,8,0,0)), res);
          console.log(ok ? `✅ ${res.result_first}` : '⏭️ exists');
          if (ok) govCount++;
        } else { console.log('❌ no data'); errors++; }
      } catch(e) { console.log('❌', e.message.slice(0,40)); errors++; }
      await sleep(1500);
    }

    // ── หวยลาว (จ-ศ) ──
    if (dow >= 1 && dow <= 5) {
      try {
        process.stdout.write(`[LAO] ${dateLabel} `);
        const res = await fetchLaoResult(d, m, y);
        if (res) {
          const ok = await insertRoundAndResult(conn, 'laos',
            `LAOS-${yyyymmdd}`, `หวยลาว ${dateLabel}`,
            new Date(Date.UTC(y,m-1,d,2,0,0)),
            new Date(Date.UTC(y,m-1,d,12,20,0)), res);
          console.log(ok ? `✅ ${res.result_first}` : '⏭️ exists');
          if (ok) laoCount++;
        } else { console.log('❌ no data'); errors++; }
      } catch(e) { console.log('❌', e.message.slice(0,40)); errors++; }
      await sleep(1000);
    }

    // ── ฮานอย (ทุกวัน) ──
    try {
      process.stdout.write(`[HANOI] ${dateLabel} `);
      const results = await fetchHanoiResult(d, m, y);
      if (results) {
        const types = [
          { key:'special', code:'hanoi_special', name:'ฮานอยพิเศษ', closeH:10 },
          { key:'normal',  code:'hanoi',         name:'ฮานอยปกติ',  closeH:11 },
          { key:'vip',     code:'hanoi_vip',     name:'ฮานอย VIP',  closeH:12 },
        ];
        let added = 0;
        for (const t of types) {
          if (!results[t.key]) continue;
          const ok = await insertRoundAndResult(conn, t.code,
            `${t.code.toUpperCase()}-${yyyymmdd}`, `${t.name} ${dateLabel}`,
            new Date(Date.UTC(y,m-1,d,2,0,0)),
            new Date(Date.UTC(y,m-1,d,t.closeH,0,0)), results[t.key]);
          if (ok) { added++; hanoiCount++; }
        }
        console.log(added > 0 ? `✅ ${added} types` : '⏭️ exists');
      } else { console.log('❌ no data'); errors++; }
    } catch(e) { console.log('❌', e.message.slice(0,40)); errors++; }
    await sleep(1000);

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  await conn.end();
  console.log(`\n🏁 Done! Gov:${govCount} Lao:${laoCount} Hanoi:${hanoiCount} Errors:${errors}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
