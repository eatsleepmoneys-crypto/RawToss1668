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

  // ── ลาวพัฒนา (จันทร์–ศุกร์ เท่านั้น — หยุดเสาร์-อาทิตย์) ──────
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'LA_GOV',
      round_code: `LAOS-${compact}`,
      round_name: `ลาวพัฒนา ${dateThai}`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 00:00:00`,
      close_at:   `${dateStr} 20:00:00`,
    });
  }

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
  // รอบเช้า: SET morning session closes 12:30 → ปิดรับ 12:00, ดึงผล 12:30
  // รอบบ่าย: SET afternoon session closes 16:30 → ปิดรับ 16:00, ดึงผล 16:30
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

  // ── หวยหุ้นจีน Shanghai (วันจันทร์–ศุกร์) ──────────────────────
  // Shanghai SSE: เช้า 10:30–11:30 TH, บ่าย 13:00–15:00 TH
  // รอบเช้า: ปิดรับ 11:00, ดึงผล 11:30
  // รอบบ่าย: ปิดรับ 14:00, ดึงผล 14:30
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'CN_STK',
      round_code: `CNSTK-${compact}-1`,
      round_name: `หวยหุ้นจีน ${dateThai} (รอบเช้า)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 09:30:00`,
      close_at:   `${dateStr} 11:00:00`,
    });
    rounds.push({
      code:       'CN_STK',
      round_code: `CNSTK-${compact}-2`,
      round_name: `หวยหุ้นจีน ${dateThai} (รอบบ่าย)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 12:00:00`,
      close_at:   `${dateStr} 14:00:00`,
    });
  }

  // ── หวยหุ้นมาเลย์ KLSE (วันจันทร์–ศุกร์) ───────────────────────
  // KLSE: เปิด 09:00 TH, พัก 12:30–14:30 TH, ปิด 17:00 TH
  // รอบเช้า: ปิดรับ 12:00, ดึงผล 12:30
  // รอบบ่าย: ปิดรับ 16:30, ดึงผล 17:00
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'MY_STK',
      round_code: `MYSTK-${compact}-1`,
      round_name: `หวยหุ้นมาเลย์ ${dateThai} (รอบเช้า)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 10:00:00`,
      close_at:   `${dateStr} 12:00:00`,
    });
    rounds.push({
      code:       'MY_STK',
      round_code: `MYSTK-${compact}-2`,
      round_name: `หวยหุ้นมาเลย์ ${dateThai} (รอบบ่าย)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 14:00:00`,
      close_at:   `${dateStr} 16:30:00`,
    });
  }

  // ── หวยหุ้นสิงคโปร์ STI (วันจันทร์–ศุกร์) ──────────────────────
  // SGX STI: เปิด 09:00 TH, ปิด 17:00 TH (รอบเดียว)
  // ปิดรับ 16:30, ดึงผล 17:15
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'SG_STK',
      round_code: `SGSTK-${compact}-1`,
      round_name: `หวยหุ้นสิงคโปร์ ${dateThai}`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 10:00:00`,
      close_at:   `${dateStr} 16:30:00`,
    });
  }

  // ── หวยหุ้นญี่ปุ่น JPX (วันจันทร์–ศุกร์) ────────────────────────
  // JPX: เปิด 09:30 Tokyo (08:30 TH), ปิด 15:30 Tokyo (14:30 TH)
  // รอบเช้า: ปิดรับ 11:30 TH, รอบบ่าย: ปิดรับ 14:00 TH
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'JP_STK',
      round_code: `JPSTK-${compact}-1`,
      round_name: `หวยหุ้นญี่ปุ่น ${dateThai} (รอบเช้า)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 09:00:00`,
      close_at:   `${dateStr} 11:30:00`,
    });
    rounds.push({
      code:       'JP_STK',
      round_code: `JPSTK-${compact}-2`,
      round_name: `หวยหุ้นญี่ปุ่น ${dateThai} (รอบบ่าย)`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 12:00:00`,
      close_at:   `${dateStr} 14:00:00`,
    });
  }

  // ── หวยหุ้นเกาหลี KRX (วันจันทร์–ศุกร์) ─────────────────────────
  // KRX: เปิด 09:00 Seoul (07:00 TH), ปิด 15:30 Seoul (13:30 TH)
  // รอบเดียว: ปิดรับ 13:00 TH, ดึงผล 13:30 TH
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'KR_STK',
      round_code: `KRSTK-${compact}-1`,
      round_name: `หวยหุ้นเกาหลี ${dateThai}`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 09:00:00`,
      close_at:   `${dateStr} 13:00:00`,
    });
  }

  // ── หวยหุ้นไต้หวัน TAIEX (วันจันทร์–ศุกร์) ──────────────────────
  // TAIEX: เปิด 09:00 Taipei (08:00 TH), ปิด 13:30 Taipei (12:30 TH)
  // รอบเดียว: ปิดรับ 12:00 TH, ดึงผล 12:30 TH
  if (dow >= 1 && dow <= 5) {
    rounds.push({
      code:       'TW_STK',
      round_code: `TWSTK-${compact}-1`,
      round_name: `หวยหุ้นไต้หวัน ${dateThai}`,
      draw_date:  dateStr,
      open_at:    `${dateStr} 09:00:00`,
      close_at:   `${dateStr} 12:00:00`,
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

// ── Auto-fetch ผลหวยจริง (ไม่รวมยี่กี) ──────────────────────────────
//
// Logic:
//   draw_at ≈ close_at + 30 นาที (ทุกประเภท — หวยออกหลังปิดรับ ~30 นาที)
//   fetch_at = draw_at + 15 = close_at + 45 นาที
//
// ทำงานทุก 1 นาที: หางวดที่ close_at + 45 นาที ผ่านไปแล้ว
// แต่ยังไม่มีผลใน lottery_results → trigger fetch ทันที
// ─────────────────────────────────────────────────────────────────

// รอดึง lotteryFetcher แบบ lazy เพื่อหลีกเลี่ยง circular require
let _fetcher = null;
function getLotteryFetcher() {
  return _fetcher || (_fetcher = require('./lotteryFetcher'));
}

// lottery codes ที่ออกผลจริง (ไม่สุ่ม, ไม่ใช่ยี่กี)
const AUTO_FETCH_CODES = new Set(['TH_GOV', 'LA_GOV', 'VN_HAN', 'VN_HAN_SP', 'VN_HAN_VIP']);

// ติดตามจำนวนครั้งที่ retry แต่ละ round  round_id → { count, lastTs }
const _fetchRetry = new Map();

// หวยออกหลัง close_at กี่นาที (ต้องรอก่อนเริ่ม fetch ครั้งแรก)
const DRAW_DELAY_MIN = { TH_GOV: 30, LA_GOV: 30, VN_HAN: 30, VN_HAN_SP: 30, VN_HAN_VIP: 30 };
const MAX_RETRY_MIN  = 480; // หยุด retry หลัง draw_time + 8 ชั่วโมง (ครอบคลุม TNews ที่อาจ publish ช้า)

async function autoFetchResults() {
  const bkk = "DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)";

  // หางวดที่:
  //  1. status='closed'  2. lottery code จริง (ไม่ใช่ยี่กี/หุ้น)
  //  3. draw_time ผ่านไปแล้ว (= close_at + DRAW_DELAY, ใช้ค่าต่ำสุด 30 นาที)
  //  4. ยังไม่มีผลใน lottery_results
  //  5. ไม่เกิน close_at + DRAW_DELAY + MAX_RETRY_MIN (หยุด retry เมื่อเกิน 90 นาทีหลังหวยออก)
  const pending = await query(`
    SELECT lr.id, lt.code, lr.close_at
    FROM   lottery_rounds lr
    JOIN   lottery_types  lt  ON lr.lottery_id = lt.id
    LEFT JOIN lottery_results res ON lr.id = res.round_id
    WHERE  lr.status = 'closed'
      AND  lt.code IN ('TH_GOV','LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP')
      AND  res.id IS NULL
      AND  DATE_ADD(lr.close_at, INTERVAL 30 MINUTE) <= ${bkk}
      AND  DATE_ADD(lr.close_at, INTERVAL ${30 + MAX_RETRY_MIN} MINUTE) >= ${bkk}
    ORDER  BY lr.close_at ASC
    LIMIT  5
  `);

  if (!pending.length) return;

  const now = Date.now();
  for (const row of pending) {
    const rec = _fetchRetry.get(row.id) || { count: 0, lastTs: 0 };

    // รอ 1 นาทีระหว่าง retry (cron ทำงานทุกนาทีอยู่แล้ว แต่ป้องกัน overlap)
    if (now - rec.lastTs < 55 * 1000) continue;

    rec.count++;
    rec.lastTs = now;
    _fetchRetry.set(row.id, rec);

    console.log(`[ROUND_MGR] 🔍 Auto-fetch #${rec.count}: ${row.code} งวด #${row.id}`);

    try {
      const fetcher = getLotteryFetcher();
      await fetcher.triggerFetch(row.code);
      console.log(`[ROUND_MGR] ✅ Auto-fetch สำเร็จ: ${row.code} #${row.id} (ครั้งที่ ${rec.count})`);
      // สำเร็จแล้ว → ล้าง retry counter (round จะไม่ถูก query อีกเพราะมี res.id แล้ว)
      _fetchRetry.delete(row.id);
    } catch (e) {
      console.warn(`[ROUND_MGR] ⚠️  Retry ${rec.count}: ${row.code} #${row.id} — ${e.message}`);
      // ไม่ลบ rec → จะ retry รอบถัดไป (1 นาที)
    }
  }

  // ล้าง cache ของ round_id ที่ไม่มีใน pending แล้ว และค้างนานเกิน 3 ชม.
  const pendingIds = new Set(pending.map(r => r.id));
  for (const [id, rec] of _fetchRetry.entries()) {
    if (!pendingIds.has(id) && now - rec.lastTs > 3 * 60 * 60 * 1000) {
      _fetchRetry.delete(id);
    }
  }
}

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
    // Backfill: fetch ผลงวดที่ถึงเวลาแต่ยังไม่มีผล (เผื่อ server restart)
    autoFetchResults().catch(e =>
      console.error('[ROUND_MGR] backfill autoFetchResults error:', e.message)
    );
  }, 5000); // รอ 5 วิให้ DB connection พร้อม

  // เที่ยงคืน: สร้างงวดของวันถัดไป
  cron.schedule('0 0 * * *', () => {
    console.log('[ROUND_MGR] เที่ยงคืน: สร้างงวดวันใหม่');
    createTodayRounds().catch(e =>
      console.error('[ROUND_MGR] createTodayRounds error:', e.message)
    );
  }, { timezone: TIMEZONE });

  // ทุก 1 นาที: ปิดงวดที่หมดเวลา + ออกผลยี่กีที่ยังค้าง + fetch ผลหวยจริง
  cron.schedule('* * * * *', () => {
    autoManageRounds().catch(e =>
      console.error('[ROUND_MGR] autoManageRounds error:', e.message)
    );
    yeekeeAutoAnnounce().catch(e =>
      console.error('[ROUND_MGR] yeekeeAutoAnnounce error:', e.message)
    );
    autoFetchResults().catch(e =>
      console.error('[ROUND_MGR] autoFetchResults error:', e.message)
    );
  }, { timezone: TIMEZONE });

  console.log('[ROUND_MGR] Crons ลงทะเบียนแล้ว:');
  console.log('  createTodayRounds  → ทุกวันเที่ยงคืน (Asia/Bangkok)');
  console.log('  autoManageRounds   → ทุก 1 นาที');
  console.log('  yeekeeAutoAnnounce → ทุก 1 นาที');
  console.log('  autoFetchResults   → retry ทุก 1 นาที จนกว่าจะได้ผล (หยุดอัตโนมัติหลัง draw+90น)');
}

module.exports = { startRoundManager, createTodayRounds, autoManageRounds, yeekeeAutoAnnounce, autoFetchResults };
