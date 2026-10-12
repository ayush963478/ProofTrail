// Append-only hash-chained ledger (docs/DATA-MODEL.md LEDGER table).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/services/db.js';
import * as ledger from '../src/services/ledger.js';

const cfg = loadConfig();
const db = getDb(cfg);

const mh = (n) => 'ab'.repeat(31) + String(n).padStart(2, '0');

test('padSeq / seqNumber use the mandated 12-char zero padding', () => {
  assert.equal(ledger.padSeq(1), '000000000001');
  assert.equal(ledger.padSeq(42), '000000000042');
  assert.equal(ledger.padSeq(123456789012), '123456789012');
  assert.equal(ledger.seqNumber('000000000042'), 42);
  assert.equal(ledger.SEQ_LEN, 12);
});

test('entryHashOf is the documented sha256(prevHash|manifestHash|seq)', () => {
  const h = ledger.entryHashOf({
    prevHash: ledger.GENESIS_PREV_HASH,
    manifestHash: 'cd'.repeat(32),
    seq: '000000000001',
  });
  assert.equal(h.length, 64);
  // deterministic
  assert.equal(
    h,
    ledger.entryHashOf({ prevHash: ledger.GENESIS_PREV_HASH, manifestHash: 'cd'.repeat(32), seq: '000000000001' }),
  );
  // and changes with any input
  assert.notEqual(h, ledger.entryHashOf({ prevHash: ledger.GENESIS_PREV_HASH, manifestHash: 'ce'.repeat(32), seq: '000000000001' }));
});

test('append builds a genesis entry then chains forward', async () => {
  const e1 = await ledger.append({ evidenceId: 'ev_a', manifestHash: mh(1) }, cfg, db);
  assert.equal(e1.seq, '000000000001');
  assert.equal(e1.prevHash, ledger.GENESIS_PREV_HASH);
  assert.equal(e1.entryHash, ledger.entryHashOf(e1));

  const e2 = await ledger.append({ evidenceId: 'ev_b', manifestHash: mh(2) }, cfg, db);
  assert.equal(e2.seq, '000000000002');
  assert.equal(e2.prevHash, e1.entryHash);
  assert.equal(e2.entryHash, ledger.entryHashOf(e2));

  const e3 = await ledger.append({ evidenceId: 'ev_c', manifestHash: mh(3) }, cfg, db);
  assert.equal(e3.seq, '000000000003');
  assert.equal(e3.prevHash, e2.entryHash);

  const all = await ledger.all(cfg, db);
  assert.equal(all.length, 3);
  assert.equal(ledger.verifyChain(all).ok, true);
  const deep = await ledger.checkEntry(e3, { deep: true }, cfg, db);
  assert.equal(deep.passed, true);
  assert.match(deep.detail, /genesis/);
});

test('append rejects missing fields', async () => {
  await assert.rejects(() => ledger.append({ evidenceId: 'ev_x' }, cfg, db), (e) => e.code === 'validation_error');
  await assert.rejects(() => ledger.append({ manifestHash: mh(9) }, cfg, db), (e) => e.code === 'validation_error');
});

test('entryIntact + checkLink detect a tampered manifestHash', async () => {
  const entries = await ledger.all(cfg, db);
  const good = entries[2];
  assert.equal(ledger.entryIntact(good), true);

  const tampered = { ...good, manifestHash: 'ff'.repeat(32) };
  assert.equal(ledger.entryIntact(tampered), false);

  const { hashOk, linkOk } = ledger.checkLink(tampered, entries[1]);
  assert.equal(hashOk, false);
  assert.equal(linkOk, true, 'link still matches predecessor');
});

test('checkLink detects a broken previous link', async () => {
  const entries = await ledger.all(cfg, db);
  const orphan = { ...entries[2], prevHash: '00'.repeat(32) };
  const { linkOk } = ledger.checkLink(orphan, entries[1]);
  assert.equal(linkOk, false);
  // non-genesis entry without its predecessor cannot be linked
  const { linkOk: noPrev } = ledger.checkLink(entries[1], null);
  assert.equal(noPrev, false);
});

test('verifyChain reports the first bad seq', async () => {
  const entries = await ledger.all(cfg, db);
  const tampered = entries.map((e, i) => (i === 1 ? { ...e, manifestHash: 'ee'.repeat(32) } : e));
  const r = ledger.verifyChain(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.firstBadSeq, '000000000002');
  assert.equal(r.checked, 3);

  assert.deepEqual(ledger.verifyChain([]), { ok: true, checked: 0, firstBadSeq: null, deepChecked: false });
});

test('the append-only store rejects in-place edits of a ledger row', async () => {
  const entries = await ledger.all(cfg, db);
  const target = entries[0];
  // Simulate an operator editing the stored row: recompute nothing, just mutate.
  const raw = await db.ledgerGet(target.seq);
  await db.ledgerAppend({ ...raw, entryHash: '11'.repeat(32) }).catch(() => {});
  // local store refuses overwrite (conditional put) — verify it stayed intact
  const reread = await db.ledgerGet(target.seq);
  assert.equal(reread.entryHash, target.entryHash, 'append-only store rejects in-place edits');

  const r = await ledger.checkEntry(target, { deep: false }, cfg, db);
  assert.equal(r.passed, true);
  assert.equal(r.chainVerified, true);
});

test('checkEntry fails for an unknown seq', async () => {
  const r = await ledger.checkEntry(null, {}, cfg, db);
  assert.equal(r.passed, false);
  assert.equal(r.detail, 'no ledger entry');
});
