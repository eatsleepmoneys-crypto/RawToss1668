/**
 * agent.js — Agent Portal API
 * GET  /api/agent/dashboard       — สถิติภาพรวม
 * GET  /api/agent/members         — รายชื่อสมาชิกภายใต้เอเยนต์
 * GET  /api/agent/commissions     — ประวัติค่าคอมมิชชั่น
 * GET  /api/agent/affiliate       — ข้อมูล Affiliate link
 * POST /api/agent/affiliate/regen — สร้าง aff_code ใหม่
 * GET  /api/agent/aff/:code       — public: ดึงชื่อ Agent จาก aff_code (ไม่ต้อง auth)
 */

'use strict';

const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/db');
const { authAgent } = require('../middleware/auth');

// ── BANK LIST ───────────────────────────────────────────────────────
const BANKS = {
  'SCB':'ไทยพาณิชย์','KTB':'กรุงไทย','BBL':'กรุงเทพ','BAY':'กรุงศรี',
  'KBANK':'กสิกรไทย','TMB':'ทีทีบี','GSB':'ออมสิน','BAAC':'ธ.ก.ส.',
  'KKP':'เกียรตินาคิน','CIMB':'ซีไอเอ็มบี','UOB':'ยูโอบี',
};

// ── VALID BET NUM LENGTHS ───────────────────────────────────────────
const BET_NUM_LEN = { '3top':3, '3tod':3, '2top':2, '2bot':2, 'run_top':1, 'run_bot':1 };

