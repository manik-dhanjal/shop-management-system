# Add Order — Feature Reference

End-to-end reference for the Add/Edit Order flow: data model, pricing rules,
backend endpoints, frontend wiring, and known caveats. Keep this updated when
the order feature changes — Claude reads this first whenever asked to work on
order/invoice code.

---

## 1. What this feature does

Lets an authenticated shop user create a customer invoice. The user picks a
customer, adds product line items, edits quantity/discount inline, then sees a
live GST breakup and grand total. On save, the order is persisted, product
stock is decremented atomically, and the user is sent to a printable invoice
view.

Supports four invoice types (`Tax Invoice`, `Bill of Supply`, `Export
Invoice`, `Retail Invoice`) and switches automatically between intra-state
(CGST+SGST) and inter-state (IGST) GST.

---

## 2. Data model (backend)

All schemas live under `backend/src/api/orders/schema/`.

### `Order` (`order.schema.ts`)
```
invoiceId       String  unique
customer        ObjectId → Customer
billedBy        ObjectId → User
shop            ObjectId → Shop
invoiceType     enum InvoiceType
items           [OrderItem]
description     String?
billing         BillingDetails
payment         PaymentDetails
orderDate       Date  default: now
createdAt/updatedAt  (mongoose timestamps)
```

### `OrderItem` (`order-item.schema.ts`) — embedded
```
product       ObjectId → Product
quantity      Number
discount      Number  min 0       — absolute ₹, includes order-level allocation
taxableValue  Number  min 0       — gross − discount
taxes         [TaxDetail]         — CGST+SGST or IGST (never both)
totalPrice    Number  min 0       — taxableValue + tax
```

### `BillingDetails` (`billing-details.schema.ts`) — embedded
```
subTotal      Number  min 0       — Σ(sellPrice × qty), pre-discount
discounts     Number  min 0       — item discounts + order discount
taxes         [TaxDetail]         — aggregated by (type, rate)
grandTotal    Number  min 0       — taxableAmount + tax
roundOff      Number              — can be negative
finalAmount   Number  min 0       — round(grandTotal)
```

### `PaymentDetails` (`payment.detail.schema.ts`) — embedded
```
paymentMethod  enum PaymentMethod   (Cash, UPI, …)
status         enum PaymentStatus   (Pending, Paid, …)
amountPaid     Number  min 0
transactionId  String?
notes          String?
paymentDate    Date
```

> **Note:** `PaymentDetails` does **not** extend `Document` (it's an embedded
> subdoc). Don't reintroduce that — Mongoose treats it as a top-level model
> otherwise.

### `TaxDetail` (`tax-detail.schema.ts`) — embedded
```
type    enum TaxType (CGST | SGST | IGST | CESS)
rate    Number  (percentage)
amount  Number
```

### `InvoiceCounter` (`invoice-counter.schema.ts`) — top-level
```
shop           ObjectId → Shop
financialYear  String  e.g. "25-26"
lastNumber     Number
```
Unique index on `(shop, financialYear)`. Drives `INV/YY-YY/NNNN` invoice IDs.

---

## 3. Backend services & endpoints

Controller: `backend/src/api/orders/order.controller.ts`, base path
`shop/:shopId/order`, all routes require role `EMPLOYEE | ADMIN | MANAGER`.

| Method | Path | Purpose |
|---|---|---|
| POST   | `/`                 | Create order. Auto-generates `invoiceId` if absent. Decrements stock atomically. |
| POST   | `/paginated`        | Paginated list (populates `customer`). |
| GET    | `/invoice-id/next`  | Peeks next invoice number for current shop+FY. **Does not increment.** |
| GET    | `/:id`              | Raw order (IDs only, used by edit page). |
| GET    | `/:id/populated`    | Order with `customer` + `items.product` populated (print page). |
| PUT    | `/:id`              | Update an order. Throws `NotFoundException` if shop mismatch. |
| DELETE | `/:id`              | Remove order. |

