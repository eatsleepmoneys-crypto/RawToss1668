/**
 * Promotions API — member claim + turnover tracking + admin management
 *
 * Routes:
 *   GET  /api/promotions              — list active promotions (public)
 *   POST /api/promotions/claim        — member claims a promotion (authMember)
 *   GET  /api/promotions/my           — member's claimed promos + progress (authMember)
 *   POST /api/promotions/cancel/:id   — member cancels pending promo (authMember)
 *   GET  /api/admin/promotions/claims — admin: all claims with filter (authAdmin)
 */

const router = require('express').Router();
const { query, transaction } = require('../config/db');
const { authMember, authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const { v4: uuidv4 } = require('uuid');

// ══════════════════════════════════════════════════════════
//  PUBLIC: รายการโปรโมชั่นที่เปิดอยู่
// ══════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id,code,name,description,type,apply_type,value,is_percent,min_deposit,max_bonus,
              turnover_multiplier,turnover_type,max_withdraw_bonus,eligible_once,start_at,end_at
       FROM promotions
       WHERE is_active=1
         AND (start_at IS NULL OR start_at <= NOW())
         AND (end_at   IS NULL OR end_at   >= NOW())
       ORDER BY id DESC`
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  MEMBER: claim โปรโมชั่น
// ══════════════════════════════════════════════════════════
router.post('/claim', authMember, async (req, res) => {
  const { code, deposit_amount = 0 } = req.body;
  if (!code) return res.status(400).json({ success: false, message: 'กรุณาระบุโค้ดโปรโมชั่น' });

  try {
    const result = await transaction(async (conn) => {
      // 1. หาโปรโมชั่น
      const [[promo]] = await conn.execute(
        `SELECT * FROM promotions
         WHERE code=? AND is_active=1
           AND (start_at IS NULL OR start_at <= NOW())
           AND (end_at   IS NULL OR end_at   >= NOW())`,
        [code]
      );
      if (!promo) throw new Error('ไม่พบโปรโมชั่นนี้ หรือหมดอายุแล้ว');

      // 2. ตรวจสอบสิทธิ์รับซ้ำ
      if (promo.eligible_once) {
        const [[existing]] = await conn.execute(
          `SELECT id FROM member_promotions
           WHERE member_id=? AND promotion_id=? AND status IN ('pending','completed')`,
          [req.member.id, promo.id]
        );
        if (existing) throw new Error('คุณได้รับโปรโมชั่นนี้ไปแล้ว');
      }

      // 3. ตรวจสอบ apply_type
      if (promo.apply_type === 'new_member') {
        // ตรวจว่าสมัครภายใน 24 ชั่วโมง
        const [[m]] = await conn.execute(
          'SELECT created_at FROM members WHERE id=?', [req.member.id]
        );
        const hoursSince = (Date.now() - new Date(m.created_at).getTime()) / 3600000;
        if (hoursSince > 24) throw new Error('โปรโมชั่นนี้สำหรับสมาชิกใหม่ภายใน 24 ชั่วโมงหลังสมัคร');
      }

      if (promo.apply_type === 'deposit') {
        const dep = parseFloat(deposit_amount);
        if (dep < parseFloat(promo.min_deposit || 0))
          throw new Error(`ต้องฝากขั้นต่ำ ฿${promo.min_deposit} เพื่อรับโปรนี้`);

        // ตรวจสอบว่ามีฝากเงินจริง (approved) ในวันนี้ที่มีมูลค่าไม่ต่ำกว่า deposit_amount
        const [[latestDeposit]] = await conn.execute(
          `SELECT id, amount FROM deposits
           WHERE member_id=? AND status='approved' AND amount >= ?
             AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
           ORDER BY id DESC LIMIT 1`,
          [req.member.id, dep]
        );
        if (!latestDeposit) throw new Error('ไม่พบรายการฝากเงินที่ตรงเงื่อนไข กรุณาฝากเงินก่อนรับโปรโมชั่นนี้');

        // ตรวจว่า deposit นี้ไม่เคยใช้กับโปรโมชั่นอื่นแล้ว
        const [[depositUsed]] = await conn.execute(
          `SELECT id FROM member_promotions
           WHERE member_id=? AND deposit_ref_id=? AND status IN ('pending','completed')`,
          [req.member.id, latestDeposit.id]
        ).catch(() => [[null]]);
        if (depositUsed) throw new Error('รายการฝากนี้ได้ใช้กับโปรโมชั่นอื่นแล้ว');
      }

      // 4. คำนวณโบนัส
      const [[m]] = await conn.execute('SELECT balance,bonus_balance FROM members WHERE id=? FOR UPDATE', [req.member.id]);
      let bonusAmt = promo.is_percent
        ? parseFloat(deposit_amount) * parseFloat(promo.value) / 100
        : parseFloat(promo.value);

      if (promo.max_bonus && bonusAmt > parseFloat(promo.max_bonus)) bonusAmt = parseFloat(promo.max_bonus);
      bonusAmt = Math.round(bonusAmt * 100) / 100;

      // 5. คำนวณยอดเทิร์นที่ต้องทำ
      let requiredTurnover = 0;
      const mult = parseFloat(promo.turnover_multiplier || 0);
      if (mult > 0) {
        if (promo.turnover_type === 'bonus_only') {
          requiredTurnover = bonusAmt * mult;
        } else if (promo.turnover_type === 'deposit_and_bonus') {
          requiredTurnover = (parseFloat(deposit_amount) + bonusAmt) * mult;
        } else if (promo.turnover_type === 'bonus_x_deposit') {
          requiredTurnover = parseFloat(deposit_amount) * mult;
        }
      }
      requiredTurnover = Math.round(requiredTurnover * 100) / 100;

      // 6. เพิ่มโบนัสเข้ากระเป๋า
      const newBal        = parseFloat(m.balance) + bonusAmt;
      const newBonusBal   = parseFloat(m.bonus_balance) + bonusAmt;
      await conn.execute(
        'UPDATE members SET balance=?, bonus_balance=? WHERE id=?',
        [newBal, newBonusBal, req.member.id]
      );
      await conn.execute(
        'INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.member.id, 'bonus', bonusAmt, m.balance, newBal, `โบนัสโปรโมชั่น: ${promo.name}`]
      );

      // 7. สร้าง member_promotions record
      const status = requiredTurnover === 0 ? 'completed' : 'pending';
      const depositRefId = promo.apply_type === 'deposit' ? (latestDeposit?.id || null) : null;
      await conn.execute(
        `INSERT INTO member_promotions
           (member_id, promotion_id, bonus_amount, required_turnover, current_turnover, deposit_amount, deposit_ref_id, status, completed_at)
         VALUES (?,?,?,?,0,?,?, ?, IF(?='completed',NOW(),NULL))`,
        [req.member.id, promo.id, bonusAmt, requiredTurnover, parseFloat(deposit_amount), depositRefId, status, status]
      );

      // เพิ่ม usage count
      await conn.execute('UPDATE promotions SET usage_count=usage_count+1 WHERE id=?', [promo.id]);

      return { bonus: bonusAmt, required_turnover: requiredTurnover, status };
    });

    res.json({
      success: true,
      message: result.required_turnover > 0
        ? `รับโบนัส ฿${result.bonus} สำเร็จ — ต้องทำเทิร์น ฿${result.required_turnover.toLocaleString()} เพื่อถอนได้`
        : `รับโบนัส ฿${result.bonus} สำเร็จ`,
      data: result
    });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  MEMBER: ดูโปรโมชั่นที่ claim แล้ว + progress เทิร์น
// ══════════════════════════════════════════════════════════
router.get('/my', authMember, async (req, res) => {
  try {
    const rows = await query(
      `SELECT mp.*, p.name as promo_name, p.code as promo_code,
              p.turnover_multiplier, p.max_withdraw_bonus,
              ROUND((mp.current_turnover / GREATEST(mp.required_turnover,1)) * 100, 1) AS progress_pct
       FROM member_promotions mp
       JOIN promotions p ON p.id = mp.promotion_id
       WHERE mp.member_id=?
       ORDER BY mp.id DESC LIMIT 20`,
      [req.member.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  MEMBER: ยกเลิกโปรโมชั่น (หักโบนัสออก)
// ══════════════════════════════════════════════════════════
router.post('/cancel/:id', authMember, async (req, res) => {
  try {
    await transaction(async (conn) => {
      const [[mp]] = await conn.execute(
        'SELECT * FROM member_promotions WHERE id=? AND member_id=? AND status="pending" FOR UPDATE',
        [req.params.id, req.member.id]
      );
      if (!mp) throw new Error('ไม่พบรายการหรือไม่สามารถยกเลิกได้');

      // หักโบนัสออกจากกระเป๋า (เหลือเท่าไหร่หักเท่านั้น)
      const [[m]] = await conn.execute('SELECT balance, bonus_balance FROM members WHERE id=? FOR UPDATE', [req.member.id]);
      const deduct    = Math.min(parseFloat(mp.bonus_amount), parseFloat(m.balance));
      const newBal    = parseFloat(m.balance) - deduct;
      const newBonus  = Math.max(0, parseFloat(m.bonus_balance) - parseFloat(mp.bonus_amount));
      await conn.execute('UPDATE members SET balance=?, bonus_balance=? WHERE id=?', [newBal, newBonus, req.member.id]);
      await conn.execute(
        'INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.member.id, 'bonus', -deduct, m.balance, newBal, `ยกเลิกโปรโมชั่น — หักโบนัส`]
      );
      await conn.execute(
        'UPDATE member_promotions SET status="cancelled" WHERE id=?', [mp.id]
      );
    });
    res.json({ success: true, message: 'ยกเลิกโปรโมชั่นแล้ว โบนัสถูกหักออก' });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  ADMIN: รายการ claims ทั้งหมด
// ══════════════════════════════════════════════════════════
router.get('/admin/claims', authAdmin, rbac.requirePerm('reports.view'), async (req, res) => {
  try {
    const { status, promotion_id, limit = 50, offset = 0 } = req.query;
    const where = []; const params = [];
    if (status)       { where.push('mp.status=?'); params.push(status); }
    if (promotion_id) { where.push('mp.promotion_id=?'); params.push(promotion_id); }
    const rows = await query(
      `SELECT mp.*, p.name as promo_name, p.code as promo_code,
              m.name as member_name, m.phone as member_phone, m.member_code,
              ROUND((mp.current_turnover / GREATEST(mp.required_turnover,1)) * 100, 1) AS progress_pct
       FROM member_promotions mp
       JOIN promotions p  ON p.id  = mp.promotion_id
       JOIN members   m  ON m.id  = mp.member_id
       ${where.length ? 'WHERE '+where.join(' AND ') : ''}
       ORDER BY mp.id DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
