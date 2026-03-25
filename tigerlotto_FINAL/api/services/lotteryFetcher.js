/**
 * lotteryFetcher.js
 * Auto-fetch lottery results and enter them into the DB.
 * All times use Asia/Bangkok (UTC+7).
 */

const cron    = require('node-cron');
const axios   = require('axios');
const cheerio = require('cheerio');

const { query, queryOne, transaction } = require('../config/db');
const { processPayouts } = require('../controllers/resultController');

const TIMEZONE    = 'Asia/Bangkok';
const MAX_RETRIES = 3;
const RETRY_DELAY = 5 * 60 * 1000; // 5 minutes

// ── Status tracking ────────────────────────────────────────────
const fetcherStatus = {
  gov:           { lastRun: null, lastSuccess: null, lastError: null, retries: 0 },
  laos:          { lastRun: null, lastSuccess: null, lastError: null, retries: 0 },
  hanoi:         { lastRun: null, lastSuccess: null, lastError: null, retries: 0 },
  hanoi_vip:     { lastRun: null, lastSuccess: null, lastError: null, retries: 0 },
  hanoi_special: { lastRun: null, lastSuccess: null, lastError: null, retries: 0 },
};

// ── Internal: บันทึกผลลง DB ────────────────────────────────────
async function enterResultInternal(lotteryCode, resultData) {
  // หา round ล่าสุดที่ status='closed'
  const round = await queryOne(
    `SELECT r.* FROM lottery_rounds r
     JOIN lottery_types lt ON r.lottery_type_id = lt.id
     WHERE lt.code = ? AND r.status = 'closed'
     ORDER BY r.close_at DESC LIMIT 1`,
    [lotteryCode]
  );

  if (!round) {
    throw new Error(`No closed round found for lottery: ${lotteryCode}`);
  }

  // ตรวจว่าบันทึกไปแล้วหรือยัง
  const existing = await queryOne(
    'SELECT id FROM lottery_results WHERE round_id=?',
    [round.id]
  );
  if (existing) {
    throw new Error(`Result already entered for round ${round.id} (${lotteryCode})`);
  }

  const {
    result_first,
    result_2_back    = null,
    result_3_back1   = null,
    result_3_back2   = null,
    result_3_front1  = null,
    result_3_front2  = null,
  } = resultData;

  // บันทึกผลและอัปเดต round status
  await transaction(async (conn) => {
    await conn.execute(
      `INSERT INTO lottery_results
       (round_id, result_first, result_2_back, result_3_back1, result_3_back2,
        result_3_front1, result_3_front2, source, entered_by, entered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'auto_fetch', NULL, NOW())`,
      [round.id, result_first, result_2_back, result_3_back1, result_3_back2,
       result_3_front1, result_3_front2]
    );
    await conn.execute(
      "UPDATE lottery_rounds SET status='resulted', result_at=NOW() WHERE id=?",
      [round.id]
    );
  });

  console.log(`[FETCHER] Result entered for ${lotteryCode} round ${round.id} (${result_first})`);

  // ประมวลผลรางวัล (async — ไม่ block)
  processPayouts(round.id, resultData).catch(err =>
    console.error(`[FETCHER] Payout error for ${lotteryCode} round ${round.id}:`, err.message)
  );

  return round.id;
}

// ── Retry wrapper ──────────────────────────────────────────────
async function fetchWithRetry(lotteryCode, fetchFn) {
  const status = fetcherStatus[lotteryCode];
  status.lastRun = new Date();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      status.retries = attempt - 1;
      const resultData = await fetchFn();
      if (!resultData || !resultData.result_first) {
        throw new Error('fetchFn returned empty result');
      }
      await enterResultInternal(lotteryCode, resultData);
      status.lastSuccess = new Date();
      status.lastError   = null;
      status.retries     = 0;
      return;
    } catch (err) {
      console.error(`[FETCHER] ${lotteryCode} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      status.lastError = err.message;
      status.retries   = attempt;

      if (attempt < MAX_RETRIES) {
        console.log(`[FETCHER] ${lotteryCode} retrying in ${RETRY_DELAY / 60000} min...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  console.error(`[FETCHER] ${lotteryCode} gave up after ${MAX_RETRIES} attempts`);
}

// ── HTTP helper ────────────────────────────────────────────────
function httpGet(url, timeoutMs = 12000) {
  return axios.get(url, {
    timeout: timeoutMs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept-Language': 'th,en;q=0.9',
    },
  });
}