// ── Helper: สร้าง aff_code แบบ AGT-XXXXXX ──────────────────────
function genAffCode(agentId) {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AGT${String(agentId).padStart(3,'0')}${rand}`;
}

async function ensureAffCode(agentId) {
  const [ag] = await query('SELECT aff_code FROM agents WHERE id=?', [agentId]);
  if (ag?.aff_code) return ag.aff_code;
  // สร้างใหม่
  let code, ok = false;
  for (let i = 0; i < 10 && !ok; i++) {
    code = genAffCode(agentId);
    try {
      await query('UPDATE agents SET aff_code=? WHERE id=?', [code, agentId]);
      ok = true;
    } catch (_) { /* ซ้ำ ลองใหม่ */ }
  }
  return code;
}

// ── GET /api/agent/aff/:code — public: resolve aff_code → agent name ──
router.get('/aff/:code', async (req, res) => {
  const [ag] = await query(
    'SELECT id, name FROM agents WHERE aff_code=? AND status="active"', [req.params.code]
  );
  if (!ag) return res.status(404).json({ success: false, message: 'ลิ้งไม่ถูกต้อง' });
  res.json({ success: true, data: { id: ag.id, name: ag.name } });
});

// ── GET /api/agent/affiliate ──────────────────────────────────────
router.get('/affiliate', authAgent, async (req, res) => {
  const code = await ensureAffCode(req.agent.id);
  res.json({ success: true, data: { aff_code: code } });
});

// ── POST /api/agent/affiliate/regen — สร้างลิ้งใหม่ ─────────────
router.post('/affiliate/regen', authAgent, async (req, res) => {
  let code, ok = false;
  for (let i = 0; i < 10 && !ok; i++) {
    code = genAffCode(req.agent.id);
    try {
      await query('UPDATE agents SET aff_code=? WHERE id=?', [code, req.agent.id]);
      ok = true;
    } catch (_) {}
  }
  res.json({ success: true, data: { aff_code: code }, message: 'สร้างลิ้งใหม่สำเร็จ' });
});

// ── GET /api/agent/dashboard ──────────────────────────────────────
router.get('/dashboard', authAgent, async (req, res) => {
  const agentId = req.agent.id;

  // จำนวนสมาชิก
  const [memberCount] = await query(
    'SELECT COUNT(*) AS cnt FROM members WHERE agent_id = ?', [agentId]
  );

  // สมาชิกใหม่วันนี้
  const [newToday] = await query(
    'SELECT COUNT(*) AS cnt FROM members WHERE agent_id = ? AND DATE(created_at) = CURDATE()', [agentId]
  );

  // ยอดเดิมพันรวม (ของสมาชิกภายใต้เอเยนต์)
  const [betStats] = await query(`
    SELECT
      COUNT(*)               AS bet_count,
      COALESCE(SUM(b.amount),0) AS bet_total
    FROM bets b
    JOIN members m ON b.member_id = m.id
    WHERE m.agent_id = ?
      AND DATE(b.created_at) = CURDATE()
  `, [agentId]);

  // ค่าคอมมิชชั่นเดือนนี้ (คำนวณจาก bet amount × commission_rate)
  const rate = req.agent.commission_rate / 100;
  const [monthBet] = await query(`
    SELECT COALESCE(SUM(b.amount),0) AS total
    FROM bets b
    JOIN members m ON b.member_id = m.id
    WHERE m.agent_id = ?
      AND YEAR(b.created_at)  = YEAR(NOW())
      AND MONTH(b.created_at) = MONTH(NOW())
  `, [agentId]);

  const commissionThisMonth = parseFloat(monthBet.total) * rate;

  res.json({
    success: true,
    data: {
      balance:              parseFloat(req.agent.balance),
      total_commission:     parseFloat(req.agent.total_commission),
      commission_rate:      req.agent.commission_rate,
      member_count:         memberCount.cnt,
      new_members_today:    newToday.cnt,
      bets_today:           betStats.bet_count,
      bet_total_today:      parseFloat(betStats.bet_total),
      commission_this_month: commissionThisMonth,
    },
  });
});

// ── GET /api/agent/members ────────────────────────────────────────
router.get('/members', authAgent, async (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const agentId = req.agent.id;

  const searchWhere = search ? 'AND (m.name LIKE ? OR m.phone LIKE ?)' : '';
  const params = search
    ? [agentId, `%${search}%`, `%${search}%`, Number(limit), offset]
    : [agentId, Number(limit), offset];

  const rows = await query(`
    SELECT
      m.id, m.uuid, m.name, m.phone, m.balance,
      m.status, m.level, m.created_at,
      COALESCE(SUM(b.amount),0) AS total_bet,
      COUNT(b.id)               AS bet_count
    FROM members m
    LEFT JOIN bets b ON b.member_id = m.id
    WHERE m.agent_id = ? ${searchWhere}
    GROUP BY m.id
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `, params);

  const [total] = await query(
    `SELECT COUNT(*) AS cnt FROM members WHERE agent_id = ? ${searchWhere}`,
    search ? [agentId, `%${search}%`, `%${search}%`] : [agentId]
  );

  res.json({ success: true, data: rows, total: total.cnt, page: Number(page), limit: Number(limit) });
});

// ── GET /api/agent/commissions ────────────────────────────────────
// ประวัติค่าคอมฯ รายวัน (30 วันล่าสุด)
router.get('/commissions', authAgent, async (req, res) => {
  const agentId = req.agent.id;
  const rate    = req.agent.commission_rate / 100;

  const rows = await query(`
    SELECT
      DATE(b.created_at)        AS date,
      COUNT(b.id)               AS bet_count,
      COALESCE(SUM(b.amount),0) AS bet_total
    FROM bets b
    JOIN members m ON b.member_id = m.id
    WHERE m.agent_id = ?
      AND b.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    GROUP BY DATE(b.created_at)
    ORDER BY date DESC
    LIMIT 30
  `, [agentId]);

  const data = rows.map(r => ({
    date:       r.date,
    bet_count:  r.bet_count,
    bet_total:  parseFloat(r.bet_total),
    commission: parseFloat(r.bet_total) * rate,
  }));

  res.json({ success: true, data });
});

// ═══════════════════════════════════════════════════════════════════
//  WALLET — กระเป๋าเงินเอเยนต์
// ═══════════════════════════════════════════════════════════════════

// ── GET /api/agent/wallet ─────────────────────────────────────────
router.get('/wallet', authAgent, async (req, res) => {
  const agentId = req.agent.id;
  const [agent] = await query('SELECT balance FROM agents WHERE id=?', [agentId]);

  const [pendDep] = await query(
    'SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) total FROM agent_deposits WHERE agent_id=? AND status="pending"',
    [agentId]
  ).catch(() => [{ cnt: 0, total: 0 }]);

  const [pendWd] = await query(
    'SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) total FROM agent_withdrawals WHERE agent_id=? AND status="pending"',
    [agentId]
  ).catch(() => [{ cnt: 0, total: 0 }]);

  const txns = await query(
    'SELECT * FROM agent_transactions WHERE agent_id=? ORDER BY id DESC LIMIT 10',
    [agentId]
  ).catch(() => []);

  res.json({
    success: true,
    data: {
      balance:         parseFloat(agent.balance),
      pending_deposit: { count: Number(pendDep.cnt),  total: parseFloat(pendDep.total) },
      pending_withdraw:{ count: Number(pendWd.cnt),   total: parseFloat(pendWd.total) },
      recent_txns:     txns,
    }
  });
});

// ── GET /api/agent/wallet/transactions ────────────────────────────
router.get('/wallet/transactions', authAgent, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const rows = await query(
    'SELECT * FROM agent_transactions WHERE agent_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
    [req.agent.id, Number(limit), offset]
  ).catch(() => []);
  const [total] = await query(
    'SELECT COUNT(*) cnt FROM agent_transactions WHERE agent_id=?',
    [req.agent.id]
  ).catch(() => [{ cnt: 0 }]);
  res.json({ success: true, data: rows, total: Number(total.cnt), page: Number(page) });
});

// ── POST /api/agent/wallet/deposit ────────────────────────────────
router.post('/wallet/deposit', authAgent, async (req, res) => {
  const { amount, bank_code, note } = req.body;
  const amt = Number(amount);
  if (!amt || amt < 100) return res.status(400).json({ success: false, message: 'จำนวนเงินขั้นต่ำ 100 บาท' });

  await query(
    'INSERT INTO agent_deposits (uuid, agent_id, amount, bank_code, note, status) VALUES (?,?,?,?,?,?)',
    [uuidv4(), req.agent.id, amt, bank_code || null, note || null, 'pending']
  );
  res.json({ success: true, message: 'ส่งคำขอฝากเงินสำเร็จ รอ Admin อนุมัติ' });
});

// ── GET /api/agent/wallet/deposits ────────────────────────────────
router.get('/wallet/deposits', authAgent, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const rows = await query(
    'SELECT * FROM agent_deposits WHERE agent_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
    [req.agent.id, Number(limit), offset]
  ).catch(() => []);
  const [total] = await query(
    'SELECT COUNT(*) cnt FROM agent_deposits WHERE agent_id=?', [req.agent.id]
  ).catch(() => [{ cnt: 0 }]);
  res.json({ success: true, data: rows, total: Number(total.cnt) });
});

// ── POST /api/agent/wallet/withdraw ───────────────────────────────
router.post('/wallet/withdraw', authAgent, async (req, res) => {
  const { amount, bank_code, bank_account, bank_name, note } = req.body;
  const amt = Number(amount);
  if (!amt || amt < 100) return res.status(400).json({ success: false, message: 'จำนวนเงินขั้นต่ำ 100 บาท' });
  if (!bank_code || !bank_account || !bank_name)
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลธนาคารให้ครบ' });

  const [agent] = await query('SELECT balance FROM agents WHERE id=?', [req.agent.id]);
  if (parseFloat(agent.balance) < amt)
    return res.status(400).json({ success: false, message: 'ยอดเงินไม่เพียงพอ' });

  await query(
    'INSERT INTO agent_withdrawals (uuid, agent_id, amount, bank_code, bank_account, bank_name, note, status) VALUES (?,?,?,?,?,?,?,?)',
    [uuidv4(), req.agent.id, amt, bank_code, bank_account, bank_name, note || null, 'pending']
  );
  res.json({ success: true, message: 'ส่งคำขอถอนเงินสำเร็จ รอ Admin อนุมัติ' });
});

// ── GET /api/agent/wallet/withdrawals ─────────────────────────────
router.get('/wallet/withdrawals', authAgent, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const rows = await query(
    'SELECT * FROM agent_withdrawals WHERE agent_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
    [req.agent.id, Number(limit), offset]
  ).catch(() => []);
  const [total] = await query(
    'SELECT COUNT(*) cnt FROM agent_withdrawals WHERE agent_id=?', [req.agent.id]
  ).catch(() => [{ cnt: 0 }]);
  res.json({ success: true, data: rows, total: Number(total.cnt) });
});

// ═══════════════════════════════════════════════════════════════════
//  LOTTERY — ซื้อหวย
// ═══════════════════════════════════════════════════════════════════

// ── GET /api/agent/lottery/rounds ─────────────────────────────────
router.get('/lottery/rounds', authAgent, async (req, res) => {
  await query(
    `UPDATE lottery_rounds SET status='open'
     WHERE status='upcoming' AND open_at IS NOT NULL
       AND open_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)`
  ).catch(() => {});
  const rows = await query(
    `SELECT lr.id, lr.uuid, lr.round_name, lr.draw_date, lr.open_at, lr.close_at, lr.status,
            lt.id AS lottery_id, lt.name AS lottery_name, lt.flag, lt.code,
            lt.rate_3top, lt.rate_3tod, lt.rate_2top, lt.rate_2bot, lt.rate_run_top, lt.rate_run_bot,
            lt.min_bet, lt.max_bet
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id = lt.id
     WHERE lr.status IN ('open','upcoming') AND lt.status = 'open'
       AND lr.close_at > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)
     ORDER BY lr.status='open' DESC, lr.close_at ASC`
  );
  res.json({ success: true, data: rows });
});

// ── POST /api/agent/lottery/bet ────────────────────────────────────
router.post('/lottery/bet', authAgent, async (req, res) => {
  const { round_id, bet_type, number, amount } = req.body;
  if (!round_id || !bet_type || !number || !amount)
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });

  const validTypes = Object.keys(BET_NUM_LEN);
  if (!validTypes.includes(bet_type))
    return res.status(400).json({ success: false, message: 'ประเภทการแทงไม่ถูกต้อง' });

  const numStr = String(number).trim();
  if (!/^\d+$/.test(numStr) || numStr.length !== BET_NUM_LEN[bet_type])
    return res.status(400).json({ success: false, message: `เลข${bet_type}ต้องเป็น ${BET_NUM_LEN[bet_type]} หลัก` });

  const betAmount = parseFloat(amount);
  if (isNaN(betAmount) || betAmount <= 0)
    return res.status(400).json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });

  // Load round + rates
  const [round] = await query(
    `SELECT lr.*, lt.min_bet, lt.max_bet, lt.code AS lottery_code,
            lt.rate_3top, lt.rate_3tod, lt.rate_2top, lt.rate_2bot, lt.rate_run_top, lt.rate_run_bot
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id = lt.id
     WHERE lr.id = ? AND lr.status = 'open'
       AND lr.close_at > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)`,
    [round_id]
  );
  if (!round) return res.status(400).json({ success: false, message: 'งวดนี้ปิดรับแล้วหรือไม่พบ' });

  if (betAmount < parseFloat(round.min_bet))
    return res.status(400).json({ success: false, message: `แทงขั้นต่ำ ฿${round.min_bet}` });
  if (betAmount > parseFloat(round.max_bet))
    return res.status(400).json({ success: false, message: `แทงสูงสุด ฿${round.max_bet}` });

  const rateMap = {
    '3top': round.rate_3top, '3tod': round.rate_3tod,
    '2top': round.rate_2top, '2bot': round.rate_2bot,
    'run_top': round.rate_run_top, 'run_bot': round.rate_run_bot,
  };
  const rate   = parseFloat(rateMap[bet_type]);
  const payout = betAmount * rate;

  try {
    await transaction(async (conn) => {
      // Lock + check balance
      const [[agent]] = await conn.execute(
        'SELECT balance FROM agents WHERE id=? FOR UPDATE', [req.agent.id]
      );
      const balBefore = parseFloat(agent.balance);
      if (balBefore < betAmount) throw new Error('ยอดเงินไม่เพียงพอ');

      const balAfter = parseFloat((balBefore - betAmount).toFixed(2));

      // Deduct balance
      await conn.execute('UPDATE agents SET balance=? WHERE id=?', [balAfter, req.agent.id]);

      // Insert bet
      await conn.execute(
        'INSERT INTO agent_bets (uuid, agent_id, round_id, bet_type, number, amount, rate, payout, status) VALUES (?,?,?,?,?,?,?,?,?)',
        [uuidv4(), req.agent.id, round_id, bet_type, numStr, betAmount, rate, payout, 'waiting']
      );

      // Transaction log
      await conn.execute(
        'INSERT INTO agent_transactions (uuid, agent_id, type, amount, balance_before, balance_after, description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.agent.id, 'bet', betAmount, balBefore, balAfter,
         `แทง ${bet_type.toUpperCase()} ${numStr} — ${round.round_name}`]
      );

      // Update round stats
      await conn.execute(
        'UPDATE lottery_rounds SET total_bet=total_bet+?, bet_count=bet_count+1 WHERE id=?',
        [betAmount, round_id]
      );
    });

    // Return updated balance
    const [updated] = await query('SELECT balance FROM agents WHERE id=?', [req.agent.id]);
    res.json({
      success: true,
      message: `แทง ${bet_type.toUpperCase()} ${numStr} สำเร็จ! ฿${betAmount.toLocaleString()}`,
      data: { balance: parseFloat(updated.balance) }
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// ── GET /api/agent/lottery/bets ────────────────────────────────────
router.get('/lottery/bets', authAgent, async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const agentId = req.agent.id;

  const whereExtra = status ? ` AND ab.status = ${query.escape ? query.escape(status) : `'${status}'`}` : '';
  const rows = await query(
    `SELECT ab.id, ab.uuid, ab.bet_type, ab.number, ab.amount, ab.rate, ab.payout,
            ab.status, ab.win_amount, ab.created_at,
            lr.round_name, lr.draw_date, lt.name AS lottery_name, lt.flag
     FROM agent_bets ab
     JOIN lottery_rounds lr ON ab.round_id = lr.id
     JOIN lottery_types  lt ON lr.lottery_id = lt.id
     WHERE ab.agent_id = ?
     ORDER BY ab.id DESC LIMIT ? OFFSET ?`,
    [agentId, Number(limit), offset]
  ).catch(() => []);

  const [total] = await query(
    'SELECT COUNT(*) cnt FROM agent_bets WHERE agent_id=?', [agentId]
  ).catch(() => [{ cnt: 0 }]);

  const [betStats] = await query(
    `SELECT COALESCE(SUM(amount),0) total_bet, COALESCE(SUM(win_amount),0) total_win,
            SUM(status='win') wins, SUM(status='waiting') pending
     FROM agent_bets WHERE agent_id=?`,
    [agentId]
  ).catch(() => [{ total_bet: 0, total_win: 0, wins: 0, pending: 0 }]);

  res.json({
    success: true,
    data:    rows,
    total:   Number(total.cnt),
    page:    Number(page),
    stats:   {
      total_bet:  parseFloat(betStats.total_bet),
      total_win:  parseFloat(betStats.total_win),
      wins:       Number(betStats.wins),
      pending:    Number(betStats.pending),
    }
  });
});

// ── POST /api/agent/change-password ──────────────────────────────
router.post('/change-password', authAgent, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password)
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  if (new_password.length < 8)
    return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัว' });

  const [agent] = await query('SELECT password FROM agents WHERE id = ?', [req.agent.id]);
  const valid   = await bcrypt.compare(old_password, agent.password);
  if (!valid) return res.status(401).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

  const hashed = await bcrypt.hash(new_password, 12);
  await query('UPDATE agents SET password = ? WHERE id = ?', [hashed, req.agent.id]);
  res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
});

module.exports = router;
