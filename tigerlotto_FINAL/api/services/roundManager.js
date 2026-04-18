/**
 * roundManager.js
 * ─────────────────────────────────────────────────────────────────
 * ระบบจัดการงวดอัตโนมัติสำหรับทุกประเภทหวย
 *
 *  • createTodayRounds()      — สร้างงวดของวันนี้ (ยี่กี 90 งวด + หวยอื่น)
 *  • autoManageRounds()       — open → closed เมื่อ close_at ผ่านไป
 *  • yeekeeAutoAnnounce()     — ออกผลยี่กีอัตโนมัติ (สุ่ม 6 หลัก) + จ่ายรางวัล
 *  • startRoundManager()      — เรียกครั้งเดียวใน server.js หลัง DB พร้อม
 *
 * All times: Asia/Bangkok (UTC+7)
 */

'use strict';

const cron        = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/db');

const TIMEZONE = 'Asia/Bangkok';

// ── Thai month names ──────────────────────────────────────────────
const THAI_MONTHS = [
  '', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

// ── Helpers ───────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

/** วันที่ปัจจุบันตามโซนกรุงเทพ */
function getTodayInfo() {
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const [year, month, day] = dateStr.split('-').map(Number);
  const d   = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay(); // 0=Sun…6=Sat
  return { dateStr, year, month, day, dow, compact: `${year}${pad2(month)}${pad2(day)}` };
}

/** วันถัดไปจาก 'YYYY-MM-DD' */
function nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** 'DD เดือน พ.ศ.' */
function formatDateThai(day, month, year) {
  return `${day} ${THAI_MONTHS[month]} ${year + 543}`;
}

/**
 * กำหนด status เริ่มต้นจาก open_at และ close_at
 *  - nowMs >= closeMs  → 'closed'
 *  - nowMs >= openMs   → 'open'
 *  - else              → 'upcoming'
 */
function determineStatus(openAtStr, closeAtStr) {
  const nowMs   = Date.now();
  const closeMs = new Date(closeAtStr.replace(' ', 'T') + '+07:00').getTime();
  const openMs  = new Date(openAtStr.replace(' ', 'T')  + '+07:00').getTime();
  if (nowMs >= closeMs) return 'closed';
  if (nowMs >= openMs)  return 'open';
  return 'upcoming';
}

// ── กำหนดตารางงวดของวันนี้ ─────────────────────────────────────────

/**
 * คืน array ของ { code, round_code, round_name, draw_date, close_at }
 * code = lottery_types.code ใน DB
 */
function buildRoundsForToday() {
  const { dateStr, year, month, day, dow, compact } = getTodayInfo();
  const tomorrow = nextDateStr(dateStr);
  const dateThai = formatDateThai(day, month, year);
  const rounds   = [];

  // ── หวยรัฐบาลไทย (วันที่ 1 และ 16 ของเดือน) ───────────────────
  if (day === 1 || day === 16) {
    rounds.push({
      code:       'TH_GOV',
      round_code: `GOV-${compact}`,
      round_name: `หวยรัฐบาลไทย ${dateThai}`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 00:00:00`,
      close_at:   `${dateStr} 14:30:00`,
    });
  }

  // ── ลาวพัฒนา (ทุกวัน) ────────────────────────────────────────
  rounds.push({
    code:       'LA_GOV',
    round_code: `LAOS-${compact}`,
    round_name: `ลาวพัฒนา ${dateThai}`,
    draw_date:  dateStr,
    open_at:    `${dateStr} 00:00:00`,
    close_at:   `${dateStr} 20:00:00`,
  });

  // ── ฮานอยปกติ (ทุกวัน ~18:30) ────────────────────────────────
  rounds.push({
    code:       'VN_HAN',
    round_code: `HANOI-${compact}`,
    round_name: `ฮานอยปกติ ${dateThai}`,
    draw_date:  dateStr,
    open_at:    `${dateStr} 00:00:00`,
    close_at:   `${dateStr} 18:00:00`,
  });

  // ── ฮานอยพิเศษ (ทุกวัน ~17:30) ──────────────────────────────
  rounds.push({
    code:       'VN_HAN_SP',
    round_code: `HANOISP-${compact}`,
    round_name: `ฮานอยพิเศษ ${dateThai}`,
    draw_date:  dateStr,
    open_at:    `${dateStr} 00:00:00`,
    close_at:   `${dateStr} 17:00:00`,
  });

  // ── ฮานอย VIP (ทุกวัน ~17:00) ───────────────────────────────
  rounds.push({
    code:       'VN_HAN_VIP',
    round_code: `HANOIVIP-${compact}`,
    round_name: `ฮานอย VIP ${dateThai}`,
    draw_date:  dateStr,
    open_at:    `${dateStr} 00:00:00`,
    close_at:   `${dateStr} 16:30:00`,
  });

  // ── หวยหุ้นไทย SET (วันจันทร์–ศุกร์) ─────────────────────────
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'TH_STK',
      round_code: `THSTK-${compact}-1`,
      round_name: `หวยหุ้นไทย ${dateThai} (รอบเช้า)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 09:30:00`,
      close_at:   `${dateStr} 12:00:00`,
    });
    rounds.push({
      code:       'TH_STK',
      round_code: `THSTK-${compact}-2`,
      round_name: `หวยหุ้นไทย ${dateThai} (รอบบ่าย)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 13:00:00`,
      close_at:   `${dateStr} 16:00:00`,
    });
  }

  // ── หวยยี่กี 90 งวด (ทุก 16 นาที ตลอด 24 ชม.) ────────────────
  // งวด n: open_at = (n-1)×16 นาที, close_at = n×16−5 นาที จากเที่ยงคืน
  for (let n = 1; n <= 90; n++) {
    const openMins  = (n - 1) * 16;
    const closeMins = n * 16 - 5;

    const openDaysAhead  = openMins  >= 1440 ? 1 : 0;
    const closeDaysAhead = closeMins >= 1440 ? 1 : 0;

    const openDate  = openDaysAhead  ? tomorrow : dateStr;
    const closeDate = closeDaysAhead ? tomorrow : dateStr;

    const openTime  = `${pad2(Math.floor((openMins  % 1440) / 60))}:${pad2((openMins  % 1440) % 60)}:00`;
    const closeTime = `${pad2(Math.floor((closeMins % 1440) / 60))}:${pad2((closeMins % 1440) % 60)}:00`;

    rounds.push({
      code:       'YEEKEE',
      round_code: `YEEKEE-${compact}-${pad2(n)}`,
      round_name: `หวยยี่กี ${dateThai} งวดที่ ${pad2(n)}`,
      draw_date:  dateStr,
      open_at:    `${openDate} ${openTime}`,
      close_at:   `${closeDate} ${closeTime}`,
    });
  }

  return { dateStr, rounds };
}

// ── สร้างงวดของวันนี้ ─────────────────────────────────────────────

async function createTodayRounds() {
  const { dateStr, rounds } = buildRoundsForToday();
  console.log(`[ROUND_MGR] createTodayRounds: ${dateStr} (${rounds.length} schedules)`);

  // สร้าง map: lottery_types.code → id (เฉพาะที่ status='open')
  const types  = await query("SELECT id, code FROM lottery_types WHERE status='open'");
  const typeMap = Object.fromEntries(types.map(t => [t.code, t.id]));

  let created = 0;
  for (const r of rounds) {
    const lottery_id = typeMap[r.code];
    if (lottery_id === undefined) continue; // ประเภทหวยนี้ปิดหรือไม่มีใน DB

    // ตรวจว่า round_code นี้มีอยู่แล้วหรือไม่
    const existing = await query(
      'SELECT id FROM lottery_rounds WHERE round_code=? LIMIT 1', [r.round_code]
    );
    if (existing.length > 0) continue;

    const status = determineStatus(r.open_at, r.close_at);

    await query(
      `INSERT INTO lottery_rounds
         (uuid, lottery_id, round_code, round_name, draw_date, open_at, close_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), lottery_id, r.round_code, r.round_name, r.draw_date, r.open_at, r.close_at, status]
    );
    created++;
  }

  if (created > 0)
    console.log(`[ROUND_MGR] สร้าง ${created} งวดใหม่สำหรับวันที่ ${dateStr}`);
  else
    console.log(`[ROUND_MGR] งวดทั้งหมดของวันที่ ${dateStr} มีอยู่แล้ว`);
}

// ── Auto-open / Auto-close ────────────────────────────────────────

async function autoManageRounds() {
  // open_at / close_at are stored as Bangkok-time strings (UTC+7).
  // Use DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR) to get "Bangkok now"
  // without depending on the MySQL session time_zone variable.
  const bkk = "DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)";

  // upcoming → open เมื่อถึงเวลา open_at
  const opened = await query(
    `UPDATE lottery_rounds SET status='open' WHERE status='upcoming' AND open_at IS NOT NULL AND open_at <= ${bkk}`
  );
  if (opened.affectedRows > 0)
    console.log(`[ROUND_MGR] Auto-opened ${opened.affectedRows} งวด`);

  // open → closed เมื่อ close_at ผ่าน
  const closed = await query(
    `UPDATE lottery_rounds SET status='closed' WHERE status='open' AND close_at <= ${bkk}`
  );
  if (closed.affectedRows > 0)
    console.log(`[ROUND_MGR] Auto-closed ${closed.affectedRows} งวด`);
}

// ── ออกผลยี่กีอัตโนมัติ ──────────────────────────────────────────

/** สุ่มผลยี่กี: รางวัลที่ 1 (6 หลัก) */
function generateYeeKeeResult() {
  const prize_1st   = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  const prize_last_2 = prize_1st.slice(-2);
  return { prize_1st, prize_last_2 };
}

/**
 * ออกผลและจ่ายรางวัลสำหรับงวดยี่กีที่ปิดรับแล้ว
 * ทำงานทุก 1 นาที — ประมวลผลได้สูงสุด 5 งวดต่อรอบ
 */
async function yeekeeAutoAnnounce() {
  // หา YEEKEE lottery_id
  const ltRows = await query("SELECT id FROM lottery_types WHERE code='YEEKEE' LIMIT 1");
  if (!ltRows.length) return;
  const typeId = ltRows[0].id;

  // หางวดที่ปิดรับแต่ยังไม่ออกผล (เรียงตาม close_at เก่าก่อน)
  const rounds = await query(`
    SELECT lr.id
    FROM lottery_rounds lr
    LEFT JOIN lottery_results res ON lr.id = res.round_id
    WHERE lr.lottery_id = ?
      AND lr.status = 'closed'
      AND res.id IS NULL
    ORDER BY lr.close_at ASC
    LIMIT 5
  `, [typeId]);

  for (const round of rounds) {
    await announceYeeKeeRound(round.id, typeId);
  }
}

/** ออกผล 1 งวด + จ่ายเงินผู้ถูก (Atomic transaction) */
async function announceYeeKeeRound(round_id, typeId) {
  const { prize_1st, prize_last_2 } = generateYeeKeeResult();

  try {
    await transaction(async (conn) => {
      // 1. Insert ผลรางวัล
      await conn.execute(
        `INSERT INTO lottery_results
           (round_id, prize_1st, prize_last_2, announced_at)
         VALUES (?, ?, ?, NOW())`,
        [round_id, prize_1st, prize_last_2]
      );

      // 2. อัพเดท status งวด → announced
      await conn.execute(
        "UPDATE lottery_rounds SET status='announced' WHERE id=?",
        [round_id]
      );

      // 3. ดึง rates ของยี่กี
      const [[lt]] = await conn.execute(
        `SELECT rate_3top, rate_3tod, rate_2top, rate_2bot, rate_run_top, rate_run_bot
         FROM lottery_types WHERE id=?`,
        [typeId]
      );
      if (!lt) return;

      // 4. ดึงทุก bet ของงวดนี้ที่ยังรอผล
      const [bets] = await conn.execute(
        "SELECT * FROM bets WHERE round_id=? AND status='waiting'",
        [round_id]
      );

      // 5. ตรวจผลและจ่ายรางวัล
      for (const bet of bets) {
        let won = false;
        let winAmt = 0;
        const n = bet.number;

        if (bet.bet_type === '3top' && prize_1st.slice(-3) === n) {
          won = true; winAmt = bet.amount * lt.rate_3top;
        } else if (bet.bet_type === '3tod') {
          const sorted   = n.split('').sort().join('');
          const p1sorted = prize_1st.slice(-3).split('').sort().join('');
          if (sorted === p1sorted) { won = true; winAmt = bet.amount * lt.rate_3tod; }
        } else if (bet.bet_type === '2top' && prize_last_2 === n) {
          won = true; winAmt = bet.amount * lt.rate_2top;
        } else if (bet.bet_type === '2bot' && prize_last_2 === n) {
          won = true; winAmt = bet.amount * lt.rate_2bot;
        } else if (bet.bet_type === 'run_top' && prize_1st.includes(n)) {
          won = true; winAmt = bet.amount * lt.rate_run_top;
        } else if (bet.bet_type === 'run_bot' && prize_last_2.includes(n)) {
          won = true; winAmt = bet.amount * lt.rate_run_bot;
        }

        const status = won ? 'win' : 'lose';
        await conn.execute(
          'UPDATE bets SET status=?, win_amount=? WHERE id=?',
          [status, winAmt, bet.id]
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
             `ถูกรางวัลยี่กี: ${bet.number} (${bet.bet_type}) งวด #${round_id}`]
          );
          await conn.execute(
            'INSERT INTO notifications (member_id, title, body, type) VALUES (?, ?, ?, ?)',
            [bet.member_id,
             '🎉 ถูกรางวัลยี่กี!',
             `เลข ${bet.number} ถูก! ได้รับเงิน ฿${Number(winAmt).toLocaleString()}`,
             'win']
          );
        }
      }

      // 6. อัพเดท total_win ของงวด
      const [[winSum]] = await conn.execute(
        'SELECT COALESCE(SUM(win_amount),0) s FROM bets WHERE round_id=? AND status="win"',
        [round_id]
      );
      await conn.execute(
        'UPDATE lottery_rounds SET total_win=? WHERE id=?',
        [winSum.s, round_id]
      );
    });

    console.log(`[ROUND_MGR] ✅ ยี่กีงวด #${round_id} ผล: ${prize_1st} (ท้าย2: ${prize_last_2})`);
  } catch (e) {
    console.error(`[ROUND_MGR] ❌ announceYeeKeeRound #${round_id} error:`, e.message);
  }
}

