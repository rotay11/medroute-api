const express = require('express');
const prisma = require('../db/client');
const { authenticate } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const { geocodeAddress } = require('../services/geocode');


// Clean RX number - strip 'Rx', 'RX', or 'rx' prefix and whitespace
function cleanRxNumber(rxNum) {
  if (!rxNum) return rxNum;
  return rxNum.toString().trim().replace(/^(Rx|RX|rx)\s*/i, '').trim();
}

const router = express.Router();

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

        const existing = await prisma.package.findFirst({ where: { rxId: cleanRxNumber(delivery.rxNumber) } });
        if (!existing) {
          const pkg = await prisma.package.create({
            data: {
              rxId: cleanRxNumber(delivery.rxNumber),
              medication: delivery.medication || 'Unknown',
              quantity: delivery.quantity || '1',
              patientId: patient.id,
              pharmacyId: pharmacy?.id || null,
              status: 'PENDING',
              urgent: false,
            }
          });
          results.push({ rxId: cleanRxNumber(delivery.rxNumber), patient: `${delivery.firstName} ${delivery.lastName}`, status: 'created' });
        } else {
          results.push({ rxId: cleanRxNumber(delivery.rxNumber), status: 'already exists' });
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

router.use(authenticate);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fast OCR using Google Vision API
router.post('/parse-fast', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'Image required' });

  try {
    const visionKey = process.env.GOOGLE_VISION_API_KEY;
    if (!visionKey) return res.status(500).json({ error: 'Vision API not configured' });

    const visionRes = await fetch(
      'https://vision.googleapis.com/v1/images:annotate?key=' + visionKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: imageBase64 },
            features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
          }]
        })
      }
    );

    const visionData = await visionRes.json();
    const fullText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';

    if (!fullText) {
      return res.status(400).json({ error: 'Could not read text from image' });
    }

    // Parse the manifest text
    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

    // Find patient name - ALL CAPS line after pharmacy address block
    let firstName = '', lastName = '', address = '', city = '', state = '', zip = '', phone = '';
    const medications = [];

    // Find patient name - look for ALL CAPS name pattern
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Patient name is ALL CAPS, typically LASTNAME, FIRSTNAME or FIRSTNAME LASTNAME
      if (/^[A-Z][A-Z]+[,\s]+[A-Z][A-Z]+/.test(line) && !line.includes('Pharmacy') && !line.includes('DELIVERY') && !line.includes('MANIFEST') && !line.includes('Rx') && !line.includes('PERIOD')) {
        const nameParts = line.split(',').map(s => s.trim());
        if (nameParts.length >= 2) {
          lastName = nameParts[0];
          firstName = nameParts[1].split(' ')[0];
        } else {
          const words = line.split(' ');
          firstName = words[0];
          lastName = words[words.length - 1];
        }
        // Address is typically the next line
        if (i + 1 < lines.length) {
          address = lines[i + 1];
        }
        // City, state, zip on the line after address
        if (i + 2 < lines.length) {
          const cityLine = lines[i + 2];
          const csz = cityLine.match(/^([A-Za-z\s]+),?\s*([A-Z]{2})\s*(\d{5})/);
          if (csz) {
            city = csz[1].trim();
            state = csz[2];
            zip = csz[3];
          }
        }
        break;
      }
    }

    // Find phone number
    for (const line of lines) {
      const phoneMatch = line.match(/Phone[:\s]*([\(\)\d\s\-]+)/i);
      if (phoneMatch) {
        phone = phoneMatch[1].trim();
        break;
      }
    }

    // Find all RX numbers and medications
    for (let i = 0; i < lines.length; i++) {
      const rxMatch = lines[i].match(/Rx\s*([\d\-]+)/i);
      if (rxMatch) {
        const rxNumber = rxMatch[1];
        // Medication name is typically the next line or same line after RX
        let medication = '';
        let quantity = '';
        // Check next line for medication
        if (i + 1 < lines.length) {
          const medLine = lines[i + 1];
          // Skip if next line is another Rx number
          if (!/^Rx\s/i.test(medLine)) {
            // Extract medication name - everything before the date
            const medMatch = medLine.match(/^([A-Z][A-Z\s\.\%\/\d]+?)\s+\d{1,2}\/\d{1,2}\/\d{2}/);
            if (medMatch) {
              medication = medMatch[1].trim();
            } else {
              medication = medLine.split(/\s{2,}/)[0].trim();
            }
            // Extract quantity - usually a number near the end
            const qtyMatch = medLine.match(/(\d+)\s+\$[\d\.]+\s*$/);
            if (qtyMatch) quantity = qtyMatch[1];
          }
        }
        medications.push({ rxNumber, medication, quantity: quantity || '1' });
      }
    }

    const result = {
      firstName,
      lastName,
      address,
      city,
      state,
      zip,
      phone,
      medications: medications.length > 0 ? medications : [],
      totalRxCount: medications.length.toString(),
      rawText: fullText
    };

    console.log('Vision OCR:', firstName, lastName, medications.length, 'medications found');
    return res.json({ success: true, data: result });

  } catch (err) {
    console.error('Vision parse error:', err.message);
    return res.status(500).json({ error: 'Could not read manifest', details: err.message });
  }
});

