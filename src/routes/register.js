const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../db/client');

// POST /api/register — public pharmacy self-registration
router.post('/', async (req, res) => {
  const { pharmacyName, contactName, email, phone, address, licenseNumber, licenseState, password, plan, driverCount } = req.body;

  if (!pharmacyName || !email || !password || !licenseNumber) {
    return res.status(400).json({ error: 'Pharmacy name, email, password and license number are required' });
  }

  try {
    // Check if email already registered
    const existing = await prisma.driver.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Create pharmacy
    const pharmacy = await prisma.pharmacy.create({
      data: {
        name: pharmacyName,
        address: address || '',
        lat: 0,
        lng: 0,
        phone: phone || '',
        licenseNumber,
        licenseState: licenseState || '',
        plan: plan || 'BASIC',
        status: 'TRIAL',
        trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        zone: 'default',
      }
    });

    // Create subscription record
    await prisma.subscription.create({
      data: {
        pharmacyId: pharmacy.id,
        plan: plan || 'BASIC',
        status: 'TRIAL',
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }
    });

    // Create admin driver account
    const passwordHash = await bcrypt.hash(password, 10);
    const nameParts = (contactName || 'Admin User').split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || 'Admin';

    const admin = await prisma.driver.create({
      data: {
        driverId: 'ADM-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        firstName,
        lastName,
        email,
        passwordHash,
        phone: phone || '',
        role: 'ADMIN',
        pharmacyId: pharmacy.id,
        zone: 'default',
        status: 'ACTIVE',
      }
    });

    // Send welcome email via SendGrid if available
    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: email,
        from: 'info@medrouterx.ai',
        subject: 'Welcome to MedRouteRx — Your 30-Day Trial Has Started',
        html: `
          <h2>Welcome to MedRouteRx, ${firstName}!</h2>
          <p>Your pharmacy <strong>${pharmacyName}</strong> has been registered successfully.</p>
          <p>Your 30-day free trial has started. No credit card required during the trial period.</p>
          <h3>Your login credentials:</h3>
          <p>Email: ${email}<br>Password: The password you chose during registration</p>
          <h3>Get started:</h3>
          <p>Dashboard: <a href="https://medroute-dashboard.vercel.app">medroute-dashboard.vercel.app</a></p>
          <p>Download driver app: <a href="https://medroute-dashboard.vercel.app/download">medroute-dashboard.vercel.app/download</a></p>
          <p>If you have any questions contact us at info@medrouterx.ai</p>
          <p>The MedRouteRx Team<br>Taylor Pharmacy Consulting</p>
        `
      });
    } catch (emailErr) {
      console.error('Welcome email failed:', emailErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Registration successful. Your 30-day trial has started.',
      pharmacyId: pharmacy.id,
      adminEmail: email,
      trialEndsAt: pharmacy.trialEndsAt,
      dashboardUrl: 'https://medroute-dashboard.vercel.app'
    });

  } catch (err) {
    console.error('Registration error:', err.message);
    return res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

module.exports = router;
