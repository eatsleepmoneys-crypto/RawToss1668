const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { signMemberToken, signAdminToken, signAgentToken, authMember, authAdmin, authAgent } = require('../middleware/auth');

// ─── Rate limiters ───────────────────────────────
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT) || 5,
  message: { success: false, message: 'พยายาม login มากเกินไป กรุณารอ 15 นาที' },
  keyGenerator: (req) => req.body.phone || req.ip,
});

const otpLimit = rateLimit({ windowMs: 60 * 1000, max: 1,
  message: { success: false, message: 'กรุณารอ 1 นาทีก่อนขอ OTP ใหม่' } });

// ─── Validators ──────────────────────────────────
const validateRegister = [
  body('name').trim().notEmpty().withMessage('กรุณากรอกชื่อ-นามสกุล').isLength({ min:2, max:100 }),
  body('phone').matches(/^0[0-9]{8,9}$/).withMessage('เบอร์โทรศัพท์ไม่ถูกต้อง'),
  body('password').isLength({ min: 6 }).withMessage('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'),
  body('bank_code').notEmpty().withMessage('กรุณาเลือกธนาคาร'),
  body('bank_account').notEmpty().withMessage('กรุณากรอกเลขบัญชี'),
  body('bank_name').notEmpty().withMessage('กรุณากรอกชื่อบัญชี'),
];

// ─── Helper: Send OTP ─────────────────────────────
const sendOTP = async (phone, type) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 5 * 60 * 1000); // 5 min
  await query('DELETE FROM otps WHERE phone = ? AND type = ?', [phone, type]);
  await query('INSERT INTO otps (phone, code, type, expires_at) VALUES (?,?,?,?)', [phone, code, type, expires]);
  // In production: send via SMS API
  console.log(`📱 OTP for ${phone}: ${code}`);
  return code;
};

// ─── POST /api/auth/send-otp ──────────────────────
router.post('/send-otp', otpLimit,
  body('phone').matches(/^0[0-9]{8,9}$/).withMessage('เบอร์โทรไม่ถูกต้อง'),
  body('type').isIn(['register','login','withdraw','reset']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { phone, type } = req.body;
    if (type === 'register') {
      const [existing] = await query('SELECT id FROM members WHERE phone = ?', [phone]);
      if (existing) return res.status(400).json({ success: false, message: 'เบอร์นี้สมัครแล้ว' });
    }
    await sendOTP(phone, type);
    res.json({ success: true, message: 'ส่ง OTP แล้ว (กรุณาตรวจสอบ SMS)' });
  }
);

// ─── POST /api/auth/verify-otp ───────────────────
router.post('/verify-otp', async (req, res) => {
  const { phone, code, type } = req.body;
  const [otp] = await query(
    'SELECT * FROM otps WHERE phone=? AND type=? AND is_used=0 AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [phone, type]
  );
  if (!otp || otp.code !== code) {
    return res.status(400).json({ success: false, message: 'OTP ไม่ถูกต้องหรือหมดอายุ' });
  }
  await query('UPDATE otps SET is_used=1 WHERE id=?', [otp.id]);
  res.json({ success: true, message: 'ยืนยัน OTP สำเร็จ', verified_token: Buffer.from(`${phone}:${Date.now()}`).toString('base64') });
});

