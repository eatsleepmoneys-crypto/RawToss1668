const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }
};

const adminOnly = (req, res, next) => {
  if (!['admin','superadmin'].includes(req.user?.role))
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin only' });
  next();
};

const agentOnly = (req, res, next) => {
  if (!['agent','sub_agent','admin','superadmin'].includes(req.user?.role))
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Agent only' });
  next();
};

module.exports = { auth, adminOnly, agentOnly };
