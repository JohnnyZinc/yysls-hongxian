# -*- coding: utf-8 -*-
"""核验无字底图: 尺寸一致、alpha 外形完全一致、中部无残留亮文字像素、背景未变白。"""
import os, glob, numpy as np, cv2
from PIL import Image

BASE = r"C:\Users\johnn\Documents\PARA\01Projects\yysls\素材库\official\xinfa"
SRC = os.path.join(BASE, "liupai_pic_big_url")
OUT = os.path.join(BASE, "liupai_pic_bg_big_url")

def load(p):
    return np.array(Image.open(p).convert("RGBA"))

files = sorted(glob.glob(os.path.join(SRC, "*.png")))
all_ok = True
for f in files:
    name = os.path.basename(f)
    op = os.path.join(OUT, name)
    if not os.path.exists(op):
        print("[缺失]", name); all_ok = False; continue
    a0, a1 = load(f), load(op)
    size_ok = a0.shape == a1.shape
    alpha_same = np.array_equal(a0[:, :, 3], a1[:, :, 3])
    rgb1, al1 = a1[:, :, :3], a1[:, :, 3]
    gray1 = cv2.cvtColor(rgb1, cv2.COLOR_RGB2GRAY)
    sat1 = rgb1.max(axis=2) - rgb1.min(axis=2)
    opaque = al1 > 30
    mid = np.zeros_like(opaque); mid[:, 40:220] = True
    resid = opaque & mid & (gray1 > 130) & (sat1 < 55)
    bg_gray = np.median(gray1[opaque])
    ok = size_ok and alpha_same and int(resid.sum()) == 0
    all_ok &= ok
    print("[%s] %-42s size=%s alpha_same=%s 中部残留=%d 背景中位灰度=%.0f" %
          ("OK" if ok else "!!", name, size_ok, alpha_same, int(resid.sum()), bg_gray))

print("\n总体:", "全部通过" if all_ok else "存在问题, 见上方 !! 项")
