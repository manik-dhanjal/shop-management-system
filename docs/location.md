# Location — Feature Plan

End-to-end plan for a backend-driven **location reference data** system
(countries, states, cities, pincodes) that:

1. Powers Country / State / City / Pincode dropdowns across every form
   (shop, customer, supplier, order shipping).
2. Validates pincodes and reverse-fills city/state.
3. Carries enough metadata to drive a future **GST automation** feature
   (place of supply, UTGST vs SGST, e-way bill thresholds, SEZ flags,
   jurisdiction officer).
4. Links every Shop / Customer / Supplier / Order address by **ObjectId
   reference** to the canonical location records — not just denormalized
   strings — so jurisdiction-aware lookups never need fuzzy matching.

Status: **planning** — no code written. Read this before starting any
implementation work.

---

## 1. Goals

- Replace free-text state/city inputs with searchable, validated dropdowns.
- Cover **all** Indian places (~155k cities + villages) plus top ~5k world cities.
- Provide pincode → city/state reverse lookup for India (~600k pincodes).
- Store **both** ObjectId refs (for jurisdiction queries) and denormalized
  names (for back-compat and fast reads) on every entity address.
- Pre-seed all GST-relevant metadata now so the future GST module never
  needs a 160k-doc migration.
- Soft validation only — forms still submit if the user types an unknown
  city.

## 2. Non-goals (v1)

- Street-level autocomplete (Google Places-style).
- i18n of city/state names.
- Admin UI for editing location data (managed via seed + redeploy).
- Live GST portal integration (separate future module).
- Tax-rate / HSN-code storage on location (belongs in the GST module).

---

## 3. Data scope

| Scope | What | Approx count |
|---|---|---|
| Countries | All ISO 3166-1 | ~250 |
| States | Sub-divisions for ~30 countries | ~3,500 |
| Cities — **India** | **All cities, towns, villages** with a pincode | ~155,000 |
| Cities — **Rest of world** | Top cities by population (`isMajor=true`) | ~5,000 |
| Pincodes — India | India Post directory mapped onto city docs | ~600,000 mappings |

**Total city docs: ~160k. Storage: ~70 MB with indexes.** Fits Atlas M0
(512 MB) with room to spare.

---

## 4. Collections

### 4.1 `countries`

```ts
{
  _id: ObjectId,
  code: string,           // "IN" — ISO 3166-1 alpha-2, unique
  name: string,           // "India"
  dialCode: string,       // "+91"
  currency: string,       // "INR"
  hasStates: boolean,
  hasGstin: boolean,      // drives GSTIN auto-fill UI
  sortOrder: number,      // India = 0 (pinned first)
  pincodeRegex: string,   // "^\\d{6}$" for India

  // GST/tax metadata (Phase 1 — dormant until GST module ships)
  taxRegime: "GST" | "VAT" | "SALES_TAX" | "NONE",
  gstinRegex?: string,
  gstinExample?: string,
  fiscalYear: { startMonth: number; startDay: number },  // India = 4/1
  taxSlabs?: number[],                  // [0, 5, 12, 18, 28]
  registrationThreshold?: number,       // ₹40L goods / ₹20L services
  compositionThreshold?: number,        // ₹1.5Cr
  eInvoiceThreshold?: number,           // ₹5Cr
  filingPortalUrl?: string,             // "https://gst.gov.in"
}
```

### 4.2 `states`

```ts
{
  _id: ObjectId,
  countryCode: string,    // "IN" — indexed
  code: string,           // "27" — GST state code (or ISO 3166-2)
  name: string,
  type: string,           // "State" | "Union Territory" | "Province"

  // GST metadata (Phase 1)
  isUnionTerritory: boolean,            // ⚠ drives UTGST vs SGST
  gstZone?: "NORTH" | "SOUTH" | "EAST" | "WEST" | "NE" | "CENTRAL",
  eWayBillIntraThreshold?: number,      // e.g. Delhi ₹100,000
  professionalTaxApplicable?: boolean,
  professionalTaxSlabs?: Array<{ minMonthlyIncome: number; tax: number }>,
  taxPortalUrl?: string,
  compositionAllowed: boolean,
}
```

