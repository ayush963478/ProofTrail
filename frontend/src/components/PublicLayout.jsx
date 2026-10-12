import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { env } from '../lib/env.js';

/**
 * Minimal chrome for public pages (verification portal). No sidebar, no auth.
 */
export default function PublicLayout({ children, subtitle = 'Verification portal' }) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <ShieldCheck size={18} />
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-bold text-slate-900">
                {env.appName}
              </span>
              <span className="block text-[11px] font-medium text-slate-500">{subtitle}</span>
            </span>
          </Link>
          <Link
            to="/login"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 text-center text-xs text-slate-400 sm:px-6">
          Independent checks run entirely in your browser with WebCrypto — no file is ever uploaded
          to verify.
        </div>
      </footer>
    </div>
  );
}
