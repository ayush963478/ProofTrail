// AI-forensic heuristics (docs/API.md ForensicReport).
//
// Six FIXED indicator names, each {name, status: flag|clean|unknown,
// confidence 0..1, detail}. Results are INDICATORS WITH CONFIDENCE — never
// verdicts. Pure-JS image parsing (no native deps), modelVersion
// "heuristics-1.0.0".

import zlib from 'node:zlib';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';
import { evidenceBytes } from './seal.js';

export const MODEL_VERSION = 'heuristics-1.0.0';
export const INDICATOR_NAMES = [
  'metadata_consistency',
  'format_vs_extension',
  'edit_software_markers',
  'compression_anomaly',
  'synthetic_media_markers',
  'provenance_completeness',
];

const ind = (name, status, confidence, detail) => ({
  name,
  status,
  confidence: Math.max(0, Math.min(1, Number(confidence))),
  detail,
});

// ---------------------------------------------------------------------------
// format detection (magic bytes)
// ---------------------------------------------------------------------------

export function detectFormat(b) {
  if (!Buffer.isBuffer(b) || b.length < 4) return { format: 'unknown', label: 'too short' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: 'png', label: 'PNG image' };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: 'jpeg', label: 'JPEG image' };
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return { format: 'gif', label: 'GIF image' };
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return { format: 'pdf', label: 'PDF document' };
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    return { format: 'zip', label: 'ZIP archive' };
  }
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return { format: 'mp4', label: 'MP4/M4A container' };
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { format: 'webp', label: 'WebP image' };
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return { format: 'bmp', label: 'BMP image' };
  if (b.subarray(0, 4).toString('latin1') === 'OggS') return { format: 'ogg', label: 'Ogg media' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { format: 'webm', label: 'WebM media' };
  if (b[0] === 0xff && b[1] === 0xf1) return { format: 'aac', label: 'AAC audio' };
  if (b[0] === 0xff && (b[1] === 0xfb || b[1] === 0xf3 || b[1] === 0xf2)) return { format: 'mp3', label: 'MP3 audio' };
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return { format: 'mp3', label: 'MP3 audio (ID3)' };
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') {
    return { format: 'wav', label: 'WAV audio' };
  }
  const head = b.subarray(0, 512).toString('latin1');
  if (/^\s*<(!doctype html|html|head|body|\?xml)/i.test(head)) return { format: 'html', label: 'HTML document' };
  const sample = b.subarray(0, 512);
  let printable = 0;
  for (const byte of sample) {
    if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable++;
  }
  if (sample.length > 0 && printable / sample.length > 0.9) return { format: 'text', label: 'plain text' };
  return { format: 'unknown', label: 'unknown binary' };
}

const EXT_FORMATS = {
  jpg: ['jpeg'], jpeg: ['jpeg'], png: ['png'], gif: ['gif'], webp: ['webp'], bmp: ['bmp'],
  pdf: ['pdf'], zip: ['zip'], mp4: ['mp4'], m4a: ['mp4'], mov: ['mp4'], webm: ['webm'],
  ogg: ['ogg'], oga: ['ogg'], wav: ['wav'], mp3: ['mp3'], aac: ['aac'], txt: ['text'],
  html: ['html'], htm: ['html'], csv: ['text'], json: ['text'], md: ['text'],
};

function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// ASCII strings
// ---------------------------------------------------------------------------

export function stringsFrom(buf, min = 4, limit = 5000) {
  const out = [];
  const re = new RegExp(`[\\x20-\\x7e]{${min},}`, 'g');
  const text = buf.toString('latin1');
  let m;
  while ((m = re.exec(text)) && out.length < limit) out.push(m[0]);
  return out;
}

// ---------------------------------------------------------------------------
// PNG parsing
// ---------------------------------------------------------------------------

