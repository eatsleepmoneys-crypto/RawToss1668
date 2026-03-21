const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, transaction } = require('../config/db');

// ── Generate JWT ──────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, uuid: user.uuid, role: user.role, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function genRefCode() {
  return 'TGL-' + Math.random().toString(36).substr(2,6).toUpperCase();
}

// ── POST /auth/register ───────────────────────────────────────
exports.register = async (req, res) => {
  try {
    const { phone, password, first_name, last_name, referral_code } = req.body;
    if (!phone || !password || !first_name || !last_name)
      return res.status(422).json({ error: 'VALIDATION', message: 'กรุณากรอกข้อมูลให้ครบ' });
    if (password.length < 8)
      return res.status(422).json({ error: 'VALIDATION', message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัว' });

    // Check phone exists
    const exists = await queryOne('SELECT id FROM users WHERE phone=?', [phone]);
    if (exists)
      return res.status(409).json({ error: 'DUPLICATE_PHONE', message: 'เบอร์โทรนี้ถูกใช้งานแล้ว' });

    // Find referrer
    let referredBy = null;
    if (referral_code) {
      const ref = await queryOne('SELECT id FROM users WHERE referral_code=?', [referral_code]);
      if (ref) referredBy = ref.id;
    }

    const hash = await bcrypt.hash(password, 12);
    const uuid = uuidv4();
    const myRefCode = genRefCode();

    const result = await transaction(async (conn) => {
      // INSERT user
      const [userRow] = await conn.execute(
        `INSERT INTO users (uuid,phone,password_hash,first_name,last_name,referral_code,referred_by,role,vip_tier)
         VALUES (?,?,?,?,?,?,?,'member','bronze')`,
        [uuid, phone, hash, first_name, last_name, myRefCode, referredBy]
      );
      const userId = userRow.insertId;

      // CREATE wallet
      await conn.execute(
        'INSERT INTO wallets (user_id,balance) VALUES (?,0)',
        [userId]
      );

      // Welcome bonus
      const bonusSetting = await queryOne("SELECT value FROM system_settings WHERE setting_key='bonus_welcome'");
      const bonusAmt = parseFloat(bonusSetting?.value || 50);
      if (bonusAmt > 0) {
        await conn.execute(
          'UPDATE wallets SET balance=balance+?, bonus_balance=bonus_balance+?, total_deposit=total_deposit+? WHERE user_id=?',
          [bonusAmt, bonusAmt, bonusAmt, userId]
        );
        await conn.execute(
          `INSERT INTO transactions (ref_no,user_id,type,amount,balance_before,balance_after,status,note)
           VALUES (?,?,'bonus',?,0,?,'success','โบนัสต้อนรับสมาชิกใหม่')`,
          [`BONUS-${Date.now()}`, userId, bonusAmt, bonusAmt]
        );
      }

      return userId;
    });

    const user = await queryOne('SELECT id,uuid,phone,first_name,last_name,role,vip_tier,referral_code FROM users WHERE id=?', [result]);
    const token = signToken(user);

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── POST /auth/login ──────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(422).json({ error: 'VALIDATION', message: 'กรุณากรอกเบอร์และรหัสผ่าน' });

    const user = await queryOne(
      'SELECT id,uuid,phone,password_hash,first_name,last_name,role,vip_tier,is_active,is_banned,referral_code FROM users WHERE phone=?',
      [phone]
    );
    if (!user)
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' });
    if (user.is_banned)
      return res.status(403).json({ error: 'BANNED', message: 'บัญชีนี้ถูกระงับการใช้งาน' });
    if (!user.is_active)
      return res.status(403).json({ error: 'INACTIVE', message: 'บัญชีนี้ไม่ได้ใช้งาน' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' });

    await query('UPDATE users SET last_login_at=NOW() WHERE id=?', [user.id]);

    const token = signToken(user);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── POST /auth/otp/send ───────────────────────────────────────
exports.sendOTP = async (req, res) => {
  try {
    const { phone, purpose } = req.body;
    if (!phone) return res.status(422).json({ error: 'VALIDATION', message: 'กรุณากรอกเบอร์โทร' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

    const user = await queryOne('SELECT id FROM users WHERE phone=?', [phone]);
    await query(
      'INSERT INTO otp_logs (user_id,phone,otp_code,purpose,expires_at,ip_address) VALUES (?,?,?,?,?,?)',
      [user?.id || null, phone, otp, purpose || 'login', expiresAt, req.ip]
    );

    // TODO: ส่ง OTP จริงผ่าน SMS API (Infobip/Telnyx)
    // await smsService.send(phone, `TigerLotto OTP: ${otp} (หมดอายุใน 2 นาที)`)
    console.log(`[OTP] ${phone} → ${otp}`); // dev only

    res.json({ message: 'ส่ง OTP แล้ว', expires_in: 120 });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── POST /auth/otp/verify ─────────────────────────────────────
exports.verifyOTP = async (req, res) => {
  try {
    const { phone, otp_code, purpose } = req.body;
    const log = await queryOne(
      'SELECT * FROM otp_logs WHERE phone=? AND otp_code=? AND purpose=? AND is_used=0 AND expires_at>NOW() ORDER BY id DESC LIMIT 1',
      [phone, otp_code, purpose || 'login']
    );
    if (!log)
      return res.status(422).json({ error: 'INVALID_OTP', message: 'รหัส OTP ไม่ถูกต้องหรือหมดอายุ' });

    await query('UPDATE otp_logs SET is_used=1, used_at=NOW() WHERE id=?', [log.id]);
    res.json({ verified: true });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
