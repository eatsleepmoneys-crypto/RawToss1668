const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { authAdmin, optionalAuth } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const { v4: uuidv4 } = require('uuid');

// Lazy-load services (avoid circular dep at startup)
let _roundMgr = null;
let _fetcher   = null;
const getRoundMgr = () => _roundMgr || (_roundMgr = require('../services/roundManager'));
const getFetcher  = () => _fetcher  || (_fetcher  = require('../services/lotteryFetcher'));

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

// GET /api/lottery/rounds — open + upcoming rounds (for buying / display)
router.get('/rounds', async (req, res) => {
  const rows = await query(
    `SELECT lr.id,lr.uuid,lr.round_name,lr.draw_date,lr.open_at,lr.close_at,lr.status,lr.total_bet,lr.bet_count,
            lt.id as lottery_id,lt.name as lottery_name,lt.flag,lt.code,
            lt.rate_3top,lt.rate_3tod,lt.rate_2top,lt.rate_2bot,lt.rate_run_top,lt.rate_run_bot,
            lt.min_bet,lt.max_bet
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id=lt.id
     WHERE lr.status IN ('open','upcoming') AND lt.status='open' AND lr.close_at > NOW()
     ORDER BY lr.status='upcoming' DESC, lr.close_at ASC`);
  res.json({ success: true, data: rows });
});

// GET /api/lottery/results — recent results
router.get('/results', async (req, res) => {
  const { lottery_id, limit = 10 } = req.query;
  const lim = Math.min(parseInt(limit) || 10, 50);
  const where = []; const params = [];
  where.push("lr.status='announced'");
  if (lottery_id) { where.push('lr.lottery_id=?'); params.push(lottery_id); }
  const rows = await query(
    `SELECT lr.id,lr.round_name,lr.draw_date,lt.name as lottery_name,lt.flag,lt.code,
            res.prize_1st,res.prize_last_2,res.prize_2bot,res.prize_last_3,res.prize_front_3,res.announced_at
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id=lt.id
     LEFT JOIN lottery_results res ON lr.id=res.round_id
     WHERE ${where.join(' AND ')}
     ORDER BY lr.draw_date DESC, lr.id DESC LIMIT ${lim}`, params);
  res.json({ success: true, data: rows });
});

// GET /api/lottery/results/:roundId — full result detail
router.get('/results/:roundId', async (req, res) => {
  const [res_] = await query(
    `SELECT lr.*,lt.name as lottery_name,lt.flag,
            r.prize_1st,r.prize_2nd,r.prize_3rd,r.prize_4th,r.prize_5th,
            r.prize_near_1st,r.prize_front_3,r.prize_last_3,r.prize_last_2,r.prize_2bot,r.announced_at
     FROM lottery_rounds lr
     JOIN lottery_types lt ON lr.lottery_id=lt.id
     LEFT JOIN lottery_results r ON lr.id=r.round_id
     WHERE lr.id=?`, [req.params.roundId]);
  if (!res_) return res.status(404).json({ success: false, message: 'ไม่พบงวดนี้' });
  res.json({ success: true, data: res_ });
});