export function parsePng(b) {
  const res = {
    width: null, height: null, bitDepth: null, colorType: null,
    chunks: [], text: {}, hasSrgb: false, hasGama: false, trailing: 0,
    valid: false,
  };
  if (b.length < 8 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return res;
  let p = 8;
  let sawIend = false;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.subarray(p + 4, p + 8).toString('latin1');
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) break;
    res.chunks.push(type);
    const data = b.subarray(dataStart, dataEnd);
    if (type === 'IHDR' && len >= 13) {
      res.width = data.readUInt32BE(0);
      res.height = data.readUInt32BE(4);
      res.bitDepth = data[8];
      res.colorType = data[9];
    } else if (type === 'sRGB') {
      res.hasSrgb = true;
    } else if (type === 'gAMA' && len >= 4) {
      res.gama = data.readUInt32BE(0);
      res.hasGama = res.gama === 45455; // gamma 0.45455 — sRGB-compatible / browser default
    } else if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) res.text[data.subarray(0, z).toString('latin1')] = data.subarray(z + 1).toString('latin1');
    } else if (type === 'zTXt') {
      const z = data.indexOf(0);
      if (z > 0 && z + 2 < len) {
        try {
          const key = data.subarray(0, z).toString('latin1');
          res.text[key] = zlib.inflateSync(data.subarray(z + 2)).toString('utf8');
        } catch { /* ignore corrupt text */ }
      }
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0 && z + 3 < len) {
        const key = data.subarray(0, z).toString('latin1');
        const compFlag = data[z + 1];
        try {
          const body = compFlag === 1
            ? zlib.inflateSync(data.subarray(z + 3)).toString('utf8')
            : data.subarray(z + 3).toString('utf8');
          // skip translated keyword (\0 terminated)
          const z2 = body.indexOf('\0');
          res.text[key] = (z2 >= 0 ? body.slice(z2 + 1) : body).replace(/\0/g, '');
        } catch { /* ignore */ }
      }
    } else if (type === 'IEND') {
      sawIend = true;
      p = dataEnd + 4;
      break;
    }
    p = dataEnd + 4;
  }
  res.trailing = sawIend ? b.length - p : 0;
  res.valid = res.chunks.includes('IHDR') && sawIend;
  return res;
}

// ---------------------------------------------------------------------------
// JPEG + minimal EXIF parsing
// ---------------------------------------------------------------------------

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function parseJpeg(b) {
  const res = {
    width: null, height: null, progressive: false, sosCount: 0,
    segments: [], comment: null, app1: [], app13: [], exif: {},
    hasEoi: false, trailing: 0, valid: false,
  };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return res;
  let p = 2;
  let eoiAt = -1;
  // NB: the guard must allow a marker that ends the file (the EOI is the last
  // two bytes of a well-formed JPEG); length reads are guarded separately below.
  while (p + 2 <= b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) break;
    const marker = b[p];
    p++;
    if (marker === 0xd9) { // EOI
      res.hasEoi = true;
      eoiAt = p;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
    if (p + 2 > b.length) break;
    const len = b.readUInt16BE(p);
    const segStart = p + 2;
    const segEnd = p + len;
    if (segEnd > b.length) break;
    res.segments.push(marker.toString(16).padStart(2, '0'));
    if (SOF_MARKERS.has(marker)) {
      res.progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
      if (len >= 6) {
        res.height = b.readUInt16BE(segStart + 1);
        res.width = b.readUInt16BE(segStart + 3);
      }
    } else if (marker === 0xda) { // SOS
      res.sosCount++;
      // entropy-coded data: scan for the next non-stuffed, non-restart marker
      let q = segEnd;
      while (q + 1 < b.length) {
        if (b[q] === 0xff && b[q + 1] !== 0x00 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7)) break;
        q++;
      }
      p = q;
      continue;
    } else if (marker === 0xfe) { // COM
      const s = b.subarray(segStart, segEnd).toString('latin1').replace(/\0/g, '').trim();
      if (s) res.comment = s;
    } else if (marker === 0xe1) { // APP1
      const seg = b.subarray(segStart, segEnd);
      res.app1.push(seg);
      if (seg.subarray(0, 6).toString('latin1') === 'Exif\0\0') {
        try { res.exif = parseExif(seg.subarray(6)); } catch { /* ignore */ }
      }
    } else if (marker === 0xed) { // APP13 (Photoshop IRB)
      res.app13.push(b.subarray(segStart, segEnd));
    }
    p = segEnd;
  }
  if (res.hasEoi && eoiAt >= 0) res.trailing = b.length - eoiAt;
  res.valid = true;
  return res;
}

function parseTiff(buf) {
  if (buf.length < 8) return {};
  const order = buf.subarray(0, 2).toString('latin1');
  const le = order === 'II';
  if (!le && order !== 'MM') return {};
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) return {};
  const readIfd = (offset) => {
    const out = {};
    if (offset + 2 > buf.length) return out;
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const valOff = e + 8;
      let str = null;
      if (type === 2) {
        let start = valOff;
        let bytes;
        if (n <= 4) bytes = buf.subarray(valOff, valOff + n);
        else {
          const off = u32(valOff);
          if (off + n > buf.length) continue;
          bytes = buf.subarray(off, off + n);
        }
        str = bytes.toString('latin1').replace(/\0+$/, '').trim();
        void start;
      } else if (type === 4 || type === 3) {
        out[tag] = n <= 1 ? (type === 4 ? u32(valOff) : u16(valOff)) : u32(valOff);
      }
      if (str !== null && str !== '') out[tag] = str;
    }
    return out;
  };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
  return {
    imageDescription: ifd0[0x010e] || null,
    software: ifd0[0x0131] || null,
    artist: ifd0[0x013b] || null,
    make: ifd0[0x010f] || null,
    model: ifd0[0x0110] || null,
    dateTime: ifd0[0x0132] || null,
    dateTimeOriginal: exif[0x9003] || null,
    dateTimeDigitized: exif[0x9004] || null,
    userComment: exif[0x9286] || null,
  };
}

