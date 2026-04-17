const express = require('express');
const bcrypt  = require('bcryptjs');
const prisma  = require('../db/client');
const logger  = require('../utils/logger');

const router = express.Router();

// Patient login — email + date of birth
router.post('/patient/login', async (req, res) => {
  const { firstName, lastName, phoneLast4 } = req.body;
  if (!firstName || !lastName || !phoneLast4) return res.status(400).json({ error:'First name, last name and last 4 digits of phone required' });
  if (phoneLast4.length !== 4 || !/^[0-9]{4}$/.test(phoneLast4)) return res.status(400).json({ error:'Please enter exactly 4 digits' });
  try {
    const patients = await prisma.patient.findMany({
      where: {
        firstName: { equals: firstName, mode: 'insensitive' },
        lastName: { equals: lastName, mode: 'insensitive' }
      }
    });
    if (!patients.length) return res.status(401).json({ error:'Patient not found. Please check your name.' });
    const patient = patients.find(p => p.phone && p.phone.replace(/\D/g, '').slice(-4) === phoneLast4);
    if (!patient) return res.status(401).json({ error:'Phone number does not match. Please try again.' });
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


// Get all facilities for dropdown
router.get('/facilities', async (req, res) => {
  try {
    const facilities = await prisma.facility.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    });
    return res.json({ facilities });
  } catch (err) { return res.status(500).json({ error: 'Could not load facilities' }); }
});

// Caregiver/facility lookup by patient name and DOB
router.post('/caregiver/lookup', async (req, res) => {
  const { facilityId, firstName, lastName, dob, role, showMeds } = req.body;
  if (!facilityId || !firstName || !lastName || !dob) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  try {
    // Find patient by name
    const patients = await prisma.patient.findMany({
      where: {
        firstName: { equals: firstName, mode: 'insensitive' },
        lastName: { equals: lastName, mode: 'insensitive' }
      }
    });

    if (!patients.length) {
      return res.status(404).json({ error: 'Patient not found. Contact Clayworth Pharmacy at (510) 537-9402.' });
    }

    // Verify date of birth
    let patient = null;
    for (const p of patients) {
      const ok = await bcrypt.compare(dob, p.dobHash);
      if (ok) { patient = p; break; }
    }

    if (!patient) {
      return res.status(401).json({ error: 'Date of birth does not match. Contact Clayworth Pharmacy at (510) 537-9402.' });
    }

    // Get delivery status only - no medication names
    const packages = await prisma.package.findMany({
      where: { patientId: patient.id },
      include: {
        bundle: {
          select: {
            status: true,
            eta: true,
            etaMinutes: true,
            driver: {
              select: {
                firstName: true,
                gpsPings: {
                  orderBy: { timestamp: 'desc' },
                  take: 1,
                  select: { timestamp: true }
                }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Return minimal information only
    const activePackages = packages.filter(p => p.status !== 'DELIVERED');
    const deliveredPackages = packages.filter(p => p.status === 'DELIVERED');

    return res.json({
      patient: {
        firstName: patient.firstName,
        lastInitial: patient.lastName.charAt(0)
      },
      role: role || 'family',
      delivery: {
        itemCount: activePackages.length,
        status: activePackages[0]?.bundle?.status || 'PENDING',
        driverName: activePackages[0]?.bundle?.driver?.firstName || null,
        eta: activePackages[0]?.bundle?.eta || null,
        etaMinutes: activePackages[0]?.bundle?.etaMinutes || null,
        lastUpdate: activePackages[0]?.bundle?.driver?.gpsPings?.[0]?.timestamp || null,
        deliveredCount: deliveredPackages.length,
        totalItems: packages.length
      },
      medications: showMeds ? activePackages.map(p => ({ medication: p.medication, dosage: p.dosage || '' })) : null,
      pharmacyPhone: '(510) 537-9402'
    });
  } catch (err) {
    console.error('Caregiver lookup error:', err.message);
    return res.status(500).json({ error: 'Lookup failed. Contact Clayworth Pharmacy at (510) 537-9402.' });
  }
});

// Get patient portal link by bundle ID — used for bag slip QR code generation
router.get('/bundle/:bundleId/link', async (req, res) => {
  try {
    const bundle = await prisma.bundle.findUnique({
      where: { id: req.params.bundleId },
      include: { packages: { include: { patient: { select: { firstName: true, lastName: true, portalToken: true } } } } }
    });
    if (!bundle || !bundle.packages[0]?.patient) {
      return res.status(404).json({ error: 'Bundle not found' });
    }
    const patient = bundle.packages[0].patient;
    const portalUrl = 'https://medroute-dashboard.vercel.app/portal?token=' + patient.portalToken;
    return res.json({
      patientName: patient.firstName + ' ' + patient.lastName,
      portalToken: patient.portalToken,
      portalUrl,
      qrUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=1D9E75&data=' + encodeURIComponent(portalUrl)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not get portal link' });
  }
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

// AI Agent — patient asks questions about their delivery
router.post('/patient/:portalToken/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  try {
    const patient = await prisma.patient.findUnique({
      where: { portalToken: req.params.portalToken }
    });
    if (!patient) return res.status(404).json({ error: 'Invalid tracking link' });

    // Get patient delivery data
    const packages = await prisma.package.findMany({
      where: { patientId: patient.id },
      include: {
        bundle: {
          select: {
            status: true, stopOrder: true, eta: true,
            driver: {
              select: {
                firstName: true, phone: true,
                gpsPings: { orderBy: { timestamp: 'desc' }, take: 1, select: { lat: true, lng: true, timestamp: true } }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Build context for AI
    const deliveryContext = packages.map(pkg => {
      const bundle = pkg.bundle;
      const driver = bundle?.driver;
      const lastPing = driver?.gpsPings?.[0];
      return `
Medication: ${pkg.medication} ${pkg.dosage || ''}
RX Number: ${pkg.rxId}
Status: ${pkg.status}
Delivery status: ${bundle?.status || 'Not yet assigned'}
Driver: ${driver?.firstName || 'Not yet assigned'}
Last known driver location: ${lastPing ? `Updated ${new Date(lastPing.timestamp).toLocaleTimeString()}` : 'Not available'}
ETA: ${bundle?.eta ? new Date(bundle.eta).toLocaleTimeString() : 'Not yet available'}
      `.trim();
    }).join('\n\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      system: `You are a helpful delivery assistant for Clayworth Pharmacy. You help patients track their medication deliveries.
      
The patient's name is ${patient.firstName} ${patient.lastName}.

Here is their current delivery information:
${deliveryContext || 'No active deliveries found.'}

Rules:
- Only answer questions about delivery status, timing, medications being delivered, driver information and pharmacy contact
- For anything else say "Please contact Clayworth Pharmacy directly at (510) 537-9402"
- Be brief, warm and professional
- Never reveal other patients information
- If no deliveries are found tell them to contact the pharmacy
- Always address the patient by their first name`,
      messages: [{ role: 'user', content: message }]
    });

    return res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('AI agent error:', err.message);
    return res.status(500).json({ error: 'Could not process your question' });
  }
});
