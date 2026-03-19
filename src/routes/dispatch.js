const express = require('express');
const prisma  = require('../db/client');
const { authenticate, requireDispatcher } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireDispatcher);

router.get('/drivers', async (req, res) => {
  try {
    const drivers = await prisma.driver.findMany({
      where: {},
      select: {
        id:true, driverId:true, firstName:true, lastName:true, status:true, zone:true, language:true,
        gpsPings: { orderBy:{ timestamp:'desc' }, take:1, select:{ lat:true, lng:true, timestamp:true } },
        bundles: { where:{ status:{ in:['ASSIGNED','IN_TRANSIT'] } }, include:{ packages:{ select:{ rxId:true, status:true, urgent:true } } }, orderBy:{ stopOrder:'asc' } },
        _count: { select:{ deliveries:true, discrepancies:true } },
      },
    });
    return res.json({ drivers });
  } catch (err) { return res.status(500).json({ error:'Could not load drivers' }); }
});

router.get('/packages', async (req, res) => {
  try {
    const { status, driverId } = req.query;
    const where = {};
    if (status)   where.status = status;
    if (driverId) where.bundle = { driverId };
    const packages = await prisma.package.findMany({
      where,
      include: {
        patient: { select:{ firstName:true, lastName:true, address:true } },
        bundle:  { select:{ driverId:true, stopOrder:true, eta:true, driver:{ select:{ firstName:true, lastName:true, driverId:true } } } },
        scans:   { orderBy:{ timestamp:'desc' }, take:1 },
      },
      orderBy: [{ urgent:'desc' }, { createdAt:'asc' }],
    });
    return res.json({ packages, total:packages.length });
  } catch (err) { return res.status(500).json({ error:'Could not load packages' }); }
});

router.post('/reassign', async (req, res) => {
  const { bundleId, newDriverId } = req.body;
  if (!bundleId || !newDriverId) return res.status(400).json({ error:'bundleId and newDriverId required' });
  try {
    const bundle = await prisma.bundle.update({ where:{ id:bundleId }, data:{ driverId:newDriverId, stopOrder:99 } });
    await prisma.auditLog.create({ data:{ actorId:req.driver.id, actorType:'dispatcher', action:'STOP_REASSIGNED', entityType:'bundle', entityId:bundleId, metadata:{ newDriverId } } });
    const io = req.app.get('io');
    if (io) {
      io.to(`driver_${newDriverId}`).emit('route_updated', { message:'A new stop has been added to your route' });
    }
    return res.json({ message:'Stop reassigned', bundle });
  } catch (err) { return res.status(500).json({ error:'Could not reassign stop' }); }
});

router.get('/alerts', async (req, res) => {
  try {
    const discrepancies = await prisma.discrepancy.findMany({
      where: { status:{ in:['OPEN','INVESTIGATING'] } },
      include: {
        package: { select:{ rxId:true, medication:true } },
        driver:  { select:{ driverId:true, firstName:true, lastName:true } },
      },
      orderBy: { flaggedAt:'desc' },
      take: 50,
    });
    return res.json({ alerts:discrepancies });
  } catch (err) { return res.status(500).json({ error:'Could not load alerts' }); }
});

module.exports = router;
