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
            text: `This is a Clayworth Pharmacy delivery manifest. The patient name appears in ALL CAPS at the top left of the page directly below the pharmacy address block. The delivery address appears directly below the patient name. Extract the following and return ONLY a valid JSON object with no markdown, no code blocks, no extra text:
{
  "patientName": "full patient name in caps near top left",
  "firstName": "first word of patient name",
  "lastName": "last word of patient name",
  "address": "street address below patient name",
  "city": "city name",
  "state": "2 letter state code",
  "zip": "5 digit zip code",
  "phone": "phone number near address",
  "rxNumber": "RX number after Rx label eg 4548967-00",
  "medication": "drug name and strength on manifest",
  "quantity": "quantity number",
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


// Inbound email from SendGrid — processes emailed manifests
router.post('/inbound', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    console.log('Inbound manifest email received');
    const { from, subject, text, html } = req.body;
    
    // Get attachments if any
    const attachmentCount = parseInt(req.body.attachments || '0');
    
    // Use Claude AI to extract delivery info from email text
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const emailContent = text || html || '';
    
    if (!emailContent && attachmentCount === 0) {
      console.log('No content in inbound email');
      return res.status(200).json({ message: 'No content to process' });
    }

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract delivery information from this pharmacy manifest email and return ONLY a JSON array of deliveries. Each delivery should have: firstName, lastName, address, city, state, zip, phone, rxNumber, medication, quantity. If multiple deliveries are found return all of them. Email content: ${emailContent}`
      }]
    });

    let text2 = response.content[0].text.trim();
    text2 = text2.replace(/\`\`\`json\n?/g, '').replace(/\`\`\`\n?/g, '').trim();
    
    const deliveries = JSON.parse(text2);
    const results = [];

    for (const delivery of deliveries) {
      try {
        const bcrypt = require('bcryptjs');
        const { v4: uuidv4 } = require('uuid');
        const pharmacy = await prisma.pharmacy.findFirst();

        let patient = await prisma.patient.findFirst({
          where: { firstName: delivery.firstName, lastName: delivery.lastName }
        });

        if (!patient) {
          const dobHash = await bcrypt.hash('000000', 10);
          const portalToken = uuidv4();
          patient = await prisma.patient.create({
            data: {
              firstName: delivery.firstName,
              lastName: delivery.lastName,
              email: `${delivery.firstName.toLowerCase()}.${delivery.lastName.toLowerCase()}@patient.clayworthpharmacy.com`,
              phone: delivery.phone || '',
              address: `${delivery.address}, ${delivery.city}, ${delivery.state} ${delivery.zip}`,
              dobHash,
              portalToken,
              language: 'EN',
            }
          });
        }

        const existing = await prisma.package.findFirst({ where: { rxId: delivery.rxNumber } });
        if (!existing) {
          const pkg = await prisma.package.create({
            data: {
              rxId: delivery.rxNumber,
              medication: delivery.medication || 'Unknown',
              quantity: delivery.quantity || '1',
              patientId: patient.id,
              pharmacyId: pharmacy?.id || null,
              status: 'PENDING',
              urgent: false,
            }
          });
          results.push({ rxId: delivery.rxNumber, patient: `${delivery.firstName} ${delivery.lastName}`, status: 'created' });
        } else {
          results.push({ rxId: delivery.rxNumber, status: 'already exists' });
        }
      } catch (err) {
        console.error('Error processing delivery:', err.message);
        results.push({ error: err.message });
      }
    }

    console.log('Inbound manifest processed:', results.length, 'deliveries');
    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('Inbound manifest error:', err.message);
    return res.status(200).json({ error: err.message });
  }
});

module.exports = router;
