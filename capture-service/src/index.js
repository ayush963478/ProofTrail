#!/usr/bin/env node
// ProofTrail cloud capture service — headless Chromium page capture.
//
// Invoked in two ways (docs/API.md "Cloud page capture"):
//
//   local   (spawned by backend/src/services/capture.js):
//     node src/index.js --job <captureId> --url <url> --out <dir> \
//                      --api <baseUrl> --service-token <token> [--wait]
//
//   fargate (ECS task, env set by RunTask overrides):
//     MODE=fargate CAPTURE_ID=... CAPTURE_TABLE=... STAGING_BUCKET=...
//     API_BASE_URL=... SERVICE_TOKEN=... CAPTURE_URL=... CAPTURE_WAIT_CONTENT=0|1
//
// Artifacts written to --out (local) / S3 staging (fargate):
//   screenshot.png   full-page render
//   page.html        rendered DOM (page.content())
//   headers.json     main-document response headers + capture metadata
//
// Completion: POST {api}/internal/captures/{id}/complete
//   header  x-service-token: <token>
//   body    {status:"running"|"done"|"failed", error?, screenshotKey?}
// In fargate mode, if the callback is unreachable, the job row is updated in
// DynamoDB directly (the backend lazily completes on GET /captures/{id}).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertUrlAllowed, checkRequestUrl } from './ssrf.js';

