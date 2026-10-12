import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.jsx';
import ProtectedRoute from './auth/ProtectedRoute.jsx';
import { ToastProvider } from './components/Toast.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Confirm from './pages/Confirm.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Cases from './pages/Cases.jsx';
import CaseDetail from './pages/CaseDetail.jsx';
import Capture from './pages/Capture.jsx';
import EvidenceDetail from './pages/EvidenceDetail.jsx';
import Packages from './pages/Packages.jsx';
import Pricing from './pages/Pricing.jsx';
import Settings from './pages/Settings.jsx';
import Verify from './pages/Verify.jsx';
import NotFound from './pages/NotFound.jsx';

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          {/* Unauthenticated */}
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/confirm" element={<Confirm />} />

          {/* Public verification portal — must work standalone, no login */}
          <Route path="/verify" element={<Verify />} />
          <Route path="/verify/:token" element={<Verify />} />

          {/* Authenticated app shell */}
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/cases" element={<Cases />} />
            <Route path="/cases/:id" element={<CaseDetail />} />
            <Route path="/capture" element={<Capture />} />
            <Route path="/evidence/:id" element={<EvidenceDetail />} />
            <Route path="/packages" element={<Packages />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/settings" element={<Settings />} />
          </Route>

          <Route path="/404" element={<NotFound />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
