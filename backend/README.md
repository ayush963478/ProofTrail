# ProofTrail backend

Implements blueprint layers 2–4: trust engine (hash → RFC 3161 timestamp →
signature → hash-chained ledger → Merkle anchoring), storage (staging + write-once
vault + metadata DB + audit log) and output (packages, public verification API).

Runs two ways from the same code:

- **local** — Node HTTP server on port 4000, filesystem vault, JSON-file tables,
  local EC P-256 keys, dev JWT auth. No AWS account needed.
- **aws** — Lambda handlers (`src/handlers/*`) behind API Gateway HTTP API, SQS,
  EventBridge, S3 Object Lock, DynamoDB, KMS, Cognito. Deployed via
  `../infrastructure/template.yaml`.

## Commands

```powershell
npm install
npm test          # node:test unit + end-to-end tests
npm run dev       # local API server on http://localhost:4000
npm run anchor    # run one Merkle anchoring batch (local mode)
```

## Key files

| Path | Role |
|---|---|
| `src/crypto/canonical.js` | canonical JSON (sorted keys, no whitespace) — signature bytes |
| `src/crypto/rfc3161.js` | zero-dependency RFC 3161 timestamp client + verifier |
| `src/crypto/keys.js` | signing: AWS KMS (aws) / local EC P-256 (local) |
| `src/crypto/merkle.js` | Merkle tree, root, inclusion proofs |
| `src/services/seal.js` | the seal pipeline (steps 3–7 of blueprint §3) |
| `src/services/ledger.js` | append-only hash-chained ledger |
| `src/services/anchor.js` | periodic Merkle-root batching + external publish |
| `src/services/forensics.js` | heuristic indicators (never verdicts) |
| `src/services/package.js` | PDF report + proof.json + QR zip |
| `src/services/verify.js` | the six public verification checks |

All environment variables are documented in `.env.example`; the API contract lives
in `../docs/API.md`.
