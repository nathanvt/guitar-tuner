// Draws the app icons (same art as public/favicon.svg) and writes them as PNGs.
// No image libraries: shapes are signed-distance fields, PNG is encoded by hand.
// Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../public/icons/', import.meta.url);

// Geometry in a 0..1 square, matching the favicon's 64-unit layout.
const PIVOT = [0.5, 42 / 64];
const ARC_RADIUS = 20 / 64;
const ARC_HALF_ANGLE = (50 * Math.PI) / 180;
const ARC_WIDTH = 3.2 / 64;
const NEEDLE_TOP = 17 / 64;
const NEEDLE_WIDTH = 3.6 / 64;
const DOT_RADIUS = 4 / 64;

const BG_TOP = [23, 26, 31];
const BG = [11, 12, 14];
const ARC = [95, 101, 112];
const GOOD = [94, 224, 143];

// Every shape keeps its whole body inside the maskable safe circle (radius 0.4).
const icons = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-512-maskable.png', 512],
];

mkdirSync(OUT, { recursive: true });
for (const [name, size] of icons) {
  writeFileSync(new URL(name, OUT), encodePng(size, draw(size)));
  console.log(`wrote public/icons/${name} (${size}×${size})`);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // Soft light from the top, like the app background.
      const glow = Math.max(0, 1 - Math.hypot((u - 0.5) / 1.2, v / 0.7) / 0.65);
      let color = mix(BG, BG_TOP, glow);
      color = mix(color, ARC, coverage(arcDistance(u, v), size));
      color = mix(color, GOOD, coverage(segmentDistance(u, v, PIVOT, [0.5, NEEDLE_TOP]) - NEEDLE_WIDTH / 2, size));
      color = mix(color, GOOD, coverage(Math.hypot(u - PIVOT[0], v - PIVOT[1]) - DOT_RADIUS, size));
      const i = (y * size + x) * 4;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Distance to the gauge arc (round-capped), minus half its stroke. */
function arcDistance(u, v) {
  const dx = u - PIVOT[0];
  const dy = v - PIVOT[1];
  const angle = Math.atan2(dx, -dy); // 0 = straight up
  if (Math.abs(angle) <= ARC_HALF_ANGLE) {
    return Math.abs(Math.hypot(dx, dy) - ARC_RADIUS) - ARC_WIDTH / 2;
  }
  const end = Math.sign(angle) * ARC_HALF_ANGLE;
  const ex = PIVOT[0] + ARC_RADIUS * Math.sin(end);
  const ey = PIVOT[1] - ARC_RADIUS * Math.cos(end);
  return Math.hypot(u - ex, v - ey) - ARC_WIDTH / 2;
}

function segmentDistance(u, v, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(u - (ax + t * (bx - ax)), v - (ay + t * (by - ay)));
}

/** Antialiased fill amount for a signed distance, measured in pixels. */
function coverage(distance, size) {
  return Math.max(0, Math.min(1, 0.5 - distance * size));
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
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