export function parseExif(tiffBuf) {
  const r = parseTiff(tiffBuf);
  return {
    imageDescription: r.imageDescription || null,
    software: r.software || null,
    artist: r.artist || null,
    make: r.make || null,
    model: r.model || null,
    dateTime: r.dateTime || null,
    dateTimeOriginal: r.dateTimeOriginal || null,
    dateTimeDigitized: r.dateTimeDigitized || null,
    userComment: r.userComment || null,
  };
}

// ---------------------------------------------------------------------------
// marker dictionaries
// ---------------------------------------------------------------------------

const EDIT_MARKERS = [
  'photoshop', 'gimp', 'lightroom', 'capture one', 'affinity photo', 'affinity designer',
  'paint.net', 'pixlr', 'imagemagick', 'graphicsmagick', 'xnview', 'adobe imageready',
  'corel paint', 'photopea', 'skylum', 'luminar', 'on1',
];

const SYNTHETIC_MARKERS = [
  'stable diffusion', 'stablediffusion', 'sdxl', 'midjourney', 'dall-e', 'dall·e', 'dalle3',
  'ai generated', 'ai-generated', 'generated with ai', 'generated by ai', 'this image was created with',
  'civitai', 'novelai', 'leonardo.ai', 'adobe firefly', 'generative fill', 'synthid',
  'comfyui', 'automatic1111', 'stable-diffusion', 'sd checkpoint', 'pnginfo', 'aigc',
];

function findMarkers(strings, dict) {
  const hits = [];
  for (const s of strings) {
    const low = s.toLowerCase();
    for (const marker of dict) {
      if (low.includes(marker)) hits.push({ marker, where: s.length > 160 ? `${s.slice(0, 157)}…` : s });
    }
  }
  return hits;
}

/** All inspectable text for an image: metadata chunks, comments, XMP, head strings. */
function collectText(b, { png, jpeg }) {
  const texts = [];
  if (png) {
    for (const [k, v] of Object.entries(png.text || {})) texts.push(`${k}: ${v}`);
  }
  if (jpeg) {
    if (jpeg.comment) texts.push(jpeg.comment);
    if (jpeg.exif) {
      for (const [k, v] of Object.entries(jpeg.exif)) if (v) texts.push(`${k}: ${v}`);
    }
    for (const seg of [...jpeg.app1, ...jpeg.app13]) {
      for (const s of stringsFrom(seg, 5, 200)) texts.push(s);
    }
  }
  // whole-file head scan (covers XMP packets, trailing metadata, HTML comments)
  for (const s of stringsFrom(b.subarray(0, Math.min(b.length, 1_500_000)), 5, 3000)) texts.push(s);
  return texts;
}

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

function indicatorFormatVsExtension(detected, filename) {
  const ext = extOf(filename);
  if (detected.format === 'unknown') {
    return ind('format_vs_extension', 'unknown', 0.5,
      `could not identify the file format from its bytes (extension ".${ext || '?'}")`);
  }
  if (detected.format === 'text' && !ext) {
    return ind('format_vs_extension', 'unknown', 0.5, 'plain text content, no extension to compare');
  }
  const allowed = EXT_FORMATS[ext];
  if (!allowed) {
    return ind('format_vs_extension', 'unknown', 0.4,
      `detected ${detected.label}, extension ".${ext || '(none)'}" has no known mapping`);
  }
  if (allowed.includes(detected.format)) {
    return ind('format_vs_extension', 'clean', 0.95,
      `extension ".${ext}" matches detected format ${detected.label}`);
  }
  return ind('format_vs_extension', 'flag', 0.9,
    `extension ".${ext}" does not match detected ${detected.label} — possible relabelling`);
}

