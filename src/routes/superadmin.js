const express = require('express');
const router = express.Router();
const prisma = require('../db/client');
const { authenticate, requireAdmin } = require('../middleware/auth');

// All superadmin routes require authentication and SUPERADMIN role
router.use(authenticate);
router.use((req, res, next) => {
  if (req.driver.role !== 'SUPERADMIN') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
});

// GET /api/superadmin/pharmacies — list all pharmacies with stats
router.get('/pharmacies', async (req, res) => {
  try {
    const pharmacies = await prisma.pharmacy.findMany({
      include: {
        subscription: true,
        drivers: { where: { role: 'DRIVER' }, select: { id: true, status: true } },
        packages: { select: { id: true, status: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' }
    });

    const planPrices = { BASIC: 199, PROFESSIONAL: 349, ENTERPRISE: 499 };

    const result = pharmacies.map(p => ({
      id: p.id,
      name: p.name,
      address: p.address,
      phone: p.phone,
      licenseNumber: p.licenseNumber,
      licenseState: p.licenseState,
      plan: p.plan,
      status: p.status,
      trialEndsAt: p.trialEndsAt,
      createdAt: p.createdAt,
      driverCount: p.drivers.length,
      activeDrivers: p.drivers.filter(d => d.status === 'ACTIVE').length,
      totalDeliveries: p.packages.filter(pkg => pkg.status === 'DELIVERED').length,
      monthlyRevenue: p.status === 'ACTIVE' ? planPrices[p.plan] || 199 : 0,
      subscription: p.subscription,
    }));

    const totalMRR = result.filter(p => p.status === 'ACTIVE').reduce((sum, p) => sum + p.monthlyRevenue, 0);
    const totalPharmacies = result.length;
    const activePharmacies = result.filter(p => p.status === 'ACTIVE').length;
    const trialPharmacies = result.filter(p => p.status === 'TRIAL').length;

    return res.json({
      stats: { totalPharmacies, activePharmacies, trialPharmacies, totalMRR },
      pharmacies: result
    });
  } catch (err) {
    console.error('Superadmin pharmacies error:', err.message);
    return res.status(500).json({ error: 'Could not fetch pharmacies' });
  }
});

// PATCH /api/superadmin/pharmacies/:id — update pharmacy status or plan
router.patch('/pharmacies/:id', async (req, res) => {
  const { status, plan } = req.body;
  try {
    const pharmacy = await prisma.pharmacy.update({
      where: { id: req.params.id },
      data: {
        ...(status && { status }),
        ...(plan && { plan }),
      }
    });
    return res.json({ success: true, pharmacy });
  } catch (err) {
    return res.status(500).json({ error: 'Could not update pharmacy' });
  }
});

// DELETE /api/superadmin/pharmacies/:id — suspend pharmacy
router.delete('/pharmacies/:id', async (req, res) => {
  try {
    await prisma.pharmacy.update({
      where: { id: req.params.id },
      data: { status: 'SUSPENDED' }
    });
    return res.json({ success: true, message: 'Pharmacy suspended' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not suspend pharmacy' });
  }
});

module.exports = router;
