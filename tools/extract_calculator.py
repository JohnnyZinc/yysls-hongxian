# -*- coding: utf-8 -*-
"""
通用提取器：流派Excel计算器 → 三个JSON
  {prefix}.skills.json   <- 武学奇术表
  {prefix}.effects.json  <- 增益表
  {prefix}.json          <- 期望表（面板输入 + 怪物参数 + build配置 + 时间轴）

用法:
  python extract_calculator.py <xlsx路径> <build_id> <中文名> <输出前缀> [game_version]
例:
  python extract_calculator.py "参考\破竹风115阶竞速轴属性毕业率进阶计算器3.1.xlsx" pozhufeng 破竹风 data/pozhufeng.115.3.5 115

设计要点：
  - 表头动态映射（四个文件的表头文字/列位有差异，按表头文字找列，不写死列号）
  - 公式单元格优先取缓存值，取不到缓存值时保留公式文本并打标记（如 count_conditional）
  - 面板输入区按 A 列标签动态扫描（各流派面板行位不同：食物加成在 23/24/25 行不等）
"""
import json
import os
import re
import sys

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


# ---------------- 基础工具 ----------------

def clean(v):
    """ArrayFormula 等对象取 .text；字符串去空白。"""
    if hasattr(v, "text"):
        v = v.text
    if isinstance(v, str):
        return v.strip()
    return v


def is_formula(v):
    return isinstance(v, str) and v.startswith("=")


def jsonable(v):
    return v if isinstance(v, (str, int, float, bool)) or v is None else str(v)


def pick(vf, vv):
    """公式单元格优先取缓存值；取不到则保留公式文本。"""
    vf, vv = clean(vf), clean(vv)
    if is_formula(vf):
        return vv if vv is not None else vf
    return vf if vf is not None else vv


def sheet_headers(ws):
    """row1 的 表头文字 -> 列号"""
    headers = {}
    for c in range(1, ws.max_column + 1):
        h = clean(ws.cell(row=1, column=c).value)
        if h:
            headers[h] = c
    return headers


# ---------------- 表头 -> 字段映射 ----------------

# 武学奇术表（类型/倍率/固伤等）。'定音加成'列特殊处理：AD=定音类型文本，AD+1=真气加成数值
WX_HEADERS = {
    "通用增伤": "generic_dmg",
    "最小外功": "min_ext", "最大外功": "max_ext",
    "外功加成": "ext_dmg", "外功穿透": "ext_pen",
    "外攻伤害加成": "ext_skill_dmg", "属性攻击加成": "elem_skill_dmg",
    "鸣金穿透": "mingjin_pen", "鸣金加成": "mingjin_dmg",
    "裂石穿透": "lieshi_pen", "裂石加成": "lieshi_dmg",
    "牵丝穿透": "qiansi_pen", "牵丝加成": "qiansi_dmg",
    "破竹穿透": "pozhu_pen", "破竹加成": "pozhu_dmg",
    "会心率": "crit_rate", "会心伤害": "crit_dmg",
    "会意率": "insight_rate", "会意伤害": "insight_dmg",
    "蓄力": "charge",
    "强制精准": "force_precision", "强制会心": "force_crit", "强制会意": "force_insight",
    "类型": "type",
    "外功倍率": "ext_mult", "外攻固伤": "ext_flat",
    "属性倍率": "elem_mult", "属性固伤": "elem_flat",
    "特定增伤": "spec_bonus",
}

SKILL_FIELDS = [
    "generic_dmg", "min_ext", "max_ext", "ext_dmg", "ext_pen",
    "ext_skill_dmg", "elem_skill_dmg",
    "mingjin_pen", "mingjin_dmg", "lieshi_pen", "lieshi_dmg",
    "qiansi_pen", "qiansi_dmg", "pozhu_pen", "pozhu_dmg",
    "crit_rate", "crit_dmg", "insight_rate", "insight_dmg",
    "charge", "force_precision", "force_crit", "force_insight",
    "type", "ext_mult", "ext_flat", "elem_mult", "elem_flat",
    "dingyin_type", "zhenqi_ratio", "spec_bonus",
]

