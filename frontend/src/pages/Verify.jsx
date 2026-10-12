import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Clock,
  Download,
  FileQuestion,
  Link2,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { ApiError, publicApi } from '../api/client.js';
import PublicLayout from '../components/PublicLayout.jsx';
import { Button, Card, CardHeader, EmptyState, Spinner } from '../components/ui.jsx';
import BrowserVerificationPanel from '../components/BrowserVerificationPanel.jsx';
import { TypeIcon } from '../components/EvidenceList.jsx';
import { formatBytes, formatDate, truncate } from '../lib/format.js';
import { tokenFromVerificationInput } from '../lib/env.js';

const CHECK_LABELS = {
  hash_present: 'File hash present',
  manifest_integrity: 'Manifest integrity',
  signature: 'Digital signature',
  timestamp: 'Trusted timestamp',
  ledger_chain: 'Ledger chain',
  anchor: 'Merkle anchor',
};

function CheckRow({ check }) {
  const label = CHECK_LABELS[check.name] || check.name;
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2.5 pr-3">
        <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
          {check.passed ? (
            <CheckCircle2 size={16} className="shrink-0 text-emerald-500" />
          ) : (
            <XCircle size={16} className="shrink-0 text-rose-500" />
          )}
          {label}
        </span>
      </td>
      <td className="py-2.5 text-xs leading-relaxed text-slate-500">{check.detail}</td>
      <td className="py-2.5 text-right">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            check.passed ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {check.passed ? 'PASS' : 'FAIL'}
        </span>
      </td>
    </tr>
  );
}

function VerdictBanner({ passed, total }) {
  const all = passed === total;
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-6 py-5 shadow-sm ${
        all ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <div className="flex items-center gap-4">
        <span
          className={`flex h-12 w-12 items-center justify-center rounded-full ${
            all ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
          }`}
        >
          {all ? <ShieldCheck size={26} /> : <AlertTriangle size={26} />}
        </span>
        <div>
          <p
            className={`text-lg font-bold ${all ? 'text-emerald-800' : 'text-amber-800'}`}
          >
            {all
              ? `All ${total} server checks passed`
              : `${passed} of ${total} server checks passed`}
          </p>
          <p className={`text-sm ${all ? 'text-emerald-600' : 'text-amber-600'}`}>
            {all
              ? 'The proof is internally consistent. Recompute it yourself below.'
              : 'Some checks failed — treat this evidence with caution.'}
          </p>
        </div>
      </div>
      <div className={`text-right ${all ? 'text-emerald-700' : 'text-amber-700'}`}>
        <p className="text-3xl font-bold">
          {passed}
          <span className="text-lg font-medium">/{total}</span>
        </p>
        <p className="text-xs font-medium uppercase tracking-wide">checks passed</p>
      </div>
    </div>
  );
}

