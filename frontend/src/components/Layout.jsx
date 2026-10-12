import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Camera,
  CreditCard,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Settings as SettingsIcon,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { planLabel } from '../lib/format.js';
import { env } from '../lib/env.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/cases', label: 'Cases', icon: FolderOpen },
  { to: '/capture', label: 'Capture', icon: Camera },
  { to: '/packages', label: 'Packages', icon: Package },
  { to: '/pricing', label: 'Pricing', icon: CreditCard },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

const TITLES = [
  { match: /^\/$/, title: 'Dashboard' },
  { match: /^\/cases$/, title: 'Cases' },
  { match: /^\/cases\/.+/, title: 'Case detail' },
  { match: /^\/capture$/, title: 'Capture evidence' },
  { match: /^\/evidence\/.+/, title: 'Evidence detail' },
  { match: /^\/packages$/, title: 'Packages' },
  { match: /^\/pricing$/, title: 'Pricing' },
  { match: /^\/settings$/, title: 'Settings' },
];

function pageTitle(pathname) {
  const hit = TITLES.find((t) => t.match.test(pathname));
  return hit ? hit.title : 'ProofTrail';
}

function SidebarNav({ onNavigate }) {
  const { meta } = useAuth();
  return (
    <>
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
          <ShieldCheck size={20} />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-bold tracking-tight text-slate-900">
            {meta?.appName || env.appName}
          </p>
          <p className="text-[11px] font-medium text-slate-500">Chain of custody</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                isActive
                  ? 'bg-indigo-50 text-indigo-700 shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 hover:translate-x-0.5'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={18}
                  className={`transition-transform duration-150 group-hover:scale-110 ${
                    isActive ? 'text-indigo-600' : 'text-slate-400'
                  }`}
                />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-slate-100 px-5 py-4">
        <p className="text-[11px] leading-relaxed text-slate-400">
          Hash · timestamp · sign · anchor — verified in your browser.
        </p>
      </div>
    </>
  );
}

/**
 * App shell: fixed sidebar (desktop) / off-canvas drawer (mobile),
 * top bar with page title, plan chip and user menu.
 */
export default function Layout({ children }) {
  const { user, meta, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const plan = user?.plan || 'free';
  const initial = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <SidebarNav />
      </aside>

      {/* Sidebar (mobile drawer) */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-2xl animate-slide-in-left">
            <div className="flex justify-end px-3 pt-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
                aria-label="Close navigation"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex flex-1 flex-col">
              <SidebarNav onNavigate={() => setOpen(false)} />
            </div>
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu size={19} />
            </button>
            <h1 className="flex-1 truncate text-sm font-semibold text-slate-900 sm:text-base">
              <span key={location.pathname} className="inline-block animate-fade-in">
                {pageTitle(location.pathname)}
              </span>
              {meta?.mode && (
                <span className="ml-2 hidden align-middle text-xs font-normal text-slate-400 sm:inline">
                  {meta.mode} mode
                </span>
              )}
            </h1>

            <span className="hidden items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 sm:inline-flex">
              {planLabel(plan)} plan
            </span>

            <Link
              to="/settings"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-slate-100"
              title="Settings"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">
                {initial || '?'}
              </span>
              <span className="hidden max-w-[10rem] truncate text-sm font-medium text-slate-700 md:inline">
                {user?.name || user?.email || 'Account'}
              </span>
            </Link>

            <button
              type="button"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-rose-600"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {/* Keyed by path: every route change replays the entrance animation. */}
          <div key={location.pathname} className="animate-fade-in-up">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