### Key services

- **`OrderService.createOrder(shopId, dto, user)`** (`order.service.ts`)
  1. Asserts `dto.shop === shopId`.
  2. Calls `productService.assertAndDecrementStock(shopId, lines)` — atomic
     conditional `$inc` per product (`stock: { $gte: qty }`); on any failure,
     previously decremented products are rolled back.
  3. Generates invoice ID via `InvoiceNumberService.generate` if missing.
  4. Sets `billedBy: user._id`. The controller pulls the user via the
     `@CurrentUser()` param decorator (`shared/decorator/current-user.decorator.ts`)
     which reads `request.user` populated by `AuthGuard`. **Required by the
     `Order` schema** — passing the user explicitly to the service keeps the
     auth side-effect out of the service contract.
  5. Persists the order.

- **`InvoiceNumberService`** (`invoice-number.service.ts`)
  - Indian FY (Apr 1 – Mar 31). Format `INV/25-26/0042`.
  - `peek()` doesn't increment; `generate()` does atomic `findOneAndUpdate`
    with upsert.

### DTOs

- `CreateOrderDto.invoiceId` is **optional** (server fills in).
- All numeric "could be zero" fields use `@Min(0)` (never `@IsPositive` — that
  excludes 0 and is wrong for discounts, round-off, etc.).
- `UpdateOrderDto = PartialType(CreateOrderDto)` (no `updatedAt` override —
  Mongoose handles that via timestamps).

---

## 4. Pricing rules (single source of truth)

Implemented as a pure function:
**`frontend/src/features/order/utils/pricing.util.ts → computeOrderTotals()`**

Inputs: `items[]`, `orderDiscount` (₹), `shopState`, `customerState`,
`invoiceType`.

```
interState   = shopState && customerState && shopState ≠ customerState
taxExempt    = invoiceType ∈ {BILL_OF_SUPPLY, RETAIL_INVOICE}

Per line i:
  gross[i]         = sellPrice[i] × qty[i]
  itemDisc[i]      = user-entered absolute ₹

  // order-level discount allocated proportionally over post-item-discount value
  allocBase[i]     = gross[i] − itemDisc[i]
  share[i]         = (allocBase[i] / Σ allocBase) × orderDiscount

  taxableValue[i]  = max(0, gross[i] − itemDisc[i] − share[i])

  if taxExempt:
    taxes[i] = [];                   tax[i] = 0
  elif interState:
    taxes[i] = [IGST @ igstRate];    tax[i] = taxable × igstRate / 100
  else:
    taxes[i] = [CGST, SGST];         tax[i] = sum of both

  totalPrice[i]    = taxableValue[i] + tax[i]

Order:
  subTotal       = Σ gross[i]
  discounts      = Σ itemDisc[i] + orderDiscount
  taxes          = aggregated by (type, rate)
  grandTotal     = Σ taxableValue + Σ tax
  finalAmount    = round(grandTotal)
  roundOff       = finalAmount − grandTotal     // signed
```

Rounding is `round2` for intermediate values and `Math.round` for the final
amount; `roundOff` is the signed delta.

Also exported: **`amountInWords(n)`** — Indian-English words for the printed
invoice ("Two thousand five hundred thirty-seven rupees only").

**Gotcha:** `sellPrice` is treated as **tax-exclusive**. If pricing is ever
moved to tax-inclusive, change only the `taxableValue`/`tax` formulas in
`pricing.util.ts` — everything downstream consumes the computed output.

---

## 5. Frontend architecture

### Page shells

