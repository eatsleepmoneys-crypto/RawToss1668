const { query, queryOne, transaction } = require('../config/db');
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');

// ── Multer Setup ──────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_DIR || '/var/www/tigerlotto/uploads', 'kyc');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `kyc-${req.user.id}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['.jpg','.jpeg','.png','.pdf'].includes(path.extname(file.originalname).toLowerCase()))
      return cb(null, true);
    cb(new Error('รองรับเฉพาะ JPG, PNG, PDF'));
  },
});
exports.upload = upload;

// ── POST /me/kyc ——ส่งเอกสาร KYC ─────────────────────────────
exports.submitKYC = async (req, res) => {
  try {
    const existing = await queryOne('SELECT * FROM user_kyc WHERE user_id=?', [req.user.id]);
    if (existing && existing.status === 'approved')
      return res.status(409).json({ error: 'ALREADY_APPROVED', message: 'ยืนยันตัวตนแล้ว' });
    if (existing && existing.status === 'pending')
      return res.status(409).json({ error: 'PENDING_REVIEW', message: 'รออนุมัติอยู่' });

    const { id_card_number } = req.body;
    if (!id_card_number)
      return res.status(422).json({ error: 'VALIDATION', message: 'กรุณาระบุเลขบัตรประชาชน' });

    const idCardImage = req.files?.id_card_image?.[0]?.filename
      ? `/uploads/kyc/${req.files.id_card_image[0].filename}` : null;
    const selfieImage = req.files?.selfie_image?.[0]?.filename
      ? `/uploads/kyc/${req.files.selfie_image[0].filename}` : null;

    if (existing) {
      // resubmit
      await query(
        'UPDATE user_kyc SET id_card_number=?,id_card_image=?,selfie_image=?,status="pending",reviewed_by=NULL,reviewed_at=NULL,reject_reason=NULL WHERE user_id=?',
        [id_card_number, idCardImage, selfieImage, req.user.id]
      );
    } else {
      await query(
        'INSERT INTO user_kyc (user_id,id_card_number,id_card_image,selfie_image,status) VALUES (?,?,?,?,"pending")',
        [req.user.id, id_card_number, idCardImage, selfieImage]
      );
    }

    // แจ้ง Admin
    await query(
      `INSERT INTO notifications (user_id,type,title,body,data)
       SELECT id,'system','📋 KYC ใหม่รอตรวจสอบ',?,?
       FROM users WHERE role IN ('admin','superadmin')`,
      [
        `สมาชิก #${req.user.id} ส่งเอกสาร KYC รอตรวจสอบ`,
        JSON.stringify({ user_id: req.user.id }),
      ]
    );

    res.status(201).json({ status: 'pending', message: 'ส่งเอกสารแล้ว รอการตรวจสอบ 1-24 ชั่วโมง' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── GET /me/kyc — ตรวจสอบสถานะ ───────────────────────────────
exports.getKYCStatus = async (req, res) => {
  try {
    const kyc = await queryOne('SELECT id,status,reviewed_at,reject_reason,created_at FROM user_kyc WHERE user_id=?', [req.user.id]);
    if (!kyc) return res.json({ status: 'not_submitted' });
    res.json(kyc);
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── GET /admin/kyc — Admin ดูรายการรอตรวจสอบ ─────────────────
exports.adminListKYC = async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const data = await query(
      `SELECT k.*, u.first_name, u.last_name, u.phone
       FROM user_kyc k JOIN users u ON k.user_id = u.id
       WHERE k.status=? ORDER BY k.created_at ASC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`,
      [status]
    );
    const total = await queryOne('SELECT COUNT(*) AS c FROM user_kyc WHERE status=?', [status]);
    res.json({ data, total: total.c });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── PUT /admin/kyc/:id/approve ────────────────────────────────
exports.approveKYC = async (req, res) => {
  try {
    const kyc = await queryOne("SELECT * FROM user_kyc WHERE id=? AND status='pending'", [req.params.id]);
    if (!kyc) return res.status(404).json({ error: 'NOT_FOUND' });

    await transaction(async (conn) => {
      await conn.execute(
        "UPDATE user_kyc SET status='approved', reviewed_by=?, reviewed_at=NOW() WHERE id=?",
        [req.user.id, kyc.id]
      );
      await conn.execute('UPDATE users SET is_verified=1 WHERE id=?', [kyc.user_id]);
      await conn.execute(
        `INSERT INTO notifications (user_id,type,title,body)
         VALUES (?,'system','✅ ยืนยันตัวตนสำเร็จ','เอกสาร KYC ของคุณได้รับการอนุมัติแล้ว สามารถถอนเงินได้เต็มจำนวน')`,
        [kyc.user_id]
      );
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};

// ── PUT /admin/kyc/:id/reject ─────────────────────────────────
exports.rejectKYC = async (req, res) => {
  try {
    const { reason } = req.body;
    const kyc = await queryOne("SELECT * FROM user_kyc WHERE id=? AND status='pending'", [req.params.id]);
    if (!kyc) return res.status(404).json({ error: 'NOT_FOUND' });

    await transaction(async (conn) => {
      await conn.execute(
        "UPDATE user_kyc SET status='rejected', reviewed_by=?, reviewed_at=NOW(), reject_reason=? WHERE id=?",
        [req.user.id, reason || 'เอกสารไม่ชัดเจน', kyc.id]
      );
      await conn.execute(
        `INSERT INTO notifications (user_id,type,title,body)
         VALUES (?,'system','❌ เอกสาร KYC ไม่ผ่าน',?)`,
        [kyc.user_id, `เหตุผล: ${reason || 'เอกสารไม่ชัดเจน'} กรุณาส่งใหม่`]
      );
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
