const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/shop-management-system';

const SHOP_ID = new ObjectId('000000000000000000000001');
const USER_ID = new ObjectId('000000000000000000000002');

async function seed() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  console.log('Connected to MongoDB');

  const db = client.db();

  const existingUser = await db.collection('users').findOne({ email: 'admin@sms.com' });
  if (existingUser) {
    console.log('Database already seeded, skipping.');
    await client.close();
    return;
  }

  await db.collection('shops').insertOne({
    _id: SHOP_ID,
    name: 'Demo Shop',
    location: {
      address: '123 Market Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      pinCode: '400001',
    },
    suppliers: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log('Created shop: Demo Shop');

  const hashedPassword = await bcrypt.hash('Admin@123', 10);
  await db.collection('users').insertOne({
    _id: USER_ID,
    firstName: 'Admin',
    lastName: 'User',
    email: 'admin@sms.com',
    password: hashedPassword,
    shopsMeta: [{ shop: SHOP_ID, roles: ['admin'] }],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log('Created admin user: admin@sms.com / Admin@123');

  const products = [
    {
      name: 'Steel Pipe 1 inch',
      description: 'High quality steel pipe for plumbing',
      sku: 'SP-001',
      hsn: '7304',
      brand: 'SteelCo',
      shop: SHOP_ID,
      keywords: ['steel', 'pipe', 'plumbing'],
      properties: [],
      igstRate: 18,
      cgstRate: 9,
      sgstRate: 9,
      inventory: [],
      stock: 50,
      measuringUnit: 'pcs',
      purchasePrice: 150,
      sellPrice: 200,
      currency: 'INR',
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'PVC Pipe 2 inch',
      description: 'Durable PVC pipe for water supply',
      sku: 'PVC-002',
      hsn: '3917',
      brand: 'PipeMaster',
      shop: SHOP_ID,
      keywords: ['pvc', 'pipe', 'water'],
      properties: [],
      igstRate: 12,
      cgstRate: 6,
      sgstRate: 6,
      inventory: [],
      stock: 100,
      measuringUnit: 'pcs',
      purchasePrice: 80,
      sellPrice: 120,
      currency: 'INR',
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Copper Wire 1.5mm',
      description: 'Electrical copper wire per kg',
      sku: 'CW-003',
      hsn: '8544',
      brand: 'WireMax',
      shop: SHOP_ID,
      keywords: ['copper', 'wire', 'electrical'],
      properties: [],
      igstRate: 18,
      cgstRate: 9,
      sgstRate: 9,
      inventory: [],
      stock: 200,
      measuringUnit: 'kg',
      purchasePrice: 500,
      sellPrice: 650,
      currency: 'INR',
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'GI Pipe 3 inch',
      description: 'Galvanized iron pipe for industrial use',
      sku: 'GI-004',
      hsn: '7304',
      brand: 'IronMax',
      shop: SHOP_ID,
      keywords: ['gi', 'pipe', 'industrial'],
      properties: [],
      igstRate: 18,
      cgstRate: 9,
      sgstRate: 9,
      inventory: [],
      stock: 30,
      measuringUnit: 'pcs',
      purchasePrice: 400,
      sellPrice: 550,
      currency: 'INR',
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'CPVC Pipe 1 inch',
      description: 'Chlorinated PVC pipe for hot water',
      sku: 'CPVC-005',
      hsn: '3917',
      brand: 'FlowPro',
      shop: SHOP_ID,
      keywords: ['cpvc', 'pipe', 'hot water'],
      properties: [],
      igstRate: 12,
      cgstRate: 6,
      sgstRate: 6,
      inventory: [],
      stock: 75,
      measuringUnit: 'pcs',
      purchasePrice: 120,
      sellPrice: 180,
      currency: 'INR',
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await db.collection('products').insertMany(products);
  console.log(`Created ${products.length} sample products`);

  const customers = [
    {
      name: 'Ramesh Kumar',
      phone: '+919876543210',
      email: 'ramesh.kumar@example.com',
      shop: SHOP_ID,
      billingAddress: {
        address: '45 Gandhi Road',
        city: 'Delhi',
        state: 'Delhi',
        country: 'India',
        pinCode: '110001',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Priya Sharma',
      phone: '+919845123456',
      email: 'priya.sharma@example.com',
      shop: SHOP_ID,
      billingAddress: {
        address: '12 Nehru Street',
        city: 'Bangalore',
        state: 'Karnataka',
        country: 'India',
        pinCode: '560001',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Suresh Patel',
      phone: '+919712345678',
      email: 'suresh.patel@example.com',
      shop: SHOP_ID,
      billingAddress: {
        address: '78 MG Road',
        city: 'Ahmedabad',
        state: 'Gujarat',
        country: 'India',
        pinCode: '380001',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Anjali Mehta',
      phone: '+919987654321',
      email: 'anjali.mehta@example.com',
      shop: SHOP_ID,
      billingAddress: {
        address: '33 Bandra West',
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        pinCode: '400050',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Vikram Singh',
      phone: '+919654321098',
      email: 'vikram.singh@example.com',
      shop: SHOP_ID,
      billingAddress: {
        address: '5 Connaught Place',
        city: 'Jaipur',
        state: 'Rajasthan',
        country: 'India',
        pinCode: '302001',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await db.collection('customers').insertMany(customers);
  console.log(`Created ${customers.length} sample customers`);

  await client.close();
  console.log('\nSeeding complete!');
  console.log('Login credentials -> Email: admin@sms.com | Password: Admin@123');
  console.log('Shop ID: ' + SHOP_ID.toString());
}

seed().catch((err) => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
