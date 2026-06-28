# GST API Mapping — Government APIs ↔ WhiteBooks (GSP/ASP)

Reference for bridging the **gaps in WhiteBooks' own API documentation**. WhiteBooks
(our GSP/ASP) re-exposes the GSTN government APIs under a thinner, REST-flavoured
surface but ships only a sparse prose doc. This file reconciles three sources so you
can find, for any government GST API, the exact WhiteBooks endpoint to call — and the
handful of government APIs WhiteBooks does **not** expose.

> Read this before wiring `GstAuthClient` / the dormant `GstModule`
> (`backend/src/api/gst/`) to any real GST call. See also [[gst-verification-doc]]
> for current shop-side GST state, and `~/Downloads/gst-integration-plan.md` for the
> broader product plan.

## Sources reconciled

| Source | What it gives | Date |
|---|---|---|
| GSTN developer portal — https://developer.gst.gov.in/apiportal/ | Top-level API surfaces & categories (Taxpayer / Public / IRP) | scraped 2026-06 |
| `Released_API_List_20231218.xlsx` (GSTN) | Canonical govt API names, sandbox/prod URLs + versions, **`Available in WhiteBooks` Y/N** | 2023-12-18 |
| WhiteBooks OpenAPI spec (`GST api postman collection.json`) | **247** live WhiteBooks endpoints across 30 modules | 2025-02 |
| `WB-GST-API.postman_collection.json` | 281 WhiteBooks example requests (params/headers) | 2025-05 |
| `whitebooks-gst-api-documentation(2).docx` | WhiteBooks base URL, auth headers, endpoint shorthand | — |
| `E-INVOICE-API.postman_collection` / `E-waybill.postman_collection` | WhiteBooks IRP (e-invoice) & NIC e-way-bill surfaces | 2024-03 |
| `GST-API-Error-Codes(2).docx`, `E-invoicing-error-codes.docx`, `e_Waybill_error_codes.xlsx` | Error-code catalogues | — |

---

## 1. The three government API surfaces (from the portal)

The GSTN developer portal groups everything under three programs. WhiteBooks, as a
licensed GSP/ASP, sits in front of all three and hides the GSTN encryption handshake.

| Govt surface | Govt categories | WhiteBooks equivalent |
|---|---|---|
| **Taxpayer API** | Authentication, Registration, FO, Payment, Returns, Ledger, E‑Invoice, SRM Forms | `api.whitebooks.in/{authentication,gstr*,ledgers,payment,ims,...}` |
| **Public API** | Authentication, Public APIs, eComm Operators | `api.whitebooks.in/public/*` |
| **IRP API** (e‑invoice / Invoice Registration Portal) | Authentication, IRP Data Pull, IRP APIs | `api.whitebooks.in/einvoice/*` + NIC `ewaybillapi/*` |

Portal "Last updated 25‑01‑2017" — the homepage is a stale nav hub; the authoritative
inventory of *released* APIs is the `Released_API_List` spreadsheet, which is what the
tables below are keyed to.

---

## 2. Why the surfaces look different (the core of the gap)

WhiteBooks is **not** a 1:1 proxy. Three transformations explain almost every mismatch:

### 2.1 Base URLs

| Environment | Government (GSTN/NIC) | WhiteBooks |
|---|---|---|
| Sandbox | `https://devapi.gst.gov.in` | (sandbox base issued per credential) |
| Production — returns/ledger/public | `https://api.gst.gov.in` | `https://api.whitebooks.in` |
| Production — e‑way bill (NIC) | `https://ewaybillapi.nic.in` (via GSP) | `https://api.whitebooks.in/ewaybillapi/v1.03` |
| Production — e‑invoice (IRP) | `https://einvoice1.gst.gov.in` (via GSP) | `https://api.whitebooks.in/einvoice` |

### 2.2 Action‑param vs REST path

The government exposes **one endpoint per form with an `?action=` switch**; WhiteBooks
splits each action into its **own path**. This is the single biggest documentation gap.

```
GOV:   GET /taxpayerapi/v4.0/returns/gstr1?action=B2B&gstin=..&ret_period=012017
WB :   GET https://api.whitebooks.in/gstr1/b2b?gstin=..&retperiod=012017&email=..
```

Rule of thumb for the translation:
- `returns/gstr1?action=B2B`   → `/gstr1/b2b`
- `returns/gstr1` (PUT save)    → `/gstr1/retsave`
- `returns/gstr1?action=RETSUM` → `/gstr1/retsum`
- `?action=B2BA` (amendments)   → `/gstr1/b2ba`
- submit / file / reset         → `/gstr1/retsubmit` · `/gstr1/retfile` · `/gstr1/reset`
- EVC filing                    → `/gstr1/retevcfile`
- query param `ret_period`      → WhiteBooks uses **`retperiod`**; `state_cd`→`statecd`;
  every WhiteBooks call also takes a **`email`** query param.

### 2.3 Authentication & encryption (WhiteBooks hides the hard part)

| Concern | Government raw API | WhiteBooks |
|---|---|---|
| ASP/GSP access token | `commonapi/v0.2/authenticate` `action=ACCESSTOKEN` | handled by WhiteBooks credentials |
| Taxpayer OTP request | `taxpayerapi/v1.0/authenticate` `action=OTPREQUEST` → returns `txn` | `GET /authentication/otprequest?email=` |
| Taxpayer auth token | `…authenticate` `action=AUTHTOKEN` (otp+txn) → `auth_token` + **`sek`** | `GET /authentication/authtoken?email=&otp=` |
| Refresh (6‑hr token) | `…authenticate` `action=REFRESHTOKEN` | `GET /authentication/refreshtoken?email=` |
| Logout | `…authenticate` `action=LOGOUT` | `GET /authentication/logout?email=` |
| EVC OTP | `…authenticate?action=EVCOTP` | `GET /authentication/otpforevc?email=&gstin=&pan=&form_type=` |
| **Payload crypto** | App must do **RSA + AES**: encrypt `app_key` with GSTN public cert, AES‑encrypt request with it, decrypt responses with `sek`/`rek`, verify HMAC | **None in the client** — send/receive plain JSON; WhiteBooks performs the GSTN encryption handshake server‑side |

**This is the headline gap‑bridge:** the government docs are mostly about the
RSA/AES/`sek`/`rek` encryption envelope. WhiteBooks removes it entirely. When porting
any government API example, **drop all `app_key`/`ek`/`rek`/HMAC handling** and pass the
inner JSON directly.

