// Forensic heuristics (docs/API.md ForensicReport): exactly SIX fixed
// indicators with confidence — never verdicts. Fixtures are generated here
// (pure-JS PNG/JPEG writers) so the suite needs no binary test assets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import './helpers.js';
import {
  analyze,
  detectFormat,
  parsePng,
  parseJpeg,
  stringsFrom,
  INDICATOR_NAMES,
  MODEL_VERSION,
} from '../src/services/forensics.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- minimal image writers --------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGB PNG of solid-ish pixel data. */
function makePng({ width = 16, height = 16, text = {} } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = (x * 17) & 0xff;
      raw[p + 1] = (y * 17) & 0xff;
      raw[p + 2] = 0x40;
    }
  }
  const parts = [PNG_SIG, chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(text)) {
    parts.push(chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Baseline JFIF JPEG: SOI, APP0, SOF0, SOS, entropy stub, EOI. */
function makeJpeg({ width = 16, height = 16, comment = null, trailing = 0, missingEoi = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  parts.push(app0);
  if (comment) {
    const c = Buffer.from(comment, 'latin1');
    const seg = Buffer.alloc(4 + c.length);
    seg.writeUInt16BE(0xfffe, 0);
    seg.writeUInt16BE(c.length + 2, 2);
    c.copy(seg, 4);
    parts.push(seg);
  }
  const sof = Buffer.alloc(4 + 6 + 3);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8 + 3, 2);
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // 1 component
  sof[10] = 1; sof[11] = 0x11; sof[12] = 0;
  parts.push(sof);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  parts.push(sos);
  // entropy-coded data (no 0xFF without stuffing)
  parts.push(Buffer.alloc(256, 0x55));
  if (!missingEoi) parts.push(Buffer.from([0xff, 0xd9]));
  if (trailing) parts.push(Buffer.alloc(trailing, 0x41));
  return Buffer.concat(parts);
}

// --- tests ------------------------------------------------------------------

test('detectFormat identifies generated PNG and JPEG from magic bytes', () => {
  assert.equal(detectFormat(makePng()).format, 'png');
  assert.equal(detectFormat(makeJpeg()).format, 'jpeg');
  assert.equal(detectFormat(Buffer.from('hello world')).format, 'text');
  assert.equal(detectFormat(Buffer.from([1, 2, 3])).format, 'unknown');
});

test('parsePng reads IHDR, text chunks and validates IEND', () => {
  const png = makePng({ width: 32, height: 24, text: { Software: 'ProofTrail test', Comment: 'generated' } });
  const r = parsePng(png);
  assert.equal(r.valid, true);
  assert.equal(r.width, 32);
  assert.equal(r.height, 24);
  assert.equal(r.bitDepth, 8);
  assert.equal(r.colorType, 2);
  assert.equal(r.text.Software, 'ProofTrail test');
  assert.equal(r.trailing, 0);
  assert.ok(r.chunks.includes('IHDR') && r.chunks.includes('IDAT') && r.chunks.includes('IEND'));
});

test('parsePng detects trailing data appended after IEND', () => {
  const png = Buffer.concat([makePng(), Buffer.alloc(64, 0x42)]);
  const r = parsePng(png);
  assert.equal(r.valid, true);
  assert.equal(r.trailing, 64);
});

test('parseJpeg reads dimensions, comment, and EOI', () => {
  const jpg = makeJpeg({ width: 64, height: 48, comment: 'hello from the camera' });
  const r = parseJpeg(jpg);
  assert.equal(r.valid, true);
  assert.equal(r.width, 64);
  assert.equal(r.height, 48);
  assert.equal(r.progressive, false);
  assert.equal(r.sosCount, 1);
  assert.equal(r.hasEoi, true);
  assert.equal(r.comment, 'hello from the camera');
  assert.equal(r.trailing, 0);
});

test('stringsFrom extracts printable runs', () => {
  const buf = Buffer.concat([Buffer.from('ABCD'), Buffer.from([0, 1, 2]), Buffer.from('efghij'), Buffer.from([0xff])]);
  const out = stringsFrom(buf, 4);
  assert.ok(out.includes('ABCD'));
  assert.ok(out.includes('efghij'));
  assert.ok(!out.some((s) => s.length < 4));
});

test('analyze always returns exactly the six fixed indicators, in order', () => {
  const reports = [
    analyze({ bytes: makePng(), filename: 'shot.png', mimeType: 'image/png', capture: {}, type: 'photo' }),
    analyze({ bytes: makeJpeg(), filename: 'shot.jpg', mimeType: 'image/jpeg', capture: null, type: 'photo' }),
    analyze({ bytes: Buffer.from('plain text'), filename: 'note.txt', mimeType: 'text/plain', capture: {}, type: 'text' }),
  ];
  for (const indicators of reports) {
    assert.equal(indicators.length, 6);
    assert.deepEqual(indicators.map((i) => i.name), INDICATOR_NAMES);
    for (const i of indicators) {
      assert.ok(['flag', 'clean', 'unknown'].includes(i.status), `${i.name}: bad status ${i.status}`);
      assert.equal(typeof i.confidence, 'number');
      assert.ok(i.confidence >= 0 && i.confidence <= 1, `${i.name}: confidence out of range`);
      assert.equal(typeof i.detail, 'string');
      assert.ok(i.detail.length > 0);
      // indicators with confidence — never verdicts
      assert.ok(!('verdict' in i));
      assert.ok(!('tampered' in i));
      assert.ok(!('authentic' in i));
    }
  }
  assert.equal(MODEL_VERSION, 'heuristics-1.0.0');
});

test('format_vs_extension flags a relabelled file', () => {
  const pngAsJpg = analyze({ bytes: makePng(), filename: 'holiday.jpg', mimeType: 'image/jpeg', capture: {}, type: 'photo' });
  const byName = Object.fromEntries(pngAsJpg.map((i) => [i.name, i]));
  assert.equal(byName.format_vs_extension.status, 'flag');
  assert.match(byName.format_vs_extension.detail, /does not match/);

  const honest = analyze({ bytes: makePng(), filename: 'holiday.png', mimeType: 'image/png', capture: {}, type: 'photo' });
  assert.equal(Object.fromEntries(honest.map((i) => [i.name, i])).format_vs_extension.status, 'clean');
});

test('edit software + synthetic media markers are found in PNG text chunks', () => {
  const ps = makePng({ text: { Software: 'Adobe Photoshop 24.0', Comment: 'exported' } });
  const edited = analyze({ bytes: ps, filename: 'a.png', mimeType: 'image/png', capture: {}, type: 'photo' });
  const byName = Object.fromEntries(edited.map((i) => [i.name, i]));
  assert.equal(byName.edit_software_markers.status, 'flag');
  assert.match(byName.edit_software_markers.detail, /photoshop/i);

  const ai = makePng({ text: { Comment: 'Generated with Stable Diffusion', Parameters: 'steps: 20' } });
  const synth = analyze({ bytes: ai, filename: 'b.png', mimeType: 'image/png', capture: {}, type: 'photo' });
  const synthByName = Object.fromEntries(synth.map((i) => [i.name, i]));
  assert.equal(synthByName.synthetic_media_markers.status, 'flag');
  assert.match(synthByName.synthetic_media_markers.detail, /stable diffusion/i);
});

test('compression_anomaly flags trailing data after IEND / missing EOI', () => {
  const appended = Buffer.concat([makePng(), Buffer.alloc(128, 0x43)]);
  const r1 = analyze({ bytes: appended, filename: 'a.png', mimeType: 'image/png', capture: {}, type: 'photo' });
  const c1 = r1.find((i) => i.name === 'compression_anomaly');
  assert.equal(c1.status, 'flag');
  assert.match(c1.detail, /appended after IEND/);

  const noEoi = makeJpeg({ missingEoi: true });
  const r2 = analyze({ bytes: noEoi, filename: 'b.jpg', mimeType: 'image/jpeg', capture: {}, type: 'photo' });
  const c2 = r2.find((i) => i.name === 'compression_anomaly');
  assert.equal(c2.status, 'flag');
  assert.match(c2.detail, /end-of-image/);
});

test('metadata_consistency flags file times far from capture time', () => {
  const jpg = makeJpeg();
  // inject an EXIF APP1 with a DateTime far from the capture clientTime
  const tiff = buildExifDateTime('2020:01:01 00:00:00');
  const app1body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4 + app1body.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(app1body.length + 2, 2);
  app1body.copy(app1, 4);
  const withExif = Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);

  const r = analyze({
    bytes: withExif,
    filename: 'c.jpg',
    mimeType: 'image/jpeg',
    capture: { clientTime: '2026-10-06T09:00:00Z', device: 'Pixel' },
    type: 'photo',
  });
  const m = r.find((i) => i.name === 'metadata_consistency');
  assert.equal(m.status, 'flag');
  assert.match(m.detail, /days/);
});

test('provenance_completeness reflects missing capture metadata', () => {
  const none = analyze({ bytes: makePng(), filename: 'x.png', mimeType: 'image/png', capture: {}, type: 'photo' });
  const p1 = none.find((i) => i.name === 'provenance_completeness');
  assert.equal(p1.status, 'flag');
  assert.match(p1.detail, /no provenance captured/);

  const full = analyze({
    bytes: makePng(),
    filename: 'x.png',
    mimeType: 'image/png',
    capture: { url: 'https://x.test', clientTime: '2026-10-06T09:00:00Z', device: 'Pixel 8' },
    type: 'photo',
  });
  const p2 = full.find((i) => i.name === 'provenance_completeness');
  assert.equal(p2.status, 'clean');
  assert.match(p2.detail, /complete/);
});

test('analysis is deterministic for identical inputs', () => {
  const png = makePng({ text: { Software: 'GIMP 2.10' } });
  const a = analyze({ bytes: png, filename: 'a.png', mimeType: 'image/png', capture: {}, type: 'photo' });
  const b = analyze({ bytes: png, filename: 'a.png', mimeType: 'image/png', capture: {}, type: 'photo' });
  assert.deepEqual(a, b);
});

/** Minimal little-endian TIFF with an IFD0 DateTime (tag 0x0132). */
function buildExifDateTime(value) {
  const str = Buffer.from(`${value}\0`, 'latin1');
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4); // IFD0 at offset 8
  const count = Buffer.alloc(2);
  count.writeUInt16LE(1, 0); // one entry
  const entry = Buffer.alloc(12);
  entry.writeUInt16LE(0x0132, 0); // DateTime
  entry.writeUInt16LE(2, 2); // ASCII
  entry.writeUInt32LE(str.length, 4);
  entry.writeUInt32LE(8 + 2 + 12 + 4, 8); // value offset (after count+entry+next)
  const next = Buffer.alloc(4); // no next IFD
  return Buffer.concat([header, count, entry, next, str]);
}
