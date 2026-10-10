# -*- coding: utf-8 -*-
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

# 检查各流派 期望表 E列 心法选择器 + 增益表 易水歌行的公式
files = [
    (r"参考\破竹风115阶竞速轴属性毕业率进阶计算器3.2.xlsx", "破竹风"),
    (r"参考\牵丝玉115阶竞速轴属性毕业率进阶计算器3.5.xlsx", "牵丝玉"),
    (r"参考\破竹尘115阶竞速轴属性毕业率进阶计算器3.3.xlsx", "破竹尘"),
    (r"参考\破竹樽115阶竞速轴属性毕业率进阶计算器3.6.xlsx", "破竹樽"),
    (r"参考\裂石威115阶竞速轴属性毕业率进阶计算器3.1.xlsx", "裂石威"),
    (r"参考\牵丝霖115阶竞速轴属性毕业率进阶计算器3.1.xlsx", "牵丝霖"),
]

for path, name in files:
    wbf = load_workbook(path, data_only=False)
    wbv = load_workbook(path, data_only=True)
    ws, wsv = wbf["期望"], wbv["期望"]
    print(f"===== {name} =====")
    # E15:F24 区域：团队勾选 + 第四心法选择器
    for r in range(15, 25):
        e = ws.cell(row=r, column=5).value
        f = ws.cell(row=r, column=6).value
        ev = wsv.cell(row=r, column=5).value
        if e is not None:
            print(f"  E{r}: {e!r}  (F{r}={f!r}, E{r}缓存={ev!r})")
    # 增益表 易水歌1层 行的公式
    ws2, ws2v = wbf["增益"], wbv["增益"]
    for r in range(2, ws2.max_row + 1):
        n = ws2.cell(row=r, column=1).value
        if n == "易水歌1层":
            b_formula = ws2.cell(row=r, column=2).value
            b_cached = ws2v.cell(row=r, column=2).value
            f_formula = ws2.cell(row=r, column=6).value
            f_cached = ws2v.cell(row=r, column=6).value
            print(f"  增益!易水歌1层: B列公式={b_formula!r} 缓存={b_cached!r}; "
                  f"F列公式={f_formula!r} 缓存={f_cached!r}")
            break
    print()
