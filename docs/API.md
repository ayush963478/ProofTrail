# ProofTrail API Contract

Single source of truth for backend and frontend. Both sides MUST implement exactly
these routes, shapes and field names. Do not deviate.

- Base URL: `VITE_API_BASE_URL` (AWS: API Gateway HTTP API URL; local: `http://localhost:4000`)
- Public base URL (for verification links): `PUBLIC_BASE_URL` / `VITE_PUBLIC_BASE_URL`
  (local: `http://localhost:5173`)
- All request/response bodies are JSON unless noted. Binary endpoints return raw bytes.
- Timestamps are ISO-8601 UTC strings (`2026-10-06T12:00:00.000Z`).
- Hashes are lowercase hex SHA-256 (64 chars).

## Error envelope

Non-2xx responses:

```json
{ "error": { "code": "validation_error", "message": "human readable" } }
```

Codes/status: `validation_error` 400, `unauthorized` 401, `forbidden` 403,
`not_found` 404, `conflict` 409, `gone` 410 (expired/revoked share),
`payload_too_large` 413, `hash_mismatch` 422, `rate_limited` 429,
`not_implemented` 501, `internal_error` 500.

## Auth

Two modes, chosen by backend env `AUTH_MODE` (`cognito` | `dev`), reported to the
frontend via `GET /meta`:

- `cognito` — frontend uses `amazon-cognito-identity-js` against the User Pool
  (`VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`). Access token (JWT) is sent
  as `Authorization: Bearer <token>`. Backend verifies RS256 against the pool JWKS.
  MFA: software-token (TOTP) challenge supported.
- `dev` — local mode only. `POST /dev/token { "email": "...", "name": "..." }` →
  `{ "token": "...", "expiresIn": 86400, "user": {...} }` (HS256, env `DEV_JWT_SECRET`).
  Frontend shows a dev login form.

Actor identity in the backend = JWT claim `sub` (cognito) or `sub` (dev, = `usr_<slug>`).

## Common shapes

### User

```json
{ "id": "usr_...", "email": "a@b.c", "name": "Ada", "plan": "free",
  "mfaEnabled": false, "createdAt": "ISO" }
```

`plan` ∈ `free | personal | pro | enterprise`.

### Case

```json
{ "id": "case_...", "ownerId": "usr_...", "title": "Deposit dispute",
  "description": "...", "evidenceCount": 3, "createdAt": "ISO",
  "updatedAt": "ISO", "sharedWith": [] }
```

### Capture metadata

```json
{ "device": "string|null", "appVersion": "string|null", "url": "string|null",
  "gps": { "lat": 12.3, "lng": 45.6 } | null,
  "clientTime": "ISO", "serverTime": "ISO", "userAgent": "string|null" }
```

### EvidenceItem (full record, `GET /evidence/{id}`)

```json
{
  "id": "ev_...",
  "caseId": "case_..." | null,
  "ownerId": "usr_...",
  "type": "photo|page|chat|file|audio|video|text",
  "filename": "chat.png",
  "mimeType": "image/png",
  "size": 12345,
  "sha256": "<hex, set by server after upload>",
  "clientSha256": "<hex, client-computed>",
  "hashMatched": true,
  "storageKey": "vault/2026/10/06/ev_.../chat.png",
  "status": "pending_upload|uploaded|sealing|sealed|failed",
  "sealError": null,
  "captureMethod": "upload|cloud_url|share_import|screen",
  "capture": { ...CaptureMetadata... },
  "proof": null | {
    "manifest": { ...Manifest... },
    "manifestHash": "<hex>",
    "signature": { "keyId": "alias/prooftrail-signing|local_<n>", "algorithm": "ECDSA_SHA_256", "value": "<base64 DER>" },
    "timestamp": { "mode": "rfc3161|local", "tsa": "https://..."|null, "token": "<base64 DER>", "genTime": "ISO" },
    "ledger": { "seq": "000000000042", "prevHash": "<hex>", "entryHash": "<hex>" },
    "anchor": null | { "root": "<hex>", "batchId": "anch_...", "fromSeq": "000000000001",
                       "toSeq": "000000000050", "publishedAt": "ISO", "externalRef": "string|null",
                       "merkleProof": ["<hex sibling>", ...] },
    "sealedAt": "ISO"
  },
  "forensicReport": null | ForensicReport,
  "shares": [ Share ],
  "retentionLock": false,
  "createdAt": "ISO", "updatedAt": "ISO", "deletedAt": null
}
```

### Manifest (canonical JSON — signature covers exactly these bytes)

