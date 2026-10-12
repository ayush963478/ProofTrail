import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, KeyRound, Lock, ShieldCheck, User } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import { Button, Field, Input, PageSpinner } from '../components/ui.jsx';
import { ApiError } from '../api/client.js';
import { env } from '../lib/env.js';

export default function Login() {
  const {
    ready,
    token,
    authMode,
    meta,
    challenge,
    login,
    verifyMfa,
    completeNewPassword,
    cancelChallenge,
    busy,
    cognitoConfigured,
  } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const returnTo = params.get('return') || '/';

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [error, setError] = useState(null);

  const isCognito = authMode === 'cognito';

  useEffect(() => {
    setError(null);
  }, [challenge]);

  if (ready && token) return <Navigate to={returnTo} replace />;

  const screen = challenge?.type === 'mfa' ? 'mfa' : challenge?.type === 'newPassword' ? 'newPassword' : 'credentials';

  async function submitCredentials(e) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    if (isCognito && !password) {
      setError('Password is required.');
      return;
    }
    try {
      const res = await login({ email: email.trim(), password, name: name.trim() || undefined });
      if (res?.mfaRequired || res?.newPasswordRequired) return; // challenge screen takes over
      navigate(returnTo, { replace: true });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err?.message || 'Sign in failed';
      setError(msg);
      toast.error(msg);
    }
  }

  async function submitMfa(e) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6,8}$/.test(code.trim())) {
      setError('Enter the 6–8 digit code from your authenticator app.');
      return;
    }
    try {
      await verifyMfa(code.trim());
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err.message || 'MFA verification failed');
      toast.error(err.message || 'MFA verification failed');
    }
  }

  async function submitNewPassword(e) {
    e.preventDefault();
    setError(null);
    if (newPw.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPw !== newPw2) {
      setError('Passwords do not match.');
      return;
    }
    try {
      await completeNewPassword(newPw);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err.message || 'Password update failed');
      toast.error(err.message || 'Password update failed');
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
            {meta?.appName || env.appName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Verified chain of custody for digital evidence
          </p>
        </div>

        <div
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm animate-fade-in-up"
          style={{ animationDelay: '0.09s' }}
        >
          {screen === 'credentials' && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">
                  {isCognito ? 'Sign in' : 'Dev sign in'}
                </h2>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {isCognito ? 'Cognito' : 'dev mode'}
                </span>
              </div>

              {!isCognito && (
                <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs leading-relaxed text-sky-800">
                  Local development auth: no password needed. We call{' '}
                  <code className="font-mono">POST /dev/token</code> with your email to mint a
                  short-lived JWT (backend reports this via <code className="font-mono">GET /meta</code>).
                </div>
              )}

              <form onSubmit={submitCredentials} className="space-y-4">
                <Field label="Email" htmlFor="login-email" required>
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </Field>

                {isCognito ? (
                  <Field label="Password" htmlFor="login-password" required>
                    <Input
                      id="login-password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </Field>
                ) : (
                  <Field
                    label="Display name"
                    htmlFor="login-name"
                    hint="Optional — used for the dev user profile."
                  >
                    <Input
                      id="login-name"
                      placeholder="Ada Lovelace"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                )}

                {error && (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <Button type="submit" className="w-full" loading={busy}>
                  {isCognito ? 'Sign in' : 'Create dev session'}
                </Button>
              </form>

              {isCognito ? (
                <p className="mt-4 text-center text-sm text-slate-500">
                  No account?{' '}
                  <Link to="/signup" className="font-medium text-indigo-600 hover:underline">
                    Create one
                  </Link>
                </p>
              ) : (
                <p className="mt-4 text-center text-sm text-slate-500">
                  Cognito expected instead?{' '}
                  <Link to="/signup" className="font-medium text-indigo-600 hover:underline">
                    See signup
                  </Link>
                </p>
              )}
            </>
          )}

          {screen === 'mfa' && (
            <>
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <KeyRound size={18} />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Two-factor code</h2>
                  <p className="text-xs text-slate-500">
                    Enter the code from your authenticator app
                  </p>
                </div>
              </div>
              <form onSubmit={submitMfa} className="space-y-4">
                <Field label="Authentication code" htmlFor="mfa-code" required>
                  <Input
                    id="mfa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    maxLength={8}
                    className="text-center font-mono text-lg tracking-[0.4em]"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    required
                    autoFocus
                  />
                </Field>
                {error && (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                <Button type="submit" className="w-full" loading={busy}>
                  Verify code
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    cancelChallenge();
                    setCode('');
                  }}
                  className="w-full text-center text-sm text-slate-500 hover:text-slate-700"
                >
                  Back to sign in
                </button>
              </form>
            </>
          )}

          {screen === 'newPassword' && (
            <>
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                  <Lock size={18} />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Set a new password</h2>
                  <p className="text-xs text-slate-500">
                    Your temporary password must be replaced on first sign-in.
                  </p>
                </div>
              </div>
              <form onSubmit={submitNewPassword} className="space-y-4">
                <Field label="New password" htmlFor="new-pw" required>
                  <Input
                    id="new-pw"
                    type="password"
                    autoComplete="new-password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Confirm new password" htmlFor="new-pw2" required>
                  <Input
                    id="new-pw2"
                    type="password"
                    autoComplete="new-password"
                    value={newPw2}
                    onChange={(e) => setNewPw2(e.target.value)}
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
                  Update password
                </Button>
              </form>
            </>
          )}
        </div>

        {!isCognito && authMode === 'dev' && cognitoConfigured && (
          <p className="mt-4 text-center text-xs text-slate-400">
            Backend reports dev auth mode; Cognito env vars are set but unused.
          </p>
        )}
        <p className="mt-4 text-center text-xs text-slate-400">
          API: {env.apiBaseUrl}
        </p>
      </div>
    </div>
  );
}