# 增益表。注意跨文件表头差异：
#   直接会心率/直接会心 -> direct_crit_rate；直接会意率/直接会意 -> direct_insight_rate
#   结算增伤(风/尘/樽) -> final_dmg；牵丝玉的X列为'特定增伤' -> spec_bonus
ZY_HEADERS = {
    "通用增伤": "generic_dmg",
    "最小外功": "min_ext", "最大外功": "max_ext",
    "外功加成": "ext_dmg", "外功穿透": "ext_pen",
    "外攻伤害加成": "ext_skill_dmg", "属性攻击加成": "elem_skill_dmg",
    "鸣金穿透": "mingjin_pen", "鸣金加成": "mingjin_dmg",
    "裂石穿透": "lieshi_pen", "裂石加成": "lieshi_dmg",
    "牵丝穿透": "qiansi_pen", "牵丝加成": "qiansi_dmg",
    "破竹穿透": "pozhu_pen", "破竹加成": "pozhu_dmg",
    "会心率": "crit_rate", "会心伤害": "crit_dmg",
    "会意率": "insight_rate", "会意伤害": "insight_dmg",
    "直接会心率": "direct_crit_rate", "直接会心": "direct_crit_rate",
    "直议会心率": "direct_crit_rate",
    "直接会意率": "direct_insight_rate", "直接会意": "direct_insight_rate",
    "直议会意率": "direct_insight_rate",
    "特殊增伤": "spec_dmg",
    "结算增伤": "final_dmg",
    "特定增伤": "spec_bonus",
}

EFFECT_FIELDS = [
    "generic_dmg", "min_ext", "max_ext", "ext_dmg", "ext_pen",
    "ext_skill_dmg", "elem_skill_dmg",
    "mingjin_pen", "mingjin_dmg", "lieshi_pen", "lieshi_dmg",
    "qiansi_pen", "qiansi_dmg", "pozhu_pen", "pozhu_dmg",
    "crit_rate", "crit_dmg", "insight_rate", "insight_dmg",
    "direct_crit_rate", "direct_insight_rate",
    "spec_dmg", "final_dmg", "spec_bonus",
]

# 面板输入 A 列标签 -> 字段名（各流派标签集合不同，未识别的标签用原文当字段名）
PANEL_LABELS = {
    "精准率": "precise_rate",
    "会心率": "crit_rate",
    "会意率": "insight_rate",
    "直接会心率": "direct_crit_rate", "直议会心率": "direct_crit_rate",
    "直接会意率": "direct_insight_rate", "直议会意率": "direct_insight_rate",
    "会心伤害加成": "crit_dmg_bonus",
    "会意伤害加成": "insight_dmg_bonus",
    "全武增": "all_weapon_dmg",
    "首领增": "boss_dmg",
    "双刀增": "shuangdao_dmg", "绳镖增": "shengbiao_dmg",
    "伞增": "san_dmg", "扇增": "shan_dmg", "拳甲增": "quanjia_dmg",
    "单体奇术增": "single_qishu_dmg", "群体奇术增": "group_qishu_dmg",
    "奇术增": "qishu_dmg",
    "轻击定音": "qingji_dingyin", "老鼠定音": "laoshu_dingyin",
    "弹道定音": "dandao_dingyin", "回旋伞定音": "huixuansan_dingyin",
    "酩酊技定音": "mingding_dingyin",
    "固伤加成": "flat_dmg_bonus",
}

BASE_STAT_KEYS = ["external", "mingjin", "lieshi", "qiansi", "pozhu", "wuxiang"]  # A2:A7


# ---------------- 提取逻辑 ----------------

def extract_table(ws_f, ws_v, header_map, all_fields, special_dinyin=False):
    """通用表提取：按表头映射列；返回 (records, headers_used)"""
    headers = sheet_headers(ws_f)
    colmap = {}  # col -> field
    used_headers = {}
    for h, field in header_map.items():
        if h in headers:
            col = headers[h]
            if col not in colmap:  # 同一列不重复赋字段
                colmap[col] = field
                used_headers[h] = get_column_letter(col)
    # 定音加成特殊列：文本列 + 数值列(列+1)
    dinyin_col = headers.get("定音加成")

    records = {}
    for r in range(2, ws_f.max_row + 1):
        name = clean(ws_f.cell(row=r, column=1).value)
        if not name:
            continue
        rec = {f: None for f in all_fields}
        for col, field in colmap.items():
            val = pick(ws_f.cell(row=r, column=col).value,
                       ws_v.cell(row=r, column=col).value)
            rec[field] = jsonable(val)
        if special_dinyin and dinyin_col:
            t = pick(ws_f.cell(row=r, column=dinyin_col).value,
                     ws_v.cell(row=r, column=dinyin_col).value)
            z = pick(ws_f.cell(row=r, column=dinyin_col + 1).value,
                     ws_v.cell(row=r, column=dinyin_col + 1).value)
            rec["dingyin_type"] = jsonable(t)
            rec["zhenqi_ratio"] = jsonable(z)
        records[name] = rec
    return records, used_headers


