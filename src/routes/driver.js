const express = require('express');
const prisma  = require('../db/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/profile', (req, res) => res.json({ driver: req.driver }));

router.patch('/language', async (req, res) => {
  const { language, mapsLanguage } = req.body;
  if (!['EN','ES'].includes(language)) return res.status(400).json({ error:'Invalid language. Use EN or ES' });
  try {
    const updated = await prisma.driver.update({
      where: { id:req.driver.id },
      data: { language, mapsLanguage: mapsLanguage||language },
      select: { id:true, language:true, mapsLanguage:true },
    });
    return res.json({ driver:updated, message:`Language updated to ${language}` });
  } catch (err) { return res.status(500).json({ error:'Could not update language' }); }
});

router.get('/stats', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
    const [totalDeliveries, todayDeliveries, discrepancies, activeBundles] = await Promise.all([
      prisma.delivery.count({ where:{ driverId:req.driver.id } }),
      prisma.delivery.count({ where:{ driverId:req.driver.id, deliveredAt:{ gte:today, lt:tomorrow } } }),
      prisma.discrepancy.count({ where:{ driverId:req.driver.id } }),
      prisma.bundle.count({ where:{ driverId:req.driver.id, status:{ in:['ASSIGNED','IN_TRANSIT'] } } }),
    ]);
    // Cap compliance at 0-100% range and only count UNRESOLVED discrepancies
    const unresolvedDiscrepancies = await prisma.discrepancy.count({ 
      where: { 
        driverId: req.driver.id, 
        status: { not: 'RESOLVED' }
      } 
    });
    let compliance = 100;
    if (totalDeliveries > 0) {
      compliance = Math.round(((totalDeliveries - unresolvedDiscrepancies) / totalDeliveries) * 100);
      compliance = Math.max(0, Math.min(100, compliance)); // cap 0-100
    }
    return res.json({ totalDeliveries, todayDeliveries, discrepancies: unresolvedDiscrepancies, activeBundles, compliance: `${compliance}%` });
  } catch (err) { return res.status(500).json({ error:'Could not load stats' }); }
});

// End route - driver pauses tracking
router.post('/end-route', async (req, res) => {
  try {
    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { status: 'OFFLINE' }
    });
    await prisma.auditLog.create({
      data: { actorId: req.driver.id, actorType: 'driver', action: 'ROUTE_ENDED', entityType: 'driver', entityId: req.driver.id }
    }).catch(() => {});
    return res.json({ success: true, status: 'OFFLINE' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not end route' });
  }
});

// Resume route - driver restarts tracking
router.post('/resume-route', async (req, res) => {
  try {
    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { status: 'ACTIVE' }
    });
    await prisma.auditLog.create({
      data: { actorId: req.driver.id, actorType: 'driver', action: 'ROUTE_RESUMED', entityType: 'driver', entityId: req.driver.id }
    }).catch(() => {});
    return res.json({ success: true, status: 'ACTIVE' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not resume route' });
  }
});

module.exports = router;