| Route | File | Notes |
|---|---|---|
| `/dashboard/order/add` | `pages/dashboard/order/add-order.page.tsx` | Auto-fetches next invoice ID; on success, navigates to `/print`. |
| `/dashboard/order/:orderId/edit` | `pages/dashboard/order/edit-order.page.tsx` | Uses **populated** endpoint and flattens `customer` → `customer._id` before feeding the form. No invoice-id auto-fill. |
| `/dashboard/order/:orderId/print` | `pages/dashboard/order/print-order.page.tsx` | Uses `/populated` endpoint. Forces white background regardless of theme via `bg-white` + negative margins that cancel the dashboard's `px-* py-*` padding. `print:` variants strip those for the physical page. |
| `/dashboard/order/all` | `pages/dashboard/order/all-orders.page.tsx` | Has Print, Edit, Duplicate, Delete actions. Customer cell handles both `string` and populated `Customer` (paginated endpoint populates). |

### Print isolation

`DashboardLayout` wraps `<DashboardSidebar>` and `<DashboardHeader>` in
`print:hidden` divs, and strips `h-screen overflow-hidden` constraints under
`print:` so the invoice flows naturally onto paper. The print page's own
"Back / Print Invoice" buttons live inside a `print:hidden` row.

### Components (`features/order/components/`)

- `order-form.component.tsx` — vertical-stack shell:
  1. **Full-width Order Details card** with internal 4-col grid (Invoice ID |
     Invoice Type | Order Date | Customer ▾), full-row customer info chip,
     full-row description.
  2. Full-width Order Items table.
  3. Payment (lg:7) + sticky Invoice Summary (lg:5) row.
  4. Submit bar.
  - `watch("items")`, `watch("orderDiscount")`, `watch("invoiceType")` →
    feed `computeOrderTotals`.
  - Mirrors computed `billing` and enriched `items` back into form state so
    submit picks them up.
  - Auto-fills `invoiceId` via `usePreviewInvoiceId` only when form is fresh.
- `order-meta.component.tsx` — exports two unwrapped slot components so the
  caller can lay them out in any grid:
  - `OrderMetaFields` — renders three fields (Invoice ID via
    `TextFieldControlled`, Invoice Type via `SelectFieldControlled`, Order
    Date via `DateFieldControlled`) as siblings. Invoice ID uses
    `slotProps={{ inputLabel: { shrink: true } }}` because it's pre-filled.
  - `OrderDescriptionField` — full-width textarea rendered separately.
- `order-customer-card.component.tsx` — split into two slots:
  - `CustomerSelectSlot` — the dropdown only (occupies one grid cell next to
    the meta fields).
  - `CustomerInfoChip` — single-row summary (name · phone · GSTIN · address)
    with intra/inter-state badge on the right; renders nothing when no
    customer is selected.
- **`customer-select.component.tsx`** (`features/customer/components/`) — the
  custom-built dropdown (not a MUI Select; opens `CustomerSelectModal` on
  click). Restyled to match MUI outlined input: fixed `h-14` (56px),
  `rounded-lg`, border `border-black/[0.23] dark:border-white/[0.23]`, floated
  label uses `bg-white dark:bg-gray-800` to notch the border, single-line
  display (name only — phone moved into the `CustomerInfoChip`).
- `order-item-list.component.tsx` — full-width editable rows. Uses
  `table-fixed` + a `colgroup` to keep columns from collapsing when product
  names are long (Product 26%, HSN 7%, Qty 10%, Unit 11%, Disc 8%, Taxable
  10%, GST cols ~8% each, Total 11%, × 4%). Product/SKU cells use `truncate`
  with `title` tooltip. Per-row Discount input uses `noSpinner` class.
- `order-item-select-modal.component.tsx` — product picker. **Does not
  compute taxes**; lines inserted with zero taxes/totals — the form's pricing
  util fills them in.
- `invoice-summary.component.tsx` — sticky card. Consolidates tax breakup
  **by type only** (one row per CGST/SGST/IGST, no per-rate split). Order
  Discount input uses `noSpinner`. Per-rate detail is still preserved on
  `computed.billing.taxes` so the print invoice can show full breakdown.
