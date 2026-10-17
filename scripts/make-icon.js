#!/usr/bin/env node
'use strict';
/**
 * Generate build/icon.png (1024×1024, RGBA) — the app icon.
 *
 * electron-builder turns this one PNG into the macOS .icns at package time, so
 * the icon has to be right here rather than shipped as a hand-made bundle
 * asset. It is drawn as a horizontal bar chart, because that is what the app
 * shows: three bars in the same colours the chart uses (cached / uncached /
 * .com), sized the way a resolver comparison looks.
 *
 * Pure Node (zlib for the PNG stream, a local CRC32), so `npm run icon` works
 * on any machine with no image tooling installed.
 *
 *   node scripts/make-icon.js [outPath]
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;

// ---------------------------------------------------------------- PNG bits ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // no filter
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- tiny raster ---

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) };
}

function blend(canvas, x, y, colour, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const a = Math.min(1, alpha);
  const i = (y * canvas.size + x) * 4;
  const dst = canvas.data;
  const dstA = dst[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA === 0) return;
  for (let c = 0; c < 3; c += 1) {
    dst[i + c] = Math.round((colour[c] * a + dst[i + c] * dstA * (1 - a)) / outA);
  }
  dst[i + 3] = Math.round(outA * 255);
}

/** Rounded rectangle with 1px analytic anti-aliasing on the edges. */
function roundedRect(canvas, x, y, w, h, radius, colour, alphaScale = 1) {
  const x0 = Math.floor(x - 2);
  const x1 = Math.ceil(x + w + 2);
  const y0 = Math.floor(y - 2);
  const y1 = Math.ceil(y + h + 2);
  const half = { x: x + w / 2, y: y + h / 2 };
  const halfW = w / 2;
  const halfH = h / 2;
  const r = Math.min(radius, halfW, halfH);
  const soft = 1.1;

  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const dx = Math.abs(px + 0.5 - half.x) - (halfW - r);
      const dy = Math.abs(py + 0.5 - half.y) - (halfH - r);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const inside = Math.max(dx, dy) <= 0 ? -Math.min(r, Math.max(halfW, halfH)) : -outside + r;
      const distance = Math.max(dx, dy) <= 0 ? inside : outside - r;
      const coverage = 1 - Math.min(1, Math.max(0, (distance + 0.5) / soft));
      if (coverage > 0) blend(canvas, px, py, colour, coverage * alphaScale);
    }
  }
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// -------------------------------------------------------------- the drawing --

const COLORS = {
  cached: [229, 72, 77],
  uncached: [48, 164, 108],
  dotcom: [142, 78, 198],
  glow: [76, 141, 255],
};

function drawIcon() {
  const canvas = createCanvas(SIZE);
  const margin = 52;
  const plate = SIZE - margin * 2;

  // plate: vertical gradient, light at the top like macOS icon plates
  for (let y = 0; y < SIZE; y += 1) {
    const t = y / (SIZE - 1);
    const colour = [lerp(38, 18, t), lerp(42, 20, t), lerp(52, 26, t)];
    for (let x = 0; x < SIZE; x += 1) blend(canvas, x, y, colour, 0);
  }
  // fill the plate shape with the gradient
  const gradientPlate = createCanvas(SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const t = y / (SIZE - 1);
    const colour = [lerp(40, 17, t), lerp(44, 19, t), lerp(56, 25, t)];
    for (let x = 0; x < SIZE; x += 1) blend(gradientPlate, x, y, colour, 1);
  }
  // composite: plate mask * gradient + a soft inner highlight
  const radius = 196;
  for (let y = margin; y < SIZE - margin; y += 1) {
    for (let x = margin; x < SIZE - margin; x += 1) {
      const dx = Math.abs(x + 0.5 - SIZE / 2) - (plate / 2 - radius);
      const dy = Math.abs(y + 0.5 - SIZE / 2) - (plate / 2 - radius);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const coverage = 1 - Math.min(1, Math.max(0, outside - radius + 0.5));
      if (coverage <= 0) continue;
      const i = (y * SIZE + x) * 4;
      const src = gradientPlate.data;
      blend(canvas, x, y, [src[i], src[i + 1], src[i + 2]], coverage);
      // top highlight
      const highlight = Math.max(0, 1 - y / (SIZE * 0.5)) * 0.06;
      if (highlight > 0) blend(canvas, x, y, [255, 255, 255], highlight * coverage);
    }
  }

  // chart bars, growing left to right, in the app's own metric colours
  const barX = 236;
  const barH = 74;
  const gap = 46;
  const top = 300;
  const lengths = [300, 430, 560];
  const colours = [COLORS.cached, COLORS.uncached, COLORS.dotcom];

  lengths.forEach((length, index) => {
    const y = top + index * (barH + gap);
    // a dark inset slot behind each bar, so short bars still read as data
    roundedRect(canvas, barX - 14, y - 10, 596, barH + 20, (barH + 20) / 2, [10, 12, 16], 0.55);
    roundedRect(canvas, barX, y, length, barH, barH / 2, colours[index], 1);
    // a soft line under each bar, echoing the axis
    roundedRect(canvas, barX, y + barH + 14, 560, 6, 3, [255, 255, 255], 0.10);
  });

  // resolver mark: three dots under the bars, suggesting the status list
  [COLORS.dotcom, COLORS.uncached, COLORS.cached].forEach((colour, index) => {
    roundedRect(canvas, barX + 8 + index * 44, 838, 26, 26, 13, colour, 0.9);
  });
  return canvas;
}

function main() {
  const outPath = process.argv[2] || path.join(__dirname, '..', 'build', 'icon.png');
  const canvas = drawIcon();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const png = encodePNG(SIZE, SIZE, canvas.data);
  fs.writeFileSync(outPath, png);

  // report the colours actually present so a silently blank icon is obvious
  const found = new Set();
  for (let y = 0; y < SIZE; y += 3) {
    for (let x = 0; x < SIZE; x += 3) {
      const i = (y * SIZE + x) * 4;
      if (canvas.data[i + 3] < 200) continue;
      for (const [name, colour] of Object.entries(COLORS)) {
        if (
          Math.abs(canvas.data[i] - colour[0]) < 6 &&
          Math.abs(canvas.data[i + 1] - colour[1]) < 6 &&
          Math.abs(canvas.data[i + 2] - colour[2]) < 6
        ) {
          found.add(name);
        }
      }
    }
  }
  process.stdout.write(
    `wrote ${outPath} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB); metric colours present: ${[...found].join(', ') || 'none'}\n`,
  );
}

main();
