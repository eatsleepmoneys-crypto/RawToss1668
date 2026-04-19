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
  const { round_id, limit = 50 } = req.query;
  let sql = `
    SELECT h.id, h.number, h.bet_count, h.total_amount, h.max_payout,
           lt.name AS lottery_type, bt.name AS bet_type,
           lr.draw_date, lr.status AS round_status,
           h.updated_at
    FROM hot_numbers h
    JOIN lottery_types lt ON h.lottery_type_id = lt.id
    JOIN bet_types bt ON h.bet_type_id = bt.id
    JOIN lottery_rounds lr ON h.round_id = lr.id
  `;
  const params = [];
  if (round_id) { sql += ' WHERE h.round_id=?'; params.push(parseInt(round_id)); }
  sql += ` ORDER BY h.total_amount DESC LIMIT ${Math.min(parseInt(limit)||50, 200)}`;
  const data = await query(sql, params);
  res.json({ success: true, data });
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
             res.prize_1st, res.prize_last_2, res.announced_at
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

module.exports = router;
