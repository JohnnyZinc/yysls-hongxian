// 把游戏内截图裁出的流派横幅，归一化成与官方 mind-tag 一致的 254x68。
// 用法: node tools/one-off/make_mind_tag.mjs <源图> <输出png> [锐化系数, 默认 0.6]
import { decodePng, encodePng, bbox, resizeLanczos } from './pnglite.mjs';
import fs from 'node:fs';

const [src, out, sharpArg] = process.argv.slice(2);
if (!src || !out) {
  console.error('用法: node tools/one-off/make_mind_tag.mjs <源图> <输出png> [锐化]');
  process.exit(1);
}
const SHARP = sharpArg === undefined ? 0.6 : Number(sharpArg);

const TW = 254, TH = 68;
// 参照标语（assets/img/mind-tag/POZHU_CHEN.png）的实测值：墨块 252x68 出血满高
const TARGET_INK_W = 252, TARGET_INK_H = 68;

const im = decodePng(src);
const { width: sw, height: sh, data: sp } = im;

// 1) 定位墨块（不透明且偏暗的像素）：比 alpha 边界更稳，不受外围羽化干扰
const ink = bbox(sp, sw, sh, (r, g, b, a) => a > 128 && (r + g + b) / 3 < 150);
if (ink.w < 40 || ink.h < 20) throw new Error('没找到墨块，源图可能不是横幅截图');
const inkCx = (ink.x0 + ink.x1 + 1) / 2;
const inkCy = (ink.y0 + ink.y1 + 1) / 2;
const factor = TARGET_INK_H / ink.h;

// 2) 反向推算裁剪框：让墨块缩放后正好等于目标尺寸并居中
const cw = TW / factor, ch = TH / factor;
const cx0 = inkCx - cw / 2, cy0 = inkCy - ch / 2;
// 取整后裁剪，几何误差 <1px；比浮点双线性更利落，也便于走 Lanczos
const ix0 = Math.round(cx0), iy0 = Math.round(cy0);
const iw = Math.round(cw), ih = Math.round(ch);
if (ix0 < 0 || iy0 < 0 || ix0 + iw > sw || iy0 + ih > sh) throw new Error('裁剪框越界，源图留白不足');

// 3) alpha 预乘后重采样，避免透明区的黑底渗进边缘（否则会出黑边）
const pre = Buffer.alloc(sw * sh * 4);
for (let i = 0; i < sw * sh; i++) {
  const a = sp[i * 4 + 3] / 255;
  pre[i * 4] = sp[i * 4] * a;
  pre[i * 4 + 1] = sp[i * 4 + 1] * a;
  pre[i * 4 + 2] = sp[i * 4 + 2] * a;
  pre[i * 4 + 3] = sp[i * 4 + 3];
}
const crop = Buffer.alloc(iw * ih * 4);
for (let y = 0; y < ih; y++) {
  pre.copy(crop, y * iw * 4, ((iy0 + y) * sw + ix0) * 4, ((iy0 + y) * sw + ix0 + iw) * 4);
}
const dst = resizeLanczos(crop, iw, ih, TW, TH, 3);

// 4) 轻度锐化补偿截图缩放损失。只作用于颜色，alpha 用原始值再合成，避免边缘出现白/黑圈
if (SHARP > 0) {
  const blurred = Buffer.from(dst);
  const K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const o = (y * TW + x) * 4;
      for (let k = 0; k < 3; k++) {
        let acc = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= TW || ny >= TH) continue;
            const wt = K[(dy + 1) * 3 + dx + 1];
            acc += dst[(ny * TW + nx) * 4 + k] * wt;
            n += wt;
          }
        }
        blurred[o + k] = Math.round(acc / n);
      }
    }
  }
  for (let i = 0; i < TW * TH; i++) {
    const o = i * 4;
    const a = dst[o + 3];
    if (a < 8) continue;
    // 此时仍是预乘空间，上界不能超过 alpha，否则反预乘后被截断成硬边
    for (let k = 0; k < 3; k++) {
      const v = dst[o + k] + (dst[o + k] - blurred[o + k]) * SHARP;
      dst[o + k] = Math.max(0, Math.min(a, v));
    }
  }
}

// 5) 反预乘还原直通 alpha
for (let i = 0; i < TW * TH; i++) {
  const o = i * 4, a = dst[o + 3];
  if (a === 0) { dst[o] = 255; dst[o + 1] = 255; dst[o + 2] = 255; continue; }
  const inv = 255 / a;
  for (let k = 0; k < 3; k++) dst[o + k] = Math.min(255, Math.round(dst[o + k] * inv));
}

fs.writeFileSync(out, encodePng(TW, TH, dst));
const nb = bbox(dst, TW, TH, (r, g, b, a) => a > 128 && (r + g + b) / 3 < 150);
const tb = bbox(dst, TW, TH, (r, g, b, a) => a > 128 && (r + g + b) / 3 > 175);
console.log(`源 ${sw}x${sh} 墨块 ${ink.w}x${ink.h} → 缩放 ${factor.toFixed(4)}x`);
console.log(`输出 ${out}  墨块 ${nb.w}x${nb.h} x:[${nb.x0},${nb.x1}] y:[${nb.y0},${nb.y1}]`);
console.log(`文字 ${tb.w}x${tb.h} x:[${tb.x0},${tb.x1}] y:[${tb.y0},${tb.y1}] 中心 ${((tb.x0 + tb.x1) / 2).toFixed(1)}`);
