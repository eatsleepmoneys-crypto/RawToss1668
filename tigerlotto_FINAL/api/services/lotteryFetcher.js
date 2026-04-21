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

/** Extract GDB + G1 from raw RSS/HTML text using label-based regex first,
 *  then fall back to positional matching.
 *  Returns { gdb, g1 } (g1 may be null) or null if nothing found.
 */
function extractGdbG1(raw) {
  // Pass 1: label-based (works when Vietnamese prize labels are present)
  const gdbM = raw.match(/(?:Đặc Biệt|đặc biệt|\bDB\b|\bĐB\b)[^\d]*(\d{5})/i)
             || raw.match(/(?:dac biet|dacbiet)[^\d]*(\d{5})/i);
  const g1M  = raw.match(/(?:Giải Nhất|giải nhất|Gi[àảã]i Nh[aấ]t|Nh[aấ]t)[^\d]*(\d{5})/i)
             || raw.match(/(?:\bG\.?1\b|Nhat)[^\d]*(\d{5})/i);
  if (gdbM) return { gdb: gdbM[1], g1: g1M ? g1M[1] : null };

  // Pass 2: positional — first two 5-digit numbers in text
  const nums = raw.match(/\b\d{5}\b/g);
  if (nums && nums.length >= 2) return { gdb: nums[0], g1: nums[1] };
  if (nums && nums.length === 1) return { gdb: nums[0], g1: null };
  return null;
}

/**
 * หวยฮานอย (Xổ số Miền Bắc) — ออกผลทุกวัน ~18:30 น.
 * รางวัลที่ 1 (Giải nhất) = 5 หลัก
 */
