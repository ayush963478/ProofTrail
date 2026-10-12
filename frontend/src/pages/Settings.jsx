import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BadgeCheck,
  KeyRound,
  LogOut,
  Mail,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { metaApi } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import { Button, Card, CardHeader, Field, Input, Select } from '../components/ui.jsx';
import { formatDate, planLabel } from '../lib/format.js';
import { env } from '../lib/env.js';

const PLANS = ['free', 'personal', 'pro', 'enterprise'];

export default function Settings() {
  const { user, meta, authMode, updateUser, refreshUser, logout, cognitoConfigured } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState(user?.name || '');
  const [plan, setPlan] = useState(user?.plan || 'free');
  const [saving, setSaving] = useState(false);
  const [metaLive, setMetaLive] = useState(null);

  useEffect(() => {
    setName(user?.name || '');
    setPlan(user?.plan || 'free');
  }, [user?.name, user?.plan]);

  useEffect(() => {
    let alive = true;
    metaApi
      .get()
      .then((m) => {
        if (alive) setMetaLive(m);
      })
      .catch(() => {
        if (alive) setMetaLive(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function saveProfile(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateUser({ name: name.trim(), plan });
      toast.success('Profile updated');
      await refreshUser().catch(() => {});
    } catch (err) {
      toast.error(err.message || 'Update failed');
    } finally {
      setSaving(false);
    }
  }

  function signOut() {
    logout();
    navigate('/login', { replace: true });
  }

  const backendReachable = metaLive !== null;
  const liveMode = metaLive?.mode;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Settings</h2>
        <p className="text-sm text-slate-500">Profile, plan and environment.</p>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader title="Profile" subtitle="Identity claims shown across the app" />
        <form onSubmit={saveProfile} className="space-y-4 p-5">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-lg font-bold text-white">
              {(user?.name || user?.email || '?').trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {user?.name || 'Unnamed account'}
              </p>
              <p className="flex items-center gap-1.5 truncate text-sm text-slate-500">
                <Mail size={13} className="shrink-0 text-slate-400" />
                {user?.email || '—'}
              </p>
              {user?.createdAt && (
                <p className="text-xs text-slate-400">Member since {formatDate(user.createdAt)}</p>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" htmlFor="set-name">
              <Input
                id="set-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </Field>
            <Field label="Plan" htmlFor="set-plan" hint="Applies immediately (PATCH /me).">
              <Select id="set-plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
                {PLANS.map((p) => (
                  <option key={p} value={p}>
                    {planLabel(p)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              <Save size={15} /> Save changes
            </Button>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
                user?.mfaEnabled
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              <KeyRound size={13} />
              MFA: {user?.mfaEnabled ? 'enabled' : 'not enabled'}
            </span>
            {!user?.mfaEnabled && authMode === 'cognito' && (
              <span className="text-xs text-slate-400">
                Enable TOTP in your Cognito profile; challenges appear automatically at sign-in.
              </span>
            )}
          </div>
        </form>
      </Card>

      {/* Environment */}
      <Card>
        <CardHeader
          title="Environment"
          subtitle="API base and auth provider reported by the backend"
          action={
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()} title="Reload">
              <RefreshCw size={14} />
            </Button>
          }
        />
        <dl className="divide-y divide-slate-50 px-5 py-2">
          {[
            { label: 'API base URL', value: env.apiBaseUrl, mono: true },
            { label: 'Public base URL', value: env.publicBaseUrl, mono: true },
            {
              label: 'Auth mode',
              value: `${authMode}${metaLive ? ' (from GET /meta)' : ' (env fallback)'}`,
            },
            { label: 'Runtime mode', value: liveMode || meta?.mode || 'unknown' },
            {
              label: 'Backend status',
              value: backendReachable ? 'reachable' : 'unreachable — using cached/env config',
              ok: backendReachable,
            },
            {
              label: 'Cognito config',
              value: cognitoConfigured
                ? `${env.cognitoUserPoolId} / client ${env.cognitoClientId.slice(0, 8)}…`
                : 'not configured',
            },
            { label: 'App version', value: metaLive?.appName || meta?.appName || env.appName },
          ].map((r) => (
            <div key={r.label} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5">
              <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">
                {r.label}
              </dt>
              <dd
                className={`min-w-0 flex-1 break-all text-sm ${
                  r.mono ? 'font-mono' : ''
                } ${r.ok === false ? 'text-amber-600' : r.ok ? 'text-emerald-600' : 'text-slate-700'}`}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      {/* Session */}
      <Card className="border-rose-100">
        <CardHeader title="Session" subtitle="Sign out of this device" />
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <ShieldCheck size={16} className="text-emerald-500" />
            Signed in as {user?.email || 'unknown'} ({planLabel(user?.plan)} plan)
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/pricing')}>
              <BadgeCheck size={15} /> Change plan
            </Button>
            <Button variant="danger" onClick={signOut}>
              <LogOut size={15} /> Sign out
            </Button>
          </div>
        </div>
      </Card>

      <p className="flex items-center justify-center gap-2 pb-6 text-xs text-slate-400">
        <UserIcon size={12} /> <Server size={12} /> ProofTrail frontend · React + Vite · WebCrypto
      </p>
    </div>
  );
}
