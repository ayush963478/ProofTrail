# ProofTrail

**A cloud-based verified chain of custody for everyday digital evidence.**

Screenshots, chat exports and photos are the most common evidence in scams,
harassment, landlord and contractor disputes — and they are trivially easy to
edit. ProofTrail lets anyone capture digital evidence at the moment it exists,
seal it cryptographically in the cloud, and produce a package whose integrity
anyone can verify independently with a link.

Core promise:

- Prove the content existed at a specific time.
- Prove it has not been changed since capture.
- Prove where it came from (URL, device, app) as far as technically possible.
- Make verification free and instant for the person receiving it.

This repository implements the project blueprint (architecture, working, data
model, security, roadmap — see `docs/`). The client is never trusted on its
own: anything the client claims is re-checked or recorded by the server, and
nothing in the vault can be modified after writing.

## Stack (per blueprint §5)

| Layer | Choice |
|---|---|
| Web and portal | React + Vite + Tailwind CSS, static-hosted verification page |
| API | AWS API Gateway (HTTP API) + Lambda (Node.js) |
| Page capture | Containerised headless Chromium on Fargate (Puppeteer) |
| Original storage | S3 with Object Lock (compliance mode) — write-once, retention enforced |
| Database | DynamoDB (cases, users, evidence index + append-only ledger) |
| Ledger | Hash-chained append-only table + periodic Merkle-root anchoring |
| Keys | AWS KMS asymmetric signing (ECC NIST P-256) — keys never leave hardware |
| Auth | Amazon Cognito with MFA (software token) |
| Queue and events | SQS (seal pipeline) + EventBridge (scheduled anchoring) |
| AI analysis | Containerised/Lambda forensic heuristics (swappable models) |
| Observability | CloudWatch Logs (API access logs, structured events) |

A **local mode** runs the same code with no AWS account: filesystem write-once
vault, JSON-file tables, local EC P-256 keys, dev JWT auth — so the whole
capture → seal → verify slice can be demonstrated offline. The manifest format,
signature algorithm and ledger rules are identical in both modes.

## Project structure

```
ProofTrail/
├── docs/
│   ├── API.md              Full API contract (backend + frontend source of truth)
│   ├── DATA-MODEL.md       Blueprint entities → storage mapping
│   └── ARCHITECTURE.md     Four layers, runtime profiles, end-to-end flows
├── backend/                Lambda handlers, trust engine, services, tests
│   └── src/{crypto,services,handlers}/
├── capture-service/        Headless Chromium capture (Puppeteer + Dockerfile)
├── infrastructure/         AWS SAM template, sample events, deploy notes
└── frontend/               React app: user portal + public verification portal
```

## Quick start (local mode, no AWS needed)

Prerequisites: Node.js 20+ and npm.

```powershell
npm run setup             # one-time: installs backend + frontend + capture-service deps
npm run dev               # starts API (http://localhost:4000) + web app (http://localhost:5173)
```

Open http://localhost:5173 and log in with the dev login form (any email —
local mode issues a dev JWT). Then: create a case → capture/upload a file (its
SHA-256 is computed in your browser) → watch the seal pipeline (hash → trusted
timestamp → signature → ledger → vault) → open the share link in a private
window to run the public verification, which checks the hash, signature,
timestamp and ledger independently in the browser.

Running `npm run dev` twice is safe: an already-running backend is reused, and
a port owned by another application produces a clear error instead of a second
server against the same data directory.

### Visual Studio Code

1. Open this folder (`File → Open Folder...`).
2. Run everything: `Terminal → Run Task... → ProofTrail: dev (all)`, or simply
   `npm run dev` in the integrated terminal.
3. Debug with **F5**: choose **Run full stack (backend + frontend)** for both
   processes, a single process, or **Frontend: open in Chrome** once the
   servers are up. Set breakpoints anywhere under `backend/src`.
4. Other tasks: `backend: tests`, `capture-service: tests`, `frontend: build`,
   `setup: install all dependencies`.

### Manual (two terminals)

```powershell
# 1. Backend (port 4000)
cd backend
npm install
npm test                 # unit + end-to-end tests (node:test)
npm run dev              # local API server

# 2. Frontend (port 5173)
cd frontend
npm install
npm run dev              # open http://localhost:5173
```

Optional — cloud page capture in local mode:

```powershell
cd capture-service
npm install               # downloads Chromium (~150 MB)
```

## Deploy to AWS (blueprint stack)

```powershell
cd infrastructure
sam build
sam deploy --guided       # stack name: prooftrail
```

The stack creates the HTTP API + Lambdas, Cognito user pool (MFA), DynamoDB
tables, staging bucket and the S3 Object Lock vault, KMS signing key, SQS seal
queue + DLQ, EventBridge anchor schedule, ECS/Fargate capture task, CloudWatch
log groups, and S3 + CloudFront hosting for the built frontend. See
`infrastructure/README.md` for details and post-deploy steps (build the
frontend, sync to the hosting bucket, build/push the capture image to ECR).

## How it works (blueprint §3)

1. **Capture** — user uploads a file (or presses the extension / passes a URL
   for cloud-side capture).
2. **Upload** — client computes SHA-256 and sends raw bytes + metadata.
3. **Verify & hash** — server recomputes the hash; mismatch ⇒ rejected (422).
4. **Trusted timestamp** — RFC 3161 time-stamping authority token over the
   canonical manifest (time proof independent of our own clock).
5. **Sign** — KMS-held key signs the canonical manifest (ECDSA P-256).
6. **Anchor** — manifest hash appended to the hash-chained ledger; scheduled
   worker publishes Merkle roots of batches to an external publish log.
7. **Store** — original written to the write-once vault (Object Lock in AWS).
8. **Package** — originals + human-readable PDF report + machine-checkable
   `proof.json` + QR verification link, zipped.
9. **Verify** — recipient opens `/verify/<token>` (no login): the server
   re-runs every check *and* the browser independently recomputes the file
   hash, manifest hash and signature with WebCrypto. Any change to a single
   byte fails verification.

## Pricing tiers (blueprint §9)

| Tier | Audience | Offer |
|---|---|---|
| Free | Individuals | Limited captures per month, public verification link |
| Personal | Individuals, freelancers | More storage, cloud page capture, case folders, PDF reports |
| Pro | Small firms, NGOs | Team access, branded reports, bulk export, API |
| Enterprise | HR, compliance, legal | SSO, audit exports, retention policies, SLA |

## Legal notes

ProofTrail strengthens the technical credibility of evidence; it does not
decide admissibility — rules differ by country and court. The product
describes itself as supporting authenticity, not guaranteeing acceptance, and
the generated PDF report carries the blueprint's stated limits: a capture
proves what was on the screen or page at capture time, not that the underlying
claim is true. Forensic analysis output is presented as indicators with
confidence levels, never as certainty.

## Roadmap status

Implemented in this repository (blueprint phase 1–3 scope): capture/upload,
hash verification, RFC 3161 timestamping, KMS/local signing, immutable vault,
hash-chained ledger + Merkle anchoring, cases, share links, evidence packages
(PDF + proof bundle), public verification portal, audit log, forensic
indicators, cloud URL capture service. Blueprint phases 4–5 (mobile app,
browser extension, teams/SSO, regional hosting) remain future work.
