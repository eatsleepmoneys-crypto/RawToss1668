/**
 * lotteryFetcher.js
 * ─────────────────────────────────────────────────────────────────
 * ดึงผลหวยจากแหล่งภายนอกและบันทึก + จ่ายรางวัลอัตโนมัติ
 *
 *  ประเภทที่รองรับ:
 *   TH_GOV      — หวยรัฐบาลไทย    (วันที่ 1, 16 ของทุกเดือน)
 *   LA_GOV      — ลาวพัฒนา        (ทุกวัน ~20:30) — 6 หลัก
 *   VN_HAN      — ฮานอยปกติ       (ทุกวัน ~18:30)
 *   VN_HAN_SP   — ฮานอยพิเศษ      (ทุกวัน ~17:30)
 *   VN_HAN_VIP  — ฮานอย VIP       (ทุกวัน ~17:00)
 *
 * DB column mapping (lottery_results):
 *   prize_1st      — รางวัลที่ 1 (6 หลักไทย / 6 หลักลาว / 5 หลักฮานอย)
 *   prize_last_2   — เลขท้าย 2 ตัว (ลาวพัฒนา = ตำแหน่ง 5-6 = 2ตัวบน, 2bot=ตำแหน่ง 3-4)
 *   prize_front_3  — เลขหน้า 3 ตัว (JSON array)
 *   prize_last_3   — เลขท้าย 3 ตัว (JSON array)
 *   announced_at   — เวลาออกผล
 *
 * All times: Asia/Bangkok (UTC+7)
 */

'use strict';

const cron      = require('node-cron');
const axios     = require('axios');
const cheerio   = require('cheerio');
const { v4: uuidv4 } = require('uuid');

const { query, transaction } = require('../config/db');

const TIMEZONE    = 'Asia/Bangkok';
const MAX_RETRIES = 3;
const RETRY_DELAY = 5 * 60 * 1000; // 5 นาที

// ── Status tracking (สำหรับ admin monitor) ───────────────────────
const fetcherStatus = {};

function initStatus(code) {
  fetcherStatus[code] = fetcherStatus[code] || {
    lastRun: null, lastSuccess: null, lastError: null, retries: 0,
  };
}
['TH_GOV','LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP'].forEach(initStatus);

// ── HTTP helper ────────────────────────────────────────────────────
const httpGet = (url, ms = 15000) => axios.get(url, {
  timeout: ms,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept-Language': 'th,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
  },
});

// ── ─────────────────────────────────────────────────────────────
//    FETCH FUNCTIONS — คืน { prize_1st, prize_last_2, front3:[], last3:[] }
// ──────────────────────────────────────────────────────────────────

/**
 * หวยรัฐบาลไทย — ออกผลวันที่ 1 และ 16 เวลา ~15:00 น.
 * ลอง 3 source ตามลำดับ
 */
