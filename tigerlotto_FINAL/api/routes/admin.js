const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');

// ══════════════════════════════════════
//  DASHBOARD STATS
// ══════════════════════════════════════
router.get('/dashboard', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  // Helper: run query safely — returns fallback if table is missing or query fails
  const safe = async (sql, fallback, params = []) => {
    try { const [r] = await query(sql, params); return r ?? fallback; }
    catch { return fallback; }
  };
  const safeAll = async (sql, params = []) => {
    try { return await query(sql, params); }
    catch { return []; }
  };

  const [members, newToday, depToday, wdToday, betToday, pendDep, pendWd, openRounds] = await Promise.all([
    safe('SELECT COUNT(*) c FROM members',                                                                      { c: 0 }),
    safe('SELECT COUNT(*) c FROM members WHERE DATE(created_at)=CURDATE()',                                    { c: 0 }),
    safe('SELECT COALESCE(SUM(amount),0) total FROM deposits WHERE status="approved" AND DATE(approved_at)=CURDATE()',   { total: 0 }),
    safe('SELECT COALESCE(SUM(amount),0) total FROM withdrawals WHERE status="completed" AND DATE(processed_at)=CURDATE()', { total: 0 }),
    safe('SELECT COALESCE(SUM(amount),0) total, COUNT(*) cnt FROM bets WHERE DATE(created_at)=CURDATE()',      { total: 0, cnt: 0 }),
    safe('SELECT COUNT(*) c FROM deposits WHERE status="pending"',                                             { c: 0 }),
    safe('SELECT COUNT(*) c, COALESCE(SUM(amount),0) total FROM withdrawals WHERE status="pending"',           { c: 0, total: 0 }),
    safe('SELECT COUNT(*) c FROM lottery_rounds WHERE status="open"',                                          { c: 0 }),
  ]);

  // Revenue 7 days
  const revenue7 = await safeAll(`
    SELECT DATE(approved_at) d, SUM(amount) total
    FROM deposits WHERE status='approved' AND approved_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY DATE(approved_at) ORDER BY d ASC`);

  // Bet by lottery type today
  const betByType = await safeAll(`
    SELECT lt.name, COALESCE(SUM(b.amount),0) total
    FROM lottery_types lt
    LEFT JOIN lottery_rounds lr ON lr.lottery_id=lt.id
    LEFT JOIN bets b ON b.round_id=lr.id AND DATE(b.created_at)=CURDATE()
    GROUP BY lt.id ORDER BY total DESC LIMIT 6`);

  // Top bettors today
  const topBettors = await safeAll(`
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
  const rows = await query('SELECT id,uuid,name,phone,commission_rate,referral_rate,balance,total_commission,status,bank_code,bank_account,bank_name,created_at FROM agents ORDER BY id DESC');
  res.json({ success: true, data: rows });
});

router.post('/agents', authAdmin, rbac.requirePerm('agents.manage'),
  body('name').notEmpty().withMessage('กรุณากรอกชื่อ'),
  body('phone').notEmpty().withMessage('กรุณากรอกเบอร์โทร'),
  body('password').isLength({min:8}).withMessage('รหัสผ่านต้องมีอย่างน้อย 8 ตัว'),
  async (req, res) => {
    const err = validationResult(req);
    if (!err.isEmpty()) return res.status(400).json({ success:false, message: err.array().map(e=>e.msg).join(', ') });
    const { name, email, password, commission_rate=3, referral_rate=0 } = req.body;
    // strip non-digits from phone for storage
    const phone = String(req.body.phone).replace(/[^0-9]/g, '');
    if (phone.length < 9) return res.status(400).json({ success:false, message: 'เบอร์โทรไม่ถูกต้อง (ต้องมีอย่างน้อย 9 หลัก)' });
    try {
      const hashed = await bcrypt.hash(password, 12);
      await query('INSERT INTO agents (uuid,name,phone,email,password,commission_rate,referral_rate) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), name, phone, email||null, hashed, commission_rate, referral_rate]);
      await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
        [req.admin.id, 'agent.create', `${name} (${phone})`, req.ip]);
      res.status(201).json({ success: true, message: 'เพิ่มเอเยนต์สำเร็จ' });
    } catch(e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success:false, message: 'เบอร์โทรนี้มีในระบบแล้ว' });
      res.status(500).json({ success:false, message: e.message });
    }
  }
);

router.patch('/agents/:id', authAdmin, rbac.requirePerm('agents.manage'), async (req, res) => {
  const { commission_rate, referral_rate, status } = req.body;
  await query(
    'UPDATE agents SET commission_rate=COALESCE(?,commission_rate), referral_rate=COALESCE(?,referral_rate), status=COALESCE(?,status) WHERE id=?',
    [commission_rate ?? null, referral_rate ?? null, status ?? null, req.params.id]
  );
  res.json({ success: true, message: 'อัพเดทเอเยนต์แล้ว' });
});

// ── Agent Bank Account ──
router.patch('/agents/:id/bank', authAdmin, rbac.requirePerm('agents.manage'), async (req, res) => {
  const { bank_code, bank_account, bank_name } = req.body;
  if (!bank_code || !bank_account || !bank_name)
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลธนาคารให้ครบ (ธนาคาร / เลขบัญชี / ชื่อบัญชี)' });
  const [a] = await query('SELECT id, name FROM agents WHERE id=?', [req.params.id]);
  if (!a) return res.status(404).json({ success: false, message: 'ไม่พบเอเยนต์' });
  await query('UPDATE agents SET bank_code=?, bank_account=?, bank_name=? WHERE id=?',
    [bank_code.toUpperCase(), bank_account.trim(), bank_name.trim(), req.params.id]);
  await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
    [req.admin.id, 'agent.bank_update', 'agent', req.params.id,
     `${bank_code} ${bank_account} (${bank_name})`, req.ip]);
  res.json({ success: true, message: `อัพเดทบัญชีธนาคารของ ${a.name} แล้ว` });
});

// ── Agent Credit ──
router.patch('/agents/:id/credit', authAdmin, rbac.requirePerm('members.credit'), async (req, res) => {
  const { amount, type = 'bonus', note } = req.body;
  if (!amount || isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });
  await transaction(async (conn) => {
    const [[a]] = await conn.execute('SELECT balance FROM agents WHERE id=? FOR UPDATE', [req.params.id]);
    if (!a) throw new Error('ไม่พบเอเยนต์');
    const adj    = type === 'deduct' ? -Math.abs(Number(amount)) : Math.abs(Number(amount));
    const newBal = parseFloat(a.balance) + adj;
    if (newBal < 0) throw new Error('ยอดเงินไม่เพียงพอ');
    await conn.execute('UPDATE agents SET balance=? WHERE id=?', [newBal, req.params.id]);
    await conn.execute(
      'INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
      [req.admin.id, 'agent.credit', 'agent', req.params.id, `${type}: ${amount} | ${note || ''}`, req.ip]
    );
  });
  res.json({ success: true, message: 'ปรับยอดเงินสำเร็จ' });
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

// ── Admin Credit ──
router.patch('/admins/:id/credit', authAdmin, rbac.requirePerm('members.credit'), async (req, res) => {
  const { amount, type = 'bonus', note } = req.body;
  if (!amount || isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });
  await transaction(async (conn) => {
    const [[a]] = await conn.execute('SELECT balance FROM admins WHERE id=? FOR UPDATE', [req.params.id]);
    if (!a) throw new Error('ไม่พบ Admin');
    const adj    = type === 'deduct' ? -Math.abs(Number(amount)) : Math.abs(Number(amount));
    const newBal = parseFloat(a.balance || 0) + adj;
    if (newBal < 0) throw new Error('ยอดเงินไม่เพียงพอ');
    await conn.execute('UPDATE admins SET balance=? WHERE id=?', [newBal, req.params.id]);
    await conn.execute(
      'INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
      [req.admin.id, 'admin.credit', 'admin', req.params.id, `${type}: ${amount} | ${note || ''}`, req.ip]
    );
  });
  res.json({ success: true, message: 'ปรับยอดเงินสำเร็จ' });
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
  const lim2 = parseInt(limit) || 30;
  const off2 = parseInt(offset) || 0;
  const rows = await query(
    `SELECT l.*,a.name as admin_name,a.role FROM admin_logs l LEFT JOIN admins a ON l.admin_id=a.id
     ${where.length?'WHERE '+where.join(' AND '):''}
     ORDER BY l.id DESC LIMIT ${lim2} OFFSET ${off2}`, params);
  res.json({ success: true, data: rows });
});

// ══════════════════════════════════════
//  PROMOTIONS CRUD
// ══════════════════════════════════════
router.get('/promotions', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const rows = await query('SELECT * FROM promotions ORDER BY id DESC');
  res.json({ success: true, data: rows });
});

router.post('/promotions', authAdmin, rbac.requirePerm('settings.view'),
  body('name').notEmpty(),
  body('type').isIn(['welcome','deposit','cashback','referral','manual']),
  body('value').isFloat({ min: 0 }),
  async (req, res) => {
    const err = validationResult(req);
    if (!err.isEmpty()) return res.status(400).json({ success: false, errors: err.array() });
    const { name, type, value, code, is_percent=0, min_deposit=0, max_bonus=null, usage_limit=null, start_at=null, end_at=null } = req.body;
    await query(
      `INSERT INTO promotions (code,name,type,value,is_percent,min_deposit,max_bonus,usage_limit,start_at,end_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [code||null, name, type, value, is_percent?1:0, min_deposit, max_bonus||null, usage_limit||null, start_at||null, end_at||null]
    );
    await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
      [req.admin.id, 'promotion.create', `สร้างโปรโมชั่น: ${name}`, req.ip]);
    res.status(201).json({ success: true, message: 'สร้างโปรโมชั่นสำเร็จ' });
  }
);

