const router = require('express').Router();
const { query } = require('../config/db');
const { authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');

// GET /api/settings — public settings (non-sensitive)
router.get('/', async (req, res) => {
  const rows = await query(
    'SELECT `key`,`value`,`type` FROM settings WHERE `group` IN ("general","contact","finance","hero") AND `key` NOT LIKE "%secret%" AND `key` NOT LIKE "%password%" AND `key` NOT IN ("site_url","auto_approve_deposit","auto_approve_max")');
  const map = {};
  rows.forEach(r => {
    map[r.key] = r.type === 'boolean' ? r.value === 'true'
               : r.type === 'number'  ? parseFloat(r.value)
               : r.type === 'json'    ? JSON.parse(r.value || '{}')
               : r.value;
  });
  res.json({ success: true, data: map });
});

// GET /api/settings/admin/all — all settings for admin
router.get('/admin/all', authAdmin, rbac.requirePerm('settings.view'), async (req, res) => {
  const { group } = req.query;
  const where = group ? 'WHERE `group`=?' : '';
  const rows = await query(`SELECT * FROM settings ${where} ORDER BY \`group\`,\`key\``, group ? [group] : []);
  res.json({ success: true, data: rows });
});

// PUT /api/settings/admin — update one or many settings
router.put('/admin', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  const updates = req.body; // { key: value, ... }
  if (!updates || typeof updates !== 'object')
    return res.status(400).json({ success: false, message: 'Invalid body' });

  // group mapping — ให้ key ถูก upsert ใน group ที่ถูกต้อง
  const KEY_GROUP = {
    site_name:'general', site_url:'general', site_tagline:'general',
    site_logo_url:'general', seo_title:'general',
    line_id:'contact', line_url:'contact', line_qr_url:'contact', contact_tel:'contact',
    min_deposit:'finance', max_deposit:'finance', min_withdraw:'finance',
    max_withdraw:'finance', auto_approve_max:'finance',
    bonus_new_member:'promotion', cashback_percent:'promotion', referral_commission:'promotion',
    session_expire:'security', pw_min_length:'security',
    slipok_enabled:'slipok', slipok_api_key:'slipok', slipok_branch_id:'slipok',
    hero_badge:'hero', hero_title1:'hero', hero_title2:'hero', hero_cta1:'hero', ticker_items:'hero',
  };
  for (const [key, value] of Object.entries(updates)) {
    const grp = KEY_GROUP[key] || 'general';
    // Upsert: create if missing, update if exists
    await query(
      `INSERT INTO settings (\`key\`,value,type,\`group\`) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE value=?`,
      [key, String(value), 'string', grp, String(value)]
    );
  }
  await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
    [req.admin.id, 'settings.update', JSON.stringify(Object.keys(updates)), req.ip]);
  res.json({ success: true, message: 'บันทึกการตั้งค่าแล้ว' });
});

// ═══════════════════════════════════════════════════════════
//  SLIPOK SETTINGS
// ═══════════════════════════════════════════════════════════

// GET /api/settings/admin/slipok — ดึงการตั้งค่า SlipOK (ซ่อน api key บางส่วน)
router.get('/admin/slipok', authAdmin, rbac.requirePerm('settings.view'), async (req, res) => {
  const rows = await query("SELECT `key`, value FROM settings WHERE `group`='slipok'");
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  // Mask api key (show last 4 only)
  const rawKey = map['slipok_api_key'] || '';
  const maskedKey = rawKey.length > 4
    ? '•'.repeat(rawKey.length - 4) + rawKey.slice(-4)
    : rawKey ? '••••' : '';
  res.json({
    success: true,
    data: {
      enabled   : map['slipok_enabled'] === 'true',
      api_key   : maskedKey,
      branch_id : map['slipok_branch_id'] || '',
      has_key   : rawKey.length > 0,
    }
  });
});

