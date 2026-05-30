# GST Verification — Feature Plan

Plan for verifying a shop's GSTIN via the Whitebooks GST API (OTP-based
authenticated flow), fetching all registered taxpayer data, storing it
locked and non-editable on the shop, enforcing cross-shop GSTIN uniqueness,
tightening API response DTOs, and laying the groundwork for automated GST
return filing via recorded orders.

Status: **shipped** — all 5 phases implemented. Read this before touching any
GST verification, `GstDetails` schema, shop response serialization, or the GST
return pipeline.

---

## 1. Goals

1. **OTP-based GSTIN verification** — admin enters GSTIN, requests an OTP
   from the GST portal, enters the OTP, and the backend exchanges it for a
   session token + full taxpayer record.
2. **Lock verified fields** — after verification, `legalName`, `tradeName`,
   `panCardNumber`, `state`, `address`, `registrationDate`, and `status` become
   read-only in the form. Only the GSTIN itself and GST-portal credentials
   (`username`, `email`) remain editable.
3. **Cross-shop GSTIN uniqueness** — the same GSTIN cannot be registered to
   two shops. Enforced at the DB index level and in the service layer.
4. **Clean API responses** — all shop endpoints return an explicit
   `ShopResponseDto` that excludes internal/operational fields (`suppliers`,
   `isDeleted`, `deletedAt`, `__v`) that have no business being in the
   client payload.
5. **GST filing foundation** — the session token obtained during OTP
   verification is stored (encrypted) and reused by the future GST return
   pipeline. The `GstReturnClient` already has the return-filing methods;
   this feature connects the credential layer.
6. **Automatic re-verification** — a scheduled job re-verifies all active
   shops monthly so status changes (Active → Suspended) are caught without
   manual action.

## 2. Non-goals (v1)

- Actual GSTR-1 / GSTR-3B filing UI (separate future module — this plan
  only lays the credential and data foundation).
- E-way bill generation.
- Multi-GSTIN per shop (one shop ↔ one GSTIN).

---

## 3. Enums — `ConstitutionOfBusiness`

The GST portal's `ctb` field carries a fixed set of values. Store as an
enum, not a free string.

```ts
// backend/src/api/shop/enum/constitution-of-business.enum.ts
export enum ConstitutionOfBusiness {
  PROPRIETORSHIP            = 'Proprietorship',
  PARTNERSHIP               = 'Partnership',
  HINDU_UNDIVIDED_FAMILY    = 'Hindu Undivided Family',
  PRIVATE_LIMITED_COMPANY   = 'Private Limited Company',
  PUBLIC_LIMITED_COMPANY    = 'Public Limited Company',
  LLP                       = 'Limited Liability Partnership',
  TRUST                     = 'Trust',
  ASSOCIATION_OR_BOI        = 'Association of Persons or Body of Individuals',
  LOCAL_AUTHORITY           = 'Local Authority',
  STATUTORY_BODY            = 'Statutory Body',
  GOVERNMENT_DEPARTMENT     = 'Government Department',
  SOCIETY_OR_CLUB           = 'Society or Club',
  OTHERS                    = 'Others',
}
```

Map `ctb` from the raw API response to this enum
(case-insensitive prefix match; fall through to `OTHERS` if unrecognised).

---

## 4. Whitebooks API — OTP flow

The existing `GstAuthClient` already has all required methods.

### 4.1 Step 1 — Request OTP

```
POST /auth/otp   body: { gstin }
```

The GST portal sends an OTP to the mobile number / email registered for
that GSTIN. No response data needed — just a 200 confirms the request was
accepted.

### 4.2 Step 2 — Validate OTP + get token

```
POST /auth/validate-otp   body: { gstin, otp }
```

On success, returns a session token (short-lived, typically 6 hours).
Store the token in the shop document (see §5.3).

### 4.3 Step 3 — Fetch taxpayer record

Use the session token to call the public search (the authenticated version
returns more complete data than the anonymous call):

```
GET /public/search?gstin=<GSTIN>&email=<email>
```

The response conforms to `GstPublicSearchTaxpayerResponse` (already
defined at `backend/src/api/gst/interfaces/public-search-taxpayer-response.interface.ts`).

