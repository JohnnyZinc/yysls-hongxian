# -*- coding: utf-8 -*-
"""
从破竹风 Excel 计算器提取 JSON：
  - skills.json        <- 武学奇术表
  - effects.json       <- 增益表
  - pozhufeng.json     <- 期望表：面板schema + 怪物参数 + build配置 + 时间轴(增益标注)
"""
import json, re, sys
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

XLSX = r"参考\破竹风115阶竞速轴属性毕业率进阶计算器3.1.xlsx"
wb_formula = load_workbook(XLSX, data_only=False)
wb_value = load_workbook(XLSX, data_only=True)

def eval_or_raw(vf, vv):
    """有缓存值用缓存值；没有则原样返回（公式字符串），标记待处理。"""
    if vf is None:
        return None
    # ArrayFormula 等对象：取其 text
    if hasattr(vf, "text"):
        vf = vf.text
    if hasattr(vv, "text"):
        vv = vv.text
    if vv is not None and not isinstance(vf, str):
        return vv
    if isinstance(vf, str) and vf.startswith("="):
        # 公式单元格：优先用缓存值
        return vv if vv is not None else vf
    return vf

# ============ 1. skills.json <- 武学奇术 ============
ws_f = wb_formula["武学奇术"]
ws_v = wb_value["武学奇术"]

# 列名 -> 字段名映射（依据表头）
SKILL_COL_MAP = {
    2: "generic_dmg",       # 通用增伤
    3: "min_ext",           # 最小外功
    4: "max_ext",           # 最大外功
    5: "ext_dmg",           # 外功加成
    6: "ext_pen",           # 外功穿透
    7: "ext_skill_dmg",     # 外攻伤害加成
    8: "elem_skill_dmg",    # 属性攻击加成
    9: "mingjin_pen",       # 鸣金穿透
    10: "mingjin_dmg",      # 鸣金加成
    11: "lieshi_pen",       # 裂石穿透
    12: "lieshi_dmg",       # 裂石加成
    13: "qiansi_pen",       # 牵丝穿透
    14: "qiansi_dmg",       # 牵丝加成
    15: "pozhu_pen",        # 破竹穿透
    16: "pozhu_dmg",        # 破竹加成
    17: "crit_rate",        # 会心率
    18: "crit_dmg",         # 会心伤害
    19: "insight_rate",     # 会意率
    20: "insight_dmg",      # 会意伤害
    21: "charge",           # 蓄力
    22: "force_precision",  # 强制精准
    23: "force_crit",       # 强制会心
    24: "force_insight",    # 强制会意
    25: "type",             # 类型
    26: "ext_mult",         # 外功倍率
    27: "ext_flat",         # 外攻固伤
    28: "elem_mult",        # 属性倍率
    29: "elem_flat",        # 属性固伤
    30: "dingyin_type",     # 定音类型(AD列文本)
    31: "dingyin_bonus",    # 定音加成(AE列数值)
    32: "spec_bonus",       # 特定增伤(AF列)
}

skills = {}
skill_formulas = {}  # 记录未求值的公式，便于核查
last_row = 0
for r in range(2, ws_f.max_row + 1):
    name = ws_f.cell(row=r, column=1).value
    if name is None or str(name).strip() == "":
        continue
    last_row = r
    rec = {}
    for col, field in SKILL_COL_MAP.items():
        vf = ws_f.cell(row=r, column=col).value
        vv = ws_v.cell(row=r, column=col).value
        val = eval_or_raw(vf, vv)
        if isinstance(val, str) and val.startswith("="):
            skill_formulas[f"{name}.{field}"] = val
        if not isinstance(val, (str, int, float, bool, type(None))):
            val = str(val)
        rec[field] = val
    skills[str(name).strip()] = rec

# ============ 2. effects.json <- 增益 ============
ws2_f = wb_formula["增益"]
ws2_v = wb_value["增益"]

EFFECT_COL_MAP = {
    2: "generic_dmg",       # 通用增伤
    3: "min_ext",           # 最小外功
    4: "max_ext",           # 最大外功
    5: "ext_dmg",           # 外功加成
    6: "ext_pen",           # 外功穿透
    7: "ext_skill_dmg",     # 外攻伤害加成
    8: "elem_skill_dmg",    # 属性攻击加成
    9: "mingjin_pen",       # 鸣金穿透
    10: "mingjin_dmg",      # 鸣金加成
    11: "lieshi_pen",       # 裂石穿透
    12: "lieshi_dmg",       # 裂石加成
    13: "qiansi_pen",       # 牵丝穿透
    14: "qiansi_dmg",       # 牵丝加成
    15: "pozhu_pen",        # 破竹穿透
    16: "pozhu_dmg",        # 破竹加成
    17: "crit_rate",        # 会心率
    18: "crit_dmg",         # 会心伤害
    19: "insight_rate",     # 会意率
    20: "insight_dmg",      # 会意伤害
    21: "direct_crit_rate", # 直接会心率
    22: "direct_insight_rate",  # 直接会意率
    23: "spec_dmg",         # 特殊增伤
    24: "final_dmg",        # 结算增伤
}

