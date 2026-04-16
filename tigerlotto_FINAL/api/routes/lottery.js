const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { authAdmin, optionalAuth } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const { v4: uuidv4 } = require('uuid');

// ════════════════════════════════════
//  PUBLIC: Lottery types + rounds
// ════════════════════════════════════

// GET /api/lottery/types — all active lottery types
router.get('/types', async (req, res) => {
  const rows = await query(
    'SELECT id,code,name,flag,status,min_bet,max_bet,rate_3top,rate_3tod,rate_2top,rate_2bot,rate_run_top,rate_run_bot FROM lottery_types ORDER BY sort_order');
  res.json({ success: true, data: rows });
});

// GET /api/lottery/types/:id
router.get('/types/:id', async (req, res) => {
  const [lt] = await query('SELECT * FROM lottery_types WHERE id=?', [req.params.id]);
  if (!lt) return res.status(404).json({ success: false, message: 'ไม่พบประเภทหวย' });
  const rounds = await query(
    'SELECT id,uuid,round_name,draw_date,close_at,status,total_bet,bet_count FROM lottery_rounds WHERE lottery_id=? ORDER BY id DESC LIMIT 10',
    [lt.id]);
  res.json({ success: true, data: { ...lt, rounds } });
});

// GET /api/lottery/rounds — open rounds (for buying)
router.get('/rounds', async (req, res) => {
  const rows = await query(
    `SELECT lr.id,lr.uuid,lr.round_name,lr.draw_date,lr.close_at,lr.status,lr.total_bet,lr.bet_count,
            lt.id as lottery_id,lt.name as lottery_name,lt.flag,lt.code,
            lt.rate_3top,lt.rate_3tod,lt.rate_2top,lt.rate_2bot,lt.rate_run_top,lt.rate_run_bot,
            lt.min_bet,lt.max_bet
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id=lt.id
     WHERE lr.status='open' AND lt.status='open' AND lr.close_at > NOW()
     ORDER BY lr.close_at ASC`);
  res.json({ success: true, data: rows });
});

// GET /api/lottery/results — recent results
router.get('/results', async (req, res) => {
  const { lottery_id, limit = 10 } = req.query;
  const where = lottery_id ? 'WHERE lr.lottery_id=?' : '';
  const params = lottery_id ? [lottery_id, parseInt(limit)] : [parseInt(limit)];
  const rows = await query(
    `SELECT lr.id,lr.round_name,lr.draw_date,lt.name as lottery_name,lt.flag,lt.code,
            res.prize_1st,res.prize_last_2,res.prize_last_3,res.prize_front_3,res.announced_at
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id=lt.id
     LEFT JOIN lottery_results res ON lr.id=res.round_id
     ${where}
     AND lr.status='announced'
     ORDER BY lr.draw_date DESC, lr.id DESC LIMIT ?`, params);
  res.json({ success: true, data: rows });
});

// GET /api/lottery/results/:roundId — full result detail
router.get('/results/:roundId', async (req, res) => {
  const [res_] = await query(
    `SELECT lr.*,lt.name as lottery_name,lt.flag,
            r.prize_1st,r.prize_2nd,r.prize_3rd,r.prize_4th,r.prize_5th,
            r.prize_near_1st,r.prize_front_3,r.prize_last_3,r.prize_last_2,r.announced_at
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id=lt.id
     LEFT JOIN lottery_results r ON lr.id=r.round_id
     WHERE lr.id=?`, [req.params.roundId]);
  if (!res_) return res.status(404).json({ success: false, message: 'ไม่พบงวดนี้' });
  res.json({ success: true, data: res_ });
});

// POST /api/lottery/check — ตรวจหวย
router.post('/check', async (req, res) => {
  const { round_id, number } = req.body;
  if (!round_id || !number) return res.status(400).json({ success: false, message: 'กรุณาระบุ round_id และเลข' });

  const [result] = await query('SELECT * FROM lottery_results WHERE round_id=?', [round_id]);
  if (!result) return res.status(404).json({ success: false, message: 'ยังไม่มีผลรางวัลของงวดนี้' });

  const n = number.trim();
  const prizes = [];

  if (result.prize_1st === n) prizes.push({ name: 'รางวัลที่ 1', amount: 6000000 });

  const last2 = n.slice(-2);
  if (result.prize_last_2 === last2) prizes.push({ name: 'รางวัลเลขท้าย 2 ตัว', amount: 2000 });

  const last3 = n.slice(-3);
  const last3arr = result.prize_last_3 ? JSON.parse(result.prize_last_3) : [];
  if (n.length >= 3 && last3arr.includes(last3)) prizes.push({ name: 'รางวัลเลขท้าย 3 ตัว', amount: 4000 });

  const front3arr = result.prize_front_3 ? JSON.parse(result.prize_front_3) : [];
  if (n.length >= 3 && front3arr.includes(n.slice(0, 3))) prizes.push({ name: 'รางวัลเลขหน้า 3 ตัว', amount: 4000 });

  res.json({ success: true, data: { number: n, prizes, won: prizes.length > 0 } });
});