WhiteBooks request headers (every call): `gst_username` (client's gst.gov.in user),
`state_cd` (first 2 GSTIN digits), `ip_address`, `client_id`, `client_secret`; `email`
is a query param (the email registered with WhiteBooks).

---

## 3. Return‑filing lifecycle (applies to every GSTRn module)

From `Return-Filing-through-API_v1.1.docx`, normalised to WhiteBooks paths. Every
return form follows the same spine:

```
save (PUT  /gstrN/retsave)        → returns refId        (async)
status (GET /gstr/retstatus?ref_id=…  ≡ /all/newretstatus) → poll until processed
get   (GET  /gstrN/{b2b,cdnr,…})  → read back saved/auto‑populated data
summary (GET /gstrN/retsum)       → freeze + verify totals
submit (POST /gstrN/retsubmit)    → lock position (where the form has submit)
offset (PUT  /gstrN/retoffset)    → set‑off liability from cash/ITC ledgers
file  (POST /gstrN/retfile)       → DSC filing → ARN  |  /gstrN/retevcfile = EVC/OTP filing
```

Notes that the WhiteBooks doc omits:
- **3B has no submit** — `retsave` → `retoffset` → `retfile`. Ledger balance is
  *last‑filed* balance; add the current period's ITC yourself.
- **GSTR1/5/6** use `/all/newproceedfile` before file; older forms use `/all/proceedfile`.
- `refId` from save is checked via `/gstr/retstatus` (alias `/all/newretstatus`).

---

## 4. WhiteBooks API reference — model, payloads, responses, endpoints

This section documents **how a WhiteBooks call is shaped** (§4.0), **what each kind of
endpoint does and the request/response/errors to expect** (§4.0.1 archetypes), an
**end‑to‑end worked example** (§4.0.2), and then the **per‑endpoint index** for all 247
endpoints grouped by module (§4.1–§4.9). The archetypes matter because the 247 endpoints
are really ~8 repeated shapes — once you know the archetype, the per‑row table tells you
the path, params and body keys.

To get the government equivalent for any endpoint, apply the §2.2 path→action rule
(`/gstr1/b2b` ↔ `returns/gstr1?action=B2B`).

### 4.0 The request / response envelope

**Every request** carries the same auth context and (for writes) a JSON body:

| Part | Where | Contents |
|---|---|---|
| Identity headers | HTTP headers | `gst_username`, `state_cd`, `ip_address`, `client_id`, `client_secret` |
| Taxpayer context | HTTP headers | `gstin`, `ret_period` (MMYYYY), `txn` (auth‑token id from `/authentication/authtoken`) |
| Caller | query | `email` (your WhiteBooks‑registered email) — on **every** call |
| Call params | query | call‑specific (e.g. `retperiod`, `ctin`, `fromtime`, `actionrequired`, `pan`, `evcotp`) |
| Payload | JSON body | only on PUT/POST writes — the GSTN form JSON (see archetypes) |

**Every response** is the common WhiteBooks envelope (OpenAPI schema `Response`):

```jsonc
{
  "status_cd": "1",                 // "1" = success, "0" = failure
  "status_desc": "...",             // human description
  "header": { "...": "..." },       // header map echoed from GSTN
  "data": { ... } | "<base64>",     // the GSTN form/result JSON (string or object)
  "error": {                        // present only on failure (schema "Error Payload")
    "error_cd": "RET11402",         // GSTN business error code (see §7)
    "message": "Unauthorized User",
    "code": "...",                  // server-side code
    "desc":  "..."                  // server-side description
  }
}
```

Key rules WhiteBooks' own doc never states:
- **Success is `status_cd:"1"`** — check it, not the HTTP status (most failures still
  return HTTP 200 with `status_cd:"0"` and a populated `error`). The OpenAPI spec only
  declares HTTP `404` (entity/API not found) and `500` (internal error).
- **`data` is the raw GSTN form JSON.** For `get*`/`retsum` it's the section data; for
  large sections WhiteBooks may return a `data` pointer that you fetch via `/all/filedet`
  → `/all/largefile` (the `ek` query param is the response encryption key).
- **Encryption is handled by WhiteBooks** — you send/receive plain JSON; the GSTN
  RSA/AES/`sek`/`rek` envelope (§2.3) never appears in your payloads.

### 4.0.1 Endpoint archetypes — what they do, payload, response, errors

Every endpoint is one of these. The per‑module tables (§4.1+) only list path/params/body;
match the verb/suffix to an archetype here for the full behaviour.

**A. Authentication** (`/authentication/*`, GET) — *Establish a taxpayer session.*
- `otprequest` → GSTN sends OTP to the client's email/SMS; response `data` carries a
  `txn`. `authtoken?otp=` exchanges OTP+`txn` for the working `txn`/auth token (valid
  6 hrs). `refreshtoken` extends it; `logout` ends it.
- **Request:** query only (`email`, `gstin`, identity headers); no body.
- **Response:** `data` = `{ "txn": "...", "auth_token"/"expiry": ... }`.
- **Errors:** `RET11402` Unauthorized, `RET11407` AUTH token invalid, `RET11408` invalid
  `txn`, `RET13509` OTP expired/incorrect, `RET11409` username not valid.

**B. Public read** (`/public/*`, GET) — *No taxpayer session needed.* `search` returns the
taxpayer profile for a GSTIN; `rettrack` the return‑filing status; `pref` the QRMP/monthly
preference. **Errors:** `RET11410`/`RET191113` invalid GSTIN, `RET13508` no details found.

**C. Section read** (`get*`, the `/gstrN/{b2b,cdnr,exp,…}` family, GET) — *Read saved or
auto‑populated invoices for a return period.*
- **Request:** query `gstin`, `retperiod`, optional `ctin` (counterparty), `fromtime`
  (delta pull), `actionrequired=Y` (only items needing action), `statecd` for B2CL.
- **Response:** `data` = the section array (e.g. `b2b:[{ctin, inv:[…]}]`).
- **Errors:** `AUTH113` invalid return period, `AUTH141` GSTIN/period missing,
  `RET13508` no details found, `RTN_15` returns still under processing.

**D. Save** (`retsave`, PUT) — *Upload/overwrite the whole form section set.*
- **Request body:** the GSTN form JSON. Save is **whole‑section overwrite** — resend the
  full section (with updated/added/deleted records) each time; the last save wins
  (see §3, esp. GSTR‑4 where all sections save together).
- **Response:** `data` = `{ "reference_id"/"refId": "...", "status_cd": "..." }` — save is
  **asynchronous**; poll its result with archetype H.
- **Errors:** `RET191106` JSON structure invalid, `RET191107` at least one line item
  required, `RET191111` duplicate invoice no., `RET191112` invalid POS state code,
  `RET191114` invoice date out of window (>18 months / future), `RET12505` corrupted
  payload, `RET12590` save not allowed for current date (timeline closed).

**E. Summary / validate** (`retsum`, `autoliab`, `validate*`, GET/POST) — *Freeze and
verify totals before submit/file.* `retsum` returns the table‑wise summary;
`validateautocalculatedata` (3B) and `validateturnover`/`validateliability` (CMP/4A/ITC04)
check the figures against GSTN's own computation. **Errors:** `RET13501` checksum mismatch,
`RTN_24/25` summary/file generation in progress/failed.

**F. Submit / offset** (`retsubmit` POST, `retoffset`/`utlcsh`/`utlitc` PUT/POST) —
*Lock the position / set off liability.* Submit freezes the return (no further edits);
offset pays liability from cash/ITC ledgers (`pdcash`/`pditc`). Both are async (return a
`refId`). **Errors:** `RET12521` already submitted, `RET12523` submit in progress,
`RTN_17` invoices already submitted, `RT_FIL_10` submit before filing.

**G. File** (`retfile` POST = DSC, `retevcfile` POST = EVC) — *File the return → ARN.*
- **Request:** the summary payload echoed back **plus** `chksum` (from the summary),
  `pan` (query) and a DSC‑signed blob (DSC) or `evcotp` (EVC).
- **Response:** `data` = `{ "arn": "...", "status": "Filed" }`.
- **Errors:** `RET13501` checksum mismatch, `RET13506`/`RET13507` DSC signature
  invalid/mismatch, `RTDSC04/05` PAN‑or‑sign invalid / DSC verify failed, `RT_FIL_02`
  already filed, `RT_FIL_09` signed summary not the latest, `RT_FIL_017/018` user/PAN not
  registered for DSC, `RT_FIL_31` not authorised for EVC, `RTN_FIL_28/29` certificate
  expired/invalid.

**H. Status / file fetch** (`/gstr/retstatus`, `/all/newretstatus`, `/all/filedet`,
`/all/largefile`, `/gstr2b/get2b`, `/ims/status`, GET) — *Poll an async `refId`; fetch
large/generated files.* **Errors:** `RTN_15` still processing, `RET11408` invalid
transaction id, `RTN_24/31/32` file generation in progress/ready/already running.

### 4.0.2 Worked example — file a GSTR‑1

```text
1. GET  /authentication/otprequest?email=me@asp.in            → data.txn = T1, OTP to client
2. GET  /authentication/authtoken?email=me@asp.in&otp=123456  (header txn=T1)
                                                              → working txn/auth_token (6 hrs)
3. PUT  /gstr1/retsave        body = { gstin, fp, b2b:[…], … } → data.refId = R1   (async)
4. GET  /gstr/retstatus?gstin=&returnperiod=&refid=R1          → status_cd "P"→"PE"(processed)
5. GET  /gstr1/retsum?gstin=&retperiod=                        → data = summary + chksum
6. GET  /all/newproceedfile?gstin=&retperiod=&type=R1         → proceed-to-file allowed
7. POST /gstr1/retfile?pan=  body = { gstin, ret_period, chksum, … } + DSC
                                                              → data.arn = "AA27…"   (filed)
```

Example **save body** (`PUT /gstr1/retsave`, B2B section abbreviated — values are the
spec's own examples):

```jsonc
{
  "gstin": "27AHQPA7588L1ZJ", "fp": "122016", "gt": 3782969.01, "cur_gt": 3782969.01,
  "b2b": [{
    "ctin": "01AABCE2207R1Z5",
    "inv": [{
      "inum": "S008400", "idt": "24-11-2016", "val": 729248.16, "pos": "06",
      "rchrg": "N", "inv_typ": "R",
      "itms": [{ "num": 1, "itm_det": { "rt": 5, "txval": 10000, "iamt": 325, "csamt": 500 } }]
    }]
  }]
}
```

Example **success response** (envelope):

```jsonc
{ "status_cd": "1", "status_desc": "Success",
  "header": { "txn": "..." },
  "data": { "reference_id": "AA270620250001R", "status_cd": "P" } }
```

Example **error response** (envelope) — submit attempted twice:

```jsonc
{ "status_cd": "0", "status_desc": "Failure",
  "error": { "error_cd": "RET12521", "message": "GSTR1 is already submitted for current period",
             "code": "...", "desc": "..." } }
```

### 4.1 Public & Authentication

### Public  `/public` — 5 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| GET | `/public/search` | gstin | — | Search taxpayer details by GSTIN |
| GET | `/public/rettrack` | gstin fy type | — | View and track returns status |
| GET | `/public/pref` | gstin fy | — | Get filing preference (QRMP/monthly) |
| GET | `/public/unregistered-applicants` | uid | — | Fetch URD details for an e‑commerce supplier |
| GET | `/public/unregistered-applicants-validation` | uid ecomEmail mobile | — | Validate mobile & email of unregistered applicants |

### Authentication  `/authentication` — 5 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| GET | `/authentication/otprequest` | — | — | Issue OTP to taxpayer (email+SMS); returns `txn` |
| GET | `/authentication/authtoken` | otp | — | Exchange OTP+`txn` for the auth token |
| GET | `/authentication/refreshtoken` | — | — | Extend the 6‑hr auth token without user action |
| GET | `/authentication/logout` | — | — | Log the taxpayer session out |
| GET | `/authentication/otpforevc` | gstin pan form_type | — | Send OTP for EVC filing |

### 4.2 Common status & utilities

### Return status / track  `/gstr` — 2 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| GET | `/gstr/retstatus` | gstin returnperiod refid | — | Status of a submitted return (poll the save `refId`) |
| GET | `/gstr/rettrack` | gstin returnperiod type | — | View and track returns status |

### Common utilities  `/all` — 13 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| POST | `/all/savemasters` | — | userGstin, productsMasters, supplierRecipientMasters | Save/update/delete user masters |
| GET | `/all/getmasters` | gstin | — | Get user masters |
| GET | `/all/filedet` | gstin returnperiod token | — | Get the file URL for a `file_num` |
| GET | `/all/largefile` | url ek gstin returnperiod | — | Get data for a large‑file URL (`ek` = encryption key) |
| GET | `/all/latefee` | gstin retperiod rettype | — | Late fee levied in GSTR3B/GSTR4 |
| GET | `/all/latefeebreakup` | gstin retperiod rettype | — | Break‑up of additional late fee for the period |
| GET | `/all/docdwld` | gstin retperiod id | — | Document download |
| GET | `/all/proceedfile` | gstin type retperiod | — | Proceed to file (older forms) |
| GET | `/all/newproceedfile` | gstin retperiod type isNil | — | New proceed to file (GSTR1/5/6) |
| POST | `/all/docupld` | — | ct, data, doc_nam | Document upload |
| GET | `/all/newretstatus` | gstin returnperiod refid rettype | — | Get return status (alias of `/gstr/retstatus`) |
| PUT | `/all/savepref` | — | gstin, fy, quarter, preference | Save filing preference |
| GET | `/all/getpref` | gstin fy | — | Get filing preference |

### 4.3 Outward supplies — GSTR‑1 / 1A / e‑invoice pull

### GSTR‑1 — Outward supplies  `/gstr1` — 30 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/gstr1/retsave` | — | gstin, fp, gt, cur_gt, b2b, b2ba, b2cl, b2cla, cdnr, cdnra, b2cs, b2csa, exp, expa | Save entire GSTR1 |
| GET | `/gstr1/retsum` | gstin retperiod smrytyp | — | Table‑wise GSTR1 summary |
| GET | `/gstr1/b2b` | actionrequired gstin retperiod ctin fromtime | — | B2B invoices |
| GET | `/gstr1/b2cl` | statecd gstin retperiod | — | B2C Large invoices |
| GET | `/gstr1/b2cs` | gstin retperiod | — | B2C Small (HSN) data |
| GET | `/gstr1/cdnr` | actionrequired gstin retperiod | — | Credit/Debit notes (registered) |
| GET | `/gstr1/cdnur` | gstin retperiod | — | Credit/Debit notes (unregistered) |
| GET | `/gstr1/exp` | gstin retperiod | — | Export invoices |
| GET | `/gstr1/at` | gstin retperiod | — | Advance tax |
| GET | `/gstr1/txp` | gstin retperiod | — | Tax paid (advance adjusted) |
| GET | `/gstr1/nil` | gstin retperiod | — | Nil‑rated/exempt/non‑GST supplies |
| GET | `/gstr1/hsnsum` | gstin retperiod | — | HSN summary |
| GET | `/gstr1/validatehsnsum` | gstin retperiod | — | Validate HSN summary |
| GET | `/gstr1/dociss` | gstin retperiod | — | Documents issued |
| GET | `/gstr1/supeco` | gstin retperiod subsection fromtime | — | Supplier ECO invoices |
| GET | `/gstr1/ecom` | gstin retperiod rtin subsection fromtime | — | ECOM invoices |
| GET | `/gstr1/einvoice` | gstin retperiod sec fromtime | — | E‑invoices pulled into GSTR1 |
| GET | `/gstr1/b2ba` | actionrequired gstin retperiod ctin | — | B2B amendments |
| GET | `/gstr1/b2cla` | statecd gstin retperiod | — | B2C Large amendments |
| GET | `/gstr1/b2csa` | gstin retperiod | — | B2C Small amendments |
| GET | `/gstr1/cdnra` | actionrequired gstin retperiod | — | CDN (registered) amendments |
| GET | `/gstr1/cdnura` | gstin retperiod | — | CDN (unregistered) amendments |
| GET | `/gstr1/expa` | gstin retperiod | — | Export amendments |
| GET | `/gstr1/ata` | gstin retperiod | — | Advance tax amendments |
| GET | `/gstr1/txpa` | gstin retperiod | — | Tax‑paid amendments |
| GET | `/gstr1/supecoa` / `/gstr1/ecoma` | gstin retperiod subsection fromtime | — | Supplier‑ECO / ECOM amendments |
| POST | `/gstr1/reset` | — | gstin, ret_period | Reset GSTR1 data |
| POST | `/gstr1/retfile` | pan | gstin, ret_period, chksum, newSumFlag, sec_sum | File GSTR1 (DSC) |
| POST | `/gstr1/retevcfile` | pan evcotp | — | File GSTR1 (EVC) |

### GSTR‑1A — Amendment of current‑period GSTR‑1  `/gstr1a` — 8 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| PUT | `/gstr1a/retsave` | — | gstin, fp, b2b, b2ba, cdnr, cdnra | Save GSTR1A |
| GET | `/gstr1a/b2b` · `/gstr1a/b2ba` | actionrequired gstin retperiod ctin fromtime | — | B2B / B2BA invoices |
| GET | `/gstr1a/cdnr` · `/gstr1a/cdnra` | actionrequired gstin retperiod ctin | — | CDN / CDNA notes |
| GET | `/gstr1a/retsum` | gstin retperiod | — | GSTR1A summary |
| POST | `/gstr1a/retsubmit` | — | — | Submit GSTR1A |
| POST | `/gstr1a/retfile` | pan | — | File GSTR1A |

### e‑Invoice pull (returns side)  `/gst/einvoice` — 4 endpoints

| Method | Endpoint | Query params | Purpose |
|---|---|---|---|
| GET | `/gst/einvoice/irnlist` | gstin rstinflag suptyp rtnprd | List of IRNs for the period |
| GET | `/gst/einvoice/irndtl` | gstin irn | Get the JSON for an IRN |
| GET | `/gst/einvoice/hsnsum` | gstin ret_period | E‑invoice HSN summary |
| GET | `/gst/einvoice/filedtl` | gstin rtnprd token | Get file URL |

### 4.4 Inward / ITC — GSTR‑2A / 2B / 2X / 3B / IMS

### GSTR‑2A — Auto‑drafted inward  `/gstr2a` — 12 endpoints

| Method | Endpoint | Query params | Purpose |
|---|---|---|---|
| GET | `/gstr2a/b2b` · `/gstr2a/b2ba` | gstin retperiod ctin fromtime | B2B / B2BA |
| GET | `/gstr2a/cdn` · `/gstr2a/cdna` | gstin retperiod ctin | CDN / amended CDN |
| GET | `/gstr2a/impg` · `/gstr2a/impgsez` | gstin retperiod fromtime | Import of goods / from SEZ |
| GET | `/gstr2a/tcs` · `/gstr2a/tds` | gstin retperiod | TCS / TDS credit |
| GET | `/gstr2a/ecom` · `/gstr2a/ecoma` | gstin retperiod ctin fromtime | ECOM / amended ECOM |
| GET | `/gstr2a/isd` | gstin retperiod ctin | ISD details |
| GET | `/gstr2a/amdhist` | gstin portcode benumber bedate retperiod | Bill‑of‑entry amendment history |

### GSTR‑2B — Static ITC statement  `/gstr2b` — 3 endpoints

| Method | Endpoint | Query params | Purpose |
|---|---|---|---|
| GET | `/gstr2b/all` | gstin rtnprd filenum | Full 2B statement |
| PUT | `/gstr2b/gen2b` | — | Generate 2B on demand |
| GET | `/gstr2b/get2b` | gstin int_tran_id | 2B generation status |

### GSTR‑2X — TDS/TCS credit  `/gstr2x` — 4 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| PUT | `/gstr2x/retsave` | — | gstin, fp, tds, tdsa, tcs, tcsa | Save GSTR2X |
| GET | `/gstr2x/tdstcs` | gstin retperiod fromtime rectype | — | TDS/TCS credit received |
| POST | `/gstr2x/retfile` · `/gstr2x/retevcfile` | pan (evcotp) | chksum, ret_period, gstin, tds… | File (DSC/EVC) |

### GSTR‑3B — Monthly summary  `/gstr3b` — 12 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/gstr3b/retsave` | — | gstin, ret_period, sup_details, inter_sup, eco_dtls, itc_elg, inward_sup, intr_ltfee | Save GSTR3B |
| GET | `/gstr3b/retsum` | gstin retperiod | — | Table‑wise summary |
| GET | `/gstr3b/autoliab` | gstin retperiod | — | GSTR1 auto‑calculated liability |
| POST | `/gstr3b/validateautocalculatedata` | — | gstin, ret_period, sup_details… | Validate 3B vs auto‑calc |
| PUT | `/gstr3b/retoffset` | — | pdcash, pditc | Offset liability (cash/ITC) |
| PUT | `/gstr3b/liabilitybreakup` | — | gstin, ret_period, breakup | Save past‑liability breakup |
| GET | `/gstr3b/syscalcintrst` | gstin retperiod | — | System‑calculated interest |
| POST | `/gstr3b/cmpint` | — | gstin, ret_period | Recompute system interest |
| GET | `/gstr3b/closingbal` | gstin | — | Credit‑reversal closing balance |
| GET | `/gstr3b/openingbal` | gstin | — | Credit‑reversal opening balance (read only — see §6) |
| POST | `/gstr3b/retfile` · `/gstr3b/retevcfile` | pan (evcotp) | gstin, ret_period, …, tx_pmt | File (DSC/EVC) |

### IMS — Invoice Management System  `/ims` — 6 endpoints (mandatory Apr 2026)

| Method | Endpoint | Query params | Purpose |
|---|---|---|---|
| GET | `/ims/invoices` | gstin section status | Section‑wise inward docs (Accept/Reject/Pending) |
| GET | `/ims/invoicescount` | gstin goodsType | Section‑wise counts |
| PUT | `/ims/save` | — | Save IMS actions (A/R/P) |
| PUT | `/ims/reset` | — | Reset IMS actions |
| GET | `/ims/status` | gstin int_tran_id | IMS save status |
| GET | `/ims/getfile` | gstin token | File URLs for IMS bulk action |

### 4.5 Electronic ledgers & payment

### Ledger  `/ledgers` — 8 endpoints

| Method | Endpoint | Query params | Purpose |
|---|---|---|---|
| GET | `/ledgers/cashdtl` | gstin frdt todt | Cash ledger details |
| GET | `/ledgers/itc` | gstin frdt todt | ITC ledger details |
| GET | `/ledgers/tax` | gstin frdt todt | Tax (liability) ledger details |
| GET | `/ledgers/bal` | gstin retperiod | Cash & ITC balance as on date |
| GET | `/ledgers/taxpayable` | gstin retperiod rettype | Return‑related liability balance |
| GET | `/ledgers/itcblocktrandetls` | gstin frdt todt | Blocked/unblocked ITC details |
| POST | `/ledgers/utlcsh` | — | Utilise cash balance against liability |
| POST | `/ledgers/utlitc` | — | Utilise ITC balance against liability |

### Payment / Challan  `/payment` — 4 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| POST | `/payment/generateChallan` | — | gstin, email_id, mobile_num, tp_name, payment_mod, bank_cd, cgst_tax_amt, … | Generate challan (CPIN) |
| POST | `/payment/validatechlnrsn` | — | gstin, payment_mod, bank_cd, cgst_tax_amt, … | Validate challan reason |
| GET | `/payment/chllnlst` | gstin fromdate todate | Challan history |
| GET | `/payment/chllnsum` | gstin cpin | Challan summary + payment status |

### 4.6 Composition — CMP‑08 / GSTR‑4 / 4A / 4 Annual

### CMP‑08  `/cmp` — 5 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| GET | `/cmp/getcmp` | gstin retperiod | — | Get CMP‑08 |
| POST | `/cmp/savecmp` | — | gstin, ret_period, isnil, table3 | Save CMP‑08 |
| GET | `/cmp/validateturnover` | gstin retperiod | — | Validate turnover |
| POST | `/cmp/retfile` · `/cmp/retevcfile` | pan (evcotp) | gstin, ret_period, isnil, table3, table4, tax_pay, offset | File (DSC/EVC) |

### GSTR‑4 — Composition (annual)  `/gstr4` — 23 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/gstr4/retsave` | — | gstin, fp, at, ata, b2b, b2ba, b2bur, b2bura, cdnr, cdnra, cdnur, cdnura, imp_s, imp_sa | Save GSTR4 (all sections together) |
| GET | `/gstr4/b2b` · `/gstr4/b2ba` | actionrequired gstin retperiod ctin | — | B2B / B2BA |
| GET | `/gstr4/b2bur` · `/gstr4/b2bura` | gstin retperiod | — | B2B unregistered / amended |
| GET | `/gstr4/cdnr` · `/gstr4/cdnra` | gstin retperiod (actionrequired) | — | CDN registered / amended |
| GET | `/gstr4/cdnur` · `/gstr4/cdnura` | gstin retperiod | — | CDN unregistered / amended |
| GET | `/gstr4/imps` · `/gstr4/impsa` | gstin retperiod | — | Import of services / amended |
| GET | `/gstr4/txos` · `/gstr4/txosa` | gstin retperiod | — | Tax on outward supplies / amended |
| GET | `/gstr4/at` · `/gstr4/ata` | gstin retperiod | — | Advance tax / amended |
| GET | `/gstr4/txp` · `/gstr4/txpa` | gstin retperiod | — | Tax paid / amended |
| GET | `/gstr4/tds` | gstin retperiod | — | TDS credit |
| GET | `/gstr4/retsum` | gstin retperiod | — | Summary |
| POST | `/gstr4/retsubmit` | — | — | Submit |
| POST | `/gstr4/retoffset` | — | — | Set‑off liability |
| POST | `/gstr4/retfile` · `/gstr4/retevcfile` | pan (evcotp) | gstin, ret_period, chksum, sec_sum, ttl_inv, liabDetl, utilizeCashReqVO | File (DSC/EVC) |

### GSTR‑4A — Auto‑draft for GSTR‑4  `/gstr4a` — 5 endpoints

| Method | Endpoint | Query params | Purpose |
|---|---|---|---|
| GET | `/gstr4a/b2b` · `/gstr4a/b2ba` · `/gstr4a/cdnr` · `/gstr4a/cdnra` · `/gstr4a/tds` | gstin retperiod ctin | Auto‑drafted B2B/CDN/TDS for composition |

### GSTR‑4 Annual (GSTR‑4X)  `/gstr4annual` — 9 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/gstr4annual/retsave` | — | gstin, agg_turnover, fp, isnil, isreset, b2bor, b2br, b2bur, imps, outsupply | Save annual return |
| GET | `/gstr4annual/txios` | gstin retperiod | — | Overall inward/outward supply data |
| GET | `/gstr4annual/tdscmp` | gstin retperiod | — | CMP‑08 + TDS/TCS summary |
| GET | `/gstr4annual/autopop` | gstin retperiod | — | Auto‑populated table 4A/4B |
| GET | `/gstr4annual/getsum` | gstin retperiod | — | Overall summary |
| GET | `/gstr4annual/validateturnover` · `/gstr4annual/validateliability` | gstin retperiod | — | Validate turnover / table‑6 liability |
| POST | `/gstr4annual/retfile` · `/gstr4annual/retevcfile` | pan (evcotp) | gstin, agg_turnover, fp, isnil, chksum, … offset | File (DSC/EVC) |

### 4.7 GSTR‑5 (non‑resident), 6/6A (ISD), 7 (TDS), 8 (TCS)

### GSTR‑5 — Non‑resident  `/gstr5` — 21 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/gstr5/retsave` | — | gstin, fp, b2b, b2ba, b2cl, b2cla, b2cs, b2csa, cdn, cdna, cdnur, cdnura, imp_g, imp_ga | Save GSTR5 |
| GET | `/gstr5/b2b` · `/gstr5/b2ba` · `/gstr5/cdn` · `/gstr5/cdna` | gstin retperiod ctin | — | B2B / CDN (+amend) |
| GET | `/gstr5/b2cl` · `/gstr5/b2cs` · `/gstr5/b2cla` · `/gstr5/b2csa` | statecd gstin retperiod | — | B2C Large/Small (+amend) |
| GET | `/gstr5/cdnur` · `/gstr5/cdnura` | gstin retperiod | — | CDN unregistered (+amend) |
| GET | `/gstr5/impg` · `/gstr5/impga` · `/gstr5/imps` · `/gstr5/impsa` | gstin retperiod | — | Import of goods/services (+amend) |
| GET | `/gstr5/ttxli` | gstin retperiod | — | Total tax liability |
| GET | `/gstr5/retsum` | gstin retperiod | — | Summary |
| POST | `/gstr5/retsubmit` | — | gstin, fp | Submit |
| PUT | `/gstr5/retoffset` | — | pdcash, pditc | Offset liability |
| POST | `/gstr5/retfile` · `/gstr5/retevcfile` | (pan evcotp) | gstin, ret_period, chksum, section_summary, txi, offset, txpd | File (DSC/EVC) |

### GSTR‑6 — ISD  `/gstr6` — 16 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/gstr6/retsave` | — | gstin, fp, gt, b2b, b2ba, isd, isda, cdn, cdna | Save GSTR6 |
| GET | `/gstr6/b2b` · `/gstr6/b2ba` | actionrequired gstin retperiod ctin | — | B2B / B2BA |
| GET | `/gstr6/cdn` · `/gstr6/cdna` | actionrequired gstin retperiod ctin | — | CDN / amended CDN |
| GET | `/gstr6/isd` · `/gstr6/isda` | gstin retperiod (ctin) | — | ISD credit / amended |
| GET | `/gstr6/itc` | gstin retperiod | — | ITC details |
| GET | `/gstr6/latefee` | gstin retperiod | — | Late fee |
| GET | `/gstr6/retsum` | gstin retperiod fnl | — | Summary |
| POST | `/gstr6/retcal` | — | gstin, ret_period | Calculate R6 status |
| POST | `/gstr6/savecrossitcdetails` | — | gstin, fp, isdItcCross | Save cross‑ITC details |
| PUT | `/gstr6/retoffsetlatefee` | — | gstin, ret_type, ret_period, liab_id, tran_cd, cgstfee, sgstfee | Offset late fee |
| POST | `/gstr6/retsubmit` | — | gstin, ret_period | Submit |
| POST | `/gstr6/retfile` · `/gstr6/retevcfile` | pan (evcotp) | gstin, ret_period, chksum, itcDetails, lateFeemain, section_summary, offset | File (DSC/EVC) |

### GSTR‑6A — Auto‑draft for ISD  `/gstr6a` — 4 endpoints

| Method | Endpoint | Query params | Purpose |
|---|---|---|---|
| GET | `/gstr6a/b2b` · `/gstr6a/b2ba` · `/gstr6a/cdn` · `/gstr6a/cdna` | actionrequired gstin retperiod ctin | Auto‑drafted B2B/CDN for ISD |

### GSTR‑7 — TDS deductor  `/gstr7` — 6 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| PUT | `/gstr7/retsave` | — | gstin, fp, tds, tdsa | Save GSTR7 |
| GET | `/gstr7/tds` | gstin retperiod fromtime rectype | — | TDS credit received |
| GET | `/gstr7/tdschecksum` | gstin retperiod fromtime rectype | — | TDS checksum |
| GET | `/gstr7/retsum` | gstin retperiod | — | Summary |
| POST | `/gstr7/retfile` · `/gstr7/retevcfile` | (pan evcotp) | gstin, fp, tds, tdsa, tax_pay, offset | File (DSC/EVC) |

### GSTR‑8 — TCS (e‑commerce)  `/gstr8` — 7 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| PUT | `/gstr8/retsave` | — | gstin, fp, tcs, tcsa, urd, urda | Save GSTR8 |
| GET | `/gstr8/tcs` | gstin retperiod fromtime rettype | — | TCS invoices |
| GET | `/gstr8/eid` | gstin retperiod fromtime rettype | — | URD original + amended supplies |
| GET | `/gstr8/checksum` | gstin retperiod fromtime rettype | — | Checksum |
| GET | `/gstr8/retsum` | gstin retperiod fnl | — | Summary |
| POST | `/gstr8/retfile` · `/gstr8/retevcfile` | pan (evcotp) | gstin, fp, dflt_amt, chksum, tcs, tcsa, urd, urda, tax_pay, offset | File (DSC/EVC) |

### 4.8 Annual returns — GSTR‑9 / 9A / 9C

### GSTR‑9 — Annual return  `/gstr9` — 6 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/gstr9/retsave` | — | gstin, fp, table4…table18 | Save GSTR9 |
| GET | `/gstr9/getdet` | gstin retperiod | — | Get GSTR9 details |
| GET | `/gstr9/getautocal` | gstin retperiod | — | Auto‑calculated details |
| GET | `/gstr9/get8adetails` | gstin fy docid retperiod | — | 8A invoices/notes |
| POST | `/gstr9/retfile` · `/gstr9/retevcfile` | (pan evcotp) | isnil, gstin, fp, table4…table17 | File (DSC/EVC) |

### GSTR‑9A — Annual (composition)  `/gstr9a` — 5 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| PUT | `/gstr9a/retsave` | — | gstin, fp, table5…table16 | Save GSTR9A |
| GET | `/gstr9a/getdet` · `/gstr9a/getautocal` | gstin retperiod | — | Details / auto‑calc |
| POST | `/gstr9a/retfile` · `/gstr9a/retevcfile` | (pan evcotp) | gstin, fp, cmp_frmdt, cmp_todt, isnil, table5…table14 | File (DSC/EVC) |

### GSTR‑9C — Reconciliation statement  `/gstr9c` — 7 endpoints

| Method | Endpoint | Query params | Request body | Purpose |
|---|---|---|---|---|
| PUT | `/gstr9c/retsave` | — | gstr9cdata, dcupdtls | Save GSTR9C |
| GET | `/gstr9c/getrecds` | gstin retperiod | — | GSTR9 records for 9C |
| GET | `/gstr9c/retsum` | gstin retperiod | — | Summary |
| PUT | `/gstr9c/genhash` | — | gstr9cdata | Generate hash |
| PUT | `/gstr9c/gencert` | — | gstin, fp, isauditor, cert_data | Generate certificate |
| POST | `/gstr9c/retfile` · `/gstr9c/retevcfile` | (pan evcotp) | gstr9cdata, dcupdtls | File (DSC/EVC) |

### 4.9 ITC‑03 / ITC‑04 / SPIKE

### ITC‑03 — ITC reversal  `/itc03` — 7 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/itc03/retsave` | type | gstin, rtn_typ, comp_arn, dof, invs, attachment | Save ITC03 |
| GET | `/itc03/getinv` · `/itc03/close` | gstin retperiod type (arnnum) | — | Get / close invoices |
| GET | `/itc03/retsum` | gstin retperiod type arnnum | — | Summary |
| PUT | `/itc03/retoffset` | type | gstin, ret_type, pd_by_cash, pd_by_itc | Offset liability |
| POST | `/itc03/retfile` · `/itc03/retevcfile` | type (pan evcotp) | gstin, rtn_typ, comp_arn, dof, isnil, sec_5a…sec_5e, tax_pay, tax_paid | File (DSC/EVC) |

### ITC‑04 — Job work  `/itc04` — 6 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| PUT | `/itc04/retsave` | — | gstin, fp, m2jw, table5A, table5B, table5C | Save ITC04 |
| GET | `/itc04/getinv` | gstin retperiod | — | Get invoices |
| GET | `/itc04/retsum` | gstin retperiod | — | Summary |
| GET | `/itc04/validateturnover` | gstin retperiod | — | Validate turnover |
| POST | `/itc04/retfile` · `/itc04/retevcfile` | pan (evcotp) | m2j_chksum, table5A_chksum, table5B_chksum, … | File (DSC/EVC) |

### SPIKE — DRC‑01B/01C liability mismatch  `/spike` — 4 endpoints

| Method | Endpoint | Query params | Request body (top-level) | Purpose |
|---|---|---|---|---|
| GET | `/spike/rtncomplist` | gstin refid retperiod status frmtyp | — | DRC‑01B/01C reference ids |
| GET | `/spike/rtncompsum` | gstin refid retperiod | — | GSTR1‑vs‑3B mismatch summary |
| PUT | `/spike/spikesave` | — | frmtyp, refid, rtnprd, gstin, drc03arn, reasons, deldrc03arn | Save explanation |
| POST | `/spike/retfile` | pan | frmtyp, refid, rtnprd, gstin, drc03arn, reasons | File explanation |

---

## 5. E‑Invoice (IRP) & E‑Way Bill — separate NIC surfaces

These are **not** part of the `returns` surface. WhiteBooks fronts the IRP (e‑invoice)
and NIC e‑way‑bill systems with their own base paths and a `type`/action style.

### 5.1 E‑Invoice (IRP) — base `…/einvoice`

| Operation | WhiteBooks |
|---|---|
| Authenticate to IRP | `GET /einvoice/authenticate?email=` |
| Generate IRN | `POST /einvoice/type/GENERATE/version/V1_03` |
| Cancel IRN | `POST /einvoice/type/CANCEL/version/V1_03` |
| Get IRN | `GET /einvoice/type/GETIRN/version/V1_03` |
| Get IRN by doc details | `GET /einvoice/type/GETIRNBYDOCDETAILS/version/V1_03` |
| Generate e‑way bill from IRN | `POST /einvoice/type/GENERATE_EWAYBILL/version/V1_03` |
| Get e‑way bill by IRN | `GET /einvoice/type/GETEWAYBILLIRN/version/V1_03` |
| Taxpayer GSTIN details / sync from CP | `GET /einvoice/type/GSTNDETAILS|SYNC_GSTIN_FROMCP/version/V1_03` |
| QR code | `GET /einvoice/qrcode?email=` |

Plus the **returns‑side e‑invoice pull** (already filed IRNs flowing into GSTR‑1):
`/gst/einvoice/{hsnsum,irnlist,filedtl,irndtl}` and `/gstr1/einvoice`.

**Payloads (IRP):** `GENERATE` takes the full **e‑invoice schema** (`Version`,
`TranDtls`, `DocDtls`, `SellerDtls`, `BuyerDtls`, `ItemList[]`, `ValDtls`, optional
`EwbDtls`) and returns `{ Irn, SignedInvoice (JWS), SignedQRCode, AckNo, AckDt, EwbNo? }`.
`CANCEL` takes `{ Irn, CnlRsn, CnlRem }` (allowed within 24 hrs). `GETIRN` takes the IRN;
`GETIRNBYDOCDETAILS` takes `{ doctype, docnum, docdate }`. **Errors:** §7.6 (`2150`
duplicate IRN, `2148` not found, `2143` not your GSTIN). Field rules:
`e_Invoice_preparation_tools.xlsx`.

### 5.2 E‑Way Bill (NIC) — base `…/ewaybillapi/v1.03/ewayapi`

| Operation | WhiteBooks |
|---|---|
| Authenticate | `GET /ewaybillapi/v1.03/authenticate?username=&password=` |
| Generate / cancel / reject | `POST …/genewaybill` · `…/canewb` · `…/rejewb` |
| Consolidated EWB | `POST …/gencewb` |
| Update vehicle / transporter | `POST …/vehewb` · `…/updatetransporter` |
| Extend validity / regenerate trip sheet | `POST …/extendvalidity` · `…/regentripsheet` |
| Multi‑vehicle | `POST …/{initmulti,addmulti,updtmulti}` |
| Get EWB / by date / by transporter / rejected‑by‑others | `GET …/{getewaybill,getewaybillsbydate,getewaybillsfortransporter,getewaybillsrejectedbyothers,…}` |
| Masters: GSTIN / HSN / transporter / error list | `GET …/{getgstindetails,gethsndetailsbyhsncode,gettransporterdetails,geterrorlist}` |

**Payloads (e‑way bill):** `genewaybill` takes `{ supplyType, subSupplyType, docType,
docNo, docDate, fromGstin, toGstin, …addresses, itemList[], hsnCode, transMode,
transDistance, transporterId, vehicleNo }` and returns `{ ewayBillNo, ewayBillDate,
validUpto }`. `vehewb` updates Part‑B (`{ ewbNo, vehicleNo, fromPlace, reasonCode }`);
`canewb`/`rejewb` take `{ ewbNo, cancelRsnCode/… }`; `extendvalidity` adds
`remainingDistance`+reason. `getgstindetails`/`gethsndetailsbyhsncode` are masters
lookups. **Errors:** §7.7 (`1xx` auth codes) plus per‑field validation codes — full list
in `e_Waybill_error_codes.xlsx`; field rules in `e_Waybill_preparation_tools.xlsx`.

---

## 6. Government APIs that WhiteBooks does NOT expose

The government's own `Released_API_List` carries an **`Available in WhiteBooks` (Y/N)**
column. Of the ~347 released government APIs, **15 are marked `N`**. Below is every one
of them, with the canonical government endpoint, **cross‑checked against the current
(2025‑02) WhiteBooks OpenAPI spec** — because several 2023 `N`s have since been added by
WhiteBooks. Government base URLs: sandbox `https://devapi.gst.gov.in`, production
`https://api.gst.gov.in`.

### 6.1 Still missing in WhiteBooks (real gaps)

| # | Government form / API | Government endpoint (sandbox) | Why it matters / workaround |
|---|---|---|---|
| 1 | **GSTR‑10 — Final Return** (Save) | `PUT taxpayerapi/v1.1/returns/gstr10` | Filed when a registration is **cancelled/surrendered**. No `/gstr10` module exists in WhiteBooks at all. |
| 2 | GSTR‑10 — Get Record | `GET …/returns/gstr10?action=RECDS&gstin=&ret_period=` | ″ |
| 3 | GSTR‑10 — Get Summary | `GET …/returns/gstr10?action=RETSUM` | ″ |
| 4 | GSTR‑10 — Get Late Fee | `GET …/returns/gstr10?action=LTFEEDTL` | ″ |
| 5 | GSTR‑10 — File | `POST …/returns/gstr10?action=RETFILE` | ″ — **the entire GSTR‑10 lifecycle must be done on the portal** or via another GSP. |
| 6 | **GSTR‑2A `ISDA`** (amended ISD credit) | `GET taxpayerapi/v2.1/returns/gstr2a?action=ISDA` | WhiteBooks has `/gstr2a/isd` (original ISD) but **no amended‑ISD pull**. |
| 7 | **GSTR‑3B Save Opening Balance** (Electronic Credit Reversal & Re‑claimed) | `PUT taxpayerapi/v3.1/returns/gstr3b` (OPENINGBAL save) | WhiteBooks exposes `GET /gstr3b/openingbal` + `closingbal` (read) but **no save** of the one‑time opening‑balance declaration. |
| 8 | **Ledger — Credit Reversal & Re‑claimed (`REVRCLM`)** | `GET taxpayerapi/v1.0/ledgers?action=REVRCLM&gstin=&fr_dt=&to_dt=` | No equivalent under `/ledgers/*`. The reversal‑&‑reclaim statement can't be pulled via WhiteBooks. |

### 6.2 Partially covered (generic, not form‑specific)

| Government form / API | Government endpoint | WhiteBooks coverage |
|---|---|---|
| **GSTR‑9C Upload Document** | `POST taxpayerapi/v1.1/document?action=DOCUPLOAD` | Use the generic `POST /all/docupld` (no 9C‑specific path). |
| **GSTR‑9C Get Doc Status** | `GET …/document?action=DOCSTATUS` | ❌ No generic doc‑status endpoint in WhiteBooks — genuine gap for tracking a 9C upload. |
| **GSTR‑9C Download Document** | `GET …/document?action=DOCDOWNLOAD` | Use the generic `GET /all/docdwld`. |

### 6.3 Listed `N` in 2023 but now present in WhiteBooks (gap closed)

These were `N` in the Dec‑2023 sheet but the 2025‑02 spec **does** expose them — so the
"not available" mark is stale; treat them as available.

| Government API | Now in WhiteBooks |
|---|---|
| GSTR‑4 `getB2BUR` | `GET /gstr4/b2bur` |
| GSTR‑4 `getCDNUR` | `GET /gstr4/cdnur` |
| GSTR‑4 Annual `Get Inward/Outward Supplies` (TXIOS) | `GET /gstr4annual/txios` |
| GSTR‑4 Annual `Proceed to File` | `GET /all/proceedfile` |

### 6.4 Bottom line

After cross‑checking, the **hard gaps in WhiteBooks** are:

1. **GSTR‑10 (Final Return)** — entirely absent (5 endpoints). Biggest gap; affects any
   deregistration flow.
2. **GSTR‑2A ISDA** — amended‑ISD inward pull.
3. **GSTR‑3B opening‑balance save** — read‑only in WhiteBooks.
4. **Ledger `REVRCLM`** — credit‑reversal/re‑claim statement pull.
5. **GSTR‑9C doc status** — no upload‑tracking endpoint.

Everything else in the government catalogue (all of GSTR‑1/1A/2A/2B/2X/3B/4/4A/4Annual/
5/6/6A/7/8/9/9A/9C, CMP‑08, ITC‑03/04, ledgers, payments, IMS, e‑invoice, e‑way bill)
has a WhiteBooks endpoint documented in §4–§5.

> **Note on direction:** the reverse gap is far larger — WhiteBooks exposes plenty the
> raw government "returns" surface treats as internal (e.g. `/all/savemasters`,
> `/gstr2b/gen2b` on‑demand generation, IMS counts, e‑invoice convenience pulls). This
> file only enumerates the **government→WhiteBooks** direction the question asked for.

---

## 7. Error reference

WhiteBooks returns failures in the envelope's `error` object (§4.0) — `status_cd:"0"`
plus `error.error_cd` / `error.message`. The codes are the **underlying GSTN/NIC codes,
passed through largely unchanged**, so the official catalogues apply directly:
`GST-API-Error-Codes(2).docx` (returns/common), `E-invoicing-error-codes.docx` (IRP),
`e_Waybill_error_codes.xlsx` (NIC). The most‑hit ones, grouped by where they occur:

### 7.1 Transport / envelope (HTTP level)

| HTTP | Meaning |
|---|---|
| `200` + `status_cd:"0"` | **Business failure** — read `error.error_cd` (the normal failure path) |
| `404` | Requested entity or API not found |
| `500` | Internal server error — retry with backoff |

### 7.2 Auth, header & request validation (archetypes A–C)

| Code | Meaning |
|---|---|
| `RET11400` | Header value missing |
| `RET11402` | Unauthorized user |
| `RET11403` | Invalid API request |
| `RET11404` | State code not valid |
| `RET11407` | AUTH token invalid (re‑authenticate) |
| `RET11408` | Invalid transaction id (`txn`) |
| `RET11409` | Username not valid |
| `RET11410` / `RET191113` | Invalid GSTIN |
| `RET11420` | Invalid API header value |
| `RET13509` | OTP expired or incorrect |
| `AUTH113` | Invalid return period |
| `AUTH141` | Mandatory GSTIN or return period missing |
| `AUTH143` | Invalid request parameters |
| `AUTH150` / `AUTH151` | Not a valid user / not authorised for this return period |

### 7.3 Save & validation (archetype D/E) — `RET1911xx` family

| Code | Meaning |
|---|---|
| `RET12505` | Corrupted API payload data |
| `RET191103` | Corrupted data or file |
| `RET191106` | JSON structure validation error |
| `RET191107` | At least one line item must be present |
| `RET191111` | Invoice no. already exists in GSTR‑1 of the period |
| `RET191112` | Invalid state code in POS |
| `RET191113` | Counterparty GSTIN same as own / invalid GSTIN |
| `RET191114` | Invoice date before registration date, or later than period / older than 18 months |
| `RET191115` | Invoice has linked credit/debit note(s) — delete those first |
| `RET191117` | Repeated rate, or non‑aggregated HSN/Desc/UQC combination |
| `RET191119` | Receiver GSTIN doesn't match original invoice |
| `RET12590` | Save/action not allowed for current date (filing timeline closed) |

### 7.4 Submit, offset & file (archetypes F–G)

| Code | Meaning |
|---|---|
| `RET12521` | Already submitted for current period |
| `RET12523` | Submit already in progress |
| `RTN_17` | Invoices already submitted |
| `RT_FIL_10` | Submit the invoices before filing |
| `RET13501` | Checksum mismatch while filing/submit |
| `RET13506` / `RET13507` | Invalid DSC signature / signed‑data‑vs‑payload mismatch |
| `RTDSC04` / `RTDSC05` | PAN or sign invalid / DSC verification failed |
| `RT_FIL_02` | Return already filed |
| `RT_FIL_09` | Signed summary is not the latest |
| `RT_FIL_017` / `RT_FIL_018` | User not registered to any DSC / PAN not registered for the GSTIN |
| `RT_FIL_31` | Not authorised to file with EVC |
| `RTN_FIL_28` / `RTN_FIL_29` | Certificate expired / not valid |

### 7.5 Async / file generation (archetype H)

| Code | Meaning |
|---|---|
| `RTN_15` | Returns still under processing — keep polling |
| `RET13508` | No details found for the provided inputs |
| `RTN_24` / `RTN_25` | File generation in progress / error in generation |
| `RTN_31` / `RTN_32` | File generated (download) / download already in progress |
| `RET13504` | Unable to process — try after some time |

### 7.6 E‑invoice (IRP) — NIC `2xxx` codes

| Code | Meaning |
|---|---|
| `2150` | **Duplicate IRN** — document already registered (store the IRN and check before re‑firing) |
| `2154` | IRN details not found |
| `2148` | Requested IRN data not available (wrong IRN or outside permitted window) |
| `2143` | Invoice does not belong to the user GSTIN (e.g. cancelling another's IRN) |
| `2140` / `2141` | Error validating / cancelling invoice (payload not per current schema) |
| `2146` / `2147` | Unable to create / sign IRN — retry after some time |

### 7.7 E‑way bill (NIC) — `1xx` codes

| Code | Meaning |
|---|---|
| `100` | Invalid JSON | 
| `101` / `102` | Invalid username / password |
| `103` / `104` / `110` | Invalid client‑id / client‑secret |
| `105` / `106` | Invalid token / token expired |
| `108` | Invalid login credentials |
| `109` | Decryption of data failed |

**Integration guidance:** check `status_cd` first; on `"0"` branch on `error.error_cd`.
Treat `RET11407`/`2148`/`106` as **re‑authenticate**, `RTN_15`/`RTN_24`/`500` as
**retry‑with‑backoff**, `2150`/`RT_FIL_02`/`RET12521` as **already‑done (idempotent
success)**, and the `RET1911xx`/validation family as **user‑fixable** (surface the
message). Map codes to user‑facing strings in one catalogue rather than leaking them.

---

## 8. How this lands in the SMS codebase

- `backend/src/api/gst/` already has `GstAuthClient` + a generic `GST_API` axios
  provider pointed at the WhiteBooks base URL (`gst.config.ts`: base URL, client
  id/secret, ip, timeout). It is **dormant** — nothing calls it. See [[gst-verification-doc]].
- A real integration would: (1) drive `/authentication/*` for the per‑client token,
  (2) call the module path from §4 (no encryption — §2.3), (3) poll `/gstr/retstatus`
  for async saves, (4) read errors via §7.
- Shop GSTIN identity today is **manual‑entry only**; the Whitebooks `/public/search`
  (Search Taxpayer) is the natural first endpoint to re‑introduce for verification.

---

_Generated from the GSTN developer portal scrape + the WhiteBooks OpenAPI spec and
Released API List. The WhiteBooks endpoint inventory is current as of the 2025‑02 spec;
re‑diff against a fresh spec/Released list before relying on the §6 gap verdicts._