- `payment-details.component.tsx` — Payment Method + Status via
  `SelectFieldControlled`, Payment Date via `DateFieldControlled`, Amount
  Paid via `TextFieldControlled` with `noSpinner`. Auto-fills `amountPaid =
  finalAmount` when status becomes "Paid"; clears it on "Pending".

`noSpinner` class (used to hide native number-input arrows):
```
[appearance:textfield]
[&::-webkit-outer-spin-button]:appearance-none
[&::-webkit-inner-spin-button]:appearance-none
[&::-webkit-inner-spin-button]:m-0
```

### Shared form components (`frontend/src/shared/components/form/`)

All three follow the same API: pass `name` + `control`, plus standard
`TextFieldProps`. They merge any caller-supplied `slotProps` with the
project-wide defaults (`borderRadius: 8px`, `className: w-full`) and **coerce
`undefined → ""`** so a freshly-mounted controlled MUI input doesn't trip
React's "uncontrolled → controlled" warning when the form value first lands.

| Component | Purpose |
|---|---|
| `text-field-controlled.component.tsx` | Text / number / multiline inputs. |
| `date-field-controlled.component.tsx` | `<input type="date">` that marshals between the form's ISO timestamp and the input's `YYYY-MM-DD` string. Defaults `inputLabel.shrink: true` (date inputs always show value/dashes). |
| `select-field-controlled.component.tsx` | Generic dropdown. Pass `options` as `["A","B"]` or `[{ label, value }]`. Default selection comes from `useForm({ defaultValues })`. |

### Hooks (`features/order/hooks/`)

- `use-add-order.hook.ts` — POST. **Does not navigate** itself anymore; pages
  pass `{ onSuccess }` via `mutate()`. Invalidates the invoice-id preview
  cache.
- `use-update-order.hook.ts` — PUT.
- `use-get-order.hook.ts` — raw, used by Edit page.
- `use-get-order-populated.hook.ts` — populated `customer`/`items.product`,
  used by Print page.
- `use-preview-invoice-id.hook.ts` — `enabled` flag; pass `false` on Edit.
- `use-get-paginated-orders.hook.ts` / `use-delete-order.hook.ts` — unchanged.

### Form types

```ts
// features/order/components/order-form.component.tsx
interface OrderFormTypes {
  invoiceId?:    string
  customer?:     string        // _id only — never a populated object
  invoiceType?:  InvoiceType
  items:         OrderItemPopulated[]   // populated for UI rendering
  description?:  string
  orderDiscount?: number       // UI-only — folded into billing.discounts
  orderDate?:    string        // ISO
  billing:       Partial<BillingDetails>
  payment:       Partial<PaymentDetails>
}
```

When submitting, each item is mapped to `OrderItem` with `product: item.product._id`.

---

## 6. UI layout (desktop — Variant A, compact)

```
┌─ Order Details ─────────────────────────────────────────────────────────┐
│ ┌────────────┬────────────┬────────────┬───────────────────────────────┐│
│ │ Invoice ID │ Inv. Type  │ Order Date │ Customer ▾                    ││
│ └────────────┴────────────┴────────────┴───────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────────────┐│
│ │ Customer · phone · GSTIN · address                       [Intra-st]  ││
│ └──────────────────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────────────────┐│
│ │ Description (full-row textarea, 2 rows)                              ││
│ └──────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
┌─ Order Items                                          [ + Add Item ] ───┐
│ Product  HSN  Qty  Unit  Disc  Taxable  CGST  SGST  Total  ×            │  ← full width
└─────────────────────────────────────────────────────────────────────────┘
┌─ Payment (lg:7) ──────────┐  ┌─ Invoice Summary (lg:5, sticky) ────────┐
│ Method     Status         │  │ Sub Total / Discount / Order Discount   │
│ Amount Paid     Date      │  │ Taxable Amount / CGST / SGST            │
│ Txn ID    Notes           │  │ Grand Total / Round Off / Final Amount  │
└───────────────────────────┘  │ (₹ in words)                            │
                               └─────────────────────────────────────────┘
                          [ Save & Generate Invoice ]
```

