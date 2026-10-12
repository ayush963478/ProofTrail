# ProofTrail capture service

Containerised **headless Chromium** page capture (blueprint §4/§5): renders a
URL, takes a full-page screenshot, saves the rendered HTML and the main
document's response headers, then reports back to the backend so the capture
becomes a sealed EvidenceItem (`captureMethod: "cloud_url"`).

It runs in two modes with the same code:

| Mode | Started by | Transport |
|---|---|---|
| `local` | backend child process (`POST /captures` in local mode) | CLI flags, completion via internal callback |
| `fargate` | ECS Fargate task (`RunTask` in aws mode) | env vars, completion via callback with direct-DynamoDB fallback |

## Local install

```powershell
cd capture-service
npm install          # downloads Chromium (~150 MB) on first run
npm test             # SSRF guard unit tests (node:test)
```

The backend checks that `capture-service/node_modules` exists before spawning;
otherwise `POST /captures` returns `501 not_implemented` with this hint.

### Manual invocation

```powershell
node src/index.js --job cap_x --url https://example.com `
                  --out .\capture-out\cap_x --api http://localhost:4000 `
                  --service-token local-service-token --wait
```

Artifacts written to `--out`:

- `screenshot.png` — full-page render
- `page.html` — rendered DOM
- `headers.json` — main-document status/headers + capture metadata

## Completion callback

```
POST {api}/internal/captures/{captureId}/complete
x-service-token: <SERVICE_TOKEN>
{ "status": "running" | "done" | "failed", "error"?: "...", "screenshotKey"?: "captures/<id>/screenshot.png" }
```

The backend then creates the EvidenceItem from `screenshot.png` and seals it.

## Fargate environment

| Variable | Meaning |
|---|---|
| `MODE` | `fargate` |
| `CAPTURE_ID` | job id |
| `CAPTURE_URL` | URL to capture |
| `CAPTURE_WAIT_CONTENT` | `1` = wait for network idle before shot |
| `CAPTURE_TABLE` | DynamoDB capture table (fallback status updates) |
| `STAGING_BUCKET` | S3 bucket for `captures/<id>/screenshot.png` |
| `API_BASE_URL` | backend base URL for the completion callback |
| `SERVICE_TOKEN` | shared secret for `x-service-token` |
| `PUPPETEER_EXECUTABLE_PATH` | set in the Docker image (`/usr/bin/chromium`) |

## Docker

```powershell
docker build -t prooftrail-capture .
docker run --rm -e MODE=fargate -e CAPTURE_ID=cap_1 `
  -e CAPTURE_URL=https://example.com -e API_BASE_URL=https://api.example.com `
  -e SERVICE_TOKEN=... -e STAGING_BUCKET=... -e CAPTURE_TABLE=... prooftrail-capture
```

Uses Debian's Chromium (no ~150 MB Puppeteer download inside the image).
Push to ECR and set the `CaptureImageUri` parameter when deploying
`infrastructure/` (see `infrastructure/README.md`).

## Security: SSRF guard

A capture service is a server-side request forge waiting to happen, so
`src/ssrf.js` enforces two layers:

1. **Literal checks** on every URL — only `http/https`; blocks `localhost`,
   `*.local`/`*.localhost`/`*.internal`, metadata hosts, and IP literals in
   private ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`
   incl. `169.254.169.254`, CGNAT `100.64/10`, TEST-NETs, multicast; IPv6
   `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, IPv4-mapped).
2. **DNS resolution checks** — every host is resolved and every address must
   be public; one private address rejects the request (defeats DNS rebinding).

The guard runs **before** Chromium launches *and* as a Puppeteer request
interceptor for **every** subresource, XHR, redirect and popup, with a 30 s
per-host DNS cache. Blocked requests are aborted and listed in
`headers.json → blockedRequests`.
