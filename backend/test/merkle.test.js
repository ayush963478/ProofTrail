// Merkle tree (docs/DATA-MODEL.md anchor batches): root, proofs, inclusion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { hashPair, merkleRoot, merkleProof, verifyMerkleProof } from '../src/crypto/merkle.js';
import { sha256Hex } from '../src/crypto/hash.js';

const leaf = (n) => sha256Hex(Buffer.from(`leaf-${n}`));

test('hashPair is order dependent', () => {
  const a = leaf(1);
  const b = leaf(2);
  assert.equal(hashPair(a, b), sha256Hex(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])));
  assert.notEqual(hashPair(a, b), hashPair(b, a));
});

test('empty leaf list has no root; single leaf root is the leaf itself', () => {
  assert.equal(merkleRoot([]), null);
  assert.equal(merkleRoot(null), null);
  assert.equal(merkleRoot([leaf(7)]), leaf(7));
});

test('root of two leaves equals hashPair', () => {
  const leaves = [leaf(1), leaf(2)];
  assert.equal(merkleRoot(leaves), hashPair(leaves[0], leaves[1]));
});

test('odd leaf counts duplicate the last node (a leaf always has a sibling)', () => {
  const leaves = [leaf(1), leaf(2), leaf(3)];
  const root = merkleRoot(leaves);
  // level 1: h(1,2), h(3,3) -> level 2: h(h(1,2), h(3,3))
  const l1 = hashPair(leaves[0], leaves[1]);
  const l2 = hashPair(leaves[2], leaves[2]);
  assert.equal(root, hashPair(l1, l2));
});

test('every leaf proves inclusion for an 8-leaf tree', () => {
  const leaves = Array.from({ length: 8 }, (_, i) => leaf(i));
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const { siblings, index } = merkleProof(leaves, i);
    assert.equal(index, i);
    assert.equal(verifyMerkleProof(leaves[i], siblings, i, leaves.length), root, `leaf ${i}`);
  }
});

test('proofs verify for odd counts (5 leaves)', () => {
  const leaves = Array.from({ length: 5 }, (_, i) => leaf(i));
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const { siblings } = merkleProof(leaves, i);
    assert.equal(verifyMerkleProof(leaves[i], siblings, i, leaves.length), root, `leaf ${i}`);
  }
});

test('a tampered leaf or sibling does not reproduce the root', () => {
  const leaves = Array.from({ length: 4 }, (_, i) => leaf(i));
  const root = merkleRoot(leaves);
  const { siblings } = merkleProof(leaves, 2);
  assert.notEqual(verifyMerkleProof(leaf(99), siblings, 2, leaves.length), root);
  const bad = [...siblings];
  bad[0] = leaf(99);
  assert.notEqual(verifyMerkleProof(leaves[2], bad, 2, leaves.length), root);
});

test('wrong index or out-of-range leaf fails verification', () => {
  const leaves = Array.from({ length: 4 }, (_, i) => leaf(i));
  const root = merkleRoot(leaves);
  const { siblings } = merkleProof(leaves, 0);
  assert.notEqual(verifyMerkleProof(leaves[0], siblings, 1, leaves.length), root);
  assert.equal(verifyMerkleProof(leaves[0], siblings, -1, leaves.length), null);
  assert.equal(verifyMerkleProof(leaves[0], siblings, 4, leaves.length), null);
  assert.equal(verifyMerkleProof(leaves[0], 'not-an-array', 0, leaves.length), null);
});

test('merkleProof rejects an out-of-range index', () => {
  const leaves = [leaf(1), leaf(2)];
  assert.throws(() => merkleProof(leaves, 5), /out of range/);
  assert.throws(() => merkleProof(leaves, -1), /out of range/);
});
