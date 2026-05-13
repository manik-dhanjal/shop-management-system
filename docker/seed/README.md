# SMS Bootstrap Seeder

Single-file Node script (`seed.js`) wired into `docker-compose.yml` as the
`seeder` service. Runs **once** on stack startup. Idempotent — if the admin
user already exists, it skips.

## What gets seeded

1. **Demo shop** — `_id: 000000000000000000000001`, located in Mumbai, MH
   (state code `27`).
2. **Admin user** — `admin@sms.com` / `Admin@123`.
3. **5 fixture products** — Steel/PVC/GI/CPVC pipes, copper wire, with
   deterministic SKUs and HSN codes for testing.
4. **50 customers** in a realistic mix:
   - 60% individual (CONSUMER reg, no GSTIN, walk-in/referral)
   - 30% business with `REGULAR`/`COMPOSITION` GSTIN — credit terms,
     contact person, default discount, opening balance
   - 10% business `UNREGISTERED`

   All addresses pull from a pool of 10 Indian states so `state`,
   `stateCode`, `placeOfSupplyStateCode`, and `gstin[0..1]` stay consistent
   per customer. GSTIN/PAN match the validator regex.
5. **CustomerCounter** — set to `lastNumber: 50` (or the de-duplicated
   count) so the next API-created customer continues the run, e.g.
   `CUST/0051`.
6. **Inventory batches** — 2–8 randomized batches per fixture product,
   with `product.stock` + `product.inventory[]` kept in sync.

## Env overrides

| Var | Default | Notes |
|---|---|---|
| `MONGO_URL` | `mongodb://mongodb:27017/shop-management-system` | Connection string |
| `CUSTOMER_COUNT` | `50` | How many demo customers to create |
| `INVENTORY_PER_PRODUCT_MIN` | `2` | Min batches per fixture product |
| `INVENTORY_PER_PRODUCT_MAX` | `8` | Max batches per fixture product |

## Running

You don't run this manually; it fires when you `docker compose up`.

To re-seed from scratch, wipe the MongoDB volume and bring the stack up
again:

```
docker compose down -v
docker compose up --build
```

## Keeping enums in sync

`seed.js` mirrors a handful of string-literal enums from
`backend/src/api/customer/enum/*.enum.ts` (look for `enum literal mirrors`
near the top of the file). If those enums change, update the mirrors and
the customer payload builders accordingly.
