import { Link } from 'react-router-dom';
import { Compass, ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui.jsx';
import PublicLayout from '../components/PublicLayout.jsx';

export default function NotFound() {
  return (
    <PublicLayout subtitle="Page not found">
      <div className="mx-auto max-w-md py-16 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <Compass size={28} />
        </span>
        <h1 className="mt-5 text-2xl font-bold text-slate-900">404 — lost the trail</h1>
        <p className="mt-2 text-sm text-slate-500">
          This page doesn&apos;t exist. If you followed a verification link, make sure it includes
          the full <code className="font-mono">/verify/&lt;token&gt;</code> path.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link to="/">
            <Button>
              <ShieldCheck size={16} /> Dashboard
            </Button>
          </Link>
          <Link to="/verify">
            <Button variant="secondary">Verify a link</Button>
          </Link>
        </div>
      </div>
    </PublicLayout>
  );
}
