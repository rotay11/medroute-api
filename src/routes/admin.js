const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const prisma  = require('../db/client');
const logger  = require('../utils/logger');
const { authenticate, requireAdmin, requireSupervisor } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/drivers', requireSupervisor, async (req, res) => {
  try {
    const { status, language, zone, search } = req.query;
    const where = {};
    if (status)   where.status   = status;
    if (language) where.language = language;
    if (zone)     where.zone     = zone;
    if (search)   where.OR = [{ firstName:{ contains:search, mode:'insensitive' } }, { lastName:{ contains:search, mode:'insensitive' } }, { email:{ contains:search, mode:'insensitive' } }, { driverId:{ contains:search, mode:'insensitive' } }];
    const drivers = await prisma.driver.findMany({
      where,
      select: { id:true, driverId:true, firstName:true, lastName:true, email:true, phone:true, role:true, language:true, mapsLanguage:true, zone:true, status:true, shiftType:true, appVersion:true, createdAt:true, pharmacyId:true, pharmacy:{ select:{ name:true } }, _count:{ select:{ deliveries:true, discrepancies:true } }, sessions:{ orderBy:{ loginAt:'desc' }, take:1, select:{ loginAt:true, isActive:true } } },
      orderBy: [{ status:'asc' }, { firstName:'asc' }],
    });
    return res.json({ drivers, total:drivers.length });
  } catch (err) { return res.status(500).json({ error:'Could not load drivers' }); }
});

router.post('/drivers', requireAdmin,
  [body('firstName').trim().notEmpty(), body('lastName').trim().notEmpty(), body('email').isEmail().normalizeEmail(), body('phone').notEmpty(), body('role').isIn(['DRIVER','DISPATCHER','SUPERVISOR']), body('language').isIn(['EN','ES'])],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error:'Validation failed', details:errors.array() });
    const { firstName, lastName, email, phone, role, language, mapsLanguage, zone, pharmacyId, shiftType } = req.body;
    try {
      const existing = await prisma.driver.findUnique({ where:{ email } });
      if (existing) return res.status(409).json({ error:'Email already registered' });
      const count    = await prisma.driver.count();
      const driverId = `DRV-${String(count+1).padStart(4,'0')}`;
      const chars    = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';
      const tempPass = Array.from({ length:12 }, ()=>chars[Math.floor(Math.random()*chars.length)]).join('');
      const hash     = await bcrypt.hash(tempPass, 12);
      const driver   = await prisma.driver.create({ data:{ driverId, firstName, lastName, email, passwordHash:hash, phone, role, language, mapsLanguage:mapsLanguage||language, zone:zone||'Unassigned', pharmacyId:pharmacyId||null, shiftType:shiftType||'Morning · 7 AM – 3 PM', status:'OFFLINE' } });
      await prisma.auditLog.create({ data:{ actorId:req.driver.id, actorType:'admin', action:'DRIVER_CREATED', entityType:'driver', entityId:driver.id, ipAddress:req.ip, metadata:{ driverId, email, role, language } } });
      logger.info(`Driver created: ${driverId}`);
      return res.status(201).json({ driver:{ id:driver.id, driverId, firstName, lastName, email, role, language, zone }, tempPassword:tempPass, message:`Driver created. Temp password: ${tempPass}` });
    } catch (err) { return res.status(500).json({ error:'Could not create driver' }); }
  }
);

router.patch('/drivers/:id', requireSupervisor, async (req, res) => {
  const fields = ['firstName','lastName','phone','role','language','mapsLanguage','zone','status','pharmacyId','shiftType'];
  const data = {};
  fields.forEach(f => { if (req.body[f] !== undefined) data[f] = req.body[f]; });
  try {
    const updated = await prisma.driver.update({ where:{ id:req.params.id }, data, select:{ id:true, driverId:true, firstName:true, lastName:true, email:true, role:true, language:true, status:true } });
    if (data.status === 'SUSPENDED') {
      await prisma.session.updateMany({ where:{ driverId:req.params.id, isActive:true }, data:{ isActive:false, logoutAt:new Date() } });
      const io = req.app.get('io');
      if (io) io.to(`driver_${req.params.id}`).emit('account_suspended', { message:'Your account has been suspended. Contact your administrator.' });
    }
    await prisma.auditLog.create({ data:{ actorId:req.driver.id, actorType:'admin', action:data.status==='SUSPENDED'?'DRIVER_SUSPENDED':'DRIVER_UPDATED', entityType:'driver', entityId:req.params.id, ipAddress:req.ip, metadata:data } });
    return res.json({ driver:updated });
  } catch (err) { return res.status(500).json({ error:'Could not update driver' }); }
});

router.get('/reconciliation/:date', requireSupervisor, async (req, res) => {
  try {
    const date    = new Date(req.params.date);
    const nextDay = new Date(date); nextDay.setDate(nextDay.getDate()+1);
    const scans   = await prisma.scan.findMany({ where:{ timestamp:{ gte:date, lt:nextDay } }, include:{ package:{ select:{ rxId:true, medication:true, urgent:true, patient:{ select:{ firstName:true, lastName:true } } } }, driver:{ select:{ driverId:true, firstName:true, lastName:true } } }, orderBy:{ timestamp:'asc' } });
    const discrepancies = await prisma.discrepancy.findMany({ where:{ flaggedAt:{ gte:date, lt:nextDay } }, include:{ package:{ select:{ rxId:true, medication:true } }, driver:{ select:{ driverId:true, firstName:true, lastName:true } } } });
    const pickups    = scans.filter(s=>s.scanType==='PICKUP');
    const deliveries = scans.filter(s=>s.scanType==='DELIVERY');
    return res.json({ date:req.params.date, summary:{ totalPickups:pickups.length, totalDeliveries:deliveries.length, discrepancies:discrepancies.length, complianceRate:pickups.length>0?Math.round((deliveries.length/pickups.length)*100):100 }, pickups, deliveries, discrepancies });
  } catch (err) { return res.status(500).json({ error:'Could not generate report' }); }
});

router.get('/app-versions', requireAdmin, async (req, res) => {
  const versions = await prisma.appVersion.findMany({ orderBy:{ publishedAt:'desc' } });
  return res.json({ versions });
});

router.post('/app-versions', requireAdmin, async (req, res) => {
  const { platform, version, downloadUrl, releaseNotes, isMinimum } = req.body;
  try {
    await prisma.appVersion.updateMany({ where:{ platform, isLatest:true }, data:{ isLatest:false } });
    const v = await prisma.appVersion.create({ data:{ platform, version, downloadUrl, releaseNotes, isMinimum:!!isMinimum, publishedBy:req.driver.id } });
    return res.status(201).json({ version:v });
  } catch (err) { return res.status(500).json({ error:'Could not publish version' }); }
});

module.exports = router;
