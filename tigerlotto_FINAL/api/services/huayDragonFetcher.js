/**
 * huayDragonFetcher.js
 * Auto-fetch lottery results from HuayDragon API and enter them into the DB.
 * All times use Asia/Bangkok (UTC+7).
 *
 * HuayDragon: https://api-huaydragon.com
 * Auth: Bearer token from process.env.HUAYDRAGON_TOKEN
 */

'use strict';

const axios = require('axios');
const { query, queryOne, transaction } = require('../config/db');
const { processPayouts } = require('../controllers/resultController');
const { autoCreateHdRound } = require('./hdRoundCreator');

const HD_BASE_URL = 'https://api-huaydragon.com';
const HD_TIMEOUT  = 12000; // 12 seconds

// ── Status tracking ────────────────────────────────────────────
const hdStatus = {
  lastRun:     null,
  lastSuccess: null,
  lastError:   null,
  lastCount:   { entered: 0, skipped: 0, errors: 0 },
};

// ── Per-slot dedup: { "YYYY-MM-DD-HH": true } ─────────────────
const _lastSlotRun = {};

// ── Mapping: HD stock[].index → TigerLotto code ───────────────
// NOTE: Must match lottery_types.code in production DB exactly (case-sensitive)
const HD_INDEX_TO_CODE = {
  8:  'stock_kr',
  9:  'stock_nk_am',
  10: 'stock_nk_pm',
  11: 'stock_hk_am',
  12: 'stock_hk_pm',
  13: 'stock_cn_am',
  14: 'stock_cn_pm',
  15: 'stock_tw',
  16: 'stock_sg',
  17: 'stock_eg',
  18: 'stock_de',
  19: 'stock_ru',
  20: 'stock_in',
  21: 'stock_dj',
  22: 'LA_GOV',
  23: 'stock_my',
  24: 'stock_uk',
  25: 'VN_HAN',
  26: 'VN_HAN_SP',
  27: 'VN_HAN_VIP',
};

// ── Mapping: customs[].name → TigerLotto code ─────────────────
const CUSTOMS_NAME_TO_CODE = {
  'ลาว (เลขชุด)':        'lao_set',
  'หวยฮานอย (เลขชุด)':  'hanoi_set',
  'หวยมาเลย์ (เลขชุด)': 'malay_set',
};

// bankStock index 0→ธกส, 1→ออมสิน; thaiStock index 0-3→เช้า/เที่ยง/บ่าย/เย็น
const BANK_STOCK_CODES = ['bank_stock', 'gsb'];
const THAI_STOCK_CODES = ['thai_am', 'thai_noon', 'thai_pm', 'thai_eve'];

// ── Token helpers ──────────────────────────────────────────────
function getHdToken() { return process.env.HUAYDRAGON_TOKEN || null; }

function isHdConfigured() {
  if (!getHdToken()) {
    console.warn('[HD FETCHER] HUAYDRAGON_TOKEN not set — skipping.');
    return false;
  }
  return true;
}

// ── HTTP GET ───────────────────────────────────────────────────
async function hdGet(path) {
  const token = getHdToken();
  if (!token) throw new Error('HUAYDRAGON_TOKEN not configured');
  try {
    const res = await axios.get(HD_BASE_URL + path, {
      timeout: HD_TIMEOUT,
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'TigerLotto/1.0' },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn('[HD FETCHER] 401 — token expired/invalid. Skipping.');
      throw new Error('HUAYDRAGON_AUTH_FAILED');
    }
    throw err;
  }
}

