# -*- coding: utf-8 -*-
"""完整导出装备面板计算器的所有工作表（公式+缓存值）"""
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

XLSX = r"C:\Users\johnn\Downloads\装备面板计算器0.1.xlsx"
wb_f = load_workbook(XLSX, data_only=False)
wb_v = load_workbook(XLSX, data_only=True)


def dump_sheet(name, max_col=None, max_row=None):
    ws, wsv = wb_f[name], wb_v[name]
    mr = max_row or ws.max_row
    mc = max_col or ws.max_column
    print(f"\n{'#'*70}\n# SHEET: {name}  ({mr}行 x {mc}列)\n{'#'*70}")
    for r in range(1, mr + 1):
        line = []
        for c in range(1, mc + 1):
            vf = ws.cell(row=r, column=c).value
            if vf is None:
                continue
            if hasattr(vf, "text"):
                vf = vf.text
            vv = wsv.cell(row=r, column=c).value
            if hasattr(vv, "text"):
                vv = vv.text
            coord = f"{get_column_letter(c)}{r}"
            if isinstance(vf, str) and vf.startswith("="):
                line.append(f"{coord}={vf!r}→{vv!r}")
            else:
                line.append(f"{coord}={vf!r}")
        if line:
            print("  " + " | ".join(line))


for name in ["弓玦套装", "装备套装", "武库", "等级", "突破", "天赋", "蹊跷", "叠音", "装备基础数值"]:
    dump_sheet(name)
dump_sheet("心法", max_col=15)   # 61列，先看前15列结构
dump_sheet("武学天赋", max_col=25)
