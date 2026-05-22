/* eslint-disable */
/**
 * Location reference data seeder.
 *
 * Seeds countries, states (India GST codes + world ISO), and cities
 * into the locations collections. Safe to re-run — all ops are upserts.
 *
 * Data sources:
 *   countries / world states / world cities — country-state-city npm package
 *   India states   — data/states.json  (GST 2-digit codes, tax metadata)
 *   India country  — data/countries.json (GST/tax regime fields)
 *   World major cities — data/cities-world-major.json (curated list)
 *
 * Usage:
 *   MONGO_URL="mongodb://..." node seed-location.js
 */

const { MongoClient } = require('mongodb');
const { Country: CscCountry, State: CscState, City: CscCity } = require('country-state-city');

const MONGO_URL =
  process.env.MONGO_URL || 'mongodb://localhost:27017/shop-management-system';

const indiaCountryOverride = require('./data/countries.json').find(c => c.code === 'IN');
const indiaGstStates = require('./data/states.json').filter(s => s.countryCode === 'IN');
const worldMajorCities = require('./data/cities-world-major.json');
const indiaMajorPincodes = require('./data/pincodes-in-major.json');

// Build ISO state-code → GST code map for India by matching names
function buildIsoToGstMap() {
  const isoStates = CscState.getStatesOfCountry('IN');
  const map = {};
  for (const iso of isoStates) {
    const gst = indiaGstStates.find(
      g => g.name.toLowerCase() === iso.name.toLowerCase(),
    );
    if (gst) map[iso.isoCode] = gst.code;
  }
  return map;
}