def extract_build(wbf, wbv, xlsx_name, build_id, name_cn, game_version):
    ws, wsv = wbf["期望"], wbv["期望"]

    # --- 选择器 G1/G2 + F3:G7 ---
    selectors = {
        "weapon_attribute": clean(ws["G1"].value),
        "set": clean(ws["G2"].value),
    }
    weapon_categories = []
    for r in range(3, 8):
        label = clean(ws.cell(row=r, column=6).value)
        if label:
            weapon_categories.append({
                "label": label,
                "value": jsonable(pick(ws.cell(row=r, column=7).value,
                                       wsv.cell(row=r, column=7).value)),
            })

    # --- 面板输入：A8 起按标签动态扫描（各流派行位不同）---
    # 在"食物加成"（含其第二行数值）后停止，避免误收 A28+ 的时间统计区标签
    panel_input = {}
    r = 8
    while r <= 45:
        label = clean(ws.cell(row=r, column=1).value)
        bval = pick(ws.cell(row=r, column=2).value,
                    wsv.cell(row=r, column=2).value)
        if label == "食物加成":
            panel_input["food_ext"] = {"label": "食物加成-外功", "default": jsonable(bval)}
            nxt = pick(ws.cell(row=r + 1, column=2).value,
                       wsv.cell(row=r + 1, column=2).value)
            panel_input["food_elem"] = {"label": "食物加成-属性", "default": jsonable(nxt)}
            break
        if label:
            key = PANEL_LABELS.get(label, label)
            panel_input[key] = {"label": label, "default": jsonable(bval)}
        r += 1

    # --- 六系基础面板 A2:C7 + 穿透/伤害加成 D2:E7 ---
    base_stats, pen_dmg = {}, {}
    for i, key in enumerate(BASE_STAT_KEYS):
        row = i + 2
        base_stats[key] = {
            "label": clean(ws.cell(row=row, column=1).value),
            "min": jsonable(pick(ws.cell(row=row, column=2).value,
                                 wsv.cell(row=row, column=2).value)),
            "max": jsonable(pick(ws.cell(row=row, column=3).value,
                                 wsv.cell(row=row, column=3).value)),
        }
        pen_dmg[key] = {
            "pen": jsonable(pick(ws.cell(row=row, column=4).value,
                                 wsv.cell(row=row, column=4).value)),
            "dmg": jsonable(pick(ws.cell(row=row, column=5).value,
                                 wsv.cell(row=row, column=5).value)),
        }

    # --- 怪物参数 + 战斗时长 ---
    monster = {
        "defense": {"label": "防御",
                    "formula": jsonable(clean(ws["I2"].value)),
                    "value": jsonable(wsv["I2"].value)},
        "ext_resist": {"label": "外抗",
                       "formula": jsonable(clean(ws["I3"].value)),
                       "value": jsonable(wsv["I3"].value)},
        "elem_resist": {"label": "属抗",
                        "formula": jsonable(clean(ws["I4"].value)),
                        "value": jsonable(wsv["I4"].value)},
        "dungeon_talent": {"label": "副本天赋", "value": jsonable(wsv["I5"].value)},
        "duration": {"label": "战斗时间", "value": jsonable(wsv["I8"].value)},
    }

    # --- 团队增益勾选 C/D 与 E/F 列（15-24行扫描）---
    team_buffs = {}
    for r in range(15, 25):
        for label_col, mark_col in ((3, 4), (5, 6)):
            label = clean(ws.cell(row=r, column=label_col).value)
            mark = clean(ws.cell(row=r, column=mark_col).value)
            if label and label not in ("团队增益",):
                team_buffs[label] = jsonable(mark)

    # --- 时间轴：按表头动态定位列（旧版 Q=次数/R=技能/S..AL=增益；
    #     裂石威/牵丝霖 P=次数/Q=技能/R..=增益，增益槽位数也不同）---
    exp_headers = sheet_headers(ws)
    skill_col = exp_headers.get("技能", 18)
    count_col = exp_headers.get("次数")          # 个别版本可能没有次数列
    type_col = exp_headers.get("类型")            # 增益区结束于类型列之前
    effect_start = skill_col + 1
    effect_end = (type_col - 1) if type_col else (skill_col + 20)

    # 期望总量列按表头定位（风/玉/尘/樽在L列，威/霖在K列）
    total_col = 12
    for c in range(1, ws.max_column + 1):
        if clean(ws.cell(row=1, column=c).value) == "期望":
            total_col = c
            break
    total_letter = get_column_letter(total_col)

    def _norm(f):
        """行号归一化，便于比较公式结构"""
        return re.sub(r"(\$?[A-Za-z]{1,3})(\d+)", r"\1#", f)

    def parse_override(text):
        """解析覆盖公式：=SUM(L8,L11:L12,...)*30%*(1+BY46) → 结构化引用"""
        refs = []

        def _range(m):
            refs.extend(range(int(m.group(1)), int(m.group(2)) + 1))
            return "+"

        def _one(m):
            refs.append(int(m.group(1)))
            return "+"

        t = re.sub(total_letter + r"(\d+):" + total_letter + r"(\d+)", _range, text)
        re.sub(total_letter + r"(\d+)", _one, t)
        factor = 1.0
        m = re.search(r"\*\s*(\d+(?:\.\d+)?)\s*(%)?\s*\*", text)
        if m:
            factor = float(m.group(1)) / (100 if m.group(2) else 1)
        bonus = "final_dmg" if re.search(r"1\s*\+\s*BY", text) else None
        return {"refs": refs, "factor": factor, "bonus": bonus}

    # L列（期望总量列）标准公式模板；归一化后不同的行记为覆盖事件（如结算/醉杀）
    total_template = None
    timeline = []
    for r in range(2, ws.max_row + 1):
        skill = clean(ws.cell(row=r, column=skill_col).value)
        if not skill:
            continue
        entry = {"row": r, "skill": skill, "count": 1, "effects": []}
        if count_col:
            raw_count = clean(ws.cell(row=r, column=count_col).value)
            count_v = pick(raw_count, wsv.cell(row=r, column=count_col).value)
            if isinstance(count_v, (int, float)):
                entry["count"] = count_v
            elif is_formula(count_v):
                entry["count"] = None  # 无缓存值
            else:
                entry["count"] = jsonable(count_v)
            if is_formula(raw_count):
                # 条件次数：count为当前求值缓存，count_conditional保留公式供引擎按build配置重算
                entry["count_conditional"] = raw_count
        for c in range(effect_start, effect_end + 1):
            v = clean(ws.cell(row=r, column=c).value)
            if v and v not in ("N/a", "N/A"):
                entry["effects"].append(v)
        l_cell = clean(ws.cell(row=r, column=total_col).value)
        if is_formula(l_cell):
            if total_template is None:
                total_template = _norm(l_cell)
            elif _norm(l_cell) != total_template:
                entry["l_override"] = parse_override(l_cell)
                entry["l_override_raw"] = l_cell
        # Excel 该行期望伤害的缓存值，作为引擎逐事件验证基准
        entry["excel_L"] = jsonable(wsv.cell(row=r, column=total_col).value)
        timeline.append(entry)

    # --- 毕业DPS常数：从 I16 公式文本提取 ---
    grad_dps = None
    i16 = clean(ws["I16"].value)
    if is_formula(i16):
        m = re.search(r"/\s*([0-9]+(?:\.[0-9]+)?)", i16)
        if m:
            grad_dps = float(m.group(1))

    # --- 公式模板（引擎翻译参考）---
    formula_templates = {}
    for coord in ["K2", "L2", "M2", "N2", "O2", "P2",
                  "BO2", "BP2", "BQ2", "BR2", "BS2", "BT2", "BU2", "BV2",
                  "AR2", "AS2", "AT2", "AU2", "AV2", "AW2", "AX2",
                  "BA2", "BB2", "BE2", "BF2", "BI2", "BJ2", "BM2", "BN2",
                  "BW2", "BX2", "BY2"]:
        v = clean(ws[coord].value)
        if v is not None:
            formula_templates[coord] = jsonable(v)

    m = re.search(r"(\d+\.\d+)\.xlsx$", xlsx_name)
    calc_version = m.group(1) if m else None

    # 套装攻击乘数：从 D10 公式解析 IF($G$2="套装名",乘数,1)，按当前套装求生效值
    set_attack_multiplier = 1.0
    d10 = clean(ws["D10"].value)
    if is_formula(d10):
        mset = re.search(r'IF\(\$G\$2="([^"]+)"\s*,\s*([0-9.]+)\s*,\s*1\)', d10)
        if mset and mset.group(1) == selectors["set"]:
            set_attack_multiplier = float(mset.group(2))

    # ---- 拆分"面板部分"与"配置常数部分" ----
    # G3 = 首领增(面板) + 配置常数(1.5%基础 + 团队/心法假设)
    # G4..G7 类别增伤 = 类别面板增伤 (+ 全武增，按类别而异，数据驱动检测)
    panel_defaults = {}
    for k, v in panel_input.items():
        d = v.get("default")
        panel_defaults[k] = d if isinstance(d, (int, float)) else 0
    all_weapon = panel_defaults.get("all_weapon_dmg", 0)

    # 面板标签(去尾"增") -> panel_input键
    label_to_keys = {}
    for k, v in panel_input.items():
        lab = v.get("label")
        if not lab or lab in ("全武增", "首领增") or not str(lab).endswith("增"):
            continue
        label_to_keys.setdefault(str(lab)[:-1], []).append(k)

    categories_cfg = []
    for cat in weapon_categories[1:]:
        lab = cat["label"]
        keys = label_to_keys.get(lab)
        if keys is None and "奇术" in lab and "奇术" in label_to_keys:
            keys = label_to_keys["奇术"]  # 部分流派用单一"奇术增"同时喂两类
        cat_bonus = sum(panel_defaults.get(k, 0) for k in (keys or []))
        diff = (cat["value"] or 0) - cat_bonus
        if abs(diff - all_weapon) < 1e-9:
            includes = True
        elif abs(diff) < 1e-9:
            includes = False
        else:
            includes = None  # 无法判定，引擎回退缓存值
            print(f"警告: 类别[{lab}] 缓存值与面板推算差 {diff}，引擎将回退缓存")
        categories_cfg.append({
            "label": lab,
            "value": cat["value"],
            "panel_keys": keys or [],
            "includes_all_weapon": includes,
        })

    config = {
        "generic_extra": (weapon_categories[0]["value"] or 0)
                         - panel_defaults.get("boss_dmg", 0),
        "categories": categories_cfg,
    }

    # Excel 自身的计算结果缓存，作为引擎验证基准
    validation = {
        "excel_total_damage": jsonable(wsv["I10"].value),
        "excel_adps": jsonable(wsv["I12"].value),
        "excel_graduation_rate": jsonable(wsv["I16"].value),
    }

    return {
        "_source": xlsx_name,
        "_sheet": "期望",
        "id": build_id,
        "name": name_cn,
        "game_version": game_version,
        "calc_version": calc_version,
        "selectors": selectors,
        "weapon_categories": weapon_categories,
        "panel_input": panel_input,
        "base_stats": base_stats,
        "pen_dmg": pen_dmg,
        "monster": monster,
        "team_buffs": team_buffs,
        "set_attack_multiplier": set_attack_multiplier,
        "config": config,
        "graduate_dps": grad_dps,
        "timeline": timeline,
        "formula_templates": formula_templates,
        "validation": validation,
    }