// GET /api/lottery/stats — public site stats
router.get('/stats', async (req, res) => {
  const [members]  = await query('SELECT COUNT(*) c FROM members WHERE status="active"');
  const [payout]   = await query('SELECT COALESCE(SUM(win_amount),0) total FROM bets WHERE status="win"');
  const [rounds]   = await query('SELECT COUNT(*) c FROM lottery_rounds WHERE status="open"');
  res.json({
    success      : true,
    member_count : members.c,
    total_payout : payout.total,
    active_rounds: rounds.c,
  });
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

    const roundRows = await query(
      `SELECT lr.*, lt.code AS lottery_code
       FROM lottery_rounds lr
       JOIN lottery_types lt ON lr.lottery_id = lt.id
       WHERE lr.id=? AND lr.status!='announced'`, [round_id]);
    if (!roundRows.length) return res.status(400).json({ success: false, message: 'ไม่พบงวด หรือประกาศผลแล้ว' });
    const round = roundRows[0];
    const lotteryCode = round.lottery_code;

    // ลาวพัฒนา: 2bot = ตำแหน่ง 3-4, 2top = ตำแหน่ง 5-6, 3top = ตำแหน่ง 4-5-6
    const isLaGov = lotteryCode === 'LA_GOV';
    const effective_2bot = isLaGov ? prize_1st.slice(2, 4) : prize_last_2;
    const effective_3top = isLaGov ? prize_1st.slice(3, 6) : prize_1st?.slice(-3);

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
      const ltRows = await query('SELECT rate_3top,rate_3tod,rate_2top,rate_2bot,rate_run_top,rate_run_bot FROM lottery_types lt JOIN lottery_rounds lr ON lr.lottery_id=lt.id WHERE lr.id=?', [round_id]);
      const lt = ltRows[0];
      const bets = await query('SELECT * FROM bets WHERE round_id=? AND status="waiting"', [round_id]);

      for (const bet of bets) {
        let won = false;
        let winAmt = 0;
        const n = bet.number;

        if (bet.bet_type === '3top' && effective_3top === n) { won = true; winAmt = bet.amount * lt.rate_3top; }
        else if (bet.bet_type === '3tod') {
          const sorted = n.split('').sort().join('');
          const p1sorted = effective_3top?.split('').sort().join('');
          if (sorted === p1sorted) { won = true; winAmt = bet.amount * lt.rate_3tod; }
        }
        else if (bet.bet_type === '2top' && prize_last_2 === n) { won = true; winAmt = bet.amount * lt.rate_2top; }
        else if (bet.bet_type === '2bot' && effective_2bot === n) { won = true; winAmt = bet.amount * lt.rate_2bot; }
        else if (bet.bet_type === 'run_top' && prize_1st?.includes(n)) { won = true; winAmt = bet.amount * lt.rate_run_top; }
        else if (bet.bet_type === 'run_bot' && effective_2bot?.includes(n)) { won = true; winAmt = bet.amount * lt.rate_run_bot; }

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

// ════════════════════════════════════
//  ADMIN: Auto-round + fetcher control
// ════════════════════════════════════

// POST /api/lottery/admin/force-rounds — force-recreate today's rounds
router.post('/admin/force-rounds', authAdmin, rbac.requirePerm('rounds.manage'), async (req, res) => {
  try {
    const rm = getRoundMgr();
    await rm.createTodayRounds();
    await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
      [req.admin.id, 'rounds.force', 'system', 0, 'manual force-create today rounds', req.ip]);
    res.json({ success: true, message: 'สร้างงวดของวันนี้สำเร็จ (งวดที่มีแล้วจะ skip)' });
  } catch (err) {
    console.error('[ADMIN] force-rounds error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/lottery/admin/trigger-fetch/:code — manually trigger result fetch
router.post('/admin/trigger-fetch/:code', authAdmin, rbac.requirePerm('results.announce'), async (req, res) => {
  const { code } = req.params;
  const validCodes = ['TH_GOV','LA_GOV','VN_HAN','VN_HAN_SP','VN_HAN_VIP','YEEKEE'];
  if (!validCodes.includes(code)) {
    return res.status(400).json({ success: false, message: `ไม่รู้จัก lottery code: ${code}` });
  }
  try {
    const fetcher = getFetcher();
    // Run fetch in background — respond immediately
    fetcher.triggerFetch(code).catch(e => console.error(`[ADMIN] trigger-fetch ${code}:`, e.message));
    await query('INSERT INTO admin_logs (admin_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?)',
      [req.admin.id, 'fetcher.trigger', 'lottery_type', 0, `manual trigger: ${code}`, req.ip]);
    res.json({ success: true, message: `กำลังดึงผล ${code}...` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/lottery/admin/fetcher-status — show fetcher + round status
router.get('/admin/fetcher-status', authAdmin, rbac.requirePerm('lottery.view'), async (req, res) => {
  try {
    const fetcher = getFetcher();
    const status  = fetcher.fetcherStatus || {};

    // Latest round per lottery type
    const rounds = await query(
      `SELECT lt.code, lt.name, lr.id, lr.round_name, lr.status, lr.open_at, lr.close_at,
              lr.bet_count, lr.total_bet,
              res.announced_at, res.prize_1st
       FROM lottery_types lt
       LEFT JOIN lottery_rounds lr ON lr.id = (
         SELECT id FROM lottery_rounds WHERE lottery_id=lt.id ORDER BY id DESC LIMIT 1
       )
       LEFT JOIN lottery_results res ON res.round_id = lr.id
       WHERE lt.status='open'
       ORDER BY lt.sort_order`
    );

    res.json({ success: true, fetcherStatus: status, rounds });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/lottery/admin/rounds/today — today's round summary for all types
router.get('/admin/rounds/today', authAdmin, rbac.requirePerm('rounds.view'), async (req, res) => {
  try {
    const rows = await query(
      `SELECT lr.id, lr.round_code, lr.round_name, lr.status,
              lr.open_at, lr.close_at, lr.bet_count, lr.total_bet,
              lt.code AS lottery_code, lt.name AS lottery_name, lt.flag,
              res.prize_1st, res.announced_at
       FROM lottery_rounds lr
       JOIN lottery_types lt ON lt.id = lr.lottery_id
       LEFT JOIN lottery_results res ON res.round_id = lr.id
       WHERE DATE(lr.draw_date) = CURDATE()
       ORDER BY lt.sort_order, lr.open_at`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
