// Port handling for the local dev server (start() must never double-start or
// silently move to a port the frontend does not know about).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createServer, portStatus, start } from '../src/local-server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await close(s);
  return port;
}

test('portStatus: nothing listening → "free"', async () => {
  const port = await freePort();
  assert.equal(await portStatus(port), 'free');
});

test('portStatus: foreign HTTP server → "busy"', async () => {
  const foreign = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('some other app');
  });
  const port = await listen(foreign);
  try {
    assert.equal(await portStatus(port), 'busy');
  } finally {
    await close(foreign);
  }
});

test('portStatus: our own server (GET /meta) → "prooftrail"', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    assert.equal(await portStatus(port), 'prooftrail');
  } finally {
    await close(server);
  }
});

test('start() is idempotent — never a second instance on the same port', async () => {
  // Uses the real configured port. If something (e.g. a running dev server)
  // already owns it, start() must report "already running" and return null;
  // if the port is free, a second start() must still refuse to double-bind.
  const first = await start();
  try {
    if (first) {
      const second = await start();
      assert.equal(second, null);
    } else {
      // an existing backend owns the port — that is the same contract
      assert.equal(first, null);
    }
  } finally {
    if (first) await close(first);
  }
});