### 4.4 Raw response → `GstDetails` mapping

The full `pradr.addr` shape from the interface:

```
{ bnm, bno, flno, st, loc, dst, pncd, stcd, landMark, lt, locality, geocodelvl, lg }
```

Assemble address string:
```
[flno] [bno] [bnm], [st], [loc], [dst], [stcd] - [pncd]
```
(Skip blank parts; join non-empty with ", ".)

| API field | `GstDetails` field | Notes |
|---|---|---|
| `data.gstin` | `gstin` | echo |
| `data.lgnm` | `legalName` | |
| `data.tradeNam` | `tradeName` | may be empty |
| `data.gstin[2:12]` | `panCardNumber` | PAN is always chars 3–12 |
| `data.rgdt` | `registrationDate` | parse `dd/mm/yyyy` → ISO Date |
| `data.sts` | `status` | map to `GstStatus` enum |
| assembled from `pradr.addr` | `address` | see above |
| `data.stj` or stateCode lookup | `state` | extract from "State - <Name> - …" prefix; fall back to `gstin[0:2]` → state name via location collection |
| `data.ctb` | `constitutionOfBusiness` | map to `ConstitutionOfBusiness` enum |
| `data.einvoiceStatus === "Yes"` | `einvoiceApplicable` | boolean |
| `data.nba` | `natureOfBusiness` | `string[]` |
| `Date.now()` | `verifiedAt` | timestamp of this verification |

Fields NOT populated by the API (`username`, `email`): these are GST portal
login credentials, entered manually by the admin and stored separately.

---

## 5. Backend changes

### 5.1 Schema — `gst-details.schema.ts`

Full schema after changes:

```ts
import { ConstitutionOfBusiness } from '../enum/constitution-of-business.enum';

@Schema({ _id: false })
export class GstDetails {
  // ── Required (always provided by admin) ─────────────────────────
  @Prop({ type: String, required: true })
  gstin: string;

  // ── Portal-locked (populated + locked after OTP verify) ─────────
  @Prop({ type: String, required: false })
  legalName?: string;

  @Prop({ type: String, required: false })
  tradeName?: string;

  @Prop({ type: String, required: false })
  panCardNumber?: string;

  @Prop({ type: String, required: false })
  address?: string;

  @Prop({ type: String, required: false })
  state?: string;

  @Prop({ type: Date, required: false })
  registrationDate?: Date;

  @Prop({ type: String, enum: GstStatus, required: false })
  status?: GstStatus;

  @Prop({ type: String, enum: ConstitutionOfBusiness, required: false })
  constitutionOfBusiness?: ConstitutionOfBusiness;   // ← enum, not string

  @Prop({ type: Boolean, required: false })
  einvoiceApplicable?: boolean;

  @Prop({ type: [String], required: false })
  natureOfBusiness?: string[];

  @Prop({ type: Date, required: false })
  verifiedAt?: Date;                 // when OTP verify last succeeded

  // ── GST portal credentials (admin-managed) ───────────────────────
  @Prop({ type: String, required: false })
  username?: string;

  @Prop({ type: String, required: false })
  email?: string;

  // ── Auth session (filing foundation) ─────────────────────────────
  @Prop({ type: String, required: false, select: false }) // never sent to client
  gstSessionToken?: string;

  @Prop({ type: Date, required: false, select: false })
  gstSessionExpiresAt?: Date;
}
```

Note: `gstSessionToken` and `gstSessionExpiresAt` have `select: false` —
Mongoose will never include them in query results unless explicitly projected.
They never reach the client.

### 5.2 GSTIN uniqueness — `shop.schema.ts`

Add a **sparse unique index** on `gstDetails.gstin`. Sparse means it only
applies to documents where the field exists, so shops without a GSTIN are
unaffected:

```ts
// shop.schema.ts — after SchemaFactory.createForClass
ShopSchema.index({ 'gstDetails.gstin': 1 }, { unique: true, sparse: true });
```

Service-layer guard in `ShopService.createShop` and `updateShop`:

```ts
// Before save / update:
if (dto.gstDetails?.gstin) {
  const conflict = await this.shopModel.findOne({
    'gstDetails.gstin': dto.gstDetails.gstin,
    _id: { $ne: shopId },   // on update: exclude self
  });
  if (conflict) {
    throw new ConflictException(
      `GSTIN ${dto.gstDetails.gstin} is already registered to another shop.`
    );
  }
}
```