// ─── POST /api/auth/register ──────────────────────
router.post('/register', validateRegister, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { name, phone, password, bank_code, bank_account, bank_name, ref_code, aff_code } = req.body;
  const [existing] = await query('SELECT id FROM members WHERE phone=?', [phone]);
  if (existing) return res.status(400).json({ success: false, message: 'เบอร์โทรนี้ถูกใช้แล้ว' });

  // ref_code = รหัสสมาชิกที่แนะนำ (เดิม)
  let refId = null;
  if (ref_code) {
    const [ref] = await query('SELECT id FROM members WHERE member_code=?', [ref_code]);
    if (ref) refId = ref.id;
  }

  // aff_code = รหัส Affiliate ของ Agent (ลิ้ง ?aff=)
  let agentId = null;
  if (aff_code) {
    const [ag] = await query('SELECT id FROM agents WHERE aff_code=? AND status="active"', [aff_code]);
    if (ag) agentId = ag.id;
  }

  const memberCode = 'TL' + Date.now().toString().slice(-8);
  const hashed = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

  const member = await transaction(async (conn) => {
    const [result] = await conn.execute(
      'INSERT INTO members (uuid,member_code,name,phone,password,bank_code,bank_account,bank_name,ref_by,agent_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [uuidv4(), memberCode, name, phone, hashed, bank_code, bank_account, bank_name, refId, agentId, 'active']
    );
    const newId = result.insertId;

    // Give welcome bonus
    const bonusRow = await conn.execute('SELECT value FROM settings WHERE `key`="bonus_new_member"');
    const bonus = parseFloat(bonusRow[0][0]?.value || 50);
    if (bonus > 0) {
      await conn.execute('UPDATE members SET balance=balance+?, bonus_balance=bonus_balance+? WHERE id=?', [bonus, bonus, newId]);
      await conn.execute('INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), newId, 'bonus', bonus, 0, bonus, 'โบนัสสมัครสมาชิกใหม่']);
    }

    // Commission to member referrer (ref_code)
    if (refId) {
      await conn.execute('SELECT value FROM settings WHERE `key`="referral_commission"').catch(()=>{});
    }

    const [newMember] = await conn.execute('SELECT id,uuid,name,phone,member_code,balance,bonus_balance,level,bank_code,bank_account,bank_name FROM members WHERE id=?', [newId]);
    return newMember[0];
  });

  const token = signMemberToken(member);
  res.status(201).json({ success: true, message: 'สมัครสมาชิกสำเร็จ', data: { member, token } });
});

// ─── POST /api/auth/login ─────────────────────────
router.post('/login', loginLimit,
  body('phone').notEmpty().withMessage('กรุณากรอกเบอร์โทร'),
  body('password').notEmpty().withMessage('กรุณากรอกรหัสผ่าน'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { phone, password } = req.body;
    const [member] = await query('SELECT * FROM members WHERE phone=?', [phone]);

    if (!member) return res.status(401).json({ success: false, message: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' });
    if (member.status === 'banned') return res.status(403).json({ success: false, message: 'บัญชีถูกระงับ' });

    // Check lockout
    if (member.locked_until && new Date(member.locked_until) > new Date()) {
      return res.status(429).json({ success: false, message: 'บัญชีถูกล็อคชั่วคราว กรุณารอสักครู่' });
    }

    const match = await bcrypt.compare(password, member.password);
    if (!match) {
      const attempts = member.login_attempts + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query('UPDATE members SET login_attempts=?, locked_until=? WHERE id=?', [attempts, lockUntil, member.id]);
      return res.status(401).json({ success: false, message: `รหัสผ่านไม่ถูกต้อง (${attempts}/5)` });
    }

    // Reset attempts, update last login
    await query('UPDATE members SET login_attempts=0, locked_until=NULL, last_login_at=NOW(), last_login_ip=? WHERE id=?',
      [req.ip, member.id]);

    const token = signMemberToken(member);
    res.json({
      success: true, message: 'เข้าสู่ระบบสำเร็จ',
      data: {
        token,
        member: {
          id: member.id, uuid: member.uuid, name: member.name, phone: member.phone,
          balance: member.balance, bonus_balance: member.bonus_balance,
          level: member.level, member_code: member.member_code,
          bank_code: member.bank_code, bank_account: member.bank_account, bank_name: member.bank_name,
        }
      }
    });
  }
);

// ─── POST /api/auth/admin/login ───────────────────
router.post('/admin/login', loginLimit,
  body('email').isEmail().withMessage('กรุณากรอก Email'),
  body('password').notEmpty(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { email, password } = req.body;
      const [admin] = await query('SELECT * FROM admins WHERE email=? AND is_active=1', [email]);
      if (!admin) return res.status(401).json({ success: false, message: 'Email หรือรหัสผ่านไม่ถูกต้อง' });

      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        return res.status(429).json({ success: false, message: 'บัญชีถูกล็อค กรุณารอสักครู่' });
      }

      const match = await bcrypt.compare(password, admin.password);
      if (!match) {
        const attempts = admin.login_attempts + 1;
        const lockUntil = attempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;
        await query('UPDATE admins SET login_attempts=?, locked_until=? WHERE id=?', [attempts, lockUntil, admin.id]);
        return res.status(401).json({ success: false, message: `รหัสผ่านไม่ถูกต้อง (${attempts}/5)` });
      }

      await query('UPDATE admins SET login_attempts=0, locked_until=NULL, last_login_at=NOW(), last_login_ip=? WHERE id=?',
        [req.ip, admin.id]);

      // Log activity (ignore error if table missing)
      try {
        await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
          [admin.id, 'login', 'เข้าสู่ระบบ Admin', req.ip]);
      } catch (logErr) {
        console.warn('admin_logs insert failed (non-fatal):', logErr.message);
      }

      const token = signAdminToken(admin);
      res.json({
        success: true, message: 'เข้าสู่ระบบสำเร็จ',
        data: { token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } }
      });
    } catch (err) {
      console.error('Admin login error:', err);
      res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    }
  }
);

