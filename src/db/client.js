const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: ['warn', 'error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Handle connection drops from Neon
prisma.$connect().catch((err) => {
  console.error('Initial database connection failed:', err.message);
});

// Reconnect on connection errors
process.on('unhandledRejection', (reason) => {
  if (reason?.message?.includes('Connection') || reason?.message?.includes('connect')) {
    console.log('Reconnecting to database...');
    prisma.$connect().catch(() => {});
  }
});

module.exports = prisma;
