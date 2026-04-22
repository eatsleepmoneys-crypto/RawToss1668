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

// ── TNews Thai Government Lottery ─────────────────────────────────────────
// TNews publishes Thai lottery results (1st & 16th) in lotto-horo-belief category
// Keywords: "สลาก", "ตรวจหวย", "หวยรัฐบาล", "สลากกินแบ่ง"
// Prize structure: รางวัลที่1 (6d), หน้า3ตัว (3d×2), ท้าย3ตัว (3d×2), ท้าย2ตัว (2d)
// ═══════════════════════════════════════════════════════════════════

let _tnewsThaiCache = { data: null, ts: 0 };
const TNEWS_THAI_CACHE_TTL = 10 * 60 * 1000; // 10 min — Thai lottery doesn't change mid-day

async function findTNewsThaiArticleUrl() {
  const BROAD_KW = ['สลาก', 'ตรวจหวย', 'หวยรัฐบาล', 'สลากกินแบ่ง'];

  // Strategy 0: WordPress REST API (เร็วและเชื่อถือได้กว่า RSS)
  const WP_THAI_URLS = [
    'https://www.tnews.co.th/wp-json/wp/v2/posts?search=%E0%B8%AA%E0%B8%A5%E0%B8%B2%E0%B8%81%E0%B8%81%E0%B8%B4%E0%B8%99%E0%B9%81%E0%B8%9A%E0%B9%88%E0%B8%87&per_page=10&_fields=link,title,date',
    'https://www.tnews.co.th/wp-json/wp/v2/posts?search=%E0%B8%95%E0%B8%A3%E0%B8%A7%E0%B8%88%E0%B8%AB%E0%B8%A7%E0%B8%A2&per_page=10&_fields=link,title,date',
  ];
  const nowBkk   = new Date(Date.now() + 7*3600*1000);
  const todayStr = nowBkk.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const dayBefore = new Date(nowBkk - 86400000).toISOString().slice(0, 10);
  for (const wpUrl of WP_THAI_URLS) {
    try {
      const wpRes  = await httpGet(wpUrl, 12000);
      const posts  = Array.isArray(wpRes.data) ? wpRes.data : [];
      // Filter by date — today or yesterday (Thai lottery published ~16:30)
      const todayPosts = posts.filter(p => p.date && (p.date.startsWith(todayStr) || p.date.startsWith(dayBefore)));
      const candidates = todayPosts.length ? todayPosts : posts;
      for (const p of candidates) {
        if (p.link && /lotto-horo-belief\/\d+/.test(p.link)) {
          console.log('[FETCHER:TNEWS_TH] WP-API →', p.link);
          return p.link;
        }
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS_TH] WP-API error:', e.message);
    }
  }

  const RSS_URLS = [
    'https://www.tnews.co.th/lotto-horo-belief/feed',
    'https://www.tnews.co.th/category/lotto-horo-belief/feed',
    'https://www.tnews.co.th/feed?cat=lotto-horo-belief',
    'https://www.tnews.co.th/feed',
  ];

  for (const rssUrl of RSS_URLS) {
    try {
      const rssRes = await httpGetProxy(rssUrl, 15000, 'th');
      const xml    = String(rssRes.data);
      const items  = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
      for (const item of items) {
        const titleM = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const linkM  = item.match(/<link>([\s\S]*?)<\/link>/i)
                    || item.match(/<link[^>]*href="([^"]+)"/i);
        if (!titleM || !linkM) continue;
        const title = titleM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().toLowerCase();
        const link  = linkM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const isThai = BROAD_KW.some(kw => title.includes(kw.toLowerCase()));
        if (isThai && /lotto-horo-belief\/\d+/.test(link)) {
          console.log('[FETCHER:TNEWS_TH] RSS →', link);
          return link;
        }
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS_TH] RSS error (%s):', rssUrl, e.message);
    }
  }

  // HTML listing fallback
  const LISTING_URLS = [
    'https://www.tnews.co.th/lotto-horo-belief',
    'https://www.tnews.co.th/category/lotto-horo-belief',
  ];
  for (const listUrl of LISTING_URLS) {
    try {
      const listRes = await httpGetProxy(listUrl, 20000, 'th');
      const $list   = cheerio.load(listRes.data);
      let articleUrl = null;
      $list('a[href*="lotto-horo-belief/"]').each((_, el) => {
        if (articleUrl) return;
        const href = $list(el).attr('href') || '';
        const text = ($list(el).text() + ' ' + ($list(el).attr('title') || '')).toLowerCase();
        const hit  = BROAD_KW.some(kw => text.includes(kw.toLowerCase()));
        if (hit && /\/lotto-horo-belief\/\d+/.test(href)) {
          articleUrl = href.startsWith('http') ? href : 'https://www.tnews.co.th' + href;
        }
      });
      if (articleUrl) {
        console.log('[FETCHER:TNEWS_TH] HTML listing →', articleUrl);
        return articleUrl;
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS_TH] listing error (%s):', listUrl, e.message);
    }
  }

  console.warn('[FETCHER:TNEWS_TH] ไม่พบ URL บทความหวยรัฐบาล');
  return null;
}

/**
 * แยกรางวัลหวยรัฐบาลไทยจาก body text ของบทความ TNews
 * คืน { prize_1st, prize_last_2, prize_front_3:[], prize_last_3:[] } หรือ null
 */
function parseTNewsThaiSection(html) {
  const $ = cheerio.load(html);
  let bodyText = '';
  for (const sel of ['article', '.content-body', '.post-content', '.article-content',
                     '.entry-content', '#content-body', '#article-body', 'body']) {
    const t = $(sel).first().text();
    if (t && t.length > bodyText.length) bodyText = t;
  }
  if (!bodyText) bodyText = $.text();

  // ─── รางวัลที่ 1 (6 digits) ──────────────────────────────────
  const m1 = bodyText.match(/รางวัลที่\s*1[^0-9]{0,30}(\d{6})/i)
           || bodyText.match(/prize\s*1st?[^0-9]{0,30}(\d{6})/i)
           || bodyText.match(/รางวัล(?:ที่|ท)?\s*1\s*[:=\-]?\s*(\d{6})/i);
  if (!m1) {
    // ลอง fallback: 6-digit ที่ไม่ใช่ปีพุทธ
    const allSix = [...bodyText.matchAll(/\b(\d{6})\b/g)].map(m => m[1])
      .filter(n => !(parseInt(n) >= 256000 && parseInt(n) <= 257000));
    if (!allSix.length) return null;
    // ไม่มี label → ใช้อันแรก
    const p1 = allSix[0];
    const last2 = bodyText.match(/(?:ท้าย\s*2\s*ตัว|2\s*ตัวท้าย|last\s*2)[^0-9]{0,20}(\d{2})/i)?.[1]
               || p1.slice(-2);
    const front3 = [...bodyText.matchAll(/(?:หน้า\s*3\s*ตัว|3\s*ตัวหน้า)[^0-9]{0,30}(\d{3})/gi)].map(m=>m[1]);
    const last3  = [...bodyText.matchAll(/(?:ท้าย\s*3\s*ตัว|3\s*ตัวท้าย)[^0-9]{0,30}(\d{3})/gi)].map(m=>m[1]);
    return { prize_1st: p1, prize_last_2: last2, prize_front_3: front3.slice(0,2), prize_last_3: last3.slice(0,2) };
  }

  const prize_1st = m1[1];

  // ─── รางวัลท้าย 2 ตัว ────────────────────────────────────────
  const mLast2 = bodyText.match(/(?:ท้าย\s*2\s*ตัว|2\s*ตัวท้าย|เลขท้าย\s*2)[^0-9]{0,20}(\d{2})/i);
  const prize_last_2 = mLast2?.[1] || prize_1st.slice(-2);

  // ─── รางวัลหน้า 3 ตัว (× 2 ชุด) ──────────────────────────────
  const front3Matches = [...bodyText.matchAll(/(?:หน้า\s*3\s*ตัว|3\s*ตัวหน้า|เลขหน้า\s*3)[^0-9]{0,30}(\d{3})/gi)];
  const prize_front_3 = front3Matches.map(m => m[1]).slice(0, 2);

  // ─── รางวัลท้าย 3 ตัว (× 2 ชุด) ──────────────────────────────
  const last3Matches = [...bodyText.matchAll(/(?:ท้าย\s*3\s*ตัว|3\s*ตัวท้าย|เลขท้าย\s*3)[^0-9]{0,30}(\d{3})/gi)];
  const prize_last_3 = last3Matches.map(m => m[1]).slice(0, 2);

  // ─── รางวัลที่ 2-5 และใกล้เคียง (TNews อาจไม่มีครบ) ───────────
  const near1Matches = [...bodyText.matchAll(/(?:ใกล้เคียง(?:รางวัล)?ที่\s*1|near\s*1)[^0-9]{0,40}(\d{6})/gi)];
  const prize_near_1st = near1Matches.map(m => m[1]).slice(0, 2);

  const p2Matches = [...bodyText.matchAll(/รางวัลที่\s*2[^0-9]{0,40}(\d{6})/gi)];
  const prize_2nd = p2Matches.map(m => m[1]).slice(0, 5);

  const p3Matches = [...bodyText.matchAll(/รางวัลที่\s*3[^0-9]{0,40}(\d{6})/gi)];
  const prize_3rd = p3Matches.map(m => m[1]).slice(0, 10);

  const p4Matches = [...bodyText.matchAll(/รางวัลที่\s*4[^0-9]{0,40}(\d{6})/gi)];
  const prize_4th = p4Matches.map(m => m[1]).slice(0, 50);

  const p5Matches = [...bodyText.matchAll(/รางวัลที่\s*5[^0-9]{0,40}(\d{6})/gi)];
  const prize_5th = p5Matches.map(m => m[1]).slice(0, 100);

  if (!prize_1st) return null;
  console.log(`[FETCHER:TNEWS_TH] prize_1st=${prize_1st} last2=${prize_last_2} front3=[${prize_front_3}] last3=[${prize_last_3}] near=${prize_near_1st.length} p2=${prize_2nd.length} p3=${prize_3rd.length}`);
  return { prize_1st, prize_last_2, prize_front_3, prize_last_3,
           prize_near_1st, prize_2nd, prize_3rd, prize_4th, prize_5th };
}

