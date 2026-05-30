# Shop — Feature Reference

End-to-end reference for the Shop feature: managing the active shop,
accessing other shops the user has been granted access to, inviting
team members, and adding new shops. Read this **first** whenever asked
to work on shop CRUD, team/roles, or the header shop switcher.

---

## 1. What this feature does

- **All My Shops** at `/dashboard/shop/all` — lists every shop the current
  user can access (via `User.shopsMeta`), always-open search + filters,
  cross-shop KPI strip, and a card per shop with quick "Switch" /
  "Open" CTAs.
- **Shop Detail** at `/dashboard/shop/:shopId` — identity, status, role
  chips, "You are here" indicator; tabs **Overview / Team & Roles /
  Settings / Danger**.
- **Edit Shop** at `/dashboard/shop/:shopId/edit` — admin-only sectioned
  form (Identity, Contact, GST & Tax, Address, Preferences).
- **Add Shop** at `/dashboard/shop/add` — same sectioned `<ShopEditForm>`
  as Edit (shared component). On success the new shop becomes the
  active shop and the user lands on its detail page. The legacy
  3-step wizard now only powers the post-signup onboarding flow at
  `/dashboard/shop/onboarding`. Calling `POST /shop` also grants the
  creator ADMIN role on the new shop.
- **Header switcher** — every page renders `<ShopSwitcher />` instead of
  the legacy `<ShopSelectDropdown />`. Click → popover with search,
  recently-used shops (localStorage), all-shops list, and links to
  *Add new shop* / *Manage shops*.

---

## 2. Backend data model

### `Shop` (`backend/src/api/shop/schema/shop.schema.ts`)

Grouped by purpose:

#### Identity & classification
```
name                String   required
kind                enum     SELF_OPERATED | EXTERNAL_SUPPLIER       default SELF_OPERATED
status              enum     ACTIVE | INACTIVE | SUSPENDED            default ACTIVE
description         String?
logo                ObjectId → MediaMetadata
```

#### Preferences (per SELF_OPERATED shop)
```
currency            String   default 'INR'
timezone            String   default 'Asia/Kolkata'
billingEmail        String?
```

#### Contact
```
phone               String?
email               String?
alternatePhones     String[]
alternateEmails     String[]
contactPersonName   String?
contactPersonDesignation String?
contactPersons      Array<{ name, designation?, phone?, email? }>
```

#### Address & tax
```
location            Location
gstDetails          GstDetails?
```

#### Subdocs
```
suppliers           SupplierLink[]   per-relationship supplier metadata (see docs/supplier.md)
```

#### Soft delete
```
isDeleted   Boolean   default false
deletedAt   Date?
```

### Indexes
```
{ kind: 1 }
{ kind: 1, 'location.state': 1 }
{ 'suppliers.supplierShop': 1 }
{ 'suppliers.supplierCode': 1 }
```

### `User.shopsMeta` (existing)

```
shopsMeta: [{
  shop:  ObjectId → Shop
  roles: UserRole[]   (admin | manager | employee)
}]
```

This is the source of truth for "which user can access which shop with
which roles". All member endpoints mutate this subdoc array.

---

## 3. Backend services & endpoints

Base path: `/api/v1/shop`.

