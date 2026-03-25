/**
 * roundManager.js
 * Automatic management of lottery_rounds:
 *   - Creates all rounds for the current day at server start and midnight
 *   - Auto-opens rounds (upcoming → open) and auto-closes (open → closed)
 * All times: Asia/Bangkok (UTC+7)
 */

'use strict';

const cron = require('node-cron');
const { query, queryOne } = require('../config/db');

const TIMEZONE = 'Asia/Bangkok';

const THAI_MONTHS = [
  '', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

// ── Helpers ────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

/** 'DD เดือน พ.ศ.' Thai date string */
function formatDateThai(day, month, year) {
  return `${day} ${THAI_MONTHS[month]} ${year + 543}`;
}

/** Returns today's date in Bangkok as { dateStr:'YYYY-MM-DD', year, month, day, dow, compact:'YYYYMMDD' } */
function getTodayInfo() {
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const [year, month, day] = dateStr.split('-').map(Number);
  // Use UTC Date at noon to derive day-of-week (avoids DST ambiguity)
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  return { dateStr, year, month, day, dow, compact: `${year}${pad2(month)}${pad2(day)}` };
}

/** Next calendar day from a 'YYYY-MM-DD' string */
function nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/** Convert total minutes (may exceed 1440) → { date, timeStr } */
function resolveTime(baseDateStr, totalMins, overflowDateStr) {
  const date    = totalMins >= 1440 ? overflowDateStr : baseDateStr;
  const mins    = totalMins % 1440;
  const timeStr = `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}:00`;
  return { date, timeStr };
}

/**
 * Determine initial status for a new round by comparing open_at / close_at
 * against the current UTC timestamp (DB pool is +07:00 so DATETIME strings
 * represent Bangkok time; we parse them with explicit +07:00 offset).
 */
function determineStatus(openAtStr, closeAtStr) {
  const nowMs   = Date.now();
  const openMs  = new Date(openAtStr.replace(' ', 'T') + '+07:00').getTime();
  const closeMs = new Date(closeAtStr.replace(' ', 'T') + '+07:00').getTime();
  if (nowMs >= closeMs) return 'closed';
  if (nowMs >= openMs)  return 'open';
  return 'upcoming';
}

// ── Round definitions ──────────────────────────────────────────

function buildRoundsForToday() {
  const { dateStr, year, month, day, dow, compact } = getTodayInfo();
  const tomorrow = nextDateStr(dateStr);
  const dateThai = formatDateThai(day, month, year);
  const rounds   = [];

  // ── GOV (1st & 16th of month) ─────────────────────────────
  if (day === 1 || day === 16) {
    rounds.push({
      code:       'gov',
      round_code: `GOV-${compact}`,
      round_name: `หวยรัฐบาลไทย ${dateThai}`,
      open_at:    `${dateStr} 00:00:00`,
      close_at:   `${dateStr} 14:30:00`,
    });
  }

  // ── LAOS (daily) ──────────────────────────────────────────
  rounds.push({
    code:       'laos',
    round_code: `LAOS-${compact}`,
    round_name: `หวยลาว ${dateThai}`,
    open_at:    `${dateStr} 00:00:00`,
    close_at:   `${dateStr} 20:00:00`,
  });

  // ── HANOI variants (daily) ────────────────────────────────
  for (const [code, prefix, name, close] of [
    ['hanoi',         'HANOI',    'หวยฮานอย',      '18:00:00'],
    ['hanoi_vip',     'HANOIVIP', 'หวยฮานอย VIP',  '17:30:00'],
    ['hanoi_special', 'HANOISP',  'หวยฮานอยพิเศษ', '17:00:00'],
  ]) {
    rounds.push({
      code,
      round_code: `${prefix}-${compact}`,
      round_name: `${name} ${dateThai}`,
      open_at:    `${dateStr} 00:00:00`,
      close_at:   `${dateStr} ${close}`,
    });
  }

  // ── SET (weekdays Mon–Fri only, 2 rounds) ─────────────────
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'set',
      round_code: `SET-${compact}-1`,
      round_name: `หวย SET ${dateThai} (รอบเช้า)`,
      open_at:    `${dateStr} 00:00:00`,
      close_at:   `${dateStr} 12:00:00`,
    });
    rounds.push({
      code:       'set',
      round_code: `SET-${compact}-2`,
      round_name: `หวย SET ${dateThai} (รอบบ่าย)`,
      open_at:    `${dateStr} 12:30:00`,
      close_at:   `${dateStr} 16:00:00`,
    });
  }

  // ── YEEKEE (90 rounds, every 16 min, starting 00:16) ──────
  // Round n: result_at = n×16 min from midnight, close_at = result_at − 5 min
  // open_at = previous result_at (or 00:00 for round 1)
  for (let n = 1; n <= 90; n++) {
    const resultMins = n * 16;   // minutes from midnight (round 90 = 1440 = next 00:00)
    const closeMins  = resultMins - 5;
    const openMins   = (n - 1) * 16; // previous result_at; 0 for round 1

    const { date: openDate, timeStr: openTime }   = resolveTime(dateStr, openMins,  tomorrow);
    const { date: closeDate, timeStr: closeTime } = resolveTime(dateStr, closeMins, tomorrow);

    rounds.push({
      code:       'yeekee',
      round_code: `YEEKEE-${compact}-${pad2(n)}`,
      round_name: `หวยยี่กี ${dateThai} งวดที่ ${pad2(n)}`,
      open_at:    `${openDate} ${openTime}`,
      close_at:   `${closeDate} ${closeTime}`,
    });
  }

  return { dateStr, rounds };
}

