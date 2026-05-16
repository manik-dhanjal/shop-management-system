/* eslint-disable */
/**
 * Bootstrap seeder for SMS.
 *
 * Wired into docker-compose as the `seeder` service. Runs once on stack
 * startup. Idempotent — if the admin user already exists, it skips.
 *
 * What gets seeded:
 *   1. Demo shop  (_id 000000000000000000000001)
 *   2. Admin user (admin@sms.com / Admin@123)
 *   3. 5 fixture products (pipes, wire) with deterministic SKUs/HSN
 *   4. 50 customers in a realistic mix (60% individual, 30% business with
 *      GSTIN, 10% business unregistered) exercising the full customer
 *      schema (GST, addresses with state codes, credit terms, tags, etc.)
 *   5. CustomerCounter set to the number of seeded customers so the next
 *      API-created customer continues the run (e.g. CUST/0051)
 *   6. 2–8 randomized inventory batches per fixture product, with
 *      product.stock + product.inventory[] kept in sync
 *   7. SUPPLIER_COUNT external supplier shops linked into Demo Shop's
 *      suppliers[], plus DISCOVERY_SUPPLIER_COUNT extra unlinked external
 *      shops + 2 SELF_OPERATED "in-system" shops so the find-supplier
 *      picker has something to surface in its suggestions/results rails.
 *      SupplierCounter primed to the linked count.
 *
 * Env overrides:
 *   MONGO_URL                 mongodb://mongodb:27017/shop-management-system
 *   CUSTOMER_COUNT            50
 *   SUPPLIER_COUNT            15   (linked into Demo Shop)
 *   DISCOVERY_SUPPLIER_COUNT  20   (unlinked, for search/suggestions)
 *   INVENTORY_PER_PRODUCT_MIN 2
 *   INVENTORY_PER_PRODUCT_MAX 8
 */

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const { faker } = require('@faker-js/faker');

const MONGO_URL =
  process.env.MONGO_URL ||
  'mongodb://localhost:27017/shop-management-system';
const SHOP_ID = new ObjectId('000000000000000000000001');
const USER_ID = new ObjectId('000000000000000000000002');
const CUSTOMER_COUNT = parseInt(process.env.CUSTOMER_COUNT || '50', 10);
const SUPPLIER_COUNT = parseInt(process.env.SUPPLIER_COUNT || '15', 10);
const DISCOVERY_SUPPLIER_COUNT = parseInt(
  process.env.DISCOVERY_SUPPLIER_COUNT || '20',
  10,
);
const INV_MIN = parseInt(process.env.INVENTORY_PER_PRODUCT_MIN || '2', 10);
const INV_MAX = parseInt(process.env.INVENTORY_PER_PRODUCT_MAX || '8', 10);

// ---- enum literal mirrors --------------------------------------------------
// Keep aligned with backend/src/api/customer/enum/*.enum.ts.

const CustomerType = { INDIVIDUAL: 'INDIVIDUAL', BUSINESS: 'BUSINESS' };
const CustomerStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  BLOCKED: 'BLOCKED',
};
const GstRegistrationType = {
  REGULAR: 'REGULAR',
  COMPOSITION: 'COMPOSITION',
  UNREGISTERED: 'UNREGISTERED',
  CONSUMER: 'CONSUMER',
};
const PaymentTerms = {
  IMMEDIATE: 'IMMEDIATE',
  NET_15: 'NET_15',
  NET_30: 'NET_30',
  NET_45: 'NET_45',
  NET_60: 'NET_60',
};
const CustomerSource = {
  WALK_IN: 'WALK_IN',
  REFERRAL: 'REFERRAL',
  ONLINE: 'ONLINE',
  CAMPAIGN: 'CAMPAIGN',
  EXISTING: 'EXISTING',
};

const ShopKind = {
  SELF_OPERATED: 'SELF_OPERATED',
  EXTERNAL_SUPPLIER: 'EXTERNAL_SUPPLIER',
};

const SupplierStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  BLOCKED: 'BLOCKED',
};

const GstStatus = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
};

// ---- reference data --------------------------------------------------------

