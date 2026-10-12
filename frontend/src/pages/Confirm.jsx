import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, BadgeCheck, Info, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import { Button, Field, Input } from '../components/ui.jsx';
import { ApiError } from '../api/client.js';
import { env } from '../lib/env.js';

export default function Confirm() {
  const { ready, token, authMode, confirmSignup, busy } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();

  const [email, setEmail] = useState(params.get('email') || '');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const isCognito = authMode === 'cognito';

  if (ready && token) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    if (!code.trim()) {
      setError('Confirmation code is required.');
      return;
    }
    try {
      await confirmSignup({ email: email.trim(), code: code.trim() });
      setDone(true);
      toast.success('Account confirmed — you can sign in now');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err?.message || 'Confirmation failed';
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md">
            <ShieldCheck size={26} />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900">
            Confirm your account
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter the code we emailed you to activate sign-in.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {!isCognito && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs leading-relaxed text-sky-800">
              <Info size={15} className="mt-0.5 shrink-0" />
              <span>
                <strong>Dev mode.</strong> Email confirmation is a Cognito feature — in dev mode the
                backend issues tokens without any confirmation step (reports{' '}
                <code className="font-mono">authMode: &quot;dev&quot;</code> via{' '}
                <code className="font-mono">GET /meta</code>). Nothing to do here; go straight to
                sign-in.
              </span>
            </div>
          )}

          {done ? (
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <BadgeCheck size={22} />
              </div>
              <h2 className="text-base font-semibold text-slate-900">Account confirmed</h2>
              <p className="mt-1 text-sm text-slate-500">
                Your account is active. Sign in to start sealing evidence.
              </p>
              <Button className="mt-4 w-full" onClick={() => navigate('/login')}>
                Go to sign in
              </Button>
            </div>
          ) : isCognito ? (
            <form onSubmit={submit} className="space-y-4">
              <Field label="Email" htmlFor="cf-email" required>
                <Input
                  id="cf-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field
                label="Confirmation code"
                htmlFor="cf-code"
                hint="6-digit code sent to your inbox."
                required
              >
                <Input
                  id="cf-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="text-center font-mono text-lg tracking-[0.35em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                />
              </Field>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" className="w-full" loading={busy}>
                Confirm account
              </Button>
            </form>
          ) : (
            <div className="text-center">
              <p className="text-sm text-slate-600">
                No confirmation is required in dev mode. Head to sign-in to mint a local token.
              </p>
              <Button className="mt-4 w-full" onClick={() => navigate('/login')}>
                Go to sign in
              </Button>
            </div>
          )}

          <p className="mt-4 text-center text-sm text-slate-500">
            <Link to="/login" className="font-medium text-indigo-600 hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">API: {env.apiBaseUrl}</p>
      </div>
    </div>
  );
}