### 5.3 New service — `GstVerificationService`

```
backend/src/api/shop/gst-verification.service.ts
```

Methods:

```ts
/** Step 1 — fire OTP to the registered mobile on the GST portal */
async requestOtp(gstin: string): Promise<void>

/** Step 2 — validate OTP, fetch taxpayer, store session + data */
async verifyWithOtp(
  shopId: string,
  gstin: string,
  otp: string,
  email: string,   // for the /public/search call
): Promise<NormalizedGstDetails>

/** Called by the scheduler — re-verify without OTP using the stored token */
async reVerify(shopId: string): Promise<NormalizedGstDetails | null>
```

`verifyWithOtp` flow:
1. `GstAuthClient.validateOtp({ gstin, otp })` → get session token + expiry.
2. Store `gstSessionToken` + `gstSessionExpiresAt` on the shop (direct
   `findByIdAndUpdate` — never goes through the DTO/whitelist path).
3. `GSTPublicClient.searchTaxpayer(gstin, email)` — fetch taxpayer record.
4. Normalise raw response → `NormalizedGstDetails`.
5. Return `NormalizedGstDetails` to controller; controller passes it to
   `ShopService.patchGstDetails(shopId, normalised)` which writes the
   locked fields + `verifiedAt`.

`reVerify` flow:
1. Load shop (select `gstDetails.gstSessionToken`, `gstDetails.gstSessionExpiresAt`).
2. If token absent or expired → mark shop with `gstVerificationStatus: 'token_expired'`
   and skip (can't re-verify without a fresh OTP).
3. Otherwise, call `GSTPublicClient.searchTaxpayer(gstin, email)` with the
   stored token in headers.
4. Normalise + write locked fields + `verifiedAt`.

### 5.4 New endpoints

Both added to `ShopController`. Require `@Roles(UserRole.ADMIN)`.

```
POST /api/v1/shop/:shopId/gst/request-otp
  body: { gstin: string }
  → 204 No Content on success

POST /api/v1/shop/:shopId/gst/verify
  body: { gstin: string; otp: string; email?: string }
  → 200 NormalizedGstDetailsDto
```

The `verify` endpoint writes the verified data directly to the DB via
`GstVerificationService`. It does **not** wait for a subsequent save-form
call — verification is an atomic server-side action, not a two-step
frontend-assemble-then-save flow.

This means the frontend only needs to:
1. Call `POST /gst/request-otp` → show OTP input.
2. Call `POST /gst/verify` → refresh the shop data (refetch).
3. Display the now-locked fields from the refreshed shop.

The regular `PATCH /:shopId` cannot overwrite locked fields — see §5.5.

### 5.5 Lock enforcement in `ShopService.updateShop`

Locked fields must not be writable via the normal `PATCH /:shopId` endpoint
after verification. Strip them from the incoming DTO when `verifiedAt` is set:

```ts
async updateShop(shopId: string, dto: UpdateShopDto): Promise<Shop> {
  const existing = await this.shopModel.findById(shopId).lean();
  if (existing?.gstDetails?.verifiedAt && dto.gstDetails) {
    // Verified — only allow updating credentials, not portal data
    const { username, email } = dto.gstDetails;
    dto.gstDetails = { username, email } as any;
  }
  // ... proceed with update
}
```

### 5.6 Scheduled re-verification — `GstReverifyScheduler`

```
backend/src/api/shop/gst-reverify.scheduler.ts
```

Uses `@nestjs/schedule` (`@Cron` decorator). Run monthly on the 1st at 03:00:

```ts
@Cron('0 3 1 * *')  // 03:00 on 1st of every month
async reverifyAll(): Promise<void> {
  const shops = await this.shopModel
    .find({ 'gstDetails.gstin': { $exists: true } })
    .select('_id gstDetails.gstin gstDetails.email gstDetails.gstSessionToken gstDetails.gstSessionExpiresAt')
    .lean();

  for (const shop of shops) {
    await this.gstVerificationService.reVerify(shop._id.toString())
      .catch(err => this.logger.warn(`Re-verify failed for ${shop._id}: ${err.message}`));
    // Small delay between calls to respect Whitebooks rate limits
    await sleep(2000);
  }
}
```

Install `@nestjs/schedule` and add `ScheduleModule.forRoot()` to `AppModule`.

### 5.7 Response DTOs — shop endpoints

Currently all shop endpoints return raw Mongoose lean documents, leaking
`suppliers`, `isDeleted`, `deletedAt`, `__v`, and the internal `gstSessionToken`.

#### `ShopResponseDto`

Returned by `GET /:shopId`, `POST /`, `PATCH /:shopId`.

```ts
// backend/src/api/shop/dto/shop-response.dto.ts
export class GstDetailsSummaryDto {
  gstin: string;
  legalName?: string;
  tradeName?: string;
  panCardNumber?: string;
  address?: string;
  state?: string;
  registrationDate?: string;
  status?: string;
  constitutionOfBusiness?: string;
  einvoiceApplicable?: boolean;
  natureOfBusiness?: string[];
  verifiedAt?: string;
  username?: string;
  email?: string;
  // gstSessionToken intentionally omitted
}

export class ShopResponseDto {
  _id: string;
  name: string;
  kind: string;
  status: string;
  description?: string;
  logo?: string;
  currency: string;
  timezone: string;
  billingEmail?: string;
  location?: object;
  gstDetails?: GstDetailsSummaryDto;
  phone?: string;
  email?: string;
  alternatePhones: string[];
  alternateEmails: string[];
  contactPersonName?: string;
  contactPersonDesignation?: string;
  contactPersons: object[];
  myRoles?: string[];        // attached at read time, not persisted
  createdAt: string;
  updatedAt: string;
  // suppliers, isDeleted, deletedAt, __v intentionally omitted
}
```

#### `ShopSummaryDto`

Returned by `GET /mine` (list view — no gstDetails, no contacts array):

```ts
export class ShopSummaryDto {
  _id: string;
  name: string;
  kind: string;
  status: string;
  logo?: string;
  currency: string;
  location?: object;
  gstin?: string;     // convenience — derived from gstDetails.gstin
  myRoles: string[];
  // todayStats attached by the service aggregation
}
```

Apply in the controller using a `toShopResponse(doc)` plain mapper function
(no `ClassSerializerInterceptor` needed — simpler than decorators for
nested objects):

```ts
// shared helper
function toShopResponse(doc: any, myRoles?: string[]): ShopResponseDto {
  const { suppliers, isDeleted, deletedAt, __v, ...rest } = doc;
  if (rest.gstDetails) {
    const { gstSessionToken, gstSessionExpiresAt, ...gst } = rest.gstDetails;
    rest.gstDetails = gst;
  }
  return { ...rest, myRoles };
}
```

Wire into every controller method that currently returns a raw document.

---

## 6. Frontend changes

### 6.1 New API methods

```ts
// shared/api/shop.api.ts
static async requestGstOtp(shopId: string, gstin: string): Promise<void> {
  await apiClient.post(`/api/v1/shop/${shopId}/gst/request-otp`, { gstin });
}

static async verifyGstOtp(
  shopId: string,
  gstin: string,
  otp: string,
  email?: string,
): Promise<ShopGstDetails> {
  const r = await apiClient.post(`/api/v1/shop/${shopId}/gst/verify`, {
    gstin, otp, email,
  });
  return r.data;
}
```

### 6.2 New hooks

```ts
// features/shop/hooks/use-request-gst-otp.hook.ts
export const useRequestGstOtp = (shopId: string) =>
  useMutation({
    mutationFn: ({ gstin }: { gstin: string }) =>
      ShopApi.requestGstOtp(shopId, gstin),
  });

// features/shop/hooks/use-verify-gst-otp.hook.ts
export const useVerifyGstOtp = (shopId: string) =>
  useMutation({
    mutationFn: ({ gstin, otp, email }: { gstin: string; otp: string; email?: string }) =>
      ShopApi.verifyGstOtp(shopId, gstin, otp, email),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shop', shopId] });
    },
  });
```

> **Add-Shop caveat**: on the Add Shop page, no `shopId` exists before the
> shop is saved. Resolution: require the user to save the shop first (with
> just name + contact), then verify GSTIN on the Edit page. The Add Shop
> form shows GSTIN as optional with a note: "Save the shop first, then
> verify your GSTIN from the Edit page." (See §10 open question #1.)

### 6.3 Verification state machine

The GST & Tax section uses local state — not RHF — to drive the OTP flow:

```ts
type GstVerifyStep = 'idle' | 'otp_sent' | 'verifying' | 'done' | 'error';
```

(`error` is rendered via a separate `gstVerifyError: string | null`; the step
itself is the bare union above.)

Seed from existing data on mount:
```ts
const initialStep = initial.gstDetails?.verifiedAt ? 'done' : 'idle';
```

**`verifiedGstDetails` — the freshly-verified record (race-condition fix).**
`verifyOtpMutation.mutateAsync()` *returns* the normalised taxpayer record, and
the hook's `onSuccess` then `invalidateQueries(['shop', shopId])` to refetch the
shop. That refetch is **async** — so for a beat after `step` flips to `'done'`,
`initial.gstDetails` still holds the *old* (unverified) data and the panel would
read "Not yet verified". To avoid that flash, the form stores the mutation result:

```ts
const [verifiedGstDetails, setVerifiedGstDetails] =
  useState<ShopGstDetails | null>(
    initial.gstDetails?.verifiedAt ? initial.gstDetails : null,
  );

// in handleVerifyOtp:
const result = await verifyOtpMutation.mutateAsync({ gstin, otp, email });
if (result) setVerifiedGstDetails(result as ShopGstDetails);   // show panel NOW
setGstVerifyStep('done');
```

The panel reads `verifiedGstDetails ?? initial.gstDetails ?? { gstin }`, so it
renders the verified card immediately from the mutation result and falls back to
the refetched shop (or a bare GSTIN) afterwards. It is cleared back to `null` when:
- the user clicks **Re-verify**, and
- the user edits the GSTIN away from `initialGstin.current` (the same effect that
  resets `step` to `'idle'`).

A companion effect re-seeds it from a later refetch when the shop comes back
already-verified (`initial.gstDetails.verifiedAt` set but `verifiedGstDetails`
still null), e.g. on first mount of an already-verified shop.

> Without this, the "shows verified panel after OTP verify" e2e test was flaky:
> the panel briefly showed the unverified state until the shop refetch landed.
> See `docs/e2e-test-plan.md` and `frontend/e2e/gst-verification.spec.ts`.

### 6.4 Locked fields after verification

After a successful verify (`step === 'done'`), the portal-derived fields
are displayed as **read-only info rows**, not form inputs. The RHF fields
for those are removed from the JSX. Only `gstin`, `username`, and `email`
remain as editable `<TextFieldControlled>` inputs.

Because the locked fields are no longer registered in RHF, they are also
no longer sent in the `PATCH` payload — which is intentional. The backend
owns those values after verification; the frontend cannot overwrite them.

The locked fields are shown in the `<GstVerifyPanel>` read-only card, which is
fed `verifiedGstDetails ?? initial.gstDetails ?? { gstin }` (see §6.3) so it
reflects the just-verified record without waiting for the shop refetch.

---

## 7. UI wireframes

### 7.1 GST & Tax — idle (before any verification)

```
┌─ GST & Tax ──────────────────────────────────────────────────────┐
│                                                                   │
│  GSTIN *                                                          │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 27AAACR5055K1Z7                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  [Send OTP to verify ↗]   (enabled when GSTIN = 15 chars valid)   │
│                                                                   │
│  Legal Name *              PAN *                                  │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐   │
│  │                      │  │ (auto-filled from GSTIN format)  │   │
│  └──────────────────────┘  └──────────────────────────────────┘   │
│                                                                   │
│  State *                                                          │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ⚠ GSTIN not verified — legal name and tax details               │
│    will need to be entered manually until you verify.             │
└───────────────────────────────────────────────────────────────────┘
```

`panCardNumber` is extracted from GSTIN format client-side (chars 3–12) as
a convenience preview only — the authoritative value comes from the portal.

---

### 7.2 GST & Tax — OTP sent

```
┌─ GST & Tax ──────────────────────────────────────────────────────┐
│                                                                   │
│  GSTIN *                                                          │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 27AAACR5055K1Z7                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ✉ OTP sent to your GST-registered mobile / email.               │
│    Enter the 6-digit OTP below.                                   │
│                                                                   │
│  OTP *                                                            │
│  ┌──────────────────┐                                            │
│  │                  │  [Verify ↗]   [Resend OTP]                 │
│  └──────────────────┘                                            │
│                                                                   │
│  GST-registered email (optional — needed for taxpayer lookup)     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

---

### 7.3 GST & Tax — verified (locked fields)

```
┌─ GST & Tax ──────────────────────────────────────────────────────┐
│                                                                   │
│  GSTIN *                                                          │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 27AAACR5055K1Z7                          ✓ Verified          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ✓ Last verified: 23 May 2026, 12:41 AM            [Re-verify]   │
│                                                                   │
│  ┌─ Verified from GST Portal (read-only) ─────────────────────┐   │
│  │  Legal Name      My Company Private Limited                  │  │
│  │  Trade Name      My Trade Name                               │  │
│  │  PAN             AAACR5055K                                  │  │
│  │  State           Maharashtra                                 │  │
│  │  Status          ● Active                                    │  │
│  │  Constitution    Private Limited Company                     │  │
│  │  Reg. Date       01 Apr 2018                                 │  │
│  │  e-Invoice       Applicable                                  │  │
│  │  Address         Flat 12, XYZ Bldg, MG Road, Mumbai - 400001│  │
│  │  Nature of Biz   Wholesale Business, Retail Business         │  │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                   │
│  GST Portal Username (optional)                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  GST Portal Email (optional)                                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

"Re-verify" resets to `step: 'idle'` (and clears `verifiedGstDetails`), allowing a
new OTP to be sent. The verified panel disappears and `step: 'otp_sent'` is entered
again once a fresh OTP is requested.

---

### 7.4 GST & Tax — error

```
┌─ GST & Tax ──────────────────────────────────────────────────────┐
│                                                                   │
│  GSTIN *                                                          │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 27AAACR5055K1Z7                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  OTP *                                                            │
│  ┌──────────────────┐                                            │
│  │ 123456           │  [Verify ↗]   [Resend OTP]                 │
│  └──────────────────┘                                            │
│  ✕ Invalid OTP. Please check and try again.                      │
│    (or: ✕ GSTIN not found on the GST portal.)                    │
│    (or: ✕ Verification service unavailable — try again later.)   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

### 7.5 Shop Detail — GST card (read view)

```
┌─ GST & Tax ────────────────────────────────────────────────────┐
│  GSTIN         27AAACR5055K1Z7             ✓ Verified           │
│  Legal Name    My Company Private Limited                       │
│  Trade Name    My Trade Name                                    │
│  PAN           AAACR5055K                                       │
│  Status        ● Active                                         │
│  Constitution  Private Limited Company                          │
│  State         Maharashtra                                      │
│  Reg. Date     01 Apr 2018                                      │
│  e-Invoice     Applicable                                       │
│  Address       Flat 12, XYZ Bldg, MG Road, Mumbai - 400001     │
│  Nature        Wholesale Business, Retail Business              │
│  Verified on   23 May 2026, 12:41 AM                            │
└────────────────────────────────────────────────────────────────┘
```

Unverified shops:
```
┌─ GST & Tax ────────────────────────────────────────────────────┐
│  GSTIN         27AAACR5055K1Z7   ○ Unverified                  │
│  Legal Name    My Company (entered manually)                    │
│  PAN           AAACR5055K                                       │
│  State         Maharashtra                                      │
│  ─────────────────────────────────────────────────────────────  │
│  ⚠ Tax details not verified against the GST portal.            │
│    Open Edit to verify your GSTIN.                              │
└────────────────────────────────────────────────────────────────┘
```

---

## 8. GST filing foundation

The session token stored in `gstDetails.gstSessionToken` is the key that
unlocks the private GST portal APIs (`GstReturnClient`, `GstLedgerClient`).
The future GST filing flow will:

1. Load the shop's stored session token.
2. Check `gstSessionExpiresAt` — if expired, prompt admin to re-verify via OTP.
3. Use the token to call `GstReturnClient.getReturnStatus(gstin, period)` to
   check what's due.
4. Aggregate the shop's recorded orders (from the `orders` collection) into
   GSTR-1 / GSTR-3B format.
5. Submit via `GstReturnClient`.

This plan does not build steps 3–5 — it only ensures steps 1–2 are in place
and the token is reliably stored and refreshed.

### Orders → GST return mapping (data contract for future module)

The future GST module will expect orders to carry:
- `invoiceNumber`, `invoiceDate`, `totalAmount`, `taxableValue`
- `cgst`, `sgst`, `igst`, `cess`
- `customer.gstin`, `customer.state`
- `shop.gstDetails.gstin`, `shop.location.stateCode`

Verify that `Order` schema carries all these before the GST filing module starts.
Flag any gaps to the order team before that work begins.

---

## 9. Data flow summary

```
Admin opens Edit Shop → GST & Tax section
  │
  ├── (idle) Admin types GSTIN → [Send OTP]
  │       │
  │       ▼
  │   POST /shop/:shopId/gst/request-otp { gstin }
  │       │
  │       ▼ GstAuthClient.getOtp({ gstin }) → OTP sent to GST-registered mobile
  │
  ├── Admin enters OTP → [Verify]
  │       │
  │       ▼
  │   POST /shop/:shopId/gst/verify { gstin, otp, email }
  │       │
  │       ▼ GstAuthClient.validateOtp({ gstin, otp }) → session token
  │       │
  │       ▼ GSTPublicClient.searchTaxpayer(gstin, email) → taxpayer record
  │       │
  │       ▼ normalise → write to DB (locked fields + verifiedAt + session token)
  │       │
  │       ▼ 200 NormalizedGstDetails
  │
  ├── Frontend refetches shop → displays locked GST panel
  │
  └── Admin saves form (PATCH /:shopId)
          │
          ▼ gstDetails in payload stripped to { username, email } only
            (locked fields ignored by service layer)


Scheduler (1st of month, 03:00)
  │
  ▼ Load all shops with gstin
  ▼ For each: GSTPublicClient.searchTaxpayer (using stored session token)
  ▼ Normalise + update locked fields + verifiedAt
  ▼ Log failures (token expired = skip, alert admin to re-verify)
```

---

## 10. Edge cases

| Case | Behaviour |
|---|---|
| GSTIN format invalid (< 15 chars) | "Send OTP" button disabled; no API call |
| OTP incorrect | 400 from Whitebooks; show "Invalid OTP. Try again." |
| OTP expired | 400 from Whitebooks; show "OTP expired. Resend OTP." |
| Whitebooks API timeout / 5xx | 503 from our backend; show "Verification service unavailable." |
| GSTIN not found on portal | 404 from Whitebooks → show "GSTIN not found on GST portal." |
| GSTIN already used by another shop | `ConflictException` on save; show "This GSTIN is already registered to another shop." |
| `ctb` not in `ConstitutionOfBusiness` enum | Log + store `OTHERS`; do not crash |
| `sts` from API not in `GstStatus` enum | Log + store `null`; treat as unverified status |
| `rgdt` date unparseable | Store `null`; log warning |
| `stj` missing / unparseable | Fall back: `gstin[0:2]` → state name from location collection |
| Admin edits GSTIN after verifying | Reset to `idle`; locked panel disappears; new OTP required |
| Admin saves without verifying | Allowed. `verifiedAt` = null. Badge shows "Unverified". Locked fields absent from payload. |
| Re-verify — token expired | Skip; mark `gstVerificationStatus: 'token_expired'`; send alert |
| Add Shop (no shopId yet) | Verify only available on Edit page — see §6.2 caveat |
| Shop status `Cancelled` / `Suspended` from portal | Display amber warning banner in GST card; do not block save |

---

## 11. New files

Backend
```
backend/src/api/shop/
├── gst-verification.service.ts       — OTP flow, normalisation, reVerify
├── gst-reverify.scheduler.ts         — @Cron monthly re-verification
└── enum/
    └── constitution-of-business.enum.ts

backend/src/api/shop/dto/
├── shop-response.dto.ts              — ShopResponseDto, GstDetailsSummaryDto
├── shop-summary.dto.ts               — ShopSummaryDto (list view)
└── gst-verify.dto.ts                 — NormalizedGstDetailsDto, OtpRequestDto, OtpVerifyDto
```

Frontend
```
frontend/src/features/shop/
├── hooks/
│   ├── use-request-gst-otp.hook.ts
│   └── use-verify-gst-otp.hook.ts
└── components/
    └── gst-verify-panel.component.tsx   — read-only locked-field card
```

### Modified files

Backend
```
backend/src/api/gst/gst.module.ts               — add + export GSTPublicClient
backend/src/api/shop/shop.module.ts             — import GstModule, ScheduleModule,
                                                   add GstVerificationService,
                                                   GstReverifyScheduler
backend/src/api/shop/shop.controller.ts         — add OTP endpoints; wrap all returns
                                                   in toShopResponse()
backend/src/api/shop/shop.service.ts            — GSTIN conflict check; lock enforcement
                                                   in updateShop; patchGstDetails()
backend/src/api/shop/schema/gst-details.schema.ts — constitutionOfBusiness enum;
                                                    einvoiceApplicable; natureOfBusiness;
                                                    verifiedAt; gstSessionToken (select:false);
                                                    gstSessionExpiresAt (select:false)
backend/src/api/shop/schema/shop.schema.ts      — sparse unique index on gstDetails.gstin
backend/src/api/shop/dto/gst-details.dto.ts     — constitutionOfBusiness as enum;
                                                   new optional fields
backend/src/app.module.ts                       — ScheduleModule.forRoot()
```

Frontend
```
frontend/src/features/shop/interface/shop.interface.ts   — constitutionOfBusiness enum;
                                                            new fields on ShopGstDetails
frontend/src/features/shop/components/shop-edit-form.component.tsx
    — OTP state machine; locked-field rendering; remove locked TextFields after verify;
      verifiedGstDetails state holds the mutation result so the panel renders the
      verified card immediately (no flash of "Not yet verified" before refetch) — see §6.3
frontend/src/shared/api/shop.api.ts             — requestGstOtp(), verifyGstOtp()
```

---

## 12. Phased delivery

| Phase | Scope | Status |
|---|---|---|
| **1. Schema + enum + index** | `ConstitutionOfBusiness` enum, schema additions, sparse unique index, `gst-details.dto.ts` update | �� shipped |
| **2. Response DTOs** | `ShopResponseDto`, `toShopResponse()` mapper, wire into all controller methods | ✅ shipped |
| **3. Backend OTP + verify** | `GstVerificationService`, two new endpoints, lock enforcement in `updateShop`, `GSTPublicClient` registered | ✅ shipped |
| **4. Frontend OTP flow** | State machine, "Send OTP" → OTP input → verify, `GstVerifyPanel`, hooks | ✅ shipped |
| **5. Scheduler** | `GstReverifyScheduler`, `ScheduleModule.forRoot()` in `ShopModule` | ✅ shipped |

---

## 13. Open questions before kickoff

1. **Add-Shop GSTIN verify** — confirm the decision: verify only on Edit page
   (shop must be saved first). Alternative: create the shop in a draft state,
   allow verify, then publish. Which UX is acceptable?
2. **Session token storage security** — `gstSessionToken` stored in MongoDB
   `select:false`. Is at-rest encryption required (Mongoose field encryption),
   or is the `select:false` + Atlas access controls sufficient?
3. **OTP `email` parameter** — does Whitebooks `/public/search` require the
   GST-registered email for authenticated calls, or is it ignored when a session
   token is present? Affects whether the email input is shown in the OTP form.
4. **Re-verify alert channel** — when the scheduler skips a shop due to an
   expired token, how should the admin be notified? Options: in-app badge on
   the shop detail page, email to `shop.billingEmail`, or a notification
   table in the DB (separate future work).
5. **Whitebooks rate limits** — confirm calls/minute quota for the plan tier
   before choosing the scheduler's inter-call delay and throttle settings.
6. **`username` field purpose** — currently unclear whether `GstDetails.username`
   is the GST portal login or something else. Confirm before building the UI.
   If it's the portal login, it feeds the OTP flow as the GSTIN registrant
   identity. If unused, remove it.
