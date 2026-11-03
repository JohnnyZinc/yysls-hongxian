"""把楷体分片合并成一个按站点用字裁剪的子集（2026-11-03 性能优化用，一次性但可复跑）。

背景：站点原先把文鼎楷按 unicode 区间切成 71 个 woff2（共 2.76MB），浏览器要发 90+ 个请求；
GitHub Pages 跨境 RTT 下这是首屏最大的瓶颈。改成「合并 → 只留站点真正用到的字 → 单个 woff2」
之后是 1 个请求 / ~357KB。

前置条件：
  1. assets/fonts/kai/*.woff2  仍是那 71 个原始分片。
     子集上线后分片已从仓库删除；需要重跑时先从 git 历史取回，例如：
         git archive 90bae96^ assets/fonts/kai | tar -x
     或  git checkout <分片还在的那个提交> -- assets/fonts/kai
     （90bae96 是「字体子集化」那个提交，取它的父提交即可。）
  2. Python 3 且能 import fontTools、brotli。
     DSH 沙箱里 pip 装不进全局，可以只装到临时目录：
         python -m pip download fonttools brotli -d <临时目录>   # 或直接从镜像下 wheel
         # 解压 wheel 后
         PYTHONPATH=<wheel 解压目录> python tools/one-off/font_subset.py

用法：
    python tools/one-off/font_subset.py            # 合并 + 裁剪 + 覆盖 assets/fonts/kai/gkai00mp.woff2
    python tools/one-off/font_subset.py --keep-all # 只合并、不裁剪（调试用，产物会很大）

改文案后如果新出现生僻字，重跑本脚本即可补字；不补也不会崩，只是那几个字走系统楷体回退。
"""
import glob
import pathlib
import sys

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
KAI_DIR = ROOT / 'assets/fonts/kai'
OUT = KAI_DIR / 'gkai00mp.woff2'
MERGED = ROOT / '.tmp/fonts/merged.ttf'
KEEP_ALL = '--keep-all' in sys.argv


def collect_chars() -> str:
    texts = []
    for pat in ['index.html', 'web/*.js', 'web/*.css']:
        texts += [p.read_text(encoding='utf-8', errors='ignore') for p in ROOT.glob(pat)]
    for pat in ['data/**/*.json', '知识库/*.md']:
        texts += [p.read_text(encoding='utf-8', errors='ignore') for p in ROOT.glob(pat)]
    chars = {c for t in texts for c in t if ord(c) >= 32}
    chars.update(chr(o) for o in range(32, 127))  # ASCII 可打印字符恒留
    return ''.join(sorted(chars))


def main() -> None:
    shards = sorted(glob.glob(str(KAI_DIR / '*.woff2')))
    if len(shards) < 2:
        sys.exit(f'没找到分片（{KAI_DIR}/*.woff2）；请先从 git 历史取回 71 个原始分片再跑。')

    print(f'分片 {len(shards)} 个，开始合并…')
    merged = Merger().merge(shards)  # 必须传路径；传 TTFont 对象会 TypeError
    MERGED.parent.mkdir(parents=True, exist_ok=True)
    merged.flavor = None
    merged.save(str(MERGED))
    cmap = merged.getBestCmap()
    print(f'合并完成：{len(cmap)} 个码位 / {len(merged.getGlyphOrder())} 个字形 → {MERGED}')

    if KEEP_ALL:
        unicodes = sorted(cmap)
    else:
        chars = collect_chars()
        unicodes = sorted({ord(c) for c in chars})
        missing = [u for u in unicodes if u not in cmap]
        print(f'站点用字 {len(unicodes)} 个；字体缺 {len(missing)} 个（这些字会走系统楷体回退）')
        if missing:
            print('  缺字：', ''.join(chr(u) for u in missing).encode('unicode_escape').decode())

    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = []   # 站点不用 OpenType 特性，关掉能再省不少
    opts.name_IDs = ['*']
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.drop_tables += ['DSIG']

    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(merged)
    merged.flavor = 'woff2'
    merged.save(str(OUT))
    print(f'子集完成：{OUT.stat().st_size / 1024:.1f}KB → {OUT.relative_to(ROOT)}')
    print('记得：assets/fonts/kai/kai.css 里 @font-face 的 src 要指向这个文件（现在已经是了）')


if __name__ == '__main__':
    main()
