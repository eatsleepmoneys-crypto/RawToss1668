const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { authMember, authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const { v4: uuidv4 } = require('uuid');

// ─── BET TYPE → digits map ────────────────────────
const BET_DIGITS = { '3top':3,'3tod':3,'2top':2,'2bot':2,'run_top':1,'run_bot':1 };

// ─── POST /api/bets — place bet ───────────────────
router.post('/', authMember,
  body('round_id').isInt({ min: 1 }),
  body('bets').isArray({ min: 1, max: 50 }).withMessage('ระบุรายการแทงได้สูงสุด 50 รายการ'),
  body('bets.*.bet_type').isIn(['3top','3tod','2top','2bot','run_top','run_bot']),
  body('bets.*.number').notEmpty(),
  body('bets.*.amount').isFloat({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { round_id, bets } = req.body;

    // Validate round
    const [round] = await query(
      `SELECT lr.*,lt.min_bet,lt.max_bet,lt.rate_3top,lt.rate_3tod,lt.rate_2top,lt.rate_2bot,lt.rate_run_top,lt.rate_run_bot,lt.status as lt_status
       FROM lottery_rounds lr JOIN lottery_types lt ON lr.lottery_id=lt.id
       WHERE lr.id=? AND lr.status='open' AND lr.close_at > NOW()`, [round_id]);
    if (!round) return res.status(400).json({ success: false, message: 'งวดนี้ปิดรับแล้วหรือไม่พบ' });
    if (round.lt_status !== 'open') return res.status(400).json({ success: false, message: 'ประเภทหวยนี้ปิดให้บริการชั่วคราว' });

    // Validate each bet
    const RATE_MAP = {
      '3top': round.rate_3top, '3tod': round.rate_3tod,
      '2top': round.rate_2top, '2bot': round.rate_2bot,
      'run_top': round.rate_run_top, 'run_bot': round.rate_run_bot,
    };

    let totalAmount = 0;
    const validated = [];

    for (const bet of bets) {
      const digits = BET_DIGITS[bet.bet_type];
      const numStr = String(bet.number).replace(/\D/g, '');
      if (numStr.length !== digits) {
        return res.status(400).json({ success: false, message: `เลข "${bet.number}" ต้องเป็น ${digits} หลักสำหรับ ${bet.bet_type}` });
      }
      if (bet.amount < round.min_bet || bet.amount > round.max_bet) {
        return res.status(400).json({ success: false, message: `จำนวนเงินต้องอยู่ระหว่าง ${round.min_bet}–${round.max_bet} บาท` });
      }

      // ─── ระบบอั้นหวย: ตรวจ tier ────────────────────────────────────────────
      // helper: ดึงอัตราจาก tier ปัจจุบัน (null = ไม่ได้อยู่ถัง 2+)
      const getTierRate = (row) => {
        if (!row) return null;
        const t = row.current_tier;
        if (t === '2')   return parseFloat(row.tier2_rate)   ?? null;
        if (t === '2.1') return parseFloat(row.tier2_1_rate) ?? null;
        if (t === '2.2') return parseFloat(row.tier2_2_rate) ?? null;
        if (t === '2.3') return parseFloat(row.tier2_3_rate) ?? null;
        return null; // tier=1 → จ่ายเต็ม
      };

      // 1. Global limit (number='*') — ครอบคลุมทุกเลขของ bet_type นี้
      const [globalRow] = await query(
        `SELECT * FROM number_limits
         WHERE lottery_id=? AND number='*' AND bet_type=?
           AND (round_id=? OR round_id IS NULL)
         ORDER BY (round_id IS NULL) ASC LIMIT 1`,
        [round.lottery_id, bet.bet_type, round_id]
      );

      // 2. Per-number limit — เฉพาะเลขนี้
      const [nlRow] = await query(
        `SELECT * FROM number_limits
         WHERE lottery_id=? AND number=? AND bet_type=?
           AND (round_id=? OR round_id IS NULL)
         ORDER BY (round_id IS NULL) ASC LIMIT 1`,
        [round.lottery_id, numStr, bet.bet_type, round_id]
      );

      // ถัง 3 → ปิดรับแทง (ทั้ง global และ per-number)
      if (globalRow?.current_tier === '3') {
        return res.status(400).json({
          success: false,
          message: `ประเภท ${bet.bet_type} ปิดรับแทงทั้งหมดแล้ว (ถัง 3 global)`
        });
      }
      if (nlRow?.current_tier === '3') {
        return res.status(400).json({
          success: false,
          message: `เลข ${numStr} ประเภท ${bet.bet_type} ปิดรับแทงแล้ว (ถัง 3)`
        });
      }

      // rate_override = เอาค่าต่ำสุดระหว่าง global และ per-number (เข้มงวดกว่า)
      const globalRate = getTierRate(globalRow);
      const perNumRate = getTierRate(nlRow);
      let rate_override = null;
      if (globalRate !== null && perNumRate !== null) rate_override = Math.min(globalRate, perNumRate);
      else if (globalRate !== null) rate_override = globalRate;
      else if (perNumRate !== null) rate_override = perNumRate;

      const nl_id      = nlRow?.id     ?? null;
      const nl_tier    = nlRow?.current_tier ?? null;
      const gl_id      = globalRow?.id ?? null;
      const gl_tier    = globalRow?.current_tier ?? null;

      const rate   = RATE_MAP[bet.bet_type];
      const effectiveRate = (rate_override !== null)
        ? rate * rate_override / 100
        : rate;
      const payout = parseFloat(bet.amount) * effectiveRate;

      validated.push({ ...bet, number: numStr, rate, rate_override, payout,
                       nl_id, nl_tier, gl_id, gl_tier });
      totalAmount += parseFloat(bet.amount);
    }

    // Check balance
    const [m] = await query('SELECT balance FROM members WHERE id=? FOR UPDATE', [req.member.id]);
    if (parseFloat(m.balance) < totalAmount) {
      return res.status(400).json({ success: false, message: `ยอดเงินไม่เพียงพอ (มี ฿${m.balance} ต้องการ ฿${totalAmount})` });
    }

    // Load member's referrer info + global referral rate (1 query each)
    const [memberInfo] = await query(
      'SELECT ref_by, agent_id FROM members WHERE id=?', [req.member.id]
    );
    // อ่าน global referral_commission rate จาก settings (ใช้อัตราเดียวทุกคน)
    const [rateSetting] = await query(
      "SELECT value FROM settings WHERE `key`='referral_commission'"
    ).catch(() => [null]);
    const globalCommRate = parseFloat(rateSetting?.value || 0);

    // Place bets in transaction
    const result = await transaction(async (conn) => {
      const [[member]] = await conn.execute('SELECT balance FROM members WHERE id=? FOR UPDATE', [req.member.id]);
      const newBal = parseFloat(member.balance) - totalAmount;

      await conn.execute('UPDATE members SET balance=?, total_bet=total_bet+? WHERE id=?',
        [newBal, totalAmount, req.member.id]);

      const placedBets = [];
      for (const bet of validated) {
        const betUuid = uuidv4();
        await conn.execute(
          'INSERT INTO bets (uuid,member_id,round_id,bet_type,number,amount,rate,rate_override,payout,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [betUuid, req.member.id, round_id, bet.bet_type, bet.number, bet.amount, bet.rate,
           bet.rate_override !== undefined ? bet.rate_override : null,
           bet.payout, 'waiting']);
        placedBets.push({ uuid: betUuid, ...bet });

        // ─── อั้นหวย: อัปเดต tier_used และ escalate ────────────────────────
        // helper ใช้ร่วมกัน
        const _updateNlUsed = async (nlId) => {
          await conn.execute(
            `UPDATE number_limits SET
               tier1_used   = tier1_used   + IF(current_tier='1',   ?, 0),
               tier2_used   = tier2_used   + IF(current_tier='2',   ?, 0),
               tier2_1_used = tier2_1_used + IF(current_tier='2.1', ?, 0),
               tier2_2_used = tier2_2_used + IF(current_tier='2.2', ?, 0),
               tier2_3_used = tier2_3_used + IF(current_tier='2.3', ?, 0)
             WHERE id=?`,
            [bet.amount, bet.amount, bet.amount, bet.amount, bet.amount, nlId]
          );
          const [[nl]] = await conn.execute(
            'SELECT * FROM number_limits WHERE id=? FOR UPDATE', [nlId]
          );
          if (nl) {
            let newTier = nl.current_tier;
            if (nl.current_tier === '1' && nl.tier1_limit > 0 && nl.tier1_used >= nl.tier1_limit)
              newTier = (nl.tier2_1_rate !== null) ? '2.1' : '2';
            else if (nl.current_tier === '2' && nl.tier2_limit > 0 && nl.tier2_used >= nl.tier2_limit)
              newTier = (nl.tier2_1_rate !== null) ? '2.1' : '3';
            else if (nl.current_tier === '2.1' && nl.tier2_1_limit > 0 && nl.tier2_1_used >= nl.tier2_1_limit)
              newTier = (nl.tier2_2_rate !== null) ? '2.2' : '3';
            else if (nl.current_tier === '2.2' && nl.tier2_2_limit > 0 && nl.tier2_2_used >= nl.tier2_2_limit)
              newTier = (nl.tier2_3_rate !== null) ? '2.3' : '3';
            else if (nl.current_tier === '2.3' && nl.tier2_3_limit > 0 && nl.tier2_3_used >= nl.tier2_3_limit)
              newTier = '3';
            if (newTier !== nl.current_tier) {
              const fromT1 = nl.current_tier === '1' ? 1 : 0;
              const closing = newTier === '3' ? 1 : 0;
              await conn.execute(
                `UPDATE number_limits SET current_tier=?,
                   escalated_at=IF(? AND escalated_at IS NULL,NOW(),escalated_at),
                   closed_at=IF(?,NOW(),closed_at) WHERE id=?`,
                [newTier, fromT1, closing, nlId]
              );
            }
          }
        };

        // Global limit อัปเดตก่อน (ยอดรวมทุกเลข)
        if (bet.gl_id) await _updateNlUsed(bet.gl_id);

        // Per-number limit อัปเดต
        if (bet.nl_id) await _updateNlUsed(bet.nl_id);
      }

      await conn.execute(
        'INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.member.id, 'bet', -totalAmount, member.balance, newBal, `แทงหวย ${placedBets.length} รายการ (งวด ${round.round_name})`]);

      await conn.execute('UPDATE lottery_rounds SET total_bet=total_bet+?, bet_count=bet_count+? WHERE id=?',
        [totalAmount, validated.length, round_id]);

      // ─── จ่ายค่าคอมด้วยอัตรา global (referral_commission setting) ────────────
      if (globalCommRate > 0) {
        const commAmount = parseFloat((totalAmount * globalCommRate / 100).toFixed(2));
        if (commAmount > 0) {

          // ผู้แนะนำ = สมาชิก (ref_by) — เข้า commission_balance (ไม่ใช่ balance หลัก)
          if (memberInfo?.ref_by) {
            const [[refMember]] = await conn.execute(
              'SELECT commission_balance FROM members WHERE id=? FOR UPDATE', [memberInfo.ref_by]
            ).catch(() => [[null]]);
            if (refMember) {
              const newCommBal = parseFloat(refMember.commission_balance || 0) + commAmount;
              await conn.execute('UPDATE members SET commission_balance=? WHERE id=?', [newCommBal, memberInfo.ref_by]);
              await conn.execute(
                'INSERT INTO commissions (uuid,earner_type,earner_id,from_member_id,bet_id,bet_amount,rate,amount,description) VALUES (?,?,?,?,?,?,?,?,?)',
                [uuidv4(), 'member', memberInfo.ref_by, req.member.id, 0, totalAmount, globalCommRate, commAmount,
                 `ค่าคอม ${globalCommRate}% จากสมาชิก id=${req.member.id}`]);
            }
          }

          // ผู้แนะนำ = agent (agent_id) — เข้า commission_balance (ไม่ใช่ balance หลัก)
          if (memberInfo?.agent_id && !memberInfo?.ref_by) {
            const [[refAgent]] = await conn.execute(
              'SELECT commission_balance FROM agents WHERE id=? FOR UPDATE', [memberInfo.agent_id]
            ).catch(() => [[null]]);
            if (refAgent) {
              const newAgCommBal = parseFloat(refAgent.commission_balance || 0) + commAmount;
              await conn.execute('UPDATE agents SET commission_balance=?, total_commission=total_commission+? WHERE id=?',
                [newAgCommBal, commAmount, memberInfo.agent_id]);
              await conn.execute(
                'INSERT INTO commissions (uuid,earner_type,earner_id,from_member_id,bet_id,bet_amount,rate,amount,description) VALUES (?,?,?,?,?,?,?,?,?)',
                [uuidv4(), 'agent', memberInfo.agent_id, req.member.id, 0, totalAmount, globalCommRate, commAmount,
                 `ค่าคอม ${globalCommRate}% จากสมาชิก id=${req.member.id}`]);
            }
          }
        }
      }

      return { bets: placedBets, balance: newBal };
    });

    res.status(201).json({ success: true, message: 'แทงหวยสำเร็จ', data: result });
  }
);

// ─── GET /api/bets/:uuid — single bet ────────────
router.get('/:uuid', authMember, async (req, res) => {
  const [bet] = await query(
    `SELECT b.*,lr.round_name,lr.draw_date,lt.name as lottery_name,lt.flag
     FROM bets b JOIN lottery_rounds lr ON b.round_id=lr.id JOIN lottery_types lt ON lr.lottery_id=lt.id
     WHERE b.uuid=? AND b.member_id=?`, [req.params.uuid, req.member.id]);
  if (!bet) return res.status(404).json({ success: false, message: 'ไม่พบรายการแทง' });
  res.json({ success: true, data: bet });
});

// ─── ADMIN: GET /api/bets/admin/list ─────────────
router.get('/admin/list', authAdmin, rbac.requirePerm('bets.view'), async (req, res) => {
  const lim    = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
  const pg     = Math.max(parseInt(req.query.page)  || 1, 1);
  const offset = (pg - 1) * lim;

  const { round_id, member_id, status, bet_type, search, lottery_code, date_from, date_to } = req.query;
  const where = []; const params = [];
  if (round_id)     { where.push('b.round_id=?');  params.push(parseInt(round_id)); }
  if (member_id)    { where.push('b.member_id=?'); params.push(parseInt(member_id)); }
  if (status)       { where.push('b.status=?');    params.push(status); }
  if (bet_type)     { where.push('b.bet_type=?');  params.push(bet_type); }
  if (lottery_code) { where.push('lt.code=?');     params.push(lottery_code); }
  if (search) {
    where.push('(m.name LIKE ? OR m.phone LIKE ? OR b.number LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (date_from) { where.push('DATE(b.created_at) >= ?'); params.push(date_from); }
  if (date_to)   { where.push('DATE(b.created_at) <= ?'); params.push(date_to); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // ใช้ inline LIMIT/OFFSET (ปลอดภัย — parseInt แล้ว) เพื่อหลีกเลี่ยง mysql2 prepared-statement bug
  const rows = await query(
    `SELECT b.id, b.uuid, b.bet_type, b.number, b.amount, b.rate, b.payout, b.win_amount, b.status, b.created_at,
            m.name AS member_name, m.phone,
            lr.round_name, lr.draw_date,
            lt.name AS lottery_name, lt.code AS lottery_code, lt.flag AS lottery_flag
     FROM bets b
     JOIN members m         ON b.member_id  = m.id
     JOIN lottery_rounds lr ON b.round_id   = lr.id
     JOIN lottery_types lt  ON lr.lottery_id = lt.id
     ${whereClause}
     ORDER BY b.id DESC
     LIMIT ${lim} OFFSET ${offset}`, params);

  const cntRows = await query(
    `SELECT COUNT(*) c, COALESCE(SUM(b.amount),0) total_amount
     FROM bets b
     JOIN members m         ON b.member_id  = m.id
     JOIN lottery_rounds lr ON b.round_id   = lr.id
     JOIN lottery_types lt  ON lr.lottery_id = lt.id
     ${whereClause}`, params);

  const cnt = cntRows[0];
  res.json({ success: true, data: rows, total: cnt.c, total_amount: cnt.total_amount, page: pg, limit: lim });
});

// ─── ADMIN: PATCH /api/bets/admin/:id/cancel ─────
router.patch('/admin/:id/cancel', authAdmin, rbac.requirePerm('bets.cancel'), async (req, res) => {
  const [bet] = await query('SELECT * FROM bets WHERE id=? AND status="waiting"', [req.params.id]);
  if (!bet) return res.status(400).json({ success: false, message: 'ไม่พบรายการหรือยกเลิกไม่ได้' });
  await transaction(async (conn) => {
    await conn.execute('UPDATE bets SET status="cancelled" WHERE id=?', [bet.id]);
    const [[m]] = await conn.execute('SELECT balance FROM members WHERE id=? FOR UPDATE', [bet.member_id]);
    const newBal = parseFloat(m.balance) + parseFloat(bet.amount);
    await conn.execute('UPDATE members SET balance=? WHERE id=?', [newBal, bet.member_id]);
    await conn.execute('INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
      [uuidv4(), bet.member_id, 'refund', bet.amount, m.balance, newBal, `คืนเงินจากการยกเลิก bet ${bet.id}`]);
  });
  res.json({ success: true, message: 'ยกเลิกและคืนเงินแล้ว' });
});

module.exports = router;
