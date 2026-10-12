import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider.jsx';
import Layout from '../components/Layout.jsx';
import { PageSpinner } from '../components/ui.jsx';

/**
 * Guards the authenticated app shell. Waits for session restoration, then
 * redirects unauthenticated visitors to /login while preserving the return path.
 */
export default function ProtectedRoute() {
  const { ready, token } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <PageSpinner label="Restoring session…" />
      </div>
    );
  }

  if (!token) {
    const ret = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?return=${ret}`} replace />;
  }

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}