const INDIAN_STATES = [
  { code: '07', state: 'Delhi', city: 'New Delhi' },
  { code: '08', state: 'Rajasthan', city: 'Jaipur' },
  { code: '09', state: 'Uttar Pradesh', city: 'Lucknow' },
  { code: '19', state: 'West Bengal', city: 'Kolkata' },
  { code: '24', state: 'Gujarat', city: 'Ahmedabad' },
  { code: '27', state: 'Maharashtra', city: 'Mumbai' },
  { code: '29', state: 'Karnataka', city: 'Bengaluru' },
  { code: '32', state: 'Kerala', city: 'Kochi' },
  { code: '33', state: 'Tamil Nadu', city: 'Chennai' },
  { code: '36', state: 'Telangana', city: 'Hyderabad' },
];

const TAGS_POOL = [
  'VIP',
  'Wholesaler',
  'Retailer',
  'Distributor',
  'Frequent Buyer',
  'New',
  'On Hold',
];

// ---- helpers ---------------------------------------------------------------

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

const pickWeighted = (items) => {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = Math.random() * total;
  for (const it of items) {
    if ((r -= it.weight) <= 0) return it.value;
  }
  return items[items.length - 1].value;
};

const randomPan = () => {
  const upper = (n) =>
    Array.from({ length: n }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ).join('');
  const digits = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
  return `${upper(5)}${digits(4)}${upper(1)}`;
};

const randomGstinForState = (stateCode) => {
  const pan = randomPan();
  const entityChars = '123456789ABCDEFGHIJKLMNPQRSTUVWXYZ'.split('');
  const checkChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
  return `${stateCode}${pan}${pickOne(entityChars)}Z${pickOne(checkChars)}`;
};

const randomIndianPhone = () => {
  const first = String(6 + Math.floor(Math.random() * 4));
  const rest = Array.from({ length: 9 }, () =>
    Math.floor(Math.random() * 10),
  ).join('');
  return `+91${first}${rest}`;
};

const randomTags = () => {
  if (Math.random() < 0.4) return [];
  const count = 1 + Math.floor(Math.random() * 2);
  const picks = new Set();
  while (picks.size < count) picks.add(pickOne(TAGS_POOL));
  return [...picks];
};

const randomAddress = (s) => ({
  address: faker.location.streetAddress(),
  addressLine2:
    Math.random() < 0.3 ? faker.location.secondaryAddress() : undefined,
  city: s.city,
  state: s.state,
  stateCode: s.code,
  country: 'India',
  pinCode: faker.location.zipCode('######'),
});

const padCustomerCode = (n) => `CUST/${String(n).padStart(4, '0')}`;

const emptyStats = () => ({
  totalOrders: 0,
  totalBilled: 0,
  totalPaid: 0,
  outstandingBalance: 0,
  avgOrderValue: 0,
});

// ---- customer payload builders ---------------------------------------------

const buildIndividual = (now) => {
  const s = pickOne(INDIAN_STATES);
  return {
    name: faker.person.fullName(),
    phone: randomIndianPhone(),
    shop: SHOP_ID,
    email: Math.random() < 0.6 ? faker.internet.email() : undefined,
    type: CustomerType.INDIVIDUAL,
    status: pickWeighted([
      { value: CustomerStatus.ACTIVE, weight: 90 },
      { value: CustomerStatus.INACTIVE, weight: 8 },
      { value: CustomerStatus.BLOCKED, weight: 2 },
    ]),
    gstRegistrationType: GstRegistrationType.CONSUMER,
    placeOfSupplyStateCode: s.code,
    billingAddress: randomAddress(s),
    shippingAddresses: [],
    source: pickWeighted([
      { value: CustomerSource.WALK_IN, weight: 60 },
      { value: CustomerSource.REFERRAL, weight: 20 },
      { value: CustomerSource.ONLINE, weight: 15 },
      { value: CustomerSource.CAMPAIGN, weight: 5 },
    ]),
    paymentTerms: PaymentTerms.IMMEDIATE,
    openingBalance: 0,
    discountPercentDefault: 0,
    currency: 'INR',
    tags: randomTags(),
    notes: Math.random() < 0.2 ? faker.lorem.sentence() : undefined,
    birthday:
      Math.random() < 0.4
        ? faker.date.birthdate({ min: 18, max: 70, mode: 'age' })
        : undefined,
    reverseChargeApplicable: false,
    isExempt: false,
    alternatePhones: [],
    alternateEmails: [],
    loyaltyPoints: 0,
    stats: emptyStats(),
    createdBy: USER_ID,
    updatedBy: USER_ID,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  };
};

