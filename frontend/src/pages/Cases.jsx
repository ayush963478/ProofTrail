import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, FolderOpen, FolderPlus, Scale } from 'lucide-react';
import { ApiError, casesApi } from '../api/client.js';
import { useToast } from '../components/Toast.jsx';
import { Button, Card, EmptyState, ErrorState, Field, Input, PageSpinner, Textarea } from '../components/ui.jsx';
import { Modal } from '../components/Modal.jsx';
import { formatDate, timeAgo } from '../lib/format.js';

export default function Cases() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(Boolean(location.state?.create));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCases(await casesApi.list());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createCase(e) {
    e.preventDefault();
    setSaveError(null);
    if (!title.trim()) {
      setSaveError('Title is required.');
      return;
    }
    setSaving(true);
    try {
      const created = await casesApi.create({
        title: title.trim(),
        description: description.trim() || undefined,
      });
      toast.success('Case created');
      setModalOpen(false);
      setTitle('');
      setDescription('');
      navigate(`/cases/${created.id}`);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!cases && !error) return <PageSpinner label="Loading cases…" />;
  if (!cases && error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Cases</h2>
          <p className="text-sm text-slate-500">
            Each case groups evidence under one chain of custody.
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <FolderPlus size={16} /> New case
        </Button>
      </div>

      {cases.length === 0 ? (
        <EmptyState
          icon={Scale}
          title="No cases yet"
          subtitle="Create your first case to start collecting evidence with a verifiable chain of custody."
          action={
            <Button onClick={() => setModalOpen(true)}>
              <FolderPlus size={16} /> Create case
            </Button>
          }
        />
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cases.map((c) => (
            <Link
              key={c.id}
              to={`/cases/${c.id}`}
              className="group card-lift rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:border-indigo-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <FolderOpen size={19} />
                </span>
                <ChevronRight
                  size={16}
                  className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500"
                />
              </div>
              <h3 className="mt-3 truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700">
                {c.title}
              </h3>
              <p className="mt-1 line-clamp-2 min-h-[1.5rem] text-xs text-slate-500">
                {c.description || 'No description'}
              </p>
              <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                  {c.evidenceCount ?? 0} evidence
                </span>
                <span>{timeAgo(c.updatedAt || c.createdAt)}</span>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">Created {formatDate(c.createdAt)}</p>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        title="New case"
        subtitle="Give the matter a clear title — it appears in packages and reports."
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="new-case-form" loading={saving}>
              Create case
            </Button>
          </>
        }
      >
        <form id="new-case-form" onSubmit={createCase} className="space-y-4">
          <Field label="Title" htmlFor="case-title" required>
            <Input
              id="case-title"
              placeholder="e.g. Deposit dispute — March 2026"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field label="Description" htmlFor="case-desc" hint="Optional context for reviewers.">
            <Textarea
              id="case-desc"
              placeholder="What this case is about…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {saveError && <p className="text-sm text-rose-600">{saveError}</p>}
        </form>
      </Modal>
    </div>
  );
}
