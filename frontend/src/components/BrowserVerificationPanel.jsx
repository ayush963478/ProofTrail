import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileSearch,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { publicApi } from '../api/client.js';
import { sha256Hex, sameHex } from '../lib/hash.js';
import { runBrowserChecks } from '../lib/verify.js';
import { formatBytes, shortHash } from '../lib/format.js';
import { Spinner } from './ui.jsx';

function StatusIcon({ status }) {
  if (status === 'pass') return <CheckCircle2 size={17} className="animate-pop text-emerald-500" />;
  if (status === 'fail') return <XCircle size={17} className="animate-pop text-rose-500" />;
  return <Clock size={17} className="text-slate-400" />;
}

const EMPTY = [];

/**
 * The frontend-independent verification panel (docs/API.md § "Frontend-independent
 * verification"). Recomputes, inside the browser with WebCrypto:
 *
 *   1. sha256(local file)                 vs evidence.sha256
 *   2. sha256(canonicalJson(manifest))     vs proof.manifestHash
 *   3. ECDSA P-256 signature over bytes    with proof.signature.publicKeyPem
 *   4. manifest.timestamp.token            vs proof.timestamp.token
 *
 * When `serverChecks` are provided (public verify response), each row shows
 * "server says" next to "recomputed in your browser".
 *
 * Props:
 *   evidence     — { sha256, filename, size }
 *   proof        — { manifest, manifestHash, signature, timestamp }
 *   serverChecks — [ { name, passed, detail } ] (optional)
 *   allowFile    — show the local file picker (default true)
 *   runSignal    — increment to force a re-run (used by "Verify in browser")
 */