// PUT /api/settings/admin/slipok — บันทึกการตั้งค่า SlipOK
router.put('/admin/slipok', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  const { api_key, branch_id, enabled } = req.body;
  const updates = {};
  if (typeof enabled !== 'undefined') updates['slipok_enabled'] = String(enabled);
  if (branch_id !== undefined) updates['slipok_branch_id'] = branch_id;
  // Only update api_key if a real value is provided (not masked)
  if (api_key && !api_key.includes('•')) updates['slipok_api_key'] = api_key;

  for (const [key, value] of Object.entries(updates)) {
    await query(
      `INSERT INTO settings (\`key\`,value,type,\`group\`) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE value=?`,
      [key, value, key === 'slipok_enabled' ? 'boolean' : 'string', 'slipok', value]
    );
  }
  await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
    [req.admin.id, 'settings.slipok', JSON.stringify(Object.keys(updates)), req.ip]);
  res.json({ success: true, message: 'บันทึกการตั้งค่า SlipOK แล้ว' });
});

// POST /api/settings/admin/slipok/test — ทดสอบการเชื่อมต่อ SlipOK
router.post('/admin/slipok/test', authAdmin, rbac.requirePerm('settings.view'), async (req, res) => {
  const { getSlipOKCredentials } = require('../services/slipVerifier');
  const creds = await getSlipOKCredentials();
  if (!creds.apiKey || !creds.branchId) {
    return res.json({ success: false, message: 'กรุณาบันทึก API Key และ Branch ID ก่อนทดสอบ' });
  }

  try {
    const axios    = require('axios');
    const FormData = require('form-data');

    // SlipOK รับแค่ POST — ส่ง POST ไม่มีไฟล์เพื่อทดสอบ credentials
    // Response คาดหวัง:
    //   400  = credentials ถูกต้อง แต่ไม่มีไฟล์สลิป (คาดหวัง ✅)
    //   401  = API Key ไม่ถูกต้อง ❌
    //   403  = Forbidden ❌
    //   404  = Branch ID ไม่พบ ❌
    //   200  = OK ✅
    const form = new FormData();
    // ไม่แนบไฟล์ — แค่ทดสอบว่า credentials ผ่านหรือไม่
    const r = await axios.post(
      `https://api.slipok.com/api/line/apikey/${creds.branchId}`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-authorization': creds.apiKey,
        },
        timeout: 12000,
        validateStatus: () => true, // ไม่ throw บน 4xx
      }
    );

    const body = r.data || {};
    const status = r.status;

    if (status === 200 || status === 400) {
      // 400 = credentials ถูก แต่ไม่มีไฟล์ = ปกติ
      const code = body?.code || body?.message || '';
      // ถ้า 400 + code บอกว่า no file = ✅ credentials valid
      return res.json({
        success : true,
        message : `✅ เชื่อมต่อสำเร็จ! Branch ID: ${creds.branchId} พร้อมใช้งาน`,
        status,
        detail  : code || 'พร้อมรับสลิป',
      });
    }

    if (status === 401) {
      return res.json({ success: false, message: '❌ API Key ไม่ถูกต้อง — กรุณาตรวจสอบใหม่' });
    }
    if (status === 403) {
      return res.json({ success: false, message: '❌ ไม่มีสิทธิ์เข้าถึง (403) — ตรวจสอบ API Key' });
    }
    if (status === 404) {
      return res.json({ success: false, message: `❌ Branch ID "${creds.branchId}" ไม่พบในระบบ SlipOK — กรุณาตรวจสอบใหม่` });
    }

    // status อื่น
    return res.json({
      success : false,
      message : `⚠️ SlipOK ตอบกลับ HTTP ${status} — ${body?.message || body?.code || 'ไม่ทราบสาเหตุ'}`,
      status,
    });

  } catch (e) {
    if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
      return res.json({ success: false, message: '⚠️ ทดสอบล้มเหลว: SlipOK ไม่ตอบสนอง (timeout)' });
    }
    return res.json({ success: false, message: `⚠️ ทดสอบล้มเหลว: ${e.message}` });
  }
});

