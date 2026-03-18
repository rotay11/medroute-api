require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./client');

async function main() {
  console.log('\n🌱 Seeding MedRoute database...\n');

  const pharmacy = await prisma.pharmacy.upsert({
    where: { id: 'pharmacy-uws-001' },
    update: {},
    create: {
      id: 'pharmacy-uws-001',
      name: 'MedPlus Upper West Side',
      address: '2880 Broadway, New York, NY 10025',
      lat: 40.8034, lng: -73.9663,
      phone: '(212) 555-0100',
      zone: 'Upper West Side',
    },
  });
  console.log(`✓ Pharmacy: ${pharmacy.name}`);

  const adminPass = await bcrypt.hash('Admin@MedRoute2024!', 12);
  await prisma.driver.upsert({
    where: { email: 'admin@medroute.com' },
    update: {},
    create: {
      id: 'admin-001', driverId: 'ADM-0001',
      firstName: 'Patricia', lastName: 'Walsh',
      email: 'admin@medroute.com', passwordHash: adminPass,
      phone: '(212) 555-0001', role: 'ADMIN',
      language: 'EN', mapsLanguage: 'EN',
      zone: 'All Zones', status: 'ACTIVE',
      pharmacyId: pharmacy.id,
    },
  });
  console.log('✓ Admin: admin@medroute.com  /  Admin@MedRoute2024!');

  const dispPass = await bcrypt.hash('Dispatch@2024!', 12);
  await prisma.driver.upsert({
    where: { email: 'dispatch@medroute.com' },
    update: {},
    create: {
      id: 'dispatcher-001', driverId: 'DSP-0001',
      firstName: 'Marcus', lastName: 'Thompson',
      email: 'dispatch@medroute.com', passwordHash: dispPass,
      phone: '(212) 555-0002', role: 'DISPATCHER',
      language: 'EN', mapsLanguage: 'EN',
      zone: 'All Zones', status: 'ACTIVE',
      pharmacyId: pharmacy.id,
    },
  });
  console.log('✓ Dispatcher: dispatch@medroute.com  /  Dispatch@2024!');

  const d1Pass = await bcrypt.hash('Driver@2024!', 12);
  const driver1 = await prisma.driver.upsert({
    where: { email: 'james.miller@medroute.com' },
    update: {},
    create: {
      id: 'driver-001', driverId: 'DRV-0042',
      firstName: 'James', lastName: 'Miller',
      email: 'james.miller@medroute.com', passwordHash: d1Pass,
      phone: '(212) 555-0042', role: 'DRIVER',
      language: 'EN', mapsLanguage: 'EN',
      zone: 'Upper West Side', status: 'OFFLINE',
      pharmacyId: pharmacy.id,
    },
  });
  console.log('✓ Driver (EN/Android): james.miller@medroute.com  /  Driver@2024!');

  const d2Pass = await bcrypt.hash('Conductor@2024!', 12);
  const driver2 = await prisma.driver.upsert({
    where: { email: 'carlos.rivera@medroute.com' },
    update: {},
    create: {
      id: 'driver-002', driverId: 'DRV-0055',
      firstName: 'Carlos', lastName: 'Rivera',
      email: 'carlos.rivera@medroute.com', passwordHash: d2Pass,
      phone: '(718) 555-0055', role: 'DRIVER',
      language: 'ES', mapsLanguage: 'ES',
      zone: 'Upper West Side', status: 'OFFLINE',
      pharmacyId: pharmacy.id,
    },
  });
  console.log('✓ Driver (ES/iPhone): carlos.rivera@medroute.com  /  Conductor@2024!');

  const dobHash = await bcrypt.hash('1968-05-12', 12);

  const patient1 = await prisma.patient.upsert({
    where: { email: 'rajesh.patel@email.com' },
    update: {},
    create: {
      id: 'patient-001', firstName: 'Rajesh', lastName: 'Patel',
      dobHash, email: 'rajesh.patel@email.com',
      phone: '(212) 555-1001',
      address: '412 W 76th St, Apt 3B, New York, NY 10023',
      addressLat: 40.7780, addressLng: -73.9832, language: 'EN',
    },
  });

  const patient2 = await prisma.patient.upsert({
    where: { email: 'maria.torres@email.com' },
    update: {},
    create: {
      id: 'patient-002', firstName: 'Maria', lastName: 'Torres',
      dobHash, email: 'maria.torres@email.com',
      phone: '(212) 555-1002',
      address: '881 Amsterdam Ave, Apt 7C, New York, NY 10025',
      addressLat: 40.7948, addressLng: -73.9666, language: 'ES',
    },
  });

  const patient3 = await prisma.patient.upsert({
    where: { email: 'harold.brooks@email.com' },
    update: {},
    create: {
      id: 'patient-003', firstName: 'Harold', lastName: 'Brooks',
      dobHash, email: 'harold.brooks@email.com',
      phone: '(212) 555-1003',
      address: '340 Riverside Dr, Apt 4F, New York, NY 10025',
      addressLat: 40.8019, addressLng: -73.9698, language: 'EN',
    },
  });
  console.log('✓ 3 test patients created');

  const bundleA = await prisma.bundle.upsert({
    where: { id: 'bundle-a-001' },
    update: {},
    create: {
      id: 'bundle-a-001', patientId: patient1.id,
      address: patient1.address, addressLat: patient1.addressLat, addressLng: patient1.addressLng,
      driverId: driver1.id, stopOrder: 1, status: 'ASSIGNED',
    },
  });
  await prisma.package.upsert({ where: { rxId: 'RX-20483' }, update: {}, create: {
    rxId: 'RX-20483', patientId: patient1.id, pharmacyId: pharmacy.id,
    bundleId: bundleA.id, medication: 'Metformin', dosage: '500mg',
    quantity: '60 tablets', status: 'PENDING',
  }});
  await prisma.package.upsert({ where: { rxId: 'RX-20484' }, update: {}, create: {
    rxId: 'RX-20484', patientId: patient1.id, pharmacyId: pharmacy.id,
    bundleId: bundleA.id, medication: 'Lisinopril', dosage: '10mg',
    quantity: '30 tablets', status: 'PENDING',
  }});

  const bundleB = await prisma.bundle.upsert({
    where: { id: 'bundle-b-001' },
    update: {},
    create: {
      id: 'bundle-b-001', patientId: patient2.id,
      address: patient2.address, addressLat: patient2.addressLat, addressLng: patient2.addressLng,
      driverId: driver1.id, stopOrder: 2, status: 'ASSIGNED',
    },
  });
  await prisma.package.upsert({ where: { rxId: 'RX-20485' }, update: {}, create: {
    rxId: 'RX-20485', patientId: patient2.id, pharmacyId: pharmacy.id,
    bundleId: bundleB.id, medication: 'Sertraline', dosage: '50mg',
    quantity: '28 tablets', status: 'PENDING',
  }});

  const bundleC = await prisma.bundle.upsert({
    where: { id: 'bundle-c-001' },
    update: {},
    create: {
      id: 'bundle-c-001', patientId: patient3.id,
      address: patient3.address, addressLat: patient3.addressLat, addressLng: patient3.addressLng,
      driverId: driver1.id, stopOrder: 3, status: 'ASSIGNED',
    },
  });
  await prisma.package.upsert({ where: { rxId: 'RX-20486' }, update: {}, create: {
    rxId: 'RX-20486', patientId: patient3.id, pharmacyId: pharmacy.id,
    bundleId: bundleC.id, medication: 'Insulin glargine', dosage: '100 units/mL',
    quantity: '1 pen', status: 'PENDING', urgent: true, refrigerated: true,
  }});
  console.log('✓ 4 test packages in 3 bundles assigned to James Miller');

  const facPass = await bcrypt.hash('Facility@2024!', 12);
  await prisma.facility.upsert({
    where: { email: 'pharmacy@stlukes-nyc.org' },
    update: {},
    create: {
      name: "St. Luke's Medical Center",
      address: '1111 Amsterdam Ave, New York, NY 10025',
      lat: 40.8004, lng: -73.9596,
      phone: '(212) 523-4000',
      email: 'pharmacy@stlukes-nyc.org',
      passwordHash: facPass,
    },
  });
  console.log("✓ Facility: pharmacy@stlukes-nyc.org  /  Facility@2024!");

  console.log('\n✅ Database seeded!\n');
  console.log('══════════════════════════════════════════════════');
  console.log('  TEST ACCOUNTS');
  console.log('══════════════════════════════════════════════════');
  console.log('  Admin:       admin@medroute.com        Admin@MedRoute2024!');
  console.log('  Dispatcher:  dispatch@medroute.com     Dispatch@2024!');
  console.log('  Driver (EN): james.miller@medroute.com Driver@2024!');
  console.log('  Driver (ES): carlos.rivera@medroute.com Conductor@2024!');
  console.log('  Patient:     rajesh.patel@email.com    DOB: 1968-05-12');
  console.log('  Facility:    pharmacy@stlukes-nyc.org  Facility@2024!');
  console.log('══════════════════════════════════════════════════\n');
}

main()
  .catch(e => { console.error('Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
