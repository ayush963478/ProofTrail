// Repository layer with two implementations behind one interface:
//   aws    — DynamoDB (tables per docs/DATA-MODEL.md)
//   local  — JSON files under $DATA_DIR/tables (dev/tests)
//
// Method names follow what services/{ledger,anchor,audit,share,cases,evidence,
// seal,...}.js call on `db`. Aliases (putX/createX/saveX) exist so handlers can
// use either verb.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';

// ---------------------------------------------------------------- local impl

class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.stamp = null;
  }
  // Local mode may be shared by more than one process (server + `npm run
  // anchor`); stat the file and re-read when it changed externally.
  load() {
    let st = null;
    try {
      st = fs.statSync(this.file);
    } catch {
      st = null;
    }
    const current = st ? `${st.mtimeMs}:${st.size}` : 'absent';
    if (this.data === null || current !== this.stamp) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (st) {
        try {
          this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch {
          this.data = {};
        }
      } else {
        this.data = {};
      }
      this.stamp = current;
    }
    return this.data;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    try {
      const st = fs.statSync(this.file);
      this.stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.stamp = null;
    }
  }
}

function byDescTime(a, b) {
  const ka = a.createdAt || a.generatedAt || a.time || '';
  const kb = b.createdAt || b.generatedAt || b.time || '';
  return kb.localeCompare(ka);
}

function createLocalDb(cfg) {
  const dir = cfg.tablesDir || path.join(cfg.dataDir, 'tables');
  const t = (name) => new JsonStore(path.join(dir, `${name}.json`));
  const stores = {
    users: t('users'),
    cases: t('cases'),
    evidence: t('evidence'),
    shares: t('shares'),
    packages: t('packages'),
    audit: t('audit'),
    captures: t('captures'),
    ledger: t('ledger'),
    anchors: t('anchors'),
  };

  const merge = (store, id, patch) => {
    const d = store.load();
    if (!d[id]) return null;
    d[id] = { ...d[id], ...patch };
    store.save();
    return d[id];
  };

  return {
    kind: 'local',

    // ---- users ----
    async getUser(uid) {
      return stores.users.load()[uid] || null;
    },
    async putUser(user) {
      const d = stores.users.load();
      d[user.id] = user;
      stores.users.save();
      return user;
    },

    // ---- cases ----
    async createCase(c) {
      const d = stores.cases.load();
      d[c.id] = c;
      stores.cases.save();
      return c;
    },
    async getCase(id) {
      return stores.cases.load()[id] || null;
    },
    async listCases(uid) {
      return Object.values(stores.cases.load())
        .filter((c) => c.ownerId === uid)
        .sort(byDescTime);
    },
    async updateCase(id, patch) {
      return merge(stores.cases, id, patch);
    },
    async deleteCase(id) {
      const d = stores.cases.load();
      if (!d[id]) return false;
      delete d[id];
      stores.cases.save();
      return true;
    },

    // ---- evidence ----
    async putEvidence(e) {
      const d = stores.evidence.load();
      d[e.id] = e;
      stores.evidence.save();
      return e;
    },
    async getEvidence(id) {
      return stores.evidence.load()[id] || null;
    },
    async updateEvidence(id, patch) {
      return merge(stores.evidence, id, patch);
    },
    async listEvidence(uid, caseId) {
      return Object.values(stores.evidence.load())
        .filter((e) => e.ownerId === uid && !e.deletedAt && (caseId ? e.caseId === caseId : true))
        .sort(byDescTime);
    },
    async findEvidenceBySha256(hash) {
      return (
        Object.values(stores.evidence.load()).find(
          (e) => !e.deletedAt && (e.sha256 === hash || e.clientSha256 === hash)
        ) || null
      );
    },

    // ---- shares ----
    async putShare(s) {
      const d = stores.shares.load();
      d[s.id] = s;
      stores.shares.save();
      return s;
    },
    async getShareById(id) {
      return stores.shares.load()[id] || null;
    },
    async getShareByToken(token) {
      return Object.values(stores.shares.load()).find((s) => s.token === token) || null;
    },
    async updateShare(id, patch) {
      return merge(stores.shares, id, patch);
    },
    async listSharesByTarget(targetId) {
      return Object.values(stores.shares.load())
        .filter((s) => s.targetId === targetId)
        .sort(byDescTime);
    },
    async deleteShare(id) {
      const d = stores.shares.load();
      if (!d[id]) return false;
      delete d[id];
      stores.shares.save();
      return true;
    },

    // ---- packages ----
    async putPackage(p) {
      const d = stores.packages.load();
      d[p.id] = p;
      stores.packages.save();
      return p;
    },
    async getPackage(id) {
      return stores.packages.load()[id] || null;
    },
    async listPackages(uid, caseId) {
      return Object.values(stores.packages.load())
        .filter((p) => p.ownerId === uid && (caseId ? p.caseId === caseId : true))
        .sort(byDescTime);
    },

    // ---- audit ----
    async appendAudit(entry) {
      const d = stores.audit.load();
      const key = entry.evidenceId;
      d[key] = d[key] || [];
      d[key].push(entry);
      stores.audit.save();
      return entry;
    },
    async listAudit(evidenceId) {
      return (stores.audit.load()[evidenceId] || []).sort((a, b) => a.time.localeCompare(b.time));
    },

    // ---- captures ----
    async putCapture(job) {
      const d = stores.captures.load();
      d[job.id] = job;
      stores.captures.save();
      return job;
    },
    async getCapture(id) {
      return stores.captures.load()[id] || null;
    },
    async updateCapture(id, patch) {
      return merge(stores.captures, id, patch);
    },
    async listCapture(uid, caseId) {
      return (await this.listCaptures(uid)).filter((j) => (caseId ? j.caseId === caseId : true));
    },
    async listCaptures(uid) {
      return Object.values(stores.captures.load())
        .filter((j) => j.ownerId === uid)
        .sort(byDescTime);
    },

    // ---- ledger (append-only) ----
    async ledgerLatest() {
      const all = Object.values(stores.ledger.load());
      if (all.length === 0) return null;
      return all.sort((a, b) => b.seq.localeCompare(a.seq))[0];
    },
    async ledgerGet(seq) {
      return stores.ledger.load()[seq] || null;
    },
    async ledgerAppend(entry) {
      const d = stores.ledger.load();
      if (d[entry.seq]) throw new AppError('conflict', `Ledger seq ${entry.seq} already exists`);
      d[entry.seq] = entry;
      stores.ledger.save();
      return entry;
    },
    async ledgerAll() {
      return Object.values(stores.ledger.load()).sort((a, b) => a.seq.localeCompare(b.seq));
    },
    async ledgerRange(fromSeq, toSeq) {
      return (await this.ledgerAll()).filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
    },

    // ---- anchors ----
    async putAnchorBatch(batch) {
      const d = stores.anchors.load();
      d[batch.root] = batch;
      stores.anchors.save();
      return batch;
    },
    async getAnchorByRoot(root) {
      return stores.anchors.load()[root] || null;
    },
    async listAnchorBatches() {
      return Object.values(stores.anchors.load()).sort((a, b) => a.fromSeq.localeCompare(b.fromSeq));
    },
    async latestAnchorBatch() {
      const all = await this.listAnchorBatches();
      return all.length ? all[all.length - 1] : null;
    },
  };
}