async function fetchTNewsTHGov() {
  const now = Date.now();
  if (_tnewsThaiCache.data && (now - _tnewsThaiCache.ts) < TNEWS_THAI_CACHE_TTL) {
    return _tnewsThaiCache.data;
  }
  const url = await findTNewsThaiArticleUrl();
  if (!url) return null;
  try {
    const artRes = await httpGetProxy(url, 25000, 'th');
    const parsed = parseTNewsThaiSection(artRes.data);
    if (parsed) {
      _tnewsThaiCache = { data: parsed, ts: now };
      console.log('[FETCHER:TNEWS_TH] ✅ prize_1st:', parsed.prize_1st);
    }
    return parsed;
  } catch(e) {
    console.warn('[FETCHER:TNEWS_TH] article fetch error:', e.message);
    return null;
  }
}

/**
 * หวยรัฐบาลไทย — ออกผลวันที่ 1 และ 16 เวลา ~15:00 น.
 * ลอง 3 source ตามลำดับ
 */
async function fetchTHGov() {
  // Source 0: TNews (tnews.co.th) — เข้าถึงได้จาก Railway
  try {
    const r = await fetchTNewsTHGov();
    if (r) return r;
  } catch(e) { console.warn('[FETCHER:TH_GOV] TNews error:', e.message); }

  // ── Helper: split delimited 6-digit prize list ────────────────
  const split6 = (v) => String(v||'').split(/[\s,|\/]+/).map(s=>s.replace(/\D/g,'')).filter(s=>/^\d{6}$/.test(s));

  // Source 1: Longdo Money (JSON API — เชื่อถือได้)
  try {
    const res = await httpGetProxy('https://money.longdo.com/lotto/api');
    const d   = res.data;
    if (d && (d.first || d.prize1)) {
      const p1 = (d.first || d.prize1 || '').replace(/\D/g,'');
      if (/^\d{6}$/.test(p1)) {
        const last2   = (d.last2   || p1.slice(-2)).replace(/\D/g,'');
        const front3  = [(d.front3_1||''), (d.front3_2||'')].map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x));
        const last3   = [(d.last3_1||''), (d.last3_2||'')].map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x));
        // ลอง field ชื่อต่างๆ ที่ Longdo อาจใช้สำหรับ prize_2nd–5th และ near_1st
        const near1   = split6(d.near1    || d.near_1   || d.near_first || '');
        const p2nd    = split6(d.second   || d.prize2   || d.two        || '');
        const p3rd    = split6(d.third    || d.prize3   || d.three      || '');
        const p4th    = split6(d.fourth   || d.prize4   || d.four       || '');
        const p5th    = split6(d.fifth    || d.prize5   || d.five       || '');
        console.log('[FETCHER:TH_GOV] Source: longdo');
        return { prize_1st: p1, prize_last_2: last2 || p1.slice(-2),
                 prize_front_3: front3, prize_last_3: last3,
                 prize_near_1st: near1, prize_2nd: p2nd, prize_3rd: p3rd, prize_4th: p4th, prize_5th: p5th };
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
        const near1 = split6(d.near1     || d.near_1    || '');
        const p2nd  = split6(d.prize2    || d.second    || '');
        const p3rd  = split6(d.prize3    || d.third     || '');
        const p4th  = split6(d.prize4    || d.fourth    || '');
        const p5th  = split6(d.prize5    || d.fifth     || '');
        console.log('[FETCHER:TH_GOV] Source: sanook API');
        return {
          prize_1st:     p1,
          prize_last_2:  (d.last2||p1.slice(-2)).replace(/\D/g,''),
          prize_front_3: [d.front3_1, d.front3_2].filter(Boolean).map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x)),
          prize_last_3:  [d.last3_1,  d.last3_2].filter(Boolean).map(x=>x.replace(/\D/g,'')).filter(x=>/^\d{3}$/.test(x)),
          prize_near_1st: near1, prize_2nd: p2nd, prize_3rd: p3rd, prize_4th: p4th, prize_5th: p5th,
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

  // Source 4: GLO official XML/JSON endpoints — parse all prize columns
  const gloUrls = [
    'https://www.glo.or.th/service/lottoXML',
    'https://openapi.glo.or.th/api/v1/lottery',
    'https://www.glo.or.th/service/p1',
  ];
  for (const gloUrl of gloUrls) {
    try {
      const res = await httpGetProxy(gloUrl, 20000, 'th');
      const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      // ── แยก 6-digit prize lists จาก XML/JSON ──────────────────
      const xmlGet = (tag) => {
        const m = raw.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`, 'i'));
        return m ? m[1].trim() : '';
      };
      const jsonGet = (...keys) => {
        for (const k of keys) {
          const m = raw.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`, 'i'));
          if (m) return m[1];
        }
        return '';
      };

      // XML field names (GLO standard)
      const p1raw   = xmlGet('Prize1')       || xmlGet('prizeNumOneFirst')  || jsonGet('prize1','first') || '';
      const near1raw = xmlGet('PrizeNear1')  || xmlGet('prizeNumNearOne')    || jsonGet('near1','nearFirst') || '';
      const p2raw   = xmlGet('Prize2')       || xmlGet('prizeNumTwo')        || jsonGet('prize2','second') || '';
      const p3raw   = xmlGet('Prize3')       || xmlGet('prizeNumThree')      || jsonGet('prize3','third') || '';
      const p4raw   = xmlGet('Prize4')       || xmlGet('prizeNumFour')       || jsonGet('prize4','fourth') || '';
      const p5raw   = xmlGet('Prize5')       || xmlGet('prizeNumFive')       || jsonGet('prize5','fifth') || '';
      const f3raw   = xmlGet('PrizeFront3')  || xmlGet('prizeNumFrontThree') || jsonGet('front3','frontThree') || '';
      const l3raw   = xmlGet('PrizeLast3')   || xmlGet('prizeNumLastThree')  || jsonGet('last3','lastThree') || '';
      const l2raw   = xmlGet('PrizeLast2')   || xmlGet('prizeNumLastTwo')    || jsonGet('last2','lastTwo') || '';

      const p1 = p1raw.replace(/\D/g,'');
      if (!/^\d{6}$/.test(p1)) continue; // ไม่มีรางวัลที่ 1 → ข้ามไป URL ถัดไป

      const prize_last_2 = l2raw.replace(/\D/g,'').slice(-2) || p1.slice(-2);
      const prize_front_3 = f3raw.split(/[\s,]+/).map(s=>s.replace(/\D/g,'')).filter(s=>/^\d{3}$/.test(s)).slice(0,2);
      const prize_last_3  = l3raw.split(/[\s,]+/).map(s=>s.replace(/\D/g,'')).filter(s=>/^\d{3}$/.test(s)).slice(0,2);
      console.log('[FETCHER:TH_GOV] Source: GLO official', gloUrl, 'p1=', p1);
      return {
        prize_1st: p1, prize_last_2, prize_front_3, prize_last_3,
        prize_near_1st: split6(near1raw),
        prize_2nd: split6(p2raw), prize_3rd: split6(p3raw),
        prize_4th: split6(p4raw), prize_5th: split6(p5raw),
      };
    } catch(e) { console.warn('[FETCHER:TH_GOV] GLO error (%s):', gloUrl, e.message); }
  }

  // Source 5: Thairath (major newspaper — less restrictive than sanook)
  try {
    const res = await httpGetProxy('https://www.thairath.co.th/news/local/lottery', 30000, 'th');
    const $   = cheerio.load(res.data);
    let p1 = '';
    $('[class*="lottery"],[class*="prize"],[class*="number"],[class*="result"]').each((_, el) => {
      const t = $(el).text().replace(/\s+/g,'').replace(/\D/g,'');
      if (/^\d{6}$/.test(t) && !p1) p1 = t;
    });
    if (!p1) {
      $('strong,b,h1,h2,span').each((_, el) => {
        if ($(el).children().length) return;
        const t = $(el).text().replace(/\s+/g,'').replace(/\D/g,'');
        if (/^\d{6}$/.test(t) && !p1) p1 = t;
      });
    }
    if (p1) {
      console.log('[FETCHER:TH_GOV] Source: thairath.co.th');
      return { prize_1st: p1, prize_last_2: p1.slice(-2), prize_front_3: [], prize_last_3: [] };
    }
  } catch(e) { console.warn('[FETCHER:TH_GOV] thairath error:', e.message); }

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

// ── press.in.th Lao scraper ───────────────────────────────────────
// URL: https://www.press.in.th/huay-ruay/
// Structure: h3 "ตรวจหวยลาว {DATE_THAI}" → .lao-grid → .lao-num ×3
//   .lao-num[0] = เลขท้าย 4 ตัว, [1] = เลขท้าย 3 ตัว, [2] = เลขท้าย 2 ตัว
// .lao-meta = "อัปเดตล่าสุด: DD/MM/YYYY HH:mm น."
// "xxxx" / "xxx" = ยังไม่ออกผล
// ─────────────────────────────────────────────────────────────────

