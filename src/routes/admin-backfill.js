const express = require('express');
const router = express.Router();
const prisma = require('../db/client');
const { geocodeAddress } = require('../services/geocode');
const { authenticate } = require('../middleware/auth');

// Backfill geocoding for bundles with null coordinates
// POST /api/admin/backfill-geocoding
router.post('/backfill-geocoding', authenticate, async (req, res) => {
  try {
    const bundles = await prisma.bundle.findMany({
      where: {
        OR: [{ addressLat: null }, { addressLng: null }],
        address: { not: null }
      },
      select: { id: true, address: true, patientId: true }
    });

    let geocoded = 0;
    let failed = 0;
    const results = [];

    for (const b of bundles) {
      const coords = await geocodeAddress(b.address);
      if (coords) {
        await prisma.bundle.update({
          where: { id: b.id },
          data: { addressLat: coords.lat, addressLng: coords.lng }
        });
        if (b.patientId) {
          await prisma.patient.update({
            where: { id: b.patientId },
            data: { addressLat: coords.lat, addressLng: coords.lng }
          }).catch(() => {});
        }
        geocoded++;
        results.push({ id: b.id, address: b.address, lat: coords.lat, lng: coords.lng });
      } else {
        failed++;
        results.push({ id: b.id, address: b.address, error: 'geocode failed' });
      }
    }

    return res.json({
      success: true,
      totalBundles: bundles.length,
      geocoded,
      failed,
      results
    });
  } catch (err) {
    console.error('Backfill error:', err);
    return res.status(500).json({ error: 'Backfill failed', details: err.message });
  }
});

module.exports = router;
