const express = require('express');
const prisma  = require('../db/client');
const router  = express.Router();

router.get('/', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected', timestamp: new Date(), version: '1.0.0' });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

module.exports = router;
