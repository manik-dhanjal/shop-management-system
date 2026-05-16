# Customer — Feature Reference

End-to-end reference for the Customer CRUD + analytics scaffolding: data
model, GST/compliance rationale, backend endpoints, frontend wiring, seeder,
and known caveats. Read this **first** whenever asked to work on customer,
CRM, customer-stats, or GST-customer code.

---

## 1. What this feature does

Lets a shop user manage their customer master:

- **List**: KPI strip + searchable/filterable table at `/dashboard/customer/all`.
- **Detail**: full customer profile + tabbed Overview / Orders view at
  `/dashboard/customer/:id`.
- **Create**: sectioned form at `/dashboard/customer/add` with auto-filled
  customer code and GSTIN-derived PAN/state code.
- **Edit**: same form at `/dashboard/customer/:id/edit`.
- **Delete**: soft-delete by default (preserves invoice history); hard-delete
  only when the customer has zero orders **and** zero outstanding balance.

Indian GST is a first-class concern — customer schema captures everything
needed for Tax Invoice headers, GSTR-1 classification (B2B / B2CL / B2CS /
SEZ / Export), and e-invoice/e-way-bill payloads.

---

## 2. Backend data model

All schemas live under `backend/src/api/customer/schema/`.

### `Customer` (`customer.schema.ts`)

Grouped by purpose:

#### Identity

```
customerCode    String   auto: CUST/NNNN per shop
name            String   display
legalName       String?  must match GSTIN registry for Tax Invoice
type            enum     INDIVIDUAL | BUSINESS                  default INDIVIDUAL
status          enum     ACTIVE | INACTIVE | BLOCKED            default ACTIVE
```

#### Contact

```
phone               String   primary (E.164)
alternatePhones     String[]                  repeater UI in form
email               String?
alternateEmails     String[]                  repeater UI in form
contactPersonName       String?   BUSINESS only — primary contact
contactPersonDesignation String?
contactPersons      Array<{                   additional contacts (BUSINESS)
  name, designation?, phone?, email?
}>
profileImage        ObjectId → MediaMetadata
```

#### GST & tax

```
gstRegistrationType  enum     REGULAR | COMPOSITION | UNREGISTERED |
                              CONSUMER | SEZ_WITH_PAYMENT | SEZ_WITHOUT_PAYMENT |
                              OVERSEAS_EXPORT                 default CONSUMER
gstin                String?  validated regex
pan                  String?  validated regex; auto-derived from gstin[2..12]
placeOfSupplyStateCode String? 2-digit; auto-derived from gstin[0..1]
taxInvoicePreference   String? "Tax Invoice" / "Bill of Supply" default at order time
reverseChargeApplicable Boolean
isExempt               Boolean
```

#### Addresses

```
billingAddress              Location?
shippingAddresses           Location[]   (multi-location B2B)
defaultShippingAddressIndex Number?
shippingAddress             Location?    legacy single-address (kept for B/W compat)
```

`Location` (shared, `backend/src/shared/schema/location.schema.ts`) now has
optional `addressLine2` and **`stateCode`** (2-digit Indian GST code) in
addition to the original `address`, `country`, `state`, `city`, `pinCode`.

#### Business terms

```
creditLimit            Number   ₹, default 0
creditPeriodDays       Number
paymentTerms           enum     IMMEDIATE | NET_7 | NET_15 | NET_30 | NET_45 | NET_60 | CUSTOM
openingBalance         Number   ₹ — carried over from before the system
discountPercentDefault Number
currency               String   default "INR"
```

#### CRM

```
tags                String[]
notes               String?
birthday            Date?
anniversary         Date?
source              enum     WALK_IN | REFERRAL | ONLINE | CAMPAIGN | EXISTING
referredByCustomerId ObjectId → Customer
loyaltyPoints       Number
```

#### Denormalized stats (recomputed by `OrderService` hook)

```
stats: {
  totalOrders        Number
  totalBilled        Number   ₹ lifetime
  totalPaid          Number
  outstandingBalance Number   openingBalance + billed − paid
  firstOrderAt       Date?
  lastOrderAt        Date?
  avgOrderValue      Number
}
```

#### Tenant + audit

```
shop        ObjectId → Shop  (required)
createdBy   ObjectId → User
updatedBy   ObjectId → User
isDeleted   Boolean   default false
deletedAt   Date?
deletedBy   ObjectId → User
createdAt / updatedAt  (mongoose timestamps)
```