function indicatorMetadataConsistency({ detected, png, jpeg, capture }) {
  if (detected.format !== 'png' && detected.format !== 'jpeg' && detected.format !== 'webp') {
    return ind('metadata_consistency', 'unknown', 0.3,
      `metadata cross-check applies to images; detected ${detected.label}`);
  }
  const fileDates = [];
  if (jpeg?.exif) {
    for (const v of [jpeg.exif.dateTimeOriginal, jpeg.exif.dateTimeDigitized, jpeg.exif.dateTime]) {
      if (v) fileDates.push(`EXIF ${v}`);
    }
  }
  const clientTime = capture?.clientTime || null;
  if (fileDates.length === 0) {
    const chunks = png ? ` (PNG chunks: ${png.chunks.join(', ') || 'none'})` : '';
    return ind('metadata_consistency', 'unknown', 0.45,
      `no embedded timestamps in file metadata to compare with capture metadata${chunks}`);
  }
  if (!clientTime) {
    return ind('metadata_consistency', 'unknown', 0.5,
      `file carries timestamps (${fileDates.join('; ')}) but capture metadata has no clientTime`);
  }
  // fileDates entries are prefixed ("EXIF 2020:01:01 …") — strip before matching
  const wanted = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    fileDates[0].replace(/^[A-Za-z]+\s+/, ''),
  );
  if (!wanted) {
    return ind('metadata_consistency', 'unknown', 0.4, `unparseable file timestamp: ${fileDates[0]}`);
  }
  const fileMs = Date.UTC(+wanted[1], +wanted[2] - 1, +wanted[3], +wanted[4], +wanted[5], +wanted[6]);
  const captureMs = Date.parse(clientTime);
  if (!Number.isFinite(captureMs)) {
    return ind('metadata_consistency', 'unknown', 0.4, `capture clientTime is not a valid timestamp: ${clientTime}`);
  }
  const diffDays = Math.abs(fileMs - captureMs) / 86400000;
  if (diffDays > 7) {
    return ind('metadata_consistency', 'flag', 0.7,
      `file metadata time differs from capture time by ${diffDays.toFixed(1)} days (${fileDates[0]} vs ${clientTime})`);
  }
  return ind('metadata_consistency', 'clean', 0.6,
    `file metadata time within ${diffDays.toFixed(1)} days of capture time`);
}

function indicatorEditSoftware({ detected, texts }) {
  if (detected.format !== 'png' && detected.format !== 'jpeg' && detected.format !== 'webp' && detected.format !== 'gif') {
    return ind('edit_software_markers', 'unknown', 0.4,
      `no image metadata markers to inspect; detected ${detected.label}`);
  }
  const hits = findMarkers(texts, EDIT_MARKERS);
  if (hits.length) {
    return ind('edit_software_markers', 'flag', 0.9,
      `edit-software marker(s) found: ${[...new Set(hits.map((h) => h.marker))].join(', ')} — "${hits[0].where}"`);
  }
  return ind('edit_software_markers', 'clean', 0.7,
    'no edit-software markers in metadata, comments or file header');
}

function indicatorCompression({ detected, bytes, png, jpeg }) {
  if (detected.format === 'jpeg' && jpeg) {
    const problems = [];
    let conf = 0.6;
    if (!jpeg.hasEoi) { problems.push('missing end-of-image (EOI) marker'); conf = 0.7; }
    if (jpeg.trailing > 0) { problems.push(`${jpeg.trailing} byte(s) appended after EOI`); conf = 0.8; }
    if (jpeg.width && jpeg.height && jpeg.width * jpeg.height > 0) {
      const bpp = (bytes.length * 8) / (jpeg.width * jpeg.height);
      if (bpp < 0.03) { problems.push(`very low information density ${bpp.toFixed(4)} bits/px (${jpeg.width}×${jpeg.height})`); conf = Math.max(conf, 0.6); }
      else if (bpp > 8) { problems.push(`unusually high information density ${bpp.toFixed(1)} bits/px (${jpeg.width}×${jpeg.height})`); conf = Math.max(conf, 0.5); }
      if (!jpeg.progressive && jpeg.sosCount > 1) { problems.push(`${jpeg.sosCount} scans — consistent with multiple compression passes`); conf = Math.max(conf, 0.6); }
      if (problems.length === 0) {
        return ind('compression_anomaly', 'clean', 0.6,
          `density ${bpp.toFixed(3)} bits/px (${jpeg.width}×${jpeg.height}) is typical for a single-pass JPEG`);
      }
    } else if (problems.length === 0) {
      return ind('compression_anomaly', 'unknown', 0.4, 'JPEG dimensions unavailable; density could not be computed');
    }
    return ind('compression_anomaly', 'flag', conf, problems.join('; '));
  }
  if (detected.format === 'png' && png) {
    const problems = [];
    let conf = 0.6;
    if (png.trailing > 0) problems.push(`${png.trailing} byte(s) of data appended after IEND`);
    if (png.width && png.height) {
      const bytesPerPx = bytes.length / (png.width * png.height);
      if (bytesPerPx > 6) problems.push(`lossless density ${bytesPerPx.toFixed(1)} bytes/px is implausibly high for ${png.width}×${png.height}`);
      if (problems.length === 0) {
        return ind('compression_anomaly', 'clean', 0.6,
          `lossless PNG density ${bytesPerPx.toFixed(2)} bytes/px (${png.width}×${png.height}); no trailing data`);
      }
    }
    conf = png.trailing > 0 ? 0.85 : 0.5;
    return ind('compression_anomaly', 'flag', conf, problems.join('; '));
  }
  return ind('compression_anomaly', 'unknown', 0.3,
    `compression analysis covers JPEG/PNG; detected ${detected.label}`);
}