Compound unique index: `{ countryCode: 1, code: 1 }`.

### 4.3 `cities`

```ts
{
  _id: ObjectId,
  countryCode: string,    // "IN" — indexed
  stateCode: string,      // "27" — indexed
  name: string,           // "Mumbai"

  // Pincode array now carries per-pincode metadata
  pincodes: Array<{
    code: string,                 // "400001"
    isSezPincode?: boolean,       // overrides city.isSez when set
    officeType?: "HO" | "SO" | "BO",
  }>,

  isMajor: boolean,       // top 5k world cities or large Indian cities
  type: "city" | "town" | "village" | "metro",
  population?: number,

  // GST metadata (Phase 1)
  isSez: boolean,                       // Special Economic Zone
  sezName?: string,                     // e.g. "SEEPZ"
  gstCommissionerate?: string,
  gstDivision?: string,
  gstRange?: string,
}
```

Indexes:
- `{ countryCode: 1, stateCode: 1, isMajor: -1, population: -1 }` — default city list
- `{ countryCode: 1, stateCode: 1, name: "text" }` — search across 155k India docs
- `{ countryCode: 1, "pincodes.code": 1 }` — pincode reverse lookup

---

## 5. Data sources & seeding

| File | Source | Size (gz) |
|---|---|---|
| `countries.json` | hand-curated + ISO list | ~30 KB |
| `states.json` | `dr5hn/countries-states-cities-database` (MIT) | ~200 KB |
| `cities-world-major.json` | `simplemaps.com/data/world-cities` (free) | ~1 MB |
| `cities-in.json.gz` | data.gov.in pincode directory | ~6 MB gz |
| `pincodes-in.json.gz` | India Post (merged into cities at seed time) | ~4 MB gz |
| `sez-in.json` | Ministry of Commerce SEZ list | < 50 KB |
| `gst-jurisdictions-in.json` | CBIC commissionerate directory | ~200 KB |

All files committed under `docker/seed/data/` (gzipped where useful).
Seed runs from existing `docker/seed/seed.js`:

- Idempotent upserts keyed by `(countryCode, code)` for states / `(countryCode, stateCode, name)` for cities.
- Streamed gunzip + bulk inserts in batches of 5,000.
- First run: 30–60s. Re-run: ~5s (content-hash skip).

---

## 6. Backend API

New module `backend/src/api/location/`.

Base path: `/api/v1/location`. All endpoints `@SkipAuth()` (reference data, no PII).
ETag + `Cache-Control: public, max-age=86400, immutable`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/countries` | All countries, ~30 KB |
| GET | `/countries/:code/states` | States for a country |
| GET | `/countries/:code/states/:stateCode/cities?q=&limit=50` | Top 50 major by default; with `?q=` runs text search |
| GET | `/countries/:code/pincode/:pincode` | Reverse lookup → `{ city, state, isSez, officeType }` or 404 |
| GET | `/countries/:code/cities/:cityId/pincodes` | Full pincode list for a city (rarely needed) |

### 6.1 Caching

- Countries + states: loaded fully into memory on boot (~250 KB combined).
- Cities: LRU cache keyed by `(countryCode, stateCode, q || "default")`, capped at 500 entries (~5 MB RAM).
- Pincode lookups: LRU of last 1,000 (~50 KB).

The cities endpoint **never returns more than 50** — frontend search drives narrowing.

---

## 7. Frontend

### 7.1 API + hooks

```
shared/api/location.api.ts
features/location/hooks/
  use-countries.hook.ts                                          // 1 call / session
  use-states-by-country.hook.ts(countryCode?)
  use-cities-by-state.hook.ts(countryCode?, stateCode?, query?)  // 300ms debounce
  use-pincode-lookup.hook.ts(countryCode?, pincode?)             // on blur