router.patch('/promotions/:id', authAdmin, rbac.requirePerm('settings.view'), async (req, res) => {
  // Build dynamic SET clause — only update fields that were actually sent
  const allowed = ['name','value','is_percent','min_deposit','max_bonus','usage_limit','is_active','start_at','end_at'];
  const sets = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`\`${key}\`=?`);
      params.push(req.body[key] === '' ? null : req.body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลให้อัพเดท' });
  params.push(req.params.id);
  await query(`UPDATE promotions SET ${sets.join(',')} WHERE id=?`, params);
  res.json({ success: true, message: 'อัพเดทโปรโมชั่นแล้ว' });
});

router.delete('/promotions/:id', authAdmin, rbac.requirePerm('settings.view'), async (req, res) => {
  await query('UPDATE promotions SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ success: true, message: 'ปิดโปรโมชั่นแล้ว' });
});

// ─── Hot Numbers ──────────────────────────────────────────────────────────────
// GET /api/admin/hot-numbers — ตัวเลขที่ถูกแทงมากที่สุด
router.get('/hot-numbers', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const { round_id, limit = 50, bet_type, date_from, date_to } = req.query;
  const where = [];
  const params = [];
  if (round_id)  { where.push('h.round_id=?');              params.push(parseInt(round_id)); }
  if (bet_type)  { where.push('bt.name=?');                  params.push(bet_type); }
  if (date_from) { where.push('DATE(lr.draw_date) >= ?');    params.push(date_from); }
  if (date_to)   { where.push('DATE(lr.draw_date) <= ?');    params.push(date_to); }
  const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sql = `
    SELECT h.id, h.number, h.bet_count, h.total_amount, h.max_payout,
           lt.name AS lottery_type, bt.name AS bet_type,
           lr.draw_date, lr.status AS round_status,
           h.updated_at
    FROM hot_numbers h
    JOIN lottery_types lt ON h.lottery_type_id = lt.id
    JOIN bet_types bt ON h.bet_type_id = bt.id
    JOIN lottery_rounds lr ON h.round_id = lr.id
    ${whereClause}
    ORDER BY h.total_amount DESC
    LIMIT ${Math.min(parseInt(limit)||50, 200)}
  `;
  const data = await query(sql, params);
  res.json({ success: true, data });
});

// GET /api/admin/hot-numbers/bet-types — distinct bet type names in hot_numbers
router.get('/hot-numbers/bet-types', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const data = await query(
    `SELECT DISTINCT bt.name
     FROM hot_numbers h
     JOIN bet_types bt ON h.bet_type_id = bt.id
     ORDER BY bt.id`
  );
  res.json({ success: true, data: data.map(r => r.name) });
});