### Indexes

```
{ shop, phone }           unique
{ shop, gstin }           unique sparse (only when gstin is a string)
{ shop, customerCode }    unique sparse
{ shop, isDeleted, status }     list-filter
{ shop, "stats.lastOrderAt" -1 } churn-risk sort
{ shop, "stats.totalBilled" -1 } top-customer sort
```

### `CustomerCounter` (`customer-counter.schema.ts`) — top-level

```
shop        ObjectId → Shop  (unique)
lastNumber  Number
```

Drives `CUST/NNNN` codes via atomic `findOneAndUpdate(upsert, $inc)` —
analog of `InvoiceCounter` in the order feature.

---

## 3. Backend services & endpoints

Controller: `backend/src/api/customer/customer.controller.ts`, base path
`shop/:shopId/customer`.

| Method | Path           | Purpose                                                                                                                                           |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/`            | Create; auto-assigns `customerCode`, audits `createdBy`. Enforces unique phone per shop.                                                          |
| PUT    | `/`            | Upsert by phone (used by the in-modal quick-add on the order page).                                                                               |
| GET    | `/code/next`   | **Peek** the next `CUST/NNNN` for the Add form preview. Does not increment.                                                                       |
| GET    | `/stats`       | Shop-wide KPI rollup `{ totalCustomers, activeCustomers, withGstin, totalOutstanding }`. Single aggregation, used by the All Customers KPI cards. |
| GET    | `/:customerId` | Single customer, populated `profileImage`. Excludes soft-deleted.                                                                                 |
| PATCH  | `/:customerId` | Update; audits `updatedBy`. Errors `NotFound` if soft-deleted.                                                                                    |
| POST   | `/paginated`   | Paginated list + fuzzy search. Accepts `filter` (e.g. `{ status, type }`) and `includeDeleted` flag.                                              |
| DELETE | `/:customerId` | Soft-delete by default; hard-delete iff `totalOrders === 0 && outstandingBalance === 0`. Audits `deletedBy`.                                      |

### Key services

- **`CustomerService.createCustomer(shopId, dto, user)`**
  - Asserts phone uniqueness within shop.
  - `enrichDerivedFields()` fills in `pan` and `placeOfSupplyStateCode` from
    GSTIN when not supplied.
  - Normalizes optional contact fields such as `email` and `gstin` so blank
    values do not fail validation. This allows customer creation when either
    email or GSTIN is omitted.
  - `customerCode` from `CustomerCodeService.generate()` if not supplied.
  - `createdBy`, `updatedBy` set from `@CurrentUser()`.

- **`CustomerService.deleteCustomer(shopId, customerId, user)`**
  - Reads stats; if zero orders + zero outstanding → hard delete; otherwise
    sets `isDeleted: true`, `deletedAt`, `deletedBy`.

- **`CustomerService.onOrderCreated(customerId, billed, paid, orderDate)`**
  - Called from `OrderService.createOrder` after successful insert.
  - Best-effort (wrapped in try/catch — order is the source of truth; stats
    can be recomputed offline if this hook ever fails).
  - Increments `totalOrders`, sums `totalBilled` + `totalPaid`, recomputes
    `outstandingBalance` (uses customer's `openingBalance`), updates
    `firstOrderAt` / `lastOrderAt`, recomputes `avgOrderValue`.

- **`CustomerCodeService`** (`customer-code.service.ts`)
  - `generate(shopId)` → atomic `$inc + upsert`
  - `peek(shopId)` → read-only

- **`CustomerService.getShopCustomerStats(shopId)`**
  - Single `$match` + `$group` aggregation scoped to `{ shop, isDeleted: { $ne: true } }`.
  - Returns `totalCustomers`, `activeCustomers` (`status === ACTIVE`), `withGstin`
    (`$type 'string'` on `gstin`), `totalOutstanding`
    (`$sum $ifNull stats.outstandingBalance, 0`).
  - Designed to stay O(1) requests regardless of list pagination state — the
    All Customers KPI cards no longer depend on the visible page.

### DTO validation highlights

- `IsEnum` on each enum.
- GSTIN regex `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Z]{1}[0-9A-Z]{1}$`
- PAN regex `^[A-Z]{5}[0-9]{4}[A-Z]{1}$`
- `placeOfSupplyStateCode` must be 2 digits.
- All numeric "could be zero" fields use `@Min(0)`.

---

## 4. Shop-level isolation

- Every customer has `shop: ObjectId` (required).
- Every service query filters by `shop: <activeShop._id>`.
- **Composite unique indexes** on `(shop, phone)`, `(shop, gstin)`,
  `(shop, customerCode)` — same phone/GSTIN/code can co-exist across shops
  but never within one.
- The cross-shop order guard (`OrderService.createOrder`) still validates
  `dto.shop === shopId`. There's an open follow-up to also verify
  `customer.shop === order.shop` at order create time.

---

## 5. Analytics & GST data flow

Four data sources today:

1. **Stored on Customer (cheap reads, denormalized)** — `stats.*`. Powers
   the detail-page stat strip without aggregating orders on every request.
2. **Shop-wide rollup** — `GET /customer/stats` (single aggregation).
   Powers the All Customers KPI cards. O(1) regardless of pagination.
3. **Derived from orders on demand** — the Orders tab on the detail page
   reuses `useGetPaginatedOrders(20, 1, { customer: id })` for that
   customer's history.
4. **Future analytics endpoints** (not shipped) — RFM scores, cohorts,
   state-wise revenue, aging buckets, top-N by revenue, churn signals.

### GST filing data — what's stored & why

| Filing artefact                           | Field(s) consulted                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Tax Invoice header                        | `legalName`, `gstin`, `billingAddress` (with `stateCode`), `placeOfSupplyStateCode` |
| GSTR-1 B2B (Table 4)                      | `gstin`, supplier vs. recipient state codes                                         |
| GSTR-1 B2CL (Table 5, inter-state >₹2.5L) | `billingAddress.stateCode`                                                          |
| GSTR-1 Exports (6A/6B)                    | `gstRegistrationType: OVERSEAS_EXPORT/SEZ_*`                                        |
| E-invoice / IRN                           | Buyer GSTIN, legal name, full address with state code, pin                          |
| E-way bill                                | full address + PAN + GSTIN + pin                                                    |

`enrichDerivedFields()` and the form's `useEffect` on `gstin` keep
`pan`/`placeOfSupplyStateCode` consistent automatically.

---

## 6. Frontend architecture

### Page shells

| Route                                  | File                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard/customer/all`              | `pages/dashboard/customer/all-customer.page.tsx`    | Shop-wide KPI strip (driven by `/stats`), debounced server-side search (400 ms), server-side `status` / `type` filters, table with status / churn badges, row-click → detail, delete confirmation that reads live stats. Loading affordances: spinner inside the search input while pending/refetching, KPI skeleton pulses while stats load, thin `LinearProgress` over the table during background refetches. |
| `/dashboard/customer/:customerId`      | `pages/dashboard/customer/customer-detail.page.tsx` | Header with badges & KPIs; tabs `Overview` (contact / GST / addresses / terms / dates cards) and `Orders` (paginated, filtered by customer).                                                                                                                                                                                                                                                                    |
| `/dashboard/customer/add`              | `pages/dashboard/customer/add-customer.page.tsx`    | Wraps `<CustomerForm>`; on success → detail page.                                                                                                                                                                                                                                                                                                                                                               |
| `/dashboard/customer/:customerId/edit` | `pages/dashboard/customer/edit-customer.page.tsx`   | Loads existing customer, flattens populated `profileImage` to id before feeding form.                                                                                                                                                                                                                                                                                                                           |