// Parse manifest photo — uses Vision first, Claude AI as fallback
router.post('/parse', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'Image required' });

  // Try Google Vision first for speed
  const visionKey = process.env.GOOGLE_VISION_API_KEY;
  if (visionKey) {
    try {
      const visionRes = await fetch(
        'https://vision.googleapis.com/v1/images:annotate?key=' + visionKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{
              image: { content: imageBase64 },
              features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
            }]
          })
        }
      );
      const visionData = await visionRes.json();
      const fullText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';
      if (fullText) {
        // Use Claude to parse the extracted text — much faster than sending image
        const parseResponse = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: `Parse this pharmacy delivery manifest text. Return ONLY valid JSON, no markdown:
{
  "firstName": "first name",
  "lastName": "last name",
  "address": "street address",
  "city": "city",
  "state": "2 letter state",
  "zip": "zip code",
  "phone": "phone number",
  "medications": [
    { "rxNumber": "rx number", "medication": "drug name and strength", "quantity": "qty" }
  ]
}
Extract ALL medications - every line with Rx followed by numbers.
Manifest text:
${fullText}`
          }]
        });
        let parsed = parseResponse.content[0].text.trim();
        parsed = parsed.replace(/\`\`\`json\n?/g, '').replace(/\`\`\`\n?/g, '').trim();
        const data = JSON.parse(parsed);
        console.log('Vision+Claude OCR:', data.firstName, data.lastName, (data.medications||[]).length, 'meds');
        return res.json({ success: true, data });
      }
    } catch (visionErr) {
      console.log('Vision failed, falling back to Claude image:', visionErr.message);
    }
  }

  // Fallback: send image directly to Claude
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
            text: `This is a Clayworth Pharmacy delivery manifest. Extract ALL information and return ONLY a valid JSON object with no markdown, no code blocks, no extra text.

CRITICAL INSTRUCTIONS:
- Patient name is in ALL CAPS near top left below pharmacy address
- Extract EVERY SINGLE medication line - there may be 1 to 10 or more
- Each medication has a barcode above it, then Rx NUMBER, then drug name
- Look for ALL lines starting with "Rx" followed by numbers
- The manifest shows "No. of Rx's = N" at the bottom - extract exactly that many medications

{
  "firstName": "first name from ALL CAPS patient name",
  "lastName": "last name from ALL CAPS patient name",
  "address": "street address",
  "city": "city",
  "state": "2 letter state",
  "zip": "5 digit zip",
  "phone": "phone number",
  "medications": [
    { "rxNumber": "exact Rx number eg 6850788-00", "medication": "full drug name and strength", "quantity": "quantity" },
    { "rxNumber": "next Rx number", "medication": "drug name", "quantity": "quantity" }
  ],
  "totalRxCount": "number from No. of Rxs line"
}

Extract ALL medications - do not stop after 1 or 2. If the manifest shows 5 medications extract all 5.`
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
  const { firstName, lastName, email, phone, address, dob, rxNumber, medication, quantity, medications, driverId } = req.body;
  if (!firstName || !lastName || !address) {
    return res.status(400).json({ error: 'Patient name and address are required' });
  }
  // Support both single rxNumber and array of medications
  const medList = medications && medications.length > 0 
    ? medications 
    : [{ rxNumber, medication, quantity }];
  if (!medList[0].rxNumber) {
    return res.status(400).json({ error: 'At least one RX number is required' });
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

    // Get pharmacy
    const pharmacy = await prisma.pharmacy.findFirst();

    // Create all packages from medList - with deduplication
    const createdPackages = [];
    const skippedPackages = [];
    const seenInThisBatch = new Set();
    for (const med of medList) {
      // Skip blank, whitespace-only, or invalid RX numbers
      const cleanedRx = cleanRxNumber(med.rxNumber);
      if (!cleanedRx || cleanedRx.trim().length < 3) continue;
      
      // Skip duplicates within this same scan batch (multi-page re-reads)
      if (seenInThisBatch.has(cleanedRx)) {
        skippedPackages.push(cleanedRx);
        continue;
      }
      seenInThisBatch.add(cleanedRx);
      
      const existing = await prisma.package.findFirst({ where: { rxId: cleanedRx } });
      if (existing) {
        skippedPackages.push(cleanedRx);
        continue;
      }
      const pkg = await prisma.package.create({
        data: {
          rxId: cleanRxNumber(med.rxNumber),
          medication: med.medication || 'Unknown',
          dosage: '',
          quantity: med.quantity || '1',
          patientId: patient.id,
          pharmacyId: pharmacy?.id || null,
          status: 'PENDING',
          urgent: false,
        }
      });
      createdPackages.push(pkg);
    }

    if (createdPackages.length === 0) {
      return res.status(409).json({ error: 'All RX numbers already in system', skipped: skippedPackages });
    }

    // Check if THIS PATIENT already has an active bundle for this driver
    const driver = await prisma.driver.findUnique({ where: { id: req.driver.id } });
    let bundle = await prisma.bundle.findFirst({
      where: { 
        driverId: req.driver.id, 
        patientId: patient.id,
        status: { in: ['ASSIGNED', 'IN_TRANSIT'] }
      }
    });

    if (bundle) {
      // Patient already has a stop - add packages to existing bundle (no duplicate stop)
      console.log('Adding packages to existing bundle for patient ' + patient.id);
    } else {
      // No existing stop for this patient - create new bundle
      const lastBundle = await prisma.bundle.findFirst({
        where: { driverId: req.driver.id, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } },
        orderBy: { stopOrder: 'desc' }
      });
      const stopOrder = lastBundle ? lastBundle.stopOrder + 1 : 1;

      // Geocode the address to enable nearest/farthest sorting
      const coords = await geocodeAddress(address);

      bundle = await prisma.bundle.create({
        data: {
          patientId: patient.id,
          address,
          addressLat: coords ? coords.lat : null,
          addressLng: coords ? coords.lng : null,
          driver: { connect: { id: req.driver.id } },
          stopOrder,
          status: 'ASSIGNED',
        }
      });

      if (coords) {
        await prisma.patient.update({
          where: { id: patient.id },
          data: { addressLat: coords.lat, addressLng: coords.lng }
        }).catch(() => {});
      }
    }

    // Link all packages to bundle
    for (const pkg of createdPackages) {
      await prisma.package.update({
        where: { id: pkg.id },
        data: { bundleId: bundle.id }
      });
    }

    return res.status(201).json({
      success: true,
      patient,
      packages: createdPackages,
      skipped: skippedPackages,
      bundle,
      message: `Patient and ${createdPackages.length} delivery item(s) created successfully`
    });
  } catch (err) {
    console.error('Create delivery error:', err.message);
    return res.status(500).json({ error: 'Could not create delivery', details: err.message });
  }
});



// Add additional packages (a new page) to an existing bundle without creating a duplicate stop
router.post('/add-to-bundle/:bundleId', async (req, res) => {
  try {
    const bundle = await prisma.bundle.findFirst({
      where: { id: req.params.bundleId, driverId: req.driver.id },
      include: { packages: { select: { rxId: true } } }
    });
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
    if (bundle.status === 'DELIVERED') {
      return res.status(400).json({ error: 'Cannot add to a completed delivery' });
    }

    const medList = Array.isArray(req.body.medications) ? req.body.medications : [];
    const pharmacy = await prisma.pharmacy.findFirst();
    const existingRxIds = new Set(bundle.packages.map(p => p.rxId));
    const seenInBatch = new Set();
    const added = [];
    const skipped = [];

    for (const med of medList) {
      const cleanedRx = cleanRxNumber(med.rxNumber);
      if (!cleanedRx || cleanedRx.trim().length < 3) continue;
      if (existingRxIds.has(cleanedRx) || seenInBatch.has(cleanedRx)) {
        skipped.push(cleanedRx);
        continue;
      }
      seenInBatch.add(cleanedRx);
      const dupCheck = await prisma.package.findFirst({ where: { rxId: cleanedRx } });
      if (dupCheck) { skipped.push(cleanedRx); continue; }
      const pkg = await prisma.package.create({
        data: {
          rxId: cleanedRx,
          medication: med.medication || 'Unknown',
          dosage: '',
          quantity: med.quantity || '1',
          patientId: bundle.patientId,
          pharmacyId: pharmacy?.id || null,
          bundleId: bundle.id,
          status: 'PENDING',
          urgent: false,
        }
      });
      added.push(pkg);
    }

    await prisma.auditLog.create({
      data: { actorId: req.driver.id, actorType: 'driver', action: 'BUNDLE_PAGE_ADDED', entityType: 'bundle', entityId: bundle.id, metadata: { added: added.length, skipped: skipped.length } }
    }).catch(() => {});

    return res.json({
      success: true,
      bundleId: bundle.id,
      added: added.length,
      skipped: skipped.length,
      message: 'Added ' + added.length + ' medication(s) to existing delivery'
    });
  } catch (err) {
    console.error('Add page error:', err);
    return res.status(500).json({ error: 'Could not add page to delivery', details: err.message });
  }
});

module.exports = router;