// GET /api/admin/hot-numbers/rounds — รายการรอบที่มีข้อมูล
router.get('/hot-numbers/rounds', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const data = await query(
    `SELECT DISTINCT lr.id, lr.draw_date, lr.status, lt.name AS lottery_type
     FROM hot_numbers h
     JOIN lottery_rounds lr ON h.round_id = lr.id
     JOIN lottery_types lt ON h.lottery_type_id = lt.id
     ORDER BY lr.draw_date DESC LIMIT 50`
  );
  res.json({ success: true, data });
});

// ─── KYC ──────────────────────────────────────────────────────────────────────
const kycCtrl = require('../controllers/kycController');

// GET /api/admin/kyc
router.get('/kyc', authAdmin, rbac.requirePerm('members.view'), kycCtrl.adminListKYC);

// PUT /api/admin/kyc/:id/approve
router.put('/kyc/:id/approve', authAdmin, rbac.requirePerm('members.edit'), kycCtrl.approveKYC);

// PUT /api/admin/kyc/:id/reject
router.put('/kyc/:id/reject', authAdmin, rbac.requirePerm('members.edit'), kycCtrl.rejectKYC);

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

// ─── GET /api/admin/yeekee/today — สถานะงวดยี่กีวันนี้ ───────────
router.get('/yeekee/today', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const rows = await query(`
    SELECT
      lr.id, lr.round_code, lr.round_name, lr.close_at, lr.status,
      lr.total_bet, lr.bet_count,
      res.prize_1st, res.prize_last_2, res.announced_at
    FROM lottery_rounds lr
    JOIN lottery_types lt ON lr.lottery_id = lt.id AND lt.code = 'YEEKEE'
    LEFT JOIN lottery_results res ON lr.id = res.round_id
    WHERE DATE(lr.draw_date) = DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR))
    ORDER BY lr.close_at ASC
  `);
  const summary = {
    total : rows.length,
    open  : rows.filter(r => r.status === 'open').length,
    closed: rows.filter(r => r.status === 'closed').length,
    announced: rows.filter(r => r.status === 'announced').length,
  };
  res.json({ success: true, data: rows, summary });
});