```

TanStack Query with long `staleTime` (24h). City search debounced 300ms.

### 7.2 Components (`shared/components/form/`)

- `StateSelectControlled` — searchable MUI Autocomplete, disabled until country chosen.
- `CitySelectControlled` — backend-driven search; `freeSolo` so user can type unknown cities.
- `PincodeFieldControlled` — format + membership + reverse-lookup.

All three: spinner in end-adornment while loading; soft fallback to plain TextField on network error.

### 7.3 Cascade behavior

```
Country ▾  →  State ▾  →  City ▾  →  Pincode [____]
                              ↑              │
                              └── reverse-fills via /pincode/:p (India only)
```

- Country change → clears state, city, pincode.
- State change → clears city, pincode.
- City change → keeps pincode if still valid; else clears.

### 7.4 Pincode validation — three soft layers

| Layer | Trigger | Result |
|---|---|---|
| Format | onChange | Red helper if `country.pincodeRegex` fails |
| Membership | onBlur + city selected | Yellow warning if not in `city.pincodes[].code` |
| Reverse lookup | onBlur + city empty | Auto-fill city/state if found |

All non-blocking — form still submits.

---

## 8. Entity schema changes (`Location` subdoc)

The shared `Location` schema at `backend/src/shared/schema/location.schema.ts`
is used by **Shop**, **Customer.billingAddress / shippingAddresses[]**,
**Supplier**, **Order shipping** — anywhere an address lives.

### 8.1 New shape (hybrid: refs + denormalized names)

```ts
@Schema({ _id: false })
export class Location {
  address: string;
  addressLine2?: string;
  pinCode: string;

  // Denormalized — kept for fast reads, back-compat, free-text fallback
  country: string;          // "India"
  state: string;            // "Maharashtra"
  stateCode?: string;       // "27" — kept for GSTIN linkage
  city: string;             // "Mumbai"

  // 🆕 References — null when user typed an unknown place
  countryRef?: ObjectId;    // → countries._id
  stateRef?: ObjectId;      // → states._id
  cityRef?: ObjectId;       // → cities._id
}
```

**Why hybrid:**

- **Refs** unlock jurisdiction-aware lookups (SEZ flag, UTGST, e-way thresholds) without ever fuzzy-matching strings.
- **Denormalized names** keep existing code working (any `loc.city` read still returns a string), and let users type addresses we don't have records for (rare hamlets, addresses outside India, typos).
- A `null` ref is **expected and fine** — it just means GST automation has to fall back to manual entry for that record.

### 8.2 Entities that need updating

| Schema | Field(s) |
|---|---|
| `Shop.location` | already uses shared `Location` — automatic |
| `Customer.billingAddress` | already uses shared `Location` |
| `Customer.shippingAddresses[]` | already uses shared `Location` |
| `Supplier.address` | already uses shared `Location` |
| `Order.shippingAddress` (if present) | already uses shared `Location` |

**The change is one file** (`shared/schema/location.schema.ts`) + corresponding DTO (`shared/dto/location.dto.ts`). Every consumer inherits the new refs automatically.

### 8.3 Form write contract

When the user picks from a dropdown:
- `stateRef` ← `selectedState._id`, `state` ← `selectedState.name`, `stateCode` ← `selectedState.code`
- `cityRef` ← `selectedCity._id`, `city` ← `selectedCity.name`
- `countryRef` ← `selectedCountry._id`, `country` ← `selectedCountry.name`

When the user free-types a city not in our list:
- `cityRef = null`, `city = "<typed value>"`
- Other refs still set (they came from dropdowns).

### 8.4 Read contract

- Display layer: use the denormalized strings (`location.city`, `location.state`, …) — no joins, no API trips.
- GST / jurisdiction layer: use the refs and populate against `cities` / `states` / `countries` to read `isSez`, `isUnionTerritory`, `eWayBillIntraThreshold`, etc.

---

## 9. Migration of existing data

Existing Shop / Customer / Supplier docs have **string-only** locations. To
populate refs without breaking anything:

1. **Migration script** under `backend/src/scripts/backfill-location-refs.ts`:
   - Iterate every collection with a `Location` subdoc.
   - For each: lookup country by name → set `countryRef`; lookup state by `(countryCode, name)` → set `stateRef`; lookup city by `(countryCode, stateCode, name)` (case-insensitive) → set `cityRef`.
   - Leave any unmatched ref as `null`. Log unmatched counts per collection.
2. **One-shot**: run after Phase 1 seed completes. Idempotent — safe to re-run after seed refreshes.
3. **Backfill report**: print `{ shop: { total, matched, unmatched }, ... }` so we can spot data-quality issues.

No data loss possible — strings remain untouched.

---

## 10. GST automation prep — how location data feeds the future module

The GST module (separate, future) will consume location refs to make place-of-supply decisions:

```
supplier = populate(shop.location.stateRef, "states")
buyer    = populate(customer.billingAddress.stateRef, "states")
buyerCity = populate(customer.billingAddress.cityRef, "cities")
pincodeInfo = lookupPincode(customer.billingAddress.pinCode)

