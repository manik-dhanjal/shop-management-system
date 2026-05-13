# Seeder — Feature Reference

End-to-end reference for the SMS bootstrap seeder: what it inserts, when
it runs, idempotency rules, env knobs, and how its data shapes line up
with the runtime schemas. Read this **first** whenever asked to extend the
seeder, debug seeded data, or wire new demo data into the stack.

---

## 1. What it is

Single Node script at `docker/seed/seed.js`. Wired into
`docker-compose.yml` as the `seeder` service. Runs **once** on stack
startup, against MongoDB directly (no HTTP — bypasses the API).

**Idempotent**: checks for `users.email === "admin@sms.com"` before doing
anything. If that doc exists, the script bails immediately. To re-seed,
wipe the volume:

```
docker compose down -v
docker compose up --build
```

---

## 2. What it seeds

| # | Collection | What |
|---|---|---|
| 1 | `shops` | One demo shop `_id: 000000000000000000000001`, Mumbai/MH, state code `27`. |
| 2 | `users` | Admin user `admin@sms.com` / `Admin@123`, bcrypt-hashed, `shopsMeta: [{ shop, roles: ['admin'] }]`. |
| 3 | `products` | 5 fixture products — pipes + copper wire — with deterministic SKUs (`SP-001`, `PVC-002`, `CW-003`, `GI-004`, `CPVC-005`) and HSN codes. Each product carries CGST/SGST/IGST rates and a `measuringUnit`. |
| 4 | `inventories` | 2–8 randomized batches per fixture product. Each batch has `purchasePrice`, `sellPrice`, `currentQuantity`, `initialQuantity`, `supplier` (= the shop itself for demo data), `measuringUnit`, `invoiceUrl`, `purchasedAt`. |
| 5 | `products` (update) | After batch insert, each product's `inventory[]` is `$push`-ed with the new ids and `stock` is `$inc`-d by the sum of `currentQuantity`s — keeps both in sync with the batches. |
| 6 | `customers` | 50 demo customers in a weighted mix (see §3). |
| 7 | `customercounters` | `{ shop, lastNumber }` upserted so the next API-created customer continues the run (default `CUST/0051`). |

`createdBy` and `updatedBy` on every customer point to the admin `_id`.

---

## 3. Customer mix

Drawn by `pickWeighted([...])` per iteration:

| Weight | Builder | Shape highlights |
|---|---|---|
| 60% | `buildIndividual` | `type: INDIVIDUAL`, `gstRegistrationType: CONSUMER`, optional email/notes/birthday, `paymentTerms: IMMEDIATE`, status weighted 90/8/2 active/inactive/blocked. |
| 30% | `buildBusinessRegistered` | `type: BUSINESS`, `REGULAR` or `COMPOSITION` GST (85/15), valid 15-char GSTIN matching the shop's state code, PAN auto-derived from GSTIN slice, contact person + designation, credit limit / period, NET_15…NET_60 terms (weighted), default discount, sometimes opening balance. |
| 10% | `buildBusinessUnregistered` | `type: BUSINESS`, `UNREGISTERED`, contact person, no GSTIN, IMMEDIATE terms. |

**State pool** (10 entries) keeps `billingAddress.state`,
`billingAddress.stateCode`, `placeOfSupplyStateCode`, and `gstin[0..1]`
all aligned for a single seeded customer:

```
07/Delhi, 08/Rajasthan, 09/Uttar Pradesh, 19/West Bengal, 24/Gujarat,
27/Maharashtra, 29/Karnataka, 32/Kerala, 33/Tamil Nadu, 36/Telangana
```

**Tags pool**: `VIP`, `Wholesaler`, `Retailer`, `Distributor`, `Frequent
Buyer`, `New`, `On Hold`. Each customer gets 0–2 tags (60% chance of ≥1).

**GSTIN format generator**: `randomGstinForState(stateCode)` produces
`<stateCode> + <PAN: 5 letters + 4 digits + 1 letter> + <entity 1-9A-Z> + Z + <check>`.
Always 15 chars; passes the backend's GSTIN regex.

**Phone format**: `+91` + 10 digits starting 6–9.

**Phone-collision guard**: faker may roll duplicate phones across two
customers within the same shop. Before insert, customers are dedup'd by
`phone` so the `(shop, phone)` unique index doesn't trip. The
`CustomerCounter.lastNumber` is set to the **deduplicated** count.

---

## 4. Env overrides

| Var | Default | Notes |
|---|---|---|
| `MONGO_URL` | `mongodb://mongodb:27017/shop-management-system` | Connection string |
| `CUSTOMER_COUNT` | `50` | How many customers to create (before dedup) |
| `INVENTORY_PER_PRODUCT_MIN` | `2` | Min batches per product |
| `INVENTORY_PER_PRODUCT_MAX` | `8` | Max batches per product |

All env values are parsed once at script load. Override at compose-up
time:

```
CUSTOMER_COUNT=10 docker compose up --build seeder
```

---

## 5. Data shape contract

