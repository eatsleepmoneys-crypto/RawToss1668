const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');

// ══════════════════════════════════════
//  DASHBOARD STATS
// ══════════════════════════════════════
router.get('/dashboard', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const [members]  = await query('SELECT COUNT(*) c FROM members');
  const [newToday] = await query('SELECT COUNT(*) c FROM members WHERE DATE(created_at)=CURDATE()');
  const [depToday] = await query('SELECT COALESCE(SUM(amount),0) total FROM deposits WHERE status="approved" AND DATE(approved_at)=CURDATE()');
  const [wdToday]  = await query('SELECT COALESCE(SUM(amount),0) total FROM withdrawals WHERE status="completed" AND DATE(processed_at)=CURDATE()');
  const [betToday] = await query('SELECT COALESCE(SUM(amount),0) total, COUNT(*) cnt FROM bets WHERE DATE(created_at)=CURDATE()');
  const [pendDep]  = await query('SELECT COUNT(*) c FROM deposits WHERE status="pending"');
  const [pendWd]   = await query('SELECT COUNT(*) c, COALESCE(SUM(amount),0) total FROM withdrawals WHERE status="pending"');
  const [openRounds] = await query('SELECT COUNT(*) c FROM lottery_rounds WHERE status="open"');

  // Revenue 7 days
  const revenue7 = await query(`
    SELECT DATE(approved_at) d, SUM(amount) total
    FROM deposits WHERE status='approved' AND approved_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY DATE(approved_at) ORDER BY d ASC`);

  // Bet by lottery type today
  const betByType = await query(`
    SELECT lt.name, COALESCE(SUM(b.amount),0) total
    FROM lottery_types lt
    LEFT JOIN lottery_rounds lr ON lr.lottery_id=lt.id
    LEFT JOIN bets b ON b.round_id=lr.id AND DATE(b.created_at)=CURDATE()
    GROUP BY lt.id ORDER BY total DESC LIMIT 6`);

  // Top bettors today
  const topBettors = await query(`
    SELECT m.name, COALESCE(SUM(b.amount),0) total
    FROM bets b JOIN members m ON b.member_id=m.id
    WHERE DATE(b.created_at)=CURDATE()
    GROUP BY b.member_id ORDER BY total DESC LIMIT 5`);

  res.json({
    success: true,
    data: {
      members:         members.c,
      new_today:       newToday.c,
      dep_today:       depToday.total,
      wd_today:        wdToday.total,
      bet_today:       betToday.total,
      bet_count_today: betToday.cnt,
      profit_today:    parseFloat(depToday.total) - parseFloat(wdToday.total),
      pending_dep:     pendDep.c,
      pending_wd:      pendWd.c,
      pending_wd_amt:  pendWd.total,
      open_rounds:     openRounds.c,
      revenue_7days:   revenue7,
      bet_by_type:     betByType,
      top_bettors:     topBettors,
    }
  });
});

// ══════════════════════════════════════
//  AGENTS
// ══════════════════════════════════════
router.get('/agents', authAdmin, rbac.requirePerm('agents.view'), async (req, res) => {
  const rows = await query('SELECT id,uuid,name,phone,commission_rate,balance,total_commission,status,created_at FROM agents ORDER BY id DESC');
  res.json({ success: true, data: rows });
});

router.post('/agents', authAdmin, rbac.requirePerm('agents.manage'),
  body('name').notEmpty(), body('phone').matches(/^0[0-9]{8,9}$/), body('password').isLength({min:8}),
  async (req, res) => {
    const err = validationResult(req);
    if (!err.isEmpty()) return res.status(400).json({ success:false, errors: err.array() });
    const { name, phone, email, password, commission_rate=3 } = req.body;
    const hashed = await bcrypt.hash(password, 12);
    await query('INSERT INTO agents (uuid,name,phone,email,password,commission_rate) VALUES (?,?,?,?,?,?)',
      [uuidv4(), name, phone, email||null, hashed, commission_rate]);
    res.status(201).json({ success: true, message: 'เพิ่มเอเยนต์สำเร็จ' });
  }
);

router.patch('/agents/:id', authAdmin, rbac.requirePerm('agents.manage'), async (req, res) => {
  const { commission_rate, status } = req.body;
  await query('UPDATE agents SET commission_rate=COALESCE(?,commission_rate), status=COALESCE(?,status) WHERE id=?',
    [commission_rate, status, req.params.id]);
  res.json({ success: true, message: 'อัพเดทเอเยนต์แล้ว' });
});

// ══════════════════════════════════════
//  ADMIN USERS (Multi-level)
// ══════════════════════════════════════
router.get('/admins', authAdmin, rbac.requirePerm('admins.view'), async (req, res) => {
  const rows = await query('SELECT id,uuid,name,email,role,is_active,two_fa_enabled,last_login_at,created_at FROM admins ORDER BY id ASC');
  res.json({ success: true, data: rows });
});

router.post('/admins', authAdmin, rbac.requirePerm('admins.create'),
  body('name').notEmpty(), body('email').isEmail(), body('password').isLength({min:8}),
  body('role').isIn(['admin','finance','staff']),
  async (req, res) => {
    const err = validationResult(req);
    if (!err.isEmpty()) return res.status(400).json({ success:false, errors: err.array() });
    const { name, email, password, role } = req.body;
    const [ex] = await query('SELECT id FROM admins WHERE email=?', [email]);
    if (ex) return res.status(400).json({ success:false, message:'Email นี้ถูกใช้แล้ว' });
    const hashed = await bcrypt.hash(password, 12);
    await query('INSERT INTO admins (uuid,name,email,password,role) VALUES (?,?,?,?,?)',
      [uuidv4(), name, email, hashed, role]);
    await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
      [req.admin.id, 'admin.create', `สร้าง Admin: ${email} (${role})`, req.ip]);
    res.status(201).json({ success: true, message: 'เพิ่ม Admin สำเร็จ' });
  }
);

