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
const { query } = require('../config/db');
const { authAgent } = require('../middleware/auth');

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
