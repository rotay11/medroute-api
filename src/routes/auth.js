const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const prisma   = require('../db/client');
const logger   = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function generateTokens(driverId, sessionId) {
  const accessToken  = jwt.sign({ driverId, sessionId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });
  const refreshToken = jwt.sign({ driverId, sessionId, type: 'refresh' }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d' });
  return { accessToken, refreshToken };
}

router.post('/login',
  [body('email').isEmail().normalizeEmail(), body('password').isLength({ min: 6 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid email or password format' });

    const { email, password, deviceId, platform } = req.body;
    try {
      const driver = await prisma.driver.findUnique({ where: { email } });
      if (!driver) return res.status(401).json({ error: 'Invalid email or password' });
      if (driver.status === 'SUSPENDED') return res.status(403).json({ error: 'Account suspended.' });

      const ok = await bcrypt.compare(password, driver.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

      const sessionId = uuidv4();
      const { accessToken, refreshToken } = generateTokens(driver.id, sessionId);

      await prisma.session.create({
        data: { id: sessionId, driverId: driver.id, deviceId: deviceId || 'unknown', refreshToken, ipAddress: req.ip, userAgent: req.headers['user-agent'] },
      });
      await prisma.driver.update({
        where: { id: driver.id },
        data: { status: driver.role === 'DRIVER' ? 'IDLE' : driver.status, deviceId: deviceId || driver.deviceId },
      });
      await prisma.auditLog.create({
        data: { actorId: driver.id, actorType: 'driver', action: 'LOGIN', entityType: 'session', entityId: sessionId, ipAddress: req.ip, metadata: { platform, deviceId } },
      });

      logger.info(`Login: ${driver.email} [${driver.role}]`);
      return res.json({
        accessToken, refreshToken,
        driver: { id: driver.id, driverId: driver.driverId, firstName: driver.firstName, lastName: driver.lastName, email: driver.email, role: driver.role, language: driver.language, mapsLanguage: driver.mapsLanguage, zone: driver.zone },
      });
    } catch (err) {
      logger.error('Login error:', err);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }
);

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });
  try {
    jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const session = await prisma.session.findUnique({ where: { refreshToken }, include: { driver: true } });
    if (!session || !session.isActive) return res.status(401).json({ error: 'Invalid session' });
    if (session.driver.status === 'SUSPENDED') return res.status(403).json({ error: 'Account suspended' });
    const newId = uuidv4();
    const tokens = generateTokens(session.driverId, newId);
    await prisma.session.update({ where: { id: session.id }, data: { isActive: false } });
    await prisma.session.create({ data: { id: newId, driverId: session.driverId, deviceId: session.deviceId, refreshToken: tokens.refreshToken, ipAddress: req.ip } });
    return res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  } catch { return res.status(401).json({ error: 'Invalid refresh token' }); }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    await prisma.session.updateMany({ where: { driverId: req.driver.id, id: req.sessionId }, data: { isActive: false, logoutAt: new Date() } });
    await prisma.driver.update({ where: { id: req.driver.id }, data: { status: 'OFFLINE' } });
    await prisma.auditLog.create({ data: { actorId: req.driver.id, actorType: 'driver', action: 'LOGOUT', ipAddress: req.ip } });
    return res.json({ message: 'Signed out successfully' });
  } catch (err) { return res.status(500).json({ error: 'Logout failed' }); }
});

router.get('/me', authenticate, (req, res) => res.json({ driver: req.driver }));

module.exports = router;
