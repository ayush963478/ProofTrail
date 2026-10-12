const CHIP = {
  // Server statuses (docs/API.md EvidenceItem.status)
  pending_upload: {
    label: 'Pending upload',
    className: 'bg-slate-100 text-slate-600 border-slate-200',
    dot: 'bg-slate-400',
  },
  uploaded: {
    label: 'Uploaded',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
    dot: 'bg-sky-500',
  },
  sealing: {
    label: 'Sealing',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
    dot: 'bg-amber-500 animate-pulse',
  },
  sealed: {
    label: 'Sealed',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-500',
  },
  failed: {
    label: 'Failed',
    className: 'bg-rose-50 text-rose-700 border-rose-200',
    dot: 'bg-rose-500',
  },
  // UI-only states used during the upload flow
  uploading: {
    label: 'Uploading',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
    dot: 'bg-sky-500 animate-pulse',
  },
  // Capture jobs (POST /captures)
  queued: {
    label: 'Queued',
    className: 'bg-slate-100 text-slate-600 border-slate-200',
    dot: 'bg-slate-400',
  },
  running: {
    label: 'Running',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
    dot: 'bg-amber-500 animate-pulse',
  },
  done: {
    label: 'Done',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-500',
  },
};

/** Consistent status chip for evidence status (and capture jobs). */
export default function StatusChip({ status, className = '' }) {
  const chip = CHIP[status] || {
    label: String(status || 'unknown'),
    className: 'bg-slate-100 text-slate-600 border-slate-200',
    dot: 'bg-slate-400',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${chip.className} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
      {chip.label}
    </span>
  );
}
