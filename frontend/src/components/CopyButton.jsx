import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useToast } from './Toast.jsx';

/** Copy-to-clipboard button with a brief check-state. */
export default function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  variant = 'secondary',
  className = '',
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(value ?? ''));
      } else {
        const ta = document.createElement('textarea');
        ta.value = String(value ?? '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      toast.error(`Copy failed: ${e.message}`);
    }
  }

  const sizes = { xs: 'px-1.5 py-1 text-xs', sm: 'px-2.5 py-1.5 text-xs', md: 'px-3 py-2 text-sm' };
  const variants = {
    secondary: 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
    ghost: 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500',
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={label}
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-md font-medium transition-all duration-150 active:scale-95 disabled:opacity-60 ${
        copied ? 'border border-emerald-300 bg-emerald-50 text-emerald-700' : ''
      } ${variants[variant] || variants.secondary} ${sizes[size] || sizes.sm} ${className}`}
    >
      {copied ? (
        <Check size={13} className="animate-pop text-emerald-500" />
      ) : (
        <Copy size={13} />
      )}
      {copied ? 'Copied' : label}
    </button>
  );
}