// ── Parse HD API response → array of result objects ───────────
function parseHdResults(data) {
  const results = [];
  if (!data) return results;

  // Government
  if (Array.isArray(data.goverment)) {
    for (const item of data.goverment) {
      if (item.topThree === 'xxx' || item.bottomTwo === 'xx') continue;
      results.push({ code: 'TH_GOV', name: 'หวยรัฐบาลไทย',
        result_first: item.topThree, result_2_back: item.bottomTwo });
    }
  }

  // Bank stocks (ธกส / ออมสิน)
  if (Array.isArray(data.bankStock)) {
    data.bankStock.forEach((item, idx) => {
      if (item.topThree === 'xxx' || item.bottomTwo === 'xx') return;
      const code = BANK_STOCK_CODES[idx];
      if (!code) return;
      results.push({ code, name: code === 'bank_stock' ? 'หวยธกส.' : 'หวยออมสิน',
        result_first: item.topThree, result_2_back: item.bottomTwo });
    });
  }

  // Thai stocks (เช้า/เที่ยง/บ่าย/เย็น)
  if (Array.isArray(data.thaiStock)) {
    data.thaiStock.forEach((item, idx) => {
      if (item.topThree === 'xxx' || item.bottomTwo === 'xx') return;
      const code = THAI_STOCK_CODES[idx];
      if (!code) return;
      results.push({ code, name: item.name || code,
        result_first: item.topThree, result_2_back: item.bottomTwo });
    });
  }

  // International stocks (by .index)
  if (Array.isArray(data.stock)) {
    for (const item of data.stock) {
      if (item.topThree === 'xxx' || item.bottomTwo === 'xx') continue;
      const code = HD_INDEX_TO_CODE[item.index];
      if (!code) continue;
      results.push({ code, name: item.name || code,
        result_first: item.topThree, result_2_back: item.bottomTwo });
    }
  }

  // Customs เลขชุด (4 digits)
  if (Array.isArray(data.customs)) {
    for (const item of data.customs) {
      if ((item.fourNumber || '') === 'xxxx') continue;
      const code = CUSTOMS_NAME_TO_CODE[item.name || ''];
      if (!code) continue;
      results.push({ code, name: item.name,
        result_first: item.fourNumber,
        result_2_back: item.fourNumber.slice(-2),
        is_four_digit: true });
    }
  }

  return results;
}

// ── Enter one result into DB ───────────────────────────────────
async function enterHdResult(code, resultObj, dateStr) {
  try {
    // 1. Find lottery_type
    const lt = await queryOne('SELECT id, code, name FROM lottery_types WHERE code = ?', [code]);
    if (!lt) {
      console.log(`[HD FETCHER] SKIP — unknown lottery type: ${code}`);
      return null;
    }

    // 2. Find round for this date
    let round = await queryOne(
      `SELECT r.* FROM lottery_rounds r
       WHERE r.lottery_type_id = ? AND DATE(r.close_at) = ?
         AND r.status IN ('closed','resulted','open')
       ORDER BY r.close_at DESC LIMIT 1`,
      [lt.id, dateStr]
    );

    // 3. No round → auto-create
    if (!round) {
      console.log(`[HD FETCHER] No round for ${code} on ${dateStr} — auto-creating...`);
      const created = await autoCreateHdRound(lt, dateStr);
      if (created) {
        round = await queryOne(
          `SELECT r.* FROM lottery_rounds r
           WHERE r.lottery_type_id = ? AND DATE(r.close_at) = ?
             AND r.status IN ('closed','resulted','open')
           ORDER BY r.close_at DESC LIMIT 1`,
          [lt.id, dateStr]
        );
      }
      if (!round) {
        console.log(`[HD FETCHER] Could not create round for ${code} on ${dateStr}. Skipping.`);
        return null;
      }
    }

    // 4. Skip if already resulted
    const existing = await queryOne('SELECT id FROM lottery_results WHERE round_id = ?', [round.id]);
    if (existing) {
      console.log(`[HD FETCHER] Already entered for ${code} round ${round.id}`);
      return null;
    }

    // 5. Close round if still open
    if (round.status === 'open') {
      await query("UPDATE lottery_rounds SET status='closed' WHERE id = ?", [round.id]);
      console.log(`[HD FETCHER] Auto-closed round ${round.id} (${code})`);
    }

    // 6. Insert result + update round
    const rd = {
      result_first:    resultObj.result_first,
      result_2_back:   resultObj.result_2_back,
      result_3_back1:  null,
      result_3_back2:  null,
      result_3_front1: null,
      result_3_front2: null,
    };

    await transaction(async (conn) => {
      await conn.execute(
        `INSERT INTO lottery_results
           (round_id, result_first, result_2_back, result_3_back1, result_3_back2,
            result_3_front1, result_3_front2, source, entered_by, entered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'huaydragon', NULL, NOW())`,
        [round.id, rd.result_first, rd.result_2_back,
         rd.result_3_back1, rd.result_3_back2, rd.result_3_front1, rd.result_3_front2]
      );
      await conn.execute(
        "UPDATE lottery_rounds SET status='resulted', result_at=NOW() WHERE id=?",
        [round.id]
      );
    });

    console.log(`[HD FETCHER] ✅ ${code} round ${round.id} → ${rd.result_first}`);

    // 7. Process payouts (async, non-blocking)
    processPayouts(round.id, rd).catch(err =>
      console.error(`[HD FETCHER] Payout error ${code} round ${round.id}:`, err.message)
    );

    return round.id;
  } catch (err) {
    console.error(`[HD FETCHER] enterHdResult error (${code}):`, err.message);
    throw err;
  }
}

