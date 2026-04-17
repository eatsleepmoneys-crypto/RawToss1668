const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { authMember, authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const { v4: uuidv4 } = require('uuid');

// ══════════════════════════════════════
//  MEMBER-FACING routes (/api/members/)
// ══════════════════════════════════════

// GET /api/members/profile
router.get('/profile', authMember, async (req, res) => {
  const [m] = await query(
    `SELECT id,uuid,name,phone,email,bank_code,bank_account,bank_name,
            balance,bonus_balance,total_deposit,total_withdraw,total_bet,total_win,
            level,member_code,is_verified,phone_verified,created_at
     FROM members WHERE id=?`, [req.member.id]);
  res.json({ success: true, data: m });
});

// PATCH /api/members/profile — update email, bank
router.patch('/profile', authMember,
  body('email').optional().isEmail(),
  body('bank_code').optional().notEmpty(),
  body('bank_account').optional().notEmpty(),
  body('bank_name').optional().notEmpty(),
  async (req, res) => {
    const { email, bank_code, bank_account, bank_name } = req.body;
    await query('UPDATE members SET email=COALESCE(?,email), bank_code=COALESCE(?,bank_code), bank_account=COALESCE(?,bank_account), bank_name=COALESCE(?,bank_name), updated_at=NOW() WHERE id=?',
      [email, bank_code, bank_account, bank_name, req.member.id]);
    res.json({ success: true, message: 'อัพเดทข้อมูลสำเร็จ' });
  }
);

// PATCH /api/members/change-password
router.patch('/change-password', authMember,
  body('old_password').notEmpty(),
  body('new_password').isLength({ min: 8 }),
  async (req, res) => {
    const { old_password, new_password } = req.body;
    const [m] = await query('SELECT password FROM members WHERE id=?', [req.member.id]);
    if (!await bcrypt.compare(old_password, m.password))
      return res.status(400).json({ success: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    const hashed = await bcrypt.hash(new_password, 12);
    await query('UPDATE members SET password=? WHERE id=?', [hashed, req.member.id]);
    res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
  }
);

// GET /api/members/wallet — balance + recent transactions
router.get('/wallet', authMember, async (req, res) => {
  const [m] = await query('SELECT balance, bonus_balance FROM members WHERE id=?', [req.member.id]);
  const txn = await query(
    'SELECT type,amount,balance_after,description,created_at FROM transactions WHERE member_id=? ORDER BY id DESC LIMIT 20',
    [req.member.id]);
  res.json({ success: true, data: { ...m, transactions: txn } });
});

// GET /api/members/notifications
router.get('/notifications', authMember, async (req, res) => {
  const notifs = await query(
    'SELECT * FROM notifications WHERE member_id=? OR member_id IS NULL ORDER BY id DESC LIMIT 30',
    [req.member.id]);
  res.json({ success: true, data: notifs });
});

// PATCH /api/members/notifications/read
router.patch('/notifications/read', authMember, async (req, res) => {
  await query('UPDATE notifications SET is_read=1 WHERE member_id=?', [req.member.id]);
  res.json({ success: true, message: 'อ่านแล้ว' });
});

// GET /api/members/bet-history
router.get('/bet-history', authMember, async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const lim = parseInt(limit) || 20;
  const off = (parseInt(page) - 1) * lim;
  const where = status ? 'AND b.status=?' : '';
  const params = status ? [req.member.id, status] : [req.member.id];

  const bets = await query(
    `SELECT b.id,b.uuid,b.bet_type,b.number,b.amount,b.rate,b.payout,b.win_amount,b.status,b.created_at,
            lr.round_name,lr.draw_date,lt.name as lottery_name,lt.flag
     FROM bets b
     JOIN lottery_rounds lr ON b.round_id=lr.id
     JOIN lottery_types lt ON lr.lottery_id=lt.id
     WHERE b.member_id=? ${where}
     ORDER BY b.id DESC LIMIT ${lim} OFFSET ${off}`, params);
  res.json({ success: true, data: bets });
});

// GET /api/members/referrals
router.get('/referrals', authMember, async (req, res) => {
  const refs = await query(
    'SELECT name, created_at FROM members WHERE ref_by=? ORDER BY id DESC',
    [req.member.id]);
  const commissions = await query(
    'SELECT SUM(amount) as total FROM transactions WHERE member_id=? AND type="commission"',
    [req.member.id]);
  res.json({ success: true, data: { referrals: refs, total_commission: commissions[0]?.total || 0 } });
});

// ══════════════════════════════════════
//  ADMIN routes (/api/members/admin/...)
// ══════════════════════════════════════

// GET /api/members/admin/list
router.get('/admin/list', authAdmin, rbac.requirePerm('members.view'), async (req, res) => {
  const { page=1, limit=20, search='', status='' } = req.query;
  const lim = Math.min(parseInt(limit)||20, 100);
  const off = (Math.max(parseInt(page),1) - 1) * lim;
  const where = [];
  const params = [];
  if (search) { where.push('(name LIKE ? OR phone LIKE ? OR member_code LIKE ?)'); params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
  if (status) { where.push('status=?'); params.push(status); }
  const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sql = `SELECT id,uuid,name,phone,bank_code,balance,status,level,member_code,created_at,last_login_at
               FROM members ${whereStr}
               ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`;
  const rows = await query(sql, params);
  const [count] = await query(`SELECT COUNT(*) as total FROM members ${whereStr}`, params);
  res.json({ success: true, data: rows, total: count.total, page: parseInt(page), limit: lim });
});

// POST /api/members/admin/create — Admin สร้างสมาชิกใหม่
router.post('/admin/create', authAdmin, rbac.requirePerm('members.view'),
  body('phone').notEmpty(), body('password').isLength({ min: 6 }), body('name').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, message: errors.array()[0].msg });
    const { phone, password, name, bank_code = null, bank_account = null, bank_name = null } = req.body;
    const existing = await query('SELECT id FROM members WHERE phone=?', [phone]);
    if (existing.length) return res.status(409).json({ success: false, message: 'เบอร์โทรนี้มีในระบบแล้ว' });
    const hash = await bcrypt.hash(password, 10);
    const code = 'M' + Date.now().toString(36).toUpperCase();
    const memberUuid = uuidv4();
    await query(
      'INSERT INTO members (uuid,name,phone,password,bank_code,bank_account,bank_name,member_code,status) VALUES (?,?,?,?,?,?,?,?,?)',
      [memberUuid, name, phone, hash, bank_code, bank_account, bank_name, code, 'active']
    );
    res.status(201).json({ success: true, message: 'เพิ่มสมาชิกสำเร็จ' });
  }
);