// ════════════════════════════════════
//  ADMIN: Lottery management
// ════════════════════════════════════

// GET /api/lottery/admin/types
router.get('/admin/types', authAdmin, rbac.requirePerm('lottery.view'), async (req, res) => {
  const rows = await query('SELECT * FROM lottery_types ORDER BY sort_order');
  res.json({ success: true, data: rows });
});

// PATCH /api/lottery/admin/types/:id — update rates, status
router.patch('/admin/types/:id', authAdmin, rbac.requirePerm('lottery.manage'), async (req, res) => {
  const { name, status, min_bet, max_bet, rate_3top, rate_3tod, rate_2top, rate_2bot, rate_run_top, rate_run_bot } = req.body;
  await query(
    `UPDATE lottery_types SET
       name=COALESCE(?,name), status=COALESCE(?,status),
       min_bet=COALESCE(?,min_bet), max_bet=COALESCE(?,max_bet),
       rate_3top=COALESCE(?,rate_3top), rate_3tod=COALESCE(?,rate_3tod),
       rate_2top=COALESCE(?,rate_2top), rate_2bot=COALESCE(?,rate_2bot),
       rate_run_top=COALESCE(?,rate_run_top), rate_run_bot=COALESCE(?,rate_run_bot),
       updated_at=NOW()
     WHERE id=?`,
    [name, status, min_bet, max_bet, rate_3top, rate_3tod, rate_2top, rate_2bot, rate_run_top, rate_run_bot, req.params.id]);
  await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
    [req.admin.id, 'lottery.update', 'lottery_type', req.params.id, JSON.stringify(req.body), req.ip]);
  res.json({ success: true, message: 'อัพเดทประเภทหวยสำเร็จ' });
});

// GET /api/lottery/admin/rounds
router.get('/admin/rounds', authAdmin, rbac.requirePerm('rounds.view'), async (req, res) => {
  const { status, lottery_id } = req.query;
  const where = [];
  const params = [];
  if (status)     { where.push('lr.status=?'); params.push(status); }
  if (lottery_id) { where.push('lr.lottery_id=?'); params.push(lottery_id); }
  const rows = await query(
    `SELECT lr.*,lt.name as lottery_name,lt.flag
     FROM lottery_rounds lr JOIN lottery_types lt ON lr.lottery_id=lt.id
     ${where.length?'WHERE '+where.join(' AND '):''}
     ORDER BY lr.id DESC LIMIT 50`, params);
  res.json({ success: true, data: rows });
});

// POST /api/lottery/admin/rounds — create round
router.post('/admin/rounds', authAdmin, rbac.requirePerm('rounds.manage'),
  body('lottery_id').isInt(), body('draw_date').isDate(), body('close_at').notEmpty(),
  async (req, res) => {
    const err = validationResult(req);
    if (!err.isEmpty()) return res.status(400).json({ success: false, errors: err.array() });
    const { lottery_id, draw_date, close_at, round_name } = req.body;
    const name = round_name || draw_date;
    await query('INSERT INTO lottery_rounds (uuid,lottery_id,round_name,draw_date,close_at,status) VALUES (?,?,?,?,?,?)',
      [uuidv4(), lottery_id, name, draw_date, close_at, 'open']);
    res.status(201).json({ success: true, message: 'เปิดงวดใหม่สำเร็จ' });
  }
);

// PATCH /api/lottery/admin/rounds/:id/close
router.patch('/admin/rounds/:id/close', authAdmin, rbac.requirePerm('rounds.manage'), async (req, res) => {
  await query('UPDATE lottery_rounds SET status="closed" WHERE id=?', [req.params.id]);
  res.json({ success: true, message: 'ปิดรับงวดแล้ว' });
});