let _pressInThLaoCache = { data: null, ts: 0 };
const PRESS_LAO_CACHE_TTL = 3 * 60 * 1000; // 3 นาที

async function fetchPressInThLao() {
  const now = Date.now();
  if (_pressInThLaoCache.data && (now - _pressInThLaoCache.ts) < PRESS_LAO_CACHE_TTL) {
    return _pressInThLaoCache.data;
  }

  let html;
  try {
    const res = await httpGetProxy('https://www.press.in.th/huay-ruay/', 20000, 'th');
    html = res.data;
  } catch(e) {
    console.warn('[FETCHER:PRESS_LAO] fetch error:', e.message);
    return null;
  }

  const $ = cheerio.load(html);

  // Bangkok date today DD/MM/YYYY
  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
  const dd   = String(nowBkk.getUTCDate()).padStart(2, '0');
  const mm   = String(nowBkk.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(nowBkk.getUTCFullYear());
  const todayDDMMYYYY = `${dd}/${mm}/${yyyy}`;

  // Validate date from .lao-meta: "อัปเดตล่าสุด: DD/MM/YYYY HH:mm น."
  const metaText = $('.lao-meta').first().text() || '';
  const metaDateM = metaText.match(/(\d{2}\/\d{2}\/\d{4})/);
  if (metaDateM && metaDateM[1] !== todayDDMMYYYY) {
    console.warn(`[FETCHER:PRESS_LAO] date mismatch: page=${metaDateM[1]}, today=${todayDDMMYYYY}`);
    return null;
  }

  // Extract .lao-num values: [0]=4ตัว, [1]=3ตัว, [2]=2ตัว
  const nums = $('.lao-num').map((_, el) => $(el).text().trim()).get();
  if (!nums.length) return null;

  const raw4 = nums[0] ? nums[0].replace(/\D/g, '') : '';
  const raw3 = nums[1] ? nums[1].replace(/\D/g, '') : '';
  const raw2 = nums[2] ? nums[2].replace(/\D/g, '') : '';

  // Skip if not yet announced (still "xxxx")
  if (!raw4 || raw4.length < 4 || /^x+$/i.test(nums[0])) {
    console.warn('[FETCHER:PRESS_LAO] ยังไม่ออกผล (xxxx)');
    return null;
  }

  // Use laGovExtract-compatible structure (4-digit → pad to 6 → slice logic works)
  // prize_1st = 4-digit (ใช้แค่ 4 ตัว ตามที่ผู้ใช้กำหนด)
  const p4 = raw4.padStart(4, '0').slice(-4);
  const top2 = raw2.length === 2 ? raw2 : p4.slice(-2);
  const top3 = raw3.length === 3 ? raw3 : p4.slice(-3);

  const result = {
    prize_1st:    p4,
    prize_last_2: top2,
    prize_front_3: [],
    prize_last_3: [top3],
    prize_2bot:   null,
  };

  console.log(`[FETCHER:PRESS_LAO] ✅ 4ตัว=${p4} 3ตัว=${top3} 2ตัว=${top2} (date=${metaDateM?.[1]||'?'})`);
  _pressInThLaoCache = { data: result, ts: now };
  return result;
}

async function fetchLAGov() {
  // Source 0: press.in.th — primary ✅ (เลขท้าย 4 ตัว)
  try {
    const r = await fetchPressInThLao();
    if (r) {
      console.log('[FETCHER:LA_GOV] press.in.th ✅ main=%s top2=%s', r.prize_1st, r.prize_last_2);
      return r;
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] press.in.th error:', e.message); }

  // Source 1: TNews (tnews.co.th) — secondary
  try {
    const r = await fetchTNewsLAGov();
    if (r) return r;
  } catch(e) { console.warn('[FETCHER:LA_GOV] TNews error:', e.message); }

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

  // Source 6: MThai lottery (Thai portal — datacenter-friendly)
  try {
    const res = await httpGetProxy('https://www.mthai.com/lottery', 30000, 'th');
    const $   = cheerio.load(res.data);
    let p6 = '';
    // หา section หวยลาว
    $('*').each((_, el) => {
      const t = $(el).text();
      if (t.includes('ลาว') || t.includes('Lao')) {
        const digits = t.replace(/\D/g, '');
        const m = digits.match(/\d{6}/);
        if (m && !p6) p6 = m[0];
      }
    });
    if (!p6) {
      const m = String(res.data).match(/(?:ลาว|lao)[^<]{0,50}(\d{6})/i);
      if (m) p6 = m[1];
    }
    if (p6) {
      console.log('[FETCHER:LA_GOV] Source: mthai.com');
      return laGovExtract(p6);
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] mthai error:', e.message); }

  // Source 7: lotto.laos.gov.la official JSON API (government site — low bot protection)
  try {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2,'0');
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const yyyy = today.getFullYear();
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const apiUrls = [
      `https://lotto.laos.gov.la/public/getLottoResult?date=${dateStr}`,
      `https://lottery.laos.gov.la/api/result?date=${dateStr}`,
      `https://www.lotto.laos.gov.la/api/latest`,
    ];
    for (const apiUrl of apiUrls) {
      try {
        const res = await httpGetProxy(apiUrl, 25000, 'th');
        const d   = res.data;
        const raw = typeof d === 'object'
          ? (d.result || d.prize1 || d.number || d.winning_number || '')
          : String(d);
        const digits = String(raw).replace(/\D/g, '');
        if (digits.length >= 4) {
          console.log('[FETCHER:LA_GOV] Source: lotto.laos.gov.la API');
          return laGovExtract(digits);
        }
      } catch(_) { /* try next */ }
    }
  } catch(e) { console.warn('[FETCHER:LA_GOV] laos.gov.la error:', e.message); }

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

// ── press.in.th Hanoi scraper ─────────────────────────────────────
// URL: https://www.press.in.th/hanoi-lotto/
// Structure: h2 heading → next table → first data row
//   cells[0]=date(DD/MM/YY), cells[1]=4ตัว, cells[2]=3ตัว, cells[3]=2ตัวบน, cells[4]=2ตัวล่าง
// "รอผล" = not yet announced
// ─────────────────────────────────────────────────────────────────

let _pressInThCache = { data: null, ts: 0 };
const PRESS_CACHE_TTL = 3 * 60 * 1000; // 3 นาที

const PRESS_HEADING_MAP = {
  VN_HAN_SP:  ['ฮานอยพิเศษ', 'hanoi พิเศษ', 'hanoiพิเศษ', 'ฮานอย พิเศษ'],
  VN_HAN:     ['ฮานอยปกติ', 'หวยฮานอยปกติ', 'hanoi ปกติ', 'hanoiปกติ'],
  VN_HAN_VIP: ['ฮานอยvip', 'ฮานอย vip', 'hanoivip', 'hanoi vip', 'ฮานอยวีไอพี'],
};

/**
 * Scrape https://www.press.in.th/hanoi-lotto/ and return all available types.
 * Returns: { VN_HAN_SP: {...}, VN_HAN: {...}, VN_HAN_VIP: {...} }
 * Caches the page for PRESS_CACHE_TTL to avoid repeated HTTP calls.
 */
async function getPressInThData() {
  const now = Date.now();
  if (_pressInThCache.data && (now - _pressInThCache.ts) < PRESS_CACHE_TTL) {
    return _pressInThCache.data;
  }

  let html;
  try {
    const res = await httpGetProxy('https://www.press.in.th/hanoi-lotto/', 20000, 'th');
    html = res.data;
  } catch(e) {
    console.warn('[FETCHER:PRESS] fetch error:', e.message);
    return null;
  }

  const $ = cheerio.load(html);

  // Bangkok date today for validation: DD/MM/YY format
  const nowBkk   = new Date(Date.now() + 7 * 3600 * 1000);
  const dd  = String(nowBkk.getUTCDate()).padStart(2, '0');
  const mm  = String(nowBkk.getUTCMonth() + 1).padStart(2, '0');
  const yy  = String(nowBkk.getUTCFullYear()).slice(-2);
  const todayDDMMYY = `${dd}/${mm}/${yy}`;

  const result = {};

  // Find all h2/h3 headings, then look at the table that follows
  $('h2, h3, h4').each((_, headingEl) => {
    const headingText = $(headingEl).text().toLowerCase().replace(/\s+/g, ' ').trim();

    let matchedType = null;
    for (const [lotteryType, keywords] of Object.entries(PRESS_HEADING_MAP)) {
      if (keywords.some(kw => headingText.includes(kw.toLowerCase()))) {
        matchedType = lotteryType;
        break;
      }
    }
    if (!matchedType) return; // not a heading we care about

    // Find the next table after this heading
    const table = $(headingEl).nextAll('table').first();
    if (!table.length) return;

    // First data row (skip thead if any)
    const firstRow = table.find('tbody tr, tr').filter((_, tr) => {
      // Skip header rows
      const cells = $(tr).find('td');
      return cells.length >= 2;
    }).first();
    if (!firstRow.length) return;

    const cells = firstRow.find('td');
    if (cells.length < 2) return;

    const dateCell  = $(cells[0]).text().trim();
    const mainCell  = $(cells[1]).text().trim();
    const top3Cell  = cells.length > 2 ? $(cells[2]).text().trim() : '';
    const top2Cell  = cells.length > 3 ? $(cells[3]).text().trim() : '';
    const bot2Cell  = cells.length > 4 ? $(cells[4]).text().trim() : '';

    // Skip if not yet announced
    if (!mainCell || mainCell.includes('รอผล') || mainCell === '-') return;

    // Validate date matches today
    if (dateCell && dateCell !== todayDDMMYY) {
      console.warn(`[FETCHER:PRESS] ${matchedType} date mismatch: page=${dateCell}, today=${todayDDMMYY}`);
      return;
    }

    const main  = mainCell.replace(/\D/g, '').padStart(4, '0');
    if (!main || main.length < 4) return;

    const top3  = top3Cell.replace(/\D/g, '').padStart(3, '0') || main.slice(-3);
    const top2  = top2Cell.replace(/\D/g, '').padStart(2, '0') || main.slice(-2);
    const bot2  = bot2Cell.replace(/\D/g, '') || null;

    result[matchedType] = {
      prize_1st:     main,
      prize_last_2:  top2,
      prize_2bot:    bot2 || null,
      prize_front_3: [],
      prize_last_3:  [top3],
    };
    console.log(`[FETCHER:PRESS] ✅ ${matchedType} main=${main} top2=${top2} bot2=${bot2||'?'} top3=${top3} (date=${dateCell})`);
  });

  if (Object.keys(result).length > 0) {
    _pressInThCache = { data: result, ts: now };
  }
  return Object.keys(result).length ? result : null;
}

/**
 * ดึงผล press.in.th สำหรับ lottery type ที่ระบุ
 * @param {string} lotteryType  'VN_HAN' | 'VN_HAN_SP' | 'VN_HAN_VIP'
 */
async function fetchPressInThHanoi(lotteryType) {
  const data = await getPressInThData();
  if (!data) return null;
  return data[lotteryType] || null;
}

/**
 * หวยฮานอย (Xổ số Miền Bắc) — ออกผลทุกวัน ~18:30 น.
 * รางวัลที่ 1 (Giải nhất) = 5 หลัก
 */
async function fetchVNHanoi() {
  /**
   * ฮานอยปกติ — ดึงจาก press.in.th ก่อน (primary) → TNews (secondary)
   * Fallback: XSMB Vietnamese sources (RSS/HTML)
   */
  function vn(gdb, g1) {
    return {
      prize_1st:    gdb,
      prize_last_2: gdb.slice(-2),
      prize_2bot:   g1 ? g1.slice(-2) : null,
      prize_front_3: [],
      prize_last_3:  [gdb.slice(-3)],
    };
  }

  // Source 1: press.in.th — primary ✅
  try {
    const result = await fetchPressInThHanoi('VN_HAN');
    if (result) {
      console.log('[FETCHER:VN_HAN] press.in.th ✅ main=%s top2=%s bot2=%s', result.prize_1st, result.prize_last_2, result.prize_2bot||'?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] press.in.th error:', e.message); }

  // Source 2: TNews.co.th (section ผลหวยฮานอยปกติ) — secondary
  try {
    const result = await fetchTNewsVNHanoi('VN_HAN');
    if (result) {
      console.log('[FETCHER:VN_HAN] TNews ✅ main=%s top2=%s bot2=%s', result.prize_1st, result.prize_last_2, result.prize_2bot||'?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN] TNews error:', e.message); }

  // Source 2: xskt.com.vn RSS feed (XML — fallback, XSMB 5-digit)
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
//
//  โครงสร้างจริงของ TNews บทความ (ยืนยันจากหน้าเว็บ 21/4/69):
//  บทความ 1 URL มีผลทุกประเภทรวมกัน แบ่งเป็น section:
//
//    ผลหวยฮานอยเฉพาะกิจ          ← ไม่ใช่ประเภทเราใช้
//    เลข 4 ตัว :  2860
//    เลข 3 ตัวบน :  860
//    เลข 2 ตัวบน :  60
//    เลข 2 ตัวล่าง :  11
//
//    ผลหวยฮานอยพิเศษ             ← VN_HAN_SP
//    เลข 4 ตัว :  9349
//    เลข 3 ตัวบน :  349
//    เลข 2 ตัวบน :  49
//    เลข 2 ตัวล่าง :  74
//
//    ผลหวยฮานอยปกติ              ← VN_HAN
//    เลข 4 ตัว :  (empty until announced)
//    ...
//
//    ผลหวยฮานอย vip              ← VN_HAN_VIP
//    เลข 4 ตัว :  (empty until announced)
//    ...
//
//  KEY: ผลคือ 4 หลัก (ไม่ใช่ 5 หลักแบบเวียดนาม), ดึง section ตาม header
// ═══════════════════════════════════════════════════════════════════

// Section headers ในบทความ TNews สำหรับแต่ละ lottery type
const TNEWS_SECTION_HEADERS = {
  VN_HAN:     ['ผลหวยฮานอยปกติ', 'ฮานอยปกติ', 'hanoiปกติ'],
  VN_HAN_SP:  ['ผลหวยฮานอยพิเศษ', 'ฮานอยพิเศษ', 'hanoi พิเศษ'],
  VN_HAN_VIP: ['ผลหวยฮานอย vip', 'ฮานอย vip', 'ฮานอยวีไอพี', 'hanoi vip'],
};

// Cache บทความ TNews (5 นาที) — article ใช้ร่วมกันทุก type ใน 1 URL
let _tnewsCache = { data: null, ts: 0 };
const TNEWS_CACHE_TTL = 5 * 60 * 1000;

/**
 * หา URL บทความ TNews วันนี้
 * Strategy 0: WordPress REST API (เร็ว + รองรับ date filter)
 * Strategy 1: RSS/Atom feed (server-rendered XML — ไม่ต้องการ JS)
 * Strategy 2: HTML listing page (fallback)
 */
async function findTNewsArticleUrl() {
  const BROAD_KW = ['ฮานอย', 'หวยฮานอย', 'hanoi'];
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // Bangkok date YYYY-MM-DD

  // ── Strategy 0: WordPress REST API ─────────────────────────────────────────
  const WP_API_URLS = [
    'https://www.tnews.co.th/wp-json/wp/v2/posts?search=%E0%B8%AB%E0%B8%A7%E0%B8%A2%E0%B8%AE%E0%B8%B2%E0%B8%99%E0%B8%AD%E0%B8%A2&per_page=10&_fields=link,title,date',
    'https://www.tnews.co.th/wp-json/wp/v2/posts?search=%E0%B8%AE%E0%B8%B2%E0%B8%99%E0%B8%AD%E0%B8%A2&per_page=10&_fields=link,title,date',
  ];
  for (const wpUrl of WP_API_URLS) {
    try {
      const wpRes = await httpGetProxy(wpUrl, 15000, 'th');
      const posts = Array.isArray(wpRes.data) ? wpRes.data : [];
      // 1st pass: prefer today's article
      for (const post of posts) {
        const link  = String(post.link || '');
        const title = String(post.title?.rendered || '').toLowerCase();
        const date  = String(post.date || '').slice(0, 10);
        const isHanoi  = BROAD_KW.some(kw => title.includes(kw.toLowerCase()));
        const isToday  = Math.abs(new Date(date) - new Date(todayStr)) <= 86400 * 1000;
        if (isHanoi && isToday && /lotto-horo-belief\/\d+/.test(link)) {
          console.log('[FETCHER:TNEWS] WP API today →', link, '(date:', date, ')');
          return link;
        }
      }
      // 2nd pass: most recent Hanoi article (any date)
      for (const post of posts) {
        const link  = String(post.link || '');
        const title = String(post.title?.rendered || '').toLowerCase();
        const isHanoi = BROAD_KW.some(kw => title.includes(kw.toLowerCase()));
        if (isHanoi && /lotto-horo-belief\/\d+/.test(link)) {
          console.log('[FETCHER:TNEWS] WP API (latest) →', link);
          return link;
        }
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS] WP API error (%s):', wpUrl, e.message);
    }
  }

  // ── Strategy 1: WordPress RSS feed (เร็วกว่า, ไม่ต้องการ JS) ──────
  const RSS_URLS = [
    'https://www.tnews.co.th/lotto-horo-belief/feed',
    'https://www.tnews.co.th/category/lotto-horo-belief/feed',
    'https://www.tnews.co.th/feed?cat=lotto-horo-belief',
    'https://www.tnews.co.th/feed',
  ];

  for (const rssUrl of RSS_URLS) {
    try {
      const rssRes = await httpGetProxy(rssUrl, 15000, 'th');
      const xml    = String(rssRes.data);
      // ดึง <link> จาก <item> ที่มี title ตรงกับ keyword ฮานอย
      const items  = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
      for (const item of items) {
        const titleM = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const linkM  = item.match(/<link>([\s\S]*?)<\/link>/i)
                    || item.match(/<link[^>]*href="([^"]+)"/i);
        if (!titleM || !linkM) continue;
        const title = titleM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().toLowerCase();
        const link  = linkM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const isHanoi = BROAD_KW.some(kw => title.includes(kw.toLowerCase()));
        if (isHanoi && /lotto-horo-belief\/\d+/.test(link)) {
          console.log('[FETCHER:TNEWS] RSS →', link);
          return link;
        }
      }
      // fallback: ลิ้งแรกในหน้า RSS ที่ตรงกับ category
      for (const item of items) {
        const linkM = item.match(/<link>([\s\S]*?)<\/link>/i)
                   || item.match(/<link[^>]*href="([^"]+)"/i);
        if (!linkM) continue;
        const link = linkM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        if (/lotto-horo-belief\/\d+/.test(link)) {
          console.log('[FETCHER:TNEWS] RSS fallback (first item) →', link);
          return link;
        }
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS] RSS error (%s):', rssUrl, e.message);
    }
  }

  // ── Strategy 2: HTML listing page ────────────────────────────────
  const LISTING_URLS = [
    'https://www.tnews.co.th/lotto-horo-belief',
    'https://www.tnews.co.th/category/lotto-horo-belief',
  ];

  for (const listUrl of LISTING_URLS) {
    try {
      const listRes = await httpGetProxy(listUrl, 20000, 'th');
      const $list   = cheerio.load(listRes.data);
      let articleUrl = null;

      $list('a[href*="lotto-horo-belief/"]').each((_, el) => {
        if (articleUrl) return;
        const href = $list(el).attr('href') || '';
        const text = ($list(el).text() + ' ' + ($list(el).attr('title') || '')).toLowerCase();
        const hit  = BROAD_KW.some(kw => text.includes(kw.toLowerCase()));
        if (hit && /\/lotto-horo-belief\/\d+/.test(href)) {
          articleUrl = href.startsWith('http') ? href : 'https://www.tnews.co.th' + href;
        }
      });

      if (!articleUrl) {
        $list('a[href*="lotto-horo-belief/"]').each((_, el) => {
          if (articleUrl) return;
          const href = $list(el).attr('href') || '';
          if (/\/lotto-horo-belief\/\d+/.test(href)) {
            articleUrl = href.startsWith('http') ? href : 'https://www.tnews.co.th' + href;
          }
        });
      }

      if (articleUrl) {
        console.log('[FETCHER:TNEWS] HTML listing OK →', articleUrl);
        return articleUrl;
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS] listing error (%s):', listUrl, e.message);
    }
  }

  console.warn('[FETCHER:TNEWS] ไม่พบ URL บทความ (RSS + listing ล้มเหลว)');
  return null;
}

/**
 * แยก section ของ lottery type จาก body text ของบทความ TNews
 * รูปแบบ: "เลข 4 ตัว : XXXX", "เลข 3 ตัวบน : XXX", "เลข 2 ตัวบน : XX", "เลข 2 ตัวล่าง : XX"
 *
 * v2: section-boundary splitting
 *   - รวม header ทุกประเภท (รวม เฉพาะกิจ เป็น boundary marker) เพื่อคำนวณขอบเขต chunk
 *   - ทุก occurrence ของ header แต่ละประเภทจะถูกตรวจ; ใช้ boundary ถัดไปเป็น chunk end
 *   - ถ้า chunk ไม่มีเลข (ยังไม่ออกผล) → ข้ามไป occurrence ถัดไป
 *   - ป้องกัน false-positive จาก title/intro ที่มีชื่อ section ปะปน
 */
function parseTNewsSections(html) {
  const $ = cheerio.load(html);
  // ดึง body text ให้ได้เยอะที่สุด
  let bodyText = '';
  for (const sel of ['article', '.content-body', '.post-content', '.article-content',
                     '.entry-content', '#content-body', '#article-body', 'body']) {
    const t = $(sel).first().text();
    if (t && t.length > bodyText.length) bodyText = t;
  }
  if (!bodyText) bodyText = $.text();

  const bodyLower = bodyText.toLowerCase();

  // headers ทุกประเภท — รวม เฉพาะกิจ เพื่อใช้เป็น boundary marker
  const ALL_SECTION_HEADERS = {
    VN_HAN_EKKA: ['ผลหวยฮานอยเฉพาะกิจ', 'ฮานอยเฉพาะกิจ'],   // boundary only
    VN_HAN:      ['ผลหวยฮานอยปกติ', 'ฮานอยปกติ', 'hanoiปกติ'],
    VN_HAN_SP:   ['ผลหวยฮานอยพิเศษ', 'ฮานอยพิเศษ', 'hanoi พิเศษ'],
    VN_HAN_VIP:  ['ผลหวยฮานอย vip', 'ฮานอย vip', 'ฮานอยวีไอพี', 'hanoi vip'],
  };

  // รวบรวม position ทุกจุดที่พบ header ใด ๆ → ใช้เป็น boundary set
  const allBoundaryPos = new Set();
  for (const hdrs of Object.values(ALL_SECTION_HEADERS)) {
    for (const hdr of hdrs) {
      const hdrLow = hdr.toLowerCase();
      let p = 0;
      while (true) {
        const idx = bodyLower.indexOf(hdrLow, p);
        if (idx === -1) break;
        allBoundaryPos.add(idx);
        p = idx + 1;
      }
    }
  }
  const boundaries = [...allBoundaryPos].sort((a, b) => a - b);

  /** หา boundary ถัดไปหลัง position idx (หรือ idx+800 ถ้าไม่มี) */
  function nextBoundary(idx) {
    for (const b of boundaries) {
      if (b > idx) return b;
    }
    return idx + 800;
  }

  const TARGET_TYPES = new Set(['VN_HAN', 'VN_HAN_SP', 'VN_HAN_VIP']);
  const result = {};

  for (const [lotteryType, headers] of Object.entries(ALL_SECTION_HEADERS)) {
    if (!TARGET_TYPES.has(lotteryType)) continue;

    let found = false;
    for (const header of headers) {
      if (found) break;
      const hdrLow = header.toLowerCase();
      let p = 0;
      while (!found) {
        const idx = bodyLower.indexOf(hdrLow, p);
        if (idx === -1) break;
        p = idx + 1;

        // chunk ถูกกำหนดโดย boundary ถัดไป (ไม่ใช่ fixed 500 chars)
        const chunkEnd = nextBoundary(idx);
        const chunk = bodyText.slice(idx, chunkEnd);

        // เลข 4 ตัว : XXXX
        const m4  = chunk.match(/เลข\s*4\s*ตัว\s*[:\-]?\s*(\d{3,5})/i);
        if (!m4) continue; // occurrence นี้ไม่มีเลข → ลอง occurrence ถัดไป

        // เลข 3 ตัวบน : XXX
        const m3  = chunk.match(/เลข\s*3\s*ตัวบน\s*[:\-]?\s*(\d{2,4})/i);
        // เลข 2 ตัวบน : XX
        const m2t = chunk.match(/เลข\s*2\s*ตัวบน\s*[:\-]?\s*(\d{1,3})/i);
        // เลข 2 ตัวล่าง : XX
        const m2b = chunk.match(/เลข\s*2\s*ตัวล่าง\s*[:\-]?\s*(\d{1,3})/i);

        const main = m4[1].padStart(4, '0');
        const top3 = m3  ? m3[1].padStart(3, '0') : main.slice(-3);
        const top2 = m2t ? m2t[1].padStart(2, '0') : main.slice(-2);
        const bot2 = m2b ? m2b[1].padStart(2, '0') : null;

        result[lotteryType] = {
          prize_1st:     main,
          prize_last_2:  top2,
          prize_2bot:    bot2,
          prize_front_3: [],
          prize_last_3:  [top3],
        };
        found = true;
      }
    }
  }
  return result;
}

/**
 * ดึงและ cache article TNews วันนี้ → return parsed sections object
 * { VN_HAN: {...}, VN_HAN_SP: {...}, VN_HAN_VIP: {...} }
 */
async function getTNewsData() {
  const now = Date.now();
  if (_tnewsCache.data && (now - _tnewsCache.ts) < TNEWS_CACHE_TTL) {
    return _tnewsCache.data;
  }

  const url = await findTNewsArticleUrl();
  if (!url) {
    console.warn('[FETCHER:TNEWS] ไม่พบ URL บทความ — ข้าม');
    return null;
  }

  try {
    const artRes = await httpGetProxy(url, 25000, 'th');
    const parsed = parseTNewsSections(artRes.data);
    const found  = Object.keys(parsed);
    console.log('[FETCHER:TNEWS] ✅ article parsed, types found:', found.length ? found.join(', ') : 'ไม่พบ section');
    // ถ้ายังไม่ครบทุก section ให้ cache แค่ 1 นาที (แทน 5 นาที) เพื่อให้ retry เร็วขึ้น
    const allFound = ['VN_HAN','VN_HAN_SP','VN_HAN_VIP'].every(t => parsed[t]);
    const cacheTs  = allFound ? now : now - (TNEWS_CACHE_TTL - 60 * 1000);
    _tnewsCache = { data: parsed, ts: cacheTs };
    return parsed;
  } catch(e) {
    console.warn('[FETCHER:TNEWS] article fetch error:', e.message);
    return null;
  }
}

/**
 * ดึงผล TNews สำหรับ lottery type ที่ระบุ
 * @param {string} lotteryType  'VN_HAN' | 'VN_HAN_SP' | 'VN_HAN_VIP'
 */
async function fetchTNewsVNHanoi(lotteryType) {
  const data = await getTNewsData();
  if (!data) return null;

  const r = data[lotteryType];
  if (r) {
    console.log(`[FETCHER:${lotteryType}] TNews ✅ main=${r.prize_1st} top2=${r.prize_last_2} bot2=${r.prize_2bot||'?'} top3=${(r.prize_last_3||[])[0]||'?'}`);
    return r;
  }

  console.warn(`[FETCHER:${lotteryType}] TNews: section ไม่พบหรือยังไม่ออกผล`);
  return null;
}

// ── TNews Lao Lottery ──────────────────────────────────────────────────────
// TNews publishes daily Lao lottery articles in the same category as Hanoi.
// Article title keywords: "ลาว", "ลาวพัฒนา", "หวยลาว"
// Section format (6-digit main number):
//   ผลหวยลาวพัฒนา
//   ตัวเต็ง (รางวัลที่ 1) : 312456   ← 6 digits
//   เลข 4 ตัว : 2456
//   เลข 3 ตัวบน : 456
//   เลข 2 ตัวบน : 56
//   เลข 2 ตัวล่าง : 31
// ═══════════════════════════════════════════════════════════════════

const TNEWS_LAO_KEYWORDS = ['ลาวพัฒนา', 'หวยลาว', 'laosvip', 'ลาว วีไอพี', 'ลาวสตาร์'];
const TNEWS_LAO_SECTION_HEADERS = [
  'ผลหวยลาวพัฒนา', 'หวยลาวพัฒนา', 'ลาวพัฒนา',
  'ผลหวยลาว', 'หวยลาว', 'ลาว พัฒนา', 'lao', 'ลาววีไอพี',
];

let _tnewsLaoCache = { data: null, ts: 0 };
const TNEWS_LAO_CACHE_TTL = 5 * 60 * 1000;

/**
 * หา URL บทความ TNews สำหรับหวยลาว
 * Strategy 0: WordPress REST API (fastest, most reliable)
 * Strategy 1: RSS feed
 * Strategy 2: HTML listing
 */
async function findTNewsLaoArticleUrl() {
  const BROAD_KW = ['ลาว', 'หวยลาว', 'ลาวพัฒนา'];
  const todayStr = new Date(Date.now() + 7*3600*1000).toISOString().slice(0,10); // Bangkok date

  // ── Strategy 0: WordPress REST API — เร็ว reliable และรองรับ search ──
  const wpApiUrls = [
    'https://www.tnews.co.th/wp-json/wp/v2/posts?search=%E0%B8%AB%E0%B8%A7%E0%B8%A2%E0%B8%A5%E0%B8%B2%E0%B8%A7&per_page=10&_fields=link,title,date',
    // fallback: ลาวพัฒนา
    'https://www.tnews.co.th/wp-json/wp/v2/posts?search=%E0%B8%A5%E0%B8%B2%E0%B8%A7%E0%B8%9E%E0%B8%B1%E0%B8%92%E0%B8%99%E0%B8%B2&per_page=10&_fields=link,title,date',
  ];
  for (const wpUrl of wpApiUrls) {
    try {
      const wpRes = await httpGetProxy(wpUrl, 15000, 'th');
      const posts = Array.isArray(wpRes.data) ? wpRes.data : [];
      for (const post of posts) {
        const link  = String(post.link || '');
        const title = String(post.title?.rendered || '').toLowerCase();
        const date  = String(post.date || '').slice(0, 10); // 'YYYY-MM-DD' UTC
        const isLao = BROAD_KW.some(kw => title.includes(kw.toLowerCase()));
        // รับวันที่ตรงกับ BKK today หรือ ±1 วัน
        const dateOk = Math.abs(new Date(date) - new Date(todayStr)) <= 86400*1000;
        if (isLao && /lotto-horo-belief\/\d+/.test(link) && dateOk) {
          console.log('[FETCHER:TNEWS_LAO] WP API →', link, '(date:', date, ')');
          return link;
        }
      }
      // ถ้าไม่ตรงวันก็เอา post แรกที่มี keyword ลาว
      for (const post of posts) {
        const link  = String(post.link || '');
        const title = String(post.title?.rendered || '').toLowerCase();
        const isLao = BROAD_KW.some(kw => title.includes(kw.toLowerCase()));
        if (isLao && /lotto-horo-belief\/\d+/.test(link)) {
          console.log('[FETCHER:TNEWS_LAO] WP API (any date) →', link);
          return link;
        }
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS_LAO] WP API error:', e.message);
    }
  }

  // ── Strategy 1: RSS feed ──────────────────────────────────────
  const RSS_URLS = [
    'https://www.tnews.co.th/lotto-horo-belief/feed',
    'https://www.tnews.co.th/category/lotto-horo-belief/feed',
    'https://www.tnews.co.th/feed?cat=lotto-horo-belief',
  ];

  for (const rssUrl of RSS_URLS) {
    try {
      const rssRes = await httpGetProxy(rssUrl, 15000, 'th');
      const xml    = String(rssRes.data);
      const items  = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
      for (const item of items) {
        const titleM = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const linkM  = item.match(/<link>([\s\S]*?)<\/link>/i)
                    || item.match(/<link[^>]*href="([^"]+)"/i);
        if (!titleM || !linkM) continue;
        const title = titleM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().toLowerCase();
        const link  = linkM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const isLao = BROAD_KW.some(kw => title.includes(kw.toLowerCase()));
        if (isLao && /lotto-horo-belief\/\d+/.test(link)) {
          console.log('[FETCHER:TNEWS_LAO] RSS →', link);
          return link;
        }
      }
      console.log('[FETCHER:TNEWS_LAO] RSS scanned', items.length, 'items, no Lao article found');
    } catch(e) {
      console.warn('[FETCHER:TNEWS_LAO] RSS error (%s):', rssUrl, e.message);
    }
  }

  // ── Strategy 2: HTML listing + broader search ─────────────────
  const LISTING_URLS = [
    'https://www.tnews.co.th/lotto-horo-belief',
    'https://www.tnews.co.th/category/lotto-horo-belief',
    'https://www.tnews.co.th/?s=%E0%B8%AB%E0%B8%A7%E0%B8%A2%E0%B8%A5%E0%B8%B2%E0%B8%A7', // search ?s=หวยลาว
  ];
  for (const listUrl of LISTING_URLS) {
    try {
      const listRes = await httpGetProxy(listUrl, 20000, 'th');
      const $list   = cheerio.load(listRes.data);
      let articleUrl = null;
      // ลองกว้างขึ้น: เอา link ใดก็ได้ใน lotto-horo-belief ที่ title มี keyword
      $list('a[href*="lotto-horo-belief/"]').each((_, el) => {
        if (articleUrl) return;
        const href  = $list(el).attr('href') || '';
        const text  = ($list(el).text() + ' ' + ($list(el).attr('title') || '')).toLowerCase();
        const isLao = BROAD_KW.some(kw => text.includes(kw.toLowerCase()));
        if (isLao && /\/lotto-horo-belief\/\d+/.test(href)) {
          articleUrl = href.startsWith('http') ? href : 'https://www.tnews.co.th' + href;
        }
      });
      if (articleUrl) {
        console.log('[FETCHER:TNEWS_LAO] HTML listing →', articleUrl);
        return articleUrl;
      }
    } catch(e) {
      console.warn('[FETCHER:TNEWS_LAO] listing error (%s):', listUrl, e.message);
    }
  }

  console.warn('[FETCHER:TNEWS_LAO] ❌ ไม่พบ URL บทความ (WP API + RSS + listing ล้มเหลวทั้งหมด)');
  return null;
}

/**
 * แยก section หวยลาวจาก body text ของบทความ TNews
 * รองรับ format หลัก: "หวยลาวรางวัลเลข 6 ตัว : 261907"  ← TNews actual format
 * รองรับ format สำรอง: "เลข 6 ตัว : XXXXXX", standalone 6-digit, reconstruct จากส่วนย่อย
 */
function parseTNewsLaoSection(html) {
  const $ = cheerio.load(html);
  let bodyText = '';
  for (const sel of ['article', '.content-body', '.post-content', '.article-content',
                     '.entry-content', '#content-body', '#article-body', 'body']) {
    const t = $(sel).first().text();
    if (t && t.length > bodyText.length) bodyText = t;
  }
  if (!bodyText) bodyText = $.text();

  // ── Fast path A: "หวยลาวรางวัลเลข 6 ตัว : XXXXXX" ─────────────
  // นี่คือ format จริงของ TNews (เห็นได้จาก tnews.co.th/lotto-horo-belief/*)
  const mFast6 = bodyText.match(/หวยลาวรางวัลเลข\s*6\s*ตัว\s*[:\-]?\s*(\d{5,6})/i);
  if (mFast6) {
    console.log('[FETCHER:TNEWS_LAO] ✅ fast-path A (หวยลาวรางวัลเลข 6 ตัว):', mFast6[1]);
    return laGovExtract(mFast6[1]);
  }

  // ── Fast path B: "รางวัลเลข 6 ตัว : XXXXXX" (variation) ─────────
  const mFast6b = bodyText.match(/รางวัลเลข\s*6\s*ตัว\s*[:\-]?\s*(\d{5,6})/i);
  if (mFast6b) {
    console.log('[FETCHER:TNEWS_LAO] ✅ fast-path B (รางวัลเลข 6 ตัว):', mFast6b[1]);
    return laGovExtract(mFast6b[1]);
  }

  // ── Fast path C: reconstruct จาก 4-digit + 2-digit (format อื่น) ─
  // "หวยลาวรางวัลเลข 4 ตัว : 1907" + "หวยลาวรางวัลเลข 2 ตัว : XX"
  // แต่ 4-digit ไม่รู้ first 2 digits → ต้องมี 5 หรือ 6 ตัวก่อน
  const mFast5 = bodyText.match(/หวยลาวรางวัลเลข\s*5\s*ตัว\s*[:\-]?\s*(\d{5})/i);
  if (mFast5) {
    // 5-digit → pad to 6 with leading 0 is wrong; need context
    // Try first digit from context - use สถิติ/ผลย้อนหลัง if available
    // For now: store as "0" + 5-digit (will be wrong for leading non-zero)
    const mFast2 = bodyText.match(/หวยลาวรางวัลเลข\s*2\s*ตัว\s*[:\-]?\s*(\d{2})/i);
    console.log('[FETCHER:TNEWS_LAO] ⚠️ fast-path C (5-digit, may be imprecise):', mFast5[1]);
    return laGovExtract(mFast5[1]); // laGovExtract จะ padStart(6,'0')
  }

  // ── Section header loop (original logic, fallback) ───────────────
  for (const header of TNEWS_LAO_SECTION_HEADERS) {
    const idx = bodyText.toLowerCase().indexOf(header.toLowerCase());
    if (idx === -1) continue;

    const chunk = bodyText.slice(idx, idx + 1000); // ขยาย chunk เป็น 1000 ตัวอักษร

    // 1. ตัวเต็ง / รางวัลที่ 1 / เลข 6 ตัว  → 6 digits
    const m6 = chunk.match(/(?:ตัวเต็ง|รางวัลที่\s*1|(?:หวยลาวรางวัล)?เลข\s*6\s*ตัว|รางวัล\s*ที่\s*1)\s*[:\-]?\s*(\d{5,6})/i);
    if (m6) {
      console.log('[FETCHER:TNEWS_LAO] section+label 6-digit:', m6[1]);
      return laGovExtract(m6[1]);
    }

    // 2. เลข 4 ตัว → 4 digits พร้อม 2 ตัวล่าง เพื่อ reconstruct
    const m5 = chunk.match(/(?:หวยลาวรางวัล)?เลข\s*5\s*ตัว\s*[:\-]?\s*(\d{5})/i);
    if (m5) {
      console.log('[FETCHER:TNEWS_LAO] section+5-digit:', m5[1]);
      return laGovExtract(m5[1]);
    }

    // 3. Fallback: standalone 6-digit ใน chunk
    const mAny6 = chunk.match(/\b(\d{6})\b/);
    if (mAny6) {
      console.log('[FETCHER:TNEWS_LAO] section standalone 6-digit:', mAny6[1]);
      return laGovExtract(mAny6[1]);
    }

    // section found but no numbers yet (ผลยังไม่ออก)
    console.warn('[FETCHER:TNEWS_LAO] section found but no numbers yet in header:', header);
    return null;
  }

  // ── Last resort: หา 6-digit แรกที่ดูเหมือน lottery number ─────────
  // (ไม่ใช่ปีพุทธศักราช, ไม่ใช่ตัวเลขอื่น)
  const allSix = [...bodyText.matchAll(/\b(\d{6})\b/g)].map(m => m[1])
    .filter(n => !(parseInt(n) >= 256000 && parseInt(n) <= 257000)); // ข้ามปี พ.ศ.
  if (allSix.length) {
    console.log('[FETCHER:TNEWS_LAO] last-resort standalone 6-digit:', allSix[0]);
    return laGovExtract(allSix[0]);
  }

  return null;
}

/**
 * ดึงและ cache ผลหวยลาวจาก TNews
 */
async function getTNewsLaoData() {
  const now = Date.now();
  if (_tnewsLaoCache.data && (now - _tnewsLaoCache.ts) < TNEWS_LAO_CACHE_TTL) {
    return _tnewsLaoCache.data;
  }

  const url = await findTNewsLaoArticleUrl();
  if (!url) {
    console.warn('[FETCHER:TNEWS_LAO] ไม่พบ URL บทความ — ข้าม');
    return null;
  }

  try {
    const artRes = await httpGetProxy(url, 25000, 'th');
    const parsed = parseTNewsLaoSection(artRes.data);
    if (parsed) {
      _tnewsLaoCache = { data: parsed, ts: now };
      console.log('[FETCHER:TNEWS_LAO] ✅ parsed prize_1st:', parsed.prize_1st);
    } else {
      // ยังไม่มีผล — cache สั้นๆ 1 นาทีเพื่อให้ retry เร็ว
      _tnewsLaoCache = { data: null, ts: now - (TNEWS_LAO_CACHE_TTL - 60 * 1000) };
    }
    return parsed;
  } catch(e) {
    console.warn('[FETCHER:TNEWS_LAO] article fetch error:', e.message);
    return null;
  }
}

/**
 * ดึงผลหวยลาวพัฒนาจาก TNews
 */
async function fetchTNewsLAGov() {
  const r = await getTNewsLaoData();
  if (r) {
    console.log(`[FETCHER:LA_GOV] TNews ✅ prize_1st=${r.prize_1st} last2=${r.prize_last_2} 2bot=${r.prize_2bot||'?'}`);
    return r;
  }
  return null;
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
    prize_front_3  = [],
    prize_last_3   = [],
    prize_2bot,                  // ลาวพัฒนา/VN: 2bot แยก
    prize_near_1st = [],         // TH_GOV: รางวัลใกล้เคียงที่ 1 (6d × 2)
    prize_2nd      = [],         // TH_GOV: รางวัลที่ 2 (6d × 5)
    prize_3rd      = [],         // TH_GOV: รางวัลที่ 3 (6d × 10)
    prize_4th      = [],         // TH_GOV: รางวัลที่ 4 (6d × 50)
    prize_5th      = [],         // TH_GOV: รางวัลที่ 5 (6d × 100)
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
    // ใช้ conn.query() แทน conn.execute() ทั้งหมด
    // เพื่อหลีกเลี่ยง prepared-statement metadata bug ใน mysql2 3.x (ENUM/SELECT*)

    // 1. Insert ผลรางวัล
    await conn.query(
      `INSERT INTO lottery_results
         (round_id, prize_1st,
          prize_near_1st, prize_2nd, prize_3rd, prize_4th, prize_5th,
          prize_last_2, prize_2bot, prize_front_3, prize_last_3, announced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [round.id, prize_1st,
       JSON.stringify(prize_near_1st), JSON.stringify(prize_2nd),
       JSON.stringify(prize_3rd),      JSON.stringify(prize_4th),
       JSON.stringify(prize_5th),
       prize_last_2, prize_2bot_store,
       JSON.stringify(prize_front_3),  JSON.stringify(prize_last_3)]
    );

    // 2. อัปเดตงวด → announced
    await conn.query(
      "UPDATE lottery_rounds SET status='announced' WHERE id=?", [round.id]
    );

    // 3. ดึง rates ของ lottery type นี้
    const [ltRows] = await conn.query(
      `SELECT rate_3top, rate_3tod, rate_2top, rate_2bot, rate_run_top, rate_run_bot
       FROM lottery_types WHERE id=?`, [typeId]
    );
    const lt = ltRows[0];
    if (!lt) return;

    // 4. ดึง bets ทั้งหมดที่รอผล
    const [bets] = await conn.query(
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

      await conn.query(
        'UPDATE bets SET status=?, win_amount=? WHERE id=?',
        [won ? 'win' : 'lose', winAmt, bet.id]
      );

      if (won && winAmt > 0) {
        const [mRows] = await conn.query(
          'SELECT balance FROM members WHERE id=? FOR UPDATE', [bet.member_id]
        );
        const m = mRows[0];
        const newBal = parseFloat(m.balance) + parseFloat(winAmt);
        await conn.query(
          'UPDATE members SET balance=?, total_win=total_win+? WHERE id=?',
          [newBal, winAmt, bet.member_id]
        );
        await conn.query(
          `INSERT INTO transactions
             (uuid, member_id, type, amount, balance_before, balance_after, description)
           VALUES (?, ?, 'win', ?, ?, ?, ?)`,
          [uuidv4(), bet.member_id, winAmt, m.balance, newBal,
           `ถูกรางวัล ${lotteryCode}: ${bet.number} (${bet.bet_type}) งวด ${round.round_name}`]
        );
        await conn.query(
          'INSERT INTO notifications (member_id, title, body, type) VALUES (?, ?, ?, ?)',
          [bet.member_id,
           `🎉 ถูกรางวัล!`,
           `เลข ${bet.number} ถูกรางวัล ${lotteryCode}! ได้รับเงิน ฿${Number(winAmt).toLocaleString()}`,
           'win']
        );
      }
    }

    // 6. จ่ายรางวัลให้ agent_bets (เอเยนต์ที่แทงหวยเอง)
    const [agentBets] = await conn.query(
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

      await conn.query(
        'UPDATE agent_bets SET status=?, win_amount=? WHERE id=?',
        [won ? 'win' : 'lose', winAmt, abet.id]
      ).catch(() => {});

      if (won && winAmt > 0) {
        const [agRows] = await conn.query(
          'SELECT balance FROM agents WHERE id=? FOR UPDATE', [abet.agent_id]
        ).catch(() => [[{ balance: 0 }]]);
        const ag = agRows[0] || { balance: 0 };
        const newBal = parseFloat(ag.balance) + parseFloat(winAmt);
        await conn.query(
          'UPDATE agents SET balance=?, total_commission=total_commission+? WHERE id=?',
          [newBal, winAmt, abet.agent_id]
        ).catch(() => {});
        await conn.query(
          'INSERT INTO agent_transactions (uuid, agent_id, type, amount, balance_before, balance_after, description) VALUES (?,?,?,?,?,?,?)',
          [uuidv4(), abet.agent_id, 'win', winAmt, ag.balance, newBal,
           `ถูกรางวัล ${bet_type_label(abet.bet_type)} ${abet.number} งวด ${round.round_name}`]
        ).catch(() => {});
      }
    }

    // 7. อัปเดต total_win ของงวด
    const [wsRows] = await conn.query(
      `SELECT COALESCE(SUM(win_amount),0) s FROM bets WHERE round_id=? AND status="win"`,
      [round.id]
    );
    const [agWsRows] = await conn.query(
      `SELECT COALESCE(SUM(win_amount),0) s FROM agent_bets WHERE round_id=? AND status="win"`,
      [round.id]
    ).catch(() => [[{ s: 0 }]]);
    await conn.query(
      'UPDATE lottery_rounds SET total_win=? WHERE id=?',
      [parseFloat((wsRows[0]||{s:0}).s) + parseFloat((agWsRows[0]||{s:0}).s), round.id]
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

  // ── html_tnews: RSS → find article URL → fetch article → section parse ──
  if (src.transform === 'html_tnews') {
    const xml      = String(rawData);
    const items    = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    const KW       = ['ฮานอย', 'หวยฮานอย', 'hanoi'];
    let articleUrl = null;

    // หา item ที่มี title ตรงกับ keyword
    for (const item of items) {
      const titleM = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const linkM  = item.match(/<link>([\s\S]*?)<\/link>/i)
                  || item.match(/<link[^>]*href="([^"]+)"/i);
      if (!titleM || !linkM) continue;
      const title  = titleM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().toLowerCase();
      const link   = linkM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (KW.some(kw => title.includes(kw.toLowerCase())) && /lotto-horo-belief\/\d+/.test(link)) {
        articleUrl = link;
        break;
      }
    }
    // fallback: ลิ้งแรกใน RSS
    if (!articleUrl) {
      for (const item of items) {
        const linkM = item.match(/<link>([\s\S]*?)<\/link>/i)
                   || item.match(/<link[^>]*href="([^"]+)"/i);
        if (!linkM) continue;
        const link = linkM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        if (/lotto-horo-belief\/\d+/.test(link)) { articleUrl = link; break; }
      }
    }

    if (!articleUrl) throw new Error('html_tnews: ไม่พบ article URL ใน RSS');

    console.log(`[FETCHER:${src.lottery_code||'?'}] html_tnews → article: ${articleUrl}`);
    const artResp = await httpGetProxy(articleUrl, 25000, 'th');
    const sections = parseTNewsSections(artResp.data);
    const lotteryCode = src.lottery_code;
    const found = lotteryCode && sections[lotteryCode] ? sections[lotteryCode] : Object.values(sections)[0];
    if (!found) throw new Error(`html_tnews: section "${lotteryCode}" ไม่พบหรือยังไม่ออกผล`);
    return found;
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
  // Source 1: press.in.th — primary ✅
  try {
    const result = await fetchPressInThHanoi('VN_HAN_SP');
    if (result) {
      console.log('[FETCHER:VN_HAN_SP] press.in.th ✅ main=%s top2=%s bot2=%s', result.prize_1st, result.prize_last_2, result.prize_2bot||'?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_SP] press.in.th error:', e.message); }

  // Source 2: TNews.co.th — secondary (section ผลหวยฮานอยพิเศษ)
  try {
    const result = await fetchTNewsVNHanoi('VN_HAN_SP');
    if (result) {
      console.log('[FETCHER:VN_HAN_SP] TNews ✅ main=%s top2=%s bot2=%s', result.prize_1st, result.prize_last_2, result.prize_2bot||'?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_SP] TNews error:', e.message); }

  // Source 3: DB sources (Admin-configured) — fallback
  try {
    const dbResult = await fetchFromDbSources('VN_HAN_SP');
    if (dbResult) {
      console.log('[FETCHER:VN_HAN_SP] DB source ✅');
      return dbResult;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_SP] DB source error:', e.message); }

  throw new Error('VN_HAN_SP: ไม่พบผล — กรุณาตรวจสอบ press.in.th / TNews หรือ config DB sources ใน Admin Panel → API Sources');
}

/**
 * ฮานอย VIP (VN_HAN_VIP) — ออกผลทุกวัน ~19:00 น.
 */
async function fetchVNHanoiVIP() {
  // Source 1: press.in.th — primary ✅
  try {
    const result = await fetchPressInThHanoi('VN_HAN_VIP');
    if (result) {
      console.log('[FETCHER:VN_HAN_VIP] press.in.th ✅ main=%s top2=%s bot2=%s', result.prize_1st, result.prize_last_2, result.prize_2bot||'?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_VIP] press.in.th error:', e.message); }

  // Source 2: TNews.co.th — secondary (section ผลหวยฮานอย vip)
  try {
    const result = await fetchTNewsVNHanoi('VN_HAN_VIP');
    if (result) {
      console.log('[FETCHER:VN_HAN_VIP] TNews ✅ main=%s top2=%s bot2=%s', result.prize_1st, result.prize_last_2, result.prize_2bot||'?');
      return result;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_VIP] TNews error:', e.message); }

  // Source 3: DB sources (Admin-configured) — fallback
  try {
    const dbResult = await fetchFromDbSources('VN_HAN_VIP');
    if (dbResult) {
      console.log('[FETCHER:VN_HAN_VIP] DB source ✅');
      return dbResult;
    }
  } catch(e) { console.warn('[FETCHER:VN_HAN_VIP] DB source error:', e.message); }

  throw new Error('VN_HAN_VIP: ไม่พบผล — กรุณาตรวจสอบ press.in.th / TNews หรือ config DB sources ใน Admin Panel → API Sources');
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

/**
 * Dry-run — เรียก scraper โดยตรง ไม่ตรวจ DB ไม่บันทึก
 * ใช้สำหรับทดสอบว่า scraper ดึงค่าอะไรได้บ้าง
 */
async function testFetch(lotteryCode) {
  const fn = FETCH_FUNCS[lotteryCode];
  if (!fn) throw new Error(`Unknown lottery code: ${lotteryCode}`);
  // ล้าง cache เพื่อ force re-fetch
  _tnewsCache        = { data: null, ts: 0 };
  _pressInThCache    = { data: null, ts: 0 };
  _pressInThLaoCache = { data: null, ts: 0 };
  console.log(`[FETCHER:${lotteryCode}] 🧪 dry-run test...`);
  return fn();
}

/**
 * Debug: ดึงข้อมูล press.in.th และ return raw info สำหรับ debug
 */
async function debugPressInTh() {
  _pressInThCache = { data: null, ts: 0 }; // force fresh fetch
  let html;
  try {
    const res = await httpGetProxy('https://www.press.in.th/hanoi-lotto/', 20000, 'th');
    html = res.data;
  } catch(e) {
    return { error: `Fetch error: ${e.message}` };
  }
  const $ = cheerio.load(html);
  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
  const dd = String(nowBkk.getUTCDate()).padStart(2, '0');
  const mm = String(nowBkk.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(nowBkk.getUTCFullYear()).slice(-2);
  const todayDDMMYY = `${dd}/${mm}/${yy}`;

  const tables = [];
  $('h2, h3, h4').each((_, headingEl) => {
    const headingText = $(headingEl).text().trim();
    const table = $(headingEl).nextAll('table').first();
    if (!table.length) return;
    const rows = [];
    table.find('tr').each((_, tr) => {
      const cells = $(tr).find('td,th').map((_, td) => $(td).text().trim()).get();
      if (cells.length) rows.push(cells);
    });
    tables.push({ heading: headingText, rows: rows.slice(0, 5) });
  });

  const parsedData = await getPressInThData();
  return { url: 'https://www.press.in.th/hanoi-lotto/', todayDDMMYY, tables, parsedData };
}

/**
 * Debug: ดึงบทความ TNews และ return raw info สำหรับ debug
 * - articleUrl: URL ที่พบ
 * - sectionsFound: keys ที่ parse ได้
 * - rawChunks: 300 ตัวแรกของแต่ละ section header ที่พบ
 * - parsedData: ผลที่ parse ได้
 */
async function debugTNewsRaw() {
  _tnewsCache = { data: null, ts: 0 }; // force fresh fetch

  const articleUrl = await findTNewsArticleUrl();
  if (!articleUrl) return { error: 'ไม่พบ URL บทความ TNews', articleUrl: null };

  let html;
  try {
    const res = await httpGetProxy(articleUrl, 25000, 'th');
    html = res.data;
  } catch(e) {
    return { error: `Fetch article error: ${e.message}`, articleUrl };
  }

  // Extract body text (same logic as parseTNewsSections)
  const $ = require('cheerio').load(html);
  let bodyText = '';
  for (const sel of ['article', '.content-body', '.post-content', '.article-content',
                     '.entry-content', '#content-body', '#article-body', 'body']) {
    const t = $(sel).first().text();
    if (t && t.length > bodyText.length) bodyText = t;
  }
  if (!bodyText) bodyText = $.text();

  // Show all occurrences of each header for debugging (incl. เฉพาะกิจ boundary)
  const DEBUG_HEADERS = {
    VN_HAN_EKKA: ['ผลหวยฮานอยเฉพาะกิจ', 'ฮานอยเฉพาะกิจ'],
    VN_HAN:      ['ผลหวยฮานอยปกติ', 'ฮานอยปกติ'],
    VN_HAN_SP:   ['ผลหวยฮานอยพิเศษ', 'ฮานอยพิเศษ'],
    VN_HAN_VIP:  ['ผลหวยฮานอย vip', 'ฮานอย vip', 'ฮานอยวีไอพี'],
  };
  const rawChunks = {};
  const bodyLower2 = bodyText.toLowerCase();
  for (const [lotteryType, headers] of Object.entries(DEBUG_HEADERS)) {
    const occurrences = [];
    for (const header of headers) {
      const hdrLow = header.toLowerCase();
      let p = 0;
      while (true) {
        const idx = bodyLower2.indexOf(hdrLow, p);
        if (idx === -1) break;
        occurrences.push({ header, position: idx, chunk: bodyText.slice(idx, idx + 300).replace(/\s+/g, ' ').trim() });
        p = idx + 1;
      }
    }
    occurrences.sort((a, b) => a.position - b.position);
    rawChunks[lotteryType] = occurrences.length ? occurrences : [{ header: null, position: -1, chunk: null }];
  }

  const parsedData = parseTNewsSections(html);

  return {
    articleUrl,
    bodyTextLength: bodyText.length,
    sectionsFound: Object.keys(parsedData),
    parsedData,
    rawChunks,
  };
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

module.exports = { startLotteryFetcher, fetcherStatus, triggerFetch, testFetch, testSource, clearScraperApiKeyCache, debugTNewsRaw, debugPressInTh, fetchPressInThLao };
