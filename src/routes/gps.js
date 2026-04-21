const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma  = require('../db/client');
const logger  = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.post('/',
  [body('lat').isFloat({ min:-90, max:90 }), body('lng').isFloat({ min:-180, max:180 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid GPS coordinates' });
    const { lat, lng, accuracy, speed, heading } = req.body;
    try {
      await prisma.gpsPing.create({ data: { driverId: req.driver.id, lat, lng, accuracy: accuracy||null, speed: speed||null, heading: heading||null } });
      // Update to ACTIVE whenever we get a GPS ping (from OFFLINE, IDLE, or any state)
      if (req.driver.status !== 'ACTIVE' && req.driver.status !== 'SUSPENDED') {
        await prisma.driver.update({ where: { id: req.driver.id }, data: { status: 'ACTIVE' } });
      }
      const io = req.app.get('io');
      if (io) {
        io.to('dispatchers').emit('driver_location', {
          driverId: req.driver.id, driverName: `${req.driver.firstName} ${req.driver.lastName}`,
          driverCode: req.driver.driverId, lat, lng, accuracy, speed, heading, timestamp: new Date(),
        });
        const activeBundles = await prisma.bundle.findMany({
          where: { driverId: req.driver.id, status: 'IN_TRANSIT' },
          include: { packages: { select: { patientId: true } } },
        });
        const patientIds = [...new Set(activeBundles.flatMap(b => b.packages.map(p => p.patientId)))];
        patientIds.forEach(pid => io.to(`patient_${pid}`).emit('driver_location', { lat, lng, timestamp: new Date() }));
      }
      return res.json({ received: true });
    } catch (err) { logger.error('GPS ping error:', err); return res.json({ received: false }); }
  }
);

router.get('/drivers', async (req, res) => {
  if (!['ADMIN','SUPERVISOR','DISPATCHER'].includes(req.driver.role)) return res.status(403).json({ error: 'Dispatcher access required' });
  try {
    const drivers = await prisma.driver.findMany({
      where: { status: { in: ['ACTIVE','IDLE'] } },
      select: {
        id:true, driverId:true, firstName:true, lastName:true, status:true, zone:true,
        gpsPings: { orderBy:{ timestamp:'desc' }, take:1, select:{ lat:true, lng:true, timestamp:true, speed:true } },
        bundles: { where:{ status:{ in:['ASSIGNED','IN_TRANSIT'] } }, select:{ id:true, stopOrder:true, status:true, address:true } },
      },
    });
    return res.json({ drivers: drivers.map(d => ({
      id:d.id, driverId:d.driverId, name:`${d.firstName} ${d.lastName}`,
      status:d.status, zone:d.zone, location:d.gpsPings[0]||null, activeStops:d.bundles.length,
    }))});
  } catch (err) { return res.status(500).json({ error: 'Could not load driver locations' }); }
});

module.exports = router;
