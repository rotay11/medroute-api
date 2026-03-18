const express = require('express');
const bcrypt  = require('bcryptjs');
const prisma  = require('../db/client');
const logger  = require('../utils/logger');

const router = express.Router();

// Patient login — email + date of birth
router.post('/patient/login', async (req, res) => {
  const { email, dob } = req.body;
  if (!email || !dob) return res.status(400).json({ error:'Email and date of birth required' });
  try {
    const patient = await prisma.patient.findUnique({ where:{ email } });
    if (!patient) return res.status(401).json({ error:'Invalid credentials' });
    const ok = await bcrypt.compare(dob, patient.dobHash);
    if (!ok) return res.status(401).json({ error:'Invalid credentials' });
    return res.json({ patient:{ id:patient.id, firstName:patient.firstName, lastName:patient.lastName, portalToken:patient.portalToken, language:patient.language } });
  } catch (err) { return res.status(500).json({ error:'Login failed' }); }
});

// Facility login — email + password
router.post('/facility/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error:'Email and password required' });
  try {
    const facility = await prisma.facility.findUnique({ where:{ email } });
    if (!facility) return res.status(401).json({ error:'Invalid credentials' });
    const ok = await bcrypt.compare(password, facility.passwordHash);
    if (!ok) return res.status(401).json({ error:'Invalid credentials' });
    return res.json({ facility:{ id:facility.id, name:facility.name, email:facility.email } });
  } catch (err) { return res.status(500).json({ error:'Login failed' }); }
});

// Patient tracking — uses portalToken (no session required — link-based auth)
router.get('/patient/:portalToken/packages', async (req, res) => {
  try {
    const patient = await prisma.patient.findUnique({ where:{ portalToken:req.params.portalToken } });
    if (!patient) return res.status(404).json({ error:'Invalid tracking link' });
    const packages = await prisma.package.findMany({
      where: { patientId:patient.id },
      include: {
        bundle: {
          select: {
            id:true, stopOrder:true, status:true, eta:true, etaMinutes:true,
            driver: { select:{ firstName:true, driverId:true,
              gpsPings:{ orderBy:{ timestamp:'desc' }, take:1, select:{ lat:true, lng:true, timestamp:true } } } },
          },
        },
      },
      orderBy: { createdAt:'desc' },
    });
    const activeBundle = packages.find(p=>p.bundle?.status==='IN_TRANSIT')?.bundle;
    return res.json({
      patient:{ firstName:patient.firstName },
      packages,
      liveTracking: activeBundle?.driver ? {
        driverName: activeBundle.driver.firstName,
        location: activeBundle.driver.gpsPings[0] || null,
        eta: activeBundle.eta,
        etaMinutes: activeBundle.etaMinutes,
        stopsAway: activeBundle.stopOrder,
      } : null,
    });
  } catch (err) { return res.status(500).json({ error:'Could not load packages' }); }
});

// Facility tracking
router.get('/facility/:facilityId/packages', async (req, res) => {
  try {
    const packages = await prisma.package.findMany({
      where: { facilityId:req.params.facilityId },
      include: {
        patient: { select:{ firstName:true, lastName:true } },
        bundle: { select:{ status:true, eta:true, driver:{ select:{ firstName:true, lastName:true, driverId:true, gpsPings:{ orderBy:{ timestamp:'desc' }, take:1, select:{ lat:true, lng:true } } } } } },
      },
      orderBy: [{ urgent:'desc' }, { createdAt:'asc' }],
    });
    return res.json({ packages, total:packages.length });
  } catch (err) { return res.status(500).json({ error:'Could not load packages' }); }
});

module.exports = router;