effects = {}
effect_formulas = {}
for r in range(2, ws2_f.max_row + 1):
    name = ws2_f.cell(row=r, column=1).value
    if name is None or str(name).strip() == "":
        continue
    rec = {}
    for col, field in EFFECT_COL_MAP.items():
        vf = ws2_f.cell(row=r, column=col).value
        vv = ws2_v.cell(row=r, column=col).value
        val = eval_or_raw(vf, vv)
        if isinstance(val, str) and val.startswith("="):
            effect_formulas[f"{name}.{field}"] = val
        if not isinstance(val, (str, int, float, bool, type(None))):
            val = str(val)
        rec[field] = val
    effects[str(name).strip()] = rec

# ============ 3. pozhufeng.json <- 期望表 ============
ws = wb_formula["期望"]
wsv = wb_value["期望"]

# 3.1 面板输入 schema（玩家手动输入的属性，A/B 列）
#     B2=外功基础, B3=鸣金基础, B4=裂石基础, B5=牵丝基础, B6=破竹基础, B7=无相(公式)
#     这些属于 base_stats，不放这里；这里放 B8-B25 的百分比/固定加成类输入
PANEL_FIELDS = {
    8:  "precise_rate",       # 精准率
    9:  "crit_rate",          # 会心率
    10: "insight_rate",       # 会意率
    11: "direct_crit_rate",   # 直接会心率
    12: "direct_insight_rate",# 直接会意率
    13: "crit_dmg_bonus",     # 会心伤害加成
    14: "insight_dmg_bonus",  # 会意伤害加成
    15: "all_weapon_dmg",     # 全武增
    16: "boss_dmg",           # 首领增
    17: "shuangdao_dmg",      # 双刀增
    18: "shengbiao_dmg",      # 绳镖增
    19: "single_qishu_dmg",   # 单体奇术增
    20: "group_qishu_dmg",    # 群体奇术增
    21: "qingji_dingyin",     # 轻击定音
    22: "laoshu_dingyin",     # 老鼠定音
    23: "flat_dmg_bonus",     # 固伤加成
    24: "food_ext",           # 食物加成-外功
    25: "food_elem",          # 食物加成-属性
}
panel_input = {}
for row, field in PANEL_FIELDS.items():
    label = ws.cell(row=row, column=1).value
    val = wsv.cell(row=row, column=2).value
    panel_input[field] = {"label": label, "default": val}

# 3.2 属性面板行 A2:C7 —— 六种属性的基础面板
#     A2外功 A3鸣金 A4裂石 A5牵丝 A6破竹 A7无相
elem_rows = {2: "external", 3: "mingjin", 4: "lieshi", 5: "qiansi", 6: "pozhu", 7: "wuxiang"}
base_stats = {}
for row, key in elem_rows.items():
    minv = wsv.cell(row=row, column=2).value
    maxv = wsv.cell(row=row, column=3).value
    if hasattr(minv, "text"): minv = minv.text
    if hasattr(maxv, "text"): maxv = maxv.text
    base_stats[key] = {
        "label": ws.cell(row=row, column=1).value,
        "min": minv,
        "max": maxv,
    }
# 穿透/伤害加成 (D/E 列 rows 2-7)
pen_dmg = {}
for row, key in elem_rows.items():
    pen = wsv.cell(row=row, column=4).value
    dmg = wsv.cell(row=row, column=5).value
    if hasattr(pen, "text"): pen = pen.text
    if hasattr(dmg, "text"): dmg = dmg.text
    pen_dmg[key] = {
        "pen": pen,
        "dmg": dmg,
    }

# 3.3 流派/套装选择器 G1:G7
selectors = {
    "weapon_attribute": wsv["G1"].value,   # 武学属性（破竹）
    "set": wsv["G2"].value,                 # 套装
}
# G3:G7 是公式，取缓存值
for coord, key in [("G3","generic_dmg_from_sets"),("G4","shuangdao_dmg"),("G5","shengbiao_dmg"),
                   ("G6","single_qishu_dmg"),("G7","group_qishu_dmg")]:
    selectors[key] = wsv[coord].value

# 3.4 怪物属性 H2:I5 + 战斗时间 + 副本天赋
monster = {
    "defense": {"label": "防御", "formula": ws["I2"].value, "value": wsv["I2"].value},
    "ext_resist": {"label": "外抗", "formula": ws["I3"].value, "value": wsv["I3"].value},
    "elem_resist": {"label": "属抗", "formula": ws["I4"].value, "value": wsv["I4"].value},
    "dungeon_talent": {"label": "副本天赋", "value": wsv["I5"].value},
    "duration": {"label": "战斗时间", "value": wsv["I8"].value},
}

