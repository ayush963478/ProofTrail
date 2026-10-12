import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Camera,
  Download,
  FilePlus2,
  Grid2x2,
  Link2,
  List,
  Package as PackageIcon,
  Scale,
  Trash2,
} from 'lucide-react';
import { ApiError, casesApi, evidenceApi, packagesApi } from '../api/client.js';
import { useToast } from '../components/Toast.jsx';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  PageSpinner,
} from '../components/ui.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { EvidenceCard, EvidenceRow } from '../components/EvidenceList.jsx';
import CopyButton from '../components/CopyButton.jsx';
import { formatBytes, formatDate, truncate } from '../lib/format.js';
import { verificationUrl } from '../lib/env.js';

export default function CaseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('list');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [pkgBusyId, setPkgBusyId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [caseRec, evidence, pkgs] = await Promise.all([
        casesApi.get(id),
        evidenceApi.list(id),
        packagesApi.list(id),
      ]);
      setData({ caseRec, evidence, packages: pkgs });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'Case not found.' : e.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function deleteCase() {
    setDeleting(true);
    try {
      await casesApi.remove(id);
      toast.success('Case deleted — its evidence was tombstoned');
      navigate('/cases', { replace: true });
    } catch (e) {
      toast.error(
        e.code === 'conflict'
          ? `Cannot delete: ${e.message}`
          : e.message || 'Delete failed'
      );
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  async function generatePackage() {
    setGenBusy(true);
    try {
      const pkg = await packagesApi.create({ caseId: id });
      toast.success(`Package generated (${pkg.itemCount} items)`);
      await load();
    } catch (e) {
      toast.error(e.message || 'Package generation failed');
    } finally {
      setGenBusy(false);
    }
  }

  async function downloadPackage(pkg) {
    setPkgBusyId(pkg.id);
    try {
      await packagesApi.download(pkg.id, { filename: `${pkg.id}.zip` });
      toast.success('Package download started');
    } catch (e) {
      toast.error(e.message || 'Download failed');
    } finally {
      setPkgBusyId(null);
    }
  }

  if (!data && !error) return <PageSpinner label="Loading case…" />;
  if (!data && error) return <ErrorState message={error} onRetry={load} />;

  const { caseRec, evidence, packages } = data;
  const sealed = evidence.filter((e) => e.status === 'sealed');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => navigate('/cases')}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-800"
        >
          <ArrowLeft size={15} /> All cases
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900">
              <Scale size={20} className="shrink-0 text-indigo-500" />
              {caseRec.title}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              {caseRec.description || 'No description.'}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              Created {formatDate(caseRec.createdAt)} · {caseRec.evidenceCount ?? evidence.length}{' '}
              evidence item{((caseRec.evidenceCount ?? evidence.length) === 1 ? '' : 's')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => navigate(`/capture?caseId=${id}`)}>
              <Camera size={16} /> Upload evidence
            </Button>
            <Button onClick={generatePackage} loading={genBusy} disabled={sealed.length === 0}>
              <PackageIcon size={16} /> Generate package
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
      </div>

      {/* Evidence */}
      <Card>
        <CardHeader
          title="Evidence"
          subtitle={
            sealed.length === evidence.length && evidence.length > 0
              ? 'All items sealed'
              : `${sealed.length} of ${evidence.length} sealed`
          }
          action={
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
              <button
                type="button"
                onClick={() => setView('list')}
                className={`rounded-md p-1.5 transition ${
                  view === 'list' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600'
                }`}
                aria-label="List view"
                title="List view"
              >
                <List size={15} />
              </button>
              <button
                type="button"
                onClick={() => setView('grid')}
                className={`rounded-md p-1.5 transition ${
                  view === 'grid' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600'
                }`}
                aria-label="Grid view"
                title="Grid view"
              >
                <Grid2x2 size={15} />
              </button>
            </div>
          }
        />
        {evidence.length === 0 ? (
          <EmptyState
            icon={FilePlus2}
            title="No evidence in this case"
            subtitle="Upload files with client-side SHA-256 hashing, or capture a page from the cloud."
            action={
              <Button onClick={() => navigate(`/capture?caseId=${id}`)}>
                <Camera size={16} /> Upload evidence
              </Button>
            }
            className="m-4"
          />
        ) : view === 'list' ? (
          <div>
            {evidence.map((ev) => (
              <EvidenceRow key={ev.id} evidence={ev} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {evidence.map((ev) => (
              <EvidenceCard key={ev.id} evidence={ev} />
            ))}
          </div>
        )}
      </Card>

      {/* Packages */}
      <Card>
        <CardHeader
          title="Packages"
          subtitle="Sealed bundle: originals + report.pdf + proof.json + README"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={generatePackage}
              loading={genBusy}
              disabled={sealed.length === 0}
            >
              Generate
            </Button>
          }
        />
        {packages.length === 0 ? (
          <EmptyState
            icon={PackageIcon}
            title="No packages yet"
            subtitle={
              sealed.length === 0
                ? 'Seal at least one evidence item first, then generate a package.'
                : 'Bundle sealed evidence with a shareable verification link.'
            }
            className="m-4"
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {packages.map((pkg) => {
              const link = pkg.verificationUrl || verificationUrl(pkg.shareToken);
              return (
                <div key={pkg.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                    <PackageIcon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{pkg.id}</p>
                    <p className="text-xs text-slate-500">
                      {pkg.itemCount} item{pkg.itemCount === 1 ? '' : 's'} ·{' '}
                      {formatBytes(pkg.size)} · generated {formatDate(pkg.generatedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="hidden max-w-[16rem] truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-500 sm:block">
                      {link}
                    </code>
                    <CopyButton value={link} label="Copy link" />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => window.open(link, '_blank', 'noopener')}
                      title="Open verification portal"
                    >
                      <Link2 size={14} />
                    </Button>
                    <Button
                      size="sm"
                      loading={pkgBusyId === pkg.id}
                      onClick={() => downloadPackage(pkg)}
                    >
                      <Download size={14} /> ZIP
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Danger zone */}
      <Card className="border-rose-200 bg-rose-50/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-rose-800">Delete this case</p>
            <p className="text-xs text-rose-600">
              Tombstones the case and its evidence ({truncate(id, 12, 6)}). Sealed originals remain
              in the write-once vault per retention policy.
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} /> Delete case
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete case?"
        message={`"${caseRec.title}" and its ${evidence.length} evidence item(s) will be tombstoned and disappear from listings. This cannot be undone.`}
        confirmLabel="Delete case"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={deleteCase}
      />
    </div>
  );
}
