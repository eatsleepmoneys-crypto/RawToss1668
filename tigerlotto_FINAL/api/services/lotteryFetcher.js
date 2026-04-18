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

// ── ScraperAPI proxy support ───────────────────────────────────────
// Railway servers are blocked by Thai/Lao sites at IP level.
// Solution: route via ScraperAPI which has residential IPs in TH/LA.
// Get a free key at https://scraperapi.com (1000 calls/month free)
// Set env var: SCRAPERAPI_KEY=your_key
// Or store in settings table: key='scraperapi_key'

let _scraperApiKey = process.env.SCRAPERAPI_KEY || null;

async function getScraperApiKey() {
  if (_scraperApiKey) return _scraperApiKey;
  try {
    const rows = await query("SELECT value FROM settings WHERE `key`='scraperapi_key' LIMIT 1");
    if (rows.length && rows[0].value) {
      _scraperApiKey = rows[0].value;
      return _scraperApiKey;
    }
  } catch {}
  return null;
}

// Invalidate cache when settings change
function clearScraperApiKeyCache() { _scraperApiKey = null; }

/**
 * Build proxy URL via ScraperAPI if key is configured, otherwise direct.
 * country_code=th routes through Thai residential IP.
 */
async function buildProxyUrl(targetUrl, countryCode = 'th') {
  const key = await getScraperApiKey();
  if (!key) return targetUrl; // direct (may be blocked)
  return `https://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(targetUrl)}&country_code=${countryCode}&render=false`;
}

// ── HTTP helper ────────────────────────────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'th,lo;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
};

// Direct HTTP (no proxy) — used for non-blocked sources or ScraperAPI itself
const httpGet = (url, ms = 15000) => axios.get(url, { timeout: ms, headers: BROWSER_HEADERS });

