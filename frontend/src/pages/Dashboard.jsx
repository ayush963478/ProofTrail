import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  FilePlus2,
  FolderPlus,
  Hourglass,
  Link2,
  Package,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import { casesApi, evidenceApi, packagesApi, ApiError } from '../api/client.js';
import { useToast } from '../components/Toast.jsx';
import { Button, Card, CardHeader, EmptyState, ErrorState } from '../components/ui.jsx';
import { EvidenceRow } from '../components/EvidenceList.jsx';
import StatusChip from '../components/StatusChip.jsx';

const PENDING_STATUSES = ['pending_upload', 'uploaded', 'sealing'];

function StatCard({ icon: Icon, label, value, accent, sub, to }) {
  return (
    <Link
      to={to}
      className="group card-lift rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:border-indigo-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between">
        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${accent}`}>
          <Icon size={19} />
        </span>
        <ArrowRight
          size={15}
          className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500"
        />
      </div>
      <p className="mt-4 text-2xl font-bold tracking-tight text-slate-900">{value}</p>
      <p className="text-sm font-medium text-slate-600">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </Link>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [cases, evidence, pkgs] = await Promise.all([
        casesApi.list(),
        evidenceApi.list(),
        packagesApi.list(),
      ]);
      setData({ cases, evidence, packages: pkgs });
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}` : e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data && !error) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="skeleton h-10 w-10" />
              <div className="skeleton mt-4 h-7 w-16" />
              <div className="skeleton mt-2 h-4 w-28" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
            <div className="skeleton h-4 w-36" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="skeleton h-9 w-9 shrink-0" />
                <div className="flex-1">
                  <div className="skeleton h-4 w-2/5" />
                  <div className="skeleton mt-1.5 h-3 w-3/5" />
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="skeleton h-4 w-28" />
            <div className="skeleton h-9 w-full" />
            <div className="skeleton h-9 w-full" />
            <div className="skeleton h-9 w-full" />
          </div>
        </div>
      </div>
    );
  }
  if (!data && error) return <ErrorState message={error} onRetry={load} />;

  const evidence = data.evidence || [];
  const cases = data.cases || [];
  const pkgs = data.packages || [];

  const sealed = evidence.filter((e) => e.status === 'sealed').length;
  const pending = evidence.filter((e) => PENDING_STATUSES.includes(e.status)).length;
  const failed = evidence.filter((e) => e.status === 'failed').length;
  const recent = [...evidence]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Scale}
          label="Cases"
          value={cases.length}
          accent="bg-indigo-50 text-indigo-600"
          sub="Chain-of-custody matters"
          to="/cases"
        />
        <StatCard
          icon={ShieldCheck}
          label="Sealed evidence"
          value={sealed}
          accent="bg-emerald-50 text-emerald-600"
          sub="Timestamped + anchored"
          to="/packages"
        />
        <StatCard
          icon={Hourglass}
          label="Pending seals"
          value={pending}
          accent="bg-amber-50 text-amber-600"
          sub={failed ? `${failed} failed` : 'In the seal pipeline'}
          to="/capture"
        />
        <StatCard
          icon={Package}
          label="Packages"
          value={pkgs.length}
          accent="bg-sky-50 text-sky-600"
          sub="Shareable evidence bundles"
          to="/packages"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Recent evidence */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent evidence"
            subtitle="Latest captures across all cases"
            action={
              <Link
                to="/cases"
                className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
              >
                View cases
              </Link>
            }
          />
          {recent.length === 0 ? (
            <EmptyState
              icon={FilePlus2}
              title="No evidence yet"
              subtitle="Capture your first file — SHA-256 is computed in your browser before anything is uploaded."
              action={
                <Button onClick={() => navigate('/capture')}>
                  <Camera size={16} /> Capture evidence
                </Button>
              }
              className="m-4"
            />
          ) : (
            <div className="stagger">
              {recent.map((ev) => (
                <EvidenceRow key={ev.id} evidence={ev} showCase />
              ))}
            </div>
          )}
        </Card>

        {/* Quick actions */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="Quick actions" />
            <div className="space-y-3 p-4">
              <Button className="w-full" onClick={() => navigate('/cases', { state: { create: true } })}>
                <FolderPlus size={16} /> New case
              </Button>
              <Button variant="secondary" className="w-full" onClick={() => navigate('/capture')}>
                <Camera size={16} /> Capture evidence
              </Button>
              <Button variant="secondary" className="w-full" onClick={() => navigate('/verify')}>
                <Link2 size={16} /> Verify a link
              </Button>
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <CheckCircle2 size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">How sealing works</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  You send a <em>claim</em> (client SHA-256). The server recomputes it, timestamps
                  the canonical manifest (RFC 3161), signs it with ECDSA P-256, appends a
                  hash-chained ledger entry and anchors batches with Merkle roots — then stores the
                  original in a write-once vault.
                </p>
              </div>
            </div>
          </Card>

          {pending > 0 && (
            <Card className="border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start gap-2 text-sm text-amber-800">
                <Hourglass size={16} className="mt-0.5 shrink-0" />
                <span>
                  {pending} item{pending === 1 ? '' : 's'} still sealing. Open an item to watch the
                  pipeline or retry a failed upload.
                </span>
              </div>
            </Card>
          )}
        </div>
      </div>

      {failed > 0 && (
        <Card className="border-rose-200 bg-rose-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-rose-800">
              <StatusChip status="failed" /> {failed} item{failed === 1 ? '' : 's'} failed to seal —
              usually a hash mismatch between the client claim and received bytes.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                toast.info('Open the failed item to inspect sealError and re-upload.');
              }}
            >
              What now?
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