export default function BrowserVerificationPanel({
  evidence,
  proof,
  serverChecks = EMPTY,
  allowFile = true,
  runSignal = 0,
  fileHint = 'the original file',
  compact = false,
}) {
  const [file, setFile] = useState(null);
  const [fileHash, setFileHash] = useState(null);
  const [hashing, setHashing] = useState(false);
  const [keyPem, setKeyPem] = useState(proof?.signature?.publicKeyPem || null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const [rows, setRows] = useState(null); // null = computing
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(false);

  // The public verify response embeds publicKeyPem; the authenticated
  // GET /evidence/{id} response only has keyId -> fetch GET /public/keys/{keyId}.
  const keyId = proof?.signature?.keyId;
  const embeddedPem = proof?.signature?.publicKeyPem;
  useEffect(() => {
    if (embeddedPem) {
      setKeyPem(embeddedPem);
      return undefined;
    }
    if (!keyId) return undefined;
    let cancelled = false;
    setKeyLoading(true);
    setKeyError(null);
    publicApi
      .key(keyId)
      .then((res) => {
        if (!cancelled) setKeyPem(res?.publicKeyPem || null);
      })
      .catch((e) => {
        if (!cancelled) setKeyError(e.message);
      })
      .finally(() => {
        if (!cancelled) setKeyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [keyId, embeddedPem]);

  const run = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      if (proof && !keyPem && keyLoading) return; // wait for the key fetch
      const effectiveProof = proof
        ? {
            ...proof,
            signature: { ...proof.signature, publicKeyPem: keyPem || proof.signature?.publicKeyPem },
          }
        : null;
      const result = await runBrowserChecks({
        evidence,
        proof: effectiveProof,
        file,
        serverChecks,
      });
      setRows(result);
    } catch (e) {
      setError(e.message || 'Verification failed to run');
      setRows(null);
    }
  }, [evidence, proof, file, serverChecks, keyPem, keyLoading, keyError]);

  useEffect(() => {
    run();
  }, [run, runSignal]);

  // Flash effect when triggered by the "Verify in browser" button.
  useEffect(() => {
    if (runSignal > 0) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [runSignal]);

  async function onPick(chosen) {
    if (!chosen) return;
    setFile(chosen);
    setFileHash(null);
    setHashing(true);
    try {
      const h = await sha256Hex(chosen);
      setFileHash(h);
    } catch (e) {
      setFileHash(null);
      setError(`Could not hash the file: ${e.message}`);
    } finally {
      setHashing(false);
    }
  }

  const computed = rows && rows.length === 4 ? rows : null;
  const fileRow = computed ? computed.find((r) => r.key === 'file_hash') : null;
  const browserPasses = computed ? computed.filter((r) => r.status === 'pass').length : 0;

  return (
    <div
      id="independent-verification"
      className={`rounded-xl border ${
        flash ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-slate-200'
      } bg-white shadow-sm transition`}
    >
      <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
          <ShieldCheck size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">
            Independent browser verification
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Recomputed in your browser with WebCrypto — the server is never trusted on its own, and
            your file never leaves this device.
          </p>
        </div>
        {!compact && computed && (
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
              browserPasses === 4
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-amber-50 text-amber-700'
            }`}
          >
            {browserPasses}/4 browser checks
          </span>
        )}
      </div>

      {allowFile && (
        <div className="border-b border-slate-100 px-5 py-4">
          <label className="group flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 px-4 py-3 transition hover:border-indigo-400 hover:bg-indigo-50/40">
            <Upload size={18} className="text-slate-400 transition group-hover:text-indigo-500" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-700">
                Select {fileHint} to compare its hash
              </span>
              <span className="block text-xs text-slate-400">
                SHA-256 is computed locally — nothing is uploaded.
              </span>
            </span>
            <input
              type="file"
              className="sr-only"
              onChange={(e) => onPick(e.target.files?.[0] || null)}
            />
          </label>

          {file && (
            <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                  <FileSearch size={15} className="shrink-0 text-slate-400" />
                  <span className="truncate font-medium">{file.name}</span>
                  <span className="text-xs text-slate-400">{formatBytes(file.size)}</span>
                </span>
                {hashing && (
                  <span className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Spinner size={13} /> Computing SHA-256…
                  </span>
                )}
              </div>
              {!hashing && fileHash && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-700 ring-1 ring-slate-200">
                    {fileHash}
                  </code>
                  {fileRow && fileRow.status === 'pass' ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                      <CheckCircle2 size={13} /> Hash matches sealed value
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-800">
                      <XCircle size={13} /> Hash does NOT match
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Results table: server says | recomputed in your browser */}
      <div className="px-5 py-4">
        {(keyLoading || rows === null) && !error && (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Spinner size={16} className="text-indigo-500" /> Running checks in your browser…
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {keyError && !error && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            Could not fetch the public key ({keyError}) — signature check cannot run.
          </div>
        )}

        {computed && !error && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-2 pr-3 font-semibold">Check</th>
                  {serverChecks.length > 0 && (
                    <th className="pb-2 pr-3 font-semibold">Server says</th>
                  )}
                  <th className="pb-2 pr-3 font-semibold">Recomputed in your browser</th>
                  <th className="pb-2 text-right font-semibold">Result</th>
                </tr>
              </thead>
              <tbody className="stagger">
                {computed.map((row) => (
                  <tr key={row.key} className="border-b border-slate-100 align-top last:border-0">
                    <td className="py-3 pr-3">
                      <span className="block font-medium text-slate-800">{row.label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                        {row.detail}
                      </span>
                    </td>
                    {serverChecks.length > 0 && (
                      <td className="py-3 pr-3">
                        <code className="break-all font-mono text-xs text-slate-500">
                          {row.server
                            ? String(row.server).length > 24
                              ? shortHash(String(row.server), 10, 6)
                              : String(row.server)
                            : '—'}
                        </code>
                      </td>
                    )}
                    <td className="py-3 pr-3">
                      {row.browser === null ? (
                        <span className="text-xs italic text-slate-400">
                          {row.key === 'file_hash' ? 'awaiting file selection' : 'not available'}
                        </span>
                      ) : (
                        <code className="break-all font-mono text-xs text-slate-700">
                          {String(row.browser).length > 24
                            ? shortHash(String(row.browser), 10, 6)
                            : String(row.browser)}
                        </code>
                      )}
                      {row.key === 'file_hash' && fileHash && fileRow && (
                        <span className="mt-1 block text-xs text-slate-500">
                          {sameHex(fileHash, evidence?.sha256)
                            ? 'identical to sealed hash'
                            : 'differs from sealed hash'}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusIcon status={row.status} />
                        <span
                          className={`text-xs font-semibold ${
                            row.status === 'pass'
                              ? 'animate-pop text-emerald-600'
                              : row.status === 'fail'
                                ? 'animate-pop text-rose-600'
                                : 'text-slate-400'
                          }`}
                        >
                          {row.status === 'pass'
                            ? 'MATCH'
                            : row.status === 'fail'
                              ? 'FAIL'
                              : 'PENDING'}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
