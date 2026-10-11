# -*- coding: utf-8 -*-
"""提取面板计算器 v0.1 主表 W 列缓存值作为 test_panel.js 的验证基准"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook

XLSX = r"C:\Users\johnn\Downloads\装备面板计算器0.1.xlsx"
wbv = load_workbook(XLSX, data_only=True)
ws = wbv["面板属性计算器"]

fixture = {}
for r in range(6, 52):
    label = ws.cell(row=r, column=1).value or ws.cell(row=r, column=20).value  # T列兜底
    v = ws.cell(row=r, column=23).value  # W列
    if label is None or v is None:
        continue
    fixture[str(label).strip()] = v

with open("data/debug/panel-v01-expected.json", "w", encoding="utf-8") as f:
    json.dump(fixture, f, ensure_ascii=False, indent=2)
print(f"-> data/debug/panel-v01-expected.json ({len(fixture)} 项)")