if buyerCity?.isSez || pincodeInfo?.isSezPincode:
    → zero-rated supply, IGST shown but refundable
elif supplier._id === buyer._id:
    → if buyer.isUnionTerritory: CGST + UTGST
    → else:                      CGST + SGST
else:
    → IGST

if invoiceAmount > supplier.eWayBillIntraThreshold:
    → flag for e-way bill generation
```

Everything reads from the location collections — no hardcoded state maps,
no scattered SEZ pincode lists.

### Related collections (NOT location)

These belong to a future `gst` module — don't conflate with location data:

| Collection | Purpose |
|---|---|
| `hsnCodes` | HSN/SAC → applicable slab + description |
| `taxSlabs` | Slab rates + effective date ranges (rates change over time) |
| `gstReturns` | Filed returns tracking per shop per period |
| `gstNotifications` | Council notifications affecting rates |
| `placeOfSupplyRules` | Sec 10–13 IGST Act rules (code, not DB) |

---

## 11. Storage footprint

| Collection | Docs | Avg size | Total (with indexes) |
|---|---|---|---|
| countries | 250 | 250 B | < 1 MB |
| states | 3,500 | 200 B | ~1 MB |
| cities | 160,000 | ~400 B (incl. pincode array + GST jurisdiction) | **~70 MB** |

Atlas M0 quota: 512 MB. Headroom remains.

---

## 12. Performance budget

| Action | Target |
|---|---|
| Initial countries load | < 100 ms |
| States dropdown open | < 100 ms |
| City dropdown open (top 50) | < 150 ms |
| City search keystroke (debounced) | < 250 ms |
| Pincode reverse lookup | < 100 ms |

Escalation path if budgets blow under load: precompute `india-cities.json.gz`
served from CDN for direct client search, or move reference data into Redis.

---

## 13. Edge cases

1. **Unknown city** — user types something not in our DB. `cityRef = null`, `city = "<typed>"`. GST automation falls back gracefully.
2. **Duplicate city names within a state** — disambiguated in dropdown label by district / parent area, else by pincode prefix.
3. **PO Box / military APO** (India 9xxxxx) — included as synthetic "Army Postal Service" city so pincode lookup doesn't 404.
4. **District splits / boundary changes** — annual seed refresh handles drift.
5. **Mixed SEZ cities** (Mumbai has SEEPZ + regular zones) — `pincodes[].isSezPincode` overrides `city.isSez`.
6. **Inter-UT vs intra-UT supplies** — Delhi → Chandigarh is interstate (IGST). Chandigarh → Chandigarh is intra-UT (CGST + UTGST). The `state.isUnionTerritory` flag is what makes this decision.
7. **Multi-GSTIN persons** — a shop owner may have multiple GSTINs in different states; `Shop.gstDetails` is per-shop, so this works.

---

## 14. Phased delivery

| Phase | Scope | Effort |
|---|---|---|
| **1. Backend foundation** | Schemas (with full GST fields from day one), gzipped seed files, location module, 5 endpoints, in-mem + LRU caches | large |
| **2. Frontend primitives** | `location.api.ts`, 4 hooks, `StateSelectControlled` + `CitySelectControlled` + `PincodeFieldControlled` | medium |
| **3. `Location` schema migration** | Add `countryRef` / `stateRef` / `cityRef` to shared `Location` schema + DTO; write backfill script | small |
| **4. Shop form integration** | Wire components into `shop-edit-form`; remove `STATE_CODE_MAP`; GSTIN auto-fills country=IN + state name + ref | small |
| **5. Customer + supplier forms** | Copy-paste pass into `customer-form` / `supplier-form` | small |
| **6. (Optional)** | Replace static `CountrySelectControlled` with backend-driven version | tiny |
| **7. (Future)** | Build `gst` module that consumes the refs — no schema changes needed | separate plan |

Phases 1 + 2 are independent and can run in parallel.
Phase 3's backfill must run **after** Phase 1's seed is loaded.

---

## 15. File map (target)

Backend
```
backend/src/api/location/
├── location.module.ts
├── location.controller.ts          — 5 endpoints
├── location.service.ts             — text-search + LRU cache
├── location.repository.ts
├── schema/
│   ├── country.schema.ts
│   ├── state.schema.ts
│   └── city.schema.ts
├── dto/
│   ├── country.dto.ts
│   ├── state.dto.ts
│   └── city.dto.ts
└── seed/
    └── load-location-data.ts       — seed-time loader

