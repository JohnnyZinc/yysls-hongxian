# -*- coding: utf-8 -*-
"""导出 Excel 指定行的中间计算缓存值（按表头命名），供引擎逐事件对比。
用法: python dump_excel_rows.py <build_prefix> <row> [row...]
输出: data/debug/{build_id}/row{N}.json
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

WANT_HEADERS = [
    "类型", "外功倍率", "外攻固伤", "属性倍率", "属性固伤",
    "通用增伤", "外攻加成", "即时小外", "即时大外", "外穿加成", "外伤加成", "属攻加成",
    "即时小鸣", "即时大鸣", "鸣金穿透", "鸣金加成",
    "即时小裂", "即时大裂", "裂石穿透", "裂石加成",
    "即时小牵", "即时大牵", "牵丝穿透", "牵丝加成",
    "即时小破", "即时大破", "破竹穿透", "破竹加成",
    "生效精准", "生效会心", "生效会心伤害", "生效会意", "生效会意伤害",
    "会心占比", "普攻占比", "擦伤占比", "特殊增伤", "特定增伤", "结算增伤",
    "会心期望", "会意期望", "普通期望", "擦伤期望", "期望", "次数",
]

XLSX_BY_BUILD = {
    "pozhufeng.115.3.2": r"参考\破竹风115阶竞速轴属性毕业率进阶计算器3.2.xlsx",
    "qiansiyu.115.3.5": r"参考\牵丝玉115阶竞速轴属性毕业率进阶计算器3.5.xlsx",
    "pozhuchen.115.3.3": r"参考\破竹尘115阶竞速轴属性毕业率进阶计算器3.3.xlsx",
    "pozhuzun.115.3.6": r"参考\破竹樽115阶竞速轴属性毕业率进阶计算器3.6.xlsx",
    "pozhuzun.115.3.7": r"参考\破竹樽115阶竞速轴属性毕业率进阶计算器3.7.xlsx",
    "lieshiwei.115.3.1": r"参考\裂石威115阶竞速轴属性毕业率进阶计算器3.1.xlsx",
    "lieshiwei.115.3.3": r"参考\裂石威115阶竞速轴属性毕业率进阶计算器3.3.xlsx",
    "lieshijun.115.3.0": r"参考\裂石钧115阶竞速轴属性毕业率进阶计算器3.0.xlsx",
    "qiansilin.115.3.1": r"参考\牵丝霖115阶竞速轴属性毕业率进阶计算器3.1.xlsx",
    "qiansiyi.115.3.1": r"参考\牵丝翊115阶竞速轴属性毕业率进阶计算器3.1.xlsx",
    "pozhuyuan.115.3.0": r"参考\破竹鸢115阶竞速轴属性毕业率进阶计算器3.0.xlsx",
}

def main():
    prefix = sys.argv[1]
    rows = [int(x) for x in sys.argv[2:]]
    xlsx = XLSX_BY_BUILD[prefix]
    wbv = load_workbook(xlsx, data_only=True)
    ws = wbv["期望"]
    col2hdr = {}
    for c in range(1, ws.max_column + 1):
        h = ws.cell(row=1, column=c).value
        if h:
            col2hdr[c] = str(h).strip()
    outdir = os.path.join("data", "debug", prefix)
    os.makedirs(outdir, exist_ok=True)
    for r in rows:
        rec = {}
        for c, h in col2hdr.items():
            if h in WANT_HEADERS:
                v = ws.cell(row=r, column=c).value
                if hasattr(v, "text"):
                    v = v.text
                rec[h] = v
        out = os.path.join(outdir, f"row{r}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
        print(f"-> {out}")

if __name__ == "__main__":
    main()
