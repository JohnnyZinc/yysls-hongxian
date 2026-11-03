# -*- coding: utf-8 -*-
"""
立绘抠图 + 对齐归一化（一次性工具，产物进 assets/img/char/）。

做法：
  1. 从边框取背景色（四张都是浅灰白渐变，取边框环中位数）
  2. 只把「与背景足够接近 **且** 与边框连通」的像素判为背景 ——
     不按颜色一刀切，否则白色衣袖会被一起抠掉
  3. 收缩 1px 再高斯羽化，去掉边缘残留的白边
  4. 边缘像素做去背景色污染（unpremultiply），深色面板上不会发光
  5. 四张按「人物高度」统一缩放、脚底对齐、头部中线对齐 ——
     出图时身高略有差异，不归一化切换时会跳

用法：python tools/cutout.py
"""
import json
import os
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SRC = '素材库/周红线'
OUT = 'assets/img/char'      # 网页只用 webp（90KB/张）
KEEP = '素材库/周红线/_抠图'      # 无损 png 母本留在素材库，不进 web 目录

# 源文件 → 情绪名（生气那张还没出，代码里会回退到 idle）
JOBS = [
    ('古风少女全身立像.png', 'idle'),
    ('古典汉服少女的亲切微笑.png', 'talk'),
    ('思索中的传统少女全身像.png', 'think'),
    ('害羞的汉服少女肖像.png', 'unsure'),
]

CANVAS_W, CANVAS_H = 800, 1300   # 输出画布（约 2:3.25）
FIG_H = 1180                     # 人物归一化高度
FEET_GAP = 18                    # 脚底到画布下边
HEAD_BAND = 0.22                 # 取人物顶部 22% 算头部中线，用它做水平对齐


def cutout(path):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    h, w, _ = a.shape

    # —— 1. 背景色：边框环的中位数（带点渐变，取中位数比取角点稳）——
    ring = np.concatenate([
        a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3),
        a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3),
    ])
    bg = np.median(ring, axis=0)

    # —— 2. 与背景的色差（按人眼权重，绿色最敏感）——
    d = a - bg
    dist = np.sqrt(0.299 * d[..., 0] ** 2 + 0.587 * d[..., 1] ** 2 + 0.114 * d[..., 2] ** 2)

    similar = dist < 14.0
    seed = np.zeros_like(similar)
    seed[0, :] = seed[-1, :] = True
    seed[:, 0] = seed[:, -1] = True
    seed &= similar
    outside = ndi.binary_propagation(seed, mask=similar)   # 与边框连通的背景

    # —— 3b. 脚下一圈**被围住的**背景：鞋子、裙摆、地面投影把它围起来，
    #    与边框不连通，光靠 flood fill 抠不掉，深色面板上会留一块浅灰。
    #    只在下面 14% 里做（那一段除了鞋和裙摆没有浅色衣物），从「确定是背景」的
    #    内芯往外长，长到色差 34 为止 —— 正好停在鞋面和裙摆上。
    band = np.zeros_like(similar)
    band[int(h * 0.86):, :] = True
    pocket_seed = band & (dist < 12) & ~outside
    pocket_mask = band & (dist < 34)
    outside |= ndi.binary_propagation(pocket_seed, mask=pocket_mask)

    solid = ~outside

    # —— 3. 收缩 + 羽化：先去白边，再让边缘柔和 ——
    solid = ndi.binary_erosion(solid, iterations=1)
    alpha = ndi.gaussian_filter(solid.astype(np.float32), sigma=0.9)
    alpha = np.clip((alpha - 0.12) / 0.76, 0, 1)           # 提一点对比，别糊成一圈灰

    # —— 4. 去背景色污染：边缘像素里混进去的浅灰白，按 alpha 反解掉 ——
    er = alpha[..., None]
    edge = (alpha > 0.02) & (alpha < 0.985)
    safe = np.maximum(er, 0.20)
    clean = (a - (1.0 - er) * bg) / safe
    a = np.where(edge[..., None], np.clip(clean, 0, 255), a)

    out = np.dstack([a, alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def normalize(img):
    """按人物包围盒缩放/对齐：高度统一、脚底贴底、头部中线居中"""
    al = np.asarray(img)[..., 3]
    ys, xs = np.where(al > 24)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    fig_h = y1 - y0 + 1
    scale = FIG_H / fig_h

    fig = img.crop((x0, y0, x1 + 1, y1 + 1))
    fig = fig.resize((max(1, round(fig.width * scale)), FIG_H), Image.LANCZOS)

    # 头部中线：取顶部 22% 的 alpha 质心（这段只有头和发髻，左右对称，最稳）
    fa = np.asarray(fig)[..., 3]
    band = fa[: int(FIG_H * HEAD_BAND), :]
    xs2 = np.where(band > 24)[1]
    head_cx = (xs2.min() + xs2.max()) / 2 if xs2.size else fig.width / 2

    canvas = Image.new('RGBA', (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    left = int(round(CANVAS_W / 2 - head_cx))
    top = CANVAS_H - FEET_GAP - FIG_H
    if left >= 0:
        canvas.alpha_composite(fig, (left, top))
    else:
        canvas.alpha_composite(fig.crop((-left, 0, fig.width, FIG_H)), (0, top))

    # 横向收进人物包围盒（左右各留 10px）：
    # 画布留大片透明会让前端按 width/height 算出的比例失真 ——
    # 一张 800 宽、人物只占 400 的图，看起来"很小"，怎么调 CSS 都不对。
    ca = np.asarray(canvas)[..., 3]
    xs = np.where(ca.max(axis=0) > 8)[0]
    if xs.size:
        pad = 10
        canvas = canvas.crop((max(0, xs.min() - pad), 0, min(CANVAS_W, xs.max() + 1 + pad), CANVAS_H))
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    done = []
    for name, mood in JOBS:
        src = os.path.join(SRC, name)
        cut = cutout(src)
        final = normalize(cut)
        os.makedirs(KEEP, exist_ok=True)
        final.save(os.path.join(KEEP, f'hongxian-{mood}.png'), optimize=True)
        dst = os.path.join(OUT, f'hongxian-{mood}.webp')
        final.save(dst, quality=88, method=6)
        # 便于核对：把缩略图铺到深色底上看看有没有白边/残底
        chk = Image.new('RGBA', final.size, (24, 22, 20, 255))
        chk.alpha_composite(final)
        chk.convert('RGB').resize((240, round(240 * CANVAS_H / CANVAS_W)), Image.LANCZOS
                                  ).save(f'.tmp/cut-{mood}.png')
        done.append(mood)
        print(f'{mood:7s} {name}  {os.path.getsize(dst) // 1024} KB')

    # 清单：前端按它决定渲染哪几张（缺的情绪自动回退到 idle，不产生 404）
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'moods': done}, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
