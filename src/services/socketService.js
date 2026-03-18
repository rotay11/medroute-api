const jwt    = require('jsonwebtoken');
const logger = require('../utils/logger');

function initSocket(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      if (socket.handshake.auth?.portalToken) return next();
      return next(new Error('Auth required'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.driverId  = decoded.driverId;
      socket.sessionId = decoded.sessionId;
      next();
    } catch { next(new Error('Invalid token')); }
  });

  io.on('connection', async (socket) => {
    if (socket.driverId) {
      socket.join(`driver_${socket.driverId}`);
      try {
        const prisma = require('../db/client');
        const driver = await prisma.driver.findUnique({
          where: { id: socket.driverId },
          select: { role: true, driverId: true },
        });
        if (driver && ['ADMIN','SUPERVISOR','DISPATCHER'].includes(driver.role)) {
          socket.join('dispatchers');
          logger.info(`Dispatcher socket: ${driver.driverId}`);
        } else if (driver) {
          logger.info(`Driver socket: ${driver.driverId}`);
        }
      } catch(e) { logger.error('Socket lookup error:', e); }
    }

    if (socket.handshake.auth?.portalToken) {
      try {
        const prisma = require('../db/client');
        const patient = await prisma.patient.findUnique({
          where: { portalToken: socket.handshake.auth.portalToken },
          select: { id: true, firstName: true },
        });
        if (patient) {
          socket.join(`patient_${patient.id}`);
          logger.info(`Patient portal socket: ${patient.firstName}`);
        }
      } catch(e) { logger.error('Patient socket error:', e); }
    }

    socket.on('disconnect', () => logger.info(`Socket disconnected: ${socket.id}`));
    socket.on('ping', () => socket.emit('pong'));
  });

  logger.info('Socket.io ready');
}

module.exports = { initSocket };
