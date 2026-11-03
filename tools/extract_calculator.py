# -*- coding: utf-8 -*-
"""
通用提取器（现行形状同步版，原 archive/legacy-tools/ 版本已删，此处为复活版）：流派Excel计算器 → 三个JSON
  {prefix}.skills.json   <- 武学奇术表
  {prefix}.effects.json  <- 增益表
  {prefix}.json          <- 期望表（面板输入 + 怪物参数 + build配置 + 时间轴）

用法:
  python extract_calculator.py <xlsx路径> <build_id> <中文名> <输出前缀> [game_version]
例:
  python extract_calculator.py "参考\破竹风115阶竞速轴属性毕业率进阶计算器3.2.xlsx" pozhufeng 破竹风 data/schools/pozhufeng/pozhufeng.115.3.2 115

与归档版的形状差异（盘点 §3.4 同步项）：
  1. 面板"技能定音"单槽 → panel_input.dingyin（旧的多槽定音标签是死数据，遇到即跳过）；
     面板扫描越过"食物加成"行继续（技能定音行在食物之后）；
  2. 单体/群体奇术两类合并为单个"奇术"类，panel_key=全奇术增伤；
     每个类别都带 panel_key（武器类型 → `${类型}武学增伤`）；
  3. 其余（skills/effects 忠实提取含 dingingyin_type/zhenqi_ratio、_headers、
     validation/formula_templates、l_override、count_conditional）与归档版一致；
  4. 套装攻击乘数带作用域 set_attack_scope（"外功"/"全部"）：115 阶表 外功与四属性各行都写
     IF($G$2=套装,X,1)；110 阶表只有外功行写了（如鸣金影飞隼×1.1）→ 记 "外功"。
     引擎据此决定属性攻击是否也乘，否则属性攻击会虚高一档（鸣金影实为 +1.83%）。
"""
import json
import os
import re
import sys

try:  # 有 openpyxl 优先；离线环境退回标准库实现 tools/xlsx_lite.py
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    from xlsx_lite import load_workbook, get_column_letter


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
    "会意转化": "insight_convert",
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
    "charge", "force_precision", "force_crit", "force_insight", "insight_convert",
    "type", "ext_mult", "ext_flat", "elem_mult", "elem_flat",
    "dingyin_type", "zhenqi_ratio", "spec_bonus",
]

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
    "剑增": "jian_dmg", "枪增": "qiang_dmg", "横刀增": "hengdao_dmg",
    "陌刀增": "modao_dmg", "鼓增": "gu_dmg",
    "单体奇术增": "single_qishu_dmg", "群体奇术增": "group_qishu_dmg",
    "奇术增": "qishu_dmg",
    "固伤加成": "flat_dmg_bonus",
    "技能定音": "dingyin",
}
# 定音面板行的标签是流派特定的（老鼠定音/蓄力技定音/酩酊技定音/特殊技定音/派生定音…），
# 由调用方经 CLI 指定本流派生效的那一行（以 *定音 结尾的其余行一律跳过）

BASE_STAT_KEYS = ["external", "mingjin", "lieshi", "qiansi", "pozhu", "wuxiang"]  # A2:A7

WEAPON_TYPE_LABELS = {"剑", "枪", "横刀", "陌刀", "伞", "扇", "绳镖", "双刀", "拳甲", "鼓"}


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


