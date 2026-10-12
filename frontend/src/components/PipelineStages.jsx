import { CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';

/**
 * Seal pipeline visualization:
 *   uploading → verifying → timestamping → signing → anchoring → sealed
 *
 * `stage` is the index of the active stage; stages before it are done, after it
 * are pending. Pass `failed` to mark the pipeline as failed at the active stage.
 */
export const STAGES = [
  { key: 'uploading', label: 'Uploading', hint: 'Raw bytes sent to storage' },
  { key: 'verifying', label: 'Verifying', hint: 'Server recomputes SHA-256' },
  { key: 'timestamping', label: 'Timestamping', hint: 'RFC 3161 trusted time' },
  { key: 'signing', label: 'Signing', hint: 'ECDSA P-256 manifest signature' },
  { key: 'anchoring', label: 'Anchoring', hint: 'Append-only hash-chained ledger' },
  { key: 'sealed', label: 'Sealed', hint: 'Write-once vault + proof issued' },
];

export default function PipelineStages({ stage = 0, failed = false, compact = false }) {
  return (
    <ol className={compact ? 'space-y-2' : 'space-y-3'}>
      {STAGES.map((s, i) => {
        const done = i < stage;
        const active = i === stage;
        const isFailed = active && failed;
        return (
          <li key={s.key} className="flex animate-fade-in items-start gap-3">
            <span
              className={`mt-0.5 shrink-0 ${active && !failed && !done ? 'animate-ring-pulse rounded-full' : ''}`}
            >
              {isFailed ? (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600">
                  !
                </span>
              ) : done ? (
                <CheckCircle2 size={22} className="animate-pop text-emerald-500" />
              ) : active ? (
                failed ? (
                  <CircleDashed size={22} className="text-slate-300" />
                ) : (
                  <Loader2 size={22} className="animate-spin text-indigo-500" />
                )
              ) : (
                <CircleDashed size={22} className="text-slate-300" />
              )}
            </span>
            <span className="min-w-0">
              <span
                className={`block text-sm font-medium ${
                  isFailed
                    ? 'text-rose-700'
                    : done
                      ? 'text-slate-800'
                      : active
                        ? 'text-indigo-700'
                        : 'text-slate-400'
                }`}
              >
                {s.label}
                {isFailed && ' — failed'}
              </span>
              {!compact && (
                <span
                  className={`block text-xs ${
                    done || active ? 'text-slate-500' : 'text-slate-400'
                  }`}
                >
                  {s.hint}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