// ------------------------------------------------------------------ aws impl

function createAwsDb(cfg) {
  const region = cfg.cognito?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  let doc = null;
  async function client() {
    if (!doc) {
      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
      doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    return doc;
  }
  async function send(Ctor, input) {
    const c = await client();
    return c.send(new Ctor(input));
  }
  const D = async () => import('@aws-sdk/lib-dynamodb');

  const MAIN = cfg.mainTable;
  const T = {
    ledger: cfg.ledgerTable,
    anchor: cfg.anchorTable,
    audit: cfg.auditTable,
    capture: cfg.captureTable,
  };

  return {
    kind: 'aws',

    async getUser(uid) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: MAIN, Key: { PK: `USR#${uid}`, SK: 'PROFILE' } });
      return r.Item ? r.Item.data : null;
    },
    async putUser(user) {
      const { PutCommand } = await D();
      await send(PutCommand, { TableName: MAIN, Item: { PK: `USR#${user.id}`, SK: 'PROFILE', data: user } });
      return user;
    },

    async createCase(c) {
      const { PutCommand } = await D();
      await send(PutCommand, {
        TableName: MAIN,
        Item: {
          PK: `CASE#${c.id}`,
          SK: 'META',
          GSI1PK: `USR#${c.ownerId}`,
          GSI1SK: `CASE#${c.createdAt}#${c.id}`,
          data: c,
        },
      });
      return c;
    },
    async getCase(id) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: MAIN, Key: { PK: `CASE#${id}`, SK: 'META' } });
      return r.Item ? r.Item.data : null;
    },
    async listCases(uid) {
      const { QueryCommand } = await D();
      const r = await send(QueryCommand, {
        TableName: MAIN,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :pre)',
        ExpressionAttributeValues: { ':p': `USR#${uid}`, ':pre': 'CASE#' },
      });
      return (r.Items || []).map((i) => i.data).sort(byDescTime);
    },
    async updateCase(id, patch) {
      const existing = await this.getCase(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      await this.createCase(merged);
      return merged;
    },
    async deleteCase(id) {
      const { DeleteCommand } = await D();
      try {
        await send(DeleteCommand, { TableName: MAIN, Key: { PK: `CASE#${id}`, SK: 'META' } });
        return true;
      } catch {
        return false;
      }
    },

    async putEvidence(e) {
      const { PutCommand } = await D();
      await send(PutCommand, {
        TableName: MAIN,
        Item: {
          PK: `EVID#${e.id}`,
          SK: 'META',
          GSI1PK: `USR#${e.ownerId}`,
          GSI1SK: `EVID#${e.createdAt}#${e.id}`,
          data: e,
        },
      });
      return e;
    },
    async getEvidence(id) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: MAIN, Key: { PK: `EVID#${id}`, SK: 'META' } });
      return r.Item ? r.Item.data : null;
    },
    async updateEvidence(id, patch) {
      const existing = await this.getEvidence(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      await this.putEvidence(merged);
      return merged;
    },
    async listEvidence(uid, caseId) {
      const { QueryCommand } = await D();
      const r = await send(QueryCommand, {
        TableName: MAIN,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :pre)',
        ExpressionAttributeValues: { ':p': `USR#${uid}`, ':pre': 'EVID#' },
      });
      return (r.Items || [])
        .map((i) => i.data)
        .filter((e) => !e.deletedAt && (caseId ? e.caseId === caseId : true))
        .sort(byDescTime);
    },
    async findEvidenceBySha256(hash) {
      const { ScanCommand } = await D();
      const r = await send(ScanCommand, {
        TableName: MAIN,
        FilterExpression: 'begins_with(PK, :p) AND (data.sha256 = :h OR data.clientSha256 = :h)',
        ExpressionAttributeValues: { ':p': 'EVID#', ':h': hash },
        Limit: 100,
      });
      const item = (r.Items || []).find((i) => !i.data?.deletedAt);
      return item ? item.data : null;
    },

    async putShare(s) {
      const { PutCommand } = await D();
      const base = { ...s };
      await send(PutCommand, { TableName: MAIN, Item: { PK: `SHARE#${s.token}`, SK: 'META', data: base } });
      const parentPk = s.scope === 'package' ? `PKG#${s.targetId}` : `EVID#${s.targetId}`;
      await send(PutCommand, { TableName: MAIN, Item: { PK: parentPk, SK: `SHARE#${s.id}`, data: base } });
      return s;
    },
    async getShareById(id) {
      const { ScanCommand } = await D();
      const r = await send(ScanCommand, {
        TableName: MAIN,
        FilterExpression: 'begins_with(PK, :p) AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': 'SHARE#', ':s': 'SHARE#' },
        Limit: 1000,
      });
      return (r.Items || []).map((i) => i.data).find((s) => s.id === id) || null;
    },
    async getShareByToken(token) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: MAIN, Key: { PK: `SHARE#${token}`, SK: 'META' } });
      return r.Item ? r.Item.data : null;
    },
    async updateShare(id, patch) {
      const existing = await this.getShareById(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      await this.putShare(merged);
      return merged;
    },
    async listSharesByTarget(targetId) {
      const { QueryCommand } = await D();
      const r = await send(QueryCommand, {
        TableName: MAIN,
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': `EVID#${targetId}`, ':s': 'SHARE#' },
      });
      return (r.Items || []).map((i) => i.data).sort(byDescTime);
    },
    async deleteShare(id) {
      const existing = await this.getShareById(id);
      if (!existing) return false;
      const { DeleteCommand } = await D();
      await send(DeleteCommand, { TableName: MAIN, Key: { PK: `SHARE#${existing.token}`, SK: 'META' } });
      const parentPk = existing.scope === 'package' ? `PKG#${existing.targetId}` : `EVID#${existing.targetId}`;
      await send(DeleteCommand, { TableName: MAIN, Key: { PK: parentPk, SK: `SHARE#${id}` } });
      return true;
    },

    async putPackage(p) {
      const { PutCommand } = await D();
      await send(PutCommand, {
        TableName: MAIN,
        Item: {
          PK: `PKG#${p.id}`,
          SK: 'META',
          GSI1PK: `USR#${p.ownerId}`,
          GSI1SK: `PKG#${p.generatedAt}#${p.id}`,
          data: p,
        },
      });
      return p;
    },
    async getPackage(id) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: MAIN, Key: { PK: `PKG#${id}`, SK: 'META' } });
      return r.Item ? r.Item.data : null;
    },
    async listPackages(uid, caseId) {
      const { QueryCommand } = await D();
      const r = await send(QueryCommand, {
        TableName: MAIN,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :pre)',
        ExpressionAttributeValues: { ':p': `USR#${uid}`, ':pre': 'PKG#' },
      });
      return (r.Items || [])
        .map((i) => i.data)
        .filter((p) => (caseId ? p.caseId === caseId : true))
        .sort(byDescTime);
    },

    async appendAudit(entry) {
      const { PutCommand } = await D();
      await send(PutCommand, {
        TableName: T.audit,
        Item: {
          PK: `EVID#${entry.evidenceId}`,
          SK: entry.id, // `<timeISO>#<action>#<rand>` per DATA-MODEL
          ...entry,
          ttl: Math.floor(Date.parse(entry.expiresAt) / 1000), // DynamoDB TTL
        },
      });
      return entry;
    },
    async listAudit(evidenceId) {
      const { QueryCommand } = await D();
      const r = await send(QueryCommand, {
        TableName: T.audit,
        KeyConditionExpression: 'PK = :p',
        ExpressionAttributeValues: { ':p': `EVID#${evidenceId}` },
      });
      return (r.Items || []).sort((a, b) => a.time.localeCompare(b.time));
    },

    async putCapture(job) {
      const { PutCommand } = await D();
      await send(PutCommand, { TableName: T.capture, Item: { PK: `CAP#${job.id}`, data: job } });
      return job;
    },
    async getCapture(id) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: T.capture, Key: { PK: `CAP#${id}` } });
      return r.Item ? r.Item.data : null;
    },
    async updateCapture(id, patch) {
      const existing = await this.getCapture(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      await this.putCapture(merged);
      return merged;
    },
    async listCapture(uid, caseId) {
      return (await this.listCaptures(uid)).filter((j) => (caseId ? j.caseId === caseId : true));
    },
    async listCaptures(uid) {
      const { ScanCommand } = await D();
      const r = await send(ScanCommand, { TableName: T.capture, Limit: 500 });
      return (r.Items || [])
        .map((i) => i.data)
        .filter((j) => j.ownerId === uid)
        .sort(byDescTime);
    },

    async ledgerLatest() {
      const { QueryCommand } = await D();
      const r = await send(QueryCommand, { TableName: T.ledger, ScanIndexForward: false, Limit: 1 });
      return r.Items && r.Items[0] ? r.Items[0].data : null;
    },
    async ledgerGet(seq) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: T.ledger, Key: { PK: seq } });
      return r.Item ? r.Item.data : null;
    },
    async ledgerAppend(entry) {
      const { PutCommand } = await D();
      try {
        await send(PutCommand, {
          TableName: T.ledger,
          Item: { PK: entry.seq, data: entry },
          ConditionExpression: 'attribute_not_exists(PK)',
        });
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
          throw new AppError('conflict', `Ledger seq ${entry.seq} already exists`);
        }
        throw err;
      }
      return entry;
    },
    async ledgerAll() {
      const { QueryCommand } = await D();
      const items = [];
      let ExclusiveStartKey;
      do {
        const r = await send(QueryCommand, {
          TableName: T.ledger,
          Limit: 1000,
          ExclusiveStartKey,
        });
        items.push(...(r.Items || []).map((i) => i.data));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items.sort((a, b) => a.seq.localeCompare(b.seq));
    },
    async ledgerRange(fromSeq, toSeq) {
      const { QueryCommand } = await D();
      const r = await send(QueryCommand, {
        TableName: T.ledger,
        KeyConditionExpression: 'PK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':a': fromSeq, ':b': toSeq },
      });
      return (r.Items || []).map((i) => i.data).sort((a, b) => a.seq.localeCompare(b.seq));
    },

    async putAnchorBatch(batch) {
      const { PutCommand } = await D();
      await send(PutCommand, { TableName: T.anchor, Item: { PK: `ROOT#${batch.root}`, data: batch } });
      await send(PutCommand, {
        TableName: T.anchor,
        Item: { PK: `BATCH#${batch.batchId}`, data: { root: batch.root } },
      });
      return batch;
    },
    async getAnchorByRoot(root) {
      const { GetCommand } = await D();
      const r = await send(GetCommand, { TableName: T.anchor, Key: { PK: `ROOT#${root}` } });
      return r.Item ? r.Item.data : null;
    },
    async listAnchorBatches() {
      const { ScanCommand } = await D();
      const r = await send(ScanCommand, {
        TableName: T.anchor,
        FilterExpression: 'begins_with(PK, :p)',
        ExpressionAttributeValues: { ':p': 'ROOT#' },
      });
      return (r.Items || []).map((i) => i.data).sort((a, b) => a.fromSeq.localeCompare(b.fromSeq));
    },
    async latestAnchorBatch() {
      const all = await this.listAnchorBatches();
      return all.length ? all[all.length - 1] : null;
    },
  };
}

// --------------------------------------------------------------- factory

let singleton = null;

export function getDb(cfg = loadConfig()) {
  const wantAws = cfg.mode === 'aws';
  if (!singleton || (singleton.kind === 'aws') !== wantAws) {
    singleton = wantAws ? createAwsDb(cfg) : createLocalDb(cfg);
  }
  return singleton;
}

export function resetDb() {
  singleton = null;
}
