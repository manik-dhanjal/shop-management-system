# Supplier — Feature Reference

End-to-end reference for the Supplier CRUD + linkage feature: data model,
storage choice, backend endpoints, frontend wiring, seeder, and known
caveats. Read this **first** whenever asked to work on supplier, purchase,
or supplier-shop code.

---

## 1. What this feature does

Lets a shop user manage the suppliers it buys from:

- **List**: KPI strip + searchable/filterable table at `/dashboard/supplier/all`.
- **Detail**: supplier profile + tabbed Overview / Purchases view at
  `/dashboard/supplier/:supplierId`.
- **Create**: two-tab Add page at `/dashboard/supplier/add` — *Create New
  Supplier* (full sectioned form) or *Link Existing Shop* (search and pick
  an in-system shop).
- **Edit**: `/dashboard/supplier/:supplierId/edit`. For in-system linked
  shops only the relationship metadata is editable (the supplier's Shop
  doc is owned by its own tenant).
- **Delete**: soft-unlink by default; hard-unlink (and cascade-delete the
  external supplier Shop, only if no other shop references it) when the
  link has zero purchases and zero payable.

A supplier **is itself a Shop document**. The buying shop tracks the
relationship as a subdoc inside its own `suppliers[]` array.

---

## 2. Storage model — *why this shape*

Two design constraints drove the shape:

1. A supplier might also be a shop owner on this platform (`SELF_OPERATED`
   Shop doc) or a pure outside party (`EXTERNAL_SUPPLIER` shell). We
   want one collection so both can be linked, searched, and (eventually)
   billed using the same identity.
2. The buyer needs per-relationship metadata (alias, payment terms, credit
   limit, opening balance, notes, stats) that doesn't make sense to mutate
   on a supplier shop owned by someone else.

So:

- **Identity** (name, address, GST, contact persons) lives on the
  supplier's `Shop` document.
