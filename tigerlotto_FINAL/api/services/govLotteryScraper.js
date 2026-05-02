/**
 * govLotteryScraper.js
 * ดึงผลหวยรัฐบาลไทยอัตโนมัติ
 * ออกรางวัลวันที่ 1 และ 16 ของทุกเดือน เวลา ~15:00-16:00 น.
 * Scrape 16:30 น. และ retry 17:00 น.
 */

const axios = require('axios');
const { query, queryOne } = require('../config/db');
const { processPayouts } = require('../controllers/resultController');

const GOV_TYPE_CODE = 'gov';

// ── เช็คว่าวันนี้เป็นวันออกหวยไทยไหม (1 หรือ 16 ของเดือน ICT) ──
function isGovLotteryDay() {
  const ict = new Date(Date.now() + 7 * 3600 * 1000);
  const d = ict.getUTCDate();
  return d === 1 || d === 16;
}

// ── scrape ผลจาก Sanook ────────────────────────────────────────
async function fetchGovLotteryResult() {
  // หา URL ข่าวผลหวยวันนี้จาก Sanook
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const d  = now.getUTCDate();
  const m  = now.getUTCMonth() + 1;
  const y  = now.getUTCFullYear();
  const thaiYear = y + 543;

  // Sanook มักลง URL แบบ /news/XXXXXXX/ ไม่มี pattern ตายตัว
  // ใช้ search page แทน
  const searchUrl = `https://www.sanook.com/news/archive/lotto/?q=${d}%2F${m}%2F${thaiYear}`;

  const r = await axios.get(searchUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' }
  });

  const html = r.data;

  // pattern: เลข 6 ตัว รางวัลที่ 1
  // Sanook ใส่ผลหวยไทยในรูปแบบ: "รางวัลที่ 1 : XXXXXX" หรือ class prize
  const first6 = html.match(/รางวัลที่\s*1[^<]{0,50}(\d{6})/);
  const back2  = html.match(/สองตัวล่าง[^<]{0,50}(\d{2})/);
  const back3  = html.match(/สามตัวล่าง[^<]{0,50}(\d{3})/);
  const front3 = html.match(/สามตัวหน้า[^<]{0,100}(\d{3})[^<]{0,100}(\d{3})/);

  if (!first6) throw new Error('Cannot parse gov lottery result from Sanook');

  return {
    result_first: first6[1],
    result_2_back: back2?.[1] || first6[1].slice(-2),
    result_3_back1: back3?.[1] || first6[1].slice(-3),
    result_3_back2: null,
    result_3_front1: front3?.[1] || null,
    result_3_front2: front3?.[2] || null,
  };
}

// ── หา round หวยไทยที่ status=closed วันนี้ ─────────────────────
async function findClosedGovRound() {
  const row = await queryOne(`
    SELECT r.id
    FROM lottery_rounds r
    JOIN lottery_types lt ON r.lottery_type_id = lt.id
    WHERE lt.code = ?
      AND r.status = 'closed'
      AND DATE(r.close_at) = CURDATE()
    ORDER BY r.close_at DESC
    LIMIT 1
  `, [GOV_TYPE_CODE]);
  return row ? row.id : null;
}

// ── enter ผล ────────────────────────────────────────────────────
async function enterResult(roundId, result) {
  const existing = await queryOne('SELECT id FROM lottery_results WHERE round_id=?', [roundId]);
  if (existing) {
    console.log(`[GOV] round ${roundId} already resulted — skip`);
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
  console.log(`[GOV] round ${roundId} => ${result.result_first}`);
  return true;
}

// ── main ────────────────────────────────────────────────────────
async function runGovScraper() {
  if (!isGovLotteryDay()) {
    console.log('[GOV] Not lottery day — skip');
    return;
  }

  console.log('[GOV] Starting scraper...');
  try {
    const result = await fetchGovLotteryResult();
    console.log(`[GOV] Fetched: ${result.result_first}`);

    const roundId = await findClosedGovRound();
    if (!roundId) {
      console.log('[GOV] No closed round found today — skip');
      return;
    }

    const entered = await enterResult(roundId, result);
    if (entered) {
      processPayouts(roundId, result).catch(err =>
        console.error('[GOV] Payout error:', err)
      );
    }
  } catch (err) {
    console.error('[GOV] Error:', err.message);
  }
}

module.exports = { runGovScraper, isGovLotteryDay };
