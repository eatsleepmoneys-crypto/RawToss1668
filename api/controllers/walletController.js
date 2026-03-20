const { query, queryOne, transaction } = require('../config/db');
const { v4: uuidv4 } = require('uuid');

function refNo(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2,4).toUpperCase()}`;
}

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
    const { amount, payment_method, slip_image } = req.body;
    if (!amount || amount < 1)
      return res.status(422).json({ error: 'VALIDATION', message: 'จำนวนเงินไม่ถูกต้อง' });

    const wallet = await queryOne('SELECT balance FROM wallets WHERE user_id=?', [req.user.id]);
    const ref = refNo('DEP');

    const txId = await transaction(async (conn) => {
      const [tx] = await conn.execute(
        `INSERT INTO transactions (ref_no,user_id,type,amount,balance_before,balance_after,payment_method,slip_image,status,note)
         VALUES (?,?,'deposit',?,?,?,'${payment_method||'bank_transfer'}',?,'pending','ฝากเงิน')`,
        [ref, req.user.id, amount, wallet.balance, wallet.balance, slip_image || null]
      );
      return tx.insertId;
    });

    // ถ้า QR PromptPay → auto approve (ในระบบจริงต้องรอ webhook จากธนาคาร)
    if (payment_method === 'qr_promptpay') {
      await approveDeposit(txId, req.user.id, amount);
    }

    res.status(201).json({ transaction_id: txId, ref_no: ref, status: 'pending', amount });
  } catch (err) {
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