def extract_build(wbf, wbv, xlsx_name, build_id, name_cn, game_version, dingyin_label="技能定音"):
    ws, wsv = wbf["期望"], wbv["期望"]

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

    # --- 面板输入：A8 起按标签动态扫描，越过"食物加成"继续；定音行按流派指定标签捕获 ---
    panel_input = {}
    seen_labels = []
    r = 8
    while r <= 45:
        label = clean(ws.cell(row=r, column=1).value)
        if label and label != "食物加成":
            if label.endswith("定音"):
                if label == dingyin_label:
                    bval = pick(ws.cell(row=r, column=2).value,
                                wsv.cell(row=r, column=2).value)
                    panel_input["dingyin"] = {"label": "技能定音", "default": jsonable(bval)}
                # 其余 *定音 行 = 其他可掷类型或死数据，一律跳过
            else:
                key = PANEL_LABELS.get(label)
                if key:
                    bval = pick(ws.cell(row=r, column=2).value,
                                wsv.cell(row=r, column=2).value)
                    panel_input[key] = {"label": label, "default": jsonable(bval)}
                elif label not in seen_labels:
                    seen_labels.append(label)  # 未识别标签：仅提示，帮助发现新版新增输入
        if label == "食物加成":
            bval = pick(ws.cell(row=r, column=2).value,
                        wsv.cell(row=r, column=2).value)
            panel_input["food_ext"] = {"label": "食物加成-外功", "default": jsonable(bval)}
            nxt = pick(ws.cell(row=r + 1, column=2).value,
                       wsv.cell(row=r + 1, column=2).value)
            panel_input["food_elem"] = {"label": "食物加成-属性", "default": jsonable(nxt)}
        r += 1
    if seen_labels:
        print(f"提示: 面板区未识别标签（已跳过，如为新输入需人工确认）: {seen_labels}")
    if "dingyin" not in panel_input:
        print(f"警告: 未捕获定音行（期望标签: {dingyin_label}），panel_input 将缺少 dingyin")

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

    team_buffs = {}
    for r in range(15, 25):
        for label_col, mark_col in ((3, 4), (5, 6)):
            label = clean(ws.cell(row=r, column=label_col).value)
            mark = clean(ws.cell(row=r, column=mark_col).value)
            if label and label not in ("团队增益",):
                team_buffs[label] = jsonable(mark)

    exp_headers = sheet_headers(ws)
    skill_col = exp_headers.get("技能", 18)
    count_col = exp_headers.get("次数")
    type_col = exp_headers.get("类型")
    effect_start = skill_col + 1
    effect_end = (type_col - 1) if type_col else (skill_col + 20)

    total_col = 12
    for c in range(1, ws.max_column + 1):
        if clean(ws.cell(row=1, column=c).value) == "期望":
            total_col = c
            break
    total_letter = get_column_letter(total_col)

    def _norm(f):
        return re.sub(r"(\$?[A-Za-z]{1,3})(\d+)", r"\1#", f)

    def parse_override(text):
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
        # (1+XY) 的增伤列：按列字母反查表头名，映射到增益字段（各流派列位不同，不写死）
        bonus = None
        m = re.search(r"1\s*\+\s*([A-Z]{1,3})\d+\s*\)", text)
        if m:
            letter = m.group(1)
            letter_to_header = {get_column_letter(col): hdr for hdr, col in exp_headers.items()}
            header = letter_to_header.get(letter)
            bonus = {"结算增伤": "final_dmg", "特定增伤": "spec_bonus"}.get(header)
            if bonus is None:
                print(f"警告: 覆盖公式增伤列[{letter}] 表头「{header}」未映射，按无增伤处理")
        return {"refs": refs, "factor": factor, "bonus": bonus}

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
                entry["count"] = None
            else:
                entry["count"] = jsonable(count_v)
            if is_formula(raw_count):
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
        entry["excel_L"] = jsonable(wsv.cell(row=r, column=total_col).value)
        timeline.append(entry)

    grad_dps = None
    i16 = clean(ws["I16"].value)
    if is_formula(i16):
        m = re.search(r"/\s*([0-9]+(?:\.[0-9]+)?)", i16)
        if m:
            grad_dps = float(m.group(1))

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

    def _row_set_mult(row):
        """取某条实际属性行（D 列=最小攻击）上生效的套装攻击乘数；无 → 1.0"""
        f = clean(ws.cell(row=row, column=4).value)
        if not is_formula(f):
            return 1.0
        m = re.search(r'IF\(\$G\$2="([^"]+)"\s*,\s*([0-9.]+)\s*,\s*1\)', f)
        if m and m.group(1) == selectors["set"]:
            return float(m.group(2))
        return 1.0

    set_attack_multiplier = 1.0
    d10 = clean(ws["D10"].value)
    if is_formula(d10):
        mset = re.search(r'IF\(\$G\$2="([^"]+)"\s*,\s*([0-9.]+)\s*,\s*1\)', d10)
        if mset and mset.group(1) == selectors["set"]:
            set_attack_multiplier = float(mset.group(2))

    # 作用域（版本差异，由表自己说话）：115 阶表 外功+四属性 各乘一次；
    # 110 阶表只乘外功（属性行没写 IF）→ 记 "外功"，引擎按此生效，否则属性攻击会虚高 ~10%
    attr_mults = [_row_set_mult(r) for r in range(11, 15)]
    if set_attack_multiplier != 1.0 and all(m == 1.0 for m in attr_mults):
        set_attack_scope = "外功"
    elif all(abs(m - set_attack_multiplier) < 1e-9 for m in attr_mults):
        set_attack_scope = "全部"
    else:
        set_attack_scope = "全部"
        print(f"警告: 套装攻击乘数在属性行不一致（外功 {set_attack_multiplier} / 属性 {attr_mults}），按 全部 处理")

    # ---- 拆分"面板部分"与"配置常数部分" + 奇术单类合并 + panel_key ----
    panel_defaults = {}
    for k, v in panel_input.items():
        d = v.get("default")
        panel_defaults[k] = d if isinstance(d, (int, float)) else 0
    all_weapon = panel_defaults.get("all_weapon_dmg", 0)

    label_to_keys = {}
    for k, v in panel_input.items():
        lab = v.get("label")
        if not lab or lab in ("全武增", "首领增") or not str(lab).endswith("增"):
            continue
        label_to_keys.setdefault(str(lab)[:-1], []).append(k)

    weapon_cats, qishu_rows = [], []
    for cat in weapon_categories[1:]:
        lab = cat["label"]
        keys = label_to_keys.get(lab)
        if keys is None and "奇术" in lab and "奇术" in label_to_keys:
            keys = label_to_keys["奇术"]
        if "奇术" in lab:
            qishu_rows.append((cat, keys or []))
            continue
        cat_bonus = sum(panel_defaults.get(k, 0) for k in keys or [])
        diff = (cat["value"] or 0) - cat_bonus
        if abs(diff - all_weapon) < 1e-9:
            includes = True
        elif abs(diff) < 1e-9:
            includes = False
        else:
            includes = None
            print(f"警告: 类别[{lab}] 缓存值与面板推算差 {diff}，引擎将回退缓存")
        weapon_cats.append({
            "label": lab,
            "value": cat["value"],
            "panel_keys": keys or [],
            "includes_all_weapon": includes,
            "panel_key": f"{lab}武学增伤" if lab in WEAPON_TYPE_LABELS else None,
        })
        if (weapon_cats[-1]["panel_key"]) is None:
            print(f"警告: 类别[{lab}] 无法推导 panel_key（非十种武器类型）")
    if qishu_rows:
        sigs = {"|".join(ks) for _, ks in qishu_rows}
        vals = [(c["value"] or 0) for c, _ in qishu_rows]
        # 面板键相同的两行共享同一输入（奇术增只算一次）；键不同才是两份独立输入
        merged_value = vals[0] if len(sigs) == 1 else sum(vals)
        merged_keys = list(dict.fromkeys(k for _, ks in qishu_rows for k in ks))
        incs = []
        for c, ks in qishu_rows:
            bonus = sum(panel_defaults.get(k, 0) for k in ks)
            diff = (c["value"] or 0) - bonus
            if abs(diff - all_weapon) < 1e-9:
                incs.append(True)
            elif abs(diff) < 1e-9:
                incs.append(False)
            else:
                incs.append(None)
        if all(i is False for i in incs):
            merged_includes = False
        elif all(i is True for i in incs):
            merged_includes = True
        else:
            merged_includes = None
        weapon_cats.append({
            "label": "奇术",
            "value": merged_value,
            "panel_keys": merged_keys,
            "includes_all_weapon": merged_includes,
            "panel_key": "全奇术增伤",
        })

    config = {
        "generic_extra": (weapon_categories[0]["value"] or 0)
                         - panel_defaults.get("boss_dmg", 0),
        "categories": weapon_cats,
    }

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
        "set_attack_scope": set_attack_scope,
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

    skills, wx_headers = extract_table(
        wbf["武学奇术"], wbv["武学奇术"], WX_HEADERS, SKILL_FIELDS, special_dinyin=True)
    effects, zy_headers = extract_table(
        wbf["增益"], wbv["增益"], ZY_HEADERS, EFFECT_FIELDS, special_dinyin=False)
    build = extract_build(wbf, wbv, xlsx_name, build_id, name_cn, game_version,
                          dingyin_label=sys.argv[6] if len(sys.argv) > 6 else "技能定音")

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