- Order Details card is **full-width**, with its top row laid out as a
  `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` grid (Invoice ID / Invoice
  Type / Order Date / Customer ▾). The customer info chip and Description
  each span a full row below.
- Items section is full-width (uses `table-fixed` + `colgroup` to keep
  column widths sane when product names wrap).
- Bill of Supply / Retail Invoice: tax columns hide, summary collapses to
  `Sub Total → Discount → Grand Total`.

---

## 7. Bugs fixed during the rebuild

| Where | Fix |
|---|---|
| `order.service.ts` `updateOrder` | Inverted `if (existingOrder)` check → now `if (!existingOrder) throw NotFoundException`. |
| `billing-details.dto.ts` | `@IsPositive` (excludes 0) → `@Min(0)`. `roundOff` no longer `@IsPositive` (can be negative). |
| `order-item.dto.ts` | `discount`, `taxableValue`, `totalPrice` → `@Min(0)`. |
| `tax-detail.dto.ts` | Same — `@Min(0)`. |
| `payment.detail.schema.ts` | Removed `extends Document` from embedded subdoc. |
| `order.schema.ts` | Added explicit `orderDate` field (defaults to now). |
| `order-item-select-modal.tsx` | Was applying CGST **and** SGST **and** IGST simultaneously — fixed by letting `computeOrderTotals` decide based on state. |
| Create order failing with `Order validation failed: billedBy: Path billedBy is required` | Added `@CurrentUser` decorator + threaded the user through `OrderController.create` → `OrderService.createOrder` → injected as `billedBy` on the persisted document. |
| Items-mirror `useEffect` only compared `taxableValue`/`totalPrice` | When the customer state switched (CGST+SGST ↔ IGST) leaving numerics equal, items array stayed stale while `billing.taxes` updated — payload had mismatched item taxes vs. billing. Now also deep-compares each line's `taxes[]` (type + rate + amount + length). |
| Print page printed the dashboard sidebar/header on the paper | `DashboardLayout` wraps both in `print:hidden` and strips `h-screen overflow-hidden` constraints under `print:`. |
| Print page rendered with dark theme in dark mode | Outer wrapper forces `bg-white text-gray-900` and negative margins eat the dashboard's content padding so the white extends edge-to-edge regardless of global theme. |
| All-orders page crashed with "Objects are not valid as a React child" | Paginated endpoint now populates `customer`; list cell checks for both `string` and populated `Customer` shapes. |
| Edit page item rows came in blank with `key=NaN` warnings | Was using `useGetOrder` (non-populated); switched to `useGetOrderPopulated` and flatten `customer` → `customer._id` before feeding the form. Row key in `order-item-list` hardened to `${product?._id ?? "row"}-${idx}`. |
| Customer dropdown taller than other inputs and unmatched border | Fixed `h-14`, single line (name only), `border-black/[0.23]` to match MUI's outlined input; phone moved to the `CustomerInfoChip`. |
| Invoice ID floating label overlapped pre-filled value | `slotProps={{ inputLabel: { shrink: true } }}` (replaced deprecated `InputLabelProps`). |
| MUI controlled-input warning ("uncontrolled → controlled") | `TextFieldControlled` (and the new `Select`/`Date` variants) coerce `field.value ?? ""` before rendering. |

---

## 8. Caveats & known follow-ups

1. **Stock decrement isn't fully transactional across the *whole* create
   call** — the per-product `$inc` is atomic, but if the order insert fails
   after stock has been decremented, stock isn't restored. Acceptable today
   because the insert is the very next step and rarely fails after stock
   validation; revisit if we observe drift.
2. **Edit order does not adjust stock.** If qty changes during edit, product
   stock isn't compensated. Treat edit as metadata-only for now.
