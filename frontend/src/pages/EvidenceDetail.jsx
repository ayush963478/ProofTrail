import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Anchor,
  ArrowLeft,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Eye,
  FileSearch,
  Hash,
  KeyRound,
  Link2,
  MapPin,
  RefreshCw,
  ScrollText,
  Server,
  Share2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { ApiError, evidenceApi, pollUntil, sharesApi } from '../api/client.js';
import { useToast } from '../components/Toast.jsx';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  PageSpinner,
  Select,
} from '../components/ui.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import StatusChip from '../components/StatusChip.jsx';
import CopyButton from '../components/CopyButton.jsx';
import BrowserVerificationPanel from '../components/BrowserVerificationPanel.jsx';
import { TypeIcon } from '../components/EvidenceList.jsx';
import { clampPercent, formatBytes, formatDate, truncate } from '../lib/format.js';
import { verificationUrl } from '../lib/env.js';

const TERMINAL = ['sealed', 'failed'];

const FORENSIC_LABELS = {
  metadata_consistency: 'Metadata consistency',
  format_vs_extension: 'Format vs extension',
  edit_software_markers: 'Edit software markers',
  compression_anomaly: 'Compression anomaly',
  synthetic_media_markers: 'Synthetic media markers',
  provenance_completeness: 'Provenance completeness',
};

const FORENSIC_TONES = {
  clean: { bar: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  flag: { bar: 'bg-rose-500', text: 'text-rose-700', chip: 'bg-rose-50 text-rose-700 border-rose-200' },
  unknown: { bar: 'bg-slate-400', text: 'text-slate-600', chip: 'bg-slate-100 text-slate-600 border-slate-200' },
};

function Row({ label, children, mono = false }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
      <dt className="w-36 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className={`min-w-0 flex-1 break-all text-sm text-slate-700 ${mono ? 'font-mono' : ''}`}>
        {children}
      </dd>
    </div>
  );
}

function Section({ icon: Icon, title, subtitle, action, children }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {Icon && <Icon size={15} className="text-indigo-500" />}
            {title}
          </span>
        }
        subtitle={subtitle}
        action={action}
      />
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

