const express = require('express');
const prisma = require('../db/client');
const { authenticate } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
router.use(authenticate);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Parse manifest photo using Claude AI
router.post('/parse', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'Image required' });

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 }
          },
          {
            type: 'text',
            text: `This is a pharmacy delivery manifest. Extract the following information and return ONLY a JSON object with no other text:
{
  "patientName": "full name from top of manifest",
  "firstName": "first name only",
  "lastName": "last name only",
  "address": "full street address",
  "city": "city",
  "state": "state abbreviation",
  "zip": "zip code",
  "phone": "phone number",
  "rxNumber": "RX number (format: digits-digits)",
  "medication": "medication name and strength",
  "quantity": "quantity",
  "fillDate": "fill date",
  "doctor": "doctor name"
}`
          }
        ]
      }]
    });

    let text = response.content[0].text.trim();
    // Remove markdown code blocks if present
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);
    return res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('Manifest parse error:', err.message);
    return res.status(500).json({ error: 'Could not read manifest', details: err.message });
  }
});

// Create patient and package from manifest data
router.post('/create-delivery', async (req, res) => {
  const { firstName, lastName, email, phone, address, dob, rxNumber, medication, quantity, driverId } = req.body;
  if (!firstName || !lastName || !address || !rxNumber) {
    return res.status(400).json({ error: 'Patient name, address and RX number are required' });
  }

  try {
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');

    // Check if patient already exists by name and address
    let patient = await prisma.patient.findFirst({
      where: { firstName, lastName, address }
    });

    if (!patient) {
      const dobHash = dob ? await bcrypt.hash(dob, 10) : await bcrypt.hash('000000', 10);
      const portalToken = uuidv4();
      patient = await prisma.patient.create({
        data: {
          firstName,
          lastName,
          email: email || `${firstName.toLowerCase()}.${lastName.toLowerCase()}@patient.clayworthpharmacy.com`,
          phone: phone || '',
          address,
          dobHash,
          portalToken,
          language: 'EN',
        }
      });
    }

    // Check if RX already exists
    const existing = await prisma.package.findFirst({ where: { rxId: rxNumber } });
    if (existing) {
      return res.status(409).json({ error: 'RX already in system', package: existing });
    }

    // Get pharmacy
    const pharmacy = await prisma.pharmacy.findFirst();

    // Create package
    const pkg = await prisma.package.create({
      data: {
        rxId: rxNumber,
        medication: medication || 'Unknown',
        dosage: '',
        quantity: quantity || '1',
        patientId: patient.id,
        pharmacyId: pharmacy?.id || null,
        status: 'PENDING',
        urgent: false,
      }
    });

    // Find or create bundle for this driver
    const driver = await prisma.driver.findUnique({ where: { id: req.driver.id } });
    let bundle = await prisma.bundle.findFirst({
      where: { driverId: req.driver.id, status: 'ASSIGNED' },
      orderBy: { stopOrder: 'desc' }
    });

    const stopOrder = bundle ? bundle.stopOrder + 1 : 1;
    bundle = await prisma.bundle.create({
      data: {
        patientId: patient.id,
        address,
        driverId: req.driver.id,
        stopOrder,
        status: 'ASSIGNED',
        pharmacyId: pharmacy?.id || null,
      }
    });

    // Link package to bundle
    await prisma.package.update({
      where: { id: pkg.id },
      data: { bundleId: bundle.id }
    });

    return res.status(201).json({
      success: true,
      patient,
      package: pkg,
      bundle,
      message: 'Patient and delivery created successfully'
    });
  } catch (err) {
    console.error('Create delivery error:', err.message);
    return res.status(500).json({ error: 'Could not create delivery', details: err.message });
  }
});

module.exports = router;
