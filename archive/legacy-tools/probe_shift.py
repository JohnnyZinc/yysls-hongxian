# -*- coding: utf-8 -*-
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

for path in [r"参考\裂石威115阶竞速轴属性毕业率进阶计算器3.1.xlsx",
             r"参考\牵丝霖115阶竞速轴属性毕业率进阶计算器3.1.xlsx"]:
    print("=" * 60)
    print("FILE:", path.split("\\")[-1])
    wbv = load_workbook(path, data_only=True)
    ws = wbv["期望"]
    print("-- row1 headers cols 14-42:")
    for c in range(14, 43):
        v = ws.cell(row=1, column=c).value
        if v is not None:
            print(f"   {get_column_letter(c)}({c}): {v}")
    print("-- sample rows 2-4, cols 15-21:")
    for r in range(2, 5):
        vals = []
        for c in range(15, 22):
            v = ws.cell(row=r, column=c).value
            vals.append(f"{get_column_letter(c)}={v!r}")
        print("   ", " | ".join(vals))
    ws2 = wbv["武学奇术"]
    ae_vals = [ws2.cell(row=r, column=31).value for r in range(2, 8)]
    print("-- 武学奇术 AE(31) rows2-7:", ae_vals)
    wbf = load_workbook(path, data_only=False)
    print("-- I16公式:", wbf["期望"]["I16"].value)

print()
print("== 检查现有 pozhufeng JSON 的 panel_input 是否被污染 ==")
with open("data/pozhufeng.115.3.5.json", encoding="utf-8") as f:
    d = json.load(f)
for k, v in d["panel_input"].items():
    print(f"  {k}: default={v['default']!r} label={v['label']!r}")
