const { query, queryOne, transaction } = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');

function refNo(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2,4).toUpperCase()}`;
}

// ── Multer: slip upload ────────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const slipStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `slip_${Date.now()}_${Math.random().toString(36).substr(2,6)}${ext}`);
  },
});
const slipFilter = (_req, file, cb) => {
  if (/^image\/(jpeg|jpg|png|webp)$/.test(file.mimetype)) cb(null, true);
  else cb(new Error('รองรับเฉพาะ jpg/png/webp เท่านั้น'), false);
};
exports.upload = multer({ storage: slipStorage, fileFilter: slipFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// ── GET /wallet ───────────────────────────────────────────────
exports.getWallet = async (req, res) => {
  try {
    const wallet = await queryOne('SELECT * FROM wallets WHERE user_id=?', [req.user.id]);
    if (!wallet) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── POST /wallet/deposit ──────────────────────────────────────
exports.deposit = async (req, res) => {
  try {
    const { amount, payment_method } = req.body;
    // slip_image มาจาก multer req.file
    const slip_image = req.file ? `/uploads/${req.file.filename}` : null;

    if (!amount || amount < 1)
      return res.status(422).json({ error: 'VALIDATION', message: 'จำนวนเงินไม่ถูกต้อง' });

    if (payment_method === 'bank_transfer' && !slip_image)
      return res.status(422).json({ error: 'VALIDATION', message: 'กรุณาแนบสลิปโอนเงิน' });

    const wallet = await queryOne('SELECT balance FROM wallets WHERE user_id=?', [req.user.id]);
    const ref = refNo('DEP');

    const txId = await transaction(async (conn) => {
      const [tx] = await conn.execute(
        `INSERT INTO transactions (ref_no,user_id,type,amount,balance_before,balance_after,payment_method,slip_image,status,note)
         VALUES (?,?,'deposit',?,?,?,?,?,'pending','ฝากเงิน')`,
        [ref, req.user.id, amount, wallet.balance, wallet.balance, payment_method || 'bank_transfer', slip_image]
      );
      return tx.insertId;
    });

    let auto_approved  = false;
    let verify_message = 'รอตรวจสอบโดย admin';

    if (payment_method === 'qr_promptpay') {
      // QR PromptPay → auto approve (ในระบบจริงต้องรอ webhook จากธนาคาร)
      await approveDeposit(txId, req.user.id, amount);
      await query("UPDATE transactions SET note='ฝากเงิน [AUTO:qr_promptpay]' WHERE id=?", [txId]);
      auto_approved  = true;
      verify_message = 'อนุมัติอัตโนมัติ (QR PromptPay)';
    } else if (req.file) {
      // ตรวจสลิปผ่าน SlipOK API
      const result = await verifySlip(req.file.path, parseFloat(amount));
      if (result.valid) {
        const transRef = result.data?.transRef || '';
        await approveDeposit(txId, req.user.id, amount);
        await query("UPDATE transactions SET note=? WHERE id=?",
          [`ฝากเงิน [AUTO:${transRef}]`, txId]);
        auto_approved  = true;
        verify_message = `ยืนยันสลิปอัตโนมัติ (ref: ${transRef})`;
      } else {
        const reason = result.reason || 'UNKNOWN';
        if (!result.skip) {
          await query("UPDATE transactions SET note=? WHERE id=?",
            [`ฝากเงิน [PENDING:${reason}]`, txId]);
        }
        verify_message = result.skip
          ? 'ระบบตรวจสลิปไม่ได้เปิดใช้งาน รอ admin ตรวจสอบ'
          : `ตรวจสลิปไม่ผ่าน (${reason}) รอ admin ตรวจสอบ`;
      }
    }

    res.status(201).json({
      transaction_id: txId,
      ref_no: ref,
      status: auto_approved ? 'success' : 'pending',
      amount,
      auto_approved,
      verify_message,
    });
  } catch (err) {
    // ลบไฟล์ถ้า transaction ล้มเหลว
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// Internal: อนุมัติฝากเงิน
async function approveDeposit(txId, userId, amount) {
  await transaction(async (conn) => {
    const [wallet] = await conn.execute('SELECT balance FROM wallets WHERE user_id=? FOR UPDATE', [userId]);
    const before = wallet[0].balance;
    const after  = parseFloat(before) + parseFloat(amount);

    await conn.execute(
      'UPDATE wallets SET balance=?, total_deposit=total_deposit+? WHERE user_id=?',
      [after, amount, userId]
    );
    await conn.execute(
      'UPDATE transactions SET status=?,balance_before=?,balance_after=?,processed_at=NOW() WHERE id=?',
      ['success', before, after, txId]
    );
  });
}
exports.approveDeposit = approveDeposit;

// ── POST /wallet/withdraw ─────────────────────────────────────
exports.withdraw = async (req, res) => {
  try {
    const { amount, bank_account_id } = req.body;
    if (!amount || amount < 1)
      return res.status(422).json({ error: 'VALIDATION', message: 'จำนวนเงินไม่ถูกต้อง' });

    const [minSetting, maxSetting] = await Promise.all([
      queryOne("SELECT value FROM system_settings WHERE `key`='min_withdraw'"),
      queryOne("SELECT value FROM system_settings WHERE `key`='max_withdraw'"),
    ]);
    const minW = parseFloat(minSetting?.value || 100);
    const maxW = parseFloat(maxSetting?.value || 50000);
    if (amount < minW) return res.status(422).json({ error: 'MIN_WITHDRAWAL', message: `ถอนขั้นต่ำ ฿${minW}` });
    if (amount > maxW) return res.status(422).json({ error: 'MAX_WITHDRAWAL', message: `ถอนสูงสุด ฿${maxW}` });

    const bank = bank_account_id
      ? await queryOne('SELECT * FROM user_bank_accounts WHERE id=? AND user_id=?', [bank_account_id, req.user.id])
      : await queryOne('SELECT * FROM user_bank_accounts WHERE user_id=? AND is_default=1', [req.user.id]);
    if (!bank) return res.status(422).json({ error: 'NO_BANK', message: 'ไม่พบบัญชีธนาคาร' });

    const ref = refNo('WIT');
    const txId = await transaction(async (conn) => {
      const [walletRow] = await conn.execute('SELECT balance FROM wallets WHERE user_id=? FOR UPDATE', [req.user.id]);
      const balance = parseFloat(walletRow[0].balance);
      if (balance < amount)
        throw Object.assign(new Error('ยอดเงินไม่เพียงพอ'), { status: 422, code: 'INSUFFICIENT_BALANCE' });

      const after = balance - amount;
      await conn.execute(
        'UPDATE wallets SET balance=?, locked_balance=locked_balance+?, total_withdraw=total_withdraw+? WHERE user_id=?',
        [after, amount, amount, req.user.id]
      );
      const [tx] = await conn.execute(
        `INSERT INTO transactions (ref_no,user_id,type,amount,balance_before,balance_after,bank_account_id,status,note)
         VALUES (?,?,'withdraw',?,?,?,?,'pending','ถอนเงิน')`,
        [ref, req.user.id, amount, balance, after, bank.id]
      );
      return tx.insertId;
    });

    res.status(201).json({ transaction_id: txId, ref_no: ref, status: 'pending', amount, estimated_time: '5-15 นาที' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── GET /wallet/transactions ──────────────────────────────────
exports.getTransactions = async (req, res) => {
  try {
    const { type, status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let sql  = 'SELECT * FROM transactions WHERE user_id=?';
    let params = [req.user.id];
    if (type)   { sql += ' AND type=?';   params.push(type); }
    if (status) { sql += ' AND status=?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [data, countRow] = await Promise.all([
      query(sql, params),
      queryOne('SELECT COUNT(*) as total FROM transactions WHERE user_id=?', [req.user.id]),
    ]);
    res.json({ data, total: countRow.total, page: parseInt(page), per_page: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