// ─── POST /api/admin/yeekee/trigger-manage — trigger open/close rounds ─
router.post('/yeekee/trigger-manage', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  try {
    const { autoManageRounds } = require('../services/roundManager');
    await autoManageRounds();
    res.json({ success: true, message: 'Trigger open/close rounds สำเร็จ' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── POST /api/admin/yeekee/trigger-announce — trigger ออกผลทันที ─
router.post('/yeekee/trigger-announce', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  try {
    const { yeekeeAutoAnnounce } = require('../services/roundManager');
    await yeekeeAutoAnnounce();
    res.json({ success: true, message: 'Trigger ออกผลยี่กีสำเร็จ' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/admin/auto-results/status — สถานะ fetcher ─────────
router.get('/auto-results/status', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  try {
    const { fetcherStatus } = require('../services/lotteryFetcher');
    // ดึงงวดล่าสุดของแต่ละ type
    const rounds = await query(`
      SELECT lt.code, lr.id, lr.round_name, lr.status, lr.close_at,
             res.prize_1st, res.prize_last_2, res.prize_2bot, res.announced_at
      FROM lottery_rounds lr
      JOIN lottery_types lt ON lr.lottery_id = lt.id
      LEFT JOIN lottery_results res ON lr.id = res.round_id
      WHERE lt.code IN ('TH_GOV','LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP')
        AND lr.status IN ('closed','announced')
      ORDER BY lr.close_at DESC
    `);
    // group by code (เอาล่าสุดของแต่ละ type)
    const latest = {};
    rounds.forEach(r => { if (!latest[r.code]) latest[r.code] = r; });

    const data = ['TH_GOV', 'LA_GOV', 'VN_HAN', 'VN_HAN_SP', 'VN_HAN_VIP'].map(code => ({
      code,
      fetcher: fetcherStatus[code] || {},
      latest: latest[code] || null,
    }));
    res.json({ success: true, data });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── POST /api/admin/auto-results/trigger/:code — manual trigger ─
router.post('/auto-results/trigger/:code', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!['TH_GOV','LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP'].includes(code))
    return res.status(400).json({ success: false, message: `Invalid code: ${code}` });

  // Guard: LA_GOV หยุดเสาร์-อาทิตย์ (ป้องกัน fetch วันหยุด → record ซ้ำ)
  if (code === 'LA_GOV') {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const dow = now.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) {
      return res.json({ success: false, message: 'หวยลาวหยุดวันเสาร์-อาทิตย์ ไม่มีผลออก' });
    }
  }

  try {
    const { triggerFetch } = require('../services/lotteryFetcher');
    const ok = await triggerFetch(code);
    res.json({ success: ok, message: ok ? `Fetch สำเร็จ: ${code}` : `Fetch ล้มเหลว: ${code} (ดู server log)` });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── POST /api/admin/auto-results/test/:code — dry-run scraper (ไม่บันทึก DB) ──────
router.post('/auto-results/test/:code', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!['TH_GOV','LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP'].includes(code))
    return res.status(400).json({ success: false, message: `Invalid code: ${code}` });
  try {
    const { testFetch } = require('../services/lotteryFetcher');
    const result = await testFetch(code);
    if (!result) return res.json({ success: false, message: 'scraper ไม่พบข้อมูล (ยังไม่ออกผล หรือ fetch ล้มเหลว)', data: null });
    res.json({ success: true, message: `ดึงผลสำเร็จ (dry-run — ไม่บันทึก DB)`, data: result });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/admin/auto-results/tnews-debug — debug TNews article parse ──────
router.get('/auto-results/tnews-debug', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  try {
    const { debugTNewsRaw } = require('../services/lotteryFetcher');
    const result = await debugTNewsRaw();
    res.json(result);
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/admin/debug/bets-schema — show actual bets table columns ───────
router.get('/debug/bets-schema', authAdmin, async (req, res) => {
  try {
    const { query } = require('../config/db');
    const cols = await query('SHOW COLUMNS FROM bets');
    const indexes = await query('SHOW INDEX FROM bets');
    res.json({ success: true, columns: cols, indexes });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/admin/debug/table-schema/:table — show any table columns ────────
router.get('/debug/table-schema/:table', authAdmin, async (req, res) => {
  const allowed = ['bets','transactions','members','commissions','deposits','withdrawals','lottery_rounds','lottery_types','number_limits'];
  const tbl = req.params.table;
  if (!allowed.includes(tbl)) return res.status(400).json({ success: false, message: 'Table not allowed' });
  try {
    const { query } = require('../config/db');
    const cols = await query(`SHOW COLUMNS FROM \`${tbl}\``);
    res.json({ success: true, table: tbl, columns: cols.map(c => c.Field) });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/admin/auto-results/press-debug — debug press.in.th parse ──────
router.get('/auto-results/press-debug', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  try {
    const { debugPressInTh } = require('../services/lotteryFetcher');
    const result = await debugPressInTh();
    res.json(result);
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── POST /api/admin/auto-results/force-announce/:code — บันทึกผลตรงๆ ไม่ผ่าน transaction ─
// ใช้ pool.query() แทน conn.execute() เพื่อหลีกเลี่ยง prepared-statement bug
router.post('/auto-results/force-announce/:code', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!['TH_GOV','LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP'].includes(code))
    return res.status(400).json({ success: false, message: `Invalid code: ${code}` });

  try {
    const { query, queryOne } = require('../config/db');
    const { debugTNewsRaw } = require('../services/lotteryFetcher');

    // 1. หา closed round
    const round = await queryOne(
      `SELECT lr.id, lr.round_name
       FROM lottery_rounds lr
       JOIN lottery_types lt ON lr.lottery_id = lt.id
       WHERE lt.code = ?
         AND lr.status = 'closed'
         AND NOT EXISTS (SELECT 1 FROM lottery_results res WHERE res.round_id = lr.id)
       ORDER BY lr.close_at DESC LIMIT 1`,
      [code]
    );
    if (!round) return res.status(404).json({ success: false, message: `${code}: ไม่พบงวดที่ปิดรับและยังไม่มีผล` });

    // 2. ดึงผลจาก TNews (force clear cache)
    const tnews = await debugTNewsRaw();
    if (!tnews.parsedData || !tnews.parsedData[code])
      return res.status(404).json({ success: false, message: `TNews: ไม่พบ section ${code}`, tnews });

    const r = tnews.parsedData[code];
    const { prize_1st, prize_last_2, prize_2bot, prize_front_3 = [], prize_last_3 = [] } = r;

    // 3. Insert lottery_results
    await query(
      `INSERT INTO lottery_results
         (round_id, prize_1st, prize_last_2, prize_2bot, prize_front_3, prize_last_3, announced_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [round.id, prize_1st, prize_last_2, prize_2bot || null,
       JSON.stringify(prize_front_3), JSON.stringify(prize_last_3)]
    );

    // 4. อัปเดต round status → announced
    await query("UPDATE lottery_rounds SET status='announced' WHERE id=?", [round.id]);

    res.json({
      success: true,
      message: `บันทึกผล ${code} สำเร็จ: ${prize_1st} (งวด: ${round.round_name})`,
      prize_1st, prize_last_2, prize_2bot,
      round_id: round.id, round_name: round.round_name,
    });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── DELETE /api/admin/lottery-result/:id — ลบผลรางวัล + reset round (by result_id) ─
router.delete('/lottery-result/:id', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  const resultId = parseInt(req.params.id);
  if (!resultId) return res.status(400).json({ success: false, message: 'Invalid result id' });
  try {
    const [row] = await query('SELECT round_id FROM lottery_results WHERE id=?', [resultId]);
    if (!row) return res.status(404).json({ success: false, message: `ไม่พบ result id=${resultId}` });
    const roundId = row.round_id;
    await query('DELETE FROM lottery_results WHERE id=?', [resultId]);
    await query("UPDATE lottery_rounds SET status='closed' WHERE id=?", [roundId]);
    res.json({ success: true, message: `ลบ result id=${resultId}, reset round id=${roundId} → closed` });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── DELETE /api/admin/lottery-round/:roundId/result — ลบผลรางวัลโดย round_id ─
router.delete('/lottery-round/:roundId/result', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  const roundId = parseInt(req.params.roundId);
  if (!roundId) return res.status(400).json({ success: false, message: 'Invalid round id' });
  try {
    const [res_] = await query('SELECT id FROM lottery_results WHERE round_id=?', [roundId]);
    if (!res_) return res.status(404).json({ success: false, message: `ไม่พบ result สำหรับ round_id=${roundId}` });
    await query('DELETE FROM lottery_results WHERE round_id=?', [roundId]);
    await query("UPDATE lottery_rounds SET status='closed' WHERE id=?", [roundId]);
    res.json({ success: true, message: `ลบ result (round_id=${roundId}), reset round → closed` });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── POST /api/admin/seed-history — เพิ่มงวดย้อนหลัง (Superadmin) ─
router.post('/seed-history', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  try {
    // Run inline (ไม่ spawn process — ใช้ module เดียวกัน)
    const path   = require('path');
    const mysql  = require('mysql2/promise');

    const HISTORY = [
      { code:'TH_GOV',     round_code:'TH_GOV-20260401',     round_name:'งวดวันที่ 1 เมษายน 2569',                     draw_date:'2026-04-01', close_at:'2026-04-01 14:30:00', announced_at:'2026-04-01 15:30:00', total_bet:158000, total_win:73500,  bet_count:312, prize_1st:'916894', prize_last_2:'17', prize_front_3:['293','635'], prize_last_3:['149','274'] },
      { code:'TH_GOV',     round_code:'TH_GOV-20260416',     round_name:'งวดวันที่ 16 เมษายน 2569',                    draw_date:'2026-04-16', close_at:'2026-04-16 14:30:00', announced_at:'2026-04-16 15:30:00', total_bet:214000, total_win:98500, bet_count:427, prize_1st:'309612', prize_last_2:'77', prize_front_3:['355','108'], prize_last_3:['868','424'] },
      // ลาวพัฒนา 6 หลัก: 2bot=slice(2,4)='98', 2top=prize_last_2=slice(4,6)='13', 3top=slice(3,6)='813'
      { code:'LA_GOV',     round_code:'LA_GOV-20260413',     round_name:'ลาวพัฒนา งวดวันที่ 13 เมษายน 2569',           draw_date:'2026-04-13', close_at:'2026-04-13 20:00:00', announced_at:'2026-04-13 20:45:00', total_bet:42500,  total_win:18200,  bet_count:98,  prize_1st:'129813', prize_last_2:'13', prize_2bot:'98', prize_front_3:[], prize_last_3:['813'] },
      // ฮานอย: prize_1st=GDB(5หลัก), prize_last_2=2ตัวบน(last2 ของ GDB), prize_2bot=2ตัวล่าง(last2 ของ G1), prize_last_3=3ตัวบน
      { code:'VN_HAN',     round_code:'VN_HAN-20260416',     round_name:'ฮานอยปกติ งวดวันที่ 16 เมษายน 2569',            draw_date:'2026-04-16', close_at:'2026-04-16 18:15:00', announced_at:'2026-04-16 18:45:00', total_bet:35000,  total_win:14700,  bet_count:76,  prize_1st:'72638', prize_last_2:'38', prize_2bot:'25', prize_front_3:[], prize_last_3:['638'] },
      { code:'VN_HAN_SP',  round_code:'VN_HAN_SP-20260416',  round_name:'ฮานอยพิเศษ งวดวันที่ 16 เมษายน 2569',          draw_date:'2026-04-16', close_at:'2026-04-16 17:00:00', announced_at:'2026-04-16 17:35:00', total_bet:21000,  total_win:8900,   bet_count:48,  prize_1st:'54219', prize_last_2:'19', prize_2bot:'63', prize_front_3:[], prize_last_3:['219'] },
      { code:'VN_HAN_VIP', round_code:'VN_HAN_VIP-20260416', round_name:'ฮานอย VIP งวดวันที่ 16 เมษายน 2569',           draw_date:'2026-04-16', close_at:'2026-04-16 16:30:00', announced_at:'2026-04-16 17:05:00', total_bet:18500,  total_win:7600,   bet_count:41,  prize_1st:'83475', prize_last_2:'75', prize_2bot:'12', prize_front_3:[], prize_last_3:['475'] },
      { code:'TH_STK',     round_code:'TH_STK-20260416',     round_name:'งวดวันที่ 16 เมษายน 2569',                    draw_date:'2026-04-16', close_at:'2026-04-16 17:00:00', announced_at:'2026-04-16 17:30:00', total_bet:29500,  total_win:11200,  bet_count:65,  prize_1st:'438712', prize_last_2:'12', prize_front_3:[], prize_last_3:['712'] },
      { code:'CN_STK', round_code:'CN_STK-20260415', round_name:'งวดวันที่ 15 เมษายน 2569', draw_date:'2026-04-15', close_at:'2026-04-15 15:30:00', announced_at:'2026-04-15 16:00:00', total_bet:22000,  total_win:8900,   bet_count:51,  prize_1st:'307524', prize_last_2:'24', prize_front_3:[], prize_last_3:['524'] },
      { code:'MY_STK', round_code:'MY_STK-20260416', round_name:'งวดวันที่ 16 เมษายน 2569', draw_date:'2026-04-16', close_at:'2026-04-16 17:30:00', announced_at:'2026-04-16 18:00:00', total_bet:18500,  total_win:7200,   bet_count:43,  prize_1st:'619083', prize_last_2:'83', prize_front_3:[], prize_last_3:['083'] },
      { code:'SG_STK', round_code:'SG_STK-20260415', round_name:'งวดวันที่ 15 เมษายน 2569', draw_date:'2026-04-15', close_at:'2026-04-15 18:00:00', announced_at:'2026-04-15 18:30:00', total_bet:16000,  total_win:6100,   bet_count:38,  prize_1st:'524167', prize_last_2:'67', prize_front_3:[], prize_last_3:['167'] },
    ];

    // Get lottery_type map (unique codes)
    const codes = [...new Set(HISTORY.map(h => h.code))];
    const typeRows = await query(
      `SELECT id, code FROM lottery_types WHERE code IN (${codes.map(()=>'?').join(',')})`,
      codes
    );
    const typeMap = {};
    typeRows.forEach(r => { typeMap[r.code] = r.id; });

    const results = [];
    for (const h of HISTORY) {
      const lotteryId = typeMap[h.code];
      if (!lotteryId) { results.push({ code: h.code, status: 'skip', reason: 'lottery_type not found' }); continue; }
      try {
        // Insert round (skip if exists)
        const rRes = await query(
          `INSERT IGNORE INTO lottery_rounds (uuid, lottery_id, round_code, round_name, draw_date, close_at, status, total_bet, total_win, bet_count)
           VALUES (UUID(), ?, ?, ?, ?, ?, 'announced', ?, ?, ?)`,
          [lotteryId, h.round_code, h.round_name, h.draw_date, h.close_at, h.total_bet, h.total_win, h.bet_count]
        );
        // หา round_id ไม่ว่าจะ insert ใหม่หรือมีอยู่แล้ว
        let roundId = rRes.insertId;
        if (!roundId) {
          const existing = await query('SELECT id FROM lottery_rounds WHERE round_code=? LIMIT 1', [h.round_code]);
          roundId = existing[0]?.id;
        }
        if (!roundId) { results.push({ code: h.code, status: 'error', reason: 'cannot find round_id' }); continue; }

        // Upsert result — ถ้ามีอยู่แล้วให้ UPDATE ด้วยข้อมูลล่าสุด (แก้ผลที่ผิดได้)
        // prize_2bot: ลาวพัฒนา = slice(2,4), ฮานอย = last 2 ของ G1 (ถ้ามี)
        const prize2bot = h.prize_2bot || null;
        await query(
          `INSERT INTO lottery_results (round_id, prize_1st, prize_last_2, prize_2bot, prize_front_3, prize_last_3, announced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             prize_1st=VALUES(prize_1st), prize_last_2=VALUES(prize_last_2),
             prize_2bot=VALUES(prize_2bot),
             prize_front_3=VALUES(prize_front_3), prize_last_3=VALUES(prize_last_3),
             announced_at=VALUES(announced_at)`,
          [roundId, h.prize_1st, h.prize_last_2, prize2bot, JSON.stringify(h.prize_front_3), JSON.stringify(h.prize_last_3), h.announced_at]
        );
        results.push({ code: h.code, status: 'ok', round_name: h.round_name, prize_1st: h.prize_1st });
      } catch(e) {
        results.push({ code: h.code, status: 'error', reason: e.message });
      }
    }

    const ok   = results.filter(r => r.status === 'ok').length;
    const skip = results.filter(r => r.status === 'skip').length;
    const fail = results.filter(r => r.status === 'error').length;

    res.json({
      success: fail === 0,
      message: `เสร็จสิ้น: เพิ่ม ${ok} งวด, ข้าม ${skip} งวด (มีอยู่แล้ว), ผิดพลาด ${fail} งวด`,
      results,
    });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  AGENT WALLET MANAGEMENT — Admin จัดการฝาก/ถอนของ Agent
// ═══════════════════════════════════════════════════════════════════

// ── GET /api/admin/agent-deposits ────────────────────────────────
router.get('/agent-deposits', authAdmin, rbac.requirePerm('finance.view'), async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const lim = Number(limit);
  const offset = (Number(page) - 1) * lim;
  const where = status ? `WHERE ad.status = ?` : '';
  const params = status ? [status, lim, offset] : [lim, offset];

  const { pool } = require('../config/db');
  const [rows] = await pool.query(
    `SELECT ad.*, COALESCE(a.name,'(unknown)') AS agent_name, a.phone AS agent_phone
     FROM agent_deposits ad
     LEFT JOIN agents a ON ad.agent_id = a.id
     ${where}
     ORDER BY ad.id DESC LIMIT ? OFFSET ?`,
    params
  );
  const [[totalRow]] = await pool.query(
    `SELECT COUNT(*) cnt FROM agent_deposits ad ${where}`,
    status ? [status] : []
  );
  res.json({ success: true, data: rows, total: Number(totalRow.cnt) });
});

// ── POST /api/admin/agent-deposits/:id/approve ───────────────────
router.post('/agent-deposits/:id/approve', authAdmin, rbac.requirePerm('finance.manage'), async (req, res) => {
  const depId = Number(req.params.id);
  const [dep] = await query(
    'SELECT ad.*, a.name agent_name, a.phone agent_phone, a.bank_code a_bank_code FROM agent_deposits ad LEFT JOIN agents a ON ad.agent_id=a.id WHERE ad.id=? AND ad.status="pending"',
    [depId]
  );
  if (!dep) return res.status(404).json({ success: false, message: 'ไม่พบคำขอหรืออนุมัติแล้ว' });

  await transaction(async (conn) => {
    await conn.execute(
      'UPDATE agent_deposits SET status="approved", approved_by=?, approved_at=NOW() WHERE id=?',
      [req.admin.id, depId]
    );
    const [[agent]] = await conn.execute(
      'SELECT balance FROM agents WHERE id=? FOR UPDATE', [dep.agent_id]
    );
    const newBal = parseFloat(agent.balance) + parseFloat(dep.amount);
    await conn.execute('UPDATE agents SET balance=? WHERE id=?', [newBal, dep.agent_id]);
    await conn.execute(
      'INSERT INTO agent_transactions (uuid, agent_id, type, amount, balance_before, balance_after, description) VALUES (?,?,?,?,?,?,?)',
      [require('uuid').v4(), dep.agent_id, 'deposit', dep.amount, agent.balance, newBal,
       `Admin อนุมัติฝากเงิน #${dep.id}`]
    );
  });
  // LINE notification
  require('../services/lineService').sendAgentDepositNotif({ agentName: dep.agent_name, phone: dep.agent_phone, amount: dep.amount, bank_code: dep.a_bank_code || dep.bank_code, status: 'approved', adminName: req.admin.name }).catch(e => console.error('[LINE] agent deposit approve notif error:', e.message));
  res.json({ success: true, message: 'อนุมัติฝากเงินสำเร็จ' });
});

// ── POST /api/admin/agent-deposits/:id/reject ────────────────────
router.post('/agent-deposits/:id/reject', authAdmin, rbac.requirePerm('finance.manage'), async (req, res) => {
  const { note } = req.body;
  const depId = Number(req.params.id);
  const [dep] = await query(
    'SELECT ad.*, a.name agent_name, a.phone agent_phone FROM agent_deposits ad LEFT JOIN agents a ON ad.agent_id=a.id WHERE ad.id=? AND ad.status="pending"',
    [depId]
  );
  await query(
    'UPDATE agent_deposits SET status="rejected", reject_note=?, approved_by=?, approved_at=NOW() WHERE id=? AND status="pending"',
    [note || null, req.admin.id, depId]
  );
  // LINE notification
  if (dep) require('../services/lineService').sendAgentDepositNotif({ agentName: dep.agent_name, phone: dep.agent_phone, amount: dep.amount, status: 'rejected', note, adminName: req.admin.name }).catch(e => console.error('[LINE] agent deposit reject notif error:', e.message));
  res.json({ success: true, message: 'ปฏิเสธคำขอฝากเงินแล้ว' });
});

// ── GET /api/admin/agent-withdrawals ─────────────────────────────
router.get('/agent-withdrawals', authAdmin, rbac.requirePerm('finance.view'), async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const lim = Number(limit);
  const offset = (Number(page) - 1) * lim;
  const where = status ? `WHERE aw.status = ?` : '';
  const params = status ? [status, lim, offset] : [lim, offset];

  // ใช้ pool.query (ไม่ใช่ execute) เพื่อหลีกเลี่ยงปัญหา prepared statement กับ SELECT *
  const { pool } = require('../config/db');
  const [rows] = await pool.query(
    `SELECT aw.*, COALESCE(a.name,'(unknown)') AS agent_name, a.phone AS agent_phone
     FROM agent_withdrawals aw
     LEFT JOIN agents a ON aw.agent_id = a.id
     ${where}
     ORDER BY aw.id DESC LIMIT ? OFFSET ?`,
    params
  );
  const [[totalRow]] = await pool.query(
    `SELECT COUNT(*) cnt FROM agent_withdrawals aw ${where}`,
    status ? [status] : []
  );
  res.json({ success: true, data: rows, total: Number(totalRow.cnt) });
});

// ── POST /api/admin/agent-withdrawals/:id/approve ────────────────
router.post('/agent-withdrawals/:id/approve', authAdmin, rbac.requirePerm('finance.manage'), async (req, res) => {
  const wdId = Number(req.params.id);
  const [wd] = await query(
    `SELECT aw.*, a.name AS agent_name, a.phone AS agent_phone
     FROM agent_withdrawals aw
     JOIN agents a ON aw.agent_id = a.id
     WHERE aw.id=? AND aw.status="pending"`,
    [wdId]
  );
  if (!wd) return res.status(404).json({ success: false, message: 'ไม่พบคำขอหรืออนุมัติแล้ว' });

  await transaction(async (conn) => {
    const [[agent]] = await conn.execute(
      'SELECT balance FROM agents WHERE id=? FOR UPDATE', [wd.agent_id]
    );
    if (parseFloat(agent.balance) < parseFloat(wd.amount))
      throw new Error('ยอดเงินไม่เพียงพอ');
    const newBal = parseFloat(agent.balance) - parseFloat(wd.amount);
    await conn.execute('UPDATE agents SET balance=? WHERE id=?', [newBal, wd.agent_id]);
    await conn.execute(
      'UPDATE agent_withdrawals SET status="completed", processed_by=?, processed_at=NOW() WHERE id=?',
      [req.admin.id, wdId]
    );
    await conn.execute(
      'INSERT INTO agent_transactions (uuid, agent_id, type, amount, balance_before, balance_after, description) VALUES (?,?,?,?,?,?,?)',
      [require('uuid').v4(), wd.agent_id, 'withdraw', wd.amount, agent.balance, newBal,
       `Admin อนุมัติถอนเงิน #${wd.id}`]
    );
  });

  require('../services/lineService').sendAgentWithdrawNotif({
    agentName  : wd.agent_name,
    phone      : wd.agent_phone,
    amount     : wd.amount,
    bank_code  : wd.bank_code,
    bank_account: wd.bank_account,
    bank_name  : wd.bank_name,
    status     : 'approved',
    adminName  : req.admin.name,
  }).catch(e => console.error('[LINE] agent withdraw approve notif error:', e.message));

  res.json({ success: true, message: 'อนุมัติถอนเงินสำเร็จ' });
});

// ── POST /api/admin/agent-withdrawals/:id/reject ─────────────────
router.post('/agent-withdrawals/:id/reject', authAdmin, rbac.requirePerm('finance.manage'), async (req, res) => {
  const { note } = req.body;
  const wdId = Number(req.params.id);

  const [wd] = await query(
    `SELECT aw.*, a.name AS agent_name, a.phone AS agent_phone
     FROM agent_withdrawals aw
     JOIN agents a ON aw.agent_id = a.id
     WHERE aw.id=? AND aw.status="pending"`,
    [wdId]
  );

  await query(
    'UPDATE agent_withdrawals SET status="rejected", reject_note=?, processed_by=?, processed_at=NOW() WHERE id=? AND status="pending"',
    [note || null, req.admin.id, wdId]
  );

  if (wd) require('../services/lineService').sendAgentWithdrawNotif({
    agentName  : wd.agent_name,
    phone      : wd.agent_phone,
    amount     : wd.amount,
    bank_code  : wd.bank_code,
    bank_account: wd.bank_account,
    bank_name  : wd.bank_name,
    status     : 'rejected',
    note,
    adminName  : req.admin.name,
  }).catch(e => console.error('[LINE] agent withdraw reject notif error:', e.message));

  res.json({ success: true, message: 'ปฏิเสธคำขอถอนเงินแล้ว' });
});

// ══════════════════════════════════════
//  REFERRAL COMMISSION MANAGEMENT
// ══════════════════════════════════════

// GET /api/admin/referral/stats — ข้อมูลระบบแนะนำ + global rate
router.get('/referral/stats', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  const safe = async (sql, fallback, params = []) => {
    try { const [r] = await query(sql, params); return r ?? fallback; }
    catch { return fallback; }
  };
  const safeAll = async (sql, params = []) => {
    try { return await query(sql, params); }
    catch { return []; }
  };

  const [rateSetting, summary, topEarners, recentComms, agentReferrals, memberReferrals] = await Promise.all([
    safe("SELECT value FROM settings WHERE `key`='referral_commission'", { value: '0' }),
    safe(`SELECT
      COALESCE(SUM(amount),0) AS total_all,
      COALESCE(SUM(CASE WHEN MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW()) THEN amount END),0) AS total_month,
      COUNT(DISTINCT from_member_id) AS unique_bettors,
      COUNT(*) AS total_records,
      COUNT(DISTINCT CASE WHEN earner_type='member' THEN earner_id END) AS member_earners,
      COUNT(DISTINCT CASE WHEN earner_type='agent' THEN earner_id END) AS agent_earners
    FROM commissions`, { total_all:0, total_month:0, unique_bettors:0, total_records:0, member_earners:0, agent_earners:0 }),
    safeAll(`SELECT
      earner_type, earner_id,
      CASE WHEN earner_type='member' THEN (SELECT name FROM members WHERE id=c.earner_id)
           ELSE (SELECT name FROM agents WHERE id=c.earner_id) END AS earner_name,
      SUM(amount) AS total, COUNT(*) AS cnt
      FROM commissions c
      GROUP BY earner_type, earner_id
      ORDER BY total DESC LIMIT 10`),
    safeAll(`SELECT c.*,
      CASE WHEN c.earner_type='member' THEN (SELECT name FROM members WHERE id=c.earner_id)
           ELSE (SELECT name FROM agents WHERE id=c.earner_id) END AS earner_name,
      (SELECT name FROM members WHERE id=c.from_member_id) AS from_name
      FROM commissions c
      ORDER BY c.id DESC LIMIT 50`),
    // สมาชิกที่สมัครผ่าน Agent (agent_id ถูกตั้งค่า)
    safeAll(`SELECT m.id, m.name, m.phone, m.member_code, m.status, m.balance, m.created_at,
      a.name AS agent_name, a.phone AS agent_phone,
      COALESCE((SELECT SUM(amount) FROM commissions WHERE earner_type='agent' AND earner_id=a.id AND from_member_id=m.id),0) AS commission_paid
      FROM members m
      JOIN agents a ON m.agent_id = a.id
      ORDER BY m.created_at DESC LIMIT 100`),
    // สมาชิกที่สมัครผ่านสมาชิกอื่น (ref_by ถูกตั้งค่า)
    safeAll(`SELECT m.id, m.name, m.phone, m.member_code, m.status, m.balance, m.created_at,
      r.name AS ref_name, r.phone AS ref_phone, r.member_code AS ref_code,
      COALESCE((SELECT SUM(amount) FROM commissions WHERE earner_type='member' AND earner_id=r.id AND from_member_id=m.id),0) AS commission_paid
      FROM members m
      JOIN members r ON m.ref_by = r.id
      ORDER BY m.created_at DESC LIMIT 100`)
  ]);

  // นับสมาชิกสมัครผ่าน agent + member referral
  const agentRefCount  = agentReferrals.length;
  const memberRefCount = memberReferrals.length;

  res.json({
    success: true,
    data: {
      global_rate: parseFloat(rateSetting?.value || 0),
      summary: { ...summary, agent_ref_count: agentRefCount, member_ref_count: memberRefCount },
      top_earners: topEarners,
      recent_commissions: recentComms,
      agent_referrals: agentReferrals,
      member_referrals: memberReferrals,
    }
  });
});

// PATCH /api/admin/referral/rate — ตั้งค่า global referral commission rate
router.patch('/referral/rate', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  const rate = parseFloat(req.body.rate);
  if (isNaN(rate) || rate < 0 || rate > 50)
    return res.status(400).json({ success: false, message: 'rate ต้องอยู่ระหว่าง 0–50' });

  await query(
    "INSERT INTO settings (`key`, value) VALUES ('referral_commission', ?) ON DUPLICATE KEY UPDATE value=?",
    [String(rate), String(rate)]
  );
  await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
    [req.admin.id, 'settings.referral_rate', 'settings', 0, `rate=${rate}%`, req.ip]);

  res.json({ success: true, message: `ตั้งค่าอัตราค่าคอมแนะนำ ${rate}% สำเร็จ` });
});

// ══════════════════════════════════════
//  MEMBER LEVELS — ตั้งค่าระดับสมาชิก
// ══════════════════════════════════════

// GET /api/admin/member-levels
router.get('/member-levels', authAdmin, async (req, res) => {
  const rows = await query('SELECT * FROM member_levels ORDER BY min_total_bet ASC');
  res.json({ success: true, data: rows });
});

// POST /api/admin/member-levels — สร้างหรืออัปเดต level (upsert by level_num)
router.post('/member-levels', authAdmin, async (req, res) => {
  const { level_num, name, min_total_bet, color, icon, benefits } = req.body;
  if (!level_num || !name || min_total_bet == null)
    return res.status(400).json({ success: false, message: 'level_num, name, min_total_bet จำเป็น' });

  const result = await query(
    `INSERT INTO member_levels (level_num, name, min_total_bet, color, icon, benefits)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), min_total_bet=VALUES(min_total_bet),
       color=VALUES(color), icon=VALUES(icon), benefits=VALUES(benefits)`,
    [level_num, name, parseFloat(min_total_bet), color || '#cd7f32', icon || '🎖️', benefits || null]
  );
  res.json({ success: true, message: 'บันทึกแล้ว', id: result.insertId || null });
});

// PATCH /api/admin/member-levels/:id
router.patch('/member-levels/:id', authAdmin, async (req, res) => {
  const allowed = ['name','min_total_bet','color','icon','benefits'];
  const sets = []; const params = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { sets.push(`${k}=?`); params.push(req.body[k]); }
  }
  if (!sets.length) return res.status(400).json({ success: false, message: 'ไม่มีฟิลด์ที่จะอัปเดต' });
  params.push(parseInt(req.params.id));
  await query(`UPDATE member_levels SET ${sets.join(',')} WHERE id=?`, params);
  res.json({ success: true, message: 'อัปเดตแล้ว' });
});

// DELETE /api/admin/member-levels/:id
router.delete('/member-levels/:id', authAdmin, async (req, res) => {
  await query('DELETE FROM member_levels WHERE id=?', [parseInt(req.params.id)]);
  res.json({ success: true, message: 'ลบแล้ว' });
});

// ═══════════════════════════════════════════════════════════════════
//  ADMIN BANK ACCOUNTS — บัญชีธนาคารของร้าน (รับฝากเงิน)
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/bank-accounts/public — no auth, for deposit modal
router.get('/bank-accounts/public', async (req, res) => {
  try {
    const rows = await query(
      'SELECT id, bank_code, bank_account, account_name, promptpay, note FROM admin_bank_accounts WHERE is_active=1 ORDER BY sort_order ASC, id ASC'
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: true, data: [] });
  }
});

// GET /api/admin/bank-accounts
router.get('/bank-accounts', authAdmin, rbac.requirePerm('settings.view'), async (req, res) => {
  const rows = await query('SELECT * FROM admin_bank_accounts ORDER BY sort_order ASC, id ASC');
  res.json({ success: true, data: rows });
});

// POST /api/admin/bank-accounts
router.post('/bank-accounts', authAdmin, rbac.requirePerm('settings.manage'),
  body('bank_code').notEmpty(), body('bank_account').notEmpty(), body('account_name').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, message: errors.array()[0].msg });
    const { bank_code, bank_account, account_name, promptpay = null, note = null, sort_order = 0, is_active = 1 } = req.body;
    await query(
      'INSERT INTO admin_bank_accounts (bank_code, bank_account, account_name, promptpay, note, sort_order, is_active) VALUES (?,?,?,?,?,?,?)',
      [bank_code, bank_account, account_name, promptpay || null, note || null, parseInt(sort_order) || 0, is_active ? 1 : 0]
    );
    await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
      [req.admin.id, 'bank_account.add', `${bank_code} ${bank_account} (${account_name})`, req.ip]);
    res.status(201).json({ success: true, message: 'เพิ่มบัญชีธนาคารแล้ว' });
  }
);

// PATCH /api/admin/bank-accounts/:id
router.patch('/bank-accounts/:id', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  const allowed = ['bank_code', 'bank_account', 'account_name', 'promptpay', 'note', 'sort_order', 'is_active'];
  const sets = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`\`${key}\`=?`);
      params.push(req.body[key] === '' ? null : req.body[key]);
    }
  }
  if (!sets.length) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่จะอัพเดท' });
  params.push(req.params.id);
  await query(`UPDATE admin_bank_accounts SET ${sets.join(',')} WHERE id=?`, params);
  await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
    [req.admin.id, 'bank_account.update', `id=${req.params.id}`, req.ip]);
  res.json({ success: true, message: 'อัพเดทบัญชีธนาคารแล้ว' });
});

// DELETE /api/admin/bank-accounts/:id
router.delete('/bank-accounts/:id', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  await query('DELETE FROM admin_bank_accounts WHERE id=?', [parseInt(req.params.id)]);
  res.json({ success: true, message: 'ลบบัญชีธนาคารแล้ว' });
});

module.exports = router;
