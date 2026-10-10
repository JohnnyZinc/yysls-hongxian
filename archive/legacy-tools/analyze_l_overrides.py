# -*- coding: utf-8 -*-
"""分析各流派 L 列公式结构 + 真正的覆盖行"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

FILES = [
    (r"参考\破竹风115阶竞速轴属性毕业率进阶计算器3.2.xlsx", "pozhufeng.115.3.2"),
    (r"参考\牵丝玉115阶竞速轴属性毕业率进阶计算器3.5.xlsx", "qiansiyu.115.3.5"),
    (r"参考\破竹尘115阶竞速轴属性毕业率进阶计算器3.3.xlsx", "pozhuchen.115.3.3"),
    (r"参考\破竹樽115阶竞速轴属性毕业率进阶计算器3.6.xlsx", "pozhuzun.115.3.6"),
    (r"参考\裂石威115阶竞速轴属性毕业率进阶计算器3.1.xlsx", "lieshiwei.115.3.1"),
    (r"参考\牵丝霖115阶竞速轴属性毕业率进阶计算器3.1.xlsx", "qiansilin.115.3.1"),
]


def norm(f):
    """把行号归一为#，便于比较公式结构"""
    if not isinstance(f, str):
        return None
    return re.sub(r"(\$?[A-Za-z]{1,3})(\d+)", r"\1#", f)


for path, prefix in FILES:
    wbf = load_workbook(path, data_only=False)
    ws = wbf["期望"]
    print("=" * 70)
    print(prefix)
    # row1 M/N/O/P 列头
    hdr = {}
    for c in range(1, 55):
        v = ws.cell(row=1, column=c).value
        if v is not None:
            hdr[get_column_letter(c)] = v
    print("row1 headers A-BB:", {k: v for k, v in hdr.items() if k in
          [get_column_letter(i) for i in range(10, 30)]})
    l2 = ws["L2"].value
    if hasattr(l2, "text"):
        l2 = l2.text
    print("L2模板:", str(l2)[:120])
    tpl = norm(l2)
    # 扫描真正的覆盖行
    overrides = []
    for r in range(2, ws.max_row + 1):
        skill = ws.cell(row=r, column=18).value or ws.cell(row=r, column=17).value
        if skill is None or not str(skill).strip():
            continue
        lv = ws.cell(row=r, column=12).value
        if hasattr(lv, "text"):
            lv = lv.text
        if isinstance(lv, str) and lv.startswith("=") and norm(lv) != tpl:
            overrides.append((r, str(skill).strip(), lv))
    print(f"真正的L覆盖行: {len(overrides)}")
    for r, s, f in overrides[:4]:
        print(f"  row{r} [{s}]: {f[:200]}")
    print()