async function fetchTHGov() {
  // Source 1: Longdo Money (JSON API — เชื่อถือได้)
  try {
    const res = await httpGet('https://money.longdo.com/lotto/api');
    const d   = res.data;
    if (d && (d.first || d.prize1)) {
      const p1 = (d.first || d.prize1 || '').replace(/\D/g,'');
      if (/^\d{6}$/.test(p1)) {
        const last2  = (d.last2  || p1.slice(-2)).replace(/\D/g,'');
        const front3 = [(d.front3_1||''), (d.front3_2||'')].map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x));
        const last3  = [(d.last3_1||''), (d.last3_2||'')].map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x));
        console.log('[FETCHER:TH_GOV] Source: longdo');
        return { prize_1st: p1, prize_last_2: last2 || p1.slice(-2), prize_front_3: front3, prize_last_3: last3 };
      }
    }
  } catch(e) { console.warn('[FETCHER:TH_GOV] longdo error:', e.message); }

  // Source 2: Sanook lotto (JSON endpoint)
  try {
    const res = await httpGet('https://api.sanook.com/lottoapi/latest');
    const d   = res.data?.result || res.data;
    if (d && d.prize1) {
      const p1 = d.prize1.replace(/\D/g,'');
      if (/^\d{6}$/.test(p1)) {
        console.log('[FETCHER:TH_GOV] Source: sanook API');
        return {
          prize_1st:     p1,
          prize_last_2:  (d.last2||p1.slice(-2)).replace(/\D/g,''),
          prize_front_3: [d.front3_1, d.front3_2].filter(Boolean).map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x)),
          prize_last_3:  [d.last3_1,  d.last3_2].filter(Boolean).map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x)),
        };
      }
    }
  } catch(e) { console.warn('[FETCHER:TH_GOV] sanook API error:', e.message); }

  // Source 3: Manager Online (HTML scrape)
  try {
    const res = await httpGet('https://www.manager.co.th/Lotto/');
    const $   = cheerio.load(res.data);
    // หา 6-digit text ที่น่าจะเป็นรางวัลที่ 1
    let p1 = '';
    $('span,td,div,p').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g,'');
      if (/^\d{6}$/.test(t) && !p1) p1 = t;
    });
    if (p1) {
      console.log('[FETCHER:TH_GOV] Source: manager.co.th scrape');
      return { prize_1st: p1, prize_last_2: p1.slice(-2), prize_front_3: [], prize_last_3: [] };
    }
  } catch(e) { console.warn('[FETCHER:TH_GOV] manager scrape error:', e.message); }

  throw new Error('TH_GOV: แหล่งข้อมูลทุกแหล่งล้มเหลว');
}

/**
 * ลาวพัฒนา — ออกผลทุกวัน ~20:30 น. (6 หลัก)
 * การคิดรางวัล:
 *   prize_1st  = 6 หลัก (padStart 0)
 *   prize_last_2 (2top/2ตัวบน) = ตำแหน่ง 5-6 = slice(4,6)
 *   prize_last_3 (3top/3ตัว)   = ตำแหน่ง 4-5-6 = slice(3,6)
 *   2ตัวล่าง (2bot) พิเศษ       = ตำแหน่ง 3-4   = slice(2,4)
 */
function laGovExtract(rawDigits) {
  const p = rawDigits.padStart(6, '0').slice(-6); // ensure 6 digits
  return {
    prize_1st:    p,
    prize_last_2: p.slice(4, 6),        // 2top = ตำแหน่ง 5-6
    prize_front_3: [],
    prize_last_3: [p.slice(3, 6)],      // 3top = ตำแหน่ง 4-5-6
    prize_2bot:   p.slice(2, 4),        // 2bot พิเศษ = ตำแหน่ง 3-4 (stored separately)
  };
}

