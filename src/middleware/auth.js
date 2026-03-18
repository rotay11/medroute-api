const jwt    = require('jsonwebtoken');
const prisma = require('../db/client');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const driver = await prisma.driver.findUnique({
      where: { id: decoded.driverId },
      select: {
        id: true, driverId: true, firstName: true, lastName: true,
        email: true, role: true, language: true, mapsLanguage: true,
        zone: true, status: true, pharmacyId: true,
      },
    });
    if (!driver) return res.status(401).json({ error: 'User not found' });
    if (driver.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
    }
    req.driver    = driver;
    req.sessionId = decoded.sessionId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.driver) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.driver.role)) {
      return res.status(403).json({ error: `Access denied. Required: ${roles.join(' or ')}` });
    }
    next();
  };
}

const requireAdmin      = requireRole('ADMIN');
const requireSupervisor = requireRole('ADMIN', 'SUPERVISOR');
const requireDispatcher = requireRole('ADMIN', 'SUPERVISOR', 'DISPATCHER');
const requireDriver     = requireRole('ADMIN', 'SUPERVISOR', 'DISPATCHER', 'DRIVER');

module.exports = { authenticate, requireRole, requireAdmin, requireSupervisor, requireDispatcher, requireDriver };