// ── Main fetch orchestrator ────────────────────────────────────
async function runHdFetch(dateStr) {
  if (!isHdConfigured()) return { entered: 0, skipped: 0, errors: [] };

  hdStatus.lastRun = new Date();

  try {
    const data   = await hdGet(`/lotto/huay/prize?date=${dateStr}`);
    const parsed = parseHdResults(data);

    let entered = 0, skipped = 0;
    const errors = [];

    for (const resultObj of parsed) {
      try {
        const roundId = await enterHdResult(resultObj.code, resultObj, dateStr);
        roundId ? entered++ : skipped++;
      } catch (err) {
        errors.push({ code: resultObj.code, error: err.message });
        skipped++;
      }
    }

    console.log(`[HD FETCHER] Done ${dateStr}: ${entered} entered, ${skipped} skipped, ${errors.length} errors`);

    hdStatus.lastSuccess = new Date();
    hdStatus.lastError   = null;
    hdStatus.lastCount   = { entered, skipped, errors: errors.length };

    return { entered, skipped, errors };
  } catch (err) {
    console.error('[HD FETCHER] runHdFetch error:', err.message);
    hdStatus.lastError = err.message;
    hdStatus.lastCount = { entered: 0, skipped: 0, errors: 1 };
    return { entered: 0, skipped: 0, errors: [{ error: err.message }] };
  }
}

// ── Status getter ──────────────────────────────────────────────
function getHdStatus() { return { ...hdStatus }; }

// ── Scheduler ─────────────────────────────────────────────────
function startHdScheduler() {
  if (!isHdConfigured()) {
    console.warn('[HD FETCHER] Scheduler not started — HUAYDRAGON_TOKEN not set.');
    return;
  }

  // Each slot: ICT hour:min to run fetch
  const slots = [
    { hr:  9, min: 35, desc: 'นิเคอิเช้า / ฮั่งเส็งเช้า / ไต้หวัน / จีนเช้า' },
    { hr: 12, min: 35, desc: 'นิเคอิบ่าย / ฮั่งเส็งบ่าย / จีนบ่าย' },
    { hr: 14, min: 35, desc: 'บ่าย' },
    { hr: 16, min: 35, desc: 'เกาหลี / อินเดีย / อียิปต์ / หุ้นไทยเย็น' },
    { hr: 17, min: 35, desc: 'สิงคโปร์ / ฮานอยพิเศษ' },
    { hr: 18, min: 35, desc: 'ฮานอยปกติ / มาเลย์ / เลขชุด' },
    { hr: 20, min: 35, desc: 'ลาว' },
    { hr: 22, min: 35, desc: 'เยอรมัน / รัสเซีย' },
    { hr:  5, min:  5, desc: 'ดาวโจนส์ / อังกฤษ (ผลเมื่อวาน)' },
  ];

  const ictNow = () => new Date(Date.now() + 7 * 3600 * 1000);
  const toDateStr = (d) => {
    const y  = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${dd}`;
  };

  setInterval(() => {
    const now  = ictNow();
    const hour = now.getUTCHours();
    const min  = now.getUTCMinutes();

    for (const slot of slots) {
      if (hour !== slot.hr || min !== slot.min) continue;

      // Early-morning slot fetches yesterday's results
      let fetchDate = toDateStr(now);
      if (slot.hr === 5) {
        const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
        fetchDate = toDateStr(yesterday);
      }

      const slotKey = `${fetchDate}-${String(slot.hr).padStart(2, '0')}`;
      if (_lastSlotRun[slotKey]) continue; // already ran this slot

      console.log(`[HD FETCHER] Slot ${slotKey} → ${slot.desc}`);
      _lastSlotRun[slotKey] = true;

      runHdFetch(fetchDate).catch(err =>
        console.error(`[HD FETCHER] Slot ${slotKey} error:`, err.message)
      );
    }
  }, 60_000);

  console.log('[HD FETCHER] Scheduler started (Asia/Bangkok):');
  slots.forEach(s =>
    console.log(`  ${String(s.hr).padStart(2,'0')}:${String(s.min).padStart(2,'0')} — 