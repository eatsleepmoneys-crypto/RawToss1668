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
      const rate = RATE_MAP[bet.bet_type];
      validated.push({ ...bet, number: numStr, rate, payout: bet.amount * rate });
      totalAmount += parseFloat(bet.amount);
    }

    // Check balance
    const [m] = await query('SELECT balance FROM members WHERE id=? FOR UPDATE', [req.member.id]);
    if (parseFloat(m.balance) < totalAmount) {
      return res.status(400).json({ success: false, message: `ยอดเงินไม่เพียงพอ (มี ฿${m.balance} ต้องการ ฿${totalAmount})` });
    }

    // Load member's referrer info (ref_by = member, agent_id = agent)
    const [memberInfo] = await query(
      'SELECT ref_by, agent_id FROM members WHERE id=?', [req.member.id]
    );

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
          'INSERT INTO bets (uuid,member_id,round_id,bet_type,number,amount,rate,payout,status) VALUES (?,?,?,?,?,?,?,?,?)',
          [betUuid, req.member.id, round_id, bet.bet_type, bet.number, bet.amount, bet.rate, bet.payout, 'waiting']);
        placedBets.push({ uuid: betUuid, ...bet });
      }

      await conn.execute(
        'INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.member.id, 'bet', -totalAmount, member.balance, newBal, `แทงหวย ${placedBets.length} รายการ (งวด ${round.round_name})`]);

      await conn.execute('UPDATE lottery_rounds SET total_bet=total_bet+?, bet_count=bet_count+? WHERE id=?',
        [totalAmount, validated.length, round_id]);

      // ─── จ่ายค่าคอมให้ผู้แนะนำ (member referrer) ───
      if (memberInfo?.ref_by) {
        const [[refMember]] = await conn.execute(
          'SELECT balance, referral_rate FROM members WHERE id=? FOR UPDATE', [memberInfo.ref_by]
        ).catch(() => [[null]]);
        if (refMember && parseFloat(refMember.referral_rate) > 0) {
          const commRate   = parseFloat(refMember.referral_rate);
          const commAmount = parseFloat((totalAmount * commRate / 100).toFixed(2));
          if (commAmount > 0) {
            const newRefBal = parseFloat(refMember.balance) + commAmount;
            await conn.execute('UPDATE members SET balance=? WHERE id=?', [newRefBal, memberInfo.ref_by]);
            await conn.execute(
              'INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
              [uuidv4(), memberInfo.ref_by, 'commission', commAmount, refMember.balance, newRefBal,
               `ค่าคอมแนะนำสมาชิก ${commRate}% จากยอดแทง ฿${totalAmount}`]);
            await conn.execute(
              'INSERT INTO commissions (uuid,earner_type,earner_id,from_member_id,bet_id,bet_amount,rate,amount,description) VALUES (?,?,?,?,?,?,?,?,?)',
              [uuidv4(), 'member', memberInfo.ref_by, req.member.id, 0, totalAmount, commRate, commAmount,
               `ค่าคอม ${commRate}% จากสมาชิก id=${req.member.id}`]);
          }
        }
      }

      // ─── จ่ายค่าคอมให้ agent (referral_rate) ───
      if (memberInfo?.agent_id) {
        const [[refAgent]] = await conn.execute(
          'SELECT balance, referral_rate FROM agents WHERE id=? FOR UPDATE', [memberInfo.agent_id]
        ).catch(() => [[null]]);
        if (refAgent && parseFloat(refAgent.referral_rate) > 0) {
          const commRate   = parseFloat(refAgent.referral_rate);
          const commAmount = parseFloat((totalAmount * commRate / 100).toFixed(2));
          if (commAmount > 0) {
            const newAgBal = parseFloat(refAgent.balance) + commAmount;
            await conn.execute('UPDATE agents SET balance=?, total_commission=total_commission+? WHERE id=?',
              [newAgBal, commAmount, memberInfo.agent_id]);
            await conn.execute(
              'INSERT INTO agent_transactions (uuid,agent_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
              [uuidv4(), memberInfo.agent_id, 'commission', commAmount, refAgent.balance, newAgBal,
               `ค่าคอมแนะนำสมาชิก ${commRate}% จากยอดแทง ฿${totalAmount}`]);
            await conn.execute(
              'INSERT INTO commissions (uuid,earner_type,earner_id,from_member_id,bet_id,bet_amount,rate,amount,description) VALUES (?,?,?,?,?,?,?,?,?)',
              [uuidv4(), 'agent', memberInfo.agent_id, req.member.id, 0, totalAmount, commRate, commAmount,
               `ค่าคอม ${commRate}% จากสมาชิก id=${req.member.id}`]);
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

  const { round_id, member_id, status, bet_type, search, lottery_code } = req.query;
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