Customer documents written by the seeder match the runtime Mongoose
schema (`backend/src/api/customer/schema/customer.schema.ts`) field-for-
field, including:

- `customerCode: "CUST/NNNN"`
- empty `stats` subdoc — `OrderService.onOrderCreated` is responsible for
  bumping these as orders flow in.
- `isDeleted: false`, `alternatePhones: []`, `alternateEmails: []`,
  `shippingAddresses: []`, `loyaltyPoints: 0`, `reverseChargeApplicable:
  false`, `isExempt: false` — so list filters that key off these fields
  don't see `undefined`.
- For `BUSINESS REGULAR/COMPOSITION` rows the seeder pre-fills `pan` and
  `placeOfSupplyStateCode`. The backend `enrichDerivedFields()` would have
  done that on a real POST, but the seeder writes to Mongo directly so
  must do it itself.

Inventory documents match `backend/src/api/inventory/schema/inventory.schema.ts`.
Note: `supplier` is set to the **shop's own _id** for demo purposes (the
schema only types it as a Shop ObjectId; using the shop itself is
acceptable for a single-shop dev environment).

---

## 6. Enum literal mirrors

`seed.js` inlines string-literal copies of:

- `CustomerType` — `INDIVIDUAL | BUSINESS`
- `CustomerStatus` — `ACTIVE | INACTIVE | BLOCKED`
- `GstRegistrationType` — `REGULAR | COMPOSITION | UNREGISTERED | CONSUMER`
  (SEZ + EXPORT not emitted by the seeder yet)
- `PaymentTerms` — `IMMEDIATE | NET_15 | NET_30 | NET_45 | NET_60`
- `CustomerSource` — `WALK_IN | REFERRAL | ONLINE | CAMPAIGN | EXISTING`

If the corresponding backend enums change, update the mirrors at the top
of `seed.js` and the payload builders accordingly. They are deliberately
inlined (not imported) so the seeder stays a self-contained CommonJS
file with no TypeScript toolchain — Docker image stays small.

---

## 7. Container image

`docker/seed/Dockerfile`:
```
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY seed.js ./
CMD ["node", "seed.js"]
```

Runtime deps (`docker/seed/package.json`):
- `mongodb` — driver
- `bcryptjs` — admin password hashing
- `@faker-js/faker` — realistic demo data

No dev deps, no TypeScript, no transpile step.

---

## 8. History

The seeder used to be split:

- `docker/seed/seed.js` — bootstrap (admin + 5 customers + 5 products)
- `backend/src/scripts/seed-customers.ts` — API-driven bulk customers
- `backend/src/scripts/seed-products.ts` — API-driven inventory batches

These were merged into `seed.js` in a single pass. The two TS scripts
needed an auth token, a host-side TypeScript toolchain, and weren't
useful in a fresh stack-up because they ran outside Docker. The merged
seeder produces the same data shapes natively and runs automatically.

---

## 9. Caveats & follow-ups

1. **Random GSTINs do not pass an authoritative check digit.** The check
   character at position 15 is generated randomly. Backend regex accepts
   them, but the GST portal would reject them on submission. Don't use
   seeded GSTINs to test real e-invoice/IRN integration.
2. **No orders or payments are seeded.** Customer `stats` stays at zero
   defaults; KPIs on the all-customers page show `0` until an order is
   created in the UI. If you need seeded orders for analytics work, add a
   step 7 to `seed.js`.
3. **`Customer.shippingAddress` (legacy single-address field) is not
   populated** — only `shippingAddresses[]` (empty). The customer form
   handles both shapes.
4. **`supplier === shop`** on every inventory batch. Fine for demo, but
   tests that exercise multi-supplier flows need a second shop seeded.
5. **`MeasuringUnit` on inventory** copies the product's unit. The
   customer-side schema permits divergence but the seeder doesn't
   exercise that path.
6. **Soft-deleted customers** aren't created. All seeded customers have
   `isDeleted: false`. To test the deleted-row exclude logic, soft-delete
   one manually after seeding.
7. **Re-running the seeder requires `down -v`.** There's no `--force`
   flag. If you need to add a single new fixture without nuking the DB,
   write a one-off Mongo shell script instead.

---

## 10. File map

```
docker/seed/
├── Dockerfile          plain `npm install`, runs `node seed.js`
├── README.md           short user-facing summary
├── package.json        mongodb + bcryptjs + @faker-js/faker
└── seed.js             single-file seeder, ~500 lines

docker-compose.yml      wires the `seeder` service with depends_on mongodb
```

Related runtime schemas the seeder must stay aligned with:
- `backend/src/api/customer/schema/customer.schema.ts` (+ `customer-counter.schema.ts`, `customer-stats.schema.ts`)
- `backend/src/api/customer/enum/*.enum.ts`
- `backend/src/api/products/schema/product.schema.ts`
- `backend/src/api/inventory/schema/inventory.schema.ts`
- `backend/src/shared/schema/location.schema.ts` (`stateCode`, `addressLine2`)
