# ProofTrail Architecture

Implementation of the blueprint's four layers, with two runtime profiles that share
one code base.

## Blueprint layers → code

| Blueprint layer | Implementation |
|---|---|
| **1 Capture** — browser extension, mobile app, cloud page capture | `frontend/` web capture (file upload with client-side SHA-256, metadata); `capture-service/` headless Chromium on Fargate (Dockerfile + Puppeteer) for cloud URL capture. Mobile app & extension are roadmap phases 2+ (noted in README). |
| **2 Trust engine** — hash + timestamp, digital signing, ledger anchoring | `backend/src/services/seal.js` pipeline; `crypto/rfc3161.js` (RFC 3161 TSA client, no deps), `crypto/keys.js` (KMS `Sign` in aws mode / local EC P-256), `crypto/canonical.js` + `crypto/signature.js` (canonical manifest + ECDSA), `services/ledger.js` (hash-chained append-only), `crypto/merkle.js` + `services/anchor.js` (periodic Merkle-root batching, external publish log) |
| **3 Storage** — immutable vault, metadata DB, access audit log | S3 bucket with **Object Lock (compliance)** + versioning + SSE-KMS; DynamoDB (single-table main + ledger + anchor + audit + capture tables); `services/audit.js` (every view/download/share/verify, ip-hash only) |
| **4 Output** — verification portal, evidence package, AI forensic check | `GET /public/verify/{token}` + `frontend/src/pages/Verify.jsx` (static, no login); `services/package.js` (originals + `report.pdf` via pdfkit + `proof.json` + QR + README, zipped); `services/forensics.js` (heuristic indicators with confidence — never verdicts) |

Design principle from the blueprint — *"the client is never trusted on its own"* —
is enforced: the client sends only a claim (`clientSha256`); the server recomputes
the hash of the received bytes, does the timestamping/signing/ledger work cloud-side,
and the vault is write-once.

## Runtime profiles

Selected by env `MODE` (`local` if unset and no AWS table/bucket envs present):

| Concern | aws (blueprint default) | local (dev/demo/tests) |
|---|---|---|
| API | API Gateway HTTP API → Lambda (`api.js`, `public.js`) | Node HTTP server `src/local-server.js` wrapping the same handlers |
| Auth | Cognito (RS256 JWT, JWKS), MFA | `AUTH_MODE=dev`, HS256 token from `POST /dev/token` |
| Storage | S3 staging (presigned PUT) + S3 Object Lock vault | filesystem `.data/staging` + `.data/vault`, write-once |
| DB | DynamoDB (4 tables) | JSON files `.data/tables/` |
| Keys | KMS ECC_NIST_P256 | EC P-256 PEM files `.data/keys/` |
| Timestamp | RFC 3161 TSA (default `https://freetsa.org/tsr`) | `TSA_MODE=local` fallback (dev key, `mode:"local"` flagged in proof) or rfc3161 if network |
| Queue | SQS seal queue → `sealWorker.js` | inline async (same handler, called directly) |
| Anchoring | EventBridge `rate(15 minutes)` → `anchorScheduler.js` | timer in local server + `npm run anchor` script |
| Capture | ECS Fargate task (`capture-service` image) | child process `node capture-service/src/index.js` |
| Forensics | Lambda (`forensics.js` heuristics; containerized models later per blueprint) | same |

The verification flow, manifest format, signature algorithm and ledger rules are
**identical** in both profiles, so a locally produced proof verifies the same way
a deployed one does.

## End-to-end flows (blueprint §3 → endpoints)

1. **Capture** — `frontend` upload (or `POST /captures` for cloud URL).
2. **Upload** — client computes SHA-256 (WebCrypto) → `POST /evidence` → PUT bytes.
3. **Verify & hash** — server recomputes SHA-256, compares, rejects mismatch (422).
4. **Trusted timestamp** — TSA token over the canonical manifest bytes.
5. **Sign** — KMS/local key signs the canonical manifest (ECDSA P-256, DER).
6. **Anchor** — ledger entry appended (hash-chained); scheduled worker publishes
   Merkle roots of entry batches + external publish log.
7. **Store** — original moved staging → vault (write-once), metadata → DB.
8. **Package** — `POST /packages`: originals + PDF report + proof.json + QR
   verification link → zip → `verificationUrl` share token.
9. **Verify** — `frontend /verify/:token` (no login): server recomputes all checks
   *and* the browser independently recomputes file hash, manifest hash and the
   signature with WebCrypto; any byte change fails.

## Security & privacy (blueprint §7 → implemented)

- TLS everywhere (AWS: API GW; local dev is http, documented).
- Least privilege: Lambda execution roles scoped per table/bucket; capture task role
  can only write capture table + staging prefix; vault has no delete permission.
- Private by default: evidence visible only to owner until a share link is created;
  shares expire/revocable.
- Access audit log with ip-hash (no raw IPs stored).
- Rate limiting on public verification endpoints; abuse note in docs.
- Data minimisation: only listed metadata fields collected; GPS optional.

## Repo layout

```
ProofTrail/
├── README.md
├── docs/                  API.md, DATA-MODEL.md, ARCHITECTURE.md, blueprint summary
├── backend/               Lambda handlers + services + crypto + tests (node:test)
├── capture-service/       Headless Chromium capture (Puppeteer, Dockerfile)
├── infrastructure/        AWS SAM template.yaml, sample events, deploy notes
└── frontend/              React + Vite + Tailwind; app + static verification portal
```