Produced server-side after sealing. Keys sorted lexicographically, no whitespace,
UTF-8. Field set is FIXED:

```json
{
  "capture": { "appVersion": "...", "clientTime": "ISO", "device": "...",
               "gps": null, "serverTime": "ISO", "url": null },
  "captureMethod": "upload|cloud_url|share_import|screen",
  "evidenceId": "ev_...",
  "filename": "chat.png",
  "serverTime": "ISO",
  "sha256": "<hex>",
  "size": 12345,
  "timestamp": { "genTime": "ISO", "mode": "rfc3161|local", "token": "<base64>", "tsa": "url|null" },
  "type": "photo|page|chat|file|audio|video|text",
  "version": "1.0"
}
```

- `manifestHash = sha256(utf8(canonicalJson(manifest)))`
- `signature.value` = base64 DER ECDSA-SHA256 signature over the canonical manifest
  bytes (WebCrypto-verifiable with the public key from `GET /public/keys/{keyId}`).
  Note: WebCrypto's `verify()` for ECDSA expects the raw `r||s` form (64 bytes for
  P-256), not DER — convert the DER bytes before verifying.
- **Timestamp rule (no circularity)**: a timestamp token cannot cover itself, so
  the TSA timestamp covers `canonicalJson(manifest)` **without** the `timestamp`
  field. The token's `messageImprint.hashedMessage` therefore equals
  `sha256(utf8(canonicalJson(manifest minus timestamp)))`, while `manifestHash`
  and `signature.value` cover the full manifest including the token.

### Ledger entry

```json
{ "seq": "000000000042", "evidenceId": "ev_...", "manifestHash": "<hex>",
  "prevHash": "<hex>", "entryHash": "<hex>", "sealedAt": "ISO" }
```

- `seq` is a zero-padded **12-char** string (per DATA-MODEL.md; lexical order =
  numeric order).

- Genesis `prevHash` = 64 zeros.
- `entryHash = sha256(utf8(prevHash + "|" + manifestHash + "|" + seq))`
- Append-only: conditional put, never updated. Anchor membership is tracked in a
  separate batches table (ranges of seq), so ledger rows never mutate.

### Share

```json
{ "id": "shr_...", "token": "<base64url random, 43 chars>",
  "scope": "evidence|package", "targetId": "ev_...|pkg_...",
  "includeDownload": true, "expiresAt": "ISO"|null, "revokedAt": "ISO"|null,
  "createdAt": "ISO" }
```

Verification URL: `{PUBLIC_BASE_URL}/verify/{token}`

### ForensicReport

```json
{ "evidenceId": "ev_...", "modelVersion": "heuristics-1.0.0",
  "generatedAt": "ISO",
  "indicators": [
    { "name": "metadata_consistency", "status": "flag|clean|unknown",
      "confidence": 0.0, "detail": "human readable" }
  ] }
```

Indicator names (fixed): `metadata_consistency`, `format_vs_extension`,
`edit_software_markers`, `compression_anomaly`, `synthetic_media_markers`,
`provenance_completeness`. Statuses are indicators with confidence — never verdicts.

### Package

```json
{ "id": "pkg_...", "caseId": "case_...", "evidenceIds": ["ev_..."],
  "itemCount": 3, "size": 123456, "generatedAt": "ISO",
  "verificationUrl": "{PUBLIC_BASE_URL}/verify/{token}",
  "shareToken": "<base64url>",
  "downloadUrl": "{API}/packages/pkg_.../download" }
```

ZIP contents: `originals/<filename>`, `report.pdf`, `proof.json`, `README.txt`.

---

## Routes

### Meta (public, no auth)

| Method | Path | Notes |
|---|---|---|
| GET | `/meta` | see below |

```json
{ "appName": "ProofTrail", "authMode": "cognito|dev", "mode": "aws|local",
  "tiers": [
    { "id": "free", "name": "Free", "audience": "Individuals",
      "offer": "Limited captures per month, public verification link" },
    { "id": "personal", "name": "Personal", "audience": "Individuals, freelancers",
      "offer": "More storage, cloud page capture, case folders, PDF reports" },
    { "id": "pro", "name": "Pro", "audience": "Small firms, NGOs",
      "offer": "Team access, branded reports, bulk export, API" },
    { "id": "enterprise", "name": "Enterprise", "audience": "HR, compliance, legal teams",
      "offer": "SSO, audit exports, retention policies, SLA" }
  ] }
```

### Dev auth (only when `authMode === "dev"`)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/dev/token` | `{email, name?}` | `{token, expiresIn, user}` |

