// ─── Role-Based Access Control ────────────────────────────────────
// Hierarchy: superadmin > admin > finance > staff

const ROLE_LEVEL = { superadmin: 4, admin: 3, finance: 2, staff: 1 };

const PERMISSIONS = {
  // Members
  'members.view':          ['staff','finance','admin','superadmin'],
  'members.create':        ['admin','superadmin'],
  'members.edit':          ['admin','superadmin'],
  'members.ban':           ['admin','superadmin'],
  'members.credit':        ['admin','superadmin'],
  // Agents
  'agents.view':           ['admin','superadmin'],
  'agents.manage':         ['admin','superadmin'],
  // Admins
  'admins.view':           ['admin','superadmin'],
  'admins.create':         ['superadmin'],
  'admins.edit':           ['superadmin'],
  'admins.delete':         ['superadmin'],
  // Lottery
  'lottery.view':          ['staff','finance','admin','superadmin'],
  'lottery.manage':        ['admin','superadmin'],
  'rounds.view':           ['staff','finance','admin','superadmin'],
  'rounds.manage':         ['admin','superadmin'],
  // Results
  'results.view':          ['staff','finance','admin','superadmin'],
  'results.announce':      ['admin','superadmin'],
  // Bets
  'bets.view':             ['staff','finance','admin','superadmin'],
  'bets.cancel':           ['admin','superadmin'],
  // Finance
  'deposits.view':         ['finance','admin','superadmin'],
  'deposits.approve':      ['finance','admin','superadmin'],
  'withdrawals.view':      ['finance','admin','superadmin'],
  'withdrawals.process':   ['finance','admin','superadmin'],
  'winpay.view':           ['finance','admin','superadmin'],
  'winpay.process':        ['finance','admin','superadmin'],
  // Reports
  'reports.view':          ['finance','admin','superadmin'],
  'reports.export':        ['admin','superadmin'],
  // API Settings
  'api.view':              ['superadmin'],
  'api.manage':            ['superadmin'],
  // System Settings
  'settings.view':         ['admin','superadmin'],
  'settings.manage':       ['superadmin'],
  // Logs
  'logs.view':             ['admin','superadmin'],
};

// Middleware factory: requirePerm(permission)
const requirePerm = (permission) => (req, res, next) => {
  const admin = req.admin;
  if (!admin) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

  const allowed = PERMISSIONS[permission] || [];
  if (!allowed.includes(admin.role)) {
    return res.status(403).json({
      success: false,
      message: `ไม่มีสิทธิ์ดำเนินการนี้ (ต้องการ: ${allowed.join('/')})`
    });
  }
  next();
};

// Check if admin has permission (returns boolean)
const can = (role, permission) => {
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(role);
};

// Check minimum role level
const minRole = (minLevel) => (req, res, next) => {
  if (!req.admin) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if ((ROLE_LEVEL[req.admin.role] || 0) < ROLE_LEVEL[minLevel]) {
    return res.status(403).json({ success: false, message: 'สิทธิ์ไม่เพียงพอ' });
  }
  next();
};

module.exports = { requirePerm, can, minRole, PERMISSIONS, ROLE_LEVEL };