function indicatorSyntheticMedia({ detected, texts }) {
  const hits = findMarkers(texts, SYNTHETIC_MARKERS);
  if (hits.length) {
    return ind('synthetic_media_markers', 'flag', 0.85,
      `generative-media marker(s) found: ${[...new Set(hits.map((h) => h.marker))].join(', ')} — "${hits[0].where}"`);
  }
  const isImage = ['png', 'jpeg', 'gif', 'webp', 'bmp'].includes(detected.format);
  if (isImage) {
    return ind('synthetic_media_markers', 'clean', 0.5,
      'no known synthetic-media markers in metadata, comments or file content');
  }
  return ind('synthetic_media_markers', 'unknown', 0.3,
    `no image metadata to inspect; detected ${detected.label}`);
}

function indicatorProvenance({ capture, type }) {
  const cap = capture || {};
  const required = ['url', 'clientTime', 'device'];
  const missing = required.filter((f) => !cap[f]);
  const optional = ['gps', 'appVersion', 'userAgent'].filter((f) => !cap[f]);
  if (missing.length === 0) {
    return ind('provenance_completeness', 'clean', 0.85,
      `capture metadata complete (url, clientTime, device present${optional.length ? `; optional ${optional.join(', ')} absent` : ''})`);
  }
  if (missing.length === required.length) {
    return ind('provenance_completeness', 'flag', 0.9,
      `no provenance captured — missing ${missing.join(', ')} (${type} evidence)`);
  }
  const conf = 0.5 + (missing.length / required.length) * 0.4;
  return ind('provenance_completeness', 'flag', conf,
    `missing provenance field(s): ${missing.join(', ')}${cap.serverTime ? '' : ' (serverTime also absent)'}`);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Pure analysis — always returns exactly the 6 fixed indicators.
 * @param {{bytes, filename, mimeType?, capture?, type?}} input
 */
export function analyze({ bytes, filename, mimeType, capture, type }) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const detected = detectFormat(b);
  const png = detected.format === 'png' ? parsePng(b) : null;
  const jpeg = detected.format === 'jpeg' ? parseJpeg(b) : null;
  const texts = collectText(b, { png, jpeg });

  const indicators = [
    indicatorMetadataConsistency({ detected, png, jpeg, capture }),
    indicatorFormatVsExtension(detected, filename),
    indicatorEditSoftware({ detected, texts }),
    indicatorCompression({ detected, bytes: b, png, jpeg }),
    indicatorSyntheticMedia({ detected, texts }),
    indicatorProvenance({ capture, type }),
  ];
  // stable order per INDICATOR_NAMES
  const byName = new Map(indicators.map((i) => [i.name, i]));
  return INDICATOR_NAMES.map((n) => byName.get(n));
}

/** Run + persist the report for one evidence item. */
export async function runForensics(evidenceId, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  const ev = await db.getEvidence(evidenceId);
  if (!ev || ev.deletedAt) throw new AppError('not_found', 'Evidence not found');
  if (opts.actor && ev.ownerId !== opts.actor.sub) throw new AppError('not_found', 'Evidence not found');
  if (['pending_upload', 'failed'].includes(ev.status)) {
    throw new AppError('conflict', `Evidence is "${ev.status}" — nothing to analyse yet`);
  }
  const bytes = await evidenceBytes(ev, cfg);
  const report = {
    evidenceId: ev.id,
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    indicators: analyze({
      bytes,
      filename: ev.filename,
      mimeType: ev.mimeType,
      capture: ev.capture,
      type: ev.type,
    }),
  };
  await db.updateEvidence(ev.id, { forensicReport: report, updatedAt: new Date().toISOString() });
  return report;
}
