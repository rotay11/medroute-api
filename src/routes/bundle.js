const express = require('express');
const prisma  = require('../db/client');
const logger  = require('../utils/logger');
const { authenticate } = require('../middleware/auth');
const { optimiseRoute } = require('../services/routeService');

const router = express.Router();
router.use(authenticate);

router.get('/route', async (req, res) => {
  try {
    const bundles = await prisma.bundle.findMany({
      where: { driverId:req.driver.id, status:{ in:['ASSIGNED','IN_TRANSIT'] } },
      include: { packages:{ include:{ patient:{ select:{ firstName:true, lastName:true } }, scans:{ select:{ scanType:true } } }, orderBy:{ urgent:'desc' } } },
      orderBy: { stopOrder:'asc' },
    });
    const enriched = bundles.map(b => {
      const total    = b.packages.length;
      const picked   = b.packages.filter(p=>p.scans.some(s=>s.scanType==='PICKUP')).length;
      const hasUrgent = b.packages.some(p=>p.urgent);
      return { ...b, progress:{ totalItems:total, scannedPickup:picked, allPickedUp:picked>=total, navigationUnlocked:picked>=total }, hasUrgent };
    });
    return res.json({ route:enriched, summary:{ totalStops:bundles.length, remainingStops:bundles.length } });
  } catch (err) { return res.status(500).json({ error:'Could not load route' }); }
});

router.post('/optimise', async (req, res) => {
  const { currentLat, currentLng } = req.body;
  if (!currentLat || !currentLng) return res.status(400).json({ error:'GPS position required' });
  try {
    const pending = await prisma.bundle.findMany({
      where: { driverId:req.driver.id, status:{ in:['ASSIGNED','IN_TRANSIT'] } },
      include: { packages:{ select:{ urgent:true, status:true } } },
    });
    if (!pending.length) return res.json({ message:'No stops to optimise', route:[] });
    const optimised = await optimiseRoute(pending, { lat:currentLat, lng:currentLng });
    await Promise.all(optimised.map((b,i) => prisma.bundle.update({ where:{ id:b.id }, data:{ stopOrder:i+1, eta:b.eta, etaMinutes:b.etaMinutes } })));
    const io = req.app.get('io');
    if (io) io.to('dispatchers').emit('route_optimised', { driverId:req.driver.id, newOrder:optimised.map(b=>({ id:b.id, stopOrder:b.stopOrder })), timestamp:new Date() });
    return res.json({ message:'Route optimised', route:optimised });
  } catch (err) { return res.status(500).json({ error:'Optimisation failed' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const bundle = await prisma.bundle.findFirst({
      where: { id:req.params.id, driverId:req.driver.id },
      include: { packages:{ include:{ patient:{ select:{ firstName:true, lastName:true, phone:true } }, scans:{ orderBy:{ timestamp:'desc' } } }, orderBy:{ urgent:'desc' } } },
    });
    if (!bundle) return res.status(404).json({ error:'Bundle not found' });
    const lang = req.driver.mapsLanguage==='ES' ? 'es' : 'en';
    const enc  = encodeURIComponent(bundle.address);
    const lat  = bundle.addressLat || 0;
    const lng  = bundle.addressLng || 0;
    const navigationLinks = {
      googleMaps: `comgooglemaps://?daddr=${enc}&directionsmode=driving&hl=${lang}`,
      appleMaps:  `maps://?daddr=${enc}&ll=${lat},${lng}`,
      waze:       `waze://?ll=${lat},${lng}&navigate=yes&lang=${lang}`,
      googleMapsWeb: `https://www.google.com/maps/dir/?api=1&destination=${enc}&travelmode=driving&hl=${lang}`,
    };
    return res.json({ bundle, navigationLinks });
  } catch (err) { return res.status(500).json({ error:'Could not load bundle' }); }
});

router.post('/:id/no-answer', async (req, res) => {
  const { gpsLat, gpsLng, notes } = req.body;
  try {
    const bundle = await prisma.bundle.findFirst({ where:{ id:req.params.id, driverId:req.driver.id } });
    if (!bundle) return res.status(404).json({ error:'Bundle not found' });
    const max = await prisma.bundle.aggregate({ where:{ driverId:req.driver.id, status:{ in:['ASSIGNED','IN_TRANSIT'] } }, _max:{ stopOrder:true } });
    await prisma.bundle.update({ where:{ id:bundle.id }, data:{ stopOrder:(max._max.stopOrder||0)+1 } });
    await prisma.auditLog.create({ data:{ actorId:req.driver.id, actorType:'driver', action:'NO_ANSWER', entityType:'bundle', entityId:bundle.id, gpsLat:gpsLat||null, gpsLng:gpsLng||null, metadata:{ notes } } });
    const io = req.app.get('io');
    if (io) io.to('dispatchers').emit('no_answer', { driverId:req.driver.id, bundleId:bundle.id, address:bundle.address, timestamp:new Date() });
    return res.json({ message:'Stop moved to end of route' });
  } catch (err) { return res.status(500).json({ error:'Could not update stop' }); }
});

module.exports = router;
