import { sha256Bytes } from './hash.js';

function toBuf(hex) {
  return Buffer.from(hex, 'hex');
}

export function hashPair(leftHex, rightHex) {
  return sha256Bytes(Buffer.concat([toBuf(leftHex), toBuf(rightHex)])).toString('hex');
}

/**
 * Build all tree levels for a leaf list (hex strings).
 * Odd nodes at any level are duplicated, so a leaf always has a sibling.
 */
function buildLevels(leaves) {
  let cur = [...leaves];
  const levels = [cur];
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i];
      const r = i + 1 < cur.length ? cur[i + 1] : l;
      next.push(hashPair(l, r));
    }
    cur = next;
    levels.push(cur);
  }
  return levels;
}

export function merkleRoot(leaves) {
  if (!leaves || leaves.length === 0) return null;
  const levels = buildLevels(leaves);
  return levels[levels.length - 1][0];
}

/** Sibling hashes from the leaf up to (excluding) the root. */
export function merkleProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error('leaf index out of range');
  const levels = buildLevels(leaves);
  const siblings = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sibIdx = idx ^ 1;
    siblings.push(sibIdx < level.length ? level[sibIdx] : level[idx]);
    idx = Math.floor(idx / 2);
  }
  return { siblings, index };
}

/**
 * Recompute the Merkle root from one leaf + its proof.
 * @returns {string} hex root (compare to the published root)
 */
export function verifyMerkleProof(leafHex, proof, index, count) {
  if (typeof leafHex !== 'string' || !Array.isArray(proof)) return null;
  if (index < 0 || index >= count) return null;
  let idx = index;
  let h = leafHex;
  for (const sib of proof) {
    h = idx % 2 === 0 ? hashPair(h, sib) : hashPair(sib, h);
    idx = Math.floor(idx / 2);
  }
  return h;
}