| Method | Path | Purpose |
|---|---|---|
| GET    | `/mine`                       | List shops in the caller's `shopsMeta`, joined with the caller's roles + per-shop today rollup (`orders`, `revenue`, `receivable`). Optional `?q=…` filters by shop name / city / GSTIN. |
| GET    | `/mine/stats`                 | Cross-shop rollup: `totalShops`, `activeShops`, `ordersToday`, `revenueToday`, `outstandingReceivable`, `outstandingPayable`. |
| GET    | `/:shopId`                    | Single shop with `logo` populated AND `myRoles` (caller's roles on this shop) attached. Excludes soft-deleted. |
| POST   | `/`                           | Create a shop. Stamps the creator into the new shop's admin role via `userService.updateUserWithQuery`. |
| PATCH  | `/:shopId`                    | Update shop fields. **`@Roles(ADMIN)`**. |
| DELETE | `/:shopId`                    | Soft-delete. **`@Roles(ADMIN)`** + caller must hold ADMIN on this specific shop + the shop must have zero order docs. Pulls the shop from every user's `shopsMeta`. |
| GET    | `/:shopId/members`            | Lists users with access to this shop (joined from `User.shopsMeta`). |
| POST   | `/:shopId/members`            | Invite by email + roles. Links an existing user, or creates a pending one (`isActive: true` with no password — signup flow completes later). Refuses if the user is already linked. **`@Roles(ADMIN)`**. |
| PATCH  | `/:shopId/members/:userId`    | Replace a member's roles. **`@Roles(ADMIN)`**. Refuses to demote the last admin. |
| DELETE | `/:shopId/members/:userId`    | Remove a member. **`@Roles(ADMIN)`**. Refuses to remove the last admin. |

### Key services (`shop.service.ts`)

- `getShopById(shopId, user?)` — populates `logo`; computes `myRoles` from the calling user's `shopsMeta`. Excludes soft-deleted.
- `getMyShops(user, q?)` — aggregation:
  1. `$match { _id ∈ user.shopsMeta.shop, isDeleted ≠ true }` plus optional regex `$or` over name/city/GSTIN.
  2. `$lookup orders` for today's orders/revenue/receivable per shop.
  3. Stitches each shop with `roles` from `user.shopsMeta` in JS.
- `getMyShopsStats(user)` — two aggregations:
  1. Over `shops`: total + active counts + `outstandingPayable` summed from each shop's `suppliers[].stats.outstandingPayable`.
  2. Over `orders`: today's order count, revenue, receivable across all accessible shop IDs.
- `deleteShop(shopId, user)` — role check, refuses if any orders exist, soft-deletes the shop, pulls from every user's `shopsMeta`.
- `inviteMember`, `updateMemberRoles`, `removeMember` — straight wrappers over `User` model updates with the last-admin guard.

### Mongoose model registration

`ShopModule` now registers both `Shop` and `User` Mongoose models (so
the service can run cross-collection queries). `UserModule` is also
imported to access `UserService.updateUserWithQuery` for the creation
flow.

---

## 4. Frontend architecture

### Pages (`pages/dashboard/shop/`)

| Route | File | Notes |
|---|---|---|
| `/dashboard/shop/all` | `all-shops.page.tsx` | Always-open search + filters (role, kind, status, state), cross-shop KPI strip, grid of `<ShopCard>`. Search hits the server; client-side filters apply on top. |
| `/dashboard/shop/:shopId` | `shop-detail.page.tsx` | Header + tabs Overview / Team & Roles / Settings / Danger. Admin-only "Edit" & "Delete" buttons. Non-active shops show a "Switch to this shop" CTA. |
| `/dashboard/shop/:shopId/edit` | `edit-shop.page.tsx` | Admin-only sectioned form via `<ShopEditForm>`. Non-admins see an amber permission banner. |
| `/dashboard/shop/add` | `add-shop.page.tsx` | Renders the same `<ShopEditForm>` Edit uses. Empty `initial`; submit calls `useAddShop().mutateAsync(values)` and navigates to `/dashboard/shop/<newId>`. The post-signup `shop-setup.page.tsx` wizard is a separate flow. |

### Components (`features/shop/components/`)

- `shop-card.component.tsx` — single card on the All My Shops grid.
  Renders status, role chips, GSTIN, location, today's KPIs, and
  Switch / Open buttons. Marks the active shop with a violet border.
- `shop-switcher.component.tsx` — new header popover. Always-on
  search input, "Recently used" section (from `useRecentShops`), all
  accessible shops, plus "Add new shop" / "Manage shops" footer
  actions. Replaces `dashboard-header.component.tsx → ShopSelectDropdown`.
- `shop-edit-form.component.tsx` — sectioned form (Identity, Contact
  with repeaters for alt phones/emails/contact persons, GST, Address,
  Preferences) backed by `react-hook-form` + `yup`.
- `shop-members-tab.component.tsx` — member table inside Shop Detail.
  Inline role multi-select editor; remove via confirmation modal.
  Admin-only writes.
- `invite-member-modal.component.tsx` — email + first/last name + role
  multi-select. Same modal handles "link existing user" and "create
  pending user" — backend decides based on email lookup.

### Hooks (`features/shop/hooks/`)

- `use-my-shops.hook.ts` — `useQuery` over `/shop/mine`.
- `use-my-shops-stats.hook.ts` — cross-shop rollup for the KPI strip.
- `use-get-shop.hook.ts` — single shop with `myRoles`.
- `use-update-shop.hook.ts` / `use-delete-shop.hook.ts` — PATCH / DELETE.
- `use-shop-members.hook.ts` / `use-invite-member.hook.ts` /
  `use-update-member-role.hook.ts` / `use-remove-member.hook.ts` —
  team CRUD.
- `use-recent-shops.hook.ts` — localStorage-backed "recently switched
  to" list, scoped per user (`sms:shop:recent:<userId>`). Updated when
  the user picks a shop via the All page or the header switcher.

### Interfaces (`features/shop/interface/shop.interface.ts`)

Extended `Shop` with `kind`, `status`, `description`, `logo`,
`currency`, `timezone`, `billingEmail`, `contactPersons[]`,
`gstDetails`, `myRoles`. New types: `MyShopRow`, `MyShopsStats`,
`ShopMember`, `InviteMemberPayload`, `ShopGstDetails`.

### Enums (`shared/enums/`)

- `shop-status.enum.ts` — `ACTIVE | INACTIVE | SUSPENDED`.
- `user-role.enum.ts` — `ADMIN | MANAGER | EMPLOYEE` + `UserRoleLabel`.
- `shop-kind.enum.ts` (existing) — reused.

### Routes (`App.tsx`)

```tsx
<Route path="shop">
  <Route path="all" element={<AllShopsPage />} />
  <Route path="add" element={<AddShopPage />} />
  <Route path=":shopId" element={<ShopDetailPage />} />
  <Route path=":shopId/edit" element={<EditShopPage />} />
</Route>
```

---

## 5. Wireframes

### 5.1 All My Shops — `/dashboard/shop/all`

```
┌─ My Shops ──────────────────────────────────────  [+ ADD SHOP] ──┐
├─ Cross-shop KPI strip (skeleton bars while loading) ────────────┤
│ Total │ Active │ Orders Today │ Revenue Today │ Receivable       │
│   4   │   3    │      27      │   ₹1,42,500   │   ₹68,200         │
├─ Always-open search + filters ──────────────────────────────────┤
│ 🔍 search shop name / city / GSTIN…              [spinner]       │
│ Role ▾ All  Kind ▾ All  Status ▾ All  State ____                  │
├─ Grid of shop cards ────────────────────────────────────────────┤
│ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐   │
│ │ Demo Shop        │ │ Mumbai Branch    │ │ Pune Outlet      │   │
│ │ [ADMIN] [ACTIVE] │ │ [MANAGER]        │ │ [EMPLOYEE]       │   │
│ │ ✓ You're here    │ │                  │ │                  │   │
│ │ GSTIN 27ABCDE…   │ │ GSTIN 27ZZZZZ…   │ │ no GSTIN         │   │
│ │ Mumbai, MH       │ │ Mumbai, MH       │ │ Pune, MH         │   │
│ │ today: 18 orders │ │ today: 6 orders  │ │ today: 3         │   │
│ │ ₹46,200 · ₹0 R   │ │ ₹38k · ₹12k R    │ │ ₹8,200           │   │
│ │            [Open]│ │ [Switch] [Open]  │ │ [Switch]         │   │
│ └──────────────────┘ └──────────────────┘ └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Shop Detail — `/dashboard/shop/:shopId`

```
┌─ ← My Shops ────────────────────────────────────────────────────┐
├─ Header card ───────────────────────────────────────────────────┤
│ Demo Shop  [SELF_OPERATED] [ACTIVE] [GSTIN 27…] [ADMIN] [✓ here] │
│ Description                                                      │
│ Mumbai, Maharashtra        [Edit] [Delete] (admin-only)          │
├─ [Overview][Team & Roles][Settings][Danger (admin)] ────────────┤
│ Overview tab:                                                    │
│  ┌─ Contact ─────────┐ ┌─ GST & Tax ────┐                        │
│  ┌─ Address ─────────┐ ┌─ Branding ─────┐                        │
│ Team tab:  member table (see 5.3)                                │
│ Settings:  read-only preferences + link to Edit                  │
│ Danger:    "Delete this shop" with explainer                     │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 Team & Roles tab

```
┌─ Members (3)                                  [+ INVITE MEMBER] ┐
│ Name              Email                Roles            Actions │
│ ─────────────────────────────────────────────────────────────── │
│ Admin User        admin@sms.com        [ADMIN ▾]          🗑    │
│ Ops Manager       ops@sms.com          [MANAGER ▾]        🗑    │
│ Sales Rep         sales@sms.com        [EMPLOYEE ▾]       🗑    │
└─────────────────────────────────────────────────────────────────┘

Invite modal:
┌─ Invite member ───────────────────────  ✕ ──┐
│ Email *                                      │
│ First name        Last name                  │
│ Roles ▾ [Manager] [Employee]                 │
│ (existing users linked instantly; new emails  │
│  create a pending user)                      │
│                          [Cancel]  [Invite]  │
└─────────────────────────────────────────────┘
```

### 5.4 Add / Edit Shop — `/dashboard/shop/add` · `/dashboard/shop/:id/edit`

Two-column layout (`lg` breakpoint and above). Left column stacks Identity →
GST & Tax → Address. Right column is the full-height Contact card. Preferences
spans the full width below both columns.

```
┌─ Left column ───────────────────┐  ┌─ Right column (Contact) ────────┐
│ ┌─ Identity ──────────────────┐ │  │                                  │
│ │ Shop Name *    Status       │ │  │  Phone           Email           │
│ │ ┌──────────┐  ┌──────────┐  │ │  │  ┌───────────┐  ┌───────────┐   │
│ │ │          │  │ ACTIVE ▾ │  │ │  │  │ 🇮🇳 +91   │  │           │   │
│ │ └──────────┘  └──────────┘  │ │  │  └───────────┘  └───────────┘   │
│ │ Description                 │ │  │                                  │
│ │ ┌─────────────────────────┐ │ │  │  Contact Person  Designation    │
│ │ │                         │ │ │  │  ┌───────────┐  ┌───────────┐   │
│ │ └─────────────────────────┘ │ │  │  │           │  │           │   │
│ └─────────────────────────────┘ │  │  └───────────┘  └───────────┘   │
│                                 │  │                                  │
│ ┌─ GST & Tax ─────────────────┐ │  │  Alternate Phones               │
│ │ GSTIN          Legal Name   │ │  │  [+91 9876 ✕] [+91 1234 ✕]      │
│ │ ┌──────────┐  ┌──────────┐  │ │  │  [+ Add phone]                  │
│ │ │          │  │          │  │ │  │  ↳ (input row appears on click) │
│ │ └──────────┘  └──────────┘  │ │  │                                  │
│ │ PAN            State        │ │  │  Alternate Emails               │
│ │ ┌──────────┐  ┌──────────┐  │ │  │  [alt@co.in ✕] [other@co ✕]    │
│ │ │          │  │          │  │ │  │  [+ Add email]                  │
│ │ └──────────┘  └──────────┘  │ │  │  ↳ (input row appears on click) │
│ └─────────────────────────────┘ │  │                                  │
│                                 │  │  Additional Contact Persons      │
│ ┌─ Address ───────────────────┐ │  │  [+ Add contact person]         │
│ │ Address Line 1              │ │  │  ┌───────────────────────────┐  │
│ │ ┌─────────────────────────┐ │ │  │  │ ▶ John Doe · Manager  🗑  │  │
│ │ │                         │ │ │  │  ├───────────────────────────┤  │
│ │ └─────────────────────────┘ │ │  │  │ ▼ Jane S · Director   🗑  │  │
│ │ City   State   State code   │ │  │  │   Name     │ Designation  │  │
│ │ ┌────┐ ┌────┐  ┌──────────┐ │ │  │  │   Phone    │ Email        │  │
│ │ │    │ │    │  │          │ │ │  │  └───────────────────────────┘  │
│ │ └────┘ └────┘  └──────────┘ │ │  └──────────────────────────────────┘
│ │ Country    Pin Code         │ │
│ │ ┌────────┐ ┌──────────┐    │ │
│ │ │India ▾ │ │          │    │ │
│ │ └────────┘ └──────────┘    │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘

┌─ Preferences (full width) ──────────────────────────────────────┐
│  Currency          Timezone              Billing Email           │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ INR        ▾ │  │ Asia/Kolkata   ▾ │  │                   │  │
│  └──────────────┘  └──────────────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

                                                    [Save Changes]
```

**Alternate phone/email chips** — inline chips with inline add flow:
```
[chip ✕]  [chip ✕]  [+ Add phone]
                        ↓ on click
[________________________]  [Add]  [Cancel]
```

**Contact person accordion** — collapsed row / expanded row:
```
▶  John Doe · Manager                          [🗑]   ← collapsed
▼  Jane Smith · Director                       [🗑]   ← expanded
   Name [__________]   Designation [__________]
   Phone [🇮🇳 +91 ___]  Email [________________]
```

On screens narrower than `lg`, all five cards stack into a single column.

### 5.5 Header shop switcher

```
┌─ 🏪 Demo Shop ▾ ─────────┐
│ Popover:                  │
│ ┌───────────────────────┐ │
│ │ 🔍 Search my shops…   │ │
│ │ ── Recently used ──   │ │
│ │ • Mumbai Branch       │ │
│ │ • Pune Outlet         │ │
│ │ ── All shops ──       │ │
│ │ ✓ Demo Shop  [Admin]  │ │
│ │   Mumbai Br. [Manager]│ │
│ │   Pune Out.  [Empl.]  │ │
│ │ ─────────────────     │ │
│ │ + Add new shop        │ │
│ │ → Manage shops        │ │
│ └───────────────────────┘ │
└──────────────────────────┘
```

---

## 6. Form validation & payload contract

### 6.1 What the form collects vs what the schema stores

`GstDetails` has 10 fields in the Mongoose schema. The `ShopEditForm`
only shows — and therefore only submits — 4 of them:

| Field | In form | Required by backend |
|---|---|---|
| `gstin` | ✅ | ✅ required |
| `legalName` | ✅ | ✅ required |
| `panCardNumber` | ✅ | ✅ required |
| `state` | ✅ (auto-filled from GSTIN) | ✅ required |
| `tradeName` | ✗ | ✗ optional |
| `address` | ✗ | ✗ optional |
| `registrationDate` | ✗ | ✗ optional |
| `status` | ✗ | ✗ optional |
| `username` | ✗ | ✗ optional |
| `email` | ✗ | ✗ optional |

The 6 hidden fields are populated by a future GST verification flow (e.g. calling the GST API with the GSTIN). Until that flow exists they remain absent from the DB. Their `@IsOptional()` in the DTO and `required: false` in the Mongoose schema reflect this intentional deferral.

**Do not** re-add `required: true` / `@IsNotEmpty()` to those 6 fields without also adding form inputs for them.

### 6.2 Payload sanitization (`ShopApi`)

`ShopApi.addShop` and `ShopApi.updateShop` both call `sanitizeShopPayload()`
before sending to the backend. It does two things:

1. **Whitelist** — only the 19 keys present in `CreateShopDto` are sent.
   Strips read-only / computed fields that come from the API response:
   `_id`, `suppliers`, `isDeleted`, `deletedAt`, `createdAt`,
   `updatedAt`, `myRoles`.
2. **Drop empty-string emails** — `email` and `billingEmail` are
   omitted (not sent as `""`) when the user leaves them blank.
   The backend's `@IsEmail()` validator rejects `""`.

This whitelist is defined once in `shop.api.ts` as `SHOP_WRITABLE_KEYS`.
Update it if `CreateShopDto` gains new fields.

### 6.3 Yup schema gotchas

The `locationSchema` and `gstDetailsSchema` in `shop-edit-form.component.tsx`
have several non-obvious rules:

| Field | Why non-obvious |
|---|---|
| `location.stateCode` | `.matches(/^[0-9]{2}$/).optional()` would fail on `""`. A `.transform((v) => v \|\| undefined)` converts the empty string to `undefined` so `.optional()` passes. |
| `location.countryRef` / `stateRef` | These are set to `null` (not `undefined`) by the cascade-reset handlers. `.nullable().optional()` is required — `.optional()` alone rejects `null`. |
| `gstDetails.*` hidden fields | Marked `.optional()` in yup — they're absent from the submission and must not be `.required()`. |
| `email` / `billingEmail` | Validated as email format. Empty string fails `@IsEmail()` on the backend, so they're stripped in `sanitizeShopPayload` rather than validated in yup. |

---

## 7. Caveats & known follow-ups

1. **`ShopEditForm` name is now misleading** — it powers Add too.
   Renaming to `ShopForm` is blocked by the legacy `<ShopForm>` still
   used by `shop-setup.page.tsx`. Once that wizard is migrated, do
   the rename in one pass.
2. **Invite-by-email** creates a pending user with no password. There's
   no email send-out yet — the inviter has to share the signup link
   manually. Wire a real invite-email service later.
3. **Soft-delete is one-way from the UI.** No "Deleted shops" admin
   view; restore must be done manually in Mongo.
4. **Delete refuses any orders.** That guard is intentionally loud — we
   don't want anyone losing GST records to a stray click. Mark a shop
   `INACTIVE` instead when you want to retire it.
5. **`getMyShopsStats.outstandingPayable`** sums each shop's
   `suppliers[].stats.outstandingPayable`. That stats subdoc is only
   updated when the future PO/GRN module fires `onPurchaseRecorded`;
   today it stays 0.
6. **`logo` upload UI** isn't built yet — the schema and the read path
   render it, but Edit doesn't expose a picker. Hook into the existing
   media-storage flow when needed.
7. **`useGetShop` for the Edit page** uses the cached `myRoles` for the
   permission gate. If you change a user's roles in another tab, you
   may need to refetch before edits go through.
8. **Header switcher search is client-side only.** Fine for typical
   user counts (≤ 50 shops). If anyone ends up with hundreds, switch
   it to a `useMyShops(q)` call.
9. **GSTIN verification not yet built.** The `GstDetails` schema stores
   `verifiedAt`, `address`, `status`, `registrationDate`, etc. but
   the form does not yet call the GST portal to populate them. Full
   plan in `docs/gst-verification.md`.

---

## 8. File map (quick jump)

Backend
```
backend/src/api/shop/
├── shop.controller.ts        — /mine, /mine/stats, /, /:shopId, /:shopId/members*
├── shop.service.ts           — myShops aggregations, members CRUD, soft-delete
├── shop.module.ts            — registers Shop + User mongoose models
├── enum/
│   ├── shop-kind.enum.ts
│   └── shop-status.enum.ts   — new
├── dto/
│   ├── create-shop.dto.ts    — extended (status, description, logo, currency,
│   │                            timezone, billingEmail)
│   └── update-shop.dto.ts
└── schema/
    ├── shop.schema.ts        — kind, status, description, logo, currency,
    │                            timezone, billingEmail
    └── gst-details.schema.ts — address/state/registrationDate/status/username/email
                                 are required:false (only gstin, legalName, panCardNumber,
                                 tradeName are required/present in the edit form)
```

Frontend
```
frontend/src/features/shop/
├── components/
│   ├── shop-card.component.tsx          — All My Shops grid card
│   ├── shop-switcher.component.tsx      — header popover (replaces legacy dropdown)
│   ├── shop-edit-form.component.tsx     — sectioned form for Edit
│   ├── shop-members-tab.component.tsx   — Detail page Team tab
│   ├── invite-member-modal.component.tsx
│   ├── shop-form.component.tsx          — legacy form (used by Add wizard)
│   └── …
├── hooks/
│   ├── use-my-shops.hook.ts
│   ├── use-my-shops-stats.hook.ts
│   ├── use-get-shop.hook.ts
│   ├── use-update-shop.hook.ts
│   ├── use-delete-shop.hook.ts
│   ├── use-shop-members.hook.ts
│   ├── use-invite-member.hook.ts
│   ├── use-update-member-role.hook.ts
│   ├── use-remove-member.hook.ts
│   ├── use-recent-shops.hook.ts
│   └── use-add-shop.hook.ts (existing)
└── interface/
    ├── shop.interface.ts                — Shop + MyShopRow + ShopMember + …
    └── shop-form.interface.ts

frontend/src/pages/dashboard/shop/
├── all-shops.page.tsx        — All My Shops
├── shop-detail.page.tsx      — Detail (Overview/Team/Settings/Danger tabs)
├── edit-shop.page.tsx        — Edit
├── add-shop.page.tsx         — existing wizard
└── shop-setup.page.tsx       — first-shop-on-signup wizard

frontend/src/shared/enums/
├── shop-kind.enum.ts
├── shop-status.enum.ts       — new
└── user-role.enum.ts         — new

frontend/src/shared/api/shop.api.ts      — full surface (mine, stats, crud, members);
                                           sanitizeShopPayload() strips read-only fields
                                           + empty emails before every POST/PATCH

frontend/src/features/dashboard/components/
├── dashboard-header.component.tsx       — mounts <ShopSwitcher /> now
└── shop-select-dropdown.component.tsx   — legacy, no longer mounted
```

---

## 9. Phase status snapshot

| Phase | Description | Status |
|---|---|---|
| 1 | Shop schema fields + endpoints (/mine, /mine/stats, /:shopId, members, soft-delete) | ✅ shipped |
| 2 | Frontend pages: All My Shops, Detail (Overview), Edit, Team & Roles | ✅ shipped |
| 3 | Header shop-switcher with search + recents | ✅ shipped |
| 4 | Add Shop sectioned form (replace legacy wizard) | ✅ shipped — Add Shop now reuses `<ShopEditForm>` |
| 5 | Logo upload UI, email-driven invites, cross-shop analytics page | 🔲 deferred |
| 6 | Permission-aware UI gating across the rest of the app via `useActiveShopRole()` | 🔲 deferred |
| 7 | Currency / timezone applied throughout money helpers and date formatters | 🔲 deferred |
