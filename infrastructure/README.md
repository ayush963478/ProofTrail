# ProofTrail — AWS deployment (SAM)

Everything the blueprint's "Deploy to AWS" section promises:

| Resource | Template resource |
|---|---|
| HTTP API (payload v2) + access logs | `HttpApi`, `ApiAccessLogGroup` |
| API Lambdas | `ApiFunction` (app routes), `PublicFunction` (`/meta`, `/public/*`, `/dev/token`, `/internal/*`) |
| Async seal worker (SQS) | `SealWorkerFunction` + `SealQueue` + `SealDeadLetterQueue` |
| Scheduled anchoring (EventBridge) | `AnchorSchedulerFunction`, `rate(15 minutes)` |
| DynamoDB | `MainTable` (PK/SK + GSI1), `LedgerTable`, `AnchorTable` (TTL), `AuditTable` (TTL), `CaptureTable` |
| Staging bucket + **Object Lock (COMPLIANCE) vault** | `StagingBucket`, `VaultBucket` (retained on stack delete) |
| KMS | `SigningKey` (ECC NIST P-256, SIGN_VERIFY), `StorageKey` (S3) |
| Cognito (software-token MFA) | `UserPool`, `UserPoolClient` |
| Fargate page capture | `CaptureCluster`, `CaptureTaskDef` (conditional), roles, logs |
| Frontend hosting | `FrontendBucket` + `FrontendOAC` + `FrontendDistribution` (CloudFront, SPA errors → `/index.html`) |

## Prerequisites

- AWS CLI v2 configured (`aws configure`)
- AWS SAM CLI (`sam --version`)
- Node.js 20+
- Docker (only for building the capture image)

## 1. Deploy the stack

```powershell
cd infrastructure
sam build
sam deploy --guided          # stack name: prooftrail
```

`--guided` writes `samconfig.toml`; a commented example lives in
`samconfig.example.toml`. Parameters you may want to set immediately:

| Parameter | Default | Notes |
|---|---|---|
| `AuthMode` | `cognito` | set `dev` only for testing (enables `POST /dev/token`) |
| `TsaMode` | `rfc3161` | real RFC 3161 against `TsaUrl` (freetsa.org) |
| `ServiceToken` | *change me* | shared secret for the internal capture callback — **set a long random value** |
| `AuditSalt` | *change me* | pepper for audit IP hashes |
| `VaultRetentionDays` | `30` | Object Lock COMPLIANCE retention (undeletable for N days) |
| `CaptureImageUri` | *(empty)* | fill after step 3, or leave empty → `POST /captures` returns 501 |
| `CaptureSubnets` / `CaptureSecurityGroups` | *(empty)* | default-VPC subnets are fine; SG needs outbound HTTPS |

Note the outputs afterwards:

```powershell
aws cloudformation describe-stacks --stack-name prooftrail \
  --query "Stacks[0].Outputs" --output table
```

`ApiUrl` and `FrontendUrl` are what you need for the next steps.

## 2. Build and publish the frontend

The stack already wires `PUBLIC_BASE_URL` and `CORS_ORIGINS` to the CloudFront
domain — but the frontend bundle needs the API URL at build time:

```powershell
cd frontend
# .env.production:
#   VITE_API_BASE_URL=<ApiUrl output>          e.g. https://abc123.execute-api.us-east-1.amazonaws.com
#   VITE_PUBLIC_BASE_URL=https://<FrontendUrl domain>
#   VITE_AUTH_MODE=cognito
#   VITE_COGNITO_USER_POOL_ID=<UserPoolId output>
#   VITE_COGNITO_CLIENT_ID=<UserPoolClientId output>
npm install
npm run build
aws s3 sync dist/ s3://<FrontendBucketName output>/ --delete
```

Open `https://<FrontendUrl>` → sign up → confirm the email code → sign in.
Enable TOTP MFA in the app (blueprint: software-token MFA).

## 3. Capture service image (optional, cloud page capture)

```powershell
cd capture-service
aws ecr create-repository --repository-name prooftrail-capture
docker build -t prooftrail-capture .
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag prooftrail-capture <account>.dkr.ecr.us-east-1.amazonaws.com/prooftrail-capture:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/prooftrail-capture:latest
```

Then update the stack parameter (creates the Fargate task definition):

```powershell
sam deploy --parameter-overrides CaptureImageUri=<account>.dkr.ecr.us-east-1.amazonaws.com/prooftrail-capture:latest
```

`CAPTURE_SUBNETS` / `CAPTURE_SG` must be set for `RunTask` to work (see the
parameter table). Without the image or subnets, `POST /captures` returns a
helpful `501 not_implemented`.

## How the pieces connect

- **Uploads** go browser → presigned S3 PUT on the staging bucket (CORS is
  configured on the bucket — required for cross-origin browser PUTs).
- **Sealing** is asynchronous: `POST /evidence/{id}/seal` enqueues to SQS →
  `SealWorkerFunction` runs hash → RFC 3161 timestamp → KMS `Sign` → ledger
  append → copy staging → vault (`IfNoneMatch: *` on the Object Lock bucket).
- **Anchoring** runs every 15 minutes: new ledger entries → Merkle batch →
  `ANCHOR table` + optional `AnchorExternalUrl` POST.
- **Verification** is public: `GET /public/verify/{token}` (add `?deep=1` to
  walk the full ledger chain). No auth, no account.
- **Downloads** stream through the API with `Content-Disposition`.

## Testing events locally

```powershell
sam local invoke ApiFunction        -e events/api-cases.json
sam local invoke PublicFunction     -e events/api-verify.json
sam local invoke SealWorkerFunction -e events/sqs-seal.json
sam local invoke AnchorSchedulerFunction -e events/schedule-anchor.json
```

(Local mode needs no AWS at all — see the root `README.md`; the Lambda code
is the same code paths with `MODE=local`.)

## Operational notes & known limits

- **CloudWatch**: API access logs in `/aws/apigateway/prooftrail`, Lambda logs
  per function, capture logs in `/ecs/prooftrail-capture`.
- **Rate limiting** is per-Lambda-instance in-process (best effort). Add API
  Gateway throttling (`AWS::ApiGatewayV2::Stage` `DefaultRouteSettings`) if you
  need hard limits.
- **API Gateway response cap is 10 MB**: very large package/evidence downloads
  served through the API can fail in aws mode. Presigned-GET redirects are the
  intended remediation if you grow past that.
- **Retention**: `VaultBucket` has `DeletionPolicy: Retain` and COMPLIANCE
  object lock — sealed originals survive stack deletion and cannot be deleted
  before `VaultRetentionDays`. Everything else is deleted by `sam delete`.
- **Key rotation**: KMS signing keys are non-exportable; old key ids stay
  valid in proofs (rotate by creating a new key and changing `KMS_KEY_ID`).

## Teardown

```powershell
sam delete --stack-name prooftrail
```

The vault bucket is retained on purpose (write-once evidence). Empty it
manually only after the Object Lock retention expires, if you really mean it.