// GET /api/members/admin/:id
router.get('/admin/:id', authAdmin, rbac.requirePerm('members.view'), async (req, res) => {
  const [m] = await query('SELECT * FROM members WHERE id=?', [req.params.id]);
  if (!m) return res.status(404).json({ success: false, message: 'ไม่พบสมาชิก' });
  const txn = await query('SELECT * FROM transactions WHERE member_id=? ORDER BY id DESC LIMIT 30', [m.id]);
  res.json({ success: true, data: { ...m, transactions: txn } });
});

// PATCH /api/members/admin/:id/status — ban/unban
router.patch('/admin/:id/status', authAdmin, rbac.requirePerm('members.ban'), async (req, res) => {
  const { status, note } = req.body;
  await query('UPDATE members SET status=? WHERE id=?', [status, req.params.id]);
  await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
    [req.admin.id, 'member.status', 'member', req.params.id, `${status}: ${note||''}`, req.ip]);
  res.json({ success: true, message: `อัพเดทสถานะเป็น "${status}" แล้ว` });
});

// PATCH /api/members/admin/:id/credit — adjust balance
router.patch('/admin/:id/credit', authAdmin, rbac.requirePerm('members.credit'), async (req, res) => {
  const { amount, type = 'bonus', note } = req.body; // type: bonus | deduct
  if (!amount || isNaN(amount)) return res.status(400).json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });

  await transaction(async (conn) => {
    const [[m]] = await conn.execute('SELECT balance FROM members WHERE id=? FOR UPDATE', [req.params.id]);
    const adj = type === 'deduct' ? -Math.abs(amount) : Math.abs(amount);
    const newBal = parseFloat(m.balance) + adj;
    if (newBal < 0) throw new Error('ยอดเงินไม่เพียงพอ');
    await conn.execute('UPDATE members SET balance=? WHERE id=?', [newBal, req.params.id]);
    await conn.execute('INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
      [uuidv4(), req.params.id, type, adj, m.balance, newBal, note || `ปรับยอดโดย Admin (${req.admin.name})`]);
    await conn.execute('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
      [req.admin.id, 'member.credit', 'member', req.params.id, `${type}: ${amount} | ${note}`, req.ip]);
  });
  res.json({ success: true, message: 'ปรับยอดเงินสำเร็จ' });
});

module.exports = router;