const buildBusinessRegistered = (now) => {
  const s = pickOne(INDIAN_STATES);
  const legalName = faker.company.name();
  const gstin = randomGstinForState(s.code);
  return {
    name: legalName,
    legalName: legalName.toUpperCase(),
    phone: randomIndianPhone(),
    shop: SHOP_ID,
    email: faker.internet.email({
      firstName: 'accounts',
      lastName: legalName.split(' ')[0],
    }),
    type: CustomerType.BUSINESS,
    status: CustomerStatus.ACTIVE,
    contactPersonName: faker.person.fullName(),
    contactPersonDesignation: pickOne([
      'Purchase Manager',
      'Owner',
      'Accounts Head',
      'Operations Manager',
    ]),
    gstRegistrationType: pickWeighted([
      { value: GstRegistrationType.REGULAR, weight: 85 },
      { value: GstRegistrationType.COMPOSITION, weight: 15 },
    ]),
    gstin,
    pan: gstin.slice(2, 12),
    placeOfSupplyStateCode: s.code,
    billingAddress: randomAddress(s),
    shippingAddresses: [],
    creditLimit: pickOne([50000, 100000, 250000, 500000, 1000000]),
    creditPeriodDays: pickOne([15, 30, 45, 60]),
    paymentTerms: pickWeighted([
      { value: PaymentTerms.NET_15, weight: 20 },
      { value: PaymentTerms.NET_30, weight: 50 },
      { value: PaymentTerms.NET_45, weight: 20 },
      { value: PaymentTerms.NET_60, weight: 10 },
    ]),
    openingBalance:
      Math.random() < 0.3 ? faker.number.int({ min: 0, max: 50000 }) : 0,
    discountPercentDefault: pickOne([0, 2, 5, 7, 10]),
    currency: 'INR',
    source: CustomerSource.REFERRAL,
    tags: randomTags(),
    notes: Math.random() < 0.3 ? faker.company.catchPhrase() : undefined,
    reverseChargeApplicable: false,
    isExempt: false,
    alternatePhones: [],
    alternateEmails: [],
    loyaltyPoints: 0,
    stats: emptyStats(),
    createdBy: USER_ID,
    updatedBy: USER_ID,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  };
};

const buildBusinessUnregistered = (now) => {
  const s = pickOne(INDIAN_STATES);
  const legalName = faker.company.name();
  return {
    name: legalName,
    legalName,
    phone: randomIndianPhone(),
    shop: SHOP_ID,
    email: faker.internet.email(),
    type: CustomerType.BUSINESS,
    status: CustomerStatus.ACTIVE,
    contactPersonName: faker.person.fullName(),
    gstRegistrationType: GstRegistrationType.UNREGISTERED,
    placeOfSupplyStateCode: s.code,
    billingAddress: randomAddress(s),
    shippingAddresses: [],
    paymentTerms: PaymentTerms.IMMEDIATE,
    openingBalance: 0,
    discountPercentDefault: 0,
    currency: 'INR',
    source: pickOne([CustomerSource.WALK_IN, CustomerSource.REFERRAL]),
    tags: randomTags(),
    reverseChargeApplicable: false,
    isExempt: false,
    alternatePhones: [],
    alternateEmails: [],
    loyaltyPoints: 0,
    stats: emptyStats(),
    createdBy: USER_ID,
    updatedBy: USER_ID,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  };
};

// ---- supplier payload builders --------------------------------------------

const SUPPLIER_COMPANY_SUFFIX = [
  'Traders',
  'Industries',
  'Wholesale',
  'Distributors',
  'Manufacturing',
  'Pvt Ltd',
  'Enterprises',
];

const SUPPLIER_TAGS_POOL = [
  'Preferred',
  'Bulk Rate',
  'Local',
  'Imports',
  'Manufacturer',
  'Backup',
];

const randomSupplierTags = () => {
  if (Math.random() < 0.5) return [];
  const count = 1 + Math.floor(Math.random() * 2);
  const picks = new Set();
  while (picks.size < count) picks.add(pickOne(SUPPLIER_TAGS_POOL));
  return [...picks];
};