export default function EvidenceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [evidence, setEvidence] = useState(null);
  const [error, setError] = useState(null);
  const [runSignal, setRunSignal] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Forensics
  const [forensicsBusy, setForensicsBusy] = useState(false);

  // Shares
  const [shares, setShares] = useState(null);
  const [shareIncludeDownload, setShareIncludeDownload] = useState(true);
  const [shareExpires, setShareExpires] = useState('72');
  const [shareBusy, setShareBusy] = useState(false);

  // Audit
  const [audit, setAudit] = useState(null);

  const pollRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const ev = await evidenceApi.get(id);
      setEvidence(ev);
      return ev;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'Evidence not found.' : e.message);
      return null;
    }
  }, [id]);

  const loadShares = useCallback(async () => {
    try {
      setShares(await evidenceApi.listShares(id));
    } catch {
      setShares([]);
    }
  }, [id]);

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await evidenceApi.audit(id));
    } catch {
      setAudit([]);
    }
  }, [id]);

  useEffect(() => {
    load();
    loadShares();
    loadAudit();
  }, [load, loadShares, loadAudit]);

  // Poll while the seal pipeline is still running (cleanup on unmount/status change).
  useEffect(() => {
    if (!evidence || TERMINAL.includes(evidence.status)) return undefined;
    const controller = new AbortController();
    pollRef.current = controller;
    (async () => {
      try {
        const final = await pollUntil(() => evidenceApi.get(id), {
          interval: 1500,
          maxInterval: 3000,
          timeout: 240000,
          signal: controller.signal,
          isDone: (ev) => TERMINAL.includes(ev.status),
          onTick: (ev) => setEvidence(ev),
        });
        setEvidence(final);
        if (final.status === 'sealed') toast.success('Evidence sealed');
      } catch (e) {
        if (e?.name !== 'AbortError') {
          /* transient polling failure — manual refresh still available */
        }
      }
    })();
    return () => {
      controller.abort();
      pollRef.current = null;
    };
  }, [evidence?.status, id, toast]);

  async function download() {
    setDownloading(true);
    try {
      await evidenceApi.download(id, { filename: evidence.filename });
      toast.success('Download started (audit-logged)');
    } catch (e) {
      toast.error(e.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await evidenceApi.remove(id);
      toast.success('Evidence tombstoned');
      navigate(evidence.caseId ? `/cases/${evidence.caseId}` : '/cases', { replace: true });
    } catch (e) {
      if (e.code === 'conflict' || e.status === 409) {
        toast.error(`Retention lock — ${e.message}`, { duration: 6000 });
      } else {
        toast.error(e.message || 'Delete failed');
      }
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  async function runForensics() {
    setForensicsBusy(true);
    try {
      const report = await evidenceApi.forensics(id);
      setEvidence((ev) => ({ ...ev, forensicReport: report }));
      toast.success('Forensic indicators computed');
    } catch (e) {
      toast.error(e.message || 'Forensic check failed');
    } finally {
      setForensicsBusy(false);
    }
  }

  async function createShare() {
    setShareBusy(true);
    try {
      const share = await evidenceApi.createShare(id, {
        includeDownload: shareIncludeDownload,
        expiresInHours: shareExpires ? Number(shareExpires) : undefined,
      });
      setShares((list) => [share, ...(list || [])]);
      toast.success('Verification link created');
    } catch (e) {
      toast.error(e.message || 'Share creation failed');
    } finally {
      setShareBusy(false);
    }
  }

  async function revokeShare(shareId) {
    try {
      await sharesApi.revoke(shareId);
      setShares((list) => (list || []).map((s) => (s.id === shareId ? { ...s, revokedAt: new Date().toISOString() } : s)));
      toast.success('Share revoked');
    } catch (e) {
      toast.error(e.message || 'Revoke failed');
    }
  }

  if (!evidence && !error) return <PageSpinner label="Loading evidence…" />;
  if (!evidence && error) return <ErrorState message={error} onRetry={load} />;

  const ev = evidence;
  const proof = ev.proof;
  const report = ev.forensicReport;
  const cap = ev.capture || {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => navigate(ev.caseId ? `/cases/${ev.caseId}` : '/cases')}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-800"
        >
          <ArrowLeft size={15} /> Back
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              <TypeIcon type={ev.type} size={21} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-bold text-slate-900">{ev.filename}</h2>
                <StatusChip status={ev.status} />
                {ev.hashMatched === false && (
                  <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">
                    client hash mismatch
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-500">
                <span className="capitalize">{ev.type}</span> · {ev.mimeType} ·{' '}
                {formatBytes(ev.size)} · method <code className="font-mono">{ev.captureMethod}</code>
                {ev.caseId && (
                  <>
                    {' · '}
                    <Link to={`/cases/${ev.caseId}`} className="text-indigo-600 hover:underline">
                      view case
                    </Link>
                  </>
                )}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                {ev.id} · created {formatDate(ev.createdAt)}
                {proof?.sealedAt && ` · sealed ${formatDate(proof.sealedAt)}`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={download} loading={downloading}>
              <Download size={16} /> Download
            </Button>
            <Button
              variant="ghost"
              className="text-rose-600 hover:bg-rose-50"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} /> Delete
            </Button>
          </div>
        </div>

        {ev.sealError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <strong>Seal error:</strong> {ev.sealError}
          </div>
        )}
      </div>

      {/* Hash + capture metadata */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Section icon={Hash} title="SHA-256" subtitle="Server-recomputed over the received bytes">
          <code className="mono-hash block">{ev.sha256 || 'not computed yet'}</code>
          {ev.clientSha256 && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Client claim (before upload)
              </p>
              <div className="mt-1 flex items-center gap-2">
                <code className="mono-hash">{ev.clientSha256}</code>
                {ev.hashMatched !== undefined && (
                  <span
                    className={`text-xs font-semibold ${ev.hashMatched ? 'text-emerald-600' : 'text-rose-600'}`}
                  >
                    {ev.hashMatched ? '✓ matched' : '✗ mismatch'}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="mt-4 flex items-center gap-2">
            <CopyButton value={ev.sha256 || ''} label="Copy hash" />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setRunSignal((s) => s + 1);
                document.getElementById('independent-verification')?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                });
              }}
            >
              <Eye size={14} /> Verify in browser
            </Button>
          </div>
        </Section>

        <Section
          icon={Server}
          title="Capture metadata"
          subtitle="What was known at capture time"
        >
          <dl className="divide-y divide-slate-50">
            <Row label="Method">
              <code className="font-mono">{ev.captureMethod}</code>
            </Row>
            <Row label="Device">{cap.device || '—'}</Row>
            <Row label="URL">{cap.url || '—'}</Row>
            <Row label="GPS">
              {cap.gps ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={13} className="text-indigo-500" />
                  {cap.gps.lat}, {cap.gps.lng}
                </span>
              ) : (
                'not provided'
              )}
            </Row>
            <Row label="App version">{cap.appVersion || '—'}</Row>
            <Row label="Client time">{cap.clientTime ? formatDate(cap.clientTime) : '—'}</Row>
            <Row label="Server time">{cap.serverTime ? formatDate(cap.serverTime) : '—'}</Row>
            <Row label="User agent">{truncate(cap.userAgent || '—', 48, 0)}</Row>
          </dl>
        </Section>
      </div>

      {/* Proof record */}
      {proof ? (
        <Section
          icon={BadgeCheck}
          title="Proof record"
          subtitle="Canonical manifest · signature · timestamp · ledger · anchor"
        >
          <div className="space-y-5">
            {/* Manifest */}
            <div className="rounded-lg border border-slate-200">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <ScrollText size={15} className="text-indigo-500" />
                    Manifest (canonical JSON — signed bytes)
                    <span className="text-xs font-normal text-slate-400">
                      {proof.manifestHash ? 'v' + (proof.manifest?.version || '?') : ''}
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className="text-slate-400 transition group-open:rotate-180"
                  />
                </summary>
                <div className="border-t border-slate-100 px-4 py-3">
                  <pre className="max-h-72 overflow-auto rounded bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">
                    {JSON.stringify(proof.manifest, null, 2)}
                  </pre>
                </div>
              </details>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    manifestHash = sha256(canonicalJson)
                  </p>
                  <code className="mono-hash mt-1 inline-block">{proof.manifestHash}</code>
                </div>
                <CopyButton value={proof.manifestHash} label="Copy manifest hash" />
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              {/* Signature */}
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <KeyRound size={15} className="text-indigo-500" /> Digital signature
                </p>
                <dl className="mt-2 divide-y divide-slate-50">
                  <Row label="Key ID">{proof.signature?.keyId || '—'}</Row>
                  <Row label="Algorithm">
                    <code className="font-mono">{proof.signature?.algorithm || '—'}</code>
                  </Row>
                  <Row label="Value (DER)" mono>
                    {truncate(proof.signature?.value, 28, 12)}
                  </Row>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <CopyButton value={proof.signature?.value || ''} label="Copy signature" />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setRunSignal((s) => s + 1);
                      document.getElementById('independent-verification')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center',
                      });
                    }}
                  >
                    <ShieldCheck size={14} /> Verify in browser
                  </Button>
                </div>
              </div>

              {/* Timestamp */}
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Clock size={15} className="text-indigo-500" /> Trusted timestamp
                </p>
                <dl className="mt-2 divide-y divide-slate-50">
                  <Row label="Mode">
                    <code className="font-mono">{proof.timestamp?.mode || '—'}</code>
                    {proof.timestamp?.mode === 'local' && (
                      <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                        dev fallback clock
                      </span>
                    )}
                  </Row>
                  <Row label="TSA">{proof.timestamp?.tsa || 'local clock'}</Row>
                  <Row label="Gen time">{formatDate(proof.timestamp?.genTime)}</Row>
                </dl>
                <details className="group mt-2">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-indigo-600">
                    <ChevronRight size={13} className="transition group-open:rotate-90" />
                    Base64 DER token
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-100 p-2 break-all font-mono text-[11px] text-slate-600">
                    {proof.timestamp?.token || '—'}
                  </pre>
                  <div className="mt-2">
                    <CopyButton value={proof.timestamp?.token || ''} label="Copy token" />
                  </div>
                </details>
              </div>

              {/* Ledger */}
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Link2 size={15} className="text-indigo-500" /> Ledger entry
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
                    #{proof.ledger?.seq}
                  </span>
                </p>
                <dl className="mt-2 divide-y divide-slate-50">
                  <Row label="prevHash" mono>
                    {truncate(proof.ledger?.prevHash, 16, 10)}
                  </Row>
                  <Row label="entryHash" mono>
                    {truncate(proof.ledger?.entryHash, 16, 10)}
                  </Row>
                </dl>
                <div className="mt-2 flex flex-wrap gap-2">
                  <CopyButton value={proof.ledger?.prevHash || ''} label="Copy prevHash" size="xs" />
                  <CopyButton value={proof.ledger?.entryHash || ''} label="Copy entryHash" size="xs" />
                </div>
              </div>

              {/* Anchor */}
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Anchor size={15} className="text-indigo-500" /> Anchor
                </p>
                {proof.anchor ? (
                  <>
                    <dl className="mt-2 divide-y divide-slate-50">
                      <Row label="Batch">{proof.anchor.batchId}</Row>
                      <Row label="Seq range">
                        {proof.anchor.fromSeq} → {proof.anchor.toSeq}
                      </Row>
                      <Row label="Root" mono>
                        {truncate(proof.anchor.root, 16, 10)}
                      </Row>
                      <Row label="Published">{formatDate(proof.anchor.publishedAt)}</Row>
                      <Row label="External ref">{proof.anchor.externalRef || 'publish log only'}</Row>
                      <Row label="Merkle proof">
                        {proof.anchor.merkleProof?.length
                          ? `${proof.anchor.merkleProof.length} sibling hash(es)`
                          : 'none (single leaf)'}
                      </Row>
                    </dl>
                    <details className="group mt-2">
                      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-indigo-600">
                        <ChevronRight size={13} className="transition group-open:rotate-90" />
                        Merkle siblings
                      </summary>
                      <pre className="mt-2 max-h-32 overflow-auto rounded bg-slate-100 p-2 break-all font-mono text-[11px] text-slate-600">
                        {(proof.anchor.merkleProof || []).join('\n') || '—'}
                      </pre>
                    </details>
                  </>
                ) : (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                    <Clock size={15} className="mt-0.5 shrink-0 text-amber-600" />
                    <p className="text-xs leading-relaxed text-amber-800">
                      <strong>Pending anchor.</strong> The entry is in the hash-chained ledger;
                      Merkle roots publish periodically (≈15 min batches), after which this proof
                      gains an anchor.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Section>
      ) : (
        <Section
          icon={Clock}
          title="Proof record"
          subtitle={ev.status === 'failed' ? 'Sealing failed — no proof issued' : 'Not sealed yet'}
        >
          <EmptyState
            icon={ShieldCheck}
            title={
              ev.status === 'failed'
                ? 'No proof — sealing failed'
                : ev.status === 'pending_upload'
                  ? 'Upload pending'
                  : 'Sealing in progress'
            }
            subtitle={
              ev.status === 'failed'
                ? ev.sealError || 'Inspect the error above and re-upload the file.'
                : 'Hash → timestamp → sign → ledger → anchor. Watch this page — it updates automatically.'
            }
          />
        </Section>
      )}

      {/* Independent browser verification */}
      <BrowserVerificationPanel
        evidence={ev}
        proof={proof}
        runSignal={runSignal}
        fileHint={`"${ev.filename}"`}
      />

      {/* Forensics */}
      <Section
        icon={FileSearch}
        title="AI forensic check"
        subtitle="Heuristic indicators — signals, not proof"
        action={
          <Button size="sm" variant="secondary" onClick={runForensics} loading={forensicsBusy}>
            <RefreshCw size={14} /> {report ? 'Re-run' : 'Run forensic check'}
          </Button>
        }
      >
        {!report ? (
          <EmptyState
            icon={FileSearch}
            title="No forensic report yet"
            subtitle="Run heuristic checks for metadata consistency, format vs extension, edit-software markers, compression anomalies, synthetic-media markers and provenance completeness."
            action={
              <Button onClick={runForensics} loading={forensicsBusy}>
                Run forensic check
              </Button>
            }
          />
        ) : (
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                Model <code className="font-mono">{report.modelVersion}</code> · generated{' '}
                {formatDate(report.generatedAt)}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                {report.indicators?.length || 0} indicators
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {(report.indicators || []).map((ind) => {
                const tone = FORENSIC_TONES[ind.status] || FORENSIC_TONES.unknown;
                const pct = clampPercent(ind.confidence);
                return (
                  <div
                    key={ind.name}
                    className="rounded-lg border border-slate-200 bg-white p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-800">
                        {FORENSIC_LABELS[ind.name] || ind.name}
                      </p>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${tone.chip}`}
                      >
                        {ind.status}
                      </span>
                    </div>
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>confidence</span>
                        <span className="font-semibold text-slate-700">{pct}%</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${tone.bar}`}
                          style={{ width: `${Math.max(3, pct)}%` }}
                        />
                      </div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-slate-600">{ind.detail}</p>
                  </div>
                );
              })}
            </div>

            <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
              <span>
                <strong>Disclaimer:</strong> indicators with confidence, never certainty. These are
                heuristic signals to guide review — not proof of authenticity or forgery, and not a
                substitute for expert examination.
              </span>
            </p>
          </div>
        )}
      </Section>

      {/* Shares */}
      <Section
        icon={Share2}
        title="Verification shares"
        subtitle="Public links to the verification portal — revocable and expiring"
      >
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={shareIncludeDownload}
                onChange={(e) => setShareIncludeDownload(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              Allow original download
            </label>
            <Field label="Expires in" htmlFor="share-expires" className="w-44">
              <Select
                id="share-expires"
                value={shareExpires}
                onChange={(e) => setShareExpires(e.target.value)}
              >
                <option value="">Never</option>
                <option value="1">1 hour</option>
                <option value="24">24 hours</option>
                <option value="72">3 days</option>
                <option value="168">7 days</option>
                <option value="720">30 days</option>
              </Select>
            </Field>
            <Button size="sm" onClick={createShare} loading={shareBusy}>
              <Share2 size={14} /> Create link
            </Button>
          </div>
        </div>

        {shares === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
            <RefreshCw size={14} className="animate-spin" /> Loading shares…
          </div>
        ) : shares.length === 0 ? (
          <EmptyState
            icon={Share2}
            title="No shares yet"
            subtitle="Create a link anyone can open — no account needed — to verify this evidence."
            className="mt-4"
          />
        ) : (
          <div className="mt-4 space-y-3">
            {shares.map((s) => {
              const url = verificationUrl(s.token);
              const revoked = Boolean(s.revokedAt);
              const expired = s.expiresAt && new Date(s.expiresAt) < new Date();
              return (
                <div
                  key={s.id}
                  className={`rounded-lg border px-4 py-3 ${
                    revoked
                      ? 'border-slate-200 bg-slate-50 opacity-70'
                      : expired
                        ? 'border-amber-200 bg-amber-50'
                        : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="max-w-full truncate font-mono text-xs text-slate-600">
                          {url}
                        </code>
                        {revoked && (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                            revoked
                          </span>
                        )}
                        {!revoked && expired && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                            expired
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        created {formatDate(s.createdAt)} ·{' '}
                        {s.expiresAt ? `expires ${formatDate(s.expiresAt)}` : 'no expiry'} ·{' '}
                        {s.includeDownload ? 'download allowed' : 'verify only'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <CopyButton value={url} label="Copy link" />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => window.open(url, '_blank', 'noopener')}
                        disabled={revoked || expired}
                      >
                        <Eye size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-rose-600"
                        onClick={() => revokeShare(s.id)}
                        disabled={revoked}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Audit log */}
      <Section
        icon={Activity}
        title="Access audit log"
        subtitle="Every view, download, share and verify — actor + ip-hash only, no raw IPs"
        action={
          <Button size="sm" variant="ghost" onClick={loadAudit} title="Refresh audit log">
            <RefreshCw size={14} />
          </Button>
        }
      >
        {audit === null ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <RefreshCw size={14} className="animate-spin" /> Loading audit…
          </div>
        ) : audit.length === 0 ? (
          <EmptyState icon={Activity} title="No audit entries yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-2 pr-3 font-semibold">Time</th>
                  <th className="pb-2 pr-3 font-semibold">Actor</th>
                  <th className="pb-2 pr-3 font-semibold">Action</th>
                  <th className="pb-2 font-semibold">IP hash</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-600">
                      {formatDate(a.time)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-500">
                      {truncate(a.actor, 10, 6)}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold capitalize text-slate-600">
                        {a.action}
                      </span>
                    </td>
                    <td className="py-2 font-mono text-xs text-slate-400">
                      {truncate(a.ipHash, 10, 6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete evidence?"
        message={`"${ev.filename}" will be tombstoned and removed from listings. If a retention lock is active the server will refuse (409). Sealed originals remain in the write-once vault per policy.`}
        confirmLabel="Delete evidence"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      />
    </div>
  );
}
