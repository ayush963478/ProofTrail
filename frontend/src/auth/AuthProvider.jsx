import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import {
  ApiError,
  devApi,
  meApi,
  metaApi,
  setTokenProvider,
  setUnauthorizedHandler,
} from '../api/client.js';
import { cognitoConfigured, env } from '../lib/env.js';

const AuthContext = createContext(null);

const LS = {
  token: 'pt.token',
  tokenKind: 'pt.tokenKind',
  user: 'pt.user',
  email: 'pt.email',
  authMode: 'pt.authMode',
};

function lsGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function readJson(key) {
  try {
    const raw = lsGet(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Synchronous storage adapter for amazon-cognito-identity-js, backed by localStorage. */
function makeCognitoStorage() {
  const prefix = 'pt.cognito.';
  return {
    getItem(k) {
      try {
        return window.localStorage.getItem(prefix + k);
      } catch {
        return null;
      }
    },
    setItem(k, v) {
      try {
        window.localStorage.setItem(prefix + k, v);
      } catch {
        /* ignore */
      }
    },
    removeItem(k) {
      try {
        window.localStorage.removeItem(prefix + k);
      } catch {
        /* ignore */
      }
    },
  };
}

function clearCognitoStorage() {
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('pt.cognito.')) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

function getPool() {
  if (!cognitoConfigured) {
    throw new ApiError(
      'Cognito is not configured. Set VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID in frontend/.env',
      { code: 'config_error', status: 0 }
    );
  }
  return new CognitoUserPool({
    UserPoolId: env.cognitoUserPoolId,
    ClientId: env.cognitoClientId,
    Storage: makeCognitoStorage(),
  });
}

function mapCognitoError(err, fallback = 'Authentication failed') {
  const code = err?.code || 'unauthorized';
  return new ApiError(err?.message || fallback, { code, status: 401 });
}

/**
 * AuthProvider — single source of truth for identity.
 *
 * authMode comes from GET /meta (preferred) with VITE_AUTH_MODE as fallback:
 *  - "cognito": amazon-cognito-identity-js against the User Pool incl.
 *    SOFTWARE_TOKEN_MFA (TOTP) + NEW_PASSWORD_REQUIRED challenges.
 *  - "dev":     POST /dev/token {email, name} -> {token, expiresIn, user}.
 *
 * The JWT (cognito access/id token or dev token) is exposed to the API client
 * via setTokenProvider and sent as `Authorization: Bearer <token>`.
 */
export function AuthProvider({ children }) {
  const [meta, setMeta] = useState(null);
  const [authMode, setAuthMode] = useState(() => lsGet(LS.authMode) || env.authMode || 'dev');
  const [user, setUser] = useState(() => readJson(LS.user));
  const [token, setTokenState] = useState(() => lsGet(LS.token));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  // challenge: null | {type:'mfa', challengeName, email} | {type:'newPassword', requiredAttributes, email}
  const [challenge, setChallenge] = useState(null);

  const tokenRef = useRef(lsGet(LS.token));
  const cognitoUserRef = useRef(null);
  const initRef = useRef(false);

  const applyToken = useCallback((t) => {
    tokenRef.current = t;
    setTokenState(t);
    lsSet(LS.token, t);
  }, []);

  const applyUser = useCallback((u) => {
    setUser(u);
    lsSet(LS.user, u ? JSON.stringify(u) : null);
  }, []);

  const clearSession = useCallback(() => {
    applyToken(null);
    applyUser(null);
    setChallenge(null);
    lsSet(LS.email, null);
    clearCognitoStorage();
  }, [applyToken, applyUser]);

  // --- API client hooks (registered first so restore can use them) ---------
  useEffect(() => {
    setTokenProvider(() => tokenRef.current);
    setUnauthorizedHandler(() => {
      // 401 on an authenticated call -> drop the session; ProtectedRoute
      // redirects to /login preserving the return path.
      applyToken(null);
      applyUser(null);
      setChallenge(null);
      lsSet(LS.email, null);
      clearCognitoStorage();
    });
    return () => {
      setTokenProvider(null);
      setUnauthorizedHandler(null);
    };
  }, [applyToken, applyUser]);

  /** Persist a cognito session. Tries the preferred JWT kind first, and if the
   *  backend rejects it with 401, automatically retries with the other one
   *  (API.md says "access token"; the ID token carries email/name claims).
   *  The working kind is remembered for future sessions. */
  const finishCognito = useCallback(
    async (cognitoUser, session) => {
      const idToken = typeof session.getIdToken === 'function' ? session.getIdToken().getJwtToken() : null;
      const accessToken =
        typeof session.getAccessToken === 'function' ? session.getAccessToken().getJwtToken() : null;
      const preferred = lsGet(LS.tokenKind);
      const candidates = [];
      if (preferred === 'id') {
        if (idToken) candidates.push({ kind: 'id', value: idToken });
        if (accessToken) candidates.push({ kind: 'access', value: accessToken });
      } else {
        if (accessToken) candidates.push({ kind: 'access', value: accessToken });
        if (idToken) candidates.push({ kind: 'id', value: idToken });
      }
      if (!candidates.length) {
        throw new ApiError('Cognito session did not contain a JWT', {
          code: 'unauthorized',
          status: 401,
        });
      }

      let last401 = null;
      for (let i = 0; i < candidates.length; i += 1) {
        applyToken(candidates[i].value);
        try {
          const me = await meApi.get();
          lsSet(LS.tokenKind, candidates[i].kind);
          applyUser(me);
          setChallenge(null);
          return me;
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            last401 = e;
            continue;
          }
          // Backend unreachable / non-auth failure: keep the token, fall back
          // to a cached or minimal profile so the app remains usable.
          const fallback = readJson(LS.user) || {
            email: lsGet(LS.email) || '',
            name: '',
            plan: 'free',
            mfaEnabled: false,
          };
          applyUser(fallback);
          setChallenge(null);
          return fallback;
        }
      }
      applyToken(null);
      throw (
        last401 ||
        new ApiError('Unauthorized', { code: 'unauthorized', status: 401 })
      );
    },
    [applyToken, applyUser]
  );

  // --- bootstrap: GET /meta then restore a stored session ------------------
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      let mode = lsGet(LS.authMode) || env.authMode || 'dev';
      try {
        const m = await metaApi.get();
        setMeta(m);
        if (m && m.authMode) {
          mode = m.authMode;
          lsSet(LS.authMode, mode);
          setAuthMode(mode);
        }
      } catch {
        // Backend offline — fall back to env VITE_AUTH_MODE.
      }

      try {
        if (mode === 'cognito') {
          const email = lsGet(LS.email);
          if (email && cognitoConfigured) {
            const cu = new CognitoUser({
              Username: email,
              Pool: getPool(),
              Storage: makeCognitoStorage(),
            });
            const session = await new Promise((resolve, reject) => {
              cu.getSession((err, sess) => {
                if (err || !sess || (typeof sess.isValid === 'function' && !sess.isValid())) {
                  reject(err || new Error('Invalid session'));
                } else {
                  resolve(sess);
                }
              });
            });
            cognitoUserRef.current = cu;
            await finishCognito(cu, session);
          }
        } else if (lsGet(LS.token)) {
          applyToken(lsGet(LS.token));
          try {
            const me = await meApi.get();
            applyUser(me);
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) clearSession();
          }
        }
      } catch {
        clearSession();
      } finally {
        setReady(true);
      }
    })();
  }, [applyToken, applyUser, clearSession, finishCognito]);

  // --- actions -------------------------------------------------------------

  const loginCognito = useCallback(
    ({ email, password }) =>
      new Promise((resolve, reject) => {
        let cu;
        try {
          cu = new CognitoUser({ Username: email, Pool: getPool(), Storage: makeCognitoStorage() });
        } catch (e) {
          reject(e);
          return;
        }
        cognitoUserRef.current = cu;
        const details = new AuthenticationDetails({ Username: email, Password: password });
        cu.authenticateUser(details, {
          onSuccess: (session) => {
            finishCognito(cu, session).then(resolve, reject);
          },
          onFailure: (err) => reject(mapCognitoError(err, 'Sign in failed')),
          totpRequired: (challengeName) => {
            setChallenge({ type: 'mfa', challengeName, email });
            resolve({ mfaRequired: true, challengeName });
          },
          mfaRequired: (challengeName) => {
            setChallenge({ type: 'mfa', challengeName, email });
            resolve({ mfaRequired: true, challengeName });
          },
          newPasswordRequired: (userAttributes, requiredAttributes) => {
            setChallenge({
              type: 'newPassword',
              requiredAttributes: requiredAttributes || [],
              email,
              userAttributes: userAttributes || {},
            });
            resolve({ newPasswordRequired: true });
          },
        });
      }),
    [finishCognito]
  );

  const loginDev = useCallback(
    async ({ email, name }) => {
      const res = await devApi.getToken({ email, name: name || undefined });
      applyToken(res.token);
      lsSet(LS.email, email);
      applyUser(res.user || { email, name: name || '', plan: 'free', mfaEnabled: false });
      setChallenge(null);
      try {
        const me = await meApi.get();
        applyUser(me);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          clearSession();
          throw e;
        }
      }
      return res.user;
    },
    [applyToken, applyUser, clearSession]
  );

  const login = useCallback(
    async (credentials) => {
      if (authMode === 'cognito') return loginCognito(credentials);
      return loginDev(credentials);
    },
    [authMode, loginCognito, loginDev]
  );

  const verifyMfa = useCallback(
    async (code) => {
      const cu = cognitoUserRef.current;
      if (!cu || !challenge || challenge.type !== 'mfa') {
        throw new ApiError('No MFA challenge is in progress', { code: 'conflict', status: 409 });
      }
      return new Promise((resolve, reject) => {
        cu.sendMFACode(
          code,
          {
            onSuccess: (session) => finishCognito(cu, session).then(resolve, reject),
            onFailure: (err) => reject(mapCognitoError(err, 'MFA verification failed')),
          },
          challenge.challengeName || 'SOFTWARE_TOKEN_MFA'
        );
      });
    },
    [challenge, finishCognito]
  );

  const completeNewPassword = useCallback(
    async (newPassword) => {
      const cu = cognitoUserRef.current;
      if (!cu || !challenge || challenge.type !== 'newPassword') {
        throw new ApiError('No password challenge is in progress', {
          code: 'conflict',
          status: 409,
        });
      }
      const attrs = {};
      (challenge.requiredAttributes || []).forEach((name) => {
        if (name === 'email') attrs.email = challenge.email;
        else if (name === 'name') attrs.name = challenge.email;
      });
      return new Promise((resolve, reject) => {
        cu.completeNewPasswordChallenge(newPassword, attrs, {
          onSuccess: (session) => finishCognito(cu, session).then(resolve, reject),
          onFailure: (err) => reject(mapCognitoError(err, 'Password update failed')),
        });
      });
    },
    [challenge, finishCognito]
  );

  const cancelChallenge = useCallback(() => {
    cognitoUserRef.current = null;
    setChallenge(null);
  }, []);

  const signup = useCallback(async ({ email, password, name }) => {
    const pool = getPool();
    const attributes = [{ Name: 'email', Value: email }];
    if (name) attributes.push({ Name: 'name', Value: name });
    return new Promise((resolve, reject) => {
      pool.signUp(email, password, attributes, null, (err, result) => {
        if (err) reject(mapCognitoError(err, 'Sign up failed'));
        else resolve(result);
      });
    });
  }, []);

  const confirmSignup = useCallback(async ({ email, code }) => {
    const cu = new CognitoUser({ Username: email, Pool: getPool(), Storage: makeCognitoStorage() });
    return new Promise((resolve, reject) => {
      cu.confirmRegistration(code, true, (err, result) => {
        if (err) reject(mapCognitoError(err, 'Confirmation failed'));
        else resolve(result);
      });
    });
  }, []);

  const logout = useCallback(() => {
    try {
      if ((lsGet(LS.authMode) || authMode) === 'cognito') {
        const email = lsGet(LS.email);
        if (email && cognitoConfigured) {
          const cu = new CognitoUser({
            Username: email,
            Pool: getPool(),
            Storage: makeCognitoStorage(),
          });
          cu.signOut();
        }
      }
    } catch {
      /* ignore */
    }
    clearSession();
  }, [authMode, clearSession]);

  const refreshUser = useCallback(async () => {
    const me = await meApi.get();
    applyUser(me);
    return me;
  }, [applyUser]);

  const updateUser = useCallback(
    async (patch) => {
      const me = await meApi.update(patch);
      applyUser(me);
      return me;
    },
    [applyUser]
  );

  const value = useMemo(
    () => ({
      meta,
      authMode,
      user,
      token,
      ready,
      busy,
      challenge,
      cognitoConfigured,
      login,
      logout,
      signup,
      confirmSignup,
      verifyMfa,
      completeNewPassword,
      cancelChallenge,
      refreshUser,
      updateUser,
      setBusy,
    }),
    [
      meta,
      authMode,
      user,
      token,
      ready,
      busy,
      challenge,
      login,
      logout,
      signup,
      confirmSignup,
      verifyMfa,
      completeNewPassword,
      cancelChallenge,
      refreshUser,
      updateUser,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
