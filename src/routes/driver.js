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
    const compliance = totalDeliveries > 0 ? Math.round(((totalDeliveries - discrepancies) / totalDeliveries) * 100) : 100;
    return res.json({ totalDeliveries, todayDeliveries, discrepancies, activeBundles, compliance: `${compliance}%` });
  } catch (err) { return res.status(500).json({ error:'Could not load stats' }); }
});

module.exports = router;