// GET /api/settings/admin/api-keys — sensitive API settings (superadmin only)
router.get('/admin/api-keys', authAdmin, rbac.requirePerm('api.view'), async (req, res) => {
  const rows = await query('SELECT * FROM settings WHERE `group` IN ("line","sms","payment","security")');
  res.json({ success: true, data: rows });
});

// PUT /api/settings/admin/api-keys
router.put('/admin/api-keys', authAdmin, rbac.requirePerm('api.manage'), async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    // Upsert
    await query(
      'INSERT INTO settings (`key`,value,type,`group`) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE value=?',
      [key, String(value), 'string', 'api', String(value)]);
  }
  await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
    [req.admin.id, 'api.update', JSON.stringify(Object.keys(updates)), req.ip]);
  res.json({ success: true, message: 'บันทึก API Keys แล้ว' });
});

// POST /api/settings/admin/maintenance
router.post('/admin/maintenance', authAdmin, rbac.requirePerm('settings.manage'), async (req, res) => {
  const { enabled, message } = req.body;
  await query('UPDATE settings SET value=? WHERE `key`="maintenance_mode"', [String(enabled)]);
  if (message) await query('INSERT INTO settings (`key`,value,type,`group`) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE value=?',
    ['maintenance_message', message, 'string', 'general', message]);
  res.json({ success: true, message: `Maintenance mode ${enabled ? 'เปิด' : 'ปิด'} แล้ว` });
});

// ═══════════════════════════════════════════════════════════
//  SCRAPERAPI PROXY KEY
// ═══════════════════════════════════════════════════════════
const axios = require('axios');