const buildExternalSupplierShop = (now) => {
  const s = pickOne(INDIAN_STATES);
  const base = faker.company.name().split(' ')[0];
  const name = `${base} ${pickOne(SUPPLIER_COMPANY_SUFFIX)}`;
  const hasGstin = Math.random() < 0.75;
  const gstin = hasGstin ? randomGstinForState(s.code) : undefined;
  return {
    _id: new ObjectId(),
    name,
    kind: ShopKind.EXTERNAL_SUPPLIER,
    location: randomAddress(s),
    phone: randomIndianPhone(),
    email: faker.internet.email({ firstName: 'sales', lastName: base }),
    alternatePhones: [],
    alternateEmails: [],
    contactPersonName: faker.person.fullName(),
    contactPersonDesignation: pickOne([
      'Sales Manager',
      'Owner',
      'Account Manager',
      'Regional Head',
    ]),
    contactPersons: [],
    gstDetails: gstin
      ? {
          gstin,
          legalName: name.toUpperCase(),
          tradeName: name,
          address: `${faker.location.streetAddress()}, ${s.city}`,
          state: s.state,
          registrationDate: faker.date.past({ years: 5 }),
          status: GstStatus.ACTIVE,
          username: faker.internet.userName(),
          email: faker.internet.email(),
          panCardNumber: gstin.slice(2, 12),
        }
      : undefined,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  };
};

const buildInSystemSupplierShop = (now, label) => {
  const s = pickOne(INDIAN_STATES);
  return {
    _id: new ObjectId(),
    name: `${label} Tenant Shop`,
    kind: ShopKind.SELF_OPERATED,
    location: randomAddress(s),
    phone: randomIndianPhone(),
    email: faker.internet.email(),
    alternatePhones: [],
    alternateEmails: [],
    contactPersons: [],
    suppliers: [],
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  };
};

const padSupplierCode = (n) => `SUP/${String(n).padStart(4, '0')}`;

const buildSupplierLink = (supplierShopId, codeNumber, now) => ({
  _id: new ObjectId(),
  supplierShop: supplierShopId,
  supplierCode: padSupplierCode(codeNumber),
  alias: undefined,
  status: pickWeighted([
    { value: SupplierStatus.ACTIVE, weight: 88 },
    { value: SupplierStatus.INACTIVE, weight: 10 },
    { value: SupplierStatus.BLOCKED, weight: 2 },
  ]),
  paymentTerms: pickWeighted([
    { value: PaymentTerms.IMMEDIATE, weight: 20 },
    { value: PaymentTerms.NET_15, weight: 20 },
    { value: PaymentTerms.NET_30, weight: 40 },
    { value: PaymentTerms.NET_45, weight: 15 },
    { value: PaymentTerms.NET_60, weight: 5 },
  ]),
  creditLimit: pickOne([50000, 100000, 250000, 500000]),
  creditPeriodDays: pickOne([15, 30, 45, 60]),
  openingBalance:
    Math.random() < 0.3 ? faker.number.int({ min: 0, max: 100000 }) : 0,
  defaultDiscountPct: pickOne([0, 2, 5, 7, 10]),
  tags: randomSupplierTags(),
  notes: Math.random() < 0.3 ? faker.company.catchPhrase() : undefined,
  primaryContact: undefined,
  stats: {
    totalOrders: 0,
    totalPurchased: 0,
    totalPaid: 0,
    outstandingPayable: 0,
    avgOrderValue: 0,
  },
  addedBy: USER_ID,
  updatedBy: USER_ID,
  isDeleted: false,
  createdAt: now,
  updatedAt: now,
});

// ---- inventory generation -------------------------------------------------

const buildInventoryBatch = (product, now) => {
  const currentQuantity = faker.number.int({ min: 1, max: 100 });
  const purchasePrice = faker.number.int({ min: 50, max: 200 });
  return {
    product: product._id,
    shop: SHOP_ID,
    supplier: SHOP_ID, // demo data uses the shop as its own supplier
    purchasePrice,
    sellPrice: purchasePrice + faker.number.int({ min: 10, max: 50 }),
    currency: 'INR',
    currentQuantity,
    initialQuantity:
      currentQuantity + faker.number.int({ min: 0, max: 100 }),
    measuringUnit: product.measuringUnit,
    invoiceUrl: faker.internet.url(),
    purchasedAt: faker.date.past(),
    createdAt: now,
    updatedAt: now,
  };
};

// ---- runner ----------------------------------------------------------------

