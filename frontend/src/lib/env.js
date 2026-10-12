// Shared environment access with safe defaults.
export const env = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000').replace(
    /\/+$/,
    ''
  ),
  publicBaseUrl: (
    import.meta.env.VITE_PUBLIC_BASE_URL ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173')
  ).replace(/\/+$/, ''),
  authMode: import.meta.env.VITE_AUTH_MODE || 'dev',
  cognitoUserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
  appName: 'ProofTrail',
};

export const cognitoConfigured = Boolean(env.cognitoUserPoolId && env.cognitoClientId);

/** Verification URL for a share/package token: {PUBLIC_BASE_URL}/verify/{token} */
export function verificationUrl(token) {
  return `${env.publicBaseUrl}/verify/${token}`;
}

/** Pull a share token out of a pasted verification link (or return it unchanged). */
export function tokenFromVerificationInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const m = raw.match(/\/verify\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return raw;
}
