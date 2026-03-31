const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma  = require('../db/client');
const logger  = require('../utils/logger');
const { authenticate } = require('../middleware/auth');
const { extractZipCode } = require('../services/zoneService');

const router = express.Router();
router.use(authenticate);

router.post('/',
  [
    body('rxId').notEmpty().trim().toUpperCase(),
    body('scanType').isIn(['PICKUP','DELIVERY','CONDITION_CHECK']),
    body('gpsLat').isFloat({ min:-90, max:90 }),
    body('gpsLng').isFloat({ min:-180, max:180 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid scan data' });
    const { rxId, scanType, gpsLat, gpsLng, notes } = req.body;
    const driverId = req.driver.id;

    try {
      const pkg = await prisma.package.findUnique({
        where: { rxId },
        include: {
          patient: { select:{ firstName:true, lastName:true, address:true } },
          bundle:  { select:{ id:true, driverId:true, stopOrder:true, address:true } },
        },
      });

      if (!pkg) {
        await prisma.discrepancy.create({ data:{ driverId, type:'ITEM_NOT_ON_MANIFEST', description:`Scanned RX "${rxId}" not found` } }).catch(()=>{});
        const io = req.app.get('io');
        if (io) io.to('dispatchers').emit('alert', { type:'SCAN_MISMATCH', severity:'HIGH', message:`${req.driver.firstName} scanned unknown ID: ${rxId}`, driverId, gpsLat, gpsLng, timestamp:new Date() });
        return res.status(404).json({ error:'Package not found on manifest', code:'ITEM_NOT_ON_MANIFEST', rxId });
      }

      // Auto-create bundle if package has no bundle yet
      if (!pkg.bundle) {
        const pharmacy = await prisma.pharmacy.findFirst();
        const existingBundles = await prisma.bundle.findMany({
          where: { driverId, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } },
          orderBy: { stopOrder: 'desc' },
          take: 1
        });
        const nextStop = existingBundles.length > 0 ? existingBundles[0].stopOrder + 1 : 1;
        const newBundle = await prisma.bundle.create({
          data: {
            patientId: pkg.patientId,
            address: pkg.patient.address || 'Unknown address',
            driver: { connect: { id: driverId } },
            stopOrder: nextStop,
            status: 'ASSIGNED',
          }
        });
        await prisma.package.update({ where: { id: pkg.id }, data: { bundleId: newBundle.id } });
        pkg.bundle = { id: newBundle.id, driverId, stopOrder: nextStop, address: newBundle.address };
        pkg.bundleId = newBundle.id;
        logger.info(`Auto-created bundle for RX ${rxId} assigned to driver ${req.driver.driverId}`);
      }

      if (pkg.bundle && pkg.bundle.driverId !== driverId) {
        return res.status(403).json({ error:'Package assigned to a different driver', code:'WRONG_DRIVER' });
      }

      if (scanType === 'PICKUP') {
        const existing = await prisma.scan.findFirst({ where:{ packageId:pkg.id, scanType:'PICKUP' } });
        if (existing) return res.status(409).json({ error:'Already scanned at pickup', code:'ALREADY_SCANNED' });
      }

      const scan = await prisma.scan.create({ data:{ packageId:pkg.id, driverId, sessionId:req.sessionId, scanType, gpsLat, gpsLng, notes:notes||null } });
      const newStatus = scanType==='PICKUP' ? 'PICKED_UP' : scanType==='DELIVERY' ? 'IN_TRANSIT' : pkg.status;
      await prisma.package.update({ where:{ id:pkg.id }, data:{ status:newStatus } });
      await prisma.auditLog.create({ data:{ actorId:driverId, actorType:'driver', action:`SCAN_${scanType}`, entityType:'package', entityId:pkg.id, gpsLat, gpsLng, metadata:{ rxId, scanType } } });

      let bundleProgress = null;
      if (pkg.bundle) {
        const allPkgs = await prisma.package.findMany({ where:{ bundleId:pkg.bundleId }, select:{ id:true, rxId:true, status:true, medication:true, dosage:true, urgent:true } });
        const scanned = allPkgs.filter(p => scanType==='PICKUP' ? p.status==='PICKED_UP' : p.status==='DELIVERED').length;
        bundleProgress = { bundleId:pkg.bundleId, address:pkg.bundle.address, total:allPkgs.length, scanned:scanned+1, allScanned:scanned+1>=allPkgs.length, items:allPkgs };
        if (bundleProgress.allScanned && scanType==='PICKUP') {
          await prisma.bundle.update({ where:{ id:pkg.bundleId }, data:{ status:'IN_TRANSIT' } });
        }
      }

      const io = req.app.get('io');
      if (io) io.to('dispatchers').emit('package_scanned', { rxId, scanType, driverId, driverName:`${req.driver.firstName} ${req.driver.lastName}`, patientName:`${pkg.patient.firstName} ${pkg.patient.lastName}`, bundleProgress, timestamp:scan.timestamp });

      logger.info(`Scan: ${rxId} [${scanType}] by ${req.driver.driverId}`);
      return res.json({ success:true, scan:{ id:scan.id, rxId, scanType, timestamp:scan.timestamp }, package:{ id:pkg.id, rxId:pkg.rxId, medication:pkg.medication, dosage:pkg.dosage, urgent:pkg.urgent, refrigerated:pkg.refrigerated, status:newStatus, patient:pkg.patient }, bundleProgress });
    } catch (err) {
      logger.error('Scan error:', err);
      return res.status(500).json({ error:'Scan failed. Please try again.' });
    }
  }
);

router.get('/manifest', async (req, res) => {
  try {
    const bundles = await prisma.bundle.findMany({
      where: { driverId:req.driver.id, status:{ in:['ASSIGNED','IN_TRANSIT'] } },
      include: { packages:{ include:{ patient:{ select:{ firstName:true, lastName:true } }, scans:{ select:{ scanType:true, timestamp:true } } }, orderBy:{ urgent:'desc' } } },
      orderBy: { stopOrder:'asc' },
    });
    const total = bundles.reduce((s,b) => s+b.packages.length, 0);
    const scanned = bundles.reduce((s,b) => s+b.packages.filter(p=>p.scans.some(sc=>sc.scanType==='PICKUP')).length, 0);
    return res.json({ bundles, summary:{ totalBundles:bundles.length, totalPackages:total, scannedPackages:scanned, remaining:total-scanned, allScanned:scanned>=total } });
  } catch (err) { return res.status(500).json({ error:'Could not load manifest' }); }
});


// Get optimized route for driver
router.get('/route', async (req, res) => {
  try {
    const bundles = await prisma.bundle.findMany({
      where: { driverId: req.driver.id, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } },
      include: {
        packages: {
          include: {
            patient: { select: { firstName:true, lastName:true, phone:true, address:true } },
            scans: { select: { scanType:true, timestamp:true } }
          },
          orderBy: { urgent: 'desc' }
        }
      },
      orderBy: { stopOrder: 'asc' }
    });

    // Separate urgent from normal
    const urgent = bundles.filter(b => b.packages.some(p => p.urgent));
    const normal = bundles.filter(b => !b.packages.some(p => p.urgent));
    const optimized = [...urgent, ...normal];

    const total = bundles.reduce((s,b) => s + b.packages.length, 0);
    const scanned = bundles.reduce((s,b) => s + b.packages.filter(p => 
      p.scans.some(sc => sc.scanType === 'PICKUP')).length, 0);

    return res.json({
      bundles: optimized,
      summary: {
        totalStops: bundles.length,
        totalPackages: total,
        scannedPackages: scanned,
        remaining: total - scanned,
        allScanned: total > 0 && scanned >= total
      }
    });
  } catch (err) {
    logger.error('Route fetch error:', err);
    return res.status(500).json({ error: 'Could not load route' });
  }
});

module.exports = router;
