import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AlertCircle, Info, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import { Button, Field, Input } from '../components/ui.jsx';
import { ApiError } from '../api/client.js';
import { env } from '../lib/env.js';

export default function Signup() {
  const { ready, token, authMode, meta, signup, busy } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const isCognito = authMode === 'cognito';

  if (ready && token) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!isCognito) {
      // Dev mode: no Cognito pool exists — accounts are implicit. Record nothing,
      // just head to the dev login (which mints a token via POST /dev/token).
      if (!email.trim()) {
        setError('Email is required.');
        return;
      }
      toast.info('Dev mode — no signup needed. Signing you in.');
      navigate(`/login?return=${encodeURIComponent('/')}`);
      return;
    }
    if (password !== password2) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    try {
      await signup({ email: email.trim(), password, name: name.trim() || undefined });
      setDone(true);
      toast.success('Account created — check your inbox for the confirmation code');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err?.message || 'Sign up failed';
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center animate-fade-in-up">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md animate-pop">
            <ShieldCheck size={26} />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {meta?.appName || env.appName} — evidence you can prove.
          </p>
        </div>

        <div
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm animate-fade-in-up"
          style={{ animationDelay: '0.09s' }}
        >
          {!isCognito && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs leading-relaxed text-sky-800">
              <Info size={15} className="mt-0.5 shrink-0" />
              <span>
                <strong>Dev mode.</strong> The backend (<code className="font-mono">GET /meta</code>{' '}
                reports <code className="font-mono">authMode: &quot;dev&quot;</code>) has no signup
                or email confirmation — accounts are created implicitly from your email at sign-in.
                You can still record a preferred name below, then head to the dev login.
              </span>
            </div>
          )}

          {done ? (
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <ShieldCheck size={22} />
              </div>
              <h2 className="text-base font-semibold text-slate-900">Check your email</h2>
              <p className="mt-1 text-sm text-slate-500">
                We sent a confirmation code to <strong>{email}</strong>. Enter it on the confirmation
                page to activate your account.
              </p>
              <Button
                className="mt-4 w-full"
                onClick={() => navigate(`/confirm?email=${encodeURIComponent(email)}`)}
              >
                Enter confirmation code
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Field label="Email" htmlFor="su-email" required>
                <Input
                  id="su-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field label="Full name" htmlFor="su-name" hint="Optional.">
                <Input
                  id="su-name"
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              {isCognito && (
                <>
                  <Field label="Password" htmlFor="su-password" required>
                    <Input
                      id="su-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Confirm password" htmlFor="su-password2" required>
                    <Input
                      id="su-password2"
                      type="password"
                      autoComplete="new-password"
                      value={password2}
                      onChange={(e) => setPassword2(e.target.value)}
                      required
                    />
                  </Field>
                </>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" className="w-full" loading={busy}>
                {isCognito ? 'Create account' : 'Continue to login'}
              </Button>
            </form>
          )}

          {!done && (
            <p className="mt-4 text-center text-sm text-slate-500">
              Already registered?{' '}
              <Link to="/login" className="font-medium text-indigo-600 hover:underline">
                Sign in
              </Link>
              {' · '}
              <Link to="/confirm" className="font-medium text-indigo-600 hover:underline">
                Confirm code
              </Link>
            </p>
          )}

          {done && (
            <p className="mt-4 text-center text-sm text-slate-500">
              <Link to="/login" className="font-medium text-indigo-600 hover:underline">
                Back to sign in
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
