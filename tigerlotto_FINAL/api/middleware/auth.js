const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// ─── Verify JWT (Member) ───────────────────────────
const authMember = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'member') return res.status(401).json({ success: false, message: 'Token ไม่ถูกต้อง' });

    const [member] = await query(
      'SELECT id, uuid, name, phone, balance, status, level FROM members WHERE id = ? AND status != "banned"',
      [decoded.id]
    );
    if (!member) return res.status(401).json({ success: false, message: 'บัญชีไม่พบหรือถูกระงับ' });

    req.member = member;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    return res.status(401).json({ success: false, message: 'Token ไม่ถูกต้อง' });
  }
};

// ─── Verify JWT (Admin) ───────────────────────────
const authAdmin = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ Admin' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'admin') return res.status(401).json({ success: false, message: 'Token ไม่ถูกต้อง' });

    const [admin] = await query(
      'SELECT id, uuid, name, email, role, is_active FROM admins WHERE id = ? AND is_active = 1',
      [decoded.id]
    );
    if (!admin) return res.status(401).json({ success: false, message: 'บัญชี Admin ไม่พบ' });

    req.admin = admin;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Session หมดอายุ' });
    return res.status(401).json({ success: false, message: 'Token ไม่ถูกต้อง' });
  }
};

// ─── Optional Auth (member or guest) ─────────────
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type === 'member') {
      const [member] = await query('SELECT id,uuid,name,balance FROM members WHERE id=?', [decoded.id]);
      if (member) req.member = member;
    }
  } catch (_) {}
  next();
};

// ─── Verify JWT (Agent) ───────────────────────────
const authAgent = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'agent') return res.status(401).json({ success: false, message: 'Token ไม่ถูกต้อง' });

    const [agent] = await query(
      'SELECT id, uuid, name, phone, email, commission_rate, balance, total_commission, status FROM agents WHERE id = ? AND status = "active"',
      [decoded.id]
    );
    if (!agent) return res.status(401).json({ success: false, message: 'บัญชี Agent ไม่พบหรือถูกระงับ' });

    req.agent = agent;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    return res.status(401).json({ success: false, message: 'Token ไม่ถูกต้อง' });
  }
};

// ─── Generate tokens ──────────────────────────────
const signMemberToken = (member) =>
  jwt.sign({ id: member.id, type: 'member' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

const signAdminToken = (admin) =>
  jwt.sign({ id: admin.id, type: 'admin', role: admin.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_ADMIN_EXPIRE || '8h' });

const signAgentToken = (agent) =>
  jwt.sign({ id: agent.id, type: 'agent' }, process.env.JWT_SECRET, { expiresIn: '12h' });

// ─── Helper ───────────────────────────────────────
const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.split(' ')[1];
  return req.cookies?.token || null;
};

module.exports = { authMember, authAdmin, authAgent, optionalAuth, signMemberToken, signAdminToken, signAgentToken };
