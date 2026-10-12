# ProofTrail Data Model

Maps the blueprint entities (§6) onto storage. Two backends behind one repository
interface (`backend/src/services/db.js`):

- **aws** — DynamoDB tables (single-table for the main index + dedicated append-only
  tables), created by `infrastructure/template.yaml`.
- **local** — JSON files under `backend/.data/tables/*.json` (atomic write, dev/tests
  only). Same access patterns.

## Entity → storage mapping

| Blueprint entity | Storage |
|---|---|
| User | Cognito User Pool (aws) / token subject (local) + `User` item in MAIN |
| Case | MAIN `CASE#<id>` |
| EvidenceItem | MAIN `EVID#<id>` (`META` + `CAPTURE` attributes) |
| CaptureMetadata | MAIN `EVID#<id>` attribute `capture` |
| ProofRecord | MAIN `EVID#<id>` attribute `proof` (immutable after `sealed`) |
| AccessLog | AUDIT table |
| Package | MAIN `PKG#<id>` |
| ForensicReport | MAIN `EVID#<id>` attribute `forensicReport` |
| (ledger) | LEDGER table, append-only, hash-chained |
| (anchor batches) | ANCHOR table |
| (capture jobs) | CAPTURE table |

## MAIN table (`$MAIN_TABLE`, blueprint "evidence index")

Composite key: `PK` + `SK`. GSI `GSI1` (`GSI1PK` + `GSI1SK`) for owner listings.

| PK | SK | GSI1PK | GSI1SK | Attributes |
|---|---|---|---|---|
| `USR#<uid>` | `PROFILE` | — | — | id, email, name, plan, mfaEnabled, createdAt |
| `CASE#<cid>` | `META` | `USR#<uid>` | `CASE#<createdAt>#<cid>` | Case fields |
| `EVID#<eid>` | `META` | `USR#<uid>` | `EVID#<createdAt>#<eid>` | EvidenceItem core + status + sha256 + storageKey + proof + forensicReport + capture |
| `EVID#<eid>` | `SHARE#<shareId>` | — | — | Share (also duplicated under `SHARE#<token>` for public lookup) |
| `SHARE#<token>` | `META` | — | — | Share (public lookup by token; contains no evidence content, only targetId + flags) |
| `PKG#<pid>` | `META` | `USR#<uid>` | `PKG#<createdAt>#<pid>` | Package fields |

Queries:

- list cases by owner → `Query GSI1PK = USR#<uid> AND begins_with(GSI1SK, 'CASE#')`
- list evidence by owner (+ optional caseId filter in app) → `GSI1PK = USR#<uid>`,
  `begins_with(GSI1SK, 'EVID#')`, descending
- share by token → `Get PK=SHARE#<token>, SK=META`

## LEDGER table (`$LEDGER_TABLE`, append-only, hash-chained)

| PK | Attributes |
|---|---|
| `seq` = zero-padded 12-char string (`"000000000042"`) | evidenceId, manifestHash, prevHash, entryHash, sealedAt |

Rules:

- Append with `PutItem` + condition `attribute_not_exists(PK)`. Never an update.
- `entryHash = sha256(prevHash + "|" + manifestHash + "|" + seq)`,
  genesis `prevHash = "0"*64`.
- Next seq = read current max (Query ScanIndexForward desc limit 1) + 1 inside a
  conditional write; on condition failure, retry (single-writer retry loop).
- Chain verification: recompute entryHash for an entry and its previous link;
  `?deep=1` walks to genesis.

## ANCHOR table (`$ANCHOR_TABLE`, Merkle batches)

| PK | Attributes |
|---|---|
| `ROOT#<rootHex>` | batchId, fromSeq, toSeq, leafCount, publishedAt, externalRef, entries: [{seq, entryHash}] (leaves for proof reconstruction — capped batch size 500) |
| `BATCH#<batchId>` | root, fromSeq, toSeq (range index) |

Published by the scheduled anchor worker (EventBridge `rate(15 minutes)` in aws
mode, timer in local mode): take all ledger entries with seq > last batch's
`toSeq` → leaves = entryHash → Merkle tree → root → write both PKs → publish
externally (`ANCHOR_EXTERNAL_URL` POST if set; always append to the external
publish log so the operator itself cannot rewrite batches silently). Verification
resolves `seq` → batch via range scan of BATCH items (small N).

## AUDIT table (`$AUDIT_TABLE`, access log)

| PK | SK | Attributes |
|---|---|---|
| `EVID#<eid>` | `<timeISO>#<action>#<rand>` | evidenceId, actor (`usr_...` or `anonymous`), action ∈ view/download/share/verify/create/seal, time, ipHash = sha256(ip + AUDIT_SALT) hex |

TTL attribute `expiresAt` = now + 365d (audit kept, content never stored here).

## CAPTURE table (`$CAPTURE_TABLE`)

| PK | Attributes |
|---|---|
| `CAP#<id>` | id, url, status queued/running/done/failed, error, caseId, evidenceId, ownerId, screenshotKey, createdAt, updatedAt |

## Buckets (aws)

- `$STAGING_BUCKET` — presigned PUT targets, no Object Lock, lifecycle expiry 7 days.
- `$VAULT_BUCKET` — **S3 Object Lock, compliance mode**, versioning on,
  default retention `VAULT_RETENTION_DAYS` (default 2555 ≈ 7 years), SSE-KMS.
  Keys: `vault/<yyyy>/<mm>/<dd>/<evidenceId>/<filename>` (originals),
  `packages/<packageId>.zip`. Write-once: a key is never overwritten; seal writes
  with `IfNoneMatch: *`.
- Local mode: `backend/.data/staging/` and `backend/.data/vault/` — same key layout,
  write-once enforced by refusing to create an existing path (app-level Object Lock).

## Keys

- aws: KMS asymmetric key (`alias/prooftrail-signing`, ECC_NIST_P256,
  SIGN_VERIFY). `keyId` stored in each proof = key ARN at seal time; old keys stay
  in KMS for verification after rotation (env `ACTIVE_SIGNING_KEY` points at the
  current one).
- local: EC P-256 keypairs PEM in `backend/.data/keys/<keyId>.{key.pem,pub.pem}`;
  `keyId = local_<n>`; `publicKeyPem` served by `GET /public/keys/{keyId}`.