// POST /api/lottery/admin/results — announce result + auto payout
router.post('/admin/results', authAdmin, rbac.requirePerm('results.announce'),
  body('round_id').isInt(),
  body('prize_1st').isLength({ min: 6, max: 6 }).withMessage('รางวัลที่ 1 ต้องเป็น 6 หลัก'),
  body('prize_last_2').isLength({ min: 2, max: 2 }),
  async (req, res) => {
    const err = validationResult(req);
    if (!err.isEmpty()) return res.status(400).json({ success: false, errors: err.array() });

    const { round_id, prize_1st, prize_2nd, prize_3rd, prize_4th, prize_5th,
            prize_near_1st, prize_front_3, prize_last_3, prize_last_2 } = req.body;

    const [round] = await query('SELECT * FROM lottery_rounds WHERE id=? AND status!="announced"', [round_id]);
    if (!round) return res.status(400).json({ success: false, message: 'ไม่พบงวด หรือประกาศผลแล้ว' });

    await transaction(async (conn) => {
      // Insert result
      await conn.execute(
        `INSERT INTO lottery_results
          (round_id,prize_1st,prize_2nd,prize_3rd,prize_4th,prize_5th,
           prize_near_1st,prize_front_3,prize_last_3,prize_last_2,announced_at,announced_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),?)`,
        [round_id, prize_1st,
          JSON.stringify(prize_2nd || []), JSON.stringify(prize_3rd || []),
          JSON.stringify(prize_4th || []), JSON.stringify(prize_5th || []),
          JSON.stringify(prize_near_1st || []),
          JSON.stringify(prize_front_3 || []), JSON.stringify(prize_last_3 || []),
          prize_last_2, req.admin.id]);

      // Update round status
      await conn.execute('UPDATE lottery_rounds SET status="announced" WHERE id=?', [round_id]);

      // Auto-calculate winners and pay
      const [lt] = await query('SELECT rate_3top,rate_3tod,rate_2top,rate_2bot,rate_run_top,rate_run_bot FROM lottery_types lt JOIN lottery_rounds lr ON lr.lottery_id=lt.id WHERE lr.id=?', [round_id]);
      const bets = await query('SELECT * FROM bets WHERE round_id=? AND status="waiting"', [round_id]);

      for (const bet of bets) {
        let won = false;
        let winAmt = 0;
        const n = bet.number;

        if (bet.bet_type === '3top' && prize_1st?.slice(-3) === n) { won = true; winAmt = bet.amount * lt.rate_3top; }
        else if (bet.bet_type === '3tod') {
          const sorted = n.split('').sort().join('');
          const p1sorted = prize_1st?.slice(-3).split('').sort().join('');
          if (sorted === p1sorted) { won = true; winAmt = bet.amount * lt.rate_3tod; }
        }
        else if (bet.bet_type === '2top' && prize_last_2 === n) { won = true; winAmt = bet.amount * lt.rate_2top; }
        else if (bet.bet_type === '2bot' && prize_last_2 === n) { won = true; winAmt = bet.amount * lt.rate_2bot; }
        else if (bet.bet_type === 'run_top' && prize_1st?.includes(n)) { won = true; winAmt = bet.amount * lt.rate_run_top; }
        else if (bet.bet_type === 'run_bot' && prize_last_2?.includes(n)) { won = true; winAmt = bet.amount * lt.rate_run_bot; }

        const status = won ? 'win' : 'lose';
        await conn.execute('UPDATE bets SET status=?, win_amount=? WHERE id=?', [status, winAmt, bet.id]);

        if (won && winAmt > 0) {
          const [[m]] = await conn.execute('SELECT balance FROM members WHERE id=? FOR UPDATE', [bet.member_id]);
          const newBal = parseFloat(m.balance) + winAmt;
          await conn.execute('UPDATE members SET balance=?, total_win=total_win+? WHERE id=?', [newBal, winAmt, bet.member_id]);
          await conn.execute('INSERT INTO transactions (uuid,member_id,type,amount,balance_before,balance_after,description) VALUES (?,?,?,?,?,?,?)',
            [uuidv4(), bet.member_id, 'win', winAmt, m.balance, newBal, `ถูกรางวัล: ${bet.number} (${bet.bet_type})`]);
          // Notify
          await conn.execute('INSERT INTO notifications (member_id,title,body,type) VALUES (?,?,?,?)',
            [bet.member_id, '🎉 ถูกรางวัล!', `เลข ${bet.number} ถูก! ได้รับเงิน ฿${winAmt.toLocaleString()}`, 'win']);
        }
      }

      // Log
      await conn.execute('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
        [req.admin.id, 'result.announce', 'round', round_id, `prize_1st: ${prize_1st}`, req.ip]);
    });

    res.json({ success: true, message: 'ประกาศผลและจ่ายรางวัลเรียบร้อย' });
  }
);

module.exports = router;
