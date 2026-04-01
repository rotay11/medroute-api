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