async function fetchLAGov() {
  // Source 1: huaylao.net (JSON)
  try {
    const res = await httpGet('https://huaylao.net/api/latest');
    const d   = res.data;
    if (d && (d.prize1 || d.first)) {
      const raw = (d.prize1 || d.first || '').replace(/\D/g,'');
      if (raw.length >= 4) {
        console.log('[FETCHER:LA_GOV] Source: huaylao.net API');
        return laGovExtract(raw);
      }
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] huaylao.net error:', e.message); }

  // Source 2: laosassociationlottery.com (HTML)
  try {
    const res = await httpGet('https://laosassociationlottery.com/en/home/', 20000);
    const $   = cheerio.load(res.data);
    const nums = [];
    $('[class*="prize"],[class*="result"],[class*="number"]').each((_, el) => {
      const t = $(el).text().replace(/\s+/g,'').replace(/\D/g,'');
      if (t.length >= 4 && t.length <= 6) nums.push(t);
    });
    if (!nums.length) {
      $('td,span,div').each((_, el) => {
        const t = $(el).text().trim().replace(/\D/g,'');
        if (t.length >= 4 && t.length <= 6) nums.push(t);
      });
    }
    if (nums.length) {
      console.log('[FETCHER:LA_GOV] Source: laosassociationlottery.com');
      return laGovExtract(nums[0]);
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] laosassociation error:', e.message); }

  // Source 3: lottovip.com
  try {
    const res = await httpGet('https://www.lottovip.com/lao-lottery-result/');
    const $   = cheerio.load(res.data);
    let raw = '';
    $('[class*="result"],[class*="number"],[class*="prize"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g,'');
      if (t.length >= 4 && !raw) raw = t;
    });
    if (raw) {
      console.log('[FETCHER:LA_GOV] Source: lottovip.com');
      return laGovExtract(raw);
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] lottovip error:', e.message); }

  throw new Error('LA_GOV: แหล่งข้อมูลทุกแหล่งล้มเหลว');
}

/**
 * หวยฮานอย (Xổ số Miền Bắc) — ออกผลทุกวัน ~18:30 น.
 * รางวัลที่ 1 (Giải nhất) = 5 หลัก
 */
async function fetchVNHanoi() {
  // Source 1: xoso.com.vn (JSON)
  try {
    const today = new Date(Date.now() + 7*3600000).toISOString().slice(0,10).replace(/-/g,'/');
    const res   = await httpGet(`https://xoso.com.vn/api/xs-mb-${today}.js`);
    const html  = res.data;
    // ดึง giainhat: ["12345"] จาก JSON
    const m = JSON.stringify(html).match(/"giainhat"\s*:\s*\["(\d+)"\]/);
    if (m) {
      const p = m[1];
      console.log('[FETCHER:VN_HAN] Source: xoso.com.vn');
      return { prize_1st: p, prize_last_2: p.slice(-2), prize_front_3: [], prize_last_3: [p.slice(-3)] };
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] xoso.com.vn error:', e.message); }

  // Source 2: xosomiennam.net (HTML scrape)
  try {
    const res = await httpGet('https://xosomiennam.net/ket-qua-xo-so-mien-bac', 20000);
    const $   = cheerio.load(res.data);
    let p = '';
    // Giải nhất มักอยู่ใน <td> หรือ <div> ที่มี 5 หลัก
    $('td,span,div').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g,'');
      if (/^\d{5}$/.test(t) && !p) p = t;
    });
    if (p) {
      console.log('[FETCHER:VN_HAN] Source: xosomiennam.net');
      return { prize_1st: p, prize_last_2: p.slice(-2), prize_front_3: [], prize_last_3: [p.slice(-3)] };
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] xosomiennam error:', e.message); }

  // Source 3: ketqua.tv (HTML scrape)
  try {
    const res = await httpGet('https://ketqua.tv/xo-so-mien-bac.html');
    const $   = cheerio.load(res.data);
    let p = '';
    $('[class*="giai-nhat"],[class*="giainhat"],[class*="prize1"],[class*="jackpot"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g,'');
      if (t.length >= 4 && !p) p = t;
    });
    if (!p) {
      $('td,span').each((_, el) => {
        const t = $(el).text().trim().replace(/\D/g,'');
        if (/^\d{5}$/.test(t) && !p) p = t;
      });
    }
    if (p) {
      console.log('[FETCHER:VN_HAN] Source: ketqua.tv');
      return { prize_1st: p, prize_last_2: p.slice(-2), prize_front_3: [], prize_last_3: [p.slice(-3)] };
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] ketqua.tv error:', e.message); }

  throw new Error('VN_HAN: แหล่งข้อมูลทุกแหล่งล้มเหลว');
}

// ── บันทึกผลลง DB ───────────────────────────────────────────────

/**
 * หาตารางงวดที่ปิดรับแล้วของ lottery type ที่ระบุ
 * ไม่มีผลอยู่แล้ว (ยังไม่ได้ประกาศ)
 */
async function findClosedRound(lotteryCode) {
  const rows = await query(
    `SELECT lr.id, lr.round_name
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id = lt.id
     WHERE lt.code = ?
       AND lr.status = 'closed'
       AND NOT EXISTS (SELECT 1 FROM lottery_results res WHERE res.round_id = lr.id)
     ORDER BY lr.close_at DESC
     LIMIT 1`,
    [lotteryCode]
  );
  return rows.length ? rows[0] : null;
}

/**
 * บันทึกผล + ออกผล + จ่ายรางวัล (atomic)
 * result = { prize_1st, prize_last_2, prize_front_3:[], prize_last_3:[] }
 */
async function announceResult(lotteryCode, result) {
  const round = await findClosedRound(lotteryCode);
  if (!round) {
    throw new Error(`${lotteryCode}: ไม่พบงวดที่ปิดรับและยังไม่มีผล`);
  }

  // ดึง lottery_type id
  const ltRows = await query(
    "SELECT id FROM lottery_types WHERE code=? LIMIT 1", [lotteryCode]
  );
  if (!ltRows.length) throw new Error(`lottery_type ${lotteryCode} not found`);
  const typeId = ltRows[0].id;

  const {
    prize_1st,
    prize_last_2,
    prize_front_3 = [],
    prize_last_3  = [],
    prize_2bot,           // ลาวพัฒนา เท่านั้น: 2bot = ตำแหน่ง 3-4
  } = result;

  // สำหรับลาวพัฒนา 2bot ใช้ตำแหน่ง 3-4 แทน prize_last_2 (ซึ่งคือ 2top)
  const effective_2bot = (lotteryCode === 'LA_GOV' && prize_2bot)
    ? prize_2bot
    : prize_last_2;
  // สำหรับลาวพัฒนา 3top ใช้ตำแหน่ง 4-5-6 (= prize_last_3[0])
  const effective_3top = (lotteryCode === 'LA_GOV' && prize_last_3.length > 0)
    ? prize_last_3[0]
    : prize_1st.slice(-3);

  await transaction(async (conn) => {
    // 1. Insert ผลรางวัล
    await conn.execute(
      `INSERT INTO lottery_results
         (round_id, prize_1st, prize_last_2, prize_front_3, prize_last_3, announced_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [round.id, prize_1st, prize_last_2,
       JSON.stringify(prize_front_3), JSON.stringify(prize_last_3)]
    );

    // 2. อัปเดตงวด → announced
    await conn.execute(
      "UPDATE lottery_rounds SET status='announced' WHERE id=?", [round.id]
    );

    // 3. ดึง rates ของ lottery type นี้
    const [[lt]] = await conn.execute(
      `SELECT rate_3top, rate_3tod, rate_2top, rate_2bot, rate_run_top, rate_run_bot
       FROM lottery_types WHERE id=?`, [typeId]
    );
    if (!lt) return;

    // 4. ดึง bets ทั้งหมดที่รอผล
    const [bets] = await conn.execute(
      "SELECT * FROM bets WHERE round_id=? AND status='waiting'", [round.id]
    );

    console.log(`[FETCHER:${lotteryCode}] ตรวจ ${bets.length} bets, งวด #${round.id} (${prize_1st})`);
    if (lotteryCode === 'LA_GOV')
      console.log(`[FETCHER:LA_GOV] 2bot=${effective_2bot}, 2top=${prize_last_2}, 3top=${effective_3top}`);

    // 5. ตรวจผลและจ่ายรางวัล
    for (const bet of bets) {
      let won = false, winAmt = 0;
      const n = bet.number;

      if      (bet.bet_type === '3top'    && effective_3top === n)
        { won = true; winAmt = bet.amount * lt.rate_3top; }
      else if (bet.bet_type === '3tod') {
        const s = n.split('').sort().join('');
        if (effective_3top.split('').sort().join('') === s)
          { won = true; winAmt = bet.amount * lt.rate_3tod; }
      }
      else if (bet.bet_type === '2top'    && prize_last_2 === n)
        { won = true; winAmt = bet.amount * lt.rate_2top; }
      else if (bet.bet_type === '2bot'    && effective_2bot === n)
        { won = true; winAmt = bet.amount * lt.rate_2bot; }
      else if (bet.bet_type === 'run_top' && prize_1st.includes(n))
        { won = true; winAmt = bet.amount * lt.rate_run_top; }
      else if (bet.bet_type === 'run_bot' && effective_2bot.includes(n))
        { won = true; winAmt = bet.amount * lt.rate_run_bot; }

      await conn.execute(
        'UPDATE bets SET status=?, win_amount=? WHERE id=?',
        [won ? 'win' : 'lose', winAmt, bet.id]
      );

      if (won && winAmt > 0) {
        const [[m]] = await conn.execute(
          'SELECT balance FROM members WHERE id=? FOR UPDATE', [bet.member_id]
        );
        const newBal = parseFloat(m.balance) + parseFloat(winAmt);
        await conn.execute(
          'UPDATE members SET balance=?, total_win=total_win+? WHERE id=?',
          [newBal, winAmt, bet.member_id]
        );
        await conn.execute(
          `INSERT INTO transactions
             (uuid, member_id, type, amount, balance_before, balance_after, description)
           VALUES (?, ?, 'win', ?, ?, ?, ?)`,
          [uuidv4(), bet.member_id, winAmt, m.balance, newBal,
           `ถูกรางวัล ${lotteryCode}: ${bet.number} (${bet.bet_type}) งวด ${round.round_name}`]
        );
        await conn.execute(
          'INSERT INTO notifications (member_id, title, body, type) VALUES (?, ?, ?, ?)',
          [bet.member_id,
           `🎉 ถูกรางวัล!`,
           `เลข ${bet.number} ถูกรางวัล ${lotteryCode}! ได้รับเงิน ฿${Number(winAmt).toLocaleString()}`,
           'win']
        );
      }
    }

    // 6. อัปเดต total_win ของงวด
    const [[ws]] = await conn.execute(
      'SELECT COALESCE(SUM(win_amount),0) s FROM bets WHERE round_id=? AND status="win"',
      [round.id]
    );
    await conn.execute(
      'UPDATE lottery_rounds SET total_win=? WHERE id=?', [ws.s, round.id]
    );
  });

  console.log(`[FETCHER:${lotteryCode}] ✅ ออกผลสำเร็จ: งวด #${round.id} (${prize_1st})`);
  return round.id;
}

// ── Simulated result fallback (for when external APIs are unreachable) ──────

/**
 * Generate a plausible simulated result for non-government lotteries.
 * Used as fallback when all external sources fail (e.g., Railway US servers).
 * TH_GOV is NOT simulated — real result required.
 */
function generateSimulatedResult(lotteryCode) {
  // 5-digit for VN_HAN types, 6-digit for Lao
  const digits = lotteryCode.startsWith('VN_') ? 5 : 6;
  const max    = Math.pow(10, digits);
  const prize_1st = String(Math.floor(Math.random() * max)).padStart(digits, '0');
  const front3 = digits === 6
    ? [String(Math.floor(Math.random() * 1000)).padStart(3,'0'), String(Math.floor(Math.random() * 1000)).padStart(3,'0')]
    : [];
  const last3  = [prize_1st.slice(-3)];
  return {
    prize_1st,
    prize_last_2: prize_1st.slice(-2),
    prize_front_3: front3,
    prize_last_3:  last3,
    _simulated: true,
  };
}

// ── Retry wrapper ──────────────────────────────────────────────

const SIMULATE_FALLBACK = ['LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP']; // TH_GOV must be real

async function runFetcher(lotteryCode, fetchFn, { simulate = false } = {}) {
  initStatus(lotteryCode);
  const status = fetcherStatus[lotteryCode];
  status.lastRun = new Date().toISOString();
  console.log(`[FETCHER:${lotteryCode}] เริ่ม fetch...`);

  // Check if already announced today
  try {
    const today = new Date().toISOString().slice(0,10);
    const existing = await query(
      `SELECT res.id FROM lottery_results res
       JOIN lottery_rounds lr ON lr.id = res.round_id
       JOIN lottery_types lt  ON lt.id = lr.lottery_id
       WHERE lt.code = ? AND DATE(res.announced_at) = ?
       LIMIT 1`,
      [lotteryCode, today]
    );
    if (existing.length > 0) {
      console.log(`[FETCHER:${lotteryCode}] ออกผลแล้ววันนี้ — ข้าม`);
      return true;
    }
  } catch(e) { /* non-fatal */ }

  // Try real external fetch
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fetchFn();
      await announceResult(lotteryCode, result);
      status.lastSuccess = new Date().toISOString();
      status.lastError   = null;
      status.retries     = 0;
      console.log(`[FETCHER:${lotteryCode}] ✅ ดึงผลจากแหล่งจริงสำเร็จ`);
      return true;
    } catch(e) {
      console.error(`[FETCHER:${lotteryCode}] attempt ${attempt}/${MAX_RETRIES}: ${e.message}`);
      status.lastError = e.message;
      status.retries   = attempt;
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 30 * 1000)); // 30s retry
    }
  }

  // Fallback: simulate result for non-government lotteries
  if (SIMULATE_FALLBACK.includes(lotteryCode) || simulate) {
    console.warn(`[FETCHER:${lotteryCode}] ⚠️  ดึงผลจากภายนอกล้มเหลว — ใช้ผลสุ่มแทน (fallback)`);
    try {
      const simResult = generateSimulatedResult(lotteryCode);
      await announceResult(lotteryCode, simResult);
      status.lastSuccess  = new Date().toISOString();
      status.lastError    = 'SIMULATED';
      status.retries      = 0;
      status.simulated    = true;
      console.log(`[FETCHER:${lotteryCode}] ✅ ออกผลสุ่ม (fallback): ${simResult.prize_1st}`);
      return true;
    } catch(e2) {
      console.error(`[FETCHER:${lotteryCode}] fallback ล้มเหลว: ${e2.message}`);
      status.lastError = e2.message;
    }
  } else {
    console.error(`[FETCHER:${lotteryCode}] หยุดหลัง ${MAX_RETRIES} ครั้ง — ต้องกรอกผลด้วยตนเอง`);
  }
  return false;
}