async function seedLocation() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  console.log('Connected to MongoDB');
  const db = client.db();

  // ── Countries ──────────────────────────────────────────────────────────────
  const cscCountries = CscCountry.getAllCountries();
  const countryOps = cscCountries.map(c => {
    const isIndia = c.isoCode === 'IN';
    const set = isIndia && indiaCountryOverride
      ? { ...indiaCountryOverride, updatedAt: new Date() }
      : {
          code: c.isoCode,
          name: c.name,
          dialCode: c.phonecode ? `+${c.phonecode}` : undefined,
          currency: c.currency,
          hasStates: true,
          hasGstin: false,
          sortOrder: 999,
          taxRegime: 'NONE',
          updatedAt: new Date(),
        };
    return {
      updateOne: {
        filter: { code: c.isoCode },
        update: { $set: set, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    };
  });

  await db.collection('countries').bulkWrite(countryOps, { ordered: false });
  console.log(`Countries: ${cscCountries.length} upserted`);

  // ── States ─────────────────────────────────────────────────────────────────
  // Non-India: ISO codes from package
  const cscStates = CscState.getAllStates();
  const nonIndiaStates = cscStates.filter(s => s.countryCode !== 'IN');

  const stateOps = nonIndiaStates.map(s => ({
    updateOne: {
      filter: { countryCode: s.countryCode, code: s.isoCode },
      update: {
        $set: {
          name: s.name,
          type: 'State',
          isUnionTerritory: false,
          professionalTaxApplicable: false,
          compositionAllowed: true,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          countryCode: s.countryCode,
          code: s.isoCode,
          createdAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  // India: GST codes (2-digit) with tax metadata — never overwritten by ISO
  const indiaStateOps = indiaGstStates.map(s => ({
    updateOne: {
      filter: { countryCode: 'IN', code: s.code },
      update: {
        $set: {
          name: s.name,
          type: s.type || 'State',
          isUnionTerritory: s.isUnionTerritory || false,
          ...(s.gstZone && { gstZone: s.gstZone }),
          ...(s.eWayBillIntraThreshold && { eWayBillIntraThreshold: s.eWayBillIntraThreshold }),
          professionalTaxApplicable: s.professionalTaxApplicable || false,
          compositionAllowed: s.compositionAllowed !== false,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          countryCode: 'IN',
          code: s.code,
          createdAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await db.collection('states').bulkWrite([...stateOps, ...indiaStateOps], { ordered: false });
  console.log(`States: ${nonIndiaStates.length} world ISO + ${indiaGstStates.length} India GST = ${nonIndiaStates.length + indiaGstStates.length} upserted`);

  // ── Cities ─────────────────────────────────────────────────────────────────
  const isoToGst = buildIsoToGstMap();
  const isoIndiaStates = CscState.getStatesOfCountry('IN');

  // India cities — all from package, remapped to GST state codes
  let indiaCityOps = [];
  for (const isoState of isoIndiaStates) {
    const gstCode = isoToGst[isoState.isoCode];
    if (!gstCode) continue;
    const cities = CscCity.getCitiesOfState('IN', isoState.isoCode);
    for (const c of cities) {
      indiaCityOps.push({
        updateOne: {
          filter: { countryCode: 'IN', stateCode: gstCode, name: c.name },
          update: {
            $set: { type: 'city', isMajor: false, isSez: false, updatedAt: new Date() },
            $setOnInsert: {
              countryCode: 'IN',
              stateCode: gstCode,
              name: c.name,
              pincodes: [],
              createdAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }
    // flush in batches to avoid memory pressure
    if (indiaCityOps.length >= 500) {
      await db.collection('cities').bulkWrite(indiaCityOps, { ordered: false });
      indiaCityOps = [];
    }
  }
  if (indiaCityOps.length) {
    await db.collection('cities').bulkWrite(indiaCityOps, { ordered: false });
  }
  console.log(`India cities: ~${isoIndiaStates.reduce((n, s) => n + CscCity.getCitiesOfState('IN', s.isoCode).length, 0)} upserted`);

  // World major cities (non-India) from curated JSON
  const worldCityOps = worldMajorCities
    .filter(c => c.countryCode !== 'IN')
    .map(c => ({
      updateOne: {
        filter: { countryCode: c.countryCode, stateCode: c.stateCode, name: c.name },
        update: {
          $set: {
            type: c.type || 'city',
            isMajor: c.isMajor !== false,
            ...(c.population && { population: c.population }),
            isSez: false,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            countryCode: c.countryCode,
            stateCode: c.stateCode,
            name: c.name,
            pincodes: [],
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

  if (worldCityOps.length) {
    await db.collection('cities').bulkWrite(worldCityOps, { ordered: false });
  }
  console.log(`World major cities: ${worldCityOps.length} upserted`);

  // ── India Pincodes ─────────────────────────────────────────────────────────
  // Populate pincodes into the matching city documents (best-effort, case-insensitive).
  // Grouped by stateCode+city so we can use a single $addToSet per city.
  const pincodeByCityKey = new Map();
  for (const p of indiaMajorPincodes) {
    const key = `${p.stateCode}|${p.city.toLowerCase()}`;
    if (!pincodeByCityKey.has(key)) pincodeByCityKey.set(key, { stateCode: p.stateCode, city: p.city, pincodes: [] });
    pincodeByCityKey.get(key).pincodes.push({ code: p.pincode, officeType: p.officeType });
  }

  let pincodeHits = 0;
  for (const { stateCode, city, pincodes } of pincodeByCityKey.values()) {
    const result = await db.collection('cities').updateOne(
      {
        countryCode: 'IN',
        stateCode,
        name: { $regex: new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') },
      },
      { $addToSet: { pincodes: { $each: pincodes } } },
    );
    if (result.matchedCount) pincodeHits++;
  }
  console.log(`India pincodes: ${indiaMajorPincodes.length} entries applied to ${pincodeHits}/${pincodeByCityKey.size} cities`);

  // ── Indexes ────────────────────────────────────────────────────────────────
  await db.collection('countries').createIndex({ code: 1 }, { unique: true, background: true });
  await db.collection('countries').createIndex({ sortOrder: 1, name: 1 }, { background: true });
  await db.collection('states').createIndex({ countryCode: 1, code: 1 }, { unique: true, background: true });
  await db.collection('states').createIndex({ countryCode: 1, name: 1 }, { background: true });
  await db.collection('cities').createIndex({ countryCode: 1, stateCode: 1, isMajor: -1, population: -1 }, { background: true });
  await db.collection('cities').createIndex({ countryCode: 1, stateCode: 1, name: 'text' }, { background: true });
  await db.collection('cities').createIndex({ countryCode: 1, 'pincodes.code': 1 }, { background: true });
  console.log('Indexes ensured');

  await client.close();
  console.log('\nLocation seeding complete!');
}

seedLocation().catch(err => {
  console.error('Location seeding failed:', err.message);
  process.exit(1);
});