// ── Fetch: หวยรัฐบาลไทย ────────────────────────────────────────
async function fetchGov() {
  // Primary: GLO announce API
  try {
    const res = await httpGet('https://www.glo.or.th/api/lottery/announce/latest');
    const d   = res.data?.data || res.data;
    if (d && (d.prizeFirst || d.first)) {
      return {
        result_first:   (d.prizeFirst  || d.first  || '').replace(/\D/g, ''),
        result_2_back:  (d.prizeLastTwo|| d.last2   || '').replace(/\D/g, '') || null,
        result_3_back1: (d.prizeLastThree1 || '').replace(/\D/g, '') || null,
        result_3_back2: (d.prizeLastThree2 || '').replace(/\D/g, '') || null,
        result_3_front1:(d.prizeFrontThree1 || '').replace(/\D/g, '') || null,
        result_3_front2:(d.prizeFrontThree2 || '').replace(/\D/g, '') || null,
      };
    }
  } catch (e) {
    console.warn('[FETCHER] gov GLO API error:', e.message);
  }

  // Fallback: scrape ch7.com
  try {
    const res = await httpGet('https://news.ch7.com/lottery');
    const $   = cheerio.load(res.data);
    const first = $('[class*="prize-first"],[class*="lottery-first"],[class*="lotto-first"]')
      .first().text().replace(/\D/g, '').trim();
    if (first && /^\d{6}$/.test(first)) {
      const back2 = $('[class*="prize-last2"],[class*="lottery-2"]')
        .first().text().replace(/\D/g, '').trim();
      return {
        result_first:   first,
        result_2_back:  back2 || first.slice(-2),
        result_3_back1: null,
        result_3_back2: null,
        result_3_front1: null,
        result_3_front2: null,
      };
    }
  } catch (e) {
    console.warn('[FETCHER] gov CH7 fallback error:', e.message);
  }

  throw new Error('gov: all sources failed');
}

// ── Fetch: หวยลาว ─────────────────────────────────────────────
async function fetchLaos() {
  // Primary: huaylaos.com
  try {
    const res = await httpGet('https://www.huaylaos.com');
    const $   = cheerio.load(res.data);
    const nums = [];
    $('[class*="result"],[class*="number"],[class*="prize"]').each((_, el) => {
      const t = $(el).text().replace(/\D/g, '').trim();
      if (t && t.length >= 2) nums.push(t);
    });
    const first = nums.find(n => n.length >= 4);
    if (first) {
      return {
        result_first:    first,
        result_2_back:   first.slice(-2),
        result_3_back1:  first.length >= 3 ? first.slice(-3) : null,
        result_3_back2:  null,
        result_3_front1: null,
        result_3_front2: null,
      };
    }
  } catch (e) {
    console.warn('[FETCHER] laos huaylaos.com error:', e.message);
  }

  // Fallback: lottovip.com
  try {
    const res = await httpGet('https://www.lottovip.com/lao-lottery-result');
    const $   = cheerio.load(res.data);
    const first = $('[class*="result"],[class*="prize"],[class*="number"]')
      .filter((_, el) => /^\d+$/.test($(el).text().trim()))
      .first().text().trim();
    if (first && first.length >= 4) {
      return {
        result_first:    first,
        result_2_back:   first.slice(-2),
        result_3_back1:  first.length >= 3 ? first.slice(-3) : null,
        result_3_back2:  null,
        result_3_front1: null,
        result_3_front2: null,
      };
    }
  } catch (e) {
    console.warn('[FETCHER] laos lottovip fallback error:', e.message);
  }

  throw new Error('laos: all sources failed');
}

