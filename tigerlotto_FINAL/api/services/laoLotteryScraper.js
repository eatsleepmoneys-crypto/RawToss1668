/**
 * laoLotteryScraper.js
 * ดึงผลหวยลาวจาก laosassociationlottery.com อัตโนมัติ
 * ออกทุกวัน เวลา ~19:55 น. (ICT, UTC+7)
 */

const axios = require('axios');
const { query, queryOne } = require('../config/db');
const { processPayouts } = require('../controllers/resultController');

const LOTTO_URL = 'https://laosassociationlottery.com/en/home/';
const LAO_TYPE_CODE = 'laos'; // lottery_types.code ในฐานข้อมูล

// ── scrape ผลล่าสุดจากเว็บ ──────────────────────────────────────
async function fetchLatestLaoResult() {
  const res = await axios.get(LOTTO_URL, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TigerLottoBot/1.0)' }
  });

  const html = res.data;

  // ดึงวันที่ล่าสุด (h5 แรก)
  const dateMatch = html.match(/<h5[^>]*>\s*([\w]+day,\s[\d]+ [\w]+ [\d]+)\s*<\/h5>/i);
  const dateStr = dateMatch ? dateMatch[1].trim() : null;

  // ดึง 1st Prize (4 หลัก)
  // pattern: <p class="...1st...">digit...
  const prize1Match = html.match(/1st Prize[\s\S]{0,200}?(\d)\s*<\/span>[\s\S]{0,50}?(\d)\s*<\/span>[\s\S]{0,50}?(\d)\s*<\/span>[\s\S]{0,50}?(\d)\s*<\/span>/i);

  // fallback: ดึงตัวเลขจาก block แรก
  let first = null;
  if (prize1Match) {
    first = prize1Match[1] + prize1Match[2] + prize1Match[3] + prize1Match[4];
  } else {
    // parse แบบ simple: หา section ก่อน "2nd Prize"
    const block = html.split(/2nd Prize|2nd\s+Prize/i)[0];
    const digits = block.match(/>(\d)</g);
    if (digits && digits.length >= 4) {
      const nums = digits.slice(-4).map(d => d.replace(/[><]/g, ''));
      first = nums.join('');
    }
  }

  if (!first || first.length < 4) throw new Error('parse 1st prize failed');

  return {
    dateStr,
    result_first: first,                    // 4 หลัก เช่น "5825"
    result_2_back: first.slice(-2),          // 2 หลักท้าย
    result_3_back1: first.slice(-3),         // 3 หลักท้าย
    result_3_back2: null,
    result_3_front1: first.slice(0, 3),      // 3 หลักหน้า
    result_3_front2: null,
  };
}

// ── หา round_id ของหวยลาวที่สถานะ 'closed' วันนี้ ─────────────
async function findOpenLaoRound() {
  const row = await queryOne(`
    SELECT r.id
    FROM lottery_rounds r
    JOIN lottery_types lt ON r.lottery_type_id = lt.id
    WHERE lt.code = ?
      AND r.status = 'closed'
      AND DATE(r.close_at) = CURDATE()
    ORDER BY r.close_at DESC
    LIMIT 1
  `, [LAO_TYPE_CODE]);
  return row ? row.id : null;
}

// ── บันทึกผลเข้า DB ────────────────────────────────────────────
async function enterResult(roundId, result) {
  const existing = await queryOne('SELECT id FROM lottery_results WHERE round_id=?', [roundId]);
  if (existing) {
    console.log(`[LAO SCRAPER] round ${roundId} already resulted — skip`);
    return false;
  }

  await query(
    `INSERT INTO lottery_results
     (round_id,result_first,result_2_back,result_3_back1,result_3_back2,result_3_front1,result_3_front2,entered_by,entered_at)
     VALUES (?,?,?,?,?,?,?,0,NOW())`,
    [roundId,
     result.result_first,
     result.result_2_back,
     result.result_3_back1,
     result.result_3_back2 || null,
     result.result_3_front1,
     result.result_3_front2 || null]
  );
  await query("UPDATE lottery_rounds SET status='resulted', result_at=NOW() WHERE id=?", [roundId]);

  console.log(`[LAO SCRAPER] round ${roundId} result entered: ${result.result_first}`);
  return true;
}

// ── main: scrape + enter + payout ─────────────────────────────
async function runLaoScraper() {
  console.log('[LAO SCRAPER] Starting...');
  try {
    const result = await fetchLatestLaoResult();
    console.log(`[LAO SCRAPER] Fetched result: ${result.result_first} (${result.dateStr})`);

    const roundId = await findOpenLaoRound();
    if (!roundId) {
      console.log('[LAO SCRAPER] No open Lao round found for today — skip');
      return;
    }

    const entered = await enterResult(roundId, result);
    if (entered) {
      processPayouts(roundId, result).catch(err =>
        console.error('[LAO SCRAPER] Payout error:', err)
      );
    }
  } catch (err) {
    console.error('[LAO SCRAPER] Error:', err.message);
  }
}

module.exports = { runLaoScraper, fetchLatestLaoResult };