### Components (`features/customer/components/`)

- `customer-form.component.tsx` — single sectioned form used by Add, Edit,
  and the in-modal quick-add on the order page. Sections:
  Identity → Contact → GST & Tax → Billing Address → Shipping Address →
  Business Terms → Notes & Dates. Each section is a `FormContainer`.
  - **GSTIN auto-derive**: a `useWatch` on `gstin` validates against the
    regex and, on full match, sets `pan = gstin[2..12]` and
    `placeOfSupplyStateCode = gstin[0..1]`.
  - **Type-aware fields**: primary contact person + designation render only
    for `type === BUSINESS`.
  - **Auto customer code**: `usePreviewCustomerCode` fills in on a fresh
    form (skipped during edit because `initialCustomerData.customerCode`
    is already set).
  - **Contact repeaters** (powered by `useFieldArray`):
    - **Alternate Phone Numbers** — add/remove `PhoneFieldControlled` rows.
    - **Alternate Emails** — add/remove email rows.
    - **Additional Contact Persons** (BUSINESS only) — card-per-row with
      `name`, `designation`, `phone`, `email`. Sits under the primary
      `contactPersonName`/`contactPersonDesignation` pair.
  - **`compact` prop** — used by the in-order quick-add modal:
    - Identity & Contact stay expanded; GST, Billing, Shipping, Business
      Terms, Notes are wrapped as `collapsible defaultOpen={false}`.
    - Grids tighten: 3-col → 2-col, 2-col → 1-col (so labels like
      "Display Name"/"INDIVIDUAL" don't truncate at modal width).
    - Submit button row becomes `sticky bottom-0` with a matching modal
      background + top border so "Save Customer" is always visible.
- `customer-select.component.tsx` — the order-page customer dropdown,
  MUI-outlined styled (covered in `docs/add-order.md`).
- `customer-select-modal.component.tsx` — wraps `CustomerForm` (in
  `compact` mode) in a modal for quick-add during order creation; uses the
  PUT `/customer` upsert. Each tab owns its own scroll container — search
  list scrolls inside its own `h-[55vh]` viewport, add-form is wrapped in
  a `max-h-[70vh] overflow-y-auto` div — so only one scrollbar shows.
  Modal is `max-w-[720px]`.
- `searchable-list-customer.component.tsx` — fuzzy-search list inside the
  modal. Internal `InfiniteScroll` keyed to a scrollable `h-[55vh]` div.

### Hooks (`features/customer/hooks/`)

- `use-add-customer.hook.ts` — POST `/customer`. Invalidates paginated.
- `use-update-customer.hook.ts` — PATCH `/customer/:id`.
- `use-delete-customer.hook.ts` — DELETE; removes single-cache + invalidates list.
- `use-get-customer.hook.ts` — GET single, populated.
- `use-get-paginated-customers.hook.ts` — POST `/paginated`. Signature:
  `(limit, page, search?, sort?, filter?)`. The All Customers page passes
  `filter: { status, type }` so dropdown filters hit the server, not the
  current page.
- `use-customer-stats.hook.ts` — GET `/stats`. Powers the shop-wide KPI
  cards on All Customers.
- `use-put-customer.hook.ts` — PUT upsert by phone.
- `use-preview-customer-code.hook.ts` — GET `/code/next`, peeks next code.

Shared:

- `shared/hooks/use-debounced-value.hook.ts` — generic
  `useDebouncedValue(value, delay)` used by All Customers' search box
  (400 ms).

### Shared enums (`frontend/src/shared/enums/`)

`customer-type.enum.ts`, `customer-status.enum.ts`,
`gst-registration-type.enum.ts` (with `GstRegistrationTypeLabel`),
`payment-terms.enum.ts` (with `PaymentTermsLabel`),
`customer-source.enum.ts` (with `CustomerSourceLabel`).

All match the backend enums byte-for-byte; the `Label` records are for
dropdown display only.

### Form types

```ts
// features/customer/interface/customer.interface.ts
interface ContactPerson {
  name: string;
  designation?: string;
  phone?: string;
  email?: string;
}
interface Customer {
  _id, customerCode, name, legalName, type, status,
  phone, alternatePhones[], email, alternateEmails[],
  contactPersonName, contactPersonDesignation,
  contactPersons[]: ContactPerson,
  profileImage,
  gstRegistrationType, gstin, pan, placeOfSupplyStateCode,
  taxInvoicePreference, reverseChargeApplicable, isExempt,
  billingAddress, shippingAddresses[], defaultShippingAddressIndex,
  shippingAddress,                  // legacy
  creditLimit, creditPeriodDays, paymentTerms,
  openingBalance, discountPercentDefault, currency,
  tags[], notes, birthday, anniversary, source,
  referredByCustomerId, loyaltyPoints,
  stats: CustomerStats,
  shop, createdBy, updatedBy,
  isDeleted, deletedAt,
  createdAt, updatedAt,
}
interface CustomerPopulated extends Omit<Customer, "profileImage"> {
  profileImage?: Image
}
interface AddCustomer extends Omit<
  Customer,
  "_id" | "createdAt" | "updatedAt" | "shop" | "stats" | "isDeleted"
> {}
interface CustomerFormTypes extends AddCustomer {}
```

---

## 7. UI sketches

### All Customers

```
┌─ Header                                         [Add Customer]  ─┐
├─ KPIs ──────────────────────────────────────────────────────────┤
│ Total Customers │ Active (page) │ Outstanding (page) │ w/ GSTIN │
├─ Filter bar ────────────────────────────────────────────────────┤
│  search…                Status▾   Type▾                          │
├─ Table ─────────────────────────────────────────────────────────┤
│ Code   Name (legal)   Phone   GSTIN/State  Orders  Lifetime  Out  Last │ Status │ ⋯
└──────────────────────────────────────────────────────────────────┘
```

- Last-order chip color: green ≤30d, amber ≤90d, red >90d.
- Outstanding > 0 → red highlight.
- Row click → detail; trash icon → delete modal that reads stats.

### Customer Detail

```
┌─ ← Back to customers
┌─ Header card ───────────────────────────────────────────────────┐
│ Sharma Traders  CUST/0042  [ACTIVE]  [GSTIN 27XXXX]  [VIP]      │
│ Sharma Traders Private Limited                                  │
│ +91 98xxxxx12 · sharma@traders.com           [Edit] [Delete]    │
│ ── stats ── Lifetime  Orders  Avg.Order  Outstanding ──         │
└─────────────────────────────────────────────────────────────────┘
[ Overview ] [ Orders (18) ]
├─ Contact ────────────┐  ├─ GST & Tax ─────────┐
├─ Billing Address ────┤  ├─ Shipping Address ──┤
├─ Business Terms ─────┤  ├─ Notes & Dates ─────┤
```

---

## 8. Seeder

`backend/src/scripts/seed-customers.ts` — populates a target shop with a
realistic mix:

- 60 % `INDIVIDUAL` (CONSUMER reg, walk-in/referral, no GSTIN)
- 30 % `BUSINESS` with `REGULAR`/`COMPOSITION` GSTIN, credit terms, contact
  person, default discount, opening balance
- 10 % `BUSINESS` `UNREGISTERED`

Indian state pool ties `billingAddress.state` + `stateCode` +
`placeOfSupplyStateCode` + `gstin[0..1]` together. Phone is `+91` + 10 digits
starting 6–9. GSTIN/PAN match the validator regex.

Run:

```
SHOP_ID=… TOKEN=… npx ts-node -r tsconfig-paths/register \
  src/scripts/seed-customers.ts
```

(or edit the `SHOP_ID` / `TOKEN` constants at the top of the file).

---

## 9. Caveats & known follow-ups

1. **Edit page casts `data` to `any` when flattening `profileImage`.**
   `Customer.customer` type doesn't model the populated variant well.
   Worth a proper `CustomerPopulated`/`OrderPopulated` interface pass.
2. **Order ↔ customer cross-shop check is not yet enforced** at order
   create. Today we trust the controller's `shopId` path-param + DTO's
   `dto.shop === shopId` check. Add `customer.shop === order.shop`
   validation before persisting.
3. **`stats` is updated only by `OrderService.createOrder`** — not by
   payments-recorded-separately, voids, or refunds. There's no payment
   subsystem yet; when one ships, hook it the same way.
4. **Outstanding balance** for the seeded `openingBalance` is included in
   `stats.outstandingBalance` after the **first order is created**, not
   on seed alone (stats subdoc is otherwise zeros for fresh customers).
5. ~~Shop-wide KPIs on the all-customers page are computed from the
   visible page only.~~ **Done** — `GET /customer/stats` powers the KPI
   cards with real shop-wide totals. Stats query is unfiltered by
   search/filter; if per-filter rollups are ever needed, extend the
   endpoint to accept the same `filter` / `search` shape as `/paginated`.
6. **GSTIN lookup against the GST portal** is not wired. `GstModule`
   clients exist in the backend; hooking them into a form button to
   auto-fill `legalName`/`billingAddress`/`status` is a separate task.
7. **Detail page does not show a Ledger or Analytics tab yet.** Stubbed in
   the plan but not implemented.
8. **Bulk import / export (CSV/XLSX), bulk tagging, deactivate-all** —
   listed in plan Phase 5, not shipped.
9. **No reverse-charge / exempt tax UX yet** — flags exist on the schema
   and form, but the order pricing util doesn't read them. Future task.
10. **`alternatePhones` / `alternateEmails` / `contactPersons`** are now
    editable in the form via `useFieldArray` repeaters (under Contact).
    **Multi-shipping addresses** (`shippingAddresses[]` +
    `defaultShippingAddressIndex`) are still single-edit only — repeater
    UI for that is the remaining piece.

---

## 10. File map (quick jump)

Backend

```
backend/src/api/customer/
├── customer.controller.ts          — REST surface
├── customer.service.ts             — CRUD + stats hook + GSTIN derive
├── customer.module.ts              — wires Mongoose models
├── customer.repository.ts          — CoreRepository<CustomerDocument>
├── customer-code.service.ts        — CUST/NNNN generator
├── repository/
│   └── customer-counter.repository.ts
├── dto/
│   ├── create-customer.dto.ts      — full-fat DTO with all sections
│   ├── update-customer.dto.ts      — PartialType(CreateCustomerDto)
│   └── paginated-customer-query.dto.ts  — search + includeDeleted
├── enum/
│   ├── customer-type.enum.ts
│   ├── customer-status.enum.ts
│   ├── gst-registration-type.enum.ts
│   ├── payment-terms.enum.ts
│   └── customer-source.enum.ts
└── schema/
    ├── customer.schema.ts          — main schema + indexes
    ├── customer-counter.schema.ts
    └── customer-stats.schema.ts    — embedded stats subdoc

backend/src/shared/schema/location.schema.ts
  └── Location.addressLine2 + Location.stateCode (added)

backend/src/scripts/seed-customers.ts
  └── shop-targeted seeder with INDIAN_STATES + GSTIN generator
```

Frontend

```
frontend/src/features/customer/
├── components/
│   ├── customer-form.component.tsx        — sectioned create/edit form
│   ├── customer-select.component.tsx      — MUI-outlined dropdown
│   ├── customer-select-modal.component.tsx
│   └── searchable-list-customer.component.tsx
├── hooks/
│   ├── use-add-customer.hook.ts
│   ├── use-update-customer.hook.ts
│   ├── use-delete-customer.hook.ts
│   ├── use-get-customer.hook.ts
│   ├── use-get-paginated-customers.hook.ts  — (limit, page, search, sort, filter)
│   ├── use-customer-stats.hook.ts          — shop-wide KPI rollup
│   ├── use-put-customer.hook.ts
│   └── use-preview-customer-code.hook.ts
└── interface/
    └── customer.interface.ts              — Customer / Populated / AddCustomer / FormTypes / Stats / ContactPerson

frontend/src/shared/hooks/use-debounced-value.hook.ts
  └── generic useDebouncedValue(value, delay)

frontend/src/pages/dashboard/customer/
├── all-customer.page.tsx        — list + KPIs + filters
├── customer-detail.page.tsx     — header + tabs (Overview / Orders)
├── add-customer.page.tsx        — wraps CustomerForm
└── edit-customer.page.tsx       — loads + flattens + wraps CustomerForm

frontend/src/shared/enums/
├── customer-type.enum.ts
├── customer-status.enum.ts
├── gst-registration-type.enum.ts
├── payment-terms.enum.ts
└── customer-source.enum.ts

frontend/src/shared/interfaces/location.interface.ts
  └── addressLine2 + stateCode (added)

frontend/src/shared/api/customer.api.ts   — REST client
```

---

## 11. Phase status snapshot

| Phase | Description                                                                                                                              | Status      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1     | Schema + counter + indexes + DTO validation                                                                                              | ✅ shipped  |
| 2     | Stats hook + endpoints + list/detail/add/edit/delete pages + seeder                                                                      | ✅ shipped  |
| 2b    | Shop-wide stats endpoint, debounced server-side search + filters, alt-phones / alt-emails / contactPersons repeaters, compact modal form | ✅ shipped  |
| 3     | Ledger tab, analytics charts, additional stats endpoints (cohorts/RFM)                                                                   | 🔲 deferred |
| 4     | GSTIN portal lookup (proxy to `GstModule`)                                                                                               | 🔲 deferred |
| 5     | CSV import/export, bulk actions, multi-currency UX, multi-shipping-address UI                                                            | 🔲 deferred |

Test plan when revisiting:

- Add → form auto-fills code; GSTIN entry auto-fills PAN/state code; submit → detail page.
- Order create → customer `stats` increments in DB.
- Soft-delete an empty customer → row disappears from list; check DB shows `isDeleted`.
- Hard-delete (no orders) → row physically gone.
- Two shops + same phone → both accepted (per-shop unique). Same shop + same phone → 409.