# 3.5 团队增益勾选 C15:F22
team_buffs = {}
for r in range(16, 23):
    name = ws.cell(row=r, column=3).value
    mark = ws.cell(row=r, column=4).value
    if name:
        team_buffs[str(name)] = mark
# E/F 列的第四心法/沧海帖/所恨年年
for r in range(16, 23):
    name = ws.cell(row=r, column=5).value
    mark = ws.cell(row=r, column=6).value
    if name:
        team_buffs[str(name)] = mark

# 3.6 时间轴 K1:BY190 —— 每行一个事件
#     Q=次数(idx47) R=技能(idx48) S-AL=增益(idx49-68) AM-BY=中间计算
#     事件行判定：R列(技能)有值
Q_COL, R_COL = 17, 18
EFFECT_START, EFFECT_END = 19, 38  # S..AL (增益1~增益20)

timeline = []
for r in range(2, 191):
    skill = ws.cell(row=r, column=R_COL).value
    if skill is None or str(skill).strip() == "":
        continue
    if hasattr(skill, "text"):
        skill = skill.text
    count_v = ws.cell(row=r, column=Q_COL).value
    if hasattr(count_v, "text"):
        count_v = count_v.text
    # 区分：数值直接用，公式标记为条件式
    if isinstance(count_v, (int, float)):
        count = count_v
        count_cond = None
    elif isinstance(count_v, str) and count_v.startswith("="):
        count = None
        count_cond = count_v
    else:
        count = count_v
        count_cond = None
    eff_list = []
    for c in range(EFFECT_START, EFFECT_END + 1):
        v = ws.cell(row=r, column=c).value
        if hasattr(v, "text"):
            v = v.text
        if v is not None and str(v).strip() not in ("", "N/a", "N/A"):
            eff_list.append(str(v).strip())
    entry = {
        "row": r,
        "skill": str(skill).strip(),
        "count": count,
        "effects": eff_list,
    }
    if count_cond:
        entry["count_conditional"] = count_cond
    timeline.append(entry)

# 3.7 毕业DPS常数（I16 = I12/182477.1 公式里）
grad_formula = ws["I16"].value
grad_dps = None
if isinstance(grad_formula, str):
    m = re.search(r"/\s*([0-9.]+)", grad_formula)
    if m:
        grad_dps = float(m.group(1))

# 3.8 期望/会意/普通/擦伤 列的公式模板（row2），供引擎翻译参考
formula_templates = {}
for coord in ["L2","M2","N2","O2","P2","K2","BO2","BP2","BQ2","BR2","BS2","BT2","BU2","BV2","AR2","AS2","AT2","AU2","AV2","AW2","AX2","BA2","BB2","BE2","BF2","BI2","BJ2","BM2","BN2","BW2","BX2","BY2"]:
    v = ws[coord].value
    if hasattr(v, "text"):
        v = v.text
    if not isinstance(v, (str, int, float, bool, type(None))):
        v = str(v)
    formula_templates[coord] = v

# ============ 输出 ============
out_dir = "data"
import os
os.makedirs(out_dir, exist_ok=True)

with open(os.path.join(out_dir, "skills.json"), "w", encoding="utf-8") as f:
    json.dump({
        "_source": XLSX,
        "_sheet": "武学奇术",
        "_note": "武学是流派独占，此文件仅含破竹风的武学+奇术。奇术部分可后续抽为共享。",
        "skills": skills,
    }, f, ensure_ascii=False, indent=2)

with open(os.path.join(out_dir, "effects.json"), "w", encoding="utf-8") as f:
    json.dump({
        "_source": XLSX,
        "_sheet": "增益",
        "_note": "含团队增益/心法/套装效果，部分为条件生效（见 formula 字段）。",
        "effects": effects,
    }, f, ensure_ascii=False, indent=2)

with open(os.path.join(out_dir, "pozhufeng.115.3.5.json"), "w", encoding="utf-8") as f:
    json.dump({
        "_source": XLSX,
        "_sheet": "期望",
        "id": "pozhufeng",
        "name": "破竹风",
        "game_version": "115",
        "calc_version": "3.1",
        "author": "BiliBili@片雲",
        "selectors": selectors,
        "panel_input": panel_input,
        "base_stats": base_stats,
        "pen_dmg": pen_dmg,
        "monster": monster,
        "team_buffs": team_buffs,
        "graduate_dps": grad_dps,
        "timeline": timeline,
        "formula_templates": formula_templates,
    }, f, ensure_ascii=False, indent=2)

print("skills:", len(skills), "条")
print("effects:", len(effects), "条")
print("timeline:", len(timeline), "个事件")
print("graduate_dps:", grad_dps)
print()
print("skills 中未求值公式:", skill_formulas if skill_formulas else "无")
print("effects 中未求值公式:", effect_formulas if effect_formulas else "无")
