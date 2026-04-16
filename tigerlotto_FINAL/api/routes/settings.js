const router = require('express').Router();
const { query } = require('../config/db');
const { authAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');

// GET /api/settings — public settings (non-sensitive)
router.get('/', async (req, res) => {
  const rows = await query(
    'SELECT `key`,`value`,`type` FROM settings WHERE `group` IN ("general","contact","finance") AND `key` NOT LIKE "%secret%" AND `key` NOT LIKE "%password%"');
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
router.get('/admin/all', authAdmin, rbac.require('settings.view'), async (req, res) => {
  const { group } = req.query;
  const where = group ? 'WHERE `group`=?' : '';
  const rows = await query(`SELECT * FROM settings ${where} ORDER BY \`group\`,\`key\``, group ? [group] : []);
  res.json({ success: true, data: rows });
});

// PUT /api/settings/admin — update one or many settings
router.put('/admin', authAdmin, rbac.require('settings.manage'), async (req, res) => {
  const updates = req.body; // { key: value, ... }
  if (!updates || typeof updates !== 'object')
    return res.status(400).json({ success: false, message: 'Invalid body' });

  const PROTECTED = ['site_name']; // keys that need superadmin
  for (const [key, value] of Object.entries(updates)) {
    if (PROTECTED.includes(key) && req.admin.role !== 'superadmin') continue;
    await query('UPDATE settings SET value=? WHERE `key`=?', [String(value), key]);
  }
  await query('INSERT INTO admin_logs (admin_id,action,detail,ip) VALUES (?,?,?,?)',
    [req.admin.id, 'settings.update', JSON.stringify(Object.keys(updates)), req.ip]);
  res.json({ success: true, message: 'บันทึกการตั้งค่าแล้ว' });
});

// GET /api/settings/admin/api-keys — sensitive API settings (superadmin only)
router.get('/admin/api-keys', authAdmin, rbac.require('api.view'), async (req, res) => {
  const rows = await query('SELECT * FROM settings WHERE `group` IN ("line","sms","payment","security")');
  res.json({ success: true, data: rows });
});

// PUT /api/settings/admin/api-keys
router.put('/admin/api-keys', authAdmin, rbac.require('api.manage'), async (req, res) => {
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
router.post('/admin/maintenance', authAdmin, rbac.require('settings.manage'), async (req, res) => {
  const { enabled, message } = req.body;
  await query('UPDATE settings SET value=? WHERE `key`="maintenance_mode"', [String(enabled)]);
  if (message) await query('INSERT INTO settings (`key`,value,type,`group`) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE value=?',
    ['maintenance_message', message, 'string', 'general', message]);
  res.json({ success: true, message: `Maintenance mode ${enabled ? 'เปิด' : 'ปิด'} แล้ว` });
});

module.exports = router;