async function fetchVNHanoi() {
  /**
   * โครงสร้างรางวัล XSMB:
   *   GDB (Giải Đặc Biệt) → prize_1st → 2 ตัวบน = GDB[-2:]
   *   G1  (Giải Nhất)     → prize_2bot → 2 ตัวล่าง = G1[-2:]
   */
  function vn(gdb, g1) {
    return {
      prize_1st:    gdb,
      prize_last_2: gdb.slice(-2),            // 2 ตัวบน  (last 2 ของ GDB)
      prize_2bot:   g1 ? g1.slice(-2) : null, // 2 ตัวล่าง (last 2 ของ G1)
      prize_front_3: [],
      prize_last_3:  [gdb.slice(-3)],
    };
  }

  // Source 1: xskt.com.vn RSS feed (XML — most reliable from Railway US servers)
  try {
    const res = await httpGet('https://xskt.com.vn/rss-feed/mien-bac-xsmb.rss', 20000);
    const parsed = extractGdbG1(String(res.data));
    if (parsed) {
      console.log('[FETCHER:VN_HAN] RSS GDB=%s G1=%s', parsed.gdb, parsed.g1 || '?');
      return vn(parsed.gdb, parsed.g1);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] xskt RSS error:', e.message); }

  // Source 2: ketqua.tv (HTML scrape via ScraperAPI)
  try {
    const res = await httpGetProxy('https://ketqua.tv/xo-so-mien-bac.html', 30000, 'sg');
    const $   = cheerio.load(res.data);
    let gdb = '', g1 = '';
    // Pass A: CSS class selectors for GDB
    $('[class*="giai-db"],[class*="giaidb"],[class*="dac-biet"],[class*="dacbiet"],[class*="jackpot"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g,'');
      if (t.length >= 4 && !gdb) gdb = t.slice(-5).padStart(5,'0');
    });
    // Pass B: CSS class selectors for G1
    $('[class*="giai-nhat"],[class*="giainhat"],[class*="prize1"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g,'');
      if (t.length >= 4 && !g1) g1 = t.slice(-5).padStart(5,'0');
    });
    // Pass C: text-based row matching (handles sites without semantic class names)
    if (!g1) {
      $('tr,li').each((_, el) => {
        const rowText = $(el).text();
        if (/nh[aấ]t|g\.?1\b/i.test(rowText) && !g1) {
          const m = rowText.match(/\d{5}/);
          if (m) g1 = m[0];
        }
        if (/đặc biệt|dac biet|DB|ĐB/i.test(rowText) && !gdb) {
          const m = rowText.match(/\d{5}/);
          if (m) gdb = m[0];
        }
      });
    }
    // Pass D: positional fallback — first two distinct 5-digit numbers
    if (!gdb) {
      const nums = [];
      $('td,span').each((_, el) => {
        const t = $(el).text().trim().replace(/\D/g,'');
        if (/^\d{5}$/.test(t) && nums.length < 2) nums.push(t);
      });
      if (nums[0]) gdb = nums[0];
      if (nums[1] && !g1) g1 = nums[1];
    }
    if (gdb) {
      console.log('[FETCHER:VN_HAN] ketqua.tv GDB=%s G1=%s', gdb, g1 || '?');
      return vn(gdb, g1 || null);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] ketqua.tv error:', e.message); }

  // Source 3: xosomiennam.net (HTML scrape via ScraperAPI)
  try {
    const res = await httpGetProxy('https://xosomiennam.net/ket-qua-xo-so-mien-bac', 30000, 'sg');
    const $   = cheerio.load(res.data);
    let gdb = '', g1 = '';
    // Text-based row matching
    $('tr,li').each((_, el) => {
      const rowText = $(el).text();
      if (/nh[aấ]t|g\.?1\b/i.test(rowText) && !g1) {
        const m = rowText.match(/\d{5}/);
        if (m) g1 = m[0];
      }
      if (/đặc biệt|dac biet/i.test(rowText) && !gdb) {
        const m = rowText.match(/\d{5}/);
        if (m) gdb = m[0];
      }
    });
    // Positional fallback
    if (!gdb) {
      const nums = [];
      $('td,span,div').each((_, el) => {
        const t = $(el).text().trim().replace(/\D/g,'');
        if (/^\d{5}$/.test(t) && nums.length < 2) nums.push(t);
      });
      if (nums[0]) { gdb = nums[0]; if (nums[1] && !g1) g1 = nums[1]; }
    }
    if (gdb) {
      console.log('[FETCHER:VN_HAN] xosomiennam GDB=%s G1=%s', gdb, g1 || '?');
      return vn(gdb, g1 || null);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] xosomiennam error:', e.message); }

  // Source 4: xsmb.vn RSS (backup RSS source)
  try {
    const res = await httpGet('https://xsmb.vn/rss', 20000);
    const parsed = extractGdbG1(String(res.data));
    if (parsed) {
      console.log('[FETCHER:VN_HAN] xsmb.vn RSS GDB=%s G1=%s', parsed.gdb, parsed.g1 || '?');
      return vn(parsed.gdb, parsed.g1);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] xsmb.vn RSS error:', e.message); }

  // Source 5: TNews.co.th (Thai news site — tnews.co.th/lotto-horo-belief/...)
  try {
    const result = await fetchTNewsVNHanoi('VN_HAN');
    if (result) {
      console.log('[FETCHER:VN_HAN] TNews GDB=%s G1=%s', result.prize_1st, result.prize_2bot || '?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] TNews error:', e.message); }

  throw new Error('VN_HAN: แหล่งข้อมูลทุกแหล่งล้มเหลว');
}

// ═══════════════════════════════════════════════════════════════════
//  TNews scraper — tnews.co.th/lotto-horo-belief/...
//  เว็บข่าวไทยที่รายงานผลหวยเวียดนามพร้อมตารางรางวัลทุกวัน
//
//  lotteryType: 'VN_HAN' | 'VN_HAN_SP' | 'VN_HAN_VIP'
//
//  วิธีทำงาน:
//  1. ดึงหน้า listing tnews.co.th/lotto-horo-belief เพื่อหา URL บทความวันนี้
//  2. ดึงบทความนั้น และ scrape ตัวเลขรางวัล
//  3. Match กับ keyword ของแต่ละ lottery type
// ═══════════════════════════════════════════════════════════════════

// Keyword ใช้ match บทความในหน้า listing
const TNEWS_KEYWORDS = {
  VN_HAN:     ['ฮานอยปกติ', 'หวยฮานอยปกติ', 'ฮานอย', 'ผลหวยฮานอย'],
  VN_HAN_SP:  ['ฮานอยพิเศษ', 'หวยฮานอยพิเศษ', 'พิเศษ'],
  VN_HAN_VIP: ['ฮานอยวีไอพี', 'ฮานอย vip', 'วีไอพี', 'ฮานอยVIP'],
};

/**
 * ดึงผลหวยเวียดนามจาก TNews.co.th
 * @param {string} lotteryType  'VN_HAN' | 'VN_HAN_SP' | 'VN_HAN_VIP'
 * @returns {{ prize_1st, prize_last_2, prize_2bot, prize_front_3, prize_last_3 }} หรือ null
 */
async function fetchTNewsVNHanoi(lotteryType) {
  const vn = (gdb, g1) => ({
    prize_1st:    gdb,
    prize_last_2: gdb.slice(-2),
    prize_2bot:   g1 ? g1.slice(-2) : null,
    prize_front_3: [],
    prize_last_3:  [gdb.slice(-3)],
  });

  // ── Step 1: ดึง listing page เพื่อหา URL บทความล่าสุดวันนี้ ──
  const todayStr = (() => {
    const d = new Date(Date.now() + 7 * 3600 * 1000); // UTC+7
    return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
  })();

  const LISTING_URLS = [
    'https://www.tnews.co.th/lotto-horo-belief',
    'https://www.tnews.co.th/category/lotto-horo-belief',
    'https://www.tnews.co.th/contents/lotto-horo-belief',
    'https://www.tnews.co.th/tag/%E0%B8%AB%E0%B8%A7%E0%B8%A2%E0%B8%AE%E0%B8%B2%E0%B8%99%E0%B8%AD%E0%B8%A2', // tag/หวยฮานอย
  ];

  let articleUrl = null;
  const keywords = TNEWS_KEYWORDS[lotteryType] || TNEWS_KEYWORDS.VN_HAN;

  for (const listUrl of LISTING_URLS) {
    try {
      const listRes = await httpGetProxy(listUrl, 20000, 'th');
      const $list   = cheerio.load(listRes.data);

      // หา <a> ที่มี href ประกอบด้วย /lotto-horo-belief/ และมี keyword ของ lotteryType
      $list('a[href*="lotto-horo-belief/"]').each((_, el) => {
        if (articleUrl) return;
        const href = $list(el).attr('href') || '';
        const text = $list(el).text().toLowerCase();
        const titleAttr = ($list(el).attr('title') || '').toLowerCase();
        const combined  = text + ' ' + titleAttr;
        const keyMatch  = keywords.some(kw => combined.includes(kw.toLowerCase()));
        if (keyMatch && /\/lotto-horo-belief\/\d+/.test(href)) {
          articleUrl = href.startsWith('http') ? href : 'https://www.tnews.co.th' + href;
        }
      });

      // ถ้ายังไม่เจอ keyword match — ลองเอา URL ล่าสุดในหน้าก่อน (อาจเป็นบทความวันนี้)
      if (!articleUrl) {
        const allLinks = [];
        $list('a[href*="lotto-horo-belief/"]').each((_, el) => {
          const href = $list(el).attr('href') || '';
          if (/\/lotto-horo-belief\/\d+/.test(href)) {
            const full = href.startsWith('http') ? href : 'https://www.tnews.co.th' + href;
            if (!allLinks.includes(full)) allLinks.push(full);
          }
        });
        if (allLinks.length > 0) articleUrl = allLinks[0]; // ลิ้งแรก = ล่าสุด
      }

      if (articleUrl) {
        console.log(`[FETCHER:${lotteryType}] TNews listing OK → ${articleUrl}`);
        break;
      }
    } catch(e) {
      console.warn(`[FETCHER:${lotteryType}] TNews listing (${listUrl}) error: ${e.message}`);
    }
  }

  // ถ้าหาใน listing ไม่ได้ → ลองดึง URL ที่รู้อยู่แล้ว (admin อาจ config ไว้ใน DB sources)
  if (!articleUrl) {
    console.log(`[FETCHER:${lotteryType}] TNews: ไม่พบบทความใน listing — ข้าม`);
    return null;
  }

  // ── Step 2: ดึงบทความและ scrape ตัวเลข ──────────────────────
  const artRes = await httpGetProxy(articleUrl, 25000, 'th');
  const $art   = cheerio.load(artRes.data);

  let gdb = '', g1 = '';

  // ── Pass A: ตาราง/rows ที่มี label ภาษาไทยหรือเวียดนาม ──────
  const GDB_PATTERNS = /รางวัลพิเศษ|đặc biệt|dac biet|giải đặc biệt|ĐB|GDB|รางวัลที่ 1 พิเศษ|prize.*special/i;
  const G1_PATTERNS  = /รางวัลที่ ?1[^0-9]|giải nhất|giải 1|nh[aấ]t|G\.?1\b/i;

  // Scan ทุก <tr>, <li>, <p>, <div> ที่อาจมีรางวัล
  $art('tr, li, p, div').each((_, el) => {
    const rowText = $art(el).text();
    if (!gdb && GDB_PATTERNS.test(rowText)) {
      // หาตัวเลข 5 หลักใน row นี้
      const m = rowText.match(/\b(\d{5})\b/);
      if (m) gdb = m[1];
    }
    if (!g1 && G1_PATTERNS.test(rowText)) {
      const m = rowText.match(/\b(\d{5})\b/);
      if (m) g1 = m[1];
    }
  });

  // ── Pass B: label-based regex scan บน raw HTML ──────────────
  if (!gdb) {
    const parsed = extractGdbG1(String(artRes.data));
    if (parsed) { gdb = parsed.gdb; if (!g1) g1 = parsed.g1 || ''; }
  }

  // ── Pass C: เฉพาะกรณีบทความตัวหนา — ค้น <strong>/<b> ที่มี 5 หลัก ──
  if (!gdb) {
    const boldNums = [];
    $art('strong, b, h2, h3, h4, span[style*="color"], span[style*="font"]').each((_, el) => {
      if ($art(el).children().length > 0) return;
      const t = $art(el).text().trim().replace(/\D/g,'');
      if (/^\d{5}$/.test(t) && !boldNums.includes(t)) boldNums.push(t);
    });
    if (boldNums.length >= 1) { gdb = boldNums[0]; }
    if (boldNums.length >= 2 && !g1) { g1 = boldNums[1]; }
  }

  // ── Pass D: positional fallback — ตัวเลข 5 หลักชุดแรกในเนื้อหา ──
  if (!gdb) {
    const allNums = [];
    $art('td, span, div, p').each((_, el) => {
      if ($art(el).children().length > 0) return;
      const t = $art(el).text().trim().replace(/\D/g,'');
      if (/^\d{5}$/.test(t) && !allNums.includes(t) && allNums.length < 5) allNums.push(t);
    });
    // กรอง: ไม่เอาปี ค.ศ. หรือ พ.ศ. (2500–2600, 1990–2100)
    const filtered = allNums.filter(n => {
      const num = parseInt(n);
      return !(num >= 19900 && num <= 21000) && !(num >= 25000 && num <= 26000);
    });
    if (filtered.length >= 1) gdb = filtered[0];
    if (filtered.length >= 2 && !g1) g1 = filtered[1];
  }

  if (!gdb) {
    console.warn(`[FETCHER:${lotteryType}] TNews: scrape ไม่พบตัวเลขใน ${articleUrl}`);
    return null;
  }

  console.log(`[FETCHER:${lotteryType}] TNews ✅ GDB=${gdb} G1=${g1||'?'} (${articleUrl})`);
  return vn(gdb, g1 || null);
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

  // LA_GOV: 2bot = ตำแหน่ง 3-4, VN_*: 2bot = last 2 ของ Giải Nhất (G1)
  const USES_SEPARATE_2BOT = ['LA_GOV', 'VN_HAN', 'VN_HAN_SP', 'VN_HAN_VIP'];
  // ถ้า lotteryCode ใช้ 2bot แยก และมี prize_2bot → เก็บเสมอ (แม้จะเท่ากับ prize_last_2)
  // เพราะ G1 last 2 อาจตรงกับ GDB last 2 ได้ (เช่น GDB=41528, G1=xxxxx28 → 2bot='28'=2top)
  const prize_2bot_store = (USES_SEPARATE_2BOT.includes(lotteryCode) && prize_2bot)
    ? prize_2bot
    : null;
  // effective_2bot ใช้สำหรับตรวจ bets: VN/LA ใช้ prize_2bot, อื่นๆ ใช้ prize_last_2
  const effective_2bot = (USES_SEPARATE_2BOT.includes(lotteryCode) && prize_2bot)
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
         (round_id, prize_1st, prize_last_2, prize_2bot, prize_front_3, prize_last_3, announced_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [round.id, prize_1st, prize_last_2, prize_2bot_store,
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
    if (USES_SEPARATE_2BOT.includes(lotteryCode))
      console.log(`[FETCHER:${lotteryCode}] 2top=${prize_last_2}, 2bot=${effective_2bot}, 3top=${effective_3top}`);

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

    // 6. จ่ายรางวัลให้ agent_bets (เอเยนต์ที่แทงหวยเอง)
    const [agentBets] = await conn.execute(
      "SELECT * FROM agent_bets WHERE round_id=? AND status='waiting'", [round.id]
    ).catch(() => [[]]);
    for (const abet of agentBets) {
      let won = false, winAmt = 0;
      const n = abet.number;
      if      (abet.bet_type === '3top' && effective_3top === n)
        { won = true; winAmt = abet.amount * lt.rate_3top; }
      else if (abet.bet_type === '3tod') {
        const s = n.split('').sort().join('');
        if (effective_3top.split('').sort().join('') === s)
          { won = true; winAmt = abet.amount * lt.rate_3tod; }
      }
      else if (abet.bet_type === '2top' && prize_last_2 === n)
        { won = true; winAmt = abet.amount * lt.rate_2top; }
      else if (abet.bet_type === '2bot' && effective_2bot === n)
        { won = true; winAmt = abet.amount * lt.rate_2bot; }
      else if (abet.bet_type === 'run_top' && prize_1st.includes(n))
        { won = true; winAmt = abet.amount * lt.rate_run_top; }
      else if (abet.bet_type === 'run_bot' && effective_2bot.includes(n))
        { won = true; winAmt = abet.amount * lt.rate_run_bot; }

      await conn.execute(
        'UPDATE agent_bets SET status=?, win_amount=? WHERE id=?',
        [won ? 'win' : 'lose', winAmt, abet.id]
      ).catch(() => {});

      if (won && winAmt > 0) {
        const [[ag]] = await conn.execute(
          'SELECT balance FROM agents WHERE id=? FOR UPDATE', [abet.agent_id]
        ).catch(() => [[{ balance: 0 }]]);
        const newBal = parseFloat(ag.balance) + parseFloat(winAmt);
        await conn.execute(
          'UPDATE agents SET balance=?, total_commission=total_commission+? WHERE id=?',
          [newBal, winAmt, abet.agent_id]
        ).catch(() => {});
        await conn.execute(
          'INSERT INTO agent_transactions (uuid, agent_id, type, amount, balance_before, balance_after, description) VALUES (?,?,?,?,?,?,?)',
          [uuidv4(), abet.agent_id, 'win', winAmt, ag.balance, newBal,
           `ถูกรางวัล ${bet_type_label(abet.bet_type)} ${abet.number} งวด ${round.round_name}`]
        ).catch(() => {});
      }
    }

    // 7. อัปเดต total_win ของงวด
    const [[ws]] = await conn.execute(
      `SELECT COALESCE(SUM(win_amount),0) s FROM bets WHERE round_id=? AND status="win"`,
      [round.id]
    );
    const [[agWs]] = await conn.execute(
      `SELECT COALESCE(SUM(win_amount),0) s FROM agent_bets WHERE round_id=? AND status="win"`,
      [round.id]
    ).catch(() => [[{ s: 0 }]]);
    await conn.execute(
      'UPDATE lottery_rounds SET total_win=? WHERE id=?',
      [parseFloat(ws.s) + parseFloat(agWs.s), round.id]
    );
  });

  console.log(`[FETCHER:${lotteryCode}] ✅ ออกผลสำเร็จ: งวด #${round.id} (${prize_1st})`);
  return round.id;
}

function bet_type_label(t) {
  const m = { '3top':'3ตัวบน','3tod':'3ตัวโต','2top':'2ตัวบน','2bot':'2ตัวล่าง','run_top':'วิ่งบน','run_bot':'วิ่งล่าง' };
  return m[t] || t;
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
      let gdb = '', g1 = '';
      // Pass 1a: CSS selector เฉพาะ GDB (Giải Đặc Biệt)
      $('[class*="giai-db"],[class*="giaidb"],[class*="dac-biet"],[class*="dacbiet"],[class*="jackpot"],[class*="special"]').each((_, el) => {
        const t = $(el).text().trim().replace(/\D/g, '');
        if (t.length >= 4 && !gdb) gdb = t.slice(-5).padStart(5,'0');
      });
      // Pass 1b: CSS selector เฉพาะ G1 (Giải Nhất)
      $('[class*="giai-nhat"],[class*="giainhat"],[class*="prize1"]').each((_, el) => {
        const t = $(el).text().trim().replace(/\D/g, '');
        if (t.length >= 4 && !g1) g1 = t.slice(-5).padStart(5,'0');
      });
      // Pass 1c: text-based row matching (sites without semantic class names)
      if (!gdb || !g1) {
        $('tr,li').each((_, el) => {
          const rowText = $(el).text();
          if (!gdb && /đặc biệt|dac biet|\bDB\b|\bĐB\b/i.test(rowText)) {
            const m = rowText.match(/\d{5}/);
            if (m) gdb = m[0];
          }
          if (!g1 && /nh[aấ]t|g\.?1\b/i.test(rowText)) {
            const m = rowText.match(/\d{5}/);
            if (m) g1 = m[0];
          }
        });
      }
      // Pass 2: positional fallback — first two distinct 5-digit numbers
      if (!gdb) {
        const nums = [];
        $('td,span,div,b,strong').each((_, el) => {
          if ($(el).children().length > 0) return;
          const t = $(el).text().trim().replace(/\D/g, '');
          if (/^\d{5}$/.test(t) && nums.length < 2) nums.push(t);
        });
        if (nums[0]) gdb = nums[0];
        if (nums[1] && !g1) g1 = nums[1];
      }
      // Pass 3: label-based regex scan on raw HTML (last resort)
      if (!gdb) {
        const parsed = extractGdbG1(String(data));
        if (parsed) { gdb = parsed.gdb; if (!g1) g1 = parsed.g1 || ''; }
      }
      if (!gdb) throw new Error('html_vn_han: scrape ไม่พบ 5 หลัก');
      return {
        prize_1st:    gdb,
        prize_last_2: gdb.slice(-2),            // 2 ตัวบน (GDB)
        prize_2bot:   g1 ? g1.slice(-2) : null, // 2 ตัวล่าง (G1)
        prize_front_3: [],
        prize_last_3:  [gdb.slice(-3)],
      };
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
      // GDB (Giải Đặc Biệt) → prize_1st / 2 ตัวบน
      // G1  (Giải Nhất)     → prize_2bot / 2 ตัวล่าง
      const parsed = extractGdbG1(String(data));
      if (!parsed) throw new Error('rss_vn: ไม่พบ 5 หลัก');
      return {
        prize_1st:    parsed.gdb,
        prize_last_2: parsed.gdb.slice(-2),
        prize_2bot:   parsed.g1 ? parsed.g1.slice(-2) : null,
        prize_front_3: [],
        prize_last_3:  [parsed.gdb.slice(-3)],
      };
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
      prize_2bot:   result.prize_2bot || null,   // 2 ตัวล่าง (VN/LA)
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

/**
 * ฮานอยพิเศษ (VN_HAN_SP) = "Xổ Số miền Bắc thêm" — ออกผลทุกวัน ~17:30 น.
 * เป็นหวยเอกชนเวียดนาม (ไม่ใช่ XSMB รัฐบาล) ออกผลก่อน XSMB ปกติ
 */
async function fetchVNHanoiSP() {
  function vn(gdb, g1) {
    return {
      prize_1st:    gdb,
      prize_last_2: gdb.slice(-2),
      prize_2bot:   g1 ? g1.slice(-2) : null,
      prize_front_3: [],
      prize_last_3:  [gdb.slice(-3)],
    };
  }

  // Source 1: xskt.com.vn — Miền Bắc thêm RSS (XSMBT)
  try {
    const res = await httpGet('https://xskt.com.vn/rss-feed/mien-bac-them-xsmbt.rss', 20000);
    const parsed = extractGdbG1(String(res.data));
    if (parsed) {
      console.log('[FETCHER:VN_HAN_SP] xskt.com.vn thêm RSS GDB=%s G1=%s', parsed.gdb, parsed.g1 || '?');
      return vn(parsed.gdb, parsed.g1);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_SP] xskt thêm RSS error:', e.message); }

  // Source 2: xoso.com.vn XSMBT (Miền Bắc thêm)
  try {
    const res = await httpGetProxy('https://xoso.com.vn/xsmbt.html', 30000, 'sg');
    const $ = cheerio.load(res.data);
    let gdb = '', g1 = '';
    $('[class*="giai-db"],[class*="giaidb"],[class*="dac-biet"],[class*="dacbiet"],[class*="jackpot"],[class*="special"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g, '');
      if (t.length >= 4 && !gdb) gdb = t.slice(-5).padStart(5, '0');
    });
    $('[class*="giai-nhat"],[class*="giainhat"],[class*="prize1"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g, '');
      if (t.length >= 4 && !g1) g1 = t.slice(-5).padStart(5, '0');
    });
    if (!gdb || !g1) {
      $('tr,li').each((_, el) => {
        const rowText = $(el).text();
        if (!gdb && /đặc biệt|dac biet|\bDB\b|\bĐB\b/i.test(rowText)) {
          const m = rowText.match(/\d{5}/); if (m) gdb = m[0];
        }
        if (!g1 && /nh[aấ]t|g\.?1\b/i.test(rowText)) {
          const m = rowText.match(/\d{5}/); if (m) g1 = m[0];
        }
      });
    }
    if (!gdb) {
      const nums = [];
      $('td,span,b,strong').each((_, el) => {
        if ($(el).children().length > 0) return;
        const t = $(el).text().trim().replace(/\D/g, '');
        if (/^\d{5}$/.test(t) && nums.length < 2) nums.push(t);
      });
      if (nums[0]) { gdb = nums[0]; if (nums[1] && !g1) g1 = nums[1]; }
    }
    if (gdb) {
      console.log('[FETCHER:VN_HAN_SP] xoso.com.vn GDB=%s G1=%s', gdb, g1 || '?');
      return vn(gdb, g1 || null);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_SP] xoso.com.vn error:', e.message); }

  // Source 3: ketqua.tv Miền Bắc thêm
  try {
    const res = await httpGetProxy('https://ketqua.tv/xo-so-mien-bac-them.html', 30000, 'sg');
    const $ = cheerio.load(res.data);
    let gdb = '', g1 = '';
    $('tr,li').each((_, el) => {
      const rowText = $(el).text();
      if (!gdb && /đặc biệt|dac biet/i.test(rowText)) {
        const m = rowText.match(/\d{5}/); if (m) gdb = m[0];
      }
      if (!g1 && /nh[aấ]t|g\.?1/i.test(rowText)) {
        const m = rowText.match(/\d{5}/); if (m) g1 = m[0];
      }
    });
    if (!gdb) {
      const parsed = extractGdbG1(String(res.data));
      if (parsed) { gdb = parsed.gdb; g1 = parsed.g1 || ''; }
    }
    if (gdb) {
      console.log('[FETCHER:VN_HAN_SP] ketqua.tv GDB=%s G1=%s', gdb, g1 || '?');
      return vn(gdb, g1 || null);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_SP] ketqua.tv error:', e.message); }

  // Source 4: xskt.com.vn — ลองดู RSS ทั่วไปของ XSMBT ในชื่อต่างๆ
  const altRssUrls = [
    'https://xskt.com.vn/rss-feed/mien-bac-them.rss',
    'https://xskt.com.vn/rss-feed/xsmbt.rss',
    'https://xsmb.vn/rss-them',
  ];
  for (const url of altRssUrls) {
    try {
      const res = await httpGet(url, 15000);
      const parsed = extractGdbG1(String(res.data));
      if (parsed) {
        console.log('[FETCHER:VN_HAN_SP] alt RSS (%s) GDB=%s G1=%s', url, parsed.gdb, parsed.g1 || '?');
        return vn(parsed.gdb, parsed.g1);
      }
    } catch(e) { /* continue */ }
  }

  // Source 5: TNews.co.th (ฮานอยพิเศษ)
  try {
    const result = await fetchTNewsVNHanoi('VN_HAN_SP');
    if (result) {
      console.log('[FETCHER:VN_HAN_SP] TNews GDB=%s G1=%s', result.prize_1st, result.prize_2bot || '?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_SP] TNews error:', e.message); }

  throw new Error('VN_HAN_SP: แหล่งข้อมูลทุกแหล่งล้มเหลว — กรุณา config DB sources ใน Admin Panel → API Sources');
}

/**
 * ฮานอย VIP (VN_HAN_VIP) — ออกผลทุกวัน ~17:00 น.
 * หวยเอกชนเวียดนาม (Hanoi VIP) ออกผลเร็วกว่า XSMB ปกติ
 */
async function fetchVNHanoiVIP() {
  function vn(gdb, g1) {
    return {
      prize_1st:    gdb,
      prize_last_2: gdb.slice(-2),
      prize_2bot:   g1 ? g1.slice(-2) : null,
      prize_front_3: [],
      prize_last_3:  [gdb.slice(-3)],
    };
  }

  // Source 1: xskt.com.vn — Hà Nội VIP RSS
  try {
    const res = await httpGet('https://xskt.com.vn/rss-feed/ha-noi-vip-xshnvip.rss', 20000);
    const parsed = extractGdbG1(String(res.data));
    if (parsed) {
      console.log('[FETCHER:VN_HAN_VIP] xskt RSS GDB=%s G1=%s', parsed.gdb, parsed.g1 || '?');
      return vn(parsed.gdb, parsed.g1);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_VIP] xskt RSS error:', e.message); }

  // Source 2: xoso.com.vn XSHNVIP
  try {
    const res = await httpGetProxy('https://xoso.com.vn/xshnvip.html', 30000, 'sg');
    const $ = cheerio.load(res.data);
    let gdb = '', g1 = '';
    $('[class*="giai-db"],[class*="giaidb"],[class*="dac-biet"],[class*="dacbiet"],[class*="jackpot"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g, '');
      if (t.length >= 4 && !gdb) gdb = t.slice(-5).padStart(5, '0');
    });
    $('[class*="giai-nhat"],[class*="giainhat"],[class*="prize1"]').each((_, el) => {
      const t = $(el).text().trim().replace(/\D/g, '');
      if (t.length >= 4 && !g1) g1 = t.slice(-5).padStart(5, '0');
    });
    if (!gdb || !g1) {
      $('tr,li').each((_, el) => {
        const rowText = $(el).text();
        if (!gdb && /đặc biệt|dac biet|\bDB\b|\bĐB\b/i.test(rowText)) {
          const m = rowText.match(/\d{5}/); if (m) gdb = m[0];
        }
        if (!g1 && /nh[aấ]t|g\.?1\b/i.test(rowText)) {
          const m = rowText.match(/\d{5}/); if (m) g1 = m[0];
        }
      });
    }
    if (!gdb) {
      const nums = [];
      $('td,span,b,strong').each((_, el) => {
        if ($(el).children().length > 0) return;
        const t = $(el).text().trim().replace(/\D/g, '');
        if (/^\d{5}$/.test(t) && nums.length < 2) nums.push(t);
      });
      if (nums[0]) { gdb = nums[0]; if (nums[1] && !g1) g1 = nums[1]; }
    }
    if (gdb) {
      console.log('[FETCHER:VN_HAN_VIP] xoso.com.vn GDB=%s G1=%s', gdb, g1 || '?');
      return vn(gdb, g1 || null);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_VIP] xoso.com.vn error:', e.message); }

  // Source 3: ketqua.tv Hà Nội VIP
  try {
    const res = await httpGetProxy('https://ketqua.tv/xo-so-ha-noi-vip.html', 30000, 'sg');
    const $ = cheerio.load(res.data);
    let gdb = '', g1 = '';
    $('tr,li').each((_, el) => {
      const rowText = $(el).text();
      if (!gdb && /đặc biệt|dac biet/i.test(rowText)) {
        const m = rowText.match(/\d{5}/); if (m) gdb = m[0];
      }
      if (!g1 && /nh[aấ]t|g\.?1/i.test(rowText)) {
        const m = rowText.match(/\d{5}/); if (m) g1 = m[0];
      }
    });
    if (!gdb) {
      const parsed = extractGdbG1(String(res.data));
      if (parsed) { gdb = parsed.gdb; g1 = parsed.g1 || ''; }
    }
    if (gdb) {
      console.log('[FETCHER:VN_HAN_VIP] ketqua.tv GDB=%s G1=%s', gdb, g1 || '?');
      return vn(gdb, g1 || null);
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_VIP] ketqua.tv error:', e.message); }

  // Source 4: ลอง RSS ในชื่อต่างๆ
  const altRssUrls = [
    'https://xskt.com.vn/rss-feed/ha-noi-vip.rss',
    'https://xskt.com.vn/rss-feed/xshnvip.rss',
    'https://xsmb.vn/rss-vip',
  ];
  for (const url of altRssUrls) {
    try {
      const res = await httpGet(url, 15000);
      const parsed = extractGdbG1(String(res.data));
      if (parsed) {
        console.log('[FETCHER:VN_HAN_VIP] alt RSS (%s) GDB=%s G1=%s', url, parsed.gdb, parsed.g1 || '?');
        return vn(parsed.gdb, parsed.g1);
      }
    } catch(e) { /* continue */ }
  }

  // Source 5: TNews.co.th (ฮานอย VIP)
  try {
    const result = await fetchTNewsVNHanoi('VN_HAN_VIP');
    if (result) {
      console.log('[FETCHER:VN_HAN_VIP] TNews GDB=%s G1=%s', result.prize_1st, result.prize_2bot || '?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_VIP] TNews error:', e.message); }

  throw new Error('VN_HAN_VIP: แหล่งข้อมูลทุกแหล่งล้มเหลว — กรุณา config DB sources ใน Admin Panel → API Sources');
}

// ── Export สำหรับ manual trigger ──────────────────────────────

const FETCH_FUNCS = {
  TH_GOV:     fetchTHGov,
  LA_GOV:     fetchLAGov,
  VN_HAN:     fetchVNHanoi,
  VN_HAN_SP:  fetchVNHanoiSP,   // ฮานอยพิเศษ (Xổ Số miền Bắc thêm) — แยก source
  VN_HAN_VIP: fetchVNHanoiVIP,  // ฮานอย VIP — แยก source
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

  // ── หวยลาว (จันทร์–ศุกร์ เท่านั้น) ──────────────────────────────
  // ออกผล ~20:00-20:30 → fetch 20:45
  cron.schedule('45 20 * * 1-5', () => {
    console.log('[FETCHER] Trigger: LA_GOV');
    runFetcher('LA_GOV', fetchLAGov).catch(e =>
      console.error('[FETCHER] LA_GOV error:', e.message)
    );
  }, { timezone: TIMEZONE });

  // Retry 21:15 (Mon-Fri เท่านั้น)
  cron.schedule('15 21 * * 1-5', async () => {
    const status = fetcherStatus['LA_GOV'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] LA_GOV retry @ 21:15');
      runFetcher('LA_GOV', fetchLAGov).catch(e => console.error('[FETCHER] LA_GOV retry:', e.message));
    }
  }, { timezone: TIMEZONE });

  // ── ฮานอย VIP (~17:00) ────────────────────────────────────────
  cron.schedule('15 17 * * *', () => {
    console.log('[FETCHER] Trigger: VN_HAN_VIP');
    runFetcher('VN_HAN_VIP', fetchVNHanoiVIP).catch(e =>
      console.error('[FETCHER] VN_HAN_VIP error:', e.message)
    );
  }, { timezone: TIMEZONE });

  cron.schedule('45 17 * * *', async () => {
    const status = fetcherStatus['VN_HAN_VIP'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] VN_HAN_VIP retry @ 17:45');
      runFetcher('VN_HAN_VIP', fetchVNHanoiVIP).catch(e => console.error('[FETCHER] VN_HAN_VIP retry:', e.message));
    }
  }, { timezone: TIMEZONE });

  // ── ฮานอยพิเศษ (~17:30) ─────────────────────────────────────
  cron.schedule('45 17 * * *', () => {
    console.log('[FETCHER] Trigger: VN_HAN_SP');
    runFetcher('VN_HAN_SP', fetchVNHanoiSP).catch(e =>
      console.error('[FETCHER] VN_HAN_SP error:', e.message)
    );
  }, { timezone: TIMEZONE });

  cron.schedule('15 18 * * *', async () => {
    const status = fetcherStatus['VN_HAN_SP'];
    if (!status?.lastSuccess || new Date(status.lastSuccess).toDateString() !== new Date().toDateString()) {
      console.log('[FETCHER] VN_HAN_SP retry @ 18:15');
      runFetcher('VN_HAN_SP', fetchVNHanoiSP).catch(e => console.error('[FETCHER] VN_HAN_SP retry:', e.message));
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
  console.log('  LA_GOV      → จันทร์-ศุกร์ @ 20:45 (retry 21:15)');
  console.log('  VN_HAN_VIP  → ทุกวัน @ 17:15 (retry 17:45)');
  console.log('  VN_HAN_SP   → ทุกวัน @ 17:45 (retry 18:15)');
  console.log('  VN_HAN      → ทุกวัน @ 18:45 (retry 19:15)');
}

module.exports = { startLotteryFetcher, fetcherStatus, triggerFetch, testSource, clearScraperApiKeyCache };
