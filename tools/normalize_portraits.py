# -*- coding: utf-8 -*-
"""
立绘归一化：把已经抠好透明底的图**只做对齐与缩放**，不重新抠图。

为什么要单独一支脚本：
  `tools/cutout.py` 是「白底原图 → 透明底」，抠图那步由它做；
  这里接的是**人工/外部工具抠好的成品**，只负责让四张在切换时不会跳：
    ① 人物高度统一（按 alpha 包围盒高度缩放）
    ② 脚底落在同一条基线
    ③ 左右不偏（按**头部中心**对齐 —— 换表情时眼睛盯着脸，头一跳最扎眼）
    ④ 四张画布**同宽同高**（410×1300）：尺寸完全一致，CSS 按右缘定位时连 2px 的
       横向漂移都不会有；留白是透明的，webp 压得掉

用法：python tools/normalize_portraits.py
输入：素材库/周红线/抠图/*.png（RGBA）
输出：web/assets/img/char/hongxian-<情绪>.webp + manifest.json
      母本 png 存 素材库/周红线/_抠图/
"""
import glob
import json
import os

import numpy as np
from PIL import Image

SRC = '素材库/周红线/抠图'
OUT = 'web/assets/img/char'      # 网页只用 webp（~90KB/张）
KEEP = '素材库/周红线/_抠图'      # 无损 png 母本，不进 web 目录

# 源文件名 → 情绪名
JOBS = [
    ('古风少女全身立像.png', 'idle'),
    ('古典汉服少女的亲切微笑.png', 'talk'),
    ('思索中的传统少女全身像.png', 'think'),
    ('害羞的汉服少女肖像.png', 'unsure'),
]

CANVAS_H = 1300      # 输出画布高（四张完全一样）
CANVAS_W = 410       # 输出画布宽（四张完全一样 —— 宽高一致，切图才不会左右跳）
FIG_H = 1180         # 人物统一高度
FEET_GAP = 18        # 脚底到画布下边
ALPHA = 24           # 超过这个 alpha 才算"人物"（滤掉边缘的淡雾）
HEAD_BAND = 0.10     # 顶部 10% 就是发髻，用它算头部水平中心


def normalize(img):
    a = np.asarray(img)[..., 3]
    ys, xs = np.where(a > ALPHA)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()

    fig = img.crop((x0, y0, x1 + 1, y1 + 1))
    scale = FIG_H / fig.height
    fig = fig.resize((max(1, round(fig.width * scale)), FIG_H), Image.LANCZOS)

    # 水平锚点用**头部中心**（顶部 10% 的左右中点）：
    # 换表情时玩家的眼睛盯着脸，头一跳就特别明显；裙摆中心跟头不一定在同一条竖线上。
    # 顶部 10% 只有发髻，抬手那张的手也进不来（手在 y≈300 以下）。
    fa = np.asarray(fig)[..., 3]
    band = fa[: int(FIG_H * HEAD_BAND)]
    bx = np.where(band.max(axis=0) > ALPHA)[0]
    anchor = (bx.min() + bx.max()) / 2 if bx.size else fig.width / 2

    canvas = Image.new('RGBA', (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    left = int(round(CANVAS_W / 2 - anchor))
    top = CANVAS_H - FEET_GAP - FIG_H
    canvas.alpha_composite(fig, (max(0, min(CANVAS_W - fig.width, left)), top))
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(KEEP, exist_ok=True)
    done = []
    for name, mood in JOBS:
        src = os.path.join(SRC, name)
        if not os.path.exists(src):
            print(f'!! 缺图：{src}')
            continue
        final = normalize(Image.open(src).convert('RGBA'))
        final.save(os.path.join(KEEP, f'hongxian-{mood}.png'), optimize=True)
        dst = os.path.join(OUT, f'hongxian-{mood}.webp')
        final.save(dst, quality=90, method=6)
        canvas = Image.new('RGBA', final.size, (24, 22, 20, 255))
        canvas.alpha_composite(final)
        canvas.convert('RGB').resize((260, round(260 * final.height / final.width)), Image.LANCZOS
                                     ).save(f'.tmp/norm-{mood}.png')
        done.append(mood)
        print(f'{mood:7s} {name}  {final.width}x{final.height}  {os.path.getsize(dst) // 1024} KB')

    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'moods': done}, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
