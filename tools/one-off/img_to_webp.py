"""把一个/一批 PNG 转成 WebP（2026-11-03 性能优化用）。

为什么：首屏背景、心法卡底、流派横幅这些大图原本是 PNG，转 WebP（q86）后体积掉到 1/3 左右，
观感几乎无差（这些图本来就带透明通道或大色块渐变）。

用法：
    python tools/one-off/img_to_webp.py assets/img/bg/golden.png [...]
    python tools/one-off/img_to_webp.py --dir assets/img/mind-card      # 目录下所有 png
    python tools/one-off/img_to_webp.py --dir assets/img/mind-card --delete   # 转换成功后删原图

转换完记得改引用：data/version/<赛季>/version.json 的「界面图片」短路径、web/studio.css 的 url()、
index.html 里的 preload（如果有），然后跑 `npm run check:site` —— 第 9 项会逐个验证界面图片存在。
"""
import pathlib
import sys

from PIL import Image

QUALITY = 86
args = [a for a in sys.argv[1:] if not a.startswith('--')]
DELETE = '--delete' in sys.argv
DIRS = [args[i + 1] for i, a in enumerate(sys.argv) if a == '--dir' and i + 1 < len(sys.argv)]
targets = [pathlib.Path(a) for a in args if a != '-']
for d in DIRS:
    targets += sorted(pathlib.Path(d).glob('*.png'))

if not targets:
    sys.exit('用法：python tools/one-off/img_to_webp.py <png...> 或 --dir <目录>')

total_before = total_after = 0
for p in targets:
    if not p.exists() or p.suffix.lower() != '.png':
        print(f'SKIP {p}')
        continue
    im = Image.open(p)
    has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
    im = im.convert('RGBA' if has_alpha else 'RGB')
    out = p.with_suffix('.webp')
    before = p.stat().st_size
    im.save(out, 'WEBP', quality=QUALITY, method=6)
    after = out.stat().st_size
    total_before += before
    total_after += after
    print(f'{p}: {before / 1024:.1f}KB → {after / 1024:.1f}KB  {im.size} alpha={has_alpha}')
    if DELETE:
        p.unlink()

print(f'合计 {total_before / 1024:.1f}KB → {total_after / 1024:.1f}KB，省 {(total_before - total_after) / 1024:.1f}KB')