### User (auth)

| Method | Path | Response |
|---|---|---|
| GET | `/me` | User |
| PATCH | `/me` | `{name?, plan?}` → User |

### Cases (auth)

| Method | Path | Body / Notes | Response |
|---|---|---|---|
| GET | `/cases` | | `[Case]` |
| POST | `/cases` | `{title, description?}` | Case |
| GET | `/cases/{caseId}` | | Case |
| PATCH | `/cases/{caseId}` | `{title?, description?}` | Case |
| DELETE | `/cases/{caseId}` | deletes case + tombstones its evidence | `{ok: true}` |

### Evidence (auth)

| Method | Path | Body / Notes | Response |
|---|---|---|---|
| POST | `/evidence` | `{caseId?, type, filename, mimeType, size, clientSha256, captureMethod, capture}` | `{id, status:"pending_upload", uploadUrl, uploadHeaders}` |
| PUT | `/evidence/upload/{id}` | **local mode only**: backend-proxied raw upload (this is the `uploadUrl` in local mode) | `{ok:true}` |
| GET | `/evidence` | `?caseId=` optional | `[EvidenceItem]` (proof included if sealed) |
| GET | `/evidence/{id}` | | EvidenceItem |
| POST | `/evidence/{id}/seal` | requires `status:"uploaded"` | `{id, status:"sealing"}` |
| GET | `/evidence/{id}/download` | auth, audit-logged `download` | raw bytes, `Content-Disposition` |
| DELETE | `/evidence/{id}` | tombstone (409 `conflict` if `retentionLock`) | `{ok:true}` |
| POST | `/evidence/{id}/forensics` | runs analysis sync | ForensicReport |

`POST /evidence` details:

- AWS mode: `uploadUrl` = S3 presigned PUT to `s3://$STAGING_BUCKET/uploads/{id}`;
  `uploadHeaders` = `{ "x-amz-meta-client-sha256": "<clientSha256>",
  "x-amz-meta-evidence-id": "<id>" }`. Client sends the file as-is (Content-Type
  from `mimeType`).
- Local mode: `uploadUrl` = `{API}/evidence/upload/{id}`, `uploadHeaders` =
  `{ "x-client-sha256": "<clientSha256>" }`.
- After the client uploads, it calls `POST /evidence/{id}/seal`. Server (or async
  worker) verifies bytes: `sha256(received) === clientSha256` else 422
  `hash_mismatch` (record status `failed`), then runs the seal pipeline:
  timestamp → sign → ledger append → move to vault (write-once).
- Seal is async in `aws` mode (SQS) and runs inline (still async from the client's
  view) in `local` mode. Client polls `GET /evidence/{id}` until `sealed`/`failed`.

### Cloud page capture (auth)

| Method | Path | Body / Notes | Response |
|---|---|---|---|
| POST | `/captures` | `{url, caseId?, waitForContent?}` | `{captureId, status:"queued"}` |
| GET | `/captures` | `?caseId=` | `[CaptureJob]` |
| GET | `/captures/{captureId}` | | CaptureJob |

`CaptureJob`: `{id, url, status:"queued|running|done|failed", error, evidenceId,
caseId, createdAt, updatedAt, screenshotKey?}`.

- `aws` mode: backend starts an ECS Fargate task (`capture-service` image).
- `local` mode: backend spawns `node capture-service/src/index.js` as a child
  process (requires `cd capture-service && npm install`), else returns 501
  `not_implemented` with a helpful message.
- When capture finishes, service stores screenshot + rendered HTML + headers and
  the backend creates an EvidenceItem (`captureMethod:"cloud_url"`) and seals it
  server-side (cloud capture is trusted cloud-side work) — lazily on
  `GET /captures/{id}` or via the internal completion callback. `GET /captures/{id}`
  then returns `status:"done"` + `evidenceId`.
- Internal completion callback (used by local child process): `POST
  /internal/captures/{id}/complete` with header `x-service-token: $SERVICE_TOKEN`;
  body `{status, error?, evidenceId?, screenshotKey?}`.

### Packages (auth)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/packages` | `?caseId=` | `[Package]` |
| POST | `/packages` | `{caseId, evidenceIds?}` (only `sealed` items; default all sealed in case) | Package |
| GET | `/packages/{id}` | | Package |
| GET | `/packages/{id}/download` | auth, audit-logged | ZIP bytes |

Generation is synchronous (Lambda timeout 60s). Creates a package-scoped Share.

