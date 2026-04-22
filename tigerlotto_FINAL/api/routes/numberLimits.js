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

// ─── POST /api/number-limits/rate-check-batch ─────────────────────────────────
// Public endpoint (no auth) — members call this to see effective payout rate
// Body: { lottery_id, round_id, checks: [{number, bet_type}] }
// Returns: { results: [{number, bet_type, tier, rate_override, closed, effective_rate}] }
router.post('/rate-check-batch', async (req, res) => {
  const { lottery_id, round_id = null, checks = [] } = req.body;
  if (!lottery_id || !Array.isArray(checks) || checks.length === 0) {
    return res.json({ success: true, results: [] });
  }

  // Fetch base rates for this lottery type
  const ltRows = await query(
    'SELECT rate_3top,rate_3tod,rate_2top,rate_2bot,rate_run_top,rate_run_bot FROM lottery_types WHERE id=?',
    [parseInt(lottery_id)]
  );
  const lt = ltRows[0] || {};
  const BASE_RATE = {
    '3top': lt.rate_3top || 750, '3tod': lt.rate_3tod || 120,
    '2top': lt.rate_2top || 95,  '2bot': lt.rate_2bot || 90,
    'run_top': lt.rate_run_top || 3.2, 'run_bot': lt.rate_run_bot || 4.2,
  };

  // Fetch global caps (number='*') for this lottery+round — one per bet_type
  const globalRows = await query(
    `SELECT bet_type, current_tier,
            tier2_rate, tier2_1_rate, tier2_2_rate, tier2_3_rate
     FROM number_limits
     WHERE lottery_id=? AND number='*'
       AND (round_id=? OR round_id IS NULL)
     ORDER BY (round_id IS NULL) ASC`,
    [parseInt(lottery_id), round_id ? parseInt(round_id) : null]
  );
  // Build global map: bet_type → first (round-specific preferred)
  const globalMap = {};
  for (const g of globalRows) {
    if (!globalMap[g.bet_type]) globalMap[g.bet_type] = g;
  }

  // Deduplicate checks to avoid N+1
  const uniqueKeys = [...new Set(checks.map(c => `${c.number}:${c.bet_type}`))];

  // Fetch all needed per-number rows in one query
  if (uniqueKeys.length === 0) return res.json({ success: true, results: [] });
  const numberList  = [...new Set(checks.map(c => c.number))];
  const betTypeList = [...new Set(checks.map(c => c.bet_type))];

  const placeholders = numberList.map(() => '?').join(',');
  const btPlaceholders = betTypeList.map(() => '?').join(',');
  const perNumRows = await query(
    `SELECT number, bet_type, current_tier,
            tier2_rate, tier2_1_rate, tier2_2_rate, tier2_3_rate
     FROM number_limits
     WHERE lottery_id=? AND number IN (${placeholders}) AND bet_type IN (${btPlaceholders})
       AND (round_id=? OR round_id IS NULL)
     ORDER BY (round_id IS NULL) ASC`,
    [parseInt(lottery_id), ...numberList, ...betTypeList, round_id ? parseInt(round_id) : null]
  );
  // Build per-num map: "number:bet_type" → first row (round-specific preferred)
  const perNumMap = {};
  for (const r of perNumRows) {
    const k = `${r.number}:${r.bet_type}`;
    if (!perNumMap[k]) perNumMap[k] = r;
  }

  function getTierRate(row) {
    if (!row) return null;
    const t = row.current_tier;
    if (t === '1') return null; // full rate
    if (t === '2') return parseFloat(row.tier2_rate) || 100;
    if (t === '2.1') return parseFloat(row.tier2_1_rate) || null;
    if (t === '2.2') return parseFloat(row.tier2_2_rate) || null;
    if (t === '2.3') return parseFloat(row.tier2_3_rate) || null;
    if (t === '3') return 0; // closed
    return null;
  }

  const results = checks.map(({ number, bet_type }) => {
    const gRow = globalMap[bet_type] || null;
    const nRow = perNumMap[`${number}:${bet_type}`] || null;

    const gRate = getTierRate(gRow);
    const nRate = getTierRate(nRow);

    let rate_override = null;
    if (gRate !== null && nRate !== null) rate_override = Math.min(gRate, nRate);
    else if (gRate !== null) rate_override = gRate;
    else if (nRate !== null) rate_override = nRate;

    const closed = rate_override === 0 ||
                   gRow?.current_tier === '3' || nRow?.current_tier === '3';

    const base = BASE_RATE[bet_type] || null;
    const effective_rate = closed ? 0
      : (rate_override !== null && base !== null)
        ? Math.round(base * rate_override / 100 * 100) / 100
        : base;

    const tier = closed ? '3'
      : (nRow?.current_tier !== '1' && nRow?.current_tier ? nRow.current_tier
        : (gRow?.current_tier !== '1' && gRow?.current_tier ? gRow.current_tier : '1'));

    return { number, bet_type, tier, rate_override, closed, effective_rate, base_rate: base };
  });

  res.json({ success: true, results });
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

// ─── POST /api/number-limits/auto-spread ──────────────────────────────────────
// Auto-distribute total budget across all possible numbers for each bet_type
// overrides = [{ number, bet_type, tier1_limit }] for custom per-number adjustments
router.post('/auto-spread', authAdmin, async (req, res) => {
  const { lottery_id, round_id = null, bet_types = {}, overrides = [] } = req.body;
  if (!lottery_id) return res.status(400).json({ success: false, message: 'lottery_id จำเป็น' });

  const DIGIT_COUNT = { '3top':3,'3tod':3,'2top':2,'2bot':2,'run_top':1,'run_bot':1 };

  // Build override lookup: { 'bet_type:number': tier1_limit }
  const ovMap = {};
  for (const ov of overrides) {
    if (ov.number && ov.bet_type) ovMap[`${ov.bet_type}:${ov.number}`] = parseFloat(ov.tier1_limit) || 0;
  }

  let created = 0;
  const errors = [];

  for (const [bet_type, cfg] of Object.entries(bet_types)) {
    if (!cfg || !cfg.total_budget || parseFloat(cfg.total_budget) <= 0) continue;
    const digits = DIGIT_COUNT[bet_type];
    if (!digits) continue;

    const count       = Math.pow(10, digits);        // 10 / 100 / 1000
    const perNumLimit = Math.floor(parseFloat(cfg.total_budget) / count);
    if (perNumLimit <= 0) { errors.push(`${bet_type}: งบต่อเลขน้อยเกินไป (${cfg.total_budget}/${count})`); continue; }

    const t2r  = parseFloat(cfg.tier2_rate)    || 100;
    const t2l  = parseFloat(cfg.tier2_limit)   || 0;
    const t21r = cfg.tier2_1_rate  != null && cfg.tier2_1_rate  !== '' ? parseFloat(cfg.tier2_1_rate)  : null;
    const t21l = parseFloat(cfg.tier2_1_limit) || 0;
    const t22r = cfg.tier2_2_rate  != null && cfg.tier2_2_rate  !== '' ? parseFloat(cfg.tier2_2_rate)  : null;
    const t22l = parseFloat(cfg.tier2_2_limit) || 0;
    const t23r = cfg.tier2_3_rate  != null && cfg.tier2_3_rate  !== '' ? parseFloat(cfg.tier2_3_rate)  : null;
    const t23l = parseFloat(cfg.tier2_3_limit) || 0;

    const startTier = cfg.skip_tier1 ? '2' : '1';

    // Generate all numbers for this digit count
    for (let i = 0; i < count; i++) {
      const num = String(i).padStart(digits, '0');
      const ovKey = `${bet_type}:${num}`;
      const limit = ovKey in ovMap ? ovMap[ovKey] : perNumLimit;

      try {
        await query(
          `INSERT INTO number_limits
             (lottery_id, round_id, number, bet_type,
              tier1_limit, tier2_rate, tier2_limit,
              tier2_1_rate, tier2_1_limit, tier2_2_rate, tier2_2_limit,
              tier2_3_rate, tier2_3_limit, current_tier,
              escalated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,IF(?='2',NOW(),NULL))
           ON DUPLICATE KEY UPDATE
             tier1_limit=VALUES(tier1_limit),
             tier2_rate=VALUES(tier2_rate),   tier2_limit=VALUES(tier2_limit),
             tier2_1_rate=VALUES(tier2_1_rate), tier2_1_limit=VALUES(tier2_1_limit),
             tier2_2_rate=VALUES(tier2_2_rate), tier2_2_limit=VALUES(tier2_2_limit),
             tier2_3_rate=VALUES(tier2_3_rate), tier2_3_limit=VALUES(tier2_3_limit),
             current_tier=VALUES(current_tier),
             escalated_at=VALUES(escalated_at)`,
          [lottery_id, round_id, num, bet_type,
           limit, t2r, t2l, t21r, t21l, t22r, t22l, t23r, t23l,
           startTier, startTier]
        );
        created++;
      } catch(e) { errors.push(`${bet_type}:${num} — ${e.message.substring(0,60)}`); }
    }
  }

  res.json({
    success: true,
    message: `สร้าง ${created} รายการแล้ว${errors.length ? ` (${errors.length} error)` : ''}`,
    count: created,
    errors: errors.slice(0, 10),
  });
});

// ─── Export helper for use in bets.js ─────────────────────────────────────────
module.exports = router;
module.exports.getLimitRow = getLimitRow;