- **Relationship** (the buyer's view: terms, opening balance, stats, ...)
  is a `SupplierLink` subdoc in `Shop.suppliers[]` on the **buying** shop.

That keeps everything in the `shops` collection per the product
direction. Cross-shop reverse lookup ("who buys from X?") is one
`{ 'suppliers.supplierShop': X }` query.

---

## 3. Backend data model

### `Shop` additions (`backend/src/api/shop/schema/shop.schema.ts`)

```
kind                ShopKind   SELF_OPERATED | EXTERNAL_SUPPLIER  default SELF_OPERATED
phone, email, alternatePhones[], alternateEmails[]
contactPersonName, contactPersonDesignation
contactPersons[]    { name, designation?, phone?, email? }
suppliers           SupplierLink[]    one-to-many → other shops (subdoc array)
isDeleted, deletedAt
```

Indexes:
```
{ "suppliers.supplierShop": 1 }     reverse lookup
{ "suppliers.supplierCode": 1 }     in-doc dedup helper (uniqueness checked in service)
{ kind: 1 }
```

### `SupplierLink` subdoc (`backend/src/api/supplier/schema/supplier-link.schema.ts`)

```
supplierShop        ObjectId → Shop   (required, indexed; uses string ref 'Shop'
                                       to dodge a circular import with Shop schema)
supplierCode        String            SUP/NNNN — auto per buying shop
alias?              String            override display label
status              ACTIVE | INACTIVE | BLOCKED            default ACTIVE
paymentTerms        IMMEDIATE | NET_* | CUSTOM             default IMMEDIATE
creditLimit, creditPeriodDays, openingBalance, defaultDiscountPct
tags[], notes?, primaryContact?: { name, phone, email }
stats: SupplierStats
addedBy, updatedBy, deletedBy        ObjectId → User
isDeleted, deletedAt
createdAt, updatedAt                 (mongoose timestamps)
```

`SupplierStats` (denormalized read-side counters) mirrors `CustomerStats`:
```
totalOrders, totalPurchased, totalPaid, outstandingPayable,
firstPurchaseAt?, lastPurchaseAt?, avgOrderValue
```
> The hook that maintains these (`SupplierService.onPurchaseRecorded`) is
> wired in advance; nothing calls it yet — it'll be invoked by the future
> PO/GRN module.

### `SupplierCounter` (`supplier/schema/supplier-counter.schema.ts`)

```
shop        ObjectId → Shop  (unique)
lastNumber  Number
```
Drives `SUP/NNNN` codes via atomic `findOneAndUpdate(upsert, $inc)` — same
pattern as `CustomerCounter` / `InvoiceCounter`.

---

## 4. Backend services & endpoints

Controller: `backend/src/api/supplier/supplier.controller.ts`, base path
`shop/:shopId/supplier`.

| Method | Path | Purpose |
|---|---|---|
| POST   | `/`                       | Add a supplier. Body must include **exactly one** of `supplierShopId` (link existing) or `newShop` (create EXTERNAL_SUPPLIER Shop and link atomically). |
| GET    | `/code/next`              | Peek next `SUP/NNNN` for the Add form. |
| GET    | `/stats`                  | Shop-wide rollup `{ totalSuppliers, activeSuppliers, withGstin, totalPayable }`. Single aggregation. |
| GET    | `/lookup/shops?q=&limit=` | Search Shop docs not yet linked to this buyer (excluding the buyer itself). Powers "Link existing shop". |
| GET    | `/:supplierId`            | One supplier (link subdoc) with the supplier's Shop doc populated. |
| POST   | `/paginated`              | Paginated list with `search` and `filter: { status, kind }`. Aggregation joins each link with its supplier Shop. |
| PATCH  | `/:supplierId`            | Update **link metadata** (alias, terms, tags, notes, status, stats fields). |
| PATCH  | `/:supplierId/shop`       | Update the supplier's underlying **Shop fields** (name, address, GST, contact). Allowed only when `supplier.shop.kind === EXTERNAL_SUPPLIER`. |
| DELETE | `/:supplierId`            | Soft-unlink (preserve purchase history). Hard-unlink iff `totalOrders === 0 && outstandingPayable === 0`; cascade-deletes the supplier Shop only if it's `EXTERNAL_SUPPLIER` AND no other shop references it. |

### Key services

- **`SupplierService.createSupplier(shopId, dto, user)`**
  - XOR check on `supplierShopId` vs `newShop`.
  - `newShop` path inserts a `kind: EXTERNAL_SUPPLIER` Shop, then links.
  - Refuses to add the same supplier twice (active links only).
  - Auto-assigns `supplierCode` if not supplied.
  - Stamps `addedBy`/`updatedBy` from `@CurrentUser()`.

- **`SupplierService.updateSupplier(shopId, supplierId, dto, user)`**
  - Patches link fields via positional `$set` on `suppliers.$.…`.

- **`SupplierService.updateSupplierShop(shopId, supplierId, dto)`**
  - Mutates the populated Shop doc. Refuses if `kind !== EXTERNAL_SUPPLIER`.

- **`SupplierService.deleteSupplier(shopId, supplierId, user)`**
  - Reads stats. If zero orders + zero payable: `$pull` the link; if the
    target was `EXTERNAL_SUPPLIER` AND no other shop references it,
    hard-delete the Shop doc too. Otherwise soft-delete the link.

- **`SupplierService.onPurchaseRecorded(buyingShopId, supplierShopId, billed, paid, date)`**
  - Stats hook for the future PO module. Wired in advance so PO doesn't
    have to refactor this surface.

- **`SupplierService.lookupShops(shopId, q, limit?)`**
  - Excludes the buyer and any already-linked supplier shops; case-insensitive
    name/phone/GSTIN/legalName regex.

- **`SupplierCodeService`**
  - `generate(shopId)` — atomic `$inc + upsert` on `suppliercounters`.
  - `peek(shopId)` — read-only preview.

### Repository

- **`SupplierRepository`** wraps the `Shop` model with three aggregations:
  - `getPaginatedSuppliers` — `$unwind suppliers` → `$lookup shops` → search
    + status + kind filter → facet with skip/limit.
  - `getShopSupplierStats` — same unwind+lookup, group with conditional
    sums for the KPI cards.
  - `lookupShops` — find/limit on unlinked shops.

---

## 5. Shop-level isolation

- Every supplier link is **a subdoc of the buying Shop** — no cross-shop
  link can be read without `shopId` in the URL.
- The supplier Shop doc is global (in `shops`), but only the buyer that
  has it in `suppliers[]` sees it on its list / detail.
- `updateSupplierShop` further guards by `kind === EXTERNAL_SUPPLIER` so
  buyers can't mutate other tenants' shops.

---

## 6. Frontend architecture

### Page shells

| Route | File | Notes |
|---|---|---|
| `/dashboard/supplier/all` | `pages/dashboard/supplier/all-supplier.page.tsx` | Shop-wide KPI strip (`/stats`), debounced server search (400 ms), server-side `status` + `kind` filters, table with `LINKED` badge for in-system shops, churn/status chips, delete confirmation that reads live stats. Loading affordances: search-input spinner, KPI skeleton bars, `LinearProgress` on background refetches. |
| `/dashboard/supplier/add` | `pages/dashboard/supplier/add-supplier.page.tsx` | Two tabs: **Create New Supplier** (full `SupplierForm`) and **Link Existing Shop** (`LinkExistingShop` picker → confirmation strip → `SupplierForm` in `linkMetadataOnly` mode). |
| `/dashboard/supplier/:supplierId` | `pages/dashboard/supplier/supplier-detail.page.tsx` | Header card with badges (status, GSTIN, `IN-SYSTEM SHOP` chip), 4 stat tiles, Overview / Purchases tabs. Purchases tab is a stub until PO ships. In-system linked shops show an amber read-only banner. |
| `/dashboard/supplier/:supplierId/edit` | `pages/dashboard/supplier/edit-supplier.page.tsx` | Wraps `SupplierForm`. For external suppliers it submits link fields via `useUpdateSupplier` AND shop fields via `useUpdateSupplierShop`. For in-system shops it sends link fields only and hides the shop sections. |

### Components (`features/supplier/components/`)

- `supplier-form.component.tsx` — single sectioned form used by Add &
  Edit. Sections: Identity (code + alias + status) → Contact (phones,
  emails, contact persons, repeaters) → GST & Tax → Address → Business
  Terms → Notes. Two key props:
  - `linkMetadataOnly` — hides supplier-shop identity sections; for
    Add-via-Link and for editing in-system linked shops.
  - `compact` — same affordance as `CustomerForm.compact`. Not currently
    used (no in-order supplier modal yet) but kept for symmetry.
  - **Auto code preview**: `usePreviewSupplierCode` pre-fills on a fresh
    form.
  - **Repeaters**: `useFieldArray` on `newShop.alternatePhones`,
    `newShop.alternateEmails`, and `newShop.contactPersons`.

- `link-existing-shop.component.tsx` — debounced search box + result list
  for the "Link existing" tab. Powered by `useLookupShops`.

### Hooks (`features/supplier/hooks/`)

- `use-get-paginated-suppliers.hook.ts` — `(limit, page, search?, sort?, filter?)`. The All page passes `filter: { status, kind }` for server-side filtering.
- `use-get-supplier.hook.ts` — single supplier.
- `use-supplier-stats.hook.ts` — shop-wide rollup, KPI cards.
- `use-preview-supplier-code.hook.ts` — peeks next `SUP/NNNN`.
- `use-add-supplier.hook.ts` — POST `/supplier`. Invalidates paginated + stats; cache-warms detail.
- `use-update-supplier.hook.ts` — PATCH link metadata.
- `use-update-supplier-shop.hook.ts` — PATCH `/:supplierId/shop` (external suppliers only).
- `use-delete-supplier.hook.ts` — DELETE; removes single-cache + invalidates list/stats.
- `use-lookup-shops.hook.ts` — search for the "Link existing" picker.

Shared:
- `shared/hooks/use-debounced-value.hook.ts` (introduced with the customer
  feature) is reused for search and lookup debouncing.

### Shared enums (`frontend/src/shared/enums/`)

`supplier-status.enum.ts`, `shop-kind.enum.ts` (`SELF_OPERATED` /
`EXTERNAL_SUPPLIER` + `ShopKindLabel`). `payment-terms.enum.ts` reused
from the customer feature.

### Interfaces (`features/supplier/interface/supplier.interface.ts`)

`Supplier` (the SupplierLink + populated `shop`), `SupplierShop` (the
Shop doc shape we care about), `SupplierStats`, `PrimaryContact`,
`AddSupplier` (POST body), `SupplierShopFormTypes` (shop-edit payload),
`SupplierFormTypes` (= `AddSupplier` for now), `SupplierShopLookup`.

---

## 6b. Find Supplier picker (discovery)

The *Link Existing Shop* tab on Add Supplier (and the "Browse Suppliers"
button on All Suppliers) opens a richer picker that helps users discover
a supplier even when they don't know the name. Discovery happens through
search, filters, sort, suggestions, preview, recents, and a side-by-side
compare tray.

### Discovery endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/supplier/lookup/shops` | Faceted search. Query params: `q`, `state`, `city`, `kind`, `gstStatus` (`any`/`registered`/`unregistered`), `sort` (`popular`/`name`/`recent`/`nearest`), `cursor`, `limit` (default 20, max 50). Response: `{ docs: SupplierShopLookup[], nextCursor: string \| null }`. Each row carries `linkedByCount` and `alreadyLinked`. |
| GET | `/supplier/suggestions` | Empty-state rails: `{ popularInYourState, popularOverall, recentlyAdded }`, each ≤ 8 rows. Excludes the buyer + already-linked shops. |
| GET | `/supplier/shop/:targetShopId/preview` | Full Shop doc + `linkedByCount` + `alreadyLinked` for the right-pane preview. |

`linkedByCount` is computed via a per-row `$lookup` into `shops` counting
`{ 'suppliers.supplierShop': X }` — small N, no caching yet.

Cursor format: opaque `base64url({"skip":N})`. The repo helpers are
`encodeCursor` / `decodeCursor` at the bottom of `supplier.repository.ts`.
Easy to migrate to a keyset cursor later if needed.

Indexes added for this surface (`shop.schema.ts`):
- `{ kind: 1, 'location.state': 1 }` — state-scoped + popular-in-state.
- `{ 'suppliers.supplierShop': 1 }` already exists; reused for the
  `linkedByCount` reverse-lookup.

### Frontend components (`features/supplier/components/`)

- `find-supplier.panel.tsx` — orchestrator. Two-column layout:
  - **Left**: search + filter bar + recents chips + (results grid OR
    suggestion rails depending on whether the user has typed/filtered).
  - **Right**: `SupplierPreviewPanel` (selected shop) with **Link supplier →** button.
  - **Bottom**: `SupplierCompareTray` (renders only when 2+ shops are checked, max 3).
- `supplier-filters.component.tsx` — sort + state + city + gstStatus + kind dropdowns.
- `supplier-result-card.component.tsx` — one row of the results grid, with
  the "Compare" checkbox and `LINKED` / `IN-SYSTEM` chips.
- `supplier-suggestion-rails.component.tsx` — three horizontally scrolling rails for the empty state.
- `supplier-preview-panel.component.tsx` — right pane (loads via `useShopPreview`).
- `supplier-compare-tray.component.tsx` — bottom side-by-side comparison table; "Link" jumps straight to the link form.

### Hooks (`features/supplier/hooks/`)

- `use-lookup-shops.hook.ts` — `useInfiniteQuery` over `/lookup/shops`. Disabled when the panel has no search/filter (suggestions render instead).
- `use-supplier-suggestions.hook.ts` — wraps `/suggestions`.
- `use-shop-preview.hook.ts` — wraps `/shop/:targetShopId/preview`.
- `use-recent-supplier-touches.hook.ts` — `localStorage`-backed *recently viewed* + *recently linked* lists, scoped per buyer shop. Max 5 each.

### Wiring

- **Add Supplier page** (`/dashboard/supplier/add`): the *Link Existing Shop* tab renders `FindSupplierPanel` directly (replacing the old single-input picker). When the user picks one, the page swaps in the link-metadata form pre-bound to that shop.
- **All Suppliers page** (`/dashboard/supplier/all`): header gains a **Browse Suppliers** button that opens the same panel in a wide modal (`max-w-[1100px]`). Confirming a pick navigates to `?linkShopId=<id>` on the Add page, which lands the user on the *Link* tab with the shop preselected (consumed and stripped from the URL by `useShopPreview` + `useSearchParams`).

### Behaviors worth knowing

- "LINKED" chip — `alreadyLinked` rows continue to surface in results, but the preview pane disables the Link button (so users can still inspect them).
- Empty state vs. results — the rails-vs-grid switch is driven by `hasActiveQuery` (any of: search, state, city, kind, gstStatus ≠ "any"). Reset all to see suggestions again.
- Recents — persisted across sessions in `localStorage` under `sms:sup:recent-viewed:<shopId>` and `sms:sup:recent-linked:<shopId>`.
- Compare cap — fixed at 3; the result card auto-disables additional checkboxes once the tray is full.

## 7. UI sketches

ASCII mockups for every supplier surface so future contributors can
orient quickly without launching the dev stack. Each block shows the
relevant chrome, key affordances, loading states, and noteworthy
conditional regions.

### 7.1 All Suppliers — `/dashboard/supplier/all`

```
┌─ Suppliers ──────────────────────────  [Browse Suppliers] [Add Supplier] ─┐
├─ KPI strip (driven by /supplier/stats; skeleton bars while loading) ──────┤
│ Total Suppliers │ Active │ Outstanding Payable │ With GSTIN                │
│       17        │   15   │     ₹2,40,000       │      12                   │
├─ Filter bar ──────────────────────────────────────────────────────────────┤
│ 🔍 Search name/phone/GSTIN/code…[spinner]  Status ▾ All  Kind ▾ All        │
├─ Table  (thin LinearProgress on refetch) ─────────────────────────────────┤
│ Code     Name (alias)        Phone        GSTIN/State    Orders Lifetime ₹ │
│ Payable  Last Purchase  Status     ✎ 🗑                                    │
│ ──────────────────────────────────────────────────────────────────────── │
│ SUP/0042 Steel & Co.         +91 98xxx…  27ABCDE…/MH       18    ₹4.8L     │
│ ₹12,000  12d ago          [ACTIVE]   ✎ 🗑                                 │
│ SUP/0041 Acme Wholesale      +91 91xxx…  —                  7    ₹1.1L     │
│ ₹0       45d ago          [ACTIVE]   ✎ 🗑                                 │
│ SUP/0040 Bharat Tenant Shop  +91 80xxx…  29ZZZZZ…/KA        2    ₹38k     │
│ ₹0       180d ago         [INACTIVE] ✎ 🗑   [IN-SYSTEM]                    │
│ …                                                                          │
├───────────────────────────────────────────────────────────────────────────┤
│                         ‹ 1  2  3  …  6 ›                                  │
└───────────────────────────────────────────────────────────────────────────┘

Row click → /dashboard/supplier/:id    Trash → confirm modal that reads live
stats (hard-unlink iff 0 orders & 0 payable, otherwise soft-unlink).
```

### 7.2 Add Supplier — `/dashboard/supplier/add`

#### 7.2a Tab strip

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Add Supplier                                                             │
├──────────────────────────────────────────────────────────────────────────┤
│ [ Create New Supplier ]  [ Link Existing Shop ]   ← tabs                  │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 7.2b Create New Supplier (default tab)

Backed by `<SupplierForm>` in full-page mode. All sections always open.

```
┌─ Identity ───────────────────────────────────────────────────────────────┐
│  Supplier Code [SUP/0043]   Alias              Status ▾ ACTIVE             │
│  (Supplier Name row is shown when not linkMetadataOnly)                    │
│  Supplier Name *                                                           │
├─ Contact ────────────────────────────────────────────────────────────────┤
│  Phone *  +91 …                Email                                       │
│  Contact Person                Designation                                 │
│  ── Alternate Phone Numbers ──                              [+ ADD PHONE] │
│    (repeater rows, remove icon per row)                                   │
│  ── Alternate Emails ──                                     [+ ADD EMAIL] │
│  ── Additional Contact Persons ──                  [+ ADD CONTACT PERSON] │
│    (card per row with name / designation / phone / email + remove)        │
├─ GST & Tax ──────────────────────────────────────────────────────────────┤
│  GSTIN   Legal Name   State   PAN (auto)                                   │
├─ Address ────────────────────────────────────────────────────────────────┤
│  Address Line 1 / 2 · City · State (code) · Country · Pincode              │
├─ Business Terms ─────────────────────────────────────────────────────────┤
│  Credit Limit ₹  Credit Period (d)  Payment Terms ▾                        │
│  Opening Balance (we owe ₹)  Default Discount %                            │
├─ Notes & Tags ───────────────────────────────────────────────────────────┤
│  Notes (multiline)                                                         │
└─────────────────────────────────────────────────  [ SAVE SUPPLIER ] ─────┘

Note: in `compact` mode (used by the Browse modal / future quick-add):
  - 3-col grids → 2-col, 2-col → 1-col
  - GST/Address/Business Terms/Notes are collapsible & default collapsed
  - SAVE SUPPLIER row becomes sticky bottom with a top border
```

#### 7.2c Link Existing Shop tab (no pick yet → renders FindSupplierPanel)

See [7.4 Find Supplier picker](#74-find-supplier-picker).

#### 7.2d Link Existing Shop tab (after a pick)

```
┌─ Linking  Bharat Tenant Shop · +91 80xxx… · 29ZZZZZ…  [change] ──────────┐
└──────────────────────────────────────────────────────────────────────────┘
┌─ SupplierForm in `linkMetadataOnly` mode ────────────────────────────────┐
│  Identity, Contact/GST/Address sections are HIDDEN (supplier's Shop doc   │
│  is owned by the in-system tenant). Only the link-side fields render:     │
│   - Identity:    Supplier Code · Alias · Status                            │
│   - Business Terms                                                        │
│   - Notes & Tags                                                          │
└─────────────────────────────────────────────────  [ LINK SUPPLIER ] ─────┘
```

### 7.3 Supplier Detail — `/dashboard/supplier/:supplierId`

```
┌─ ← Back to suppliers ────────────────────────────────────────────────────┐
├─ Header card ────────────────────────────────────────────────────────────┤
│  Steel & Co.   SUP/0042   [ACTIVE]   [GSTIN 27ABCDE…]   [IN-SYSTEM SHOP]  │
│  Steel & Co. Pvt. Ltd. (legal name)                                       │
│  +91 98xxxxxx · accounts@steelco.in              [ EDIT ]   [ DELETE ]    │
│  ── stats ── Lifetime ₹ │ Orders │ Avg. Order │ Outstanding Payable ──    │
│              ₹4,80,000     18       ₹26,667         ₹12,000 (red if >0)   │
├──────────────────────────────────────────────────────────────────────────┤
│ Banner (in-system linked only, amber):                                    │
│   "This supplier is an in-system shop. Only relationship metadata        │
│    (terms, alias, tags, notes) is editable — identity is owned by the    │
│    supplier shop itself."                                                 │
├─ [ Overview ] [ Purchases (N) ] ─────────────────────────────────────────┤
│                                                                          │
│  ┌─ Contact ─────────────┐  ┌─ GST & Tax ────────────┐                   │
│  │ phone, email, persons │  │ GSTIN, legal, PAN, st. │                   │
│  └───────────────────────┘  └────────────────────────┘                   │
│  ┌─ Address ─────────────┐  ┌─ Business Terms ───────┐                   │
│  │ address lines, …      │  │ terms, credit, opening │                   │
│  └───────────────────────┘  └────────────────────────┘                   │
│  ┌─ Notes & Tags ───────────────────────────────────────┐                │
│  │ notes (multiline)        [tag] [tag] [tag]            │                │
│  └──────────────────────────────────────────────────────┘                │
│                                                                          │
│  Purchases tab (stub until PO module ships):                              │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Purchase Orders will appear here once the PO module ships.        │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 7.3a Edit Supplier — `/dashboard/supplier/:supplierId/edit`

External supplier → identical to the Create form, prefilled, but issues
two PATCH calls on submit: link metadata via `useUpdateSupplier`, then
shop fields via `useUpdateSupplierShop`.

```
┌─ Edit Supplier ──────────────────────────────────────────────────────────┐
│ (amber banner shown when target is an in-system linked shop)              │
│ Same sectioned form as Create. linkMetadataOnly=true → hides identity,    │
│ contact, GST, address sections; only Identity (code/alias/status),        │
│ Business Terms, and Notes & Tags render.                                  │
└─────────────────────────────────────────────────  [ SAVE CHANGES ] ──────┘
```

### 7.4 Find Supplier picker

Used in two places:
- Inside the Add Supplier page's **Link Existing Shop** tab (inline, full width).
- Inside the **Browse Suppliers** modal on the All Suppliers page (`max-w-[1100px]`).

The empty state (no `q`, no filters except sort) shows three suggestion
rails. As soon as the user types or picks a filter, the rails are
replaced with a scrollable results grid.

```
┌─ Find Supplier ──────────────────────────────────────────────────────────┐
│ 🔍 Search by name / phone / GSTIN…                          [spinner]     │
│ Sort ▾ Popular   State ▾ All   City ____   GST ▾ Any   Kind ▾ All         │
│ Recently linked: [Steel & Co.] [Acme]                                     │
│ Recently viewed: [Bharat ×] [Royal ×] [Vivek ×]                           │
├──────────────────────────────────────────┬───────────────────────────────┤
│ LEFT (max-h-[60vh] overflow-y-auto)       │ RIGHT  Preview panel          │
│                                          │                               │
│ Empty / no-filter state → SUGGESTIONS:    │ (no selection yet)            │
│  ── Popular in your state ──              │ ┌──────────────────────────┐  │
│   [card][card][card] → (horiz scroll)     │ │ Pick a supplier on the   │  │
│  ── Popular overall ──                    │ │ left to preview them.    │  │
│   [card][card][card] →                    │ └──────────────────────────┘  │
│  ── Recently added ──                     │                               │
│   [card][card][card] →                    │ (after pick) — useShopPreview │
│                                          │ ┌──────────────────────────┐  │
│ Active-filter state → RESULT GRID:        │ │ Steel & Co.    [GSTIN]   │  │
│ ┌─ result card ─────────────────────────┐ │ │ External supplier        │  │
│ │ ▣ Steel & Co.                         │ │ │ Linked by 12 shops       │  │
│ │   +91 98xxx… · 27ABCDE…/MH            │ │ │ Phone · Email · Address  │  │
│ │   Linked by 12 shops                  │ │ │ Legal · PAN              │  │
│ │   ☐ Compare                           │ │ │ [ LINK SUPPLIER → ]       │  │
│ ├──────────────────────────────────────│ │ └──────────────────────────┘  │
│ │ ▣ Acme Wholesale     [LINKED]         │ │                               │
│ │   Mumbai · +91…                       │ │ alreadyLinked → button       │
│ ├──────────────────────────────────────│ │   replaced by an emerald      │
│ │ ▣ Bharat Tenant Shop [IN-SYSTEM]      │ │   "Already linked" note.      │
│ │   …                                   │ │                               │
│ └──────────────────────────────────────│ │                               │
│             [ Load more ]                │                               │
└──────────────────────────────────────────┴───────────────────────────────┘

   ┌─ Compare tray (only when ≥2 cards ticked, max 3) ────  [Clear] ┐
   │                  Steel & Co.   Acme Wholesale   Royal Traders   │
   │ Phone            +91 98…        +91 91…          +91 80…         │
   │ GSTIN            27ABCDE…       —                27ZZZZZ…        │
   │ Legal name       Steel Pvt Ltd  Acme Wholesale   Royal Traders   │
   │ State            Maharashtra    Maharashtra      Karnataka       │
   │ City             Mumbai         Mumbai           Bengaluru       │
   │ Linked by        12             5                3               │
   │ Action           [ Link ]       [ Linked ]       [ Link ]        │
   └────────────────────────────────────────────────────────────────┘
```

Behavior callouts:
- `hasActiveQuery` flips the left pane between suggestions and the grid.
- `useInfiniteQuery` on `/lookup/shops` — `Load more` reads `nextCursor`.
- `useShopPreview` powers the right pane; loads on selection.
- `useRecentSupplierTouches` persists viewed/linked across sessions in
  `localStorage` (scoped per buyer shop).
- Picking *Link supplier →* from either preview or compare tray:
  - In the **Add page** flow → swaps the panel out for the link-metadata form.
  - In the **Browse modal** flow → navigates to `add?linkShopId=<id>`,
    which preselects the shop via `useShopPreview` and lands on the
    *Link Existing Shop* tab with the form already showing.

### 7.5 Browse Suppliers modal (entry from All page)

```
┌─ Browse Suppliers ─────────────────────────────────────────────────  ✕ ──┐
│ (Modal w-[95vw] max-w-[1100px], body max-h-[80vh] overflow-y-auto)        │
│                                                                          │
│  ↓ identical layout to section 7.4 Find Supplier picker ↓                 │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 7.6 Delete-supplier confirmation (modal)

```
┌─ Remove supplier ────────────────────────────────────────────────  ✕ ────┐
│  case A — no purchases, zero payable:                                     │
│    Unlink Steel & Co.? No purchases recorded and zero outstanding —       │
│    the link will be removed (and the external supplier shop too if no     │
│    other shop references it).                                             │
│                                                                          │
│  case B — has purchases or payable:                                       │
│    Deactivate Steel & Co.? They have 18 order(s) and ₹12,000 payable.     │
│    Purchase history will be preserved.                                    │
│                                                                          │
│                                          [ CANCEL ]   [ CONFIRM ]         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Seeder

`docker/seed/seed.js` was extended (step 7):

- `SUPPLIER_COUNT` (default 15) `EXTERNAL_SUPPLIER` Shop docs with name,
  address, GST (75% have GSTIN), and contact.
- 2 additional `SELF_OPERATED` Shop docs ("Bharat Tenant Shop", "Vivek
  Tenant Shop") **inserted but not linked** — so the user can exercise
  the *Link Existing Shop* flow against them.
- All external supplier shops linked into Demo Shop's `suppliers[]` with
  realistic `paymentTerms`, `creditLimit`, `creditPeriodDays`, and
  occasional `openingBalance`.
- `suppliercounters` primed to `SUPPLIER_COUNT` so the next API-created
  supplier continues the sequence (e.g. `SUP/0016`).
- The Demo Shop create was also updated to set `kind: SELF_OPERATED` and
  initialize new contact arrays.

`SUPPLIER_COUNT` is overridable via env.

---

## 9. Migration

One-off script at `backend/src/scripts/migrate-suppliers.ts` handles
fixed-up dev DBs that still have `Shop.suppliers: ObjectId[]` from the
old schema. Idempotent — re-runs skip entries already in subdoc shape.
Run:

```
MONGO_URI=… DB=… npx ts-node -r tsconfig-paths/register \
  src/scripts/migrate-suppliers.ts
```

---

## 10. Caveats & known follow-ups

1. **Purchase Order / GRN module not shipped.** The `Purchases` tab on
   the detail page is a stub; `SupplierService.onPurchaseRecorded` is
   wired but unused; `stats.*` stays at zero until PO writes hit it.
2. **`stats` is updated only by the (future) PO module.** Payments
   recorded separately, voids, and adjustments would each need an
   analogous hook.
3. **`Inventory.supplier`** today references a `Shop` id (any shop). When
   PO ships, we should validate the supplier shop is actually linked to
   the recording shop.
4. **`Shop.gstDetails` requires several non-optional fields** (legalName,
   address, registrationDate, status, username, email, panCardNumber).
   The supplier-form UI only collects `gstin`/`legalName`/`state`/`pan`;
   the seeder fills the rest. We may want to relax those Mongoose
   requirements or expand the form before exposing GST-heavy supplier
   onboarding.
5. **No in-order supplier quick-add modal** yet. `supplier-form` already
   supports `compact` for that — wire when needed.
6. **Reverse lookup endpoint** ("which buyers does this shop supply?")
   isn't exposed publicly. Easy to add via the existing
   `{ 'suppliers.supplierShop': X }` index when needed.
7. **Cross-shop supplier code uniqueness** is enforced by counter, not
   by an index inside the subdoc array (Mongo can't index uniqueness
   across array elements within a single doc). Two manual writes with
   the same code would theoretically slip past — the service only ever
   generates via `SupplierCodeService`, so in practice it's safe.
8. **Hard-delete of in-system linked shops never happens** (we only
   cascade-delete `EXTERNAL_SUPPLIER` shells). That's intentional.

---

## 11. File map (quick jump)

Backend
```
backend/src/api/supplier/
├── supplier.controller.ts          — REST surface
├── supplier.service.ts             — CRUD + link/unlink + stats hook + lookup
├── supplier.module.ts              — wires Mongoose models
├── supplier.repository.ts          — aggregations over Shop model
├── supplier-code.service.ts        — SUP/NNNN generator
├── repository/
│   └── supplier-counter.repository.ts
├── dto/
│   ├── create-supplier.dto.ts          — link or create-and-link, link metadata
│   ├── update-supplier.dto.ts          — PartialType minus discriminator
│   ├── update-supplier-shop.dto.ts     — supplier Shop fields
│   └── paginated-supplier-query.dto.ts — search + filter + includeDeleted
├── enum/
│   ├── supplier-status.enum.ts
│   └── supplier-source.enum.ts
└── schema/
    ├── supplier-link.schema.ts     — subdoc lived inside Shop.suppliers[]
    ├── supplier-stats.schema.ts    — denormalized rollup
    └── supplier-counter.schema.ts

backend/src/api/shop/
├── schema/shop.schema.ts           — + kind, contact, suppliers: SupplierLink[]
├── enum/shop-kind.enum.ts          — SELF_OPERATED | EXTERNAL_SUPPLIER
├── dto/create-shop.dto.ts          — contact fields added; suppliers removed
├── shop.service.ts                 — legacy supplier methods deleted
├── shop.controller.ts              — legacy supplier endpoint deleted
└── repository/shops.repository.ts  — broken aggregation removed

backend/src/scripts/migrate-suppliers.ts  — ObjectId[] → subdoc migration

backend/src/api/form/form.service.ts      — dropdown entity 'supplier' now hits SupplierService
```

Frontend
```
frontend/src/features/supplier/
├── components/
│   ├── supplier-form.component.tsx        — sectioned, repeater-aware, linkMetadataOnly mode
│   └── link-existing-shop.component.tsx   — debounced shop picker
├── hooks/
│   ├── use-get-paginated-suppliers.hook.ts
│   ├── use-get-supplier.hook.ts
│   ├── use-supplier-stats.hook.ts
│   ├── use-preview-supplier-code.hook.ts
│   ├── use-add-supplier.hook.ts
│   ├── use-update-supplier.hook.ts
│   ├── use-update-supplier-shop.hook.ts
│   ├── use-delete-supplier.hook.ts
│   └── use-lookup-shops.hook.ts
└── interface/supplier.interface.ts        — Supplier / SupplierShop / Stats / AddSupplier / SupplierShopFormTypes / Lookup

frontend/src/pages/dashboard/supplier/
├── all-supplier.page.tsx        — list + KPIs + filters
├── add-supplier.page.tsx        — tabs: create / link
├── supplier-detail.page.tsx     — header + tabs (Overview / Purchases stub)
└── edit-supplier.page.tsx       — link + shop edit, in-system banner

frontend/src/shared/enums/
├── supplier-status.enum.ts
└── shop-kind.enum.ts

frontend/src/shared/api/supplier.api.ts    — REST client

frontend/src/App.tsx                       — route registration
frontend/src/features/dashboard/components/dashboard-sidebar.component.tsx
    — sidebar links fixed (both pointed to "suppliers"; now /supplier/all and /supplier/add)
```

---

## 12. Phase status snapshot

| Phase | Description | Status |
|---|---|---|
| 1 | Shop schema extensions + SupplierLink subdoc + SupplierCounter | ✅ shipped |
| 2 | Supplier module (CRUD + link/unlink + stats + lookup) | ✅ shipped |
| 3 | All / Add / Detail / Edit pages + sidebar + routes + seeder | ✅ shipped |
| 3b | Find Supplier picker: faceted lookup, suggestions, preview, compare tray, recents, Browse modal | ✅ shipped |
| 4 | Purchase Orders + GRN + payable ledger + stats hook caller | 🔲 deferred |
| 5 | In-order quick-add supplier modal, analytics tab, CSV import | 🔲 deferred |

Test plan when revisiting:
- Add → form auto-fills SUP code; submit → detail page.
- Link Existing → search shows the 2 seeded in-system shops; pick → relationship form → submit → detail page; same shop can't be linked twice.
- Edit external → both link + shop fields persist.
- Edit in-system linked → only link fields editable; shop sections hidden.
- Delete with no purchases → link removed; if `EXTERNAL_SUPPLIER` and no other refs, Shop doc gone.
- Delete with purchases → soft-unlink only.
- `/stats` reflects shop-wide counts across pagination.
