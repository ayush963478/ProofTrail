import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUrlAllowed,
  checkRequestUrl,
  hostnameRejectReason,
  ipv4IsPrivate,
  ipv6IsPrivate,
  addressIsPrivate,
  clearDnsCache,
} from '../src/ssrf.js';

const lookupPublic = async () => [{ address: '93.184.216.34' }];
const lookupPrivate = async () => [{ address: '10.0.0.5' }];
const lookupMetadata = async () => [{ address: '169.254.169.254' }];
const lookupMixed = async () => [
  { address: '93.184.216.34' },
  { address: '127.0.0.1' },
];

test('IPv4 private ranges', () => {
  for (const ip of [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.5',
    '100.64.0.1',
    '100.127.255.255',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(ipv4IsPrivate(ip), true, `${ip} must be blocked`);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '198.51.101.1', '1.1.1.1']) {
    assert.equal(ipv4IsPrivate(ip), false, `${ip} must be allowed`);
  }
});

test('IPv6 private ranges', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:192.168.0.1', '::ffff:10.0.0.1']) {
    assert.equal(ipv6IsPrivate(ip), true, `${ip} must be blocked`);
  }
  for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(ipv6IsPrivate(ip), false, `${ip} must be allowed`);
  }
  assert.equal(addressIsPrivate('1.1.1.1'), false);
  assert.equal(addressIsPrivate('fe80::1'), true);
});

test('hostname literal guard', () => {
  assert.ok(hostnameRejectReason('localhost'));
  assert.ok(hostnameRejectReason('metadata.google.internal'));
  assert.ok(hostnameRejectReason('127.0.0.1'));
  assert.ok(hostnameRejectReason('0.0.0.0'));
  assert.ok(hostnameRejectReason('[::1]'));
  assert.ok(hostnameRejectReason('169.254.169.254'));
  assert.ok(hostnameRejectReason('build.internal'));
  assert.ok(hostnameRejectReason('printer.local'));
  assert.equal(hostnameRejectReason('example.com'), null);
  assert.equal(hostnameRejectReason('93.184.216.34'), null);
});

test('assertUrlAllowed blocks bad schemes and hosts before DNS', async () => {
  await assert.rejects(assertUrlAllowed('file:///etc/passwd'), /http\/https/);
  await assert.rejects(assertUrlAllowed('ftp://example.com/f'), /http\/https/);
  await assert.rejects(assertUrlAllowed('not a url'), /invalid URL/);
  await assert.rejects(assertUrlAllowed('http://localhost:4000/meta'), /private/);
  await assert.rejects(assertUrlAllowed('http://127.0.0.1/admin'), /private/);
  await assert.rejects(assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), /private/);
  await assert.rejects(assertUrlAllowed('http://metadata.google.internal/computeMetadata/'), /private/);
  await assert.rejects(assertUrlAllowed('http://[fe80::1]/'), /private/);
  await assert.rejects(assertUrlAllowed('https://intranet.localhost/'), /private/);
});

test('assertUrlAllowed blocks private DNS resolutions', async () => {
  clearDnsCache();
  await assert.rejects(
    assertUrlAllowed('http://internal.example.com/', { lookup: lookupPrivate }),
    /private address 10\.0\.0\.5/
  );
  clearDnsCache();
  await assert.rejects(
    assertUrlAllowed('http://metadata-alias.example.com/', { lookup: lookupMetadata }),
    /169\.254\.169\.254/
  );
  clearDnsCache();
  await assert.rejects(
    assertUrlAllowed('http://rebind.example.com/', { lookup: lookupMixed }),
    /private address 127\.0\.0\.1/
  );
});

test('assertUrlAllowed allows public resolutions', async () => {
  clearDnsCache();
  const url = await assertUrlAllowed('https://example.com/some/page?x=1', { lookup: lookupPublic });
  assert.equal(url, 'https://example.com/some/page?x=1');
});

test('checkRequestUrl verdicts (interception hook)', async () => {
  clearDnsCache();
  assert.equal((await checkRequestUrl('https://cdn.example.com/app.js', { lookup: lookupPublic })).allow, true);
  clearDnsCache();
  const blocked = await checkRequestUrl('http://192.168.0.10/router', { lookup: lookupPublic });
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /private/);
});