// POST /api/settings/admin/scraper-key — save ScraperAPI key
router.post('/admin/scraper-key', authAdmin, rbac.requirePerm('api.manage'), async (req, res) => {
  const { key } = req.body;
  if (!key || key.length < 8) return res.status(400).json({ success: false, message: 'กรุณาใส่ key ที่ถูกต้อง' });
  try {
    await query(
      `INSERT INTO settings (\`key\`, value, type, \`group\`)
       VALUES ('scraperapi_key', ?, 'string', 'api')
       ON DUPLICATE KEY UPDATE value=?`,
      [key, key]
    );
    // Invalidate cache in fetcher
    try { require('../services/lotteryFetcher').clearScraperApiKeyCache?.(); } catch {}
    await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
      [req.admin.id, 'api.scraperkey.save', 'scraperapi_key saved', req.ip]);
    res.json({ success: true, message: 'บันทึก ScraperAPI Key สำเร็จ' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/settings/admin/scraper-key/test — test ScraperAPI connectivity
router.post('/admin/scraper-key/test', authAdmin, rbac.requirePerm('api.view'), async (req, res) => {
  // Use provided key (from form) or fetch from DB
  let key = req.body?.key?.trim();
  if (!key) {
    const rows = await query("SELECT value FROM settings WHERE `key`='scraperapi_key' LIMIT 1");
    key = rows[0]?.value;
  }
  if (!key) return res.status(400).json({ success: false, message: 'ไม่พบ ScraperAPI Key — กรุณาบันทึกก่อน' });

  // Test by fetching ScraperAPI's account endpoint (returns credit info)
  try {
    const r = await axios.get(`https://api.scraperapi.com/account?api_key=${key}`, { timeout: 10000 });
    const d = r.data;
    const msg = `เครดิตที่ใช้: ${d.requestCount || 0} / ${d.requestLimit || '?'} calls`;
    return res.json({ success: true, message: msg, data: d });
  } catch (e) {
    const code = e.response?.status;
    if (code === 403) return res.json({ success: false, message: 'API Key ไม่ถูกต้อง (403)' });
    return res.json({ success: false, message: `ทดสอบล้มเหลว: ${e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════
//  LOTTERY API SOURCES
// ═══════════════════════════════════════════════════════════

// GET /api/settings/admin/lottery-sources — list all sources
router.get('/admin/lottery-sources', authAdmin, rbac.requirePerm('api.view'), async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, lottery_code, name, source_url, method, api_key, api_secret,
              extra_headers, body_template, transform,
              path_prize1, path_last2, path_front3, path_last3,
              enabled, sort_order, last_status, last_checked, last_result, updated_at
       FROM lottery_api_sources
       ORDER BY lottery_code, sort_order, id`
    );
    // mask api_secret
    rows.forEach(r => { if (r.api_secret) r.api_secret = '••••••••'; });
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/settings/admin/lottery-sources — add new source
router.post('/admin/lottery-sources', authAdmin, rbac.requirePerm('api.manage'), async (req, res) => {
  const {
    lottery_code, name, source_url, method = 'GET',
    api_key, api_secret, extra_headers, body_template,
    transform = 'auto', path_prize1, path_last2, path_front3, path_last3,
    enabled = 1, sort_order = 99,
  } = req.body;
  if (!lottery_code || !source_url) {
    return res.status(400).json({ success: false, message: 'lottery_code และ source_url จำเป็น' });
  }
  try {
    const result = await query(
      `INSERT INTO lottery_api_sources
         (lottery_code, name, source_url, method, api_key, api_secret, extra_headers, body_template,
          transform, path_prize1, path_last2, path_front3, path_last3, enabled, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lottery_code, name || source_url, source_url, method,
       api_key || null, api_secret || null, extra_headers || null, body_template || null,
       transform, path_prize1 || null, path_last2 || null, path_front3 || null, path_last3 || null,
       enabled ? 1 : 0, sort_order]
    );
    await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
      [req.admin.id, 'api_source.add', `${lottery_code}: ${source_url}`, req.ip]);
    res.status(201).json({ success: true, message: 'เพิ่ม API Source สำเร็จ', id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/settings/admin/lottery-sources/:id — update source
router.patch('/admin/lottery-sources/:id', authAdmin, rbac.requirePerm('api.manage'), async (req, res) => {
  const { id } = req.params;
  const allowed = ['name','source_url','method','api_key','api_secret','extra_headers','body_template',
                   'transform','path_prize1','path_last2','path_front3','path_last3','enabled','sort_order'];
  const sets = []; const vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      sets.push(`\`${k}\`=?`);
      vals.push(req.body[k] === '' ? null : req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่จะอัพเดท' });
  vals.push(id);
  try {
    await query(`UPDATE lottery_api_sources SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ success: true, message: 'อัพเดท API Source สำเร็จ' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/settings/admin/lottery-sources/:id
router.delete('/admin/lottery-sources/:id', authAdmin, rbac.requirePerm('api.manage'), async (req, res) => {
  try {
    await query('DELETE FROM lottery_api_sources WHERE id=?', [req.params.id]);
    res.json({ success: true, message: 'ลบ API Source สำเร็จ' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/settings/admin/lottery-sources/:id/test — test connectivity + parse result
router.post('/admin/lottery-sources/:id/test', authAdmin, rbac.requirePerm('api.view'), async (req, res) => {
  try {
    const rows = await query('SELECT * FROM lottery_api_sources WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบ source' });
    const src = rows[0];

    // Lazy-load fetcher for its HTTP helper + transform logic
    const fetcher = require('../services/lotteryFetcher');
    const result  = await fetcher.testSource(src);

    // Update status in DB
    await query(
      'UPDATE lottery_api_sources SET last_status=?, last_checked=NOW(), last_result=? WHERE id=?',
      [result.success ? 'ok' : 'error', JSON.stringify(result), src.id]
    );

    res.json({ success: true, data: result });
  } catch (err) {
    await query('UPDATE lottery_api_sources SET last_status="error", last_checked=NOW() WHERE id=?',
      [req.params.id]).catch(() => {});
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
