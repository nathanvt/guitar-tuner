// Draws the app icons and favicon to match the tuner: casing grey, a dark screen band,
// the arc of bars lit green as when in tune, and a white pixel E.
// No image libraries: shapes are signed-distance fields, PNG is encoded by hand.
// Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../public/', import.meta.url);

const CASING = [27, 28, 31];
const SCREEN = [14, 15, 17];
const GREEN = [46, 226, 122];
const WHITE = [244, 243, 238];

// Geometry in a 0..1 square. Every mark sits inside the maskable safe circle (radius 0.4).
const BAND = { top: 0.18, bottom: 0.82 };
const ARC = { cx: 0.5, cy: 0.6, radius: 0.28, half: 4, sweep: (60 * Math.PI) / 180, length: 0.075, width: 0.04 };
const CENTER_LENGTH = 1.3;
const E = ['#####', '#....', '#....', '####.', '#....', '#....', '#####'];
const PITCH = 0.036;
const NOTE = { x: 0.5 - (5 * PITCH) / 2, y: 0.5 };

const bars = [];
for (let i = -ARC.half; i <= ARC.half; i++) {
  bars.push({ angle: (i / ARC.half) * ARC.sweep, length: ARC.length * (i === 0 ? CENTER_LENGTH : 1) });
}
const pixels = [];
E.forEach((row, r) => [...row].forEach((dot, c) => dot === '#' && pixels.push({ x: NOTE.x + c * PITCH, y: NOTE.y + r * PITCH })));

mkdirSync(new URL('icons/', OUT), { recursive: true });
for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-512-maskable.png', 512],
]) {
  writeFileSync(new URL(`icons/${name}`, OUT), encodePng(size, draw(size)));
  console.log(`wrote public/icons/${name} (${size}×${size})`);
}
writeFileSync(new URL('favicon.svg', OUT), favicon());
console.log('wrote public/favicon.svg');

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const onScreen = v >= BAND.top && v <= BAND.bottom;
      let color = onScreen ? SCREEN : CASING;

      const bar = Math.min(...bars.map((b) => barDistance(u, v, b)));
      // Soft green light around the bars, on the screen only.
      if (onScreen) color = mix(color, GREEN, 0.3 * Math.exp(-Math.max(bar, 0) / 0.03));
      color = mix(color, GREEN, coverage(bar, size));

      const note = Math.min(...pixels.map((p) => pixelDistance(u, v, p)));
      color = mix(color, WHITE, coverage(note, size));

      const i = (y * size + x) * 4;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Distance to one bar: a rounded rectangle standing on the arc, pointing out from its center. */
function barDistance(u, v, { angle, length }) {
  const dx = u - ARC.cx;
  const dy = v - ARC.cy;
  const along = dx * Math.sin(angle) - dy * Math.cos(angle);
  const across = dx * Math.cos(angle) + dy * Math.sin(angle);
  const inner = ARC.radius - ARC.length / 2;
  return roundedRect(along - (inner + length / 2), across, length / 2, ARC.width / 2, 0.005);
}

/** Distance to one pixel of the note: a square with a small gap and a hint of rounding. */
function pixelDistance(u, v, p) {
  const side = PITCH * 0.88;
  return roundedRect(u - (p.x + PITCH / 2), v - (p.y + PITCH / 2), side / 2, side / 2, side * 0.1);
}

function roundedRect(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Antialiased fill amount for a signed distance, measured in pixels. */
function coverage(distance, size) {
  return Math.max(0, Math.min(1, 0.5 - distance * size));
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

/** The same design as SVG, on a 64-unit grid with rounded corners for browser tabs. */
function favicon() {
  const s = 64;
  const hex = ([r, g, b]) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  const n = (value) => +(value * s).toFixed(2);
  const inner = ARC.radius - ARC.length / 2;
  const barMarks = bars
    .map(
      (b) =>
        `<rect x="${n(-ARC.width / 2)}" y="${n(-(inner + b.length))}" width="${n(ARC.width)}" height="${n(b.length)}" rx="0.4" transform="translate(${n(ARC.cx)} ${n(ARC.cy)}) rotate(${((b.angle * 180) / Math.PI).toFixed(2)})"/>`,
    )
    .join('');
  const side = PITCH * 0.88;
  const notePixels = pixels
    .map((p) => `<rect x="${n(p.x + (PITCH - side) / 2)}" y="${n(p.y + (PITCH - side) / 2)}" width="${n(side)}" height="${n(side)}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">
  <clipPath id="c"><rect width="${s}" height="${s}" rx="14"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="${s}" height="${s}" fill="${hex(CASING)}"/>
    <rect y="${n(BAND.top)}" width="${s}" height="${n(BAND.bottom - BAND.top)}" fill="${hex(SCREEN)}"/>
    <g fill="${hex(GREEN)}">${barMarks}</g>
    <g fill="${hex(WHITE)}">${notePixels}</g>
  </g>
</svg>
`;
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1)); // each row starts with filter byte 0
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