3. **Order-level discount allocation** is proportional by post-item-discount
   line value. If two lines have different GST rates, this changes how much
   tax each loses — by design. Document this if a tax consultant questions it.
4. **`sellPrice` is tax-exclusive** by assumption. No UI toggle yet.
5. **Print view** uses the browser's print dialog (`window.print()`). No PDF
   generation backend.
6. **Invoice ID is server-generated but the field is editable.** If a user
   types over it, the server will accept the typed value. The peek endpoint
   won't change; the next real order may collide. Consider tightening this
   later (e.g. read-only with a "regenerate" action).
7. **`useGetOrder` returns customer/items as IDs**, while `useGetOrderPopulated`
   returns them as nested objects. The TS type `Order.customer: string` is a
   lie for the populated variant — print page and edit page both cast to
   `any`. Worth a proper `OrderPopulated` interface later.
8. **Paginated orders endpoint populates `customer`** for the list view, so
   `Order.customer` from `useGetPaginatedOrders` is actually a `Customer`
   object, not a string. The all-orders page guards both shapes inline.
9. **Edit page does not refresh stock or invoice number**. It edits in place;
   any product change re-uses the old invoice id and does not re-validate
   stock. Treat edits as cosmetic until that's hardened.

---

## 9. File map (quick jump)

Backend
```
backend/src/api/orders/
├── order.controller.ts             — REST surface
├── order.service.ts                — create / update / get / list / delete
├── order.module.ts                 — wires Mongoose + ProductsModule
├── invoice-number.service.ts       — FY-aware INV/YY-YY/NNNN
├── dto/                            — CreateOrderDto, UpdateOrderDto, etc.
├── enum/                           — InvoiceType, PaymentMethod, PaymentStatus, TaxType
├── repository/                     — OrderRepository, InvoiceCounterRepository
└── schema/                         — Order, OrderItem, Billing, Payment, Tax, InvoiceCounter

backend/src/api/products/product.service.ts
  └── assertAndDecrementStock(shopId, lines)   ← called from OrderService

backend/src/shared/decorator/current-user.decorator.ts
  └── @CurrentUser() — reads request.user populated by AuthGuard
```

Frontend
```
frontend/src/features/order/
├── components/
│   ├── order-form.component.tsx          — shell + wiring
│   ├── order-meta.component.tsx          — OrderMetaFields + OrderDescriptionField
│   ├── order-customer-card.component.tsx — CustomerSelectSlot + CustomerInfoChip
│   ├── order-item-list.component.tsx
│   ├── order-item-select-modal.component.tsx
│   ├── invoice-summary.component.tsx
│   └── payment-details.component.tsx
├── hooks/
│   ├── use-add-order.hook.ts
│   ├── use-update-order.hook.ts
│   ├── use-get-order.hook.ts
│   ├── use-get-order-populated.hook.ts
│   ├── use-preview-invoice-id.hook.ts
│   ├── use-get-paginated-orders.hook.ts
│   └── use-delete-order.hook.ts
├── interface/                            — Order, OrderItem, Billing, Payment, TaxDetail
└── utils/
    └── pricing.util.ts                   — computeOrderTotals + amountInWords

frontend/src/pages/dashboard/order/
├── add-order.page.tsx
├── edit-order.page.tsx
├── all-orders.page.tsx
└── print-order.page.tsx

frontend/src/pages/dashboard/layout/dashboard.layout.tsx
  └── wraps sidebar/header in `print:hidden`, strips screen-fit on print

frontend/src/features/customer/components/customer-select.component.tsx
  └── MUI-styled custom dropdown (opens CustomerSelectModal)

frontend/src/shared/components/form/
├── text-field-controlled.component.tsx   — base TextField wrapper
├── date-field-controlled.component.tsx   — ISO ↔ YYYY-MM-DD marshalling
└── select-field-controlled.component.tsx — generic dropdown with options[]

frontend/src/shared/api/order.api.ts      — REST client
```
