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
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/db');
const { authAgent } = require('../middleware/auth');

// ── Multer (slip upload for agent) ─────────────────────────────────
const AGENT_UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(AGENT_UPLOAD_DIR)) fs.mkdirSync(AGENT_UPLOAD_DIR, { recursive: true });

const agentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AGENT_UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `aslip_${Date.now()}${path.extname(file.originalname)}`),
});
const agentUpload = multer({
  storage: agentStorage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5242880 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpg|jpeg|png|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพ (jpg, png, webp)'));
  },
});

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

// ── GET /api/agent/profile — ดึงข้อมูล Agent รวมถึงข้อมูลธนาคาร ──
router.get('/profile', authAgent, async (req, res) => {
  const [ag] = await query(
    'SELECT id, uuid, name, phone, email, status, bank_code, bank_account, bank_name, balance, commission_balance, created_at FROM agents WHERE id=?',
    [req.agent.id]
  );
  if (!ag) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
  res.json({ success: true, data: ag });
});

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

  // ค่าคอมที่ได้รับจริงเดือนนี้ (จาก commissions table — with safe fallback)
  const [realCommRow] = await query(
    `SELECT COALESCE(SUM(amount),0) total FROM commissions
     WHERE earner_type='agent' AND earner_id=?
       AND YEAR(created_at)=YEAR(NOW()) AND MONTH(created_at)=MONTH(NOW())`,
    [agentId]
  ).catch(() => [null]);

  // global referral rate จาก settings
  const [dashRateSetting] = await query(
    "SELECT value FROM settings WHERE `key`='referral_commission'"
  ).catch(() => [null]);
  const dashGlobalRate = parseFloat(dashRateSetting?.value || 0);

  res.json({
    success: true,
    data: {
      balance:               parseFloat(req.agent.balance || 0),
      commission_balance:    parseFloat(req.agent.commission_balance || 0),
      total_commission:      parseFloat(req.agent.total_commission || 0),
      commission_rate:       req.agent.commission_rate || 0,
      referral_rate:         dashGlobalRate,
      member_count:          memberCount.cnt,
      new_members_today:     newToday.cnt,
      bets_today:            betStats.bet_count,
      bet_total_today:       parseFloat(betStats.bet_total),
      commission_this_month: parseFloat(realCommRow?.total || commissionThisMonth || 0),
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
// ประวัติค่าคอมฯ ที่ได้รับจริงจาก commissions table (30 วันล่าสุด)
router.get('/commissions', authAgent, async (req, res) => {
  const agentId = req.agent.id;

  // รายวัน (จาก commissions table จริง)
  const daily = await query(`
    SELECT DATE(c.created_at) AS date,
           COUNT(*)           AS count,
           SUM(c.bet_amount)  AS bet_total,
           SUM(c.amount)      AS commission
    FROM commissions c
    WHERE c.earner_type='agent' AND c.earner_id=?
      AND c.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    GROUP BY DATE(c.created_at)
    ORDER BY date DESC
    LIMIT 30
  `, [agentId]).catch(() => []);

  // รายการล่าสุด
  const recent = await query(`
    SELECT c.id, c.from_member_id, m.name AS from_member_name,
           c.bet_amount, c.rate, c.amount, c.description, c.created_at
    FROM commissions c
    LEFT JOIN members m ON c.from_member_id = m.id
    WHERE c.earner_type='agent' AND c.earner_id=?
    ORDER BY c.id DESC LIMIT 50
  `, [agentId]).catch(() => []);

  // สรุปยอดรวม
  const [totals] = await query(`
    SELECT COALESCE(SUM(amount),0) total_all,
           COALESCE(SUM(CASE WHEN MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW()) THEN amount END),0) total_month
    FROM commissions WHERE earner_type='agent' AND earner_id=?
  `, [agentId]).catch(() => [{ total_all: 0, total_month: 0 }]);

  // global referral rate จาก settings
  const [rateSetting] = await query(
    "SELECT value FROM settings WHERE `key`='referral_commission'"
  ).catch(() => [null]);
  const globalRate = parseFloat(rateSetting?.value || 0);

  res.json({
    success: true,
    daily,
    recent,
    summary: {
      total_all:   parseFloat(totals?.total_all || 0),
      total_month: parseFloat(totals?.total_month || 0),
      referral_rate: globalRate,
      discount_rate: parseFloat(req.agent.commission_rate || 0),
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  WALLET — กระเป๋าเงินเอเยนต์
// ═══════════════════════════════════════════════════════════════════

// ── GET /api/agent/wallet ─────────────────────────────────────────
router.get('/wallet', authAgent, async (req, res) => {
  const agentId = req.agent.id;
  const [agent] = await query('SELECT balance, commission_balance FROM agents WHERE id=?', [agentId]);

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

// ── POST /api/agent/wallet/deposit — รับสลิป, ไม่ตรวจ SlipOK, รอ Admin อนุมัติ ──
router.post('/wallet/deposit', authAgent, agentUpload.single('slip'), async (req, res) => {
  const { amount, bank_code, transfer_at, note } = req.body;
  const amt = Number(amount);
  if (!amt || amt < 100) return res.status(400).json({ success: false, message: 'จำนวนเงินขั้นต่ำ 100 บาท' });
  if (!req.file)         return res.status(400).json({ success: false, message: 'กรุณาแนบสลิปโอนเงิน' });

  // ── ตรวจว่า Agent มีบัญชีธนาคารผูกไว้ (ถ้าตั้งค่าบังคับ) ──────
  const [agent] = await query(
    'SELECT bank_code, bank_account, bank_name FROM agents WHERE id=?',
    [req.agent.id]
  );
  const reqBankRow = await query("SELECT value FROM settings WHERE `key`='require_sender_bank' LIMIT 1");
  const requireBank = reqBankRow[0]?.value !== 'false'; // default true
  if (requireBank && !agent?.bank_account) {
    return res.status(400).json({
      success : false,
      message : 'กรุณาติดต่อ Admin เพื่อผูกบัญชีธนาคารก่อนฝากเงิน',
      code    : 'NO_BANK_ACCOUNT',
    });
  }

  // ── เพิ่มหมายเหตุบัญชีผู้โอน (Admin จะเห็นข้อมูลนี้) ────────────
  const BANK_MAP = {
    'SCB':'ไทยพาณิชย์','KBANK':'กสิกรไทย','BBL':'กรุงเทพ','KTB':'กรุงไทย',
    'BAY':'กรุงศรี','TMB':'ทีเอ็มบีธนชาต','GSB':'ออมสิน','BAAC':'ธกส',
    'CIMB':'ซีไอเอ็มบี','TBANK':'ธนชาต','UOB':'ยูโอบี','LH':'แลนด์แอนด์เฮ้าส์','TISCO':'ทิสโก้'
  };
  let depositNote = note || null;
  if (agent?.bank_account) {
    const bankLabel = BANK_MAP[agent.bank_code] || agent.bank_code || '';
    const regInfo   = `${bankLabel} ${agent.bank_account}${agent.bank_name ? ' ('+agent.bank_name+')' : ''}`.trim();
    depositNote = `📌 บัญชีที่ลงทะเบียน: ${regInfo}${note ? '\n'+note : ''}`;
  }

  await query(
    `INSERT INTO agent_deposits
       (uuid, agent_id, amount, bank_code, slip_image, note, status)
     VALUES (?,?,?,?,?,?,?)`,
    [uuidv4(), req.agent.id, amt, bank_code || agent?.bank_code || null,
     req.file.filename, depositNote, 'pending']
  );

  res.status(201).json({ success: true, message: 'ส่งสลิปฝากเงินสำเร็จ รอ Admin อนุมัติ' });
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

// ── POST /api/agent/lottery/bets-batch — ส่งโพยหลายใบพร้อมกัน ────
router.post('/lottery/bets-batch', authAgent, async (req, res) => {
  const { round_id, bets } = req.body;
  if (!round_id || !Array.isArray(bets) || bets.length === 0)
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
  if (bets.length > 200)
    return res.status(400).json({ success: false, message: 'ส่งได้ไม่เกิน 200 ใบต่อครั้ง' });

  // Validate each bet
  for (const b of bets) {
    const { bet_type, number, amount } = b;
    if (!BET_NUM_LEN[bet_type])
      return res.status(400).json({ success: false, message: `ประเภท "${bet_type}" ไม่ถูกต้อง` });
    const numStr = String(number||'').trim();
    if (!/^\d+$/.test(numStr) || numStr.length !== BET_NUM_LEN[bet_type])
      return res.status(400).json({ success: false, message: `เลข ${bet_type} "${numStr}" ต้องเป็น ${BET_NUM_LEN[bet_type]} หลัก` });
    if (parseFloat(amount) <= 0)
      return res.status(400).json({ success: false, message: 'จำนวนเงินต้องมากกว่า 0' });
  }

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

  const rateMap = {
    '3top': round.rate_3top, '3tod': round.rate_3tod,
    '2top': round.rate_2top, '2bot': round.rate_2bot,
    'run_top': round.rate_run_top, 'run_bot': round.rate_run_bot,
  };

  const totalFaceAmount = bets.reduce((s, b) => s + parseFloat(b.amount), 0);

  // ── คำนวณส่วนลด (commission_rate = ส่วนลดเมื่อ Agent ซื้อหวย) ──
  const discountRate   = parseFloat(req.agent.commission_rate || 0);
  const discountAmount = parseFloat((totalFaceAmount * discountRate / 100).toFixed(2));
  const totalAmount    = parseFloat((totalFaceAmount - discountAmount).toFixed(2)); // ยอดที่ตัดจริง

  try {
    await transaction(async (conn) => {
      const [agRows] = await conn.query(
        'SELECT balance FROM agents WHERE id=? FOR UPDATE', [req.agent.id]
      );
      const agent = agRows[0];
      const balBefore = parseFloat(agent.balance);
      if (balBefore < totalAmount) throw new Error(`ยอดเงินไม่เพียงพอ (ต้องการ ฿${totalAmount.toLocaleString()} มีอยู่ ฿${balBefore.toLocaleString()})`);

      const balAfter = parseFloat((balBefore - totalAmount).toFixed(2));
      await conn.query('UPDATE agents SET balance=? WHERE id=?', [balAfter, req.agent.id]);

      for (const b of bets) {
        const numStr  = String(b.number).trim();
        const betAmt  = parseFloat(b.amount);
        const rate    = parseFloat(rateMap[b.bet_type]);
        const payout  = betAmt * rate;
        await conn.query(
          'INSERT INTO agent_bets (uuid, agent_id, round_id, bet_type, number, amount, rate, payout, status) VALUES (?,?,?,?,?,?,?,?,?)',
          [uuidv4(), req.agent.id, round_id, b.bet_type, numStr, betAmt, rate, payout, 'waiting']
        );
      }

      // Transaction log (บันทึกทั้งยอดเต็มและส่วนลด)
      const discountNote = discountAmount > 0 ? ` (ส่วนลด ${discountRate}% = ฿${discountAmount.toLocaleString()})` : '';
      await conn.query(
        'INSERT INTO agent_transactions (uuid, agent_id, type, amount, balance_before, balance_after, description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.agent.id, 'bet', totalAmount, balBefore, balAfter,
         `แทงหวย ${bets.length} ใบ — ${round.round_name}${discountNote}`]
      );

      await conn.query(
        'UPDATE lottery_rounds SET total_bet=total_bet+?, bet_count=bet_count+? WHERE id=?',
        [totalFaceAmount, bets.length, round_id]
      );
    });

    const [updated] = await query('SELECT balance FROM agents WHERE id=?', [req.agent.id]);
    const discountMsg = discountAmount > 0 ? ` (ประหยัด ฿${discountAmount.toLocaleString()})` : '';
    res.json({
      success: true,
      message: `แทงสำเร็จ ${bets.length} ใบ รวม ฿${totalFaceAmount.toLocaleString()}${discountMsg}`,
      data: {
        balance:         parseFloat(updated.balance),
        count:           bets.length,
        face_amount:     totalFaceAmount,
        discount_amount: discountAmount,
        charged_amount:  totalAmount,
      }
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

// ── POST /api/agent/commission/transfer — โอนค่าคอมเข้ากระเป๋าหลัก ──
router.post('/commission/transfer', authAgent, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || isNaN(amount) || amount <= 0)
    return res.status(400).json({ success: false, message: 'ระบุจำนวนเงินที่ต้องการโอน' });

  await transaction(async (conn) => {
    const [[ag]] = await conn.execute(
      'SELECT balance, commission_balance FROM agents WHERE id=? FOR UPDATE', [req.agent.id]
    );
    const commBal = parseFloat(ag.commission_balance || 0);
    if (commBal < amount)
      throw new Error(`ค่าคอมไม่เพียงพอ (มี ฿${commBal.toFixed(2)})`);

    const newCommBal = parseFloat((commBal - amount).toFixed(2));
    const newMainBal = parseFloat((parseFloat(ag.balance) + amount).toFixed(2));

    await conn.execute(
      'UPDATE agents SET commission_balance=?, balance=? WHERE id=?',
      [newCommBal, newMainBal, req.agent.id]
    );
    await conn.execute(
      'INSERT INTO agent_transactions (uuid,agent_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
      [uuidv4(), req.agent.id, 'commission_transfer', amount, ag.balance, newMainBal,
       `โอนค่าคอมแนะนำเข้ากระเป๋าหลัก ฿${amount}`]
    );
  });

  res.json({ success: true, message: `โอนค่าคอม ฿${amount} เข้ากระเป๋าหลักสำเร็จ` });
});

// ── PATCH /api/agent/bank — Agent ลงทะเบียน/แก้ไขบัญชีธนาคารตัวเอง ──
router.patch('/bank', authAgent, async (req, res) => {
  const { bank_code, bank_account, bank_name } = req.body;
  if (!bank_code || !bank_account || !bank_name)
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลธนาคารให้ครบ' });
  await query(
    'UPDATE agents SET bank_code=?, bank_account=?, bank_name=? WHERE id=?',
    [bank_code.toUpperCase().trim(), bank_account.trim(), bank_name.trim(), req.agent.id]
  );
  res.json({ success: true, message: 'บันทึกบัญชีธนาคารสำเร็จ' });
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