// Proxy-aware HTTP — auto-routes through ScraperAPI if key configured
async function httpGetProxy(url, ms = 25000, countryCode = 'th') {
  const proxyUrl = await buildProxyUrl(url, countryCode);
  const usingProxy = proxyUrl !== url;
  if (usingProxy) console.log(`[PROXY] ${url.slice(0, 60)}... → ScraperAPI (${countryCode})`);
  return axios.get(proxyUrl, {
    timeout: ms,
    headers: usingProxy ? {} : BROWSER_HEADERS, // ScraperAPI sends its own headers
  });
}

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
    const res = await httpGetProxy('https://money.longdo.com/lotto/api');
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
    const res = await httpGetProxy('https://api.sanook.com/lottoapi/latest');
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
    const res = await httpGetProxy('https://www.manager.co.th/Lotto/');
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
  // Source 1: Sanook Lao Lottery (Thai site — fast, reliable 4-digit result)
  try {
    const res = await httpGetProxy('https://www.sanook.com/news/laolotto/', 30000, 'th');
    const $   = cheerio.load(res.data);
    let raw = '';
    $('strong,b,.textBold').each((_, el) => {
      if ($(el).children().length > 0) return;
      const t = $(el).text().replace(/\s+/g, '').replace(/\D/g, '');
      if (/^\d{4}$/.test(t)) {
        const n = parseInt(t, 10);
        if (n >= 2500 && n <= 2600) return; // skip Buddhist Era years
        if (!raw) raw = t;
      }
    });
    if (!raw) {
      const m4 = (String(res.data).match(/\b(\d{4})\b/g) || [])
        .find(m => !(parseInt(m) >= 2500 && parseInt(m) <= 2600));
      if (m4) raw = m4;
    }
    if (raw) {
      console.log('[FETCHER:LA_GOV] Source: sanook.com (4-digit)', raw);
      return laGovExtract(raw);
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] sanook.com error:', e.message); }

  // Source 2: huaylao.net (JSON — may timeout)
  try {
    const res = await httpGetProxy('https://huaylao.net/api/latest', 30000, 'th');
    const d   = res.data;
    if (d && (d.prize1 || d.first)) {
      const raw = (d.prize1 || d.first || '').replace(/\D/g,'');
      if (raw.length >= 4) {
        console.log('[FETCHER:LA_GOV] Source: huaylao.net API');
        return laGovExtract(raw);
      }
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] huaylao.net error:', e.message); }

  // Source 4: LD1 Official Lao Lottery (HTML — slow, may timeout)
  try {
    const res = await httpGetProxy('https://www.ld1.la/', 40000, 'th');
    const $   = cheerio.load(res.data);
    let p6 = '';
    $('[class*="prize"],[class*="result"],[class*="number"],[class*="lotto"],[class*="jackpot"],[class*="winner"]').each((_, el) => {
      const t = $(el).text().replace(/\s+/g,'').replace(/\D/g,'');
      if (/^\d{6}$/.test(t) && !p6) p6 = t;
    });
    if (!p6) {
      $('strong,b,h1,h2,h3,span,td').each((_, el) => {
        if ($(el).children().length > 0) return;
        const t = $(el).text().replace(/\s+/g,'').replace(/\D/g,'');
        if (/^\d{6}$/.test(t) && !p6) p6 = t;
      });
    }
    if (!p6) {
      const m = String(res.data).match(/\b(\d{6})\b/);
      if (m) p6 = m[1];
    }
    if (p6) {
      console.log('[FETCHER:LA_GOV] Source: ld1.la (official)');
      return laGovExtract(p6);
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] ld1.la error:', e.message); }

  // Source 5: lottovip.com (Thai residential proxy — works in production 1×/day)
  try {
    const res = await httpGetProxy('https://www.lottovip.com/lao-lottery-result/', 40000, 'th');
    const $   = cheerio.load(res.data);
    let p6 = '';
    $('[class*="result"],[class*="number"],[class*="prize"],[class*="jackpot"]').each((_, el) => {
      const t = $(el).text().replace(/\s+/g,'').replace(/\D/g,'');
      if (/^\d{6}$/.test(t) && !p6) p6 = t;
    });
    if (!p6) {
      $('strong,b,span,td').each((_, el) => {
        if ($(el).children().length > 0) return;
        const t = $(el).text().replace(/\s+/g,'').replace(/\D/g,'');
        if (/^\d{6}$/.test(t) && !p6) p6 = t;
      });
    }
    if (!p6) {
      const m = String(res.data).match(/\b(\d{6})\b/);
      if (m) p6 = m[1];
    }
    if (p6) {
      console.log('[FETCHER:LA_GOV] Source: lottovip.com');
      return laGovExtract(p6);
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
    const res   = await httpGetProxy(`https://xoso.com.vn/api/xs-mb-${today}.js`);
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
    const res = await httpGetProxy('https://xosomiennam.net/ket-qua-xo-so-mien-bac', 20000);
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
    const res = await httpGetProxy('https://ketqua.tv/xo-so-mien-bac.html');
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

// ══════════════════════════════════════════════════════════════
//  DB-DRIVEN SOURCE ENGINE
//  อ่าน lottery_api_sources จาก DB แล้วลองทีละ source
// ══════════════════════════════════════════════════════════════

/**
 * ดึงค่าจาก JSON object ด้วย dot-path เช่น "data.result.prize1"
 */
function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

/**
 * Transform response ตาม transform type ที่กำหนด
 * Returns standardized { prize_1st, prize_last_2, prize_front_3:[], prize_last_3:[], prize_2bot? }
 * or throws on failure
 */
function applyTransform(transform, data, src) {
  const clean = s => String(s || '').replace(/\D/g, '');

  switch (transform) {
    // ─── Longdo Money JSON ─────────────────────────────────────
    case 'longdo': {
      const p1 = clean(data.first || data.prize1 || data.prizeFirst);
      if (!/^\d{6}$/.test(p1)) throw new Error('longdo: ไม่พบรางวัลที่ 1 (6 หลัก)');
      const last2  = clean(data.last2 || p1.slice(-2));
      const front3 = [clean(data.front3_1), clean(data.front3_2)].filter(x => /^\d{3}$/.test(x));
      const last3  = [clean(data.last3_1),  clean(data.last3_2)].filter(x => /^\d{3}$/.test(x));
      return { prize_1st: p1, prize_last_2: last2, prize_front_3: front3, prize_last_3: last3 };
    }

    // ─── Sanook Lotto API JSON ─────────────────────────────────
    case 'sanook': {
      const d  = data.result || data;
      const p1 = clean(d.prize1 || d.first);
      if (!/^\d{6}$/.test(p1)) throw new Error('sanook: ไม่พบรางวัลที่ 1 (6 หลัก)');
      return {
        prize_1st:     p1,
        prize_last_2:  clean(d.last2 || p1.slice(-2)),
        prize_front_3: [d.front3_1, d.front3_2].filter(Boolean).map(clean).filter(x => /^\d{3}$/.test(x)),
        prize_last_3:  [d.last3_1,  d.last3_2].filter(Boolean).map(clean).filter(x => /^\d{3}$/.test(x)),
      };
    }

    // ─── HTML scrape — TH_GOV ──────────────────────────────────
    case 'html_th_gov': {
      const $ = cheerio.load(data);
      let p1 = '';
      // Pass 1: specific prize elements
      $('[class*="prize"],[class*="first"],[class*="jackpot"],[class*="lotto"],[id*="prize"],[id*="first"]').each((_, el) => {
        const t = $(el).text().replace(/\s+/g, '').replace(/\D/g, '');
        if (/^\d{6}$/.test(t) && !p1) p1 = t;
      });
      // Pass 2: broad scrape — any element containing exactly 6 digits
      if (!p1) {
        $('*').each((_, el) => {
          const children = $(el).children();
          if (children.length > 0) return; // leaf nodes only
          const t = $(el).text().replace(/\s+/g, '').replace(/\D/g, '');
          if (/^\d{6}$/.test(t) && !p1) p1 = t;
        });
      }
      // Pass 3: regex scan on full HTML for standalone 6-digit numbers
      if (!p1) {
        const m = String(data).match(/\b(\d{6})\b/);
        if (m) p1 = m[1];
      }
      if (!p1) throw new Error('html_th_gov: scrape ไม่พบ 6 หลัก');
      return { prize_1st: p1, prize_last_2: p1.slice(-2), prize_front_3: [], prize_last_3: [] };
    }

    // ─── HTML scrape — LA_GOV ─────────────────────────────────
    case 'html_la_gov': {
      const $ = cheerio.load(data);
      let p6 = '';
      // Pass 1: prize/result/number class elements — look for exactly 6 digits
      $('[class*="prize"],[class*="result"],[class*="number"],[class*="lotto"],[class*="jackpot"],[class*="winner"],[class*="reward"],[class*="digit"]').each((_, el) => {
        const t = $(el).text().replace(/\s+/g, '').replace(/\D/g, '');
        if (/^\d{6}$/.test(t) && !p6) p6 = t;
      });
      // Pass 2: leaf nodes (strong/b/td/span/h tags) with exactly 6 digits
      if (!p6) {
        $('strong,b,h1,h2,h3,h4,span,td').each((_, el) => {
          if ($(el).children().length > 0) return;
          const t = $(el).text().replace(/\s+/g, '').replace(/\D/g, '');
          if (/^\d{6}$/.test(t) && !p6) p6 = t;
        });
      }
      // Pass 3: regex scan for standalone 6-digit number in raw HTML
      if (!p6) {
        const m6 = String(data).match(/\b(\d{6})\b/g) || [];
        if (m6.length) p6 = m6[0];
      }
      // Pass 4: accept 4-5 digit and pad (last resort)
      if (!p6) {
        const m45 = String(data).match(/\b(\d{4,5})\b/g) || [];
        if (m45.length) p6 = m45[0].padStart(6, '0');
      }
      if (!p6) throw new Error('html_la_gov: scrape ไม่พบตัวเลข');
      return laGovExtract(p6);
    }

    // ─── Sanook laolotto page (4-digit เลขท้าย) ───────────────
    case 'html_sanook_lao': {
      const $ = cheerio.load(data);
      let raw = '';
      // Primary: find 4-digit number in strong/b elements — skip BE years (2500-2600)
      $('strong,b,.textBold').each((_, el) => {
        if ($(el).children().length > 0) return;
        const t = $(el).text().replace(/\s+/g, '').replace(/\D/g, '');
        if (/^\d{4}$/.test(t)) {
          const n = parseInt(t, 10);
          if (n >= 2500 && n <= 2600) return; // skip Buddhist Era years
          if (!raw) raw = t;
        }
      });
      // Fallback: also accept 6-digit
      if (!raw) {
        $('strong,b,td,span').each((_, el) => {
          if ($(el).children().length > 0) return;
          const t = $(el).text().replace(/\s+/g, '').replace(/\D/g, '');
          if (/^\d{6}$/.test(t) && !raw) raw = t;
        });
      }
      // Regex fallback: first 4-digit number that's not a year
      if (!raw) {
        const m4 = (String(data).match(/\b(\d{4})\b/g) || [])
          .find(m => !(parseInt(m) >= 2500 && parseInt(m) <= 2600));
        if (m4) raw = m4;
      }
      if (!raw) throw new Error('html_sanook_lao: ไม่พบตัวเลข');
      return laGovExtract(raw);
    }

    // ─── HTML scrape — VN_HAN ─────────────────────────────────
    case 'html_vn_han': {
      const $ = cheerio.load(data);
      let p = '';
      // Pass 1: specific prize classes (Vietnamese lottery sites)
      $('[class*="giai-nhat"],[class*="giainhat"],[class*="prize1"],[class*="jackpot"],[class*="special"],[class*="dac-biet"],[class*="dacbiet"]').each((_, el) => {
        const t = $(el).text().trim().replace(/\D/g, '');
        if (t.length >= 4 && !p) p = t;
      });
      // Pass 2: look for 5-digit numbers in table cells
      if (!p) {
        $('td,span,div,b,strong').each((_, el) => {
          const children = $(el).children();
          const t = $(el).text().trim().replace(/\D/g, '');
          if (/^\d{5}$/.test(t) && !p) p = t;
        });
      }
      // Pass 3: regex scan for first 5-digit number in HTML
      if (!p) {
        const m = String(data).match(/\b(\d{5})\b/);
        if (m) p = m[1];
      }
      if (!p) throw new Error('html_vn_han: scrape ไม่พบ 5 หลัก');
      return { prize_1st: p, prize_last_2: p.slice(-2), prize_front_3: [], prize_last_3: [p.slice(-3)] };
    }

    // ─── xoso.com.vn JS endpoint ──────────────────────────────
    case 'xoso_js': {
      const m = JSON.stringify(data).match(/"giainhat"\s*:\s*\["(\d+)"\]/);
      if (!m) throw new Error('xoso_js: ไม่พบ giainhat');
      const p = m[1];
      return { prize_1st: p, prize_last_2: p.slice(-2), prize_front_3: [], prize_last_3: [p.slice(-3)] };
    }

    // ─── RSS/XML ─────────────────────────────────────────────
    case 'rss_vn': {
      // ดึง 5-digit จาก RSS content
      const matches = String(data).match(/\b\d{5}\b/g);
      if (!matches || !matches.length) throw new Error('rss_vn: ไม่พบ 5 หลัก');
      const p = matches[0];
      return { prize_1st: p, prize_last_2: p.slice(-2), prize_front_3: [], prize_last_3: [p.slice(-3)] };
    }

    // ─── JSON flat (prize_1st, prize_last_2 ตรงๆ) ──────────
    case 'json_flat': {
      const p1 = clean(data.prize_1st || data.prize1 || data.first);
      if (!p1) throw new Error('json_flat: ไม่พบ prize_1st');
      return {
        prize_1st:     p1,
        prize_last_2:  clean(data.prize_last_2 || data.last2 || p1.slice(-2)),
        prize_front_3: (data.prize_front_3 || data.front3 || []).map(clean).filter(Boolean),
        prize_last_3:  (data.prize_last_3  || data.last3  || []).map(clean).filter(Boolean),
      };
    }

    // ─── Custom path mapping ──────────────────────────────────
    case 'custom': {
      const p1 = clean(getByPath(data, src.path_prize1));
      if (!p1) throw new Error(`custom: path "${src.path_prize1}" ไม่พบค่า`);
      const last2Val = getByPath(data, src.path_last2);
      return {
        prize_1st:     p1,
        prize_last_2:  last2Val ? clean(last2Val) : p1.slice(-2),
        prize_front_3: src.path_front3 ? [].concat(getByPath(data, src.path_front3) || []).map(clean).filter(Boolean) : [],
        prize_last_3:  src.path_last3  ? [].concat(getByPath(data, src.path_last3)  || []).map(clean).filter(Boolean) : [],
      };
    }

    // ─── Auto: ลอง detect รูปแบบ JSON ────────────────────────
    case 'auto':
    default: {
      // ถ้าเป็น HTML
      if (typeof data === 'string' && data.trim().startsWith('<')) {
        // ลอง detect lottery type จาก src.lottery_code
        if (src.lottery_code === 'TH_GOV') return applyTransform('html_th_gov', data, src);
        if (src.lottery_code === 'LA_GOV') return applyTransform('html_la_gov', data, src);
        return applyTransform('html_vn_han', data, src);
      }
      // ถ้าเป็น JSON — ลอง longdo, sanook, json_flat ตามลำดับ
      if (data && (data.first || data.prize1 || data.prizeFirst)) {
        // longdo-like
        const p1 = (data.first || data.prize1 || '').replace(/\D/g,'');
        if (/^\d{6}$/.test(p1)) return applyTransform('longdo', data, src);
      }
      if (data && data.result) return applyTransform('sanook', data, src);
      return applyTransform('json_flat', data, src);
    }
  }
}

/**
 * ดึงผลจาก source เดียว (สำหรับ test และ loop)
 * Returns standardized result หรือ throw
 */
async function fetchOneSource(src) {
  // If source has its own api_key configured — use direct (it's likely a proxy/API service already)
  // Otherwise route through ScraperAPI proxy if configured
  const useDirectForApiKey = !!src.api_key;

  const headers = { ...BROWSER_HEADERS };
  // Extra headers from DB
  if (src.extra_headers) {
    try { Object.assign(headers, JSON.parse(src.extra_headers)); } catch {}
  }
  // API Key header
  if (src.api_key) headers['x-api-key'] = src.api_key;

  let rawData;
  if (src.method === 'POST') {
    const bodyData = src.body_template ? JSON.parse(src.body_template) : {};
    const url = useDirectForApiKey ? src.source_url : await buildProxyUrl(src.source_url);
    const resp = await axios.post(url, bodyData, { headers, timeout: 25000 });
    rawData = resp.data;
  } else {
    if (useDirectForApiKey) {
      // Source has its own auth — call directly
      const resp = await axios.get(src.source_url, { headers, timeout: 25000 });
      rawData = resp.data;
    } else {
      // Determine country code and timeout based on lottery type
      // Note: ScraperAPI supports 'th' (Thailand) and 'sg' (Singapore) for SEA;
      // 'la' (Laos) and 'vn' (Vietnam) are NOT valid country codes — use nearest.
      const cc = src.lottery_code?.startsWith('VN_') ? 'sg'
               : 'th'; // LA_GOV and TH_GOV: Thai residential proxy
      const ms = (src.lottery_code === 'LA_GOV' || src.lottery_code?.startsWith('VN_')) ? 45000 : 30000;
      // Route through proxy (ScraperAPI) if key configured, else direct
      const resp = await httpGetProxy(src.source_url, ms, cc);
      rawData = resp.data;
    }
  }

  return applyTransform(src.transform, rawData, src);
}

/**
 * ลองดึงผลจาก DB sources ทั้งหมดของ lotteryCode ตามลำดับ sort_order
 * Returns result หรือ null ถ้าทุก source ล้มเหลว
 */
async function fetchFromDbSources(lotteryCode) {
  let sources = [];
  try {
    sources = await query(
      `SELECT * FROM lottery_api_sources
       WHERE lottery_code=? AND enabled=1
       ORDER BY sort_order, id`,
      [lotteryCode]
    );
  } catch (e) {
    console.warn(`[FETCHER:${lotteryCode}] ไม่สามารถอ่าน DB sources:`, e.message);
    return null;
  }

  if (!sources.length) {
    console.log(`[FETCHER:${lotteryCode}] ไม่มี DB sources ที่ enable`);
    return null;
  }

  for (const src of sources) {
    try {
      console.log(`[FETCHER:${lotteryCode}] ลอง DB source: "${src.name}" (${src.source_url.slice(0,60)})`);
      const result = await fetchOneSource(src);
      // Update last_status in background
      query('UPDATE lottery_api_sources SET last_status="ok", last_checked=NOW() WHERE id=?', [src.id])
        .catch(() => {});
      console.log(`[FETCHER:${lotteryCode}] ✅ DB source สำเร็จ: ${src.name} → ${result.prize_1st}`);
      return result;
    } catch (e) {
      console.warn(`[FETCHER:${lotteryCode}] DB source "${src.name}" ล้มเหลว: ${e.message}`);
      query('UPDATE lottery_api_sources SET last_status="error", last_checked=NOW() WHERE id=?', [src.id])
        .catch(() => {});
    }
  }

  console.log(`[FETCHER:${lotteryCode}] DB sources ทั้งหมดล้มเหลว`);
  return null;
}

/**
 * ทดสอบ source เดียว — ใช้โดย admin API
 */
async function testSource(src) {
  try {
    const result = await fetchOneSource(src);
    return {
      success:    true,
      prize_1st:  result.prize_1st,
      prize_last_2: result.prize_last_2,
      prize_front_3: result.prize_front_3,
      prize_last_3:  result.prize_last_3,
      transform:  src.transform,
      source:     src.name,
    };
  } catch (e) {
    return { success: false, error: e.message, source: src.name };
  }
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

  // ── STEP 1: ลอง DB sources ก่อน (configured by admin) ─────
  const dbResult = await fetchFromDbSources(lotteryCode);
  if (dbResult) {
    try {
      await announceResult(lotteryCode, dbResult);
      status.lastSuccess = new Date().toISOString();
      status.lastError   = null;
      status.retries     = 0;
      status.simulated   = false;
      console.log(`[FETCHER:${lotteryCode}] ✅ ใช้ DB source สำเร็จ`);
      return true;
    } catch (e) {
      console.error(`[FETCHER:${lotteryCode}] announceResult จาก DB source ล้มเหลว: ${e.message}`);
      // ต่อไปลอง hardcoded
    }
  }

  // ── STEP 2: ลอง hardcoded fetcher (fallback) ──────────────
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fetchFn();
      await announceResult(lotteryCode, result);
      status.lastSuccess = new Date().toISOString();
      status.lastError   = null;
      status.retries     = 0;
      status.simulated   = false;
      console.log(`[FETCHER:${lotteryCode}] ✅ ดึงผลจาก hardcoded source สำเร็จ`);
      return true;
    } catch(e) {
      console.error(`[FETCHER:${lotteryCode}] hardcoded attempt ${attempt}/${MAX_RETRIES}: ${e.message}`);
      status.lastError = e.message;
      status.retries   = attempt;
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 30 * 1000));
    }
  }

  console.error(`[FETCHER:${lotteryCode}] ทุก source ล้มเหลว`);
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

module.exports = { startLotteryFetcher, fetcherStatus, triggerFetch, testSource, clearScraperApiKeyCache };