// ── Export สำหรับ manual trigger ──────────────────────────────

const FETCH_FUNCS = {
  TH_GOV:     fetchTHGov,
  LA_GOV:     fetchLAGov,
  VN_HAN:     fetchVNHanoi,
  VN_HAN_SP:  fetchVNHanoi,   // ฮานอยพิเศษ — ใช้ source เดียวกัน
  VN_HAN_VIP: fetchVNHanoi,   // ฮานอย VIP — ใช้ source เดียวกัน
};

async function triggerFetch(lotteryCode) {
  const fn = FETCH_FUNCS[lotteryCode];
  if (!fn) throw new Error(`Unknown lottery code: ${lotteryCode}`);
  return runFetcher(lotteryCode, fn);
}

// ── Start cron jobs ────────────────────────────────────────────

function startLotteryFetcher() {
  console.log('[FETCHER] เริ่ม Lottery Auto-Fetcher (tz: Asia/Bangkok)...');

  // ── หวยรัฐบาลไทย ─────────────────────────────────────────────
  // ออกผล 15:00 → fetch 15:30 (รอผล stabilize)
  // retry: 16:00, 16:30
  cron.schedule('30 15 1,16 * *', () => {
    console.log('[FETCHER] Trigger: TH_GOV');
    runFetcher('TH_GOV', fetchTHGov).catch(e =>
      console.error('[FETCHER] TH_GOV error:', e.message)
    );
  }, { timezone: TIMEZONE });

  // Retry ถ้ายังไม่ออก
  cron.schedule('0 16 1,16 * *', async () => {
    const status = fetcherStatus['TH_GOV'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] TH_GOV retry @ 16:00');
      runFetcher('TH_GOV', fetchTHGov).catch(e => console.error('[FETCHER] TH_GOV retry:', e.message));
    }
  }, { timezone: TIMEZONE });

  // ── หวยลาว ────────────────────────────────────────────────────
  // ออกผล ~20:30 → fetch 20:45
  cron.schedule('45 20 * * *', () => {
    console.log('[FETCHER] Trigger: LA_GOV');
    runFetcher('LA_GOV', fetchLAGov).catch(e =>
      console.error('[FETCHER] LA_GOV error:', e.message)
    );
  }, { timezone: TIMEZONE });

  // Retry 21:15
  cron.schedule('15 21 * * *', async () => {
    const status = fetcherStatus['LA_GOV'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] LA_GOV retry @ 21:15');
      runFetcher('LA_GOV', fetchLAGov).catch(e => console.error('[FETCHER] LA_GOV retry:', e.message));
    }
  }, { timezone: TIMEZONE });

  // ── ฮานอย VIP (~17:00) ────────────────────────────────────────
  cron.schedule('15 17 * * *', () => {
    console.log('[FETCHER] Trigger: VN_HAN_VIP');
    runFetcher('VN_HAN_VIP', fetchVNHanoi).catch(e =>
      console.error('[FETCHER] VN_HAN_VIP error:', e.message)
    );
  }, { timezone: TIMEZONE });

  cron.schedule('45 17 * * *', async () => {
    const status = fetcherStatus['VN_HAN_VIP'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] VN_HAN_VIP retry @ 17:45');
      runFetcher('VN_HAN_VIP', fetchVNHanoi).catch(e => console.error('[FETCHER] VN_HAN_VIP retry:', e.message));
    }
  }, { timezone: TIMEZONE });

  // ── ฮานอยพิเศษ (~17:30) ─────────────────────────────────────
  cron.schedule('45 17 * * *', () => {
    console.log('[FETCHER] Trigger: VN_HAN_SP');
    runFetcher('VN_HAN_SP', fetchVNHanoi).catch(e =>
      console.error('[FETCHER] VN_HAN_SP error:', e.message)
    );
  }, { timezone: TIMEZONE });

  cron.schedule('15 18 * * *', async () => {
    const status = fetcherStatus['VN_HAN_SP'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] VN_HAN_SP retry @ 18:15');
      runFetcher('VN_HAN_SP', fetchVNHanoi).catch(e => console.error('[FETCHER] VN_HAN_SP retry:', e.message));
    }
  }, { timezone: TIMEZONE });

  // ── ฮานอยปกติ (~18:30) ──────────────────────────────────────
  cron.schedule('45 18 * * *', () => {
    console.log('[FETCHER] Trigger: VN_HAN');
    runFetcher('VN_HAN', fetchVNHanoi).catch(e =>
      console.error('[FETCHER] VN_HAN error:', e.message)
    );
  }, { timezone: TIMEZONE });

  // Retry 19:15
  cron.schedule('15 19 * * *', async () => {
    const status = fetcherStatus['VN_HAN'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] VN_HAN retry @ 19:15');
      runFetcher('VN_HAN', fetchVNHanoi).catch(e => console.error('[FETCHER] VN_HAN retry:', e.message));
    }
  }, { timezone: TIMEZONE });

  console.log('[FETCHER] Crons ลงทะเบียนแล้ว:');
  console.log('  TH_GOV      → วันที่ 1, 16 @ 15:30 (retry 16:00)');
  console.log('  LA_GOV      → ทุกวัน @ 20:45 (retry 21:15)');
  console.log('  VN_HAN_VIP  → ทุกวัน @ 17:15 (retry 17:45)');
  console.log('  VN_HAN_SP   → ทุกวัน @ 17:45 (retry 18:15)');
  console.log('  VN_HAN      → ทุกวัน @ 18:45 (retry 19:15)');
}

module.exports = { startLotteryFetcher, fetcherStatus, triggerFetch };
