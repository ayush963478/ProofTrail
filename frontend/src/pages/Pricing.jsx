import { useMemo, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import { Button, PageSpinner } from '../components/ui.jsx';
import { capitalize, planLabel } from '../lib/format.js';

// Blueprint §9 tier features — used when GET /meta doesn't carry `features`.
const FALLBACK_FEATURES = {
  free: [
    '1 case',
    '25 sealed evidence items / month',
    'Client-side SHA-256 + server re-hash',
    'Public verification portal',
    'Browser-side independent checks',
    'Community support',
  ],
  personal: [
    '10 cases',
    '250 sealed evidence items / month',
    'RFC 3161 trusted timestamps',
    'Expiring & revocable share links',
    'Evidence packages (ZIP + report.pdf)',
    'Forensic indicator checks',
    'Email support',
  ],
  pro: [
    'Unlimited cases',
    '5,000 sealed evidence items / month',
    'Everything in Personal',
    'Hash-chained ledger + Merkle anchoring',
    'Package verification links with download',
    'Access audit log (ip-hash only)',
    'API access',
    'Priority support',
  ],
  enterprise: [
    'Unlimited everything',
    'Everything in Pro',
    'KMS-backed signing keys & rotation',
    'SSO / SAML',
    'Retention locks & legal hold',
    'Custom anchor publication',
    'Dedicated support & SLA',
  ],
};

const ORDER = ['free', 'personal', 'pro', 'enterprise'];

const PRICES = {
  free: '$0',
  personal: '$19',
  pro: '$59',
  enterprise: 'Custom',
};

function tierKey(tier, idx) {
  const raw =
    (typeof tier === 'string' ? tier : tier?.id || tier?.key || tier?.name || '') || '';
  const lower = String(raw).toLowerCase();
  const hit = ORDER.find((k) => lower.includes(k));
  return hit || ORDER[idx] || lower;
}

export default function Pricing() {
  const { meta, user, updateUser, ready } = useAuth();
  const toast = useToast();
  const [busyKey, setBusyKey] = useState(null);

  const tiers = useMemo(() => {
    const raw = Array.isArray(meta?.tiers) && meta.tiers.length ? meta.tiers : ORDER;
    return raw.slice(0, 4).map((t, i) => {
      const obj = typeof t === 'string' ? { name: t } : t || {};
      const key = tierKey(obj, i);
      const name = obj.name || obj.title || planLabel(key);
      const features =
        Array.isArray(obj.features) && obj.features.length
          ? obj.features
          : FALLBACK_FEATURES[key] || [];
      return {
        key,
        name,
        price: obj.price ?? obj.monthlyPrice ?? PRICES[key] ?? 'Custom',
        period: obj.period ?? obj.billing ?? (String(obj.price ?? '').includes('/') ? '' : '/mo'),
        description: obj.description || obj.blurb || null,
        features,
      };
    });
  }, [meta]);

  const currentPlan = user?.plan || 'free';

  async function choose(key) {
    if (key === currentPlan) return;
    setBusyKey(key);
    try {
      await updateUser({ plan: key });
      toast.success(`Plan updated to ${planLabel(key)}`);
    } catch (e) {
      toast.error(e.message || 'Plan update failed');
    } finally {
      setBusyKey(null);
    }
  }

  if (!ready) return <PageSpinner />;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">
          Simple pricing for defensible evidence
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-500">
          Every plan seals evidence with hashes, trusted timestamps and signatures. Higher tiers
          add anchoring, packaging and organizational controls.
        </p>
        <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
          <Sparkles size={13} /> Your plan: {planLabel(currentPlan)}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        {tiers.map((tier) => {
          const isCurrent = tier.key === currentPlan;
          const isPopular = tier.key === 'pro';
          return (
            <div
              key={tier.key}
              className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm transition ${
                isCurrent
                  ? 'border-indigo-400 ring-2 ring-indigo-200'
                  : isPopular
                    ? 'border-indigo-200 shadow'
                    : 'border-slate-200'
              }`}
            >
              {isCurrent && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-1 text-[11px] font-bold text-white">
                  Current plan
                </span>
              )}
              {!isCurrent && isPopular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-bold text-white">
                  Most popular
                </span>
              )}

              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                {tier.name}
              </h3>
              <p className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight text-slate-900">
                  {tier.price}
                </span>
                <span className="text-sm text-slate-400">{tier.period}</span>
              </p>
              {tier.description && (
                <p className="mt-1 text-xs text-slate-500">{tier.description}</p>
              )}

              <ul className="mt-5 flex-1 space-y-2.5">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-slate-600">
                    <Check size={15} className="mt-0.5 shrink-0 text-emerald-500" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <Button
                className="mt-6 w-full"
                variant={isCurrent ? 'secondary' : isPopular ? 'primary' : 'secondary'}
                disabled={isCurrent || busyKey !== null}
                loading={busyKey === tier.key}
                onClick={() => choose(tier.key)}
              >
                {isCurrent ? 'Current plan' : `Switch to ${capitalize(tier.key)}`}
              </Button>
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-slate-400">
        Plan changes apply immediately via <code className="font-mono">PATCH /me</code>. In the
        local/dev profile there is no billing integration — tiers come from{' '}
        <code className="font-mono">GET /meta</code>.
      </p>
    </div>
  );
}
