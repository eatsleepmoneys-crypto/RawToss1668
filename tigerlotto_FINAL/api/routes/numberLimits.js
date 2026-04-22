const router = require('express').Router();
const { query, transaction } = require('../config/db');
const { authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');

// ─── helper: get limit row (round-specific first, then template) ──────────────
async function getLimitRow(conn, lottery_id, round_id, number, bet_type) {
  const rows = conn
    ? (await conn.execute(
        `SELECT * FROM number_limits
         WHERE lottery_id=? AND number=? AND bet_type=?
           AND (round_id=? OR round_id IS NULL)
         ORDER BY (round_id IS NULL) ASC
         LIMIT 1`,
        [lottery_id, number, bet_type, round_id]
      ))[0]
    : await query(
        `SELECT * FROM number_limits
         WHERE lottery_id=? AND number=? AND bet_type=?
           AND (round_id=? OR round_id IS NULL)
         ORDER BY (round_id IS NULL) ASC
         LIMIT 1`,
        [lottery_id, number, bet_type, round_id]
      );
  return rows[0] || null;
}

// ─── GET /api/number-limits ───────────────────────────────────────────────────
// List limits — filter by lottery_id, round_id, number, bet_type
router.get('/', authAdmin, async (req, res) => {
  const { lottery_id, round_id, number, bet_type } = req.query;
  const pg      = Math.max(parseInt(req.query.page) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  const offset  = (pg - 1) * perPage;

  const where = []; const params = [];
  if (lottery_id) { where.push('nl.lottery_id=?'); params.push(parseInt(lottery_id)); }
  if (round_id !== undefined) {
    if (round_id === 'null' || round_id === '') where.push('nl.round_id IS NULL');
    else { where.push('nl.round_id=?'); params.push(parseInt(round_id)); }
  }
  if (number) { where.push('nl.number LIKE ?'); params.push(`%${number}%`); }
  if (bet_type) { where.push('nl.bet_type=?'); params.push(bet_type); }
  const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await query(
    `SELECT nl.*, lt.name AS lottery_name, lt.code AS lottery_code, lt.flag AS lottery_flag,
            lr.round_name
     FROM number_limits nl
     JOIN lottery_types lt ON nl.lottery_id = lt.id
     LEFT JOIN lottery_rounds lr ON nl.round_id = lr.id
     ${wc}
     ORDER BY nl.lottery_id, nl.number, nl.bet_type
     LIMIT ${perPage} OFFSET ${offset}`, params);

  const cnt = await query(`SELECT COUNT(*) c FROM number_limits nl ${wc}`, params);
  res.json({ success: true, data: rows, total: cnt[0].c, page: pg, limit: perPage });
});

// ─── GET /api/number-limits/lottery-types ─────────────────────────────────────
// Helper: list lottery types for dropdowns
router.get('/lottery-types', authAdmin, async (req, res) => {
  const rows = await query('SELECT id,name,code,flag FROM lottery_types WHERE status="open" ORDER BY id');
  res.json({ success: true, data: rows });
});

// ─── POST /api/number-limits ──────────────────────────────────────────────────
// Create or upsert a limit config
router.post('/', authAdmin, async (req, res) => {
  const {
    lottery_id, round_id = null,
    number, bet_type,
    tier1_limit    = 0,
    tier2_rate     = 100, tier2_limit    = 0,
    tier2_1_rate   = null, tier2_1_limit = 0,
    tier2_2_rate   = null, tier2_2_limit = 0,
    tier2_3_rate   = null, tier2_3_limit = 0,
  } = req.body;

  if (!lottery_id || !number || !bet_type) {
    return res.status(400).json({ success: false, message: 'lottery_id, number, bet_type จำเป็น' });
  }

  const result = await query(
    `INSERT INTO number_limits
       (lottery_id, round_id, number, bet_type,
        tier1_limit,
        tier2_rate,   tier2_limit,
        tier2_1_rate, tier2_1_limit,
        tier2_2_rate, tier2_2_limit,
        tier2_3_rate, tier2_3_limit,
        current_tier)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'1')
     ON DUPLICATE KEY UPDATE
       tier1_limit    = VALUES(tier1_limit),
       tier2_rate     = VALUES(tier2_rate),   tier2_limit    = VALUES(tier2_limit),
       tier2_1_rate   = VALUES(tier2_1_rate), tier2_1_limit  = VALUES(tier2_1_limit),
       tier2_2_rate   = VALUES(tier2_2_rate), tier2_2_limit  = VALUES(tier2_2_limit),
       tier2_3_rate   = VALUES(tier2_3_rate), tier2_3_limit  = VALUES(tier2_3_limit)`,
    [lottery_id, round_id, number, bet_type,
     tier1_limit,
     tier2_rate,   tier2_limit,
     tier2_1_rate, tier2_1_limit,
     tier2_2_rate, tier2_2_limit,
     tier2_3_rate, tier2_3_limit]
  );

  res.status(201).json({ success: true, message: 'บันทึกแล้ว', id: result.insertId });
});

// ─── POST /api/number-limits/bulk ─────────────────────────────────────────────
// Bulk create limits for multiple numbers (comma-separated or array)
router.post('/bulk', authAdmin, async (req, res) => {
  const {
    lottery_id, round_id = null, bet_type,
    numbers,  // array or comma-separated string
    tier1_limit    = 0,
    tier2_rate     = 100, tier2_limit    = 0,
    tier2_1_rate   = null, tier2_1_limit = 0,
    tier2_2_rate   = null, tier2_2_limit = 0,
    tier2_3_rate   = null, tier2_3_limit = 0,
  } = req.body;

  if (!lottery_id || !numbers || !bet_type) {
    return res.status(400).json({ success: false, message: 'lottery_id, numbers, bet_type จำเป็น' });
  }

  const numList = Array.isArray(numbers) ? numbers : String(numbers).split(/[\s,]+/).filter(Boolean);
  if (!numList.length) return res.status(400).json({ success: false, message: 'ไม่พบตัวเลขที่ระบุ' });

  let inserted = 0;
  for (const num of numList) {
    await query(
      `INSERT INTO number_limits
         (lottery_id, round_id, number, bet_type,
          tier1_limit, tier2_rate, tier2_limit,
          tier2_1_rate, tier2_1_limit, tier2_2_rate, tier2_2_limit,
          tier2_3_rate, tier2_3_limit, current_tier)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'1')
       ON DUPLICATE KEY UPDATE
         tier1_limit=VALUES(tier1_limit), tier2_rate=VALUES(tier2_rate), tier2_limit=VALUES(tier2_limit),
         tier2_1_rate=VALUES(tier2_1_rate), tier2_1_limit=VALUES(tier2_1_limit),
         tier2_2_rate=VALUES(tier2_2_rate), tier2_2_limit=VALUES(tier2_2_limit),
         tier2_3_rate=VALUES(tier2_3_rate), tier2_3_limit=VALUES(tier2_3_limit)`,
      [lottery_id, round_id, num.trim(), bet_type,
       tier1_limit, tier2_rate, tier2_limit,
       tier2_1_rate, tier2_1_limit, tier2_2_rate, tier2_2_limit,
       tier2_3_rate, tier2_3_limit]
    );
    inserted++;
  }

  res.status(201).json({ success: true, message: `บันทึก ${inserted} รายการแล้ว`, count: inserted });
});

// ─── PATCH /api/number-limits/:id ─────────────────────────────────────────────
// Update limit config (including manual tier override)
router.patch('/:id', authAdmin, async (req, res) => {
  const allowed = [
    'tier1_limit',
    'tier2_rate', 'tier2_limit',
    'tier2_1_rate', 'tier2_1_limit',
    'tier2_2_rate', 'tier2_2_limit',
    'tier2_3_rate', 'tier2_3_limit',
    'current_tier',
  ];
  const sets = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { sets.push(`${key}=?`); params.push(req.body[key]); }
  }
  if (!sets.length) return res.status(400).json({ success: false, message: 'ไม่มีฟิลด์ที่จะอัปเดต' });

  // Auto-set timestamps when manually changing tier
  if (req.body.current_tier) {
    if (['2', '2.1', '2.2', '2.3'].includes(req.body.current_tier)) {
      sets.push('escalated_at = COALESCE(escalated_at, NOW())');
      sets.push('closed_at = NULL');
    } else if (req.body.current_tier === '3') {
      sets.push('closed_at = NOW()');
    } else if (req.body.current_tier === '1') {
      sets.push('escalated_at = NULL');
      sets.push('closed_at = NULL');
    }
  }

  params.push(parseInt(req.params.id));
  await query(`UPDATE number_limits SET ${sets.join(',')} WHERE id=?`, params);
  res.json({ success: true, message: 'อัปเดตแล้ว' });
});

// ─── PATCH /api/number-limits/:id/reset ───────────────────────────────────────
// Reset used counters → back to tier 1
router.patch('/:id/reset', authAdmin, async (req, res) => {
  await query(
    `UPDATE number_limits SET
       tier1_used=0, tier2_used=0, tier2_1_used=0, tier2_2_used=0, tier2_3_used=0,
       current_tier='1', escalated_at=NULL, closed_at=NULL
     WHERE id=?`,
    [parseInt(req.params.id)]
  );
  res.json({ success: true, message: 'รีเซ็ตถังแล้ว' });
});

// ─── DELETE /api/number-limits/:id ────────────────────────────────────────────
router.delete('/:id', authAdmin, async (req, res) => {
  await query('DELETE FROM number_limits WHERE id=?', [parseInt(req.params.id)]);
  res.json({ success: true, message: 'ลบแล้ว' });
});

// ─── Export helper for use in bets.js ─────────────────────────────────────────
module.exports = router;
module.exports.getLimitRow = getLimitRow;
