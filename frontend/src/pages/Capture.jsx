import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Camera as CameraIcon,
  Cloud,
  FileUp,
  Globe,
  MapPin,
  Upload,
  X,
} from 'lucide-react';
import { ApiError, capturesApi, casesApi, evidenceApi, pollUntil } from '../api/client.js';
import { useToast } from '../components/Toast.jsx';
import {
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  PageSpinner,
  Select,
} from '../components/ui.jsx';
import PipelineStages from '../components/PipelineStages.jsx';
import CopyButton from '../components/CopyButton.jsx';
import { Modal } from '../components/Modal.jsx';
import { sha256OfFile } from '../lib/hash.js';
import { formatBytes, shortHash } from '../lib/format.js';

const EVIDENCE_TYPES = [
  { value: 'photo', label: 'Photo' },
  { value: 'page', label: 'Web page' },
  { value: 'chat', label: 'Chat / message' },
  { value: 'file', label: 'Document / file' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'text', label: 'Text note' },
];

function guessType(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('image/')) return 'photo';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('text/')) return 'text';
  if (t === 'application/pdf') return 'file';
  return 'file';
}

function normalizeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

export default function Capture() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [tab, setTab] = useState('file');
  const [cases, setCases] = useState(null);
  const [caseId, setCaseId] = useState(params.get('caseId') || '');

  // --- file upload state ---
  const [file, setFile] = useState(null);
  const [hash, setHash] = useState(null);
  const [hashing, setHashing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [form, setForm] = useState({
    type: 'file',
    device: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    appVersion: 'web-1.0.0',
    url: '',
  });
  const [gps, setGps] = useState(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsPromptOpen, setGpsPromptOpen] = useState(false);
  const [gpsPane, setGpsPane] = useState('consent'); // 'consent' | 'manual'
  const [gpsSource, setGpsSource] = useState(null); // 'device' | 'manual' (display only)
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | uploading | sealing | sealed | failed
  const [stage, setStage] = useState(0);
  const [sealError, setSealError] = useState(null);
  const [sealedId, setSealedId] = useState(null);

  // --- cloud capture state ---
  const [cloudUrl, setCloudUrl] = useState('');
  const [cloudJob, setCloudJob] = useState(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState(null);

  const abortRef = useRef(null);
  const hashSeqRef = useRef(0);

  // Abort all in-flight work on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    let alive = true;
    casesApi
      .list()
      .then((list) => {
        if (alive) setCases(list);
      })
      .catch(() => {
        if (alive) setCases([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Keep ?caseId= in sync so the flow survives reloads.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (caseId) next.set('caseId', caseId);
    else next.delete('caseId');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const pickFile = useCallback(
    async (chosen) => {
      if (!chosen) return;
      const seq = hashSeqRef.current + 1;
      hashSeqRef.current = seq;
      setFile(chosen);
      setHash(null);
      setHashing(true);
      setForm((f) => ({ ...f, type: guessType(chosen) }));
      try {
        const hex = await sha256OfFile(chosen);
        if (hashSeqRef.current === seq) setHash(hex);
      } catch (e) {
        if (hashSeqRef.current === seq) {
          setHash(null);
          toast.error(`Could not hash file: ${e.message}`);
        }
      } finally {
        if (hashSeqRef.current === seq) setHashing(false);
      }
    },
    [toast]
  );

  /** Open the location popup. If the browser already blocks geolocation for
   *  this origin (embedded browsers often do — there is no UI to re-allow it),
   *  skip straight to the manual-coordinate pane instead of dead-ending. */
  async function openGpsPrompt() {
    setManualLat('');
    setManualLng('');
    let state = 'unknown';
    try {
      if (navigator.permissions?.query) {
        state = (await navigator.permissions.query({ name: 'geolocation' })).state;
      }
    } catch {
      /* Permissions API unavailable — assume a prompt can still show */
    }
    setGpsPane(state === 'denied' ? 'manual' : 'consent');
    setGpsPromptOpen(true);
  }

  function captureGps() {
    if (!navigator.geolocation) {
      setGpsPane('manual');
      toast.warning('This browser has no device GPS — enter the coordinates manually below.');
      return;
    }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({
          lat: Math.round(pos.coords.latitude * 1e6) / 1e6,
          lng: Math.round(pos.coords.longitude * 1e6) / 1e6,
        });
        setGpsSource('device');
        setGpsBusy(false);
        setGpsPromptOpen(false);
        toast.success('Location attached from your device (optional metadata only)');
      },
      (err) => {
        setGpsBusy(false);
        setGpsPane('manual');
        toast.warning(
          err && err.code === 1
            ? 'Device location is blocked in this browser — enter the coordinates manually below.'
            : `Device location unavailable (${err && err.message}) — enter the coordinates manually below.`
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  /** Manual fallback: attach coordinates typed by the user (same gps contract
   *  shape the backend validates: { lat, lng }). Display flags it as manual. */
  function attachManualGps() {
    const lat = Number(manualLat);
    const lng = Number(manualLng);
    if (manualLat.trim() === '' || manualLng.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      toast.warning('Enter latitude and longitude as numbers');
      return;
    }
    if (lat < -90 || lat > 90) {
      toast.warning('Latitude must be between -90 and 90');
      return;
    }
    if (lng < -180 || lng > 180) {
      toast.warning('Longitude must be between -180 and 180');
      return;
    }
    setGps({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 });
    setGpsSource('manual');
    setGpsPromptOpen(false);
    toast.success('Location attached (coordinates entered manually)');
  }

  function reset() {
    setFile(null);
    setHash(null);
    setHashing(false);
    setPhase('idle');
    setStage(0);
    setSealError(null);
    setSealedId(null);
    setGps(null);
    setGpsSource(null);
    setGpsPane('consent');
  }

  async function submitUpload(e) {
    e.preventDefault();
    if (!file) {
      toast.warning('Choose a file first');
      return;
    }
    if (!hash || hashing) {
      toast.warning('Waiting for the SHA-256 hash to finish…');
      return;
    }
    setSealError(null);
    setSealedId(null);
    setPhase('uploading');
    setStage(0);

    const controller = new AbortController();
    abortRef.current = controller;

    let created = null;
    try {
      const capture = {
        device: form.device || null,
        appVersion: form.appVersion || null,
        url: form.type === 'page' ? form.url || null : null,
        gps: gps || null,
        clientTime: new Date().toISOString(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      };

      created = await evidenceApi.create({
        caseId: caseId || undefined,
        type: form.type,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        clientSha256: hash,
        captureMethod: 'upload',
        capture,
      });

      await evidenceApi.upload(created.uploadUrl, file, created.uploadHeaders, {
        signal: controller.signal,
        contentType: file.type || 'application/octet-stream',
      });

      setPhase('sealing');
      setStage(1);

      try {
        await evidenceApi.seal(created.id);
      } catch (err) {
        // Tolerate a "already uploaded / conflict" race — polling still applies.
        if (!(err instanceof ApiError) || (err.status !== 409 && err.code !== 'conflict')) {
          throw err;
        }
      }

      const final = await pollUntil(() => evidenceApi.get(created.id), {
        interval: 1500,
        maxInterval: 3000,
        signal: controller.signal,
        isDone: (ev) => ev.status === 'sealed' || ev.status === 'failed',
        onTick: (ev) => {
          if (ev.status === 'sealing') setStage((s) => Math.min(4, s + 1));
        },
      });

      if (final.status === 'sealed') {
        setStage(5);
        setPhase('sealed');
        setSealedId(final.id);
        toast.success('Evidence sealed — proof issued');
      } else {
        setPhase('failed');
        setSealError(final.sealError || 'Sealing failed on the server.');
        toast.error(final.sealError || 'Sealing failed');
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setPhase('failed');
      const msg =
        err instanceof ApiError
          ? `${err.message}${err.code ? ` (${err.code})` : ''}`
          : err?.message || 'Upload failed';
      setSealError(msg);
      toast.error(msg);
    }
  }

  async function submitCloud(e) {
    e.preventDefault();
    const target = normalizeUrl(cloudUrl);
    if (!target) {
      toast.warning('Enter a URL to capture');
      return;
    }
    setCloudBusy(true);
    setCloudError(null);
    setCloudJob(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const started = await capturesApi.create({
        url: target,
        caseId: caseId || undefined,
      });
      const captureId = started.captureId || started.id;
      setCloudJob({ id: captureId, url: target, status: started.status || 'queued' });

      const done = await pollUntil(() => capturesApi.get(captureId), {
        interval: 1500,
        maxInterval: 4000,
        timeout: 300000,
        signal: controller.signal,
        isDone: (j) => j.status === 'done' || j.status === 'failed',
        onTick: (j) => setCloudJob(j),
      });

      if (done.status === 'done' && done.evidenceId) {
        toast.success('Cloud capture complete — sealed server-side');
        navigate(`/evidence/${done.evidenceId}`);
      } else {
        setCloudError(done.error || 'The capture job failed.');
        toast.error(done.error || 'Capture failed');
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (err instanceof ApiError && (err.status === 501 || err.code === 'not_implemented')) {
        setCloudError(err.message);
        toast.error(err.message);
      } else {
        const msg = err?.message || 'Cloud capture failed';
        setCloudError(msg);
        toast.error(msg);
      }
    } finally {
      setCloudBusy(false);
    }
  }

  const busy = phase === 'uploading' || phase === 'sealing';

  if (!cases) return <PageSpinner label="Preparing capture workspace…" />;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Capture evidence</h2>
        <p className="text-sm text-slate-500">
          SHA-256 is computed <strong>in your browser</strong> before upload — the server never
          trusts your claim alone and recomputes it.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1">
        <button
          type="button"
          onClick={() => setTab('file')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'file' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          <FileUp size={16} /> File upload
        </button>
        <button
          type="button"
          onClick={() => setTab('url')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'url' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          <Cloud size={16} /> Cloud URL capture
        </button>
      </div>

      {tab === 'file' && (
        <form onSubmit={submitUpload} className="space-y-6">
          {/* Case select */}
          <Card className="p-4">
            <Field
              label="Case"
              htmlFor="capture-case"
              hint="Evidence can live outside a case too, but grouping keeps chains tidy."
            >
              <Select
                id="capture-case"
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
                disabled={busy}
              >
                <option value="">No case (unassigned)</option>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>

          {/* Dropzone */}
          {phase === 'idle' || phase === 'failed' ? (
            <Card
              className={`border-2 border-dashed p-6 transition ${
                dragOver ? 'border-indigo-400 bg-indigo-50/50' : 'border-slate-300'
              }`}
            >
              <label
                className="group flex cursor-pointer flex-col items-center justify-center text-center"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) pickFile(dropped);
                }}
              >
                <input
                  type="file"
                  className="sr-only"
                  onChange={(e) => pickFile(e.target.files?.[0] || null)}
                />
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-500 transition group-hover:bg-indigo-100">
                  <Upload size={24} />
                </span>
                <span className="mt-3 text-sm font-semibold text-slate-800">
                  {file ? file.name : 'Drag & drop a file, or click to browse'}
                </span>
                <span className="mt-1 text-xs text-slate-500">
                  {file
                    ? `${formatBytes(file.size)} · ${file.type || 'unknown type'}`
                    : 'Photos, chats, documents, audio, video — anything with bytes worth proving.'}
                </span>
              </label>

              {/* Client hash display */}
              <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Client-computed SHA-256
                  </span>
                  {hash && <CopyButton value={hash} label="Copy hash" />}
                </div>
                {hashing ? (
                  <>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full w-1/2 rounded-full bg-indigo-500 animate-progress-slide" />
                    </div>
                    <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                      <CameraIcon size={13} className="animate-pulse" /> Hashing{' '}
                      {file?.name} with WebCrypto…
                    </p>
                  </>
                ) : hash ? (
                  <p className="mt-1 break-all font-mono text-xs text-slate-700">{hash}</p>
                ) : (
                  <p className="mt-1 text-xs text-slate-400">
                    No file yet — the hash appears here while/after hashing.
                  </p>
                )}
              </div>
              {file && !hashing && hash && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600">
                  <CheckCircle2 size={13} /> Hash ready — the server will recompute and compare
                  (422 <code className="font-mono">hash_mismatch</code> on disagreement).
                </p>
              )}
            </Card>
          ) : (
            /* In-flight / success panels */
            <Card className="p-6">
              {phase === 'sealed' ? (
                <div className="text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                    <CheckCircle2 size={28} />
                  </div>
                  <h3 className="mt-4 text-lg font-bold text-slate-900">Evidence sealed</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Timestamped, signed, ledger-appended and anchored. The original is now in the
                    write-once vault.
                  </p>
                  <div className="mt-4 flex flex-col items-center gap-2">
                    <code className="mono-hash max-w-full">{hash}</code>
                  </div>
                  <div className="mt-5 flex flex-wrap justify-center gap-3">
                    <Button onClick={() => navigate(`/evidence/${sealedId}`)}>
                      View evidence detail
                    </Button>
                    <Button variant="secondary" onClick={reset}>
                      Capture another
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-6 sm:grid-cols-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Seal pipeline</p>
                    <p className="mb-3 text-xs text-slate-500">
                      {phase === 'uploading'
                        ? 'Uploading raw bytes…'
                        : 'Server-side: verify → timestamp → sign → ledger → anchor'}
                    </p>
                    <PipelineStages stage={stage} failed={phase === 'failed'} />
                  </div>
                  <div className="space-y-3">
                    <div className="rounded-lg bg-slate-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Claim (client hash)
                      </p>
                      <p className="mt-1 break-all font-mono text-xs text-slate-700">{hash}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        {file?.name} · {formatBytes(file?.size)}
                      </p>
                    </div>
                    {phase === 'failed' && (
                      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
                        <p className="flex items-center gap-2 text-sm font-semibold text-rose-700">
                          <AlertTriangle size={15} /> Sealing failed
                        </p>
                        <p className="mt-1 break-words text-xs text-rose-600">{sealError}</p>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="mt-3"
                          onClick={reset}
                        >
                          Start over
                        </Button>
                      </div>
                    )}
                    {phase === 'sealing' && (
                      <p className="text-xs text-slate-500">
                        Polling <code className="font-mono">GET /evidence/…</code> every 1.5s until
                        sealed…
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        abortRef.current?.abort();
                        reset();
                      }}
                    >
                      <X size={14} /> Cancel
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Metadata form */}
          {phase !== 'sealed' && (
            <Card>
              <CardHeader title="Capture metadata" subtitle="Optional but strengthens provenance." />
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <Field label="Evidence type" htmlFor="ev-type">
                  <Select
                    id="ev-type"
                    value={form.type}
                    onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                    disabled={busy}
                  >
                    {EVIDENCE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="App version" htmlFor="ev-app" hint="Your capture app / schema version.">
                  <Input
                    id="ev-app"
                    value={form.appVersion}
                    onChange={(e) => setForm((f) => ({ ...f, appVersion: e.target.value }))}
                    disabled={busy}
                  />
                </Field>

                <Field
                  label="Device"
                  htmlFor="ev-device"
                  hint="Prefilled from your user agent."
                  className="sm:col-span-2"
                >
                  <Input
                    id="ev-device"
                    value={form.device}
                    onChange={(e) => setForm((f) => ({ ...f, device: e.target.value }))}
                    disabled={busy}
                  />
                </Field>

                {form.type === 'page' && (
                  <Field
                    label="Page URL"
                    htmlFor="ev-url"
                    hint="Where this capture came from."
                    className="sm:col-span-2"
                  >
                    <Input
                      id="ev-url"
                      type="url"
                      placeholder="https://example.com/page"
                      value={form.url}
                      onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                      disabled={busy}
                    />
                  </Field>
                )}

                <div className="sm:col-span-2">
                  <p className="mb-1.5 text-sm font-medium text-slate-700">
                    Location (GPS){' '}
                    <span className="font-normal text-slate-400">— optional, consent-based</span>
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={openGpsPrompt}
                      loading={gpsBusy}
                      disabled={busy}
                    >
                      <MapPin size={14} /> {gps ? 'Update location' : 'Attach my location'}
                    </Button>
                    {gps && (
                      <>
                        <code className="mono-hash">
                          {gps.lat}, {gps.lng}
                        </code>
                        {gpsSource === 'manual' && (
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                            entered manually
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setGps(null);
                            setGpsSource(null);
                          }}
                          className="text-xs text-slate-400 underline hover:text-slate-600"
                        >
                          remove
                        </button>
                      </>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs text-slate-400">
                    ProofTrail only records location after you allow the permission popup — or
                    coordinates you enter yourself. Never automatically.
                  </p>
                </div>
              </div>
            </Card>
          )}

          {phase === 'idle' || phase === 'failed' ? (
            <div className="flex justify-end">
              <Button type="submit" disabled={!file || !hash || hashing} loading={busy}>
                <Upload size={16} /> Upload & seal
              </Button>
            </div>
          ) : null}
        </form>
      )}

      {tab === 'url' && (
        <div className="space-y-6">
          <Card className="p-5">
            <p className="text-sm text-slate-600">
              Hand a URL to the cloud capture service (headless Chromium). The rendered page,
              screenshot and response headers are stored and sealed{' '}
              <strong>server-side</strong> as a trusted capture.
            </p>
            <form onSubmit={submitCloud} className="mt-4 space-y-4">
              <Field label="Page URL" htmlFor="cloud-url" required>
                <div className="flex gap-2">
                  <Input
                    id="cloud-url"
                    type="text"
                    placeholder="https://example.com/post"
                    value={cloudUrl}
                    onChange={(e) => setCloudUrl(e.target.value)}
                    disabled={cloudBusy}
                  />
                  <Button type="submit" loading={cloudBusy} className="shrink-0">
                    <Globe size={16} /> Capture
                  </Button>
                </div>
              </Field>
              <Field label="Case" htmlFor="cloud-case">
                <Select
                  id="cloud-case"
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                  disabled={cloudBusy}
                >
                  <option value="">No case (unassigned)</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              </Field>
            </form>
          </Card>

          {cloudError && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                <AlertTriangle size={16} /> Capture unavailable
              </p>
              <p className="mt-2 break-words text-sm leading-relaxed text-amber-700">{cloudError}</p>
              <p className="mt-2 text-xs text-amber-600">
                In local mode the backend needs the capture service:{' '}
                <code className="font-mono">cd capture-service &amp;&amp; npm install</code>, then
                retry. AWS mode runs it on Fargate.
              </p>
            </div>
          )}

          {cloudJob && !cloudError && (
            <Card className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{cloudJob.url}</p>
                  <p className="text-xs text-slate-500">Job: {cloudJob.id}</p>
                </div>
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                    cloudJob.status === 'done'
                      ? 'bg-emerald-50 text-emerald-700'
                      : cloudJob.status === 'failed'
                        ? 'bg-rose-50 text-rose-700'
                        : 'bg-amber-50 text-amber-700'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      cloudJob.status === 'done'
                        ? 'bg-emerald-500'
                        : cloudJob.status === 'failed'
                          ? 'bg-rose-500'
                          : 'animate-pulse bg-amber-500'
                    }`}
                  />
                  {cloudJob.status}
                </span>
              </div>
              <div className="mt-4 space-y-2">
                {['queued', 'running', 'done'].map((s) => {
                  const order = ['queued', 'running', 'done'];
                  const idx = order.indexOf(cloudJob.status === 'failed' ? 'running' : cloudJob.status);
                  const si = order.indexOf(s);
                  const done = si < idx || cloudJob.status === 'done';
                  const active = si === idx && cloudJob.status !== 'done' && cloudJob.status !== 'failed';
                  return (
                    <p key={s} className="flex items-center gap-2 text-sm">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          done ? 'bg-emerald-500' : active ? 'animate-pulse bg-amber-500' : 'bg-slate-300'
                        }`}
                      />
                      <span className={done || active ? 'text-slate-700' : 'text-slate-400'}>
                        {s === 'queued'
                          ? 'Queued — capture service assigned'
                          : s === 'running'
                            ? 'Running — headless Chromium rendering the page'
                            : 'Done — evidence sealed server-side'}
                      </span>
                    </p>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Polling <code className="font-mono">GET /captures/{cloudJob.id}</code> every 1.5s…
              </p>
            </Card>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
            <p className="font-medium text-slate-700">Why cloud capture is trustworthy</p>
            <p className="mt-1 text-xs leading-relaxed">
              The capture runs in isolated infrastructure — the browser never supplies a hash for
              it. The service stores the page bytes, computes hashes, and the backend seals the
              evidence in the same pipeline as uploads, flagged{' '}
              <code className="font-mono">captureMethod: &quot;cloud_url&quot;</code>.
            </p>
          </div>
        </div>
      )}

      <Modal
        open={gpsPromptOpen}
        title={gpsPane === 'manual' ? 'Add location' : 'Share your location?'}
        subtitle={
          gpsPane === 'manual'
            ? 'Device GPS is blocked in this browser — enter the coordinates yourself'
            : 'ProofTrail is asking permission to read this device’s GPS position'
        }
        onClose={() => setGpsPromptOpen(false)}
        footer={
          gpsPane === 'manual' ? (
            <>
              <Button variant="secondary" onClick={() => setGpsPane('consent')}>
                Back
              </Button>
              <Button variant="primary" onClick={attachManualGps}>
                <MapPin size={14} /> Attach coordinates
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setGpsPromptOpen(false)}>
                Not now
              </Button>
              <Button variant="primary" loading={gpsBusy} onClick={captureGps}>
                <MapPin size={14} /> Allow location
              </Button>
            </>
          )
        }
      >
        {gpsPane === 'manual' ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-relaxed text-amber-800">
              This browser blocks device location for websites (common in embedded browsers), so
              the GPS popup can never appear. In a regular browser, click the icon next to the
              address bar → <strong>Site settings → Location → Allow</strong>. Or take the
              coordinates from your phone (maps app shows them on long-press) and type them here.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Latitude" htmlFor="gps-lat" className="block">
                <Input
                  id="gps-lat"
                  inputMode="decimal"
                  placeholder="28.6139"
                  value={manualLat}
                  onChange={(e) => setManualLat(e.target.value)}
                />
              </Field>
              <Field label="Longitude" htmlFor="gps-lng" className="block">
                <Input
                  id="gps-lng"
                  inputMode="decimal"
                  placeholder="77.2090"
                  value={manualLng}
                  onChange={(e) => setManualLng(e.target.value)}
                />
              </Field>
            </div>
            <p className="text-xs text-slate-400">
              The values are validated (−90…90 / −180…180) and shown with an “entered manually”
              tag next to them — the sealed proof records exactly what you type.
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-sm leading-relaxed text-slate-600">
            <p>
              If you allow, your browser will ask for permission to read this device&apos;s GPS
              position. The coordinates become <strong>optional metadata</strong> on the single
              evidence item you are about to seal — never collected automatically, never attached
              to other captures, and shown only to viewers of that item&apos;s proof record.
            </p>
            <p className="text-xs text-slate-400">
              Declining changes nothing: you can still capture and seal evidence without location.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