async function seed() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  console.log('Connected to MongoDB');
  const db = client.db();

  const existingUser = await db
    .collection('users')
    .findOne({ email: 'admin@sms.com' });
  if (existingUser) {
    console.log('Database already seeded, skipping.');
    await client.close();
    return;
  }

  const now = new Date();

  // 1. shop ------------------------------------------------------------------
  await db.collection('shops').insertOne({
    _id: SHOP_ID,
    name: 'Demo Shop',
    kind: ShopKind.SELF_OPERATED,
    location: {
      address: '123 Market Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: '27',
      country: 'India',
      pinCode: '400001',
    },
    suppliers: [],
    alternatePhones: [],
    alternateEmails: [],
    contactPersons: [],
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  });
  console.log('Created shop: Demo Shop');

  // 2. admin user -----------------------------------------------------------
  const hashedPassword = await bcrypt.hash('Admin@123', 10);
  await db.collection('users').insertOne({
    _id: USER_ID,
    firstName: 'Admin',
    lastName: 'User',
    email: 'admin@sms.com',
    password: hashedPassword,
    shopsMeta: [{ shop: SHOP_ID, roles: ['admin'] }],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  console.log('Created admin user: admin@sms.com / Admin@123');

  // 3. fixture products ------------------------------------------------------
  const productsToInsert = [
    {
      name: 'Steel Pipe 1 inch',
      description: 'High quality steel pipe for plumbing',
      sku: 'SP-001',
      hsn: '7304',
      brand: 'SteelCo',
      keywords: ['steel', 'pipe', 'plumbing'],
      igstRate: 18,
      cgstRate: 9,
      sgstRate: 9,
      stock: 50,
      measuringUnit: 'pcs',
      purchasePrice: 150,
      sellPrice: 200,
    },
    {
      name: 'PVC Pipe 2 inch',
      description: 'Durable PVC pipe for water supply',
      sku: 'PVC-002',
      hsn: '3917',
      brand: 'PipeMaster',
      keywords: ['pvc', 'pipe', 'water'],
      igstRate: 12,
      cgstRate: 6,
      sgstRate: 6,
      stock: 100,
      measuringUnit: 'pcs',
      purchasePrice: 80,
      sellPrice: 120,
    },
    {
      name: 'Copper Wire 1.5mm',
      description: 'Electrical copper wire per kg',
      sku: 'CW-003',
      hsn: '8544',
      brand: 'WireMax',
      keywords: ['copper', 'wire', 'electrical'],
      igstRate: 18,
      cgstRate: 9,
      sgstRate: 9,
      stock: 200,
      measuringUnit: 'kg',
      purchasePrice: 500,
      sellPrice: 650,
    },
    {
      name: 'GI Pipe 3 inch',
      description: 'Galvanized iron pipe for industrial use',
      sku: 'GI-004',
      hsn: '7304',
      brand: 'IronMax',
      keywords: ['gi', 'pipe', 'industrial'],
      igstRate: 18,
      cgstRate: 9,
      sgstRate: 9,
      stock: 30,
      measuringUnit: 'pcs',
      purchasePrice: 400,
      sellPrice: 550,
    },
    {
      name: 'CPVC Pipe 1 inch',
      description: 'Chlorinated PVC pipe for hot water',
      sku: 'CPVC-005',
      hsn: '3917',
      brand: 'FlowPro',
      keywords: ['cpvc', 'pipe', 'hot water'],
      igstRate: 12,
      cgstRate: 6,
      sgstRate: 6,
      stock: 75,
      measuringUnit: 'pcs',
      purchasePrice: 120,
      sellPrice: 180,
    },
  ].map((p) => ({
    ...p,
    shop: SHOP_ID,
    properties: [],
    inventory: [],
    currency: 'INR',
    images: [],
    createdAt: now,
    updatedAt: now,
  }));

  const productInsert = await db
    .collection('products')
    .insertMany(productsToInsert);
  const insertedProducts = productsToInsert.map((p, i) => ({
    ...p,
    _id: productInsert.insertedIds[i],
  }));
  console.log(`Created ${insertedProducts.length} sample products`);

  // 4. inventory batches per product ----------------------------------------
  const inventoriesByProduct = {};
  for (const product of insertedProducts) {
    const count = faker.number.int({ min: INV_MIN, max: INV_MAX });
    const batches = Array.from({ length: count }, () =>
      buildInventoryBatch(product, now),
    );
    if (!batches.length) continue;
    const ins = await db.collection('inventories').insertMany(batches);
    const ids = Object.values(ins.insertedIds);
    inventoriesByProduct[product._id.toString()] = {
      ids,
      addedStock: batches.reduce((sum, b) => sum + b.currentQuantity, 0),
    };
  }

  // Keep product.inventory[] and product.stock consistent with the batches.
  for (const product of insertedProducts) {
    const info = inventoriesByProduct[product._id.toString()];
    if (!info) continue;
    await db.collection('products').updateOne(
      { _id: product._id },
      {
        $set: { updatedAt: now },
        $push: { inventory: { $each: info.ids } },
        $inc: { stock: info.addedStock },
      },
    );
  }
  const totalBatches = Object.values(inventoriesByProduct).reduce(
    (n, x) => n + x.ids.length,
    0,
  );
  console.log(
    `Created ${totalBatches} inventory batches across ${insertedProducts.length} products`,
  );

  // 5. customers ------------------------------------------------------------
  // 60% individual, 30% business with GSTIN, 10% business unregistered.
  const customers = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const builder = pickWeighted([
      { value: buildIndividual, weight: 60 },
      { value: buildBusinessRegistered, weight: 30 },
      { value: buildBusinessUnregistered, weight: 10 },
    ]);
    customers.push({
      ...builder(now),
      customerCode: padCustomerCode(i + 1),
    });
  }

  // Two seeded customers might roll the same random phone — deduplicate
  // before insert so the (shop, phone) unique index doesn't trip.
  const seenPhones = new Set();
  const uniqueCustomers = customers.filter((c) => {
    if (seenPhones.has(c.phone)) return false;
    seenPhones.add(c.phone);
    return true;
  });

  if (uniqueCustomers.length > 0) {
    await db.collection('customers').insertMany(uniqueCustomers);
  }
  console.log(`Created ${uniqueCustomers.length} customers`);

  // 6. customer counter so the next API-created customer continues the run --
  await db.collection('customercounters').updateOne(
    { shop: SHOP_ID },
    {
      $set: {
        shop: SHOP_ID,
        lastNumber: uniqueCustomers.length,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  // 7. suppliers ------------------------------------------------------------
  //   - SUPPLIER_COUNT external supplier Shop docs LINKED to Demo Shop
  //   - DISCOVERY_SUPPLIER_COUNT extra unlinked externals so the
  //     find-supplier picker's suggestions/results rails have data
  //   - 2 SELF_OPERATED "in-system" shops the user can also link
  //   - SupplierCounter primed to the linked count
  const linkedExternals = Array.from(
    { length: SUPPLIER_COUNT },
    () => buildExternalSupplierShop(now),
  );
  const discoveryExternals = Array.from(
    { length: DISCOVERY_SUPPLIER_COUNT },
    () => buildExternalSupplierShop(now),
  );
  const inSystemSupplierShops = [
    buildInSystemSupplierShop(now, 'Bharat'),
    buildInSystemSupplierShop(now, 'Vivek'),
  ];
  const allSupplierShops = [
    ...linkedExternals,
    ...discoveryExternals,
    ...inSystemSupplierShops,
  ];
  if (allSupplierShops.length) {
    await db.collection('shops').insertMany(allSupplierShops);
  }

  // Only the linked externals are pushed onto Demo Shop. Discovery externals
  // and the in-system shops stay floating for the picker to surface.
  const supplierLinks = linkedExternals.map((s, i) =>
    buildSupplierLink(s._id, i + 1, now),
  );
  if (supplierLinks.length) {
    await db.collection('shops').updateOne(
      { _id: SHOP_ID },
      { $push: { suppliers: { $each: supplierLinks } } },
    );
  }
  await db.collection('suppliercounters').updateOne(
    { shop: SHOP_ID },
    {
      $set: {
        shop: SHOP_ID,
        lastNumber: supplierLinks.length,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  console.log(
    `Created ${linkedExternals.length} linked + ${discoveryExternals.length} discoverable external + ` +
      `${inSystemSupplierShops.length} in-system supplier shops; ` +
      `${supplierLinks.length} linked to Demo Shop.`,
  );

  await client.close();
  console.log('\nSeeding complete!');
  console.log(
    'Login credentials -> Email: admin@sms.com | Password: Admin@123',
  );
  console.log('Shop ID: ' + SHOP_ID.toString());
}

seed().catch((err) => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