// ── Main functions ─────────────────────────────────────────────

/**
 * createTodayRounds()
 * Called at server start and every midnight.
 * Inserts rounds that don't yet exist in lottery_rounds.
 */
async function createTodayRounds() {
  const { dateStr, rounds } = buildRoundsForToday();
  console.log(`[ROUND_MGR] createTodayRounds: ${dateStr} (${rounds.length} schedules)`);

  // Fetch active lottery types
  const types = await query('SELECT id, code FROM lottery_types WHERE is_active=1');
  const typeMap = Object.fromEntries(types.map(t => [t.code, t.id]));

  let created = 0;
  for (const r of rounds) {
    const typeId = typeMap[r.code];
    if (typeId === undefined) continue; // lottery type not active / not in DB

    const exists = await queryOne(
      'SELECT id FROM lottery_rounds WHERE round_code=?',
      [r.round_code]
    );
    if (exists) continue;

    const status = determineStatus(r.open_at, r.close_at);

    await query(
      `INSERT INTO lottery_rounds
         (lottery_type_id, round_code, round_name, open_at, close_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [typeId, r.round_code, r.round_name, r.open_at, r.close_at, status]
    );
    created++;
    console.log(`[ROUND_MGR] Created: ${r.round_code} (${status})`);
  }

  if (created === 0) {
    console.log(`[ROUND_MGR] All rounds for ${dateStr} already exist.`);
  } else {
    console.log(`[ROUND_MGR] Created ${created} new round(s) for ${dateStr}.`);
  }
}

/**
 * autoCloseRounds()
 * Runs every minute via cron.
 *   upcoming → open  when open_at  <= NOW()
 *   open     → closed when close_at <= NOW()
 */
async function autoCloseRounds() {
  const opened = await query(
    `UPDATE lottery_rounds SET status='open'
     WHERE status='upcoming' AND open_at <= NOW()`
  );
  if (opened.affectedRows > 0)
    console.log(`[ROUND_MGR] Auto-opened ${opened.affectedRows} round(s)`);

  const closed = await query(
    `UPDATE lottery_rounds SET status='closed'
     WHERE status='open' AND close_at <= NOW()`
  );
  if (closed.affectedRows > 0)
    console.log(`[ROUND_MGR] Auto-closed ${closed.affectedRows} round(s)`);
}

/**
 * startRoundManager()
 * Call once in server.js after DB is ready.
 */
function startRoundManager() {
  console.log('[ROUND_MGR] Starting round manager (tz: Asia/Bangkok)...');

  // Create today's rounds immediately on start
  createTodayRounds().catch(err =>
    console.error('[ROUND_MGR] createTodayRounds error:', err.message)
  );

  // Re-run at midnight Bangkok time to create next day's rounds
  cron.schedule('0 0 * * *', () => {
    console.log('[ROUND_MGR] Midnight cron: creating new-day rounds');
    createTodayRounds().catch(err =>
      console.error('[ROUND_MGR] createTodayRounds error:', err.message)
    );
  }, { timezone: TIMEZONE });

  // Auto-open and auto-close rounds every minute
  cron.schedule('* * * * *', () => {
    autoCloseRounds().catch(err =>
      console.error('[ROUND_MGR] autoCloseRounds error:', err.message)
    );
  }, { timezone: TIMEZONE });

  console.log('[ROUND_MGR] Schedules registered:');
  console.log('  createTodayRounds → daily @ 00:00 Asia/Bangkok');
  console.log('  autoCloseRounds   → every minute');
}

module.exports = { startRoundManager };