// ─── GET /api/auth/me ─────────────────────────────
router.get('/me', authMember, async (req, res) => {
  const [m] = await query(
    'SELECT id,uuid,name,phone,email,bank_code,bank_account,bank_name,balance,bonus_balance,level,member_code,created_at FROM members WHERE id=?',
    [req.member.id]
  );
  res.json({ success: true, data: m });
});

// ─── GET /api/auth/admin/me ───────────────────────
router.get('/admin/me', authAdmin, (req, res) => {
  res.json({ success: true, data: req.admin });
});

// ─── POST /api/auth/logout ────────────────────────
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'ออกจากระบบแล้ว' });
});

// ─── POST /api/auth/reset-password ───────────────
router.post('/reset-password',
  body('phone').matches(/^0[0-9]{8,9}$/),
  body('otp').isLength({ min: 6, max: 6 }),
  body('new_password').isLength({ min: 8 }),
  async (req, res) => {
    const { phone, new_password } = req.body;
    const [member] = await query('SELECT id FROM members WHERE phone=?', [phone]);
    if (!member) return res.status(404).json({ success: false, message: 'ไม่พบบัญชีนี้' });
    const hashed = await bcrypt.hash(new_password, 12);
    await query('UPDATE members SET password=?, login_attempts=0, locked_until=NULL WHERE id=?', [hashed, member.id]);
    res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
  }
);

// ─── POST /api/auth/agent/login ───────────────────
router.post('/agent/login', loginLimit,
  body('phone').notEmpty().withMessage('กรุณากรอกเบอร์โทร'),
  body('password').notEmpty().withMessage('กรุณากรอกรหัสผ่าน'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

    const phone = String(req.body.phone).replace(/[^0-9]/g, '');
    const { password } = req.body;

    const [agent] = await query(
      'SELECT id, uuid, name, phone, email, password, commission_rate, balance, total_commission, status FROM agents WHERE phone = ?',
      [phone]
    );

    if (!agent) return res.status(401).json({ success: false, message: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' });
    if (agent.status !== 'active') return res.status(403).json({ success: false, message: 'บัญชีถูกระงับ กรุณาติดต่อ Admin' });

    const valid = await bcrypt.compare(password, agent.password);
    if (!valid) return res.status(401).json({ success: false, message: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' });

    const token = signAgentToken(agent);
    const { password: _pw, ...agentData } = agent;
    res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', token, agent: agentData });
  }
);

// ─── GET /api/auth/agent/me ───────────────────────
router.get('/agent/me', authAgent, (req, res) => {
  res.json({ success: true, data: req.agent });
});

module.exports = router;
