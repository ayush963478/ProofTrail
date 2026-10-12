// EventBridge scheduled handler (rate(15 minutes)) -> anchor.js

import { anchorNow } from '../services/anchor.js';
import { loadConfig } from '../config.js';

export async function handler() {
  const cfg = loadConfig();
  const result = await anchorNow(cfg);
  console.log('[anchorScheduler]', JSON.stringify(result));
  return { ok: true, ...result };
}