// ── เพิ่ม API route สำหรับดูสถานะงวดยี่กีวันนี้ (optional) ────────

// ── Start ─────────────────────────────────────────────────────────

function startRoundManager() {
  console.log('[ROUND_MGR] เริ่ม Round Manager (tz: Asia/Bangkok)...');

  // สร้างงวดทันทีเมื่อ server เริ่ม
  createTodayRounds().catch(e =>
    console.error('[ROUND_MGR] createTodayRounds error:', e.message)
  );

  // Backfill: ปิดงวดที่ค้างอยู่ทันทีหลัง server เริ่ม
  // (เผื่อ server หยุดไประหว่างวันและมีงวดที่ผ่านเวลาไปแล้ว)
  setTimeout(() => {
    autoManageRounds().catch(e =>
      console.error('[ROUND_MGR] backfill autoManageRounds error:', e.message)
    );
    yeekeeAutoAnnounce().catch(e =>
      console.error('[ROUND_MGR] backfill yeekeeAutoAnnounce error:', e.message)
    );
  }, 5000); // รอ 5 วิให้ DB connection พร้อม

  // เที่ยงคืน: สร้างงวดของวันถัดไป
  cron.schedule('0 0 * * *', () => {
    console.log('[ROUND_MGR] เที่ยงคืน: สร้างงวดวันใหม่');
    createTodayRounds().catch(e =>
      console.error('[ROUND_MGR] createTodayRounds error:', e.message)
    );
  }, { timezone: TIMEZONE });

  // ทุก 1 นาที: ปิดงวดที่หมดเวลา + ออกผลยี่กีที่ยังค้าง
  cron.schedule('* * * * *', () => {
    autoManageRounds().catch(e =>
      console.error('[ROUND_MGR] autoManageRounds error:', e.message)
    );
    yeekeeAutoAnnounce().catch(e =>
      console.error('[ROUND_MGR] yeekeeAutoAnnounce error:', e.message)
    );
  }, { timezone: TIMEZONE });

  console.log('[ROUND_MGR] Crons ลงทะเบียนแล้ว:');
  console.log('  createTodayRounds  → ทุกวันเที่ยงคืน (Asia/Bangkok)');
  console.log('  autoManageRounds   → ทุก 1 นาที');
  console.log('  yeekeeAutoAnnounce → ทุก 1 นาที');
}

module.exports = { startRoundManager, createTodayRounds, autoManageRounds, yeekeeAutoAnnounce };