router.patch('/admins/:id', authAdmin, rbac.requirePerm('admins.edit'), async (req, res) => {
  if (parseInt(req.params.id) === req.admin.id && req.body.role)
    return res.status(400).json({ success:false, message:'ไม่สามารถเปลี่ยน role ตัวเองได้' });
  const { name, role, is_active } = req.body;
  await query('UPDATE admins SET name=COALESCE(?,name), role=COALESCE(?,role), is_active=COALESCE(?,is_active) WHERE id=?',
    [name, role, is_active, req.params.id]);
  res.json({ success: true, message: 'อัพเดท Admin แล้ว' });
});

router.delete('/admins/:id', authAdmin, rbac.requirePerm('admins.delete'), async (req, res) => {
  if (parseInt(req.params.id) === req.admin.id)
    return res.status(400).json({ success:false, message:'ไม่สามารถลบตัวเองได้' });
  await query('UPDATE admins SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ success: true, message: 'ปิดการใช้งาน Admin แล้ว' });
});

router.patch('/admins/:id/reset-password', authAdmin, rbac.requirePerm('admins.edit'),
  body('new_password').isLength({min:8}),
  async (req, res) => {
    const hashed = await bcrypt.hash(req.body.new_password, 12);
    await query('UPDATE admins SET password=?, login_attempts=0, locked_until=NULL WHERE id=?', [hashed, req.params.id]);
    res.json({ success: true, message: 'รีเซ็ตรหัสผ่านแล้ว' });
  }
);

// ══════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════
router.get('/reports/summary', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const dateTo   = to   || new Date().toISOString().slice(0,10);

  const [dep]    = await query('SELECT COALESCE(SUM(amount),0) t FROM deposits WHERE status="approved" AND DATE(approved_at) BETWEEN ? AND ?', [dateFrom, dateTo]);
  const [wd]     = await query('SELECT COALESCE(SUM(amount),0) t FROM withdrawals WHERE status="completed" AND DATE(processed_at) BETWEEN ? AND ?', [dateFrom, dateTo]);
  const [bets]   = await query('SELECT COALESCE(SUM(amount),0) t, COUNT(*) cnt FROM bets WHERE DATE(created_at) BETWEEN ? AND ?', [dateFrom, dateTo]);
  const [wins]   = await query('SELECT COALESCE(SUM(win_amount),0) t FROM bets WHERE status="win" AND DATE(updated_at) BETWEEN ? AND ?', [dateFrom, dateTo]);
  const [newMem] = await query('SELECT COUNT(*) c FROM members WHERE DATE(created_at) BETWEEN ? AND ?', [dateFrom, dateTo]);

  const daily = await query(`
    SELECT DATE(approved_at) d, SUM(amount) dep
    FROM deposits WHERE status='approved' AND DATE(approved_at) BETWEEN ? AND ?
    GROUP BY DATE(approved_at) ORDER BY d`, [dateFrom, dateTo]);

  const byLottery = await query(`
    SELECT lt.name, lt.flag, COALESCE(SUM(b.amount),0) total, COUNT(b.id) cnt
    FROM lottery_types lt
    LEFT JOIN lottery_rounds lr ON lr.lottery_id=lt.id
    LEFT JOIN bets b ON b.round_id=lr.id AND DATE(b.created_at) BETWEEN ? AND ?
    GROUP BY lt.id ORDER BY total DESC`, [dateFrom, dateTo]);

  res.json({
    success: true,
    data: {
      from: dateFrom, to: dateTo,
      total_deposit:  dep.t,
      total_withdraw: wd.t,
      total_bet:      bets.t,
      total_bet_count: bets.cnt,
      total_win:      wins.t,
      profit:         parseFloat(dep.t) - parseFloat(wd.t),
      new_members:    newMem.c,
      daily,
      by_lottery:     byLottery,
    }
  });
});

// GET /api/admin/logs
router.get('/logs', authAdmin, rbac.requirePerm('logs.view'), async (req, res) => {
  const { page=1, limit=30, admin_id, action } = req.query;
  const offset = (page-1)*limit;
  const where=[]; const params=[];
  if (admin_id) { where.push('l.admin_id=?'); params.push(admin_id); }
  if (action)   { where.push('l.action LIKE ?'); params.push(`%${action}%`); }
  const rows = await query(
    `SELECT l.*,a.name as admin_name,a.role FROM admin_logs l LEFT JOIN admins a ON l.admin_id=a.id
     ${where.length?'WHERE '+where.join(' AND '):''}
     ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), parseInt(offset)]);
  res.json({ success: true, data: rows });
});

// POST /api/admin/announce — broadcast notification
router.post('/announce', authAdmin, rbac.requirePerm('settings.view'),
  body('title').notEmpty(), body('body').notEmpty(),
  async (req, res) => {
    const { title, body: bodyText, member_id } = req.body;
    // member_id=null = broadcast to all
    await query('INSERT INTO notifications (member_id,title,body,type) VALUES (?,?,?,?)',
      [member_id||null, title, bodyText, 'system']);
    res.json({ success: true, message: 'ส่งประกาศแล้ว' });
  }
);

module.exports = router;
