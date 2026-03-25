/**
 * hanoiScraper.js
 * ดึงผลหวยฮานอย 3 ประเภทจาก sanook.com อัตโนมัติ
 * 
 * เวลาออกผล (ICT UTC+7):
 *   ฮานอยพิเศษ  → ~17:30 น. → scrape 17:35
 *   ฮานอยปกติ  → ~18:30 น. → scrape 18:35
 *   ฮานอย VIP  → ~19:30 น. → scrape 19:35
 */

const axios = require('axios');
const { query, queryOne } = require('../config/db');
const { processPayouts } = require('../controllers/resultController');

const SANOOK_URL = 'https://www.sanook.com/news/archive/hanoi-lottery/';

// map ชื่อ -> lottery_types.code ใน DB
const HANOI_TYPES = {
  special: 'hanoi_special',   // ฮานอยพิเศษ
  normal:  'hanoi',           // ฮานอยปกติ
  vip:     'hanoi_vip',       // ฮานอย VIP
};

// ── scrape ผลจาก sanook ──────────────────────────────────────
async function fetchHanoiResults() {
  const res = await axios.get('https://www.sanook.com/news/9837690/', {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TigerLottoBot/1.0)' }
  });

  const html = res.data;
  const results = {};

  // pattern หาแต่ละ block: "เลข 4 ตัว : XXXX"
  const pattern4 = /เลข\s*4\s*ตัว\s*:\s*(\d{4})/g;
  const pattern2back = /เลข\s*2\s*ตัวล่าง\s*:\s*(\d{2})/g;

  const matches4 = [...html.matchAll(pattern4)];
  const matches2back = [...html.matchAll(pattern2back)];

  // วันนี้ block แรก = special, 2 = normal, 3 = vip
  // (sanook เรียงตามลำดับ: เฉพาะกิจ, พิเศษ, ปกติ, vip)
  // sanook page นี้มี 4 ประเภท แต่เราใช้แค่ 3 (พิเศษ=idx1, ปกติ=idx2, vip=idx3)
  if (matches4.length >= 4) {
    results.special = {
      result_first: matches4[1][1],
      result_2_back: matches2back[1]?.[1] || null,
      result_3_back1: matches4[1][1].slice(-3),
      result_3_back2: null,
      result_3_front1: matches4[1][1].slice(0, 3),
      result_3_front2: null,
    };
    results.normal = {
      result_first: matches4[2][1],
      result_2_back: matches2back[2]?.[1] || null,
      result_3_back1: matches4[2][1].slice(-3),
      result_3_back2: null,
      result_3_front1: matches4[2][1].slice(0, 3),
      result_3_front2: null,
    };
    results.vip = {
      result_first: matches4[3][1],
      result_2_back: matches2back[3]?.[1] || null,
      result_3_back1: matches4[3][1].slice(-3),
      result_3_back2: null,
      result_3_front1: matches4[3][1].slice(0, 3),
      result_3_front2: null,
    };
  } else if (matches4.length >= 1) {
    // fallback: ถ้าออกแค่บางประเภท
    throw new Error(`Only ${matches4.length} hanoi results found (expected 4+)`);
  } else {
    throw new Error('Cannot parse hanoi results from sanook');
  }

  return results;
}

// ── หา round_id ของประเภทนั้น status=closed วันนี้ ───────────
async function findClosedRound(typeCode) {
  const row = await queryOne(`
    SELECT r.id
    FROM lottery_rounds r
    JOIN lottery_types lt ON r.lottery_type_id = lt.id
    WHERE lt.code = ?
      AND r.status = 'closed'
      AND DATE(r.close_at) = CURDATE()
    ORDER BY r.close_at DESC
    LIMIT 1
  `, [typeCode]);
  return row ? row.id : null;
}

// ── enter ผล ────────────────────────────────────────────────
async function enterResult(roundId, result, label) {
  const existing = await queryOne('SELECT id FROM lottery_results WHERE round_id=?', [roundId]);
  if (existing) {
    console.log(`[HANOI] ${label} round ${roundId} already resulted — skip`);
    return false;
  }
  await query(
    `INSERT INTO lottery_results
     (round_id,result_first,result_2_back,result_3_back1,result_3_back2,result_3_front1,result_3_front2,entered_by,entered_at)
     VALUES (?,?,?,?,?,?,?,0,NOW())`,
    [roundId,
     result.result_first,
     result.result_2_back || null,
     result.result_3_back1 || null,
     result.result_3_back2 || null,
     result.result_3_front1 || null,
     result.result_3_front2 || null]
  );
  await query("UPDATE lottery_rounds SET status='resulted', result_at=NOW() WHERE id=?", [roundId]);
  console.log(`[HANOI] ${label} round ${roundId} => ${result.result_first}`);
  return true;
}

// ── run scraper สำหรับ 1 ประเภท ─────────────────────────────
async function runHanoiType(typeKey) {
  const typeCode = HANOI_TYPES[typeKey];
  const label = { special: 'พิเศษ', normal: 'ปกติ', vip: 'VIP' }[typeKey];

  try {
    const allResults = await fetchHanoiResults();
    const result = allResults[typeKey];
    if (!result) throw new Error(`No result for ${typeKey}`);

    const roundId = await findClosedRound(typeCode);
    if (!roundId) {
      console.log(`[HANOI] ${label}: no closed round today — skip`);
      return;
    }

    const entered = await enterResult(roundId, result, label);
    if (entered) {
      processPayouts(roundId, result).catch(err =>
        console.error(`[HANOI] ${label} payout error:`, err)
      );
    }
  } catch (err) {
    console.error(`[HANOI] ${label} error:`, err.message);
  }
}

module.exports = { runHanoiType, fetchHanoiResults };
