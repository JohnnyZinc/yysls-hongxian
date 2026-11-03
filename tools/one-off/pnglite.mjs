// 零依赖 PNG 读写（RGBA8 / RGB8，非交错）。仅供构建脚本使用。
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG: ' + file);
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持交错 PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持 colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  // 统一转 RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (colorType === 3) {
      const pi = out[i];
      r = palette[pi * 3]; g = palette[pi * 3 + 1]; b = palette[pi * 3 + 2];
      if (trns && pi < trns.length) a = trns[pi];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width: w, height: h, data: rgba };
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunks = [];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  chunks.push(SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ---- 几何小工具 ----
export function sample(px, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const g = (xx, yy) => {
    const cx = Math.min(w - 1, Math.max(0, xx)), cy = Math.min(h - 1, Math.max(0, yy));
    const i = (cy * w + cx) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  };
  const p00 = g(x0, y0), p10 = g(x0 + 1, y0), p01 = g(x0, y0 + 1), p11 = g(x0 + 1, y0 + 1);
  const out = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    out[k] = Math.round(
      p00[k] * (1 - fx) * (1 - fy) + p10[k] * fx * (1 - fy) +
      p01[k] * (1 - fx) * fy + p11[k] * fx * fy
    );
  }
  return out;
}

export function resizeBilinear(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * sh / dh - 0.5;
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * sw / dw - 0.5;
      const p = sample(src, sw, sh, sx, sy);
      const i = (y * dw + x) * 4;
      out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2]; out[i + 3] = p[3];
    }
  }
  return out;
}

// Lanczos3 重采样：放大时比双线性更保高频，用于截图素材归一化
function lanczos(x, a = 3) {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

export function resizeLanczos(src, sw, sh, dw, dh, a = 3) {
  const tmp = new Float32Array(dw * sh * 4);
  const taps = [];
  for (let x = 0; x < dw; x++) {
    const sx = (x + 0.5) * sw / dw - 0.5;
    const i0 = Math.floor(sx) - a + 1;
    let sum = 0;
    const list = [];
    for (let i = 0; i <= 2 * a; i++) {
      const wv = lanczos(sx - (i0 + i), a);
      if (wv !== 0) { list.push([i0 + i, wv]); sum += wv; }
    }
    taps[x] = list.map(([i, wv]) => [i, wv / sum]);
  }
  const clampI = (v, n) => Math.min(n - 1, Math.max(0, v));
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4;
      for (const [i, wv] of taps[x]) {
        const s = (y * sw + clampI(i, sw)) * 4;
        for (let k = 0; k < 4; k++) tmp[o + k] += src[s + k] * wv;
      }
    }
  }
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * sh / dh - 0.5;
    const j0 = Math.floor(sy) - a + 1;
    let sum = 0;
    const list = [];
    for (let j = 0; j <= 2 * a; j++) {
      const wv = lanczos(sy - (j0 + j), a);
      if (wv !== 0) { list.push([j0 + j, wv]); sum += wv; }
    }
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4;
      const acc = [0, 0, 0, 0];
      for (const [j, wv0] of list) {
        const s = (clampI(j, sh) * dw + x) * 4;
        const wv = wv0 / sum;
        for (let k = 0; k < 4; k++) acc[k] += tmp[s + k] * wv;
      }
      for (let k = 0; k < 4; k++) out[o + k] = Math.max(0, Math.min(255, Math.round(acc[k])));
    }
  }
  return out;
}

export function bbox(px, w, h, pred) {  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (pred(px[i], px[i + 1], px[i + 2], px[i + 3], x, y)) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