function ProofDetails({ proof, evidence }) {
  if (!proof) {
    return (
      <Card>
        <CardHeader title="Proof" subtitle="No proof available" />
        <div className="p-5">
          <EmptyState icon={Clock} title="Not sealed" subtitle="This record has no proof yet." />
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Proof details" subtitle="As recorded at seal time" />
      <div className="grid gap-5 px-5 py-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Hash</p>
          <code className="mono-hash mt-1 block">{evidence?.sha256 || '—'}</code>
          <p className="mt-1 text-xs text-slate-400">
            manifestHash: <code className="font-mono">{truncate(proof.manifestHash, 14, 8)}</code>
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Timestamp
          </p>
          <p className="mt-1 text-sm text-slate-700">
            {formatDate(proof.timestamp?.genTime)} ·{' '}
            <code className="font-mono text-xs">{proof.timestamp?.mode}</code>
            {proof.timestamp?.tsa ? (
              <span className="block truncate text-xs text-slate-500">
                TSA: {proof.timestamp.tsa}
              </span>
            ) : (
              <span className="block text-xs text-slate-400">local clock (dev profile)</span>
            )}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Signature</p>
          <p className="mt-1 text-sm text-slate-700">
            <code className="font-mono text-xs">{proof.signature?.keyId}</code>
            <span className="block text-xs text-slate-500">
              {proof.signature?.algorithm} · value{' '}
              <code className="font-mono">{truncate(proof.signature?.value, 12, 6)}</code>
            </span>
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Ledger entry
          </p>
          <p className="mt-1 text-sm text-slate-700">
            seq <code className="font-mono font-semibold">{proof.ledger?.seq}</code>
            <span className="block truncate text-xs text-slate-500">
              entryHash <code className="font-mono">{truncate(proof.ledger?.entryHash, 14, 8)}</code>
              {proof.ledger?.chainVerified !== undefined &&
                (proof.ledger.chainVerified ? ' ✓ chain verified' : ' ✗ chain broken')}
            </span>
          </p>
        </div>

        <div className="md:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Anchor</p>
          {proof.anchor ? (
            <p className="mt-1 text-sm text-slate-700">
              batch <code className="font-mono">{proof.anchor.batchId}</code> · root{' '}
              <code className="font-mono">{truncate(proof.anchor.root, 14, 8)}</code>
              <span className="block text-xs text-slate-500">
                seqs {proof.anchor.fromSeq}→{proof.anchor.toSeq} · published{' '}
                {formatDate(proof.anchor.publishedAt)}
                {proof.anchor.included !== undefined &&
                  (proof.anchor.included ? ' · included ✓' : ' · not included')}
                {proof.anchor.externalRef ? ` · ext: ${proof.anchor.externalRef}` : ''}
              </span>
            </p>
          ) : (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
              <Clock size={14} className="text-amber-500" /> Pending anchor — batches publish
              periodically.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function EvidenceSummary({ evidence }) {
  if (!evidence) return null;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <TypeIcon type={evidence.type} size={15} className="text-indigo-500" />
            Evidence
          </span>
        }
        subtitle={evidence.id}
      />
      <div className="px-5 py-4">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">File</dt>
            <dd className="text-sm text-slate-700">
              {evidence.filename} · {formatBytes(evidence.size)} ·{' '}
              <span className="capitalize">{evidence.type}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Capture method
            </dt>
            <dd className="text-sm text-slate-700">
              <code className="font-mono text-xs">{evidence.captureMethod}</code>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">SHA-256</dt>
            <dd>
              <code className="mono-hash">{evidence.sha256}</code>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Sealed at
            </dt>
            <dd className="text-sm text-slate-700">{formatDate(evidence.sealedAt)}</dd>
          </div>
          {evidence.capture?.url && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">URL</dt>
              <dd className="break-all text-sm text-slate-700">{evidence.capture.url}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Client time
            </dt>
            <dd className="text-sm text-slate-700">
              {formatDate(evidence.capture?.clientTime)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Server time
            </dt>
            <dd className="text-sm text-slate-700">
              {formatDate(evidence.capture?.serverTime)}
            </dd>
          </div>
          {evidence.capture?.device && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Device</dt>
              <dd className="break-all text-sm text-slate-700">{evidence.capture.device}</dd>
            </div>
          )}
        </dl>
      </div>
    </Card>
  );
}

/** Screen shown when no token is in the URL: paste a verification link. */
function PasteLinkScreen() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  function submit(e) {
    e.preventDefault();
    const token = tokenFromVerificationInput(value);
    if (!token) {
      setError('Paste a verification link or token.');
      return;
    }
    navigate(`/verify/${token}`);
  }

  return (
    <PublicLayout>
      <div className="mx-auto max-w-xl">
        <div className="mb-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
            <SearchCheck size={26} />
          </span>
          <h1 className="mt-4 text-xl font-bold text-slate-900">Verify evidence</h1>
          <p className="mt-1 text-sm text-slate-500">
            Paste a ProofTrail verification link — no account needed.
          </p>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                Verification link or token
              </span>
              <div className="flex gap-2">
                <input
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="https://…/verify/abc123… or just the token"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setError(null);
                  }}
                />
                <Button type="submit" className="shrink-0">
                  <ClipboardPaste size={16} /> Verify
                </Button>
              </div>
            </label>
            {error && <p className="text-sm text-rose-600">{error}</p>}
          </form>
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
            <Link2 size={14} className="mt-0.5 shrink-0 text-indigo-500" />
            Verification links are created per evidence share or package. Anyone with the link can
            verify; only you can revoke it.
          </p>
        </Card>
      </div>
    </PublicLayout>
  );
}

export default function Verify() {
  const { token: pathToken } = useParams();
  const [params, setParams] = useSearchParams();

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fail, setFail] = useState(null); // {status, code, message}
  const [downloadBusy, setDownloadBusy] = useState(false);

  const deep = params.get('deep') === '1';

  const load = useCallback(
    async (tk, isDeep) => {
      setLoading(true);
      setFail(null);
      try {
        const res = await publicApi.verify(tk, { deep: isDeep });
        setResult(res);
      } catch (e) {
        setResult(null);
        if (e instanceof ApiError) {
          setFail({ status: e.status, code: e.code, message: e.message });
        } else {
          setFail({ status: 0, code: 'network_error', message: e.message });
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (pathToken) load(pathToken, deep);
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathToken, deep]);

  async function downloadOriginal() {
    setDownloadBusy(true);
    try {
      await publicApi.download(pathToken);
    } catch (e) {
      setFail({ status: e.status, code: e.code, message: e.message });
    } finally {
      setDownloadBusy(false);
    }
  }

  function reverifyDeep() {
    const next = new URLSearchParams(params);
    next.set('deep', '1');
    setParams(next);
  }

  if (!pathToken) return <PasteLinkScreen />;

  // --- failure screens ---
  if (loading) {
    return (
      <PublicLayout>
        <div className="flex flex-col items-center gap-3 py-24 text-slate-500">
          <Spinner size={28} className="text-indigo-500" />
          <p className="text-sm">Fetching proof from the verification service…</p>
        </div>
      </PublicLayout>
    );
  }

  if (fail) {
    const notFound = fail.status === 404 || fail.code === 'not_found';
    const gone = fail.status === 410 || fail.code === 'gone';
    const limited = fail.status === 429;
    return (
      <PublicLayout>
        <div className="mx-auto max-w-xl">
          <Card className="p-8 text-center">
            <span
              className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${
                gone
                  ? 'bg-amber-100 text-amber-600'
                  : notFound
                    ? 'bg-slate-100 text-slate-500'
                    : 'bg-rose-100 text-rose-600'
              }`}
            >
              {gone ? <Clock size={28} /> : notFound ? <FileQuestion size={28} /> : <AlertTriangle size={28} />}
            </span>
            <h1 className="mt-4 text-lg font-bold text-slate-900">
              {gone
                ? 'This link has expired or been revoked'
                : notFound
                  ? 'Verification link not found'
                  : limited
                    ? 'Too many requests'
                    : 'Verification service unreachable'}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              {gone
                ? 'The share behind this link is no longer valid — it either reached its expiry time or was revoked by the owner. That is the expected result for a withdrawn evidence link.'
                : notFound
                  ? 'No share exists for this token. Links are case-sensitive; check the full URL, or ask the sender for a fresh link.'
                  : limited
                    ? 'The public verification endpoints are rate-limited to prevent abuse. Wait a moment and try again.'
                    : fail.message}
            </p>
            <p className="mt-3 break-all font-mono text-xs text-slate-400">
              token: {truncate(pathToken, 16, 8)}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button variant="secondary" onClick={() => load(pathToken, deep)}>
                <RefreshCw size={15} /> Retry
              </Button>
              <Link to="/verify">
                <Button variant="secondary">
                  <ClipboardPaste size={15} /> Try another link
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </PublicLayout>
    );
  }

  const res = result;
  const isPackage = res?.kind === 'package' || res?.scope === 'package';
  const items = res?.items || [];

  // Aggregate verdict: evidence scope uses top-level checks; package scope sums items.
  const passed = isPackage
    ? items.reduce((n, it) => n + (it.checksPassed || 0), 0)
    : res?.checksPassed || 0;
  const total = isPackage
    ? items.reduce((n, it) => n + (it.checksTotal || 0), 0)
    : res?.checksTotal || 0;

  const includeDownload = Boolean(res?.share?.includeDownload);

  return (
    <PublicLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              {isPackage ? 'Package verification' : 'Evidence verification'}
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Shared {formatDate(res?.share?.createdAt)}
              {res?.share?.expiresAt ? ` · expires ${formatDate(res.share.expiresAt)}` : ''}
              {deep ? ' · deep ledger check enabled' : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!deep && (
              <Button variant="secondary" size="sm" onClick={reverifyDeep}>
                <RefreshCw size={14} /> Deep re-verify (?deep=1)
              </Button>
            )}
            {includeDownload && (
              <Button size="sm" onClick={downloadOriginal} loading={downloadBusy}>
                <Download size={14} /> Download original
              </Button>
            )}
          </div>
        </div>

        <VerdictBanner passed={passed} total={total || 0} />

        {/* Server-side checks */}
        {!isPackage && Array.isArray(res?.checks) && (
          <Card>
            <CardHeader
              title="Server-side checks"
              subtitle="Recomputed by the verification service (GET /public/verify)"
            />
            <div className="px-5 py-2">
              <table className="w-full text-left">
                <tbody className="stagger">
                  {res.checks.map((c) => (
                    <CheckRow key={c.name} check={c} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {isPackage && items.length === 0 && (
          <Card>
            <EmptyState
              icon={FileQuestion}
              title="Package contains no items"
              subtitle="The package scope returned an empty items array."
            />
          </Card>
        )}

        {/* Evidence scope: details + independent browser verification */}
        {!isPackage && res?.evidence && (
          <div className="space-y-6">
            <EvidenceSummary evidence={res.evidence} />
            <ProofDetails proof={res.proof} evidence={res.evidence} />
            <BrowserVerificationPanel
              evidence={res.evidence}
              proof={res.proof}
              serverChecks={res.checks || []}
              fileHint={res.evidence.filename || 'the original file'}
            />
          </div>
        )}

        {/* Package scope: per-item cards with their own file pickers */}
        {isPackage && (
          <div className="space-y-6">
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Link2 size={15} className="text-indigo-500" /> Package
                  </span>
                }
                subtitle={res?.package?.id}
              />
              <div className="px-5 py-4 text-sm text-slate-600">
                {res?.package?.itemCount} item{res?.package?.itemCount === 1 ? '' : 's'} ·
                generated {formatDate(res?.package?.generatedAt)}
              </div>
            </Card>

            {items.map((item, idx) => (
              <div key={item?.evidence?.id || idx} className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">
                    {idx + 1}
                  </span>
                  <p className="truncate text-sm font-semibold text-slate-800">
                    {item?.evidence?.filename || `Item ${idx + 1}`}
                  </p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      item?.checksPassed === item?.checksTotal
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {item?.checksPassed}/{item?.checksTotal} checks
                  </span>
                </div>

                <Card>
                  <CardHeader
                    title="Server-side checks"
                    subtitle={item?.evidence?.id}
                    action={
                      <span className="text-xs text-slate-400">
                        {formatBytes(item?.evidence?.size)} · sealed{' '}
                        {formatDate(item?.evidence?.sealedAt)}
                      </span>
                    }
                  />
                  <div className="px-5 py-2">
                    <table className="w-full text-left">
                      <tbody>
                        {(item?.checks || []).map((c) => (
                          <CheckRow key={c.name} check={c} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                <BrowserVerificationPanel
                  evidence={item?.evidence}
                  proof={item?.proof}
                  serverChecks={item?.checks || []}
                  compact
                  fileHint={item?.evidence?.filename || 'this file'}
                />
              </div>
            ))}
          </div>
        )}

        {/* Footer note */}
        <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs leading-relaxed text-slate-500 shadow-sm">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-indigo-500" />
          <span>
            Server checks and <strong>recomputed-in-your-browser</strong> checks are shown side by
            side. Local file bytes never leave this device: the browser computes SHA-256 with
            WebCrypto, re-canonicalizes the manifest, verifies the ECDSA P-256 signature and compares
            timestamp tokens independently of the server.
          </span>
        </p>
      </div>
    </PublicLayout>
  );
}
