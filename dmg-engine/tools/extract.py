#!/usr/bin/env python3
"""从原始 xlsx 抽取「流派包」与「输入快照」为 JSON。

设计约束（与需求一致）：
  * 只读原表，不修改原表；
  * 输出里不出现任何单元格/行/列坐标，全部翻译成实体与字段；
  * 开关、心法、套装、目标、基准值、战斗时间 → 流派包；
  * 面板数值（精准/会心/会意/各类增/定音/攻击/穿透/伤害加成）→ 输入快照；
  * 引擎负责的中间量（即时攻击、各乘区、四态占比、M/N/O/P、L）一律不抽取，由引擎重算。

用法：python tools/extract.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import openpyxl

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = PROJECT.parent
OUT_PACKAGES = PROJECT / "packages"
OUT_INPUTS = PROJECT / "inputs"

ELEMENT_KEYS = {"鸣金": "mingjin", "裂石": "lieshi", "牵丝": "qiansi", "破竹": "pozhu"}
ELEMENT_ORDER = ["mingjin", "lieshi", "qiansi", "pozhu"]

# 武学奇术表的列位（抽取时使用；这些坐标只存在于本脚本内，不会进入 JSON）
SKILL_COLUMNS = {
    2: "generalDamage",
    3: "minPhysical",
    4: "maxPhysical",
    5: "physicalBonus",
    6: "physicalPenetration",
    7: "physicalDamageBonus",
    8: "elementAttackBonus",
    9: ("penetration", "mingjin"),
    10: ("elementDamageBonus", "mingjin"),
    11: ("penetration", "lieshi"),
    12: ("elementDamageBonus", "lieshi"),
    13: ("penetration", "qiansi"),
    14: ("elementDamageBonus", "qiansi"),
    15: ("penetration", "pozhu"),
    16: ("elementDamageBonus", "pozhu"),
    17: "critRate",
    18: "critDamage",
    19: "resolveRate",
    20: "resolveDamage",
    21: "charge",
    22: "forcedPrecise",
    23: "forcedCrit",
    24: "forcedResolve",
    25: "type",
    26: "physicalRatio",
    27: "physicalFlat",
    28: "elementRatio",
    29: "elementFlat",
    30: "tuningCategory",
    32: "specificBonus",
    # 第 31 列（真气系数）按决定删除：它只服务于真气比例，而真气比例不是输出
}

BUFF_COLUMNS = {
    2: "generalDamage",
    3: "minPhysical",
    4: "maxPhysical",
    5: "physicalBonus",
    6: "physicalPenetration",
    7: "physicalDamageBonus",
    8: "elementAttackBonus",
    9: ("penetration", "mingjin"),
    10: ("elementDamageBonus", "mingjin"),
    11: ("penetration", "lieshi"),
    12: ("elementDamageBonus", "lieshi"),
    13: ("penetration", "qiansi"),
    14: ("elementDamageBonus", "qiansi"),
    15: ("penetration", "pozhu"),
    16: ("elementDamageBonus", "pozhu"),
    17: "critRate",
    18: "critDamage",
    19: "resolveRate",
    20: "resolveDamage",
    21: "directCritRate",
    22: "directResolveRate",
    23: "specialDamageBonus",
    24: None,  # 最后一列：按表头决定是 specificBonus 还是 settlementBonus
}

FILES = [
    ("pozhu_feng_3.1", "破竹风", "3.1", "破竹风115阶竞速轴属性毕业率进阶计算器3.1.xlsx"),
    ("pozhu_chen_3.1", "破竹尘", "3.1", "破竹尘115阶竞速轴属性毕业率进阶计算器3.1.xlsx"),
    ("qiansi_yu_3.2", "牵丝玉", "3.2", "牵丝玉115阶竞速轴属性毕业率进阶计算器3.2.xlsx"),
    ("pozhu_zun_3.5", "破竹樽", "3.5", "破竹樽115阶竞速轴属性毕业率进阶计算器3.5.xlsx"),
]


def val(ws, row: int, col: int):
    return ws.cell(row=row, column=col).value


def num(v) -> float:
    return float(v) if isinstance(v, (int, float)) else 0.0


def put(d: dict, key, v) -> None:
    if isinstance(key, tuple):
        d.setdefault(key[0], {})[key[1]] = v
    else:
        d[key] = v


def find_label(ws, label: str, col: int, row_from: int, row_to: int) -> int | None:
    for r in range(row_from, row_to + 1):
        cell = val(ws, r, col)
        if isinstance(cell, str) and cell.strip() == label:
            return r
    return None


def find_label_contains(ws, needle: str, col: int, row_from: int, row_to: int) -> int | None:
    for r in range(row_from, row_to + 1):
        cell = val(ws, r, col)
        if isinstance(cell, str) and needle in cell:
            return r
    return None


def extract(key: str, name: str, version: str, filename: str) -> tuple[dict, dict]:
    path = WORKSPACE / "参考" / filename
    wb = openpyxl.load_workbook(path, data_only=True)
    wb_formula = openpyxl.load_workbook(path, data_only=False)
    ws = wb["期望"]
    wsf = wb_formula["期望"]
    skills_ws = wb["武学奇术"]
    buffs_ws = wb["增益"]
    notes: list[str] = []

    # ---------------- 面板 / 流派固定参数 ----------------
    element_name = val(ws, 1, 7)
    if element_name not in ELEMENT_KEYS:
        raise ValueError(f"{key}: 生效属性无法识别: {element_name!r}")

    phys_min = num(val(ws, 2, 2))
    phys_max = num(val(ws, 2, 3))
    phys_pen = num(val(ws, 2, 4))

    augment_min = num(val(ws, 7, 2))
    augment_max = num(val(ws, 7, 3))

    elements: dict[str, dict] = {}
    for r in range(3, 7):
        label = val(ws, r, 1)
        if label not in ELEMENT_KEYS:
            raise ValueError(f"{key}: 属性行标签无法识别: {label!r}")
        elements[ELEMENT_KEYS[label]] = {
            "min": num(val(ws, r, 2)),
            "max": num(val(ws, r, 3)),
            "penetration": num(val(ws, r, 4)),
            "damageBonus": num(val(ws, r, 5)),
        }
    for r in range(11, 15):
        label = val(ws, r, 3)
        if label in ELEMENT_KEYS and elements[ELEMENT_KEYS[label]]["min"] != num(val(ws, r - 8, 2)):
            notes.append(f"{label} 的攻击面板行序与属性表行序不一致，已按属性表行序取值")

    precision = num(val(ws, 8, 2))
    crit_rate = num(val(ws, 9, 2))
    resolve_rate = num(val(ws, 10, 2))
    direct_crit = num(val(ws, 11, 2))
    direct_resolve = num(val(ws, 12, 2))
    crit_damage_bonus = num(val(ws, 13, 2))
    resolve_damage_bonus = num(val(ws, 14, 2))
    # 各类增伤输入项不按固定行号读取（各流派面板行数不同），
    # 而是在下面根据类型公式真正引用了哪些输入项来决定；见 bonus_inputs。

    tuning_rows = [
        r
        for r in range(8, 27)
        if isinstance(val(ws, r, 1), str) and val(ws, r, 1).strip().endswith("定音")
    ]
    tuning_active = None
    tuning_dropped = []
    for r in tuning_rows:
        label = str(val(ws, r, 1)).strip()
        category = label[: -len("定音")]
        bonus = num(val(ws, r, 2))
        if tuning_active is None and bonus:
            tuning_active = {"category": category, "bonus": bonus, "label": label}
        else:
            tuning_dropped.append({"category": category, "bonus": bonus, "label": label})
    if tuning_active is None:
        raise ValueError(f"{key}: 未找到生效的定音槽")
    if any(d["bonus"] for d in tuning_dropped):
        notes.append("存在多个非零定音槽，当前模型只支持一个，已保留第一个")
    for d in tuning_dropped:
        notes.append(f"空置/未使用的定音槽已丢弃: {d['label']}={d['bonus']}")

    flat_row = find_label(ws, "固伤加成", 1, 8, 27)
    flat_damage_bonus = num(val(ws, flat_row, 2)) if flat_row else 0.0

    food_row = find_label(ws, "食物加成", 1, 8, 27)
    food_min = num(val(ws, food_row, 2)) if food_row else 0.0
    food_max = num(val(ws, food_row + 1, 2)) if food_row else 0.0

    base_phys_damage_bonus = num(val(ws, 10, 7))  # 外功行的伤害加成（原表里是条件公式，已固定）

    attack_pool_min = phys_min + food_min
    set_multiplier = (num(val(ws, 10, 4)) / attack_pool_min) if attack_pool_min else 1.0
    set_multiplier = round(set_multiplier, 6)

    # 类型 → 增伤来源：不假设固定行号，直接读公式（原表里各流派的面板行数不同，
    # 例如牵丝玉把两个奇术增合并成一行，两个奇术类型引用的是同一个输入）
    input_cell_to_field = {
        15: "allWeaponBonus",
        16: "bossBonus",
        17: "weaponBonus1",
        18: "weaponBonus2",
        19: "skillTypeBonus1",
        20: "skillTypeBonus2",
    }
    type_bonuses = []
    weapon_type_names = []
    referenced_cells: set[int] = set()
    for offset, r in enumerate((4, 5, 6, 7)):
        type_name = val(ws, r, 6)
        if not (isinstance(type_name, str) and type_name):
            notes.append(f"类型名缺失（第 {offset + 1} 个类型行），已跳过")
            continue
        formula = wsf.cell(row=r, column=7).value
        if not (isinstance(formula, str) and formula.startswith("=")):
            raise ValueError(f"{key}: 类型 {type_name!r} 的增伤不是公式: {formula!r}")
        fields = []
        for ref in re.findall(r"\$?B\$?(\d+)", formula):
            cell_row = int(ref)
            if cell_row not in input_cell_to_field:
                raise ValueError(f"{key}: 类型 {type_name!r} 的增伤引用了未知输入项 B{ref}")
            referenced_cells.add(cell_row)
            field = input_cell_to_field[cell_row]
            if field not in fields:
                fields.append(field)
        type_bonuses.append({"name": type_name, "add": fields})
        if offset < 2:
            weapon_type_names.append(type_name)

    # 通用增伤的基准项引用了「首领增」，它总是被引用
    base_formula = wsf.cell(row=3, column=7).value
    for ref in re.findall(r"\$?B\$?(\d+)", base_formula or ""):
        if int(ref) in input_cell_to_field:
            referenced_cells.add(int(ref))
    if 16 not in referenced_cells:
        notes.append("未能从通用增伤公式里确认「首领增」输入项，已按默认行处理")
        referenced_cells.add(16)

    # 只把真正被引用的增伤项写进输入快照（避免出现指向别处的死字段）
    bonus_inputs = {
        input_cell_to_field[cell_row]: num(val(ws, cell_row, 2))
        for cell_row in sorted(referenced_cells)
    }
    for cell_row, field in input_cell_to_field.items():
        if field not in bonus_inputs:
            notes.append(f"输入项 {field} 未被该流派引用，未写入输入快照")
    boss_bonus = bonus_inputs["bossBonus"]

    general_damage_cell = num(val(ws, 3, 7))
    general_damage_flat = general_damage_cell - boss_bonus
    target = {
        "defense": num(val(ws, 2, 9)),
        "physicalResist": num(val(ws, 3, 9)),
        "elementResist": num(val(ws, 4, 9)),
        "dungeonTalent": num(val(ws, 5, 9)),
    }
    clear_time = num(val(ws, 8, 9))
    total_damage_ref = num(val(ws, 10, 9))
    adps_ref = num(val(ws, 12, 9))
    graduation_ref = num(val(ws, 16, 9))
    if graduation_ref == 0 or adps_ref == 0:
        raise ValueError(f"{key}: 缺少总伤/ADPS/毕业率参考值")
    benchmark_adps = adps_ref / graduation_ref

    # ---------------- 时间轴 ----------------
    actions = []
    settlement_specs = []
    row_to_index: dict[int, int] = {}
    for r in range(2, ws.max_row + 1):
        l_value = val(ws, r, 12)
        l_formula = wsf.cell(row=r, column=12).value
        if l_value is None and l_formula is None:
            continue
        if not (isinstance(l_value, (int, float)) or (isinstance(l_formula, str) and l_formula.startswith("="))):
            continue  # 表头文字
        idx = len(actions)
        row_to_index[r] = idx
        skill = val(ws, r, 18)
        repeat = val(ws, r, 17)
        buffs = [
            val(ws, r, c)
            for c in range(19, 39)
            if isinstance(val(ws, r, c), str) and val(ws, r, c).strip() not in ("", "N/a")
        ]
        if isinstance(l_formula, str) and "SUM(L" in l_formula:
            actions.append(
                {
                    "index": idx,
                    "type": "settlement",
                    "repeat": 1,
                    "buffs": buffs,
                    "ratio": None,
                    "window": None,
                }
            )
            settlement_specs.append((idx, l_formula))
        else:
            if not isinstance(l_formula, str):
                raise ValueError(f"{key}: 动作 {idx} 的 L 既不是公式也不是结算式，无法翻译")
            actions.append(
                {
                    "index": idx,
                    "type": "skill",
                    "skill": skill,
                    "repeat": num(repeat) if isinstance(repeat, (int, float)) else 0,
                    "buffs": buffs,
                }
            )

    for idx, formula in settlement_specs:
        ratio_m = re.search(r"\*\s*(\d+(?:\.\d+)?)\s*(%?)\s*\*", formula)
        if not ratio_m:
            raise ValueError(f"{key}: 结算动作 {idx} 未能解析比例: {formula}")
        ratio = float(ratio_m.group(1)) / (100.0 if ratio_m.group(2) == "%" else 1.0)
        window_rows: list[int] = []
        body = formula
        for a, b in re.findall(r"L(\d+)\s*:\s*L(\d+)", formula):
            window_rows.extend(range(int(a), int(b) + 1))
            body = body.replace(f"L{a}:L{b}", " ")
            body = body.replace(f"L{a}: L{b}", " ")
        for a in re.findall(r"(?<![A-Za-z0-9])L(\d+)", body):
            window_rows.append(int(a))
        window = sorted({row_to_index[r] for r in window_rows if r in row_to_index})
        missing = [r for r in window_rows if r not in row_to_index]
        if missing:
            raise ValueError(f"{key}: 结算动作 {idx} 引用了不存在的动作行 {missing}")
        act = actions[idx]
        act["ratio"] = ratio
        act["window"] = window

    # ---------------- 技能表 ----------------
    used_skills = sorted({a["skill"] for a in actions if a["type"] == "skill"})
    skill_table: dict[str, dict] = {}
    for r in range(2, skills_ws.max_row + 1):
        skill_name = val(skills_ws, r, 1)
        if not isinstance(skill_name, str) or skill_name not in used_skills:
            continue
        entry: dict = {}
        for col, mapping in SKILL_COLUMNS.items():
            raw = val(skills_ws, r, col)
            if mapping in ("forcedPrecise", "forcedCrit", "forcedResolve"):
                put(entry, mapping, raw == 1)
            elif mapping in ("type", "tuningCategory"):
                put(entry, mapping, raw if isinstance(raw, str) else None)
            else:
                put(entry, mapping, num(raw))
        skill_table[skill_name] = entry
    missing_skills = [s for s in used_skills if s not in skill_table]
    if missing_skills:
        raise ValueError(f"{key}: 技能表缺少这些技能: {missing_skills}")

    # ---------------- 增益表 ----------------
    last_col_header = val(buffs_ws, 1, 24)
    if not isinstance(last_col_header, str):
        raise ValueError(f"{key}: 增益表最后一列没有表头")
    if "结算增伤" in last_col_header:
        last_field = "settlementBonus"
    elif "特定增伤" in last_col_header:
        last_field = "specificBonus"
    else:
        raise ValueError(f"{key}: 未知的增益表最后一列: {last_col_header!r}")
    notes.append(f"增益表最后一列“{last_col_header}”映射为 {last_field}")

    used_buffs = sorted({b for a in actions for b in a["buffs"]})
    buff_table: dict[str, dict] = {}
    for r in range(2, buffs_ws.max_row + 1):
        buff_name = val(buffs_ws, r, 1)
        if not isinstance(buff_name, str) or buff_name not in used_buffs:
            continue
        entry = {}
        for col, mapping in BUFF_COLUMNS.items():
            raw = val(buffs_ws, r, col)
            if col == 24:
                entry[last_field] = num(raw)
            else:
                put(entry, mapping, num(raw))
        buff_table[buff_name] = entry
    missing_buffs = [b for b in used_buffs if b not in buff_table]
    if missing_buffs:
        raise ValueError(f"{key}: 增益表缺少这些增益: {missing_buffs}")

    # ---------------- 组装 ----------------
    package = {
        "schemaVersion": 1,
        "id": key,
        "name": name,
        "version": version,
        "source": f"参考/{filename}",
        "notes": notes,
        "build": {
            "element": element_name,
            "setMultiplier": set_multiplier,
            "foodBonus": {"min": food_min, "max": food_max},
            "basePhysicalDamageBonus": base_phys_damage_bonus,
            "flatDamageBonus": flat_damage_bonus,
            "flatDamageTypes": weapon_type_names,
            "directCritRate": direct_crit,
            "directResolveRate": direct_resolve,
            "critDamageBonus": crit_damage_bonus,
            "resolveDamageBonus": resolve_damage_bonus,
            "tuningCategory": tuning_active["category"],
            "generalDamageFlatBonus": general_damage_flat,
            "typeBonuses": type_bonuses,
            "elementAttackAugment": {
                "min": augment_min,
                "max": augment_max,
                "appliesTo": "activeElement",
            },
        },
        "target": target,
        "rotation": {
            "clearTime": clear_time,
            "benchmarkAdps": benchmark_adps,
            "actions": actions,
        },
        "skills": skill_table,
        "buffs": buff_table,
    }

    inputs = {
        "schemaVersion": 1,
        "packageId": key,
        "precision": precision,
        "critRate": crit_rate,
        "resolveRate": resolve_rate,
        "tuningBonus": tuning_active["bonus"],
        "attack": {
            "physical": {
                "min": phys_min,
                "max": phys_max,
                "penetration": phys_pen,
                "damageBonus": None,  # 外功伤害加成属于流派包 build.basePhysicalDamageBonus
            },
            "elements": {k: elements[k] for k in ELEMENT_ORDER},
        },
        # 各类增伤（全武增/首领增/各武器增/奇术增），键名与流派包 typeBonuses 的 add 对应
        "bonuses": bonus_inputs,
    }

    reference = {
        "packageId": key,
        "totalDamage": total_damage_ref,
        "adps": adps_ref,
        "graduationRate": graduation_ref,
        "benchmarkAdps": benchmark_adps,
        "actionCount": len(actions),
        "settlementCount": len(settlement_specs),
    }
    return package, inputs, reference


def main() -> None:
    OUT_PACKAGES.mkdir(exist_ok=True)
    OUT_INPUTS.mkdir(exist_ok=True)
    references = {}
    for key, name, version, filename in FILES:
        package, inputs, reference = extract(key, name, version, filename)
        (OUT_PACKAGES / f"{key}.json").write_text(
            json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (OUT_INPUTS / f"{key}.json").write_text(
            json.dumps(inputs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        references[key] = reference
        print(
            f"{key:16s} 动作 {reference['actionCount']:3d} 个（结算 {reference['settlementCount']}）"
            f" 技能 {len(package['skills']):2d} 增益 {len(package['buffs']):2d}"
            f" 总伤 {reference['totalDamage']:.2f}"
        )
        for n in package["notes"]:
            print(f"    note: {n}")
    (PROJECT / "reference-snapshot.json").write_text(
        json.dumps(references, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