// ── Fetch: หวยฮานอย variants ───────────────────────────────────
async function fetchHanoiVariant(variant) {
  const paths = {
    hanoi:         '/ket-qua-xo-so-mien-bac',
    hanoi_vip:     '/ket-qua-xo-so-mien-bac-vip',
    hanoi_special: '/ket-qua-xo-so-mien-bac-dac-biet',
  };

  // Primary: xosokienthiet.net
  try {
    const res = await httpGet(`https://xosokienthiet.net${paths[variant] || paths.hanoi}`);
    const $   = cheerio.load(res.data);

    // Prize 1 (giải nhất) is the main jackpot
    const first = $('[class*="giai-nhat"],[class*="prize-1"],[class*="jackpot"],[data-prize="1"]')
      .first().text().replace(/\D/g, '').trim();

    if (first && /^\d{5}$/.test(first)) {
      return {
        result_first:    first,
        result_2_back:   first.slice(-2),
        result_3_back1:  first.slice(-3),
        result_3_back2:  null,
        result_3_front1: null,
        result_3_front2: null,
      };
    }

    // Also try generic number selectors
    const anyNum = $('td,span,div')
      .filter((_, el) => /^\d{5}$/.test($(el).text().trim()))
      .first().text().trim();
    if (anyNum) {
      return {
        result_first:    anyNum,
        result_2_back:   anyNum.slice(-2),
        result_3_back1:  anyNum.slice(-3),
        result_3_back2:  null,
        result_3_front1: null,
        result_3_front2: null,
      };
    }
  } catch (e) {
    console.warn(`[FETCHER] ${variant} xosokienthiet error:`, e.message);
  }

  // Fallback: xosomiennam.net
  try {
    const res = await httpGet('https://xosomiennam.net/ket-qua-xo-so-mien-bac');
    const $   = cheerio.load(res.data);
    const first = $('td,span')
      .filter((_, el) => /^\d{5}$/.test($(el).text().trim()))
      .first().text().trim();
    if (first) {
      return {
        result_first:    first,
        result_2_back:   first.slice(-2),
        result_3_back1:  first.slice(-3),
        result_3_back2:  null,
        result_3_front1: null,
        result_3_front2: null,
      };
    }
  } catch (e) {
    console.warn(`[FETCHER] ${variant} fallback error:`, e.message);
  }

  throw new Error(`${variant}: all sources failed`);
}

const fetchHanoi        = () => fetchHanoiVariant('hanoi');
const fetchHanoiVip     = () => fetchHanoiVariant('hanoi_vip');
const fetchHanoiSpecial = () => fetchHanoiVariant('hanoi_special');

// ── Start all fetchers ─────────────────────────────────────────
function startLotteryFetcher() {
  console.log('[FETCHER] Initialising lottery auto-fetcher (tz: Asia/Bangkok)...');

  // หวยรัฐบาลไทย — 1 และ 16 ของทุกเดือน เวลา 15:05 น.
  // (ออกผล 15:00, รอ 5 นาทีก่อน fetch)
  cron.schedule('5 15 1,16 * *', () => {
    console.log('[FETCHER] Triggering: gov');
    fetchWithRetry('gov', fetchGov);
  }, { timezone: TIMEZONE });

  // หวยลาว — ทุกวัน 20:35 น. (ออกผล 20:30)
  cron.schedule('35 20 * * *', () => {
    console.log('[FETCHER] Triggering: laos');
    fetchWithRetry('laos', fetchLaos);
  }, { timezone: TIMEZONE });

  // หวยฮานอย — ทุกวัน 18:35 น. (ออกผล 18:30)
  cron.schedule('35 18 * * *', () => {
    console.log('[FETCHER] Triggering: hanoi');
    fetchWithRetry('hanoi', fetchHanoi);
  }, { timezone: TIMEZONE });

  // หวยฮานอย VIP — ทุกวัน 18:05 น. (ออกผล 18:00)
  cron.schedule('5 18 * * *', () => {
    console.log('[FETCHER] Triggering: hanoi_vip');
    fetchWithRetry('hanoi_vip', fetchHanoiVip);
  }, { timezone: TIMEZONE });

  // หวยฮานอยพิเศษ — ทุกวัน 17:35 น. (ออกผล 17:30)
  cron.schedule('35 17 * * *', () => {
    console.log('[FETCHER] Triggering: hanoi_special');
    fetchWithRetry('hanoi_special', fetchHanoiSpecial);
  }, { timezone: TIMEZONE });

  console.log('[FETCHER] Schedules registered:');
  console.log('  gov           → 1st & 16th @ 15:05 Asia/Bangkok');
  console.log('  laos          → daily @ 20:35 Asia/Bangkok');
  console.log('  hanoi         → daily @ 18:35 Asia/Bangkok');
  console.log('  hanoi_vip     → daily @ 18:05 Asia/Bangkok');
  console.log('  hanoi_special → daily @ 17:35 Asia/Bangkok');
}

module.exports = { startLotteryFetcher, fetcherStatus };
