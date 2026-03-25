const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma  = require('../db/client');
const logger  = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.post('/',
  [body('bundleId').notEmpty(), body('gpsLat').isFloat({ min:-90, max:90 }), body('gpsLng').isFloat({ min:-180, max:180 }), body('scannedRxIds').isArray({ min:1 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error:'Invalid delivery data' });
    const { bundleId, gpsLat, gpsLng, scannedRxIds, signatureBase64, photoBase64, recipientName, notes, refused } = req.body;
    try {
      const bundle = await prisma.bundle.findFirst({
        where: { id:bundleId, driverId:req.driver.id },
        include: { packages:{ include:{ patient:{ select:{ firstName:true, lastName:true } } } } },
      });
      if (!bundle) return res.status(404).json({ error:'Bundle not found' });

      const expected = bundle.packages.map(p=>p.rxId);
      const missing  = expected.filter(id=>!scannedRxIds.includes(id));
      if (missing.length) {
        await Promise.all(missing.map(rxId => {
          const pkg = bundle.packages.find(p=>p.rxId===rxId);
          return prisma.discrepancy.create({ data:{ packageId:pkg?.id||null, driverId:req.driver.id, type:'MISSING_AT_DELIVERY', description:`${rxId} not scanned at delivery` } });
        }));
        const io = req.app.get('io');
        if (io) io.to('dispatchers').emit('alert', { type:'MISSING_AT_DELIVERY', severity:'HIGH', message:`${missing.length} item(s) missing at delivery: ${missing.join(', ')}`, driverId:req.driver.id, bundleId, timestamp:new Date() });
        return res.status(400).json({ error:'Not all items scanned', code:'MISSING_ITEMS', missingItems:missing });
      }

      const signatureUrl = signatureBase64 ? `http://localhost:${process.env.PORT||4000}/files/signatures/${bundleId}.png` : null;
      const photoUrl     = photoBase64     ? `http://localhost:${process.env.PORT||4000}/files/photos/${bundleId}.jpg`     : null;

      const delivery = await prisma.delivery.create({ data:{ bundleId, driverId:req.driver.id, gpsLat, gpsLng, signatureUrl, photoUrl, recipientName:recipientName||null, notes:notes||null } });
      await prisma.package.updateMany({ where:{ bundleId }, data:{ status:'DELIVERED', deliveryDate:new Date() } });
      await prisma.bundle.update({ where:{ id:bundleId }, data:{ status:'DELIVERED' } });
      await Promise.all(bundle.packages.map(pkg => prisma.scan.create({ data:{ packageId:pkg.id, driverId:req.driver.id, sessionId:req.sessionId, scanType:'DELIVERY', gpsLat, gpsLng } })));
      await prisma.auditLog.create({ data:{ actorId:req.driver.id, actorType:'driver', action:'DELIVERY_CONFIRMED', entityType:'bundle', entityId:bundleId, gpsLat, gpsLng, metadata:{ itemCount:bundle.packages.length, address:bundle.address } } });

      const io = req.app.get('io');
      if (io) {
        io.to('dispatchers').emit('delivery_confirmed', { driverId:req.driver.id, bundleId, address:bundle.address, timestamp:new Date() });
        bundle.packages.forEach(p => io.to(`patient_${p.patientId}`).emit('delivery_confirmed', { deliveredAt:new Date() }));
      }

      const next = await prisma.bundle.findFirst({
        where: { driverId:req.driver.id, status:{ in:['ASSIGNED','IN_TRANSIT'] }, stopOrder:{ gt:bundle.stopOrder } },
        include: { packages:{ include:{ patient:{ select:{ firstName:true, lastName:true } } } } },
        orderBy: { stopOrder:'asc' },
      });

      logger.info(`Delivery confirmed: ${bundleId} by ${req.driver.driverId}`);
      return res.json({
        success:true,
        delivery: { id:delivery.id, bundleId, deliveredAt:delivery.deliveredAt, itemCount:bundle.packages.length },
        nextStop: next ? { bundleId:next.id, address:next.address, stopOrder:next.stopOrder, patientName:next.packages[0] ? `${next.packages[0].patient.firstName} ${next.packages[0].patient.lastName}` : null } : null,
        allDelivered: !next,
      });
    } catch (err) {
      logger.error('Delivery error:', err);
      return res.status(500).json({ error:'Delivery confirmation failed' });
    }
  }
);

module.exports = router;
