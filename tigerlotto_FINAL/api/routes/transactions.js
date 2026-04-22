const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { authMember, authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');

// ─── Multer (slip upload) ─────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename:    (req, file, cb) => cb(null, `slip_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5242880 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpg|jpeg|png|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพ (jpg, png, webp)'));
  },
});

// ══════════════════════════════
//  DEPOSIT
// ══════════════════════════════

// POST /api/transactions/deposit — member submit deposit
router.post('/deposit', authMember, upload.single('slip'),
  body('amount').isFloat({ min: 1 }),
  body('bank_code').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { amount, bank_code, transfer_at } = req.body;

    // ── ดึงข้อมูลบัญชีธนาคารของสมาชิก ───────────────────────────
    const [member] = await query(
      'SELECT bank_code, bank_account, bank_name FROM members WHERE id=?',
      [req.member.id]
    );

    // ── บล็อกถ้าไม่มีบัญชีลงทะเบียน (default: เปิดใช้งาน) ───────
    const reqBankRow = await query("SELECT value FROM settings WHERE `key`='require_sender_bank' LIMIT 1");
    const requireBank = reqBankRow[0]?.value !== 'false'; // default true
    if (requireBank && !member?.bank_account) {
      return res.status(400).json({
        success : false,
        message : 'กรุณาผูกบัญชีธนาคารก่อนฝากเงิน — ติดต่อ Admin เพื่อเพิ่มบัญชี',
        code    : 'NO_BANK_ACCOUNT',
      });
    }

    // Check min/max
    const minRow = await query('SELECT value FROM settings WHERE `key`="min_deposit"');
    const maxRow = await query('SELECT value FROM settings WHERE `key`="max_deposit"');
    const min = parseFloat(minRow[0]?.value || 100);
    const max = parseFloat(maxRow[0]?.value || 100000);
    if (amount < min) return res.status(400).json({ success: false, message: `ฝากขั้นต่ำ ฿${min}` });
    if (amount > max) return res.status(400).json({ success: false, message: `ฝากสูงสุด ฿${max.toLocaleString()}` });

    const slipImage = req.file?.filename || null;
    const slipPath  = slipImage ? require('path').join(process.env.UPLOAD_DIR || './uploads', slipImage) : null;

    // ── SlipOK Verification ──────────────────────────────────────
    let verifyStatus = 'skipped';
    let verifyData   = null;
    let transRef     = null;
    let depositNote  = null;  // หมายเหตุสำหรับ Admin

    if (slipPath) {
      try {
        const { verifySlip, REASON_TH } = require('../services/slipVerifier');
        // ส่งข้อมูลบัญชีสมาชิกไปด้วยเพื่อตรวจผู้โอน
        const result = await verifySlip(slipPath, amount, member);

        verifyData = JSON.stringify({ reason: result.reason, ...(result.data ? { data: result.data } : {}) });
        transRef   = result.transRef || null;

        if (result.skip) {
          verifyStatus = 'skipped';

        } else if (result.valid) {
          verifyStatus = 'verified';

        } else {
          verifyStatus = 'failed';

          // ❌ สลิปปลอม / ซ้ำ — ปฏิเสธทันที
          if (result.reason === 'DUPLICATE_SLIP' || result.reason === 'SLIP_INVALID') {
            return res.status(400).json({
              success: false,
              message: REASON_TH[result.reason] || result.reason,
              reason : result.reason,
            });
          }

          // ⚠️ บัญชีผู้โอนไม่ตรง — รอ Admin ตรวจ พร้อมหมายเหตุ
          if (result.reason === 'WRONG_SENDER_ACCOUNT') {
            verifyStatus = 'failed';
            const senderInfo = `${result.senderBank || ''} ${result.senderAccount || '(ไม่ระบุ)'}`.trim();
            const regInfo    = `${result.registeredBank || ''} ${result.registeredAccount || ''}`.trim();
            depositNote = `⚠️ บัญชีผู้โอนไม่ตรง: สลิประบุ [${senderInfo}] | บัญชีลงทะเบียน [${regInfo}]`;
          }
          // amount_mismatch / expired — รอ Admin ตรวจ (ไม่มี note พิเศษ)
        }
      } catch (verifyErr) {
        verifyStatus = 'error';
        verifyData   = JSON.stringify({ reason: 'EXCEPTION', error: verifyErr.message });
      }
    }

    // Insert deposit record
    const [result] = await query(
      `INSERT INTO deposits
         (uuid,member_id,amount,bank_code,slip_image,transfer_at,status,slip_verify_status,slip_verify_data,slip_ref_id,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), req.member.id, amount, bank_code, slipImage,
       transfer_at || new Date(), 'pending',
       verifyStatus, verifyData, transRef, depositNote]
    );

    // ── Auto-approve ─────────────────────────────────────────────
    // Case 1: SlipOK verified → อนุมัติอัตโนมัติทันที
    if (verifyStatus === 'verified') {
      await approveDeposit(result.insertId, req.member.id, amount, null);
      return res.json({
        success : true,
        message : '✅ ตรวจสลิปผ่านแล้ว ฝากเงินสำเร็จ!',
        auto    : true,
        verified: true,
      });
    }

    // Case 2: Auto-approve (legacy setting) — ใช้เมื่อ slipok ไม่ได้ตั้งค่า
    // ไม่ auto-approve ถ้า slipok ตรวจไม่ผ่าน (เช่น WRONG_SENDER_ACCOUNT)
    const autoRow = await query('SELECT value FROM settings WHERE `key`="auto_approve_deposit"');
    const autoMax = await query('SELECT value FROM settings WHERE `key`="auto_approve_max"');
    if (verifyStatus !== 'failed' && autoRow[0]?.value === 'true' && amount <= parseFloat(autoMax[0]?.value || 1000)) {
      await approveDeposit(result.insertId, req.member.id, amount, null);
      return res.json({ success: true, message: 'ฝากเงินสำเร็จ (อนุมัติอัตโนมัติ)', auto: true });
    }

    // Case 3: รอ Admin ตรวจ
    const waitMsg = verifyStatus === 'failed'
      ? '⚠️ ระบบตรวจสลิปไม่ผ่านอัตโนมัติ กำลังรอ Admin ตรวจสอบ'
      : 'ส่งสลิปแล้ว กรุณารอการตรวจสอบ (5-15 นาที)';
    res.status(201).json({ success: true, message: waitMsg, id: result.insertId, verify_status: verifyStatus });
  }
);

// ─── Helper: approve deposit ──────────────────────
async function approveDeposit(depositId, memberId, amount, adminId) {
  await transaction(async (conn) => {
    await conn.execute('UPDATE deposits SET status="approved", approved_by=?, approved_at=NOW() WHERE id=?', [adminId, depositId]);
    const [[m]] = await conn.execute('SELECT balance FROM members WHERE id=? FOR UPDATE', [memberId]);
    const newBal = parseFloat(m.balance) + parseFloat(amount);
    await conn.execute('UPDATE members SET balance=?, total_deposit=total_deposit+? WHERE id=?', [newBal, amount, memberId]);
    await conn.execute('INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
      [uuidv4(), memberId, 'deposit', amount, m.balance, newBal, `ฝากเงิน ฿${amount}`]);
    await conn.execute('INSERT INTO notifications (member_id,title,body,type) VALUES (?,?,?,?)',
      [memberId, '✅ เติมเงินสำเร็จ', `เติมเงิน ฿${parseFloat(amount).toLocaleString()} เรียบร้อย`, 'deposit']);
  });
}

// ══════════════════════════════
//  WITHDRAW
// ══════════════════════════════

// POST /api/transactions/withdraw — member request withdraw
router.post('/withdraw', authMember,
  body('amount').isFloat({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { amount } = req.body;
    const [minR] = await query('SELECT value FROM settings WHERE `key`="min_withdraw"');
    const [maxR] = await query('SELECT value FROM settings WHERE `key`="max_withdraw"');
    const min = parseFloat(minR?.value || 100);
    const max = parseFloat(maxR?.value || 50000);
    if (amount < min) return res.status(400).json({ success: false, message: `ถอนขั้นต่ำ ฿${min}` });
    if (amount > max) return res.status(400).json({ success: false, message: `ถอนสูงสุด ฿${max.toLocaleString()}` });

    // Check pending withdraw
    const [pending] = await query('SELECT id FROM withdrawals WHERE member_id=? AND status IN ("pending","processing")', [req.member.id]);
    if (pending) return res.status(400).json({ success: false, message: 'มีรายการถอนที่รอดำเนินการอยู่' });

    const [m] = await query('SELECT balance, bank_code, bank_account, bank_name FROM members WHERE id=?', [req.member.id]);
    if (!m.bank_account) return res.status(400).json({ success: false, message: 'กรุณาผูกบัญชีธนาคารก่อนถอน' });
    if (parseFloat(m.balance) < amount) return res.status(400).json({ success: false, message: `ยอดเงินไม่เพียงพอ (มี ฿${m.balance})` });

    await transaction(async (conn) => {
      const [[member]] = await conn.execute('SELECT balance FROM members WHERE id=? FOR UPDATE', [req.member.id]);
      const newBal = parseFloat(member.balance) - parseFloat(amount);
      await conn.execute('UPDATE members SET balance=? WHERE id=?', [newBal, req.member.id]);
      await conn.execute('INSERT INTO withdrawals (uuid,member_id,amount,bank_code,bank_account,bank_name,status) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.member.id, amount, m.bank_code, m.bank_account, m.bank_name, 'pending']);
      await conn.execute('INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.member.id, 'withdraw', -amount, member.balance, newBal, `ถอนเงิน ฿${amount}`]);
    });

    res.status(201).json({ success: true, message: 'ส่งคำขอถอนแล้ว กรุณารอ 5-30 นาที' });
  }
);

// GET /api/transactions/history — member wallet history
router.get('/history', authMember, async (req, res) => {
  const { page=1, limit=20, type } = req.query;
  const lim = parseInt(limit) || 20;
  const off = (parseInt(page) - 1) * lim;
  const where = type ? 'AND type=?' : '';
  const params = type ? [req.member.id, type] : [req.member.id];
  const rows = await query(
    `SELECT id,type,amount,balance_after,description,created_at FROM transactions
     WHERE member_id=? ${where} ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`, params);
  const [cnt] = await query(`SELECT COUNT(*) c FROM transactions WHERE member_id=? ${where}`,
    type ? [req.member.id, type] : [req.member.id]);
  res.json({ success: true, data: rows, total: cnt.c });
});

// GET /api/transactions/deposit-status — check deposit status
router.get('/deposit-status', authMember, async (req, res) => {
  const rows = await query(
    'SELECT id,amount,bank_code,status,created_at,approved_at FROM deposits WHERE member_id=? ORDER BY id DESC LIMIT 10',
    [req.member.id]);
  res.json({ success: true, data: rows });
});

// ══════════════════════════════
//  ADMIN: Deposits
// ══════════════════════════════

// GET /api/transactions/admin/deposits
router.get('/admin/deposits', authAdmin, rbac.requirePerm('deposits.view'), async (req, res) => {
  const lim    = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const pg     = Math.max(parseInt(req.query.page) || 1, 1);
  const offset = (pg - 1) * lim;
  const { status, search } = req.query;

  const where = []; const params = [];
  if (status && status !== 'all') { where.push('d.status=?'); params.push(status); }
  if (search)                     { where.push('(m.name LIKE ? OR m.phone LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await query(
    `SELECT d.*,m.name,m.phone,m.bank_name AS member_bank FROM deposits d JOIN members m ON d.member_id=m.id
     ${whereClause} ORDER BY d.id DESC LIMIT ${lim} OFFSET ${offset}`, params);
  const cntRows = await query(
    `SELECT COUNT(*) c, COALESCE(SUM(d.amount),0) total FROM deposits d JOIN members m ON d.member_id=m.id ${whereClause}`, params);
  const cnt = cntRows[0];
  res.json({ success: true, data: rows, total: cnt.c, total_amount: cnt.total, page: pg, limit: lim });
});

// PATCH /api/transactions/admin/deposits/:id/approve
router.patch('/admin/deposits/:id/approve', authAdmin, rbac.requirePerm('deposits.approve'), async (req, res) => {
  const [dep] = await query('SELECT * FROM deposits WHERE id=? AND status="pending"', [req.params.id]);
  if (!dep) return res.status(400).json({ success: false, message: 'ไม่พบรายการหรืออนุมัติแล้ว' });
  await approveDeposit(dep.id, dep.member_id, dep.amount, req.admin.id);
  await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
    [req.admin.id, 'deposit.approve', 'deposit', dep.id, `฿${dep.amount}`, req.ip]);
  res.json({ success: true, message: `อนุมัติฝากเงิน ฿${dep.amount} แล้ว` });
});

// PATCH /api/transactions/admin/deposits/:id/reject
router.patch('/admin/deposits/:id/reject', authAdmin, rbac.requirePerm('deposits.approve'), async (req, res) => {
  const { note } = req.body;
  const [dep] = await query('SELECT * FROM deposits WHERE id=? AND status="pending"', [req.params.id]);
  if (!dep) return res.status(400).json({ success: false, message: 'ไม่พบรายการ' });
  await query('UPDATE deposits SET status="rejected", note=?, approved_by=?, approved_at=NOW() WHERE id=?',
    [note || '', req.admin.id, dep.id]);
  await query('INSERT INTO notifications (member_id,title,body,type) VALUES (?,?,?,?)',
    [dep.member_id, '❌ ฝากเงินไม่สำเร็จ', `รายการฝาก ฿${dep.amount} ถูกปฏิเสธ: ${note||'กรุณาติดต่อ Admin'}`, 'deposit']);
  res.json({ success: true, message: 'ปฏิเสธรายการแล้ว' });
});

// ══════════════════════════════
//  ADMIN: Withdrawals
// ══════════════════════════════

// GET /api/transactions/admin/withdrawals
router.get('/admin/withdrawals', authAdmin, rbac.requirePerm('withdrawals.view'), async (req, res) => {
  const lim    = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const pg     = Math.max(parseInt(req.query.page) || 1, 1);
  const offset = (pg - 1) * lim;
  const { status, search } = req.query;

  const where = []; const params = [];
  if (status && status !== 'all') { where.push('w.status=?'); params.push(status); }
  if (search)                     { where.push('(m.name LIKE ? OR m.phone LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await query(
    `SELECT w.*,m.name,m.phone FROM withdrawals w JOIN members m ON w.member_id=m.id
     ${whereClause} ORDER BY w.id DESC LIMIT ${lim} OFFSET ${offset}`, params);
  const cntRows = await query(
    `SELECT COUNT(*) c, COALESCE(SUM(w.amount),0) total FROM withdrawals w JOIN members m ON w.member_id=m.id ${whereClause}`, params);
  const cnt = cntRows[0];
  res.json({ success: true, data: rows, total: cnt.c, total_amount: cnt.total, page: pg, limit: lim });
});

// PATCH /api/transactions/admin/withdrawals/:id/process
router.patch('/admin/withdrawals/:id/process', authAdmin, rbac.requirePerm('withdrawals.process'), async (req, res) => {
  const { ref_no } = req.body;
  const [wd] = await query('SELECT * FROM withdrawals WHERE id=? AND status IN ("pending","processing")', [req.params.id]);
  if (!wd) return res.status(400).json({ success: false, message: 'ไม่พบรายการ' });
  await query('UPDATE withdrawals SET status="completed", processed_by=?, processed_at=NOW(), ref_no=? WHERE id=?',
    [req.admin.id, ref_no || null, wd.id]);
  await query('UPDATE members SET total_withdraw=total_withdraw+? WHERE id=?', [wd.amount, wd.member_id]);
  await query('INSERT INTO notifications (member_id,title,body,type) VALUES (?,?,?,?)',
    [wd.member_id, '✅ ถอนเงินสำเร็จ', `โอนเงิน ฿${parseFloat(wd.amount).toLocaleString()} เข้าบัญชี ${wd.bank_name} แล้ว`, 'withdraw']);
  await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
    [req.admin.id, 'withdraw.complete', 'withdrawal', wd.id, `฿${wd.amount} ref:${ref_no}`, req.ip]);
  res.json({ success: true, message: `โอนเงิน ฿${wd.amount} สำเร็จ` });
});

// PATCH /api/transactions/admin/withdrawals/:id/reject
router.patch('/admin/withdrawals/:id/reject', authAdmin, rbac.requirePerm('withdrawals.process'), async (req, res) => {
  const { note } = req.body;
  const [wd] = await query('SELECT * FROM withdrawals WHERE id=? AND status="pending"', [req.params.id]);
  if (!wd) return res.status(400).json({ success: false, message: 'ไม่พบรายการ' });
  await transaction(async (conn) => {
    await conn.execute('UPDATE withdrawals SET status="rejected", note=?, processed_by=?, processed_at=NOW() WHERE id=?',
      [note || '', req.admin.id, wd.id]);
    // Refund balance
    const [[m]] = await conn.execute('SELECT balance FROM members WHERE id=? FOR UPDATE', [wd.member_id]);
    const newBal = parseFloat(m.balance) + parseFloat(wd.amount);
    await conn.execute('UPDATE members SET balance=? WHERE id=?', [newBal, wd.member_id]);
    await conn.execute('INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
      [uuidv4(), wd.member_id, 'refund', wd.amount, m.balance, newBal, `คืนเงินถอนที่ถูกปฏิเสธ: ${note}`]);
    await conn.execute('INSERT INTO notifications (member_id,title,body,type) VALUES (?,?,?,?)',
      [wd.member_id, '❌ ถอนเงินไม่สำเร็จ', `รายการถอน ฿${wd.amount} ถูกปฏิเสธ เงินได้คืนในกระเป๋าแล้ว`, 'withdraw']);
  });
  res.json({ success: true, message: 'ปฏิเสธและคืนเงินแล้ว' });
});

module.exports = router;