def main():
    xlsx, build_id, name_cn, out_prefix = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    game_version = sys.argv[5] if len(sys.argv) > 5 else "115"
    xlsx_name = os.path.basename(xlsx)

    wbf = load_workbook(xlsx, data_only=False)
    wbv = load_workbook(xlsx, data_only=True)

    # skills <- 武学奇术
    skills, wx_headers = extract_table(
        wbf["武学奇术"], wbv["武学奇术"], WX_HEADERS, SKILL_FIELDS, special_dinyin=True)
    # effects <- 增益
    effects, zy_headers = extract_table(
        wbf["增益"], wbv["增益"], ZY_HEADERS, EFFECT_FIELDS, special_dinyin=False)
    # build <- 期望
    build = extract_build(wbf, wbv, xlsx_name, build_id, name_cn, game_version)

    os.makedirs(os.path.dirname(out_prefix) or ".", exist_ok=True)

    with open(out_prefix + ".skills.json", "w", encoding="utf-8") as f:
        json.dump({
            "_source": xlsx_name, "_sheet": "武学奇术",
            "_note": "武学为流派独占，奇术(群体奇术/单体奇术类)可能跨流派共享；字段含定音类型与真气加成。",
            "_headers": wx_headers,
            "skills": skills,
        }, f, ensure_ascii=False, indent=2)

    with open(out_prefix + ".effects.json", "w", encoding="utf-8") as f:
        json.dump({
            "_source": xlsx_name, "_sheet": "增益",
            "_note": "含团队增益/心法/套装效果；牵丝玉的X列为'特定增伤'(映射为spec_bonus)，其余流派为'结算增伤'(final_dmg)。",
            "_headers": zy_headers,
            "effects": effects,
        }, f, ensure_ascii=False, indent=2)

    with open(out_prefix + ".json", "w", encoding="utf-8") as f:
        json.dump(build, f, ensure_ascii=False, indent=2)

    n_cond = sum(1 for e in build["timeline"] if "count_conditional" in e)
    print(f"[{build_id}] skills={len(skills)} effects={len(effects)} "
          f"timeline={len(build['timeline'])}(条件{n_cond}) "
          f"graduate_dps={build['graduate_dps']} "
          f"weapon_attribute={build['selectors']['weapon_attribute']} set={build['selectors']['set']}")


if __name__ == "__main__":
    main()
