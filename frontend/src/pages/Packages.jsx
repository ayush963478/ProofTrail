import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Download,
  FolderOpen,
  Link2,
  Package as PackageIcon,
  PackagePlus,
} from 'lucide-react';
import { ApiError, casesApi, evidenceApi, packagesApi } from '../api/client.js';
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
import { Modal } from '../components/Modal.jsx';
import { TypeIcon } from '../components/EvidenceList.jsx';
import CopyButton from '../components/CopyButton.jsx';
import StatusChip from '../components/StatusChip.jsx';
import { formatBytes, formatDate } from '../lib/format.js';
import { verificationUrl } from '../lib/env.js';

export default function Packages() {
  const toast = useToast();

  const [packages, setPackages] = useState(null);
  const [cases, setCases] = useState([]);
  const [error, setError] = useState(null);

  // Generate modal
  const [open, setOpen] = useState(false);
  const [caseId, setCaseId] = useState('');
  const [evidence, setEvidence] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pkgs, caseList] = await Promise.all([packagesApi.list(), casesApi.list()]);
      setPackages(pkgs);
      setCases(caseList);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Load sealed evidence for the chosen case inside the modal.
  useEffect(() => {
    if (!open || !caseId) {
      setEvidence([]);
      setSelected(new Set());
      return undefined;
    }
    let alive = true;
    setEvidenceLoading(true);
    evidenceApi
      .list(caseId)
      .then((list) => {
        if (!alive) return;
        const sealed = list.filter((e) => e.status === 'sealed');
        setEvidence(sealed);
        setSelected(new Set(sealed.map((e) => e.id)));
      })
      .catch(() => {
        if (alive) {
          setEvidence([]);
          setSelected(new Set());
        }
      })
      .finally(() => {
        if (alive) setEvidenceLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, caseId]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generate() {
    if (!caseId) {
      toast.warning('Choose a case first');
      return;
    }
    setGenerating(true);
    try {
      const body = { caseId };
      if (selected.size > 0 && selected.size !== evidence.length) {
        body.evidenceIds = [...selected];
      }
      const pkg = await packagesApi.create(body);
      toast.success(`Package generated: ${pkg.itemCount} item(s)`);
      setOpen(false);
      setCaseId('');
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function download(pkg) {
    setBusyId(pkg.id);
    try {
      await packagesApi.download(pkg.id, { filename: `${pkg.id}.zip` });
      toast.success('Package download started (audit-logged)');
    } catch (e) {
      toast.error(e.message || 'Download failed');
    } finally {
      setBusyId(null);
    }
  }

  if (!packages && !error) return <PageSpinner label="Loading packages…" />;
  if (!packages && error) return <ErrorState message={error} onRetry={load} />;

  const caseTitle = (cid) => cases.find((c) => c.id === cid)?.title || cid;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Evidence packages</h2>
          <p className="text-sm text-slate-500">
            ZIP bundle: <code className="font-mono">originals/</code> +{' '}
            <code className="font-mono">report.pdf</code> +{' '}
            <code className="font-mono">proof.json</code> +{' '}
            <code className="font-mono">README.txt</code>, plus a public verification link.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={cases.length === 0}>
          <PackagePlus size={16} /> Generate package
        </Button>
      </div>

      {packages.length === 0 ? (
        <EmptyState
          icon={PackageIcon}
          title="No packages yet"
          subtitle={
            cases.length === 0
              ? 'Create a case and seal some evidence first.'
              : 'Bundle sealed evidence from a case into a shareable ZIP with an embedded verification link.'
          }
          action={
            cases.length > 0 ? (
              <Button onClick={() => setOpen(true)}>
                <PackagePlus size={16} /> Generate package
              </Button>
            ) : (
              <Link to="/cases">
                <Button variant="secondary">
                  <FolderOpen size={16} /> Go to cases
                </Button>
              </Link>
            )
          }
        />
      ) : (
        <div className="space-y-4">
          {packages.map((pkg) => {
            const link = pkg.verificationUrl || verificationUrl(pkg.shareToken);
            return (
              <Card key={pkg.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
                      <PackageIcon size={21} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm font-semibold text-slate-900">
                        {pkg.id}
                      </p>
                      <p className="mt-0.5 text-sm text-slate-500">
                        <Link
                          to={`/cases/${pkg.caseId}`}
                          className="text-indigo-600 hover:underline"
                        >
                          {caseTitle(pkg.caseId)}
                        </Link>{' '}
                        · {pkg.itemCount} item{pkg.itemCount === 1 ? '' : 's'} ·{' '}
                        {formatBytes(pkg.size)}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        Generated {formatDate(pkg.generatedAt)}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <Link2 size={13} className="shrink-0 text-slate-400" />
                        <code className="truncate font-mono text-xs text-slate-500">{link}</code>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <CopyButton value={link} label="Copy link" />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => window.open(link, '_blank', 'noopener')}
                    >
                      <Link2 size={14} /> Verify
                    </Button>
                    <Button size="sm" loading={busyId === pkg.id} onClick={() => download(pkg)}>
                      <Download size={14} /> ZIP
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Generate modal */}
      <Modal
        open={open}
        title="Generate evidence package"
        subtitle="Only sealed evidence can be packaged."
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={generating}>
              Cancel
            </Button>
            <Button onClick={generate} loading={generating} disabled={!caseId}>
              Generate
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Case" htmlFor="pkg-case" required>
            <Select id="pkg-case" value={caseId} onChange={(e) => setCaseId(e.target.value)}>
              <option value="">Select a case…</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({c.evidenceCount ?? 0} evidence)
                </option>
              ))}
            </Select>
          </Field>

          {caseId && (
            <div>
              <p className="mb-2 text-sm font-medium text-slate-700">
                Evidence subset{' '}
                <span className="font-normal text-slate-400">
                  — leave all checked to include everything sealed
                </span>
              </p>
              {evidenceLoading ? (
                <p className="text-sm text-slate-500">Loading sealed evidence…</p>
              ) : evidence.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
                  No sealed evidence in this case yet.
                </p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3">
                  {evidence.map((e) => (
                    <label
                      key={e.id}
                      className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggle(e.id)}
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <TypeIcon type={e.type} size={15} className="shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                        {e.filename}
                      </span>
                      <StatusChip status={e.status} />
                    </label>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-slate-400">
                {selected.size} of {evidence.length} selected
              </p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