const { values: flags } = parseArgs({
  options: {
    job: { type: 'string' },
    url: { type: 'string' },
    out: { type: 'string' },
    api: { type: 'string' },
    'service-token': { type: 'string' },
    wait: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

const MODE = process.env.MODE || 'local';
const isFargate = MODE === 'fargate';

const JOB_ID = isFargate ? process.env.CAPTURE_ID : flags.job;
const TARGET_URL = isFargate ? process.env.CAPTURE_URL : flags.url;
const OUT_DIR = isFargate ? process.env.CAPTURE_OUT || '/tmp/capture' : flags.out;
const API_BASE = (isFargate ? process.env.API_BASE_URL : flags.api || '').replace(/\/+$/, '');
const SERVICE_TOKEN = (isFargate ? process.env.SERVICE_TOKEN : flags['service-token']) || '';
const WAIT_CONTENT = isFargate ? process.env.CAPTURE_WAIT_CONTENT === '1' : Boolean(flags.wait);
const SCREENSHOT_KEY = `captures/${JOB_ID}/screenshot.png`;

const HARD_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS || 165000);
const NAV_TIMEOUT_MS = Number(process.env.CAPTURE_NAV_TIMEOUT_MS || 60000);

function log(msg) {
  console.log(`[capture ${JOB_ID || '?'}] ${msg}`);
}

// ---------------------------------------------------------------------------
// completion callback
// ---------------------------------------------------------------------------

async function postCallback(body, { retries = 3 } = {}) {
  if (!API_BASE) return false;
  const url = `${API_BASE}/internal/captures/${encodeURIComponent(JOB_ID)}/complete`;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': SERVICE_TOKEN,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok || res.status === 409 || res.status === 404) return true;
      lastErr = new Error(`callback responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  log(`completion callback failed: ${lastErr && lastErr.message}`);
  return false;
}

/** fargate fallback: write the job status straight into DynamoDB. */
async function ddbSetStatus(status, error = null) {
  const table = process.env.CAPTURE_TABLE;
  if (!table) return false;
  try {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { GetItemCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const client = new DynamoDBClient({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });
    const key = { PK: { S: `CAP#${JOB_ID}` } };
    const got = await client.send(new GetItemCommand({ TableName: table, Key: key }));
    const current = got.Item && got.Item.data ? JSON.parse(got.Item.data.S) : {};
    const merged = {
      ...current,
      status,
      error,
      screenshotKey: status === 'done' ? SCREENSHOT_KEY : current.screenshotKey ?? null,
      updatedAt: new Date().toISOString(),
    };
    await client.send(
      new PutItemCommand({ TableName: table, Item: { PK: key.PK, data: { S: JSON.stringify(merged) } } })
    );
    return true;
  } catch (err) {
    log(`dynamodb status update failed: ${err.message}`);
    return false;
  }
}

async function markRunning() {
  await postCallback({ status: 'running' }, { retries: 1 }).catch(() => false);
}

async function finish(body) {
  const ok = await postCallback(body);
  if (!ok && isFargate) {
    await ddbSetStatus(body.status, body.error || null);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function run() {
  if (!JOB_ID) throw new Error(isFargate ? 'CAPTURE_ID env is required' : '--job is required');
  if (!TARGET_URL) throw new Error(isFargate ? 'CAPTURE_URL env is required' : '--url is required');

  // Layer 1+2: literal + DNS guard before Chromium is even launched.
  const safeUrl = await assertUrlAllowed(TARGET_URL);
  log(`capturing ${safeUrl} (wait=${WAIT_CONTENT})`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await markRunning();

  const puppeteer = (await import('puppeteer')).default;
  const launchArgs = ['--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'];
  if (process.env.CHROMIUM_NO_SANDBOX === '1' || process.getuid?.() === 0 || process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchArgs.push('--no-sandbox'); // container default; Chrome's sandbox needs extra privileges in Docker
  }
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: launchArgs,
    protocolTimeout: HARD_TIMEOUT_MS,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(
      process.env.CAPTURE_USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ProofTrail/1.0'
    );
    await page.setRequestInterception(true);

    // Layer 1 for every subresource, popup and XHR: SSRF guard per request.
    const blocked = [];
    page.on('request', async (req) => {
      const verdict = await checkRequestUrl(req.url());
      if (verdict.allow) {
        try {
          await req.continue();
          return;
        } catch {
          /* page may be closed/navigated */
        }
      } else {
        blocked.push({ url: req.url(), reason: verdict.reason });
      }
      try {
        await req.abort('blockedbyclient');
      } catch {
        /* already handled */
      }
    });

    const response = await page.goto(safeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    if (WAIT_CONTENT) {
      await page.waitForNetworkIdle({ idleTime: 1200, timeout: 20000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 800)); // settle SPA re-renders
    }

    const capturedAt = new Date().toISOString();
    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const screenshot = Buffer.from(await page.screenshot({ fullPage: true, type: 'png' }));
    const html = await page.content();

    const headersInfo = {
      jobId: JOB_ID,
      requestedUrl: safeUrl,
      finalUrl,
      title,
      capturedAt,
      waitedForContent: WAIT_CONTENT,
      status: response ? response.status() : null,
      statusText: response ? response.statusText() : null,
      headers: response ? response.headers() : {},
      userAgent: await browser.userAgent().catch(() => null),
      blockedRequests: blocked,
    };

    fs.writeFileSync(path.join(OUT_DIR, 'screenshot.png'), screenshot);
    fs.writeFileSync(path.join(OUT_DIR, 'page.html'), html, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'headers.json'), JSON.stringify(headersInfo, null, 2), 'utf8');
    log(`captured ${finalUrl} — ${screenshot.length} bytes png, ${html.length} bytes html`);

    // fargate: push the screenshot to staging so the backend can read it
    if (isFargate) {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const bucket = process.env.STAGING_BUCKET;
      if (bucket) {
        const s3 = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: SCREENSHOT_KEY,
            Body: screenshot,
            ContentType: 'image/png',
          })
        );
        log(`uploaded ${SCREENSHOT_KEY} to ${bucket}`);
      }
    }

    await finish({ status: 'done', screenshotKey: isFargate ? SCREENSHOT_KEY : undefined });
    log('done');
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  log(`hard timeout after ${HARD_TIMEOUT_MS}ms`);
  finish({ status: 'failed', error: `capture timed out (${Math.round(HARD_TIMEOUT_MS / 1000)}s)` }).finally(() => {
    process.exit(1);
  });
}, HARD_TIMEOUT_MS);
watchdog.unref?.();

run()
  .then(() => process.exit(0))
  .catch(async (err) => {
    log(`FAILED: ${err.message}`);
    await finish({ status: 'failed', error: String(err.message || err).slice(0, 500) }).catch(() => {});
    process.exit(1);
  });
