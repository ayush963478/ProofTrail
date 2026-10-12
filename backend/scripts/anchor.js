#!/usr/bin/env node
// One-shot Merkle anchor batch (docs/DATA-MODEL.md ANCHOR table).
//
// Local mode:  npm run anchor          — publish pending ledger entries
// AWS:         EventBridge rate(15m) -> src/handlers/anchorScheduler.js
//              (this script is the local equivalent of that schedule)
//
// Exit codes: 0 = batch published or nothing to do, 1 = failure.

import { loadConfig } from '../src/config.js';
import { anchorNow } from '../src/services/anchor.js';

async function main() {
  const cfg = loadConfig();
  const result = await anchorNow(cfg);
  if (result.skipped) {
    console.log(`[anchor] skipped: ${result.reason}`);
    return 0;
  }
  console.log(`[anchor] published batch ${result.batchId}`);
  console.log(`  root      ${result.root}`);
  console.log(`  seqs      ${result.fromSeq}..${result.toSeq} (${result.leafCount} leaves)`);
  console.log(`  published ${result.publishedAt}`);
  if (result.externalRef) console.log(`  external  ${result.externalRef}`);
  if (result.logPath) console.log(`  log       ${result.logPath}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[anchor] failed: ${e.message}`);
    process.exit(1);
  });
