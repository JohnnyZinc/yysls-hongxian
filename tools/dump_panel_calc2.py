# -*- coding: utf-8 -*-
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

XLSX = r"C:\Users\johnn\Downloads\装备面板计算器0.1.xlsx"
wb_f = load_workbook(XLSX, data_only=False)
wb_v = load_workbook(XLSX, data_only=True)

print("== 武学天赋 rows 1-25 全部 ==")
ws, wsv = wb_f["武学天赋"], wb_v["武学天赋"]
for r in range(1, 26):
    line = []
    for c in range(1, ws.max_column + 1):
        v = ws.cell(row=r, column=c).value
        if v is None:
            continue
        if hasattr(v, "text"):
            v = v.text
        line.append(f"{get_column_letter(c)}={v}")
    if line:
        print(f"  r{r}: " + " | ".join(line))

print()
print("== 心法 sheet 列名 (row1, 全部61列) ==")
ws, wsv = wb_f["心法"], wb_v["心法"]
names = []
for c in range(1, ws.max_column + 1):
    v = ws.cell(row=1, column=c).value
    if v is not None:
        names.append(f"{get_column_letter(c)}={v}")
print("  " + " | ".join(names))

print()
print("== 心法 sheet 行标签 (col A, rows 1-50) ==")
for r in range(1, 51):
    v = ws.cell(row=r, column=1).value
    if v is not None:
        print(f"  r{r}: {v}")

print()
print("== 心法 全部数据 (非空, B列起) rows 2-47 ==")
for r in range(2, 48):
    line = []
    for c in range(2, ws.max_column + 1):
        v = ws.cell(row=r, column=c).value
        if v is None:
            continue
        if hasattr(v, "text"):
            v = v.text
        line.append(f"{get_column_letter(c)}={v}")
    if line:
        lab = ws.cell(row=r, column=1).value
        print(f"  r{r}[{lab}]: " + " | ".join(line))