backend/src/shared/schema/location.schema.ts   — ⚠ add 3 ref fields
backend/src/shared/dto/location.dto.ts         — ⚠ add 3 ref fields

backend/src/scripts/
└── backfill-location-refs.ts       — one-shot migration
```

Frontend
```
frontend/src/shared/api/location.api.ts
frontend/src/features/location/
├── hooks/
│   ├── use-countries.hook.ts
│   ├── use-states-by-country.hook.ts
│   ├── use-cities-by-state.hook.ts
│   └── use-pincode-lookup.hook.ts
└── interface/location.interface.ts

frontend/src/shared/components/form/
├── state-select-controlled.component.tsx
├── city-select-controlled.component.tsx
└── pincode-field-controlled.component.tsx     — replaces plain TextField for pincode
```

Seed
```
docker/seed/data/
├── countries.json
├── states.json
├── cities-world-major.json
├── cities-in.json.gz
├── pincodes-in.json.gz
├── sez-in.json
└── gst-jurisdictions-in.json
```

---

## 16. Caveats / known follow-ups

1. **World cities limited to top 5k** — anything smaller, user types free-text.
2. **No i18n** — names stored in English.
3. **No admin UI** — managed by seed + redeploy.
4. **Pincode validation is soft** — never blocks form submit.
5. **GST fields dormant** until the GST module ships — they're carried in the seed and schemas but unused by current UI.
6. **`countryRef` is technically redundant** with the existing `country` string (since country dropdown options are already static) — included for consistency and to support future country-level jurisdiction queries.

---

## 17. Open questions before kickoff

Locked in:
- ✅ All Indian cities + villages, top 5k world cities
- ✅ Hybrid storage: refs + denormalized names
- ✅ Soft pincode validation (warning, not block)
- ✅ Pincode reverse-fills city/state when empty
- ✅ GST metadata fields seeded from Phase 1

Still open:
1. **Seed file commit strategy** — gzipped in repo (~10 MB total) vs downloaded on first seed run?
2. **Backfill aggressiveness** — case-insensitive name match only, or include fuzzy match (Levenshtein) for "Mumabi" → "Mumbai" typos?
3. **GST jurisdiction seed (commissionerate/division/range)** — scrape now or leave nullable until GST module needs it?
4. **Replace `CountrySelectControlled` in Phase 1** or defer to Phase 6?

Once these are settled, Phase 1 can start.
