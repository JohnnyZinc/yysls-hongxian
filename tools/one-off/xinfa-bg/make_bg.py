# -*- coding: utf-8 -*-
"""批量擦除流派横版标签上的白色书法文字/间隔点, 输出纯笔触背景底图。
保留: 毛笔墨渍色块、左上角暗纹装饰、边缘飞白透明外形。
输入: 素材库/official/xinfa/liupai_pic_big_url/*.png  (254x68 RGBA)
输出: 素材库/official/xinfa/liupai_pic_bg_big_url/<同名>.png  (尺寸与格式不变)
用法: python make_bg.py
"""
import os, glob, numpy as np, cv2
from PIL import Image

BASE = r"C:\Users\johnn\Documents\PARA\01Projects\yysls\素材库\official\xinfa"
SRC_DIR = os.path.join(BASE, "liupai_pic_big_url")
OUT_DIR = os.path.join(BASE, "liupai_pic_bg_big_url")

GTH = 150          # 高亮文字灰度阈值
SAT_LIM = 55       # 白色低饱和上限
DILATE = 1         # 抗锯齿边缘膨胀像素
OPAQUE_MIN = 30    # alpha 外形判定下限
INPAINT_R = 3

def process_one(arr):
    rgb = arr[:, :, :3].copy()
    alpha = arr[:, :, 3].copy()
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    opaque = alpha > OPAQUE_MIN
    text = opaque & (gray > GTH) & (sat < SAT_LIM)
    mask = text.astype(np.uint8) * 255
    if DILATE > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        mask = cv2.dilate(mask, k, iterations=DILATE)
    mask[~opaque] = 0  # 不破坏飞白透明外形
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    bgr = cv2.inpaint(bgr, mask, INPAINT_R, cv2.INPAINT_TELEA)
    out_rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    out = np.dstack([out_rgb, alpha])
    return out, int((mask > 0).sum())

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    files = sorted(f for f in glob.glob(os.path.join(SRC_DIR, "*.png")))
    n = 0
    for f in files:
        name = os.path.basename(f)
        im = Image.open(f).convert("RGBA")
        w0, h0 = im.size
        out, removed = process_one(np.array(im))
        Image.fromarray(out, "RGBA").save(os.path.join(OUT_DIR, name))
        n += 1
        print("%-42s %dx%d removed=%d" % (name, w0, h0, removed))
    print("done: %d -> %s" % (n, OUT_DIR))

if __name__ == "__main__":
    main()
