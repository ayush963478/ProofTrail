import { Link } from 'react-router-dom';
import {
  Camera,
  FileText,
  File as FileIcon,
  Globe,
  Image,
  MessageSquare,
  Mic,
  Video,
} from 'lucide-react';
import StatusChip from './StatusChip.jsx';
import { formatDate, formatBytes, shortHash } from '../lib/format.js';

export const TYPE_ICONS = {
  photo: Image,
  page: Globe,
  chat: MessageSquare,
  file: FileIcon,
  audio: Mic,
  video: Video,
  text: FileText,
  screen: Camera,
};

export function TypeIcon({ type, size = 18, className = '' }) {
  const Icon = TYPE_ICONS[type] || FileIcon;
  return <Icon size={size} className={className} />;
}

/** List row for an evidence item (dashboard + case detail list view). */
export function EvidenceRow({ evidence, showCase = false }) {
  return (
    <Link
      to={`/evidence/${evidence.id}`}
      className="group flex items-center gap-3 border-b border-slate-100 px-4 py-3 transition last:border-b-0 hover:bg-slate-50"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition-all duration-150 group-hover:scale-110 group-hover:bg-indigo-50 group-hover:text-indigo-600">
        <TypeIcon type={evidence.type} size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-900">
          {evidence.filename}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          <span className="capitalize">{evidence.type}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(evidence.size)}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono" title={evidence.sha256 || ''}>
            {evidence.sha256 ? shortHash(evidence.sha256) : 'no hash yet'}
          </span>
          {showCase && evidence.caseId && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{evidence.caseId}</span>
            </>
          )}
        </span>
      </span>
      <span className="hidden shrink-0 text-xs text-slate-400 sm:block">
        {evidence.proof?.sealedAt
          ? formatDate(evidence.proof.sealedAt)
          : formatDate(evidence.createdAt)}
      </span>
      <StatusChip status={evidence.status} />
    </Link>
  );
}

/** Card variant used by the case detail grid view. */
export function EvidenceCard({ evidence }) {
  return (
    <Link
      to={`/evidence/${evidence.id}`}
      className="group card-lift flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
          <TypeIcon type={evidence.type} size={19} />
        </span>
        <StatusChip status={evidence.status} />
      </div>
      <p className="mt-3 truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700">
        {evidence.filename}
      </p>
      <p className="mt-1 truncate font-mono text-xs text-slate-500" title={evidence.sha256 || ''}>
        {evidence.sha256 ? shortHash(evidence.sha256) : 'hash pending'}
      </p>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
        <span className="capitalize">{evidence.type}</span>
        <span>
          {evidence.proof?.sealedAt
            ? `Sealed ${formatDate(evidence.proof.sealedAt)}`
            : formatDate(evidence.createdAt)}
        </span>
      </div>
    </Link>
  );
}
