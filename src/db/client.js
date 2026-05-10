const { PrismaClient } = require('@prisma/client');

// Configure connection pooling and retry logic for stable Neon connections
const prisma = new PrismaClient({
  log: ['warn', 'error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Initial connection
prisma.$connect()
  .then(() => console.log('Database connected successfully'))
  .catch((err) => {
    console.error('Initial database connection failed:', err.message);
    setTimeout(() => prisma.$connect().catch(() => {}), 5000);
  });

// Wrap Prisma operations with retry logic for connection errors
const withRetry = async (operation, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isConnectionError = 
        error?.message?.includes('Connection') ||
        error?.message?.includes('connect') ||
        error?.message?.includes('Closed') ||
        error?.message?.includes('terminating') ||
        error?.code === 'P1001' ||
        error?.code === 'P1002' ||
        error?.code === 'P1017';
      
      if (isConnectionError && attempt < maxRetries) {
        console.log(`Connection error on attempt ${attempt}, retrying in ${attempt * 500}ms...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
        try {
          await prisma.$disconnect();
          await prisma.$connect();
        } catch (reconnectErr) {
          // Continue to retry
        }
        continue;
      }
      throw error;
    }
  }
};

// Periodic connection keepalive (every 4 minutes - shorter than Neon idle timeout)
setInterval(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log('Keepalive ping failed, reconnecting...');
    try {
      await prisma.$connect();
    } catch (reconnectErr) {
      // Will retry on next interval
    }
  }
}, 4 * 60 * 1000);

// Handle unexpected errors
process.on('unhandledRejection', (reason) => {
  if (reason?.message?.includes('Connection') || reason?.message?.includes('connect') || reason?.message?.includes('Closed')) {
    console.log('Connection error caught, reconnecting...');
    prisma.$connect().catch(() => {});
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = prisma;
module.exports.withRetry = withRetry;
