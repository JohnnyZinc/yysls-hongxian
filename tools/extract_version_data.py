# -*- coding: utf-8 -*-
"""从装备面板计算器 v0.1 提取版本数据包 → data/version/nanlvxianghe-shang.115.json

提取策略：按"行名"读取（归一化"最小外功攻击"→"最小外功"等），
不依赖行号，避免 v0.1 各表行名/行位不一致的坑。
换算系数（判定抗性/增益抗性/五维贡献）硬编码自主表 W 列公式，附注释。
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
from openpyxl import load_workbook

XLSX = r"C:\Users\johnn\Downloads\装备面板计算器0.1.xlsx"
OUT = "data/version/nanlvxianghe-shang.115.json"

# 行名归一化：去"攻击"后缀统一为无后缀形态；伤害加成类统一
NORMALIZE = {
    "最小外功攻击": "最小外功", "最大外功攻击": "最大外功",
    "最小鸣金攻击": "最小鸣金", "最大鸣金攻击": "最大鸣金",
    "最小裂石攻击": "最小裂石", "最大裂石攻击": "最大裂石",
    "最小牵丝攻击": "最小牵丝", "最大牵丝攻击": "最大牵丝",
    "最小破竹攻击": "最小破竹", "最大破竹攻击": "最大破竹",
    "最小无相攻击": "最小无相", "最大无相攻击": "最大无相",
    "会心伤害加成": "会心伤害", "会意伤害加成": "会意伤害",
}


def norm(name):
    name = str(name).strip()
    return NORMALIZE.get(name, name)


def read_stat_rows(ws, wsv, col=2):
    """读取 A=属性名, col=数值 的纵向表 → {归一化属性名: 值}（同名累加）"""
    out = {}
    for r in range(2, ws.max_row + 1):
        name = ws.cell(row=r, column=1).value
        if name is None:
            continue
        v = wsv.cell(row=r, column=col).value
        if hasattr(v, "text"):
            v = v.text
        if not isinstance(v, (int, float)):
            continue
        key = norm(name)
        out[key] = out.get(key, 0) + v
    return out


def main():
    wb_f = load_workbook(XLSX, data_only=False)
    wb_v = load_workbook(XLSX, data_only=True)

    def sheet(name):
        return wb_f[name], wb_v[name]

    # ---- 固定层六表 ----
    fixed = {}
    for name in ["等级", "突破", "天赋", "蹊跷", "叠音", "装备基础数值"]:
        ws, wsv = sheet(name)
        fixed[name] = read_stat_rows(ws, wsv)

    # 用户假设：等级提供 35% 会心伤害 / 20% 会意伤害（游戏内未找到明确出处，待验证）
    fixed["等级"]["会心伤害"] = fixed["等级"].get("会心伤害", 0) + 0.35
    fixed["等级"]["会意伤害"] = fixed["等级"].get("会意伤害", 0) + 0.20

    # ---- 心法表：列=心法名 ----
    ws, wsv = sheet("心法")
    xinfa = {}
    for c in range(2, ws.max_column + 1):
        name = ws.cell(row=1, column=c).value
        if name is None:
            continue
        rec = {}
        for r in range(2, ws.max_row + 1):
            lab = ws.cell(row=r, column=1).value
            if lab is None:
                continue
            v = wsv.cell(row=r, column=c).value
            if isinstance(v, (int, float)):
                rec[norm(lab)] = v
        if rec:
            xinfa[str(name).strip()] = rec

    # ---- 武学天赋表：列=流派 ----
    ws, wsv = sheet("武学天赋")
    talents = {}
    for c in range(2, ws.max_column + 1):
        name = ws.cell(row=1, column=c).value
        if name is None:
            continue
        rec = {}
        for r in range(2, ws.max_row + 1):
            lab = ws.cell(row=r, column=1).value
            if lab is None:
                continue
            v = wsv.cell(row=r, column=c).value
            if hasattr(v, "text"):
                v = v.text
            if v is None:
                continue
            rec[norm(lab)] = v
        if rec:
            talents[str(name).strip()] = rec

    # ---- 弓玦 / 装备套装 / 武库：横向表 ----
    def read_horizontal(name):
        ws, wsv = sheet(name)
        out = {}
        cols = {}
        for c in range(2, ws.max_column + 1):
            v = ws.cell(row=1, column=c).value
            if v is not None:
                cols[c] = str(v).strip()
        for r in range(2, ws.max_row + 1):
            lab = ws.cell(row=r, column=1).value
            if lab is None:
                continue
            for c, cname in cols.items():
                v = wsv.cell(row=r, column=c).value
                if isinstance(v, (int, float)):
                    out.setdefault(cname, {})[norm(lab)] = v
        return out

    bundle = {
        "version": {
            "赛季": "南吕相和",
            "阶段": "上",
            "突破等级": 24,
            "装备等阶": 115,
            "source": os.path.basename(XLSX),
        },
        "constants": {
            "判定抗性": 1.8,
            "增益抗性": 0.32,
            "精准率基线": 0.65,
        },
        # 换算系数：来自主表 W 列公式（游戏数值，版本变动时随版本包更新）
        "五维贡献": {
            "最小外功": {"劲": 0.22, "敏": 0.9},
            "最大外功": {"劲": 1.36, "势": 0.9},
            "会心率": {"敏": 0.076 / 100},
            "会意率": {"势": 0.038 / 100},
        },
        "fixed": fixed,
        "心法": xinfa,
        "武学天赋": talents,
        "弓玦": read_horizontal("弓玦套装"),
        "装备套装": read_horizontal("装备套装"),
        "武库": read_horizontal("武库"),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, indent=2)
    print(f"-> {OUT}")
    print(f"心法 {len(xinfa)} 本, 武学天赋 {len(talents)} 流派, "
          f"弓玦 {len(bundle['弓玦'])}, 套装 {len(bundle['装备套装'])}, 武库 {len(bundle['武库'])}")


if __name__ == "__main__":
    main()