### Shares (auth)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/evidence/{id}/shares` | | `[Share]` |
| POST | `/evidence/{id}/shares` | `{includeDownload?, expiresInHours?}` | Share |
| DELETE | `/shares/{shareId}` | revoke | `{ok:true}` |

### Audit (auth)

| Method | Path | Response |
|---|---|---|
| GET | `/evidence/{id}/audit` | `[{id, evidenceId, actor, action, time, ipHash}]`, action ∈ `view|download|share|verify|create|seal` |

### Public verification (no auth; rate-limited)

| Method | Path | Notes | Response |
|---|---|---|---|
| GET | `/public/verify/{token}` | share token; 404 unknown, 410 revoked/expired. `?deep=1` walks full ledger chain | `PublicVerify` |
| POST | `/public/verify` | `{sha256}` → existence probe only | `{exists: bool, sealedAt: ISO|null}` |
| GET | `/public/download/{token}` | only if `includeDownload`; audit-logged | raw bytes |
| GET | `/public/keys/{keyId}` | KMS public key or local key | `{keyId, algorithm:"ECDSA_SHA_256", publicKeyPem, source:"kms"|"local"}` |
| GET | `/public/anchors/{root}` | anchor batch record | `{root, batchId, fromSeq, toSeq, leafCount, publishedAt, externalRef}` |

`PublicVerify` (evidence scope):

```json
{
  "scope": "evidence",
  "kind": "evidence",
  "share": { "createdAt": "ISO", "expiresAt": "ISO|null", "includeDownload": true },
  "evidence": { "id": "ev_...", "type": "...", "filename": "...", "size": 1,
                "sha256": "<hex>", "captureMethod": "...",
                "capture": { ...public subset: url, clientTime, serverTime, device... },
                "sealedAt": "ISO" },
  "proof": { "manifest": {...}, "manifestHash": "<hex>",
             "signature": { "keyId", "algorithm", "value", "publicKeyPem", "source" },
             "timestamp": { "mode", "tsa", "token", "genTime", "verified": true },
             "ledger": { "seq", "prevHash", "entryHash", "chainVerified": true,
                         "deepChecked": false },
             "anchor": null | { "root", "batchId", "fromSeq", "toSeq", "publishedAt",
                                "externalRef", "merkleProof": [...], "included": true } },
  "checks": [
    { "name": "hash_present", "passed": true, "detail": "..." },
    { "name": "manifest_integrity", "passed": true, "detail": "..." },
    { "name": "signature", "passed": true, "detail": "..." },
    { "name": "timestamp", "passed": true, "detail": "..." },
    { "name": "ledger_chain", "passed": true, "detail": "..." },
    { "name": "anchor", "passed": true, "detail": "included in root ..." | "pending batch" }
  ],
  "checksPassed": 6, "checksTotal": 6
}
```

Package scope: same envelope with `"kind": "package"`,
`"package": { "id", "generatedAt", "itemCount" }` and
`"items": [ { "evidence": {...}, "proof": {...}, "checks": [...], "checksPassed", "checksTotal" } ]`.

`anchor` check: `passed:true` with `detail:"pending batch — anchored periodically"`
counts as pass when the entry is not yet in a published batch.

---

## Frontend-independent verification (browser must do its own checks)

The `/verify/:token` page additionally, in the browser with WebCrypto:

1. Compute SHA-256 of the locally selected file → compare to `evidence.sha256`.
2. Recompute `canonicalJson(manifest)` (sorted keys, no whitespace) → sha256 →
   compare to `proof.manifestHash`.
3. Verify `signature.value` (base64 DER) over canonical manifest bytes with
   `signature.publicKeyPem` (ECDSA P-256 / SHA-256). WebCrypto expects the raw
   `r||s` signature form (64 bytes) — convert the DER bytes first.
4. Confirm `manifest.timestamp.token === proof.timestamp.token`.

Server checks and browser checks are displayed side by side ("server says" /
"recomputed in your browser").

## CORS

Backend sends `Access-Control-Allow-Origin` from env `CORS_ORIGINS`
(JSON array, local default: `localhost` and `127.0.0.1` on ports 5173–5176 so a
vite port bump still works; override for anything else), `Allow-Headers:
Authorization,Content-Type,x-client-sha256,x-service-token,x-amz-meta-client-sha256,x-amz-meta-evidence-id`,
`Allow-Methods` incl. PUT, and answers `OPTIONS` preflight.

## Rate limiting

Sliding window per IP, in-memory: public routes 60 req/min, authed 300 req/min.
Exceed → 429 `rate_limited`.
