# GST — Feature Reference

Current reference for how GST data is captured on a Shop. Read this before
touching `GstDetails`, the shop GST form, shop response serialization, or the
`GstModule`/`GstAuthClient` client.

> **History:** an OTP-based GSTIN verification flow (Whitebooks portal) was
> built and then **removed**. GST is now **manual-entry only**. The generic
> `GstModule` / `GstAuthClient` (Whitebooks HTTP client) is **retained** for a
> future verification/e-invoice/e-way-bill rebuild — it is not wired to any
> endpoint today. See §5 for exactly what was removed.

---

## 1. What this feature does

A shop admin enters their GST identity by hand on the Edit Shop form
(`/dashboard/shop/:shopId/edit`, GST & Tax section). Four fields are stored:

| Field | Notes |
|---|---|
| `gstin` | 15-char GSTIN, validated against the standard regex |
| `legalName` | registered legal name (manual) |
| `panCardNumber` | auto-filled from `gstin[2..12]`; editable |
| `state` | auto-filled from `gstin[0..1]` → state name (via the location states list); editable |

There is **no** OTP flow, no portal lookup, no locked/verified state, and no
session token. Whatever the admin types is what gets saved.

---

## 2. Backend

### 2.1 Schema — `gst-details.schema.ts`

```ts
@Schema({ _id: false })
export class GstDetails {
  @Prop({ type: String, required: true })  gstin: string;
  @Prop({ type: String, required: false }) legalName?: string;
  @Prop({ type: String, required: false }) panCardNumber?: string;
  @Prop({ type: String, required: false }) state?: string;
}
```

Embedded on `Shop.gstDetails` (optional — a shop may have no GST details).

### 2.2 DTO — `gst-details.dto.ts`

`GstDetailsDto` validates the same four fields: `gstin` required (`@Length(15,15)`),
`legalName`/`panCardNumber`(`@Length(10,10)`)/`state` optional. Used inside
`CreateShopDto.gstDetails` / `UpdateShopDto`.

### 2.3 Cross-shop GSTIN uniqueness (kept)

One GSTIN per shop across the collection. Enforced two ways in
`backend/src/api/shop/`:

- **Index** (`shop.schema.ts`): `ShopSchema.index({ 'gstDetails.gstin': 1 }, { unique: true, sparse: true })` — sparse so shops without a GSTIN are unaffected.
- **Service guard** (`shop.service.ts → assertGstinUnique`): `createShop` and
  `updateShop` throw `ConflictException` if the GSTIN already belongs to another
  shop. On update, the current shop is excluded.

This is plain data integrity (not part of the removed OTP flow).

### 2.4 Clean responses — `shop-response.dto.ts`

`toShopResponse(doc, myRoles)` is applied by `ShopController` to `GET /:shopId`,
`POST /`, `PATCH /:shopId`. It:
- runs `doc.toJSON()` when available,
- strips internal fields (`suppliers`, `isDeleted`, `deletedAt`, `__v`),
- returns `gstDetails` as `GstDetailsSummaryDto` = `{ gstin, legalName, panCardNumber, state }`.

### 2.5 `GstModule` (retained, unused by shop)

`backend/src/api/gst/` keeps `GstAuthClient` + a generic `GST_API` axios provider
(Whitebooks base URL + client credentials from `gst.config.ts`). It is exported
and imported by `ShopModule`/`AppModule` but **nothing calls it** — it's the
foundation for a future GST integration. Leave it in place.

---

## 3. Frontend

- **Form** — `features/shop/components/shop-edit-form.component.tsx`, GST & Tax
  `FormContainer`: a GSTIN field plus Legal Name / PAN / State. A `useEffect` on
  the watched `gstin` auto-fills `panCardNumber` (`gstin[2..12]`) and `state`
  (state-code → name via `useStatesByCountry("IN")`) when the GSTIN is 15 valid
  chars.
- **Yup** — `gstDetailsSchema` validates `gstin` (15, regex, required) +
  optional `legalName`/`panCardNumber`(10)/`state`. The whole `gstDetails` object
  transforms to `undefined` when every field is blank, so an empty section is
  omitted from the payload.
- **Payload sanitization** — `shared/api/shop.api.ts → sanitizeGstDetails`
  whitelists `GST_DETAILS_WRITABLE_KEYS = ["gstin","legalName","panCardNumber","state"]`.
- **Interface** — `features/shop/interface/shop.interface.ts → ShopGstDetails`
  has just those four optional fields.
- **Detail read view** — `pages/dashboard/shop/shop-detail.page.tsx` shows GSTIN,
  Legal Name, PAN, State as read-only rows.

---

## 4. Tests

- `frontend/e2e/shop.spec.ts` — "Add Shop form" asserts PAN auto-fill from GSTIN;
  "Edit Shop — GST & Tax section" asserts the GSTIN + manual fields render, PAN
  auto-fills, **no** "Send OTP" button exists, and a shop can be saved without GST.
- `frontend/e2e/helpers/mocks.ts` no longer stubs GST endpoints (only Cloudinary).
- Seeder (`docker/seed/seed.js`) sets only `{ gstin, legalName, panCardNumber, state }`
  on external-supplier shops.

---

## 5. What was removed (for anyone chasing old references)

Backend (`src/api/shop/`):
- `gst-verification.service.ts`, `gst-reverify.scheduler.ts` (+ `ScheduleModule` wiring in `ShopModule`)
- `dto/gst-verify.dto.ts` (`OtpRequestDto`/`OtpVerifyDto`/`NormalizedGstDetailsDto`)
- `enum/constitution-of-business.enum.ts`, `enum/gst-status.enum.ts`, the inline `GstStatus`
- the `POST /:shopId/gst/request-otp` and `POST /:shopId/gst/verify` endpoints
- `GstDetails` props: `tradeName`, `address`, `registrationDate`, `status`,
  `constitutionOfBusiness`, `einvoiceApplicable`, `natureOfBusiness`, `verifiedAt`,
  `username`, `email`, `gstSessionToken`, `gstSessionExpiresAt`
- the `verifiedAt`-based "lock enforcement" branch in `updateShop`
- the session-token stripping in `toShopResponse`

Backend (`src/api/gst/`): the verification-specific clients/interfaces
(`gst-public`, `gst-return`, `gst-ledger`, `gst-eway-bill`, taxpayer/return
interfaces). `GstAuthClient` + the generic `GST_API` provider remain.

Frontend:
- `hooks/use-request-gst-otp.hook.ts`, `hooks/use-verify-gst-otp.hook.ts`
- `components/gst-verify-panel.component.tsx`
- `ShopApi.requestGstOtp` / `ShopApi.verifyGstOtp`
- the OTP state machine + verified panel + portal-credential fields in the form
- `ConstitutionOfBusiness` enum and the verify-only fields on `ShopGstDetails`

Tests/docs:
- `e2e/gst-verification.spec.ts`, the GST visual snapshot, the GST OTP cases in
  `shop.spec.ts`, the `mockGst` helper.

---

## 6. If you rebuild GST verification later

The pieces left standing to build on:
- `GstAuthClient` + `GST_API` axios provider (Whitebooks auth/OTP calls).
- `gst.config.ts` (base URL, client id/secret, ip address, timeout).
- Cross-shop GSTIN uniqueness already enforced.

Re-introduce a verification service + endpoints, re-add the portal-derived fields
to `GstDetails`, and gate them read-only after verification. The removed
implementation is in git history (see the commit that removed OTP verification).
