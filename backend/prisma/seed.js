/* AMS seed: roles + default users (idempotent) */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

/**
 * Production guard — roles/workflows are seeded everywhere, but demo
 * data (demo users, org data, fleet, rooms, sample items) only in testing.
 * In production only sysadmin is created; set its password via SEED_PASSWORD.
 */
const IS_PROD = (process.env.APP_ENV || '').toLowerCase() === 'production';

const ROLES = [
  ['SYSTEM_ADMIN', 'System Administrator - full technical control'],
  ['ADMINISTRATION', 'Administration office - processes admin requests'],
  ['DEPARTMENT_HEAD', 'Reviews and approves department requests'],
  ['PURCHASING', 'Handles quotations, vendors and POs'],
  ['FINANCE', 'Views purchase/invoice/payment information'],
  ['MANAGEMENT', 'Approves high-value requests, views reports'],
  ['MAINTENANCE_COORDINATOR', 'Maintains maintenance records and schedules'],
  ['EMPLOYEE', 'Creates own requests, reads announcements'],
];

async function main() {
  const seedPassword = process.env.SEED_PASSWORD || 'ChangeMe#2026';
  const hash = await bcrypt.hash(seedPassword, 10);

  for (const [name, description] of ROLES) {
    await prisma.role.upsert({
      where: { name },
      update: { description },
      create: { name, description },
    });
  }
  console.log('Roles seeded:', ROLES.length);
  if (IS_PROD) {
    console.log('Production mode — skipping demo data seed (only sysadmin + roles + workflows).');
    await prisma.$disconnect();
    return;
  }

  // =============================================================
  // Demo/master data runs ONCE per database. Everything in the
  // demo block below is deletable from the UI (drivers, vehicles,
  // rooms, inventory items…), so re-seeding on every boot would
  // resurrect deleted rows. The seed.demo_data_v1 flag marks the
  // database as seeded. To re-seed demo data deliberately, delete
  // the row: DELETE FROM system_settings WHERE key='seed.demo_data_v1';
  // Roles/users/workflows above/below stay idempotent every boot.
  // =============================================================
  const DEMO_FLAG_KEY = 'seed.demo_data_v1';
  const demoFlag = await prisma.systemSetting.findUnique({ where: { key: DEMO_FLAG_KEY } });
  if (demoFlag) {
    console.log('Demo data already seeded (seed.demo_data_v1) — skipping demo block.');
  } else {
  const users = IS_PROD ? [
    { username: 'sysadmin', fullName: 'System Administrator', roles: ['SYSTEM_ADMIN'] },
  ] : [
    { username: 'sysadmin', fullName: 'System Administrator', roles: ['SYSTEM_ADMIN'] },
    { username: 'admin1', fullName: 'Administration Officer', roles: ['ADMINISTRATION', 'EMPLOYEE'] },
    { username: 'head1', fullName: 'Department Head (Demo)', roles: ['DEPARTMENT_HEAD', 'EMPLOYEE'] },
    { username: 'manager1', fullName: 'Manager (Demo)', roles: ['MANAGEMENT', 'EMPLOYEE'] },
    { username: 'employee1', fullName: 'Employee (Demo)', roles: ['EMPLOYEE'] },
  ];

  for (const u of users) {
    const existing = await prisma.user.findUnique({ where: { username: u.username } });
    if (existing) {
      console.log('User exists, skip:', u.username);
      continue;
    }
    const created = await prisma.user.create({
      data: {
        username: u.username,
        fullName: u.fullName,
        passwordHash: hash,
        userRoles: {
          create: u.roles.map((name) => ({ role: { connect: { name } } })),
        },
      },
    });
    console.log('User created:', created.username);
  }

  // demo organization data
  const branch = await prisma.branch.upsert({
    where: { code: 'HQ' },
    update: {},
    create: { code: 'HQ', name: 'Head Office', address: 'Yangon' },
  });
  const dept = await prisma.department.upsert({
    where: { code: 'ADMIN' },
    update: {},
    create: { code: 'ADMIN', name: 'Administration Department', branchId: branch.id },
  });
  await prisma.department.upsert({
    where: { code: 'IT' },
    update: {},
    create: { code: 'IT', name: 'IT Department', branchId: branch.id },
  });
  await prisma.employee.upsert({
    where: { employeeNo: 'EMP-0001' },
    update: {},
    create: {
      employeeNo: 'EMP-0001',
      fullName: 'Employee (Demo)',
      departmentId: dept.id,
      branchId: branch.id,
      position: 'Staff',
    },
  });
  console.log('Demo org data seeded.');

  // ----- Phase 2: default GENERIC_REQUEST workflow: DEPARTMENT_HEAD → MANAGEMENT -----
  const wf = await prisma.approvalWorkflow.upsert({
    where: { module: 'GENERIC_REQUEST' },
    update: {},
    create: { module: 'GENERIC_REQUEST', name: 'General Request Approval', active: true },
  });
  const stepCount = await prisma.approvalStep.count({ where: { workflowId: wf.id } });
  if (stepCount === 0) {
    await prisma.approvalStep.createMany({
      data: [
        { workflowId: wf.id, level: 1, roleName: 'DEPARTMENT_HEAD', minApprovals: 1 },
        { workflowId: wf.id, level: 2, roleName: 'MANAGEMENT', minApprovals: 1 },
      ],
    });
  }
  console.log('Default workflow seeded.');

  // ----- Car Request workflow: single-step approval by ADMINISTRATION (Plan §6) -----
  const carWf = await prisma.approvalWorkflow.upsert({
    where: { module: 'CAR_REQUEST' },
    update: {},
    create: { module: 'CAR_REQUEST', name: 'Car Request — Administration approval', active: true },
  });
  const carStepCount = await prisma.approvalStep.count({ where: { workflowId: carWf.id } });
  if (carStepCount === 0) {
    await prisma.approvalStep.create({
      data: { workflowId: carWf.id, level: 1, roleName: 'ADMINISTRATION', minApprovals: 1 },
    });
    console.log('CAR_REQUEST workflow seeded (L1 ADMINISTRATION).');
  }

  // ----- Meeting Room Request workflow: single-step approval by ADMINISTRATION (same flow as cars) -----
  const mtgWf = await prisma.approvalWorkflow.upsert({
    where: { module: 'MEETING_ROOM_REQUEST' },
    update: {},
    create: { module: 'MEETING_ROOM_REQUEST', name: 'Meeting Room Request — Administration approval', active: true },
  });
  const mtgStepCount = await prisma.approvalStep.count({ where: { workflowId: mtgWf.id } });
  if (mtgStepCount === 0) {
    await prisma.approvalStep.create({
      data: { workflowId: mtgWf.id, level: 1, roleName: 'ADMINISTRATION', minApprovals: 1 },
    });
    console.log('MEETING_ROOM_REQUEST workflow seeded (L1 ADMINISTRATION).');
  }


  // ----- Office Supply (Inventory) workflow: single-step approval by ADMINISTRATION (Plan §12) -----
  const osrWf = await prisma.approvalWorkflow.upsert({
    where: { module: 'OFFICE_SUPPLY_REQUEST' },
    update: {},
    create: { module: 'OFFICE_SUPPLY_REQUEST', name: 'Office Supply Request — Administration approval', active: true },
  });
  const osrStepCount = await prisma.approvalStep.count({ where: { workflowId: osrWf.id } });
  if (osrStepCount === 0) {
    await prisma.approvalStep.create({
      data: { workflowId: osrWf.id, level: 1, roleName: 'ADMINISTRATION', minApprovals: 1 },
    });
    console.log('OFFICE_SUPPLY_REQUEST workflow seeded (L1 ADMINISTRATION).');
  }

  // ----- Inventory: seed starter stationery items (idempotent by code) -----
  const inventoryDefaults = [
    { code: 'ITM-0001', name: 'A4 Paper', category: 'PAPER', unit: 'ream', minStock: 10, balance: 40, description: 'Double A / similar, 80gsm' },
    { code: 'ITM-0002', name: 'Ball Pen (Blue)', category: 'STATIONERY', unit: 'pcs', minStock: 50, balance: 120, description: 'Standard office ballpoint' },
    { code: 'ITM-0003', name: 'Ball Pen (Black)', category: 'STATIONERY', unit: 'pcs', minStock: 50, balance: 110, description: 'Standard office ballpoint' },
    { code: 'ITM-0004', name: 'Notebook (A5)', category: 'BOOKS', unit: 'pcs', minStock: 20, balance: 45, description: 'Hard cover, 100 pages' },
    { code: 'ITM-0005', name: 'Stapler', category: 'STATIONERY', unit: 'pcs', minStock: 5, balance: 12, description: 'Medium office stapler' },
    { code: 'ITM-0006', name: 'Staple Pins', category: 'STATIONERY', unit: 'box', minStock: 10, balance: 25, description: '26/6, 1000 pins per box' },
    { code: 'ITM-0007', name: 'File Folder', category: 'STATIONERY', unit: 'pcs', minStock: 30, balance: 80, description: 'Lever arch / box file' },
    { code: 'ITM-0008', name: 'Envelope (A4)', category: 'STATIONERY', unit: 'box', minStock: 5, balance: 15, description: 'Window, 100 pcs per box' },
    { code: 'ITM-0009', name: 'Toner Cartridge', category: 'IT_SUPPLIES', unit: 'pcs', minStock: 4, balance: 6, description: 'HP 85A / compatible' },
    { code: 'ITM-0010', name: 'Instant Coffee', category: 'KITCHEN', unit: 'jar', minStock: 6, balance: 10, description: 'Pantry supply' },
  ];
  for (const item of inventoryDefaults) {
    await prisma.inventoryItem.upsert({ where: { code: item.code }, update: {}, create: item });
  }
  console.log('Inventory items seeded.');

  // ----- Phase 2: give head1 / admin1 / employee1 user accounts a link to employees + departments -----
  // (department heads need a department to approve for; requester needs one too)
  const it = await prisma.department.findUnique({ where: { code: 'IT' } });
  const admin = await prisma.department.findUnique({ where: { code: 'ADMIN' } });
  const h1 = await prisma.user.findUnique({ where: { username: 'head1' } });
  const a1 = await prisma.user.findUnique({ where: { username: 'admin1' } });
  const e1 = await prisma.user.findUnique({ where: { username: 'employee1' } });

  const headEmp = await prisma.employee.upsert({
    where: { employeeNo: 'EMP-0002' },
    update: { userId: h1?.id, departmentId: it?.id },
    create: { employeeNo: 'EMP-0002', fullName: 'Department Head (Demo)', position: 'Head', departmentId: it?.id, userId: h1?.id },
  });
  await prisma.department.update({ where: { code: 'IT' }, data: { headEmployeeId: headEmp.id } });

  await prisma.employee.upsert({
    where: { employeeNo: 'EMP-0003' },
    update: { userId: a1?.id, departmentId: admin?.id },
    create: { employeeNo: 'EMP-0003', fullName: 'Administration Officer', position: 'Officer', departmentId: admin?.id, userId: a1?.id },
  });
  await prisma.employee.upsert({
    where: { employeeNo: 'EMP-0004' },
    update: { userId: e1?.id, departmentId: it?.id },
    create: { employeeNo: 'EMP-0004', fullName: 'Employee (Demo)', position: 'Staff', departmentId: it?.id, userId: e1?.id },
  });
  console.log('Demo user-employee links seeded.');

  // ----- Phase 3: sample fleet -----
  const drivers = [
    { name: 'U Aung Kyaw', phone: '09-450001111', licenseNo: 'DL-12345' },
    { name: 'U Zaw Zaw', phone: '09-450002222', licenseNo: 'DL-12346' },
  ];
  const driverIds = {};
  for (const d of drivers) {
    const existing = await prisma.driver.findFirst({ where: { name: d.name } });
    driverIds[d.name] = existing
      ? existing.id
      : (await prisma.driver.create({ data: d })).id;
  }

  const vehicles = [
    { vehicleNo: 'YGN-1234', vehicleType: 'SEDAN', brandModel: 'Toyota Corolla', capacity: 4, driverName: 'U Aung Kyaw', currentMileage: 45200 },
    { vehicleNo: 'YGN-5678', vehicleType: 'SUV', brandModel: 'Toyota Land Cruiser', capacity: 7, driverName: 'U Zaw Zaw', currentMileage: 88300 },
    { vehicleNo: 'YGN-9012', vehicleType: 'PICKUP', brandModel: 'Hilux Revo', capacity: 2, driverName: null, currentMileage: 30150 },
  ];
  for (const v of vehicles) {
    const existing = await prisma.vehicle.findUnique({ where: { vehicleNo: v.vehicleNo } });
    if (!existing) {
      await prisma.vehicle.create({
        data: {
          vehicleNo: v.vehicleNo,
          vehicleType: v.vehicleType,
          brandModel: v.brandModel,
          capacity: v.capacity,
          driverId: v.driverName ? driverIds[v.driverName] : null,
          currentMileage: v.currentMileage,
        },
      });
    }
  }
  console.log('Sample fleet seeded.');

  // ----- Meeting rooms: default rooms for the Meeting Room Request flow -----
  const rooms = [
    { name: 'Meeting Room A', location: 'Head Office — 2nd Floor', capacity: 10, facilities: 'TV, Whiteboard, Conference phone' },
    { name: 'Meeting Room B', location: 'Head Office — 2nd Floor', capacity: 6, facilities: 'TV, Whiteboard' },
    { name: 'Board Room', location: 'Head Office — 5th Floor', capacity: 20, facilities: 'Projector, Conference phone, AC' },
  ];
  for (const r of rooms) {
    await prisma.meetingRoom.upsert({ where: { name: r.name }, update: {}, create: r });
  }
  console.log('Meeting rooms seeded.');

  // mark demo data as seeded — see the note at the top of this block
  await prisma.systemSetting.create({ data: { key: DEMO_FLAG_KEY, value: 'done' } });
  console.log('Demo data flag set (seed.demo_data_v1).');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
