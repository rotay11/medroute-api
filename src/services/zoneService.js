const prisma = require('../db/client');

// Extract zip code from an address string
function extractZipCode(address) {
  if (!address) return null;
  const match = address.match(/\b\d{5}\b/);
  return match ? match[0] : null;
}

// Find the driver assigned to a zip code
async function findDriverForZip(zipCode, pharmacyId) {
  if (!zipCode) return null;
  
  try {
    const drivers = await prisma.driver.findMany({
      where: {
        status: { not: 'SUSPENDED' },
        role: 'DRIVER',
        zipCodes: { not: '' },
        pharmacyId: pharmacyId || undefined
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        driverId: true,
        zipCodes: true,
        zone: true,
        status: true
      }
    });

    for (const driver of drivers) {
      const driverZips = driver.zipCodes
        .split(',')
        .map(z => z.trim())
        .filter(z => z.length > 0);
      
      if (driverZips.includes(zipCode)) {
        return driver;
      }
    }
    return null;
  } catch (err) {
    console.error('Zone lookup error:', err.message);
    return null;
  }
}

// Auto assign a delivery to a driver based on zip code
async function autoAssignDriver(address, pharmacyId) {
  const zipCode = extractZipCode(address);
  if (!zipCode) return { driver: null, zipCode: null };
  
  const driver = await findDriverForZip(zipCode, pharmacyId);
  return { driver, zipCode };
}

module.exports = { extractZipCode, findDriverForZip, autoAssignDriver };
