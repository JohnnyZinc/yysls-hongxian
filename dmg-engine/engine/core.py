"""期望伤害引擎：与流派无关的那部分计算。

模型（与规格一致，不出现任何单元格/行/列概念）：

    总伤 = Σ 每个动作的伤害
    标准动作: L = 会心期望·会心占比 + 会意期望·会意占比 + 普通期望·普通占比 + 擦伤期望·擦伤占比
              每个状态 = 外功分支 + 鸣金分支 + 裂石分支 + 牵丝分支 + 破竹分支
              分支 = (即时攻击 × 倍率 + 固伤) × (1 + 该分支穿透) × (1 + 该分支伤害加成)
              只有「生效属性」那一支使用属性倍率，并且只有它吃「属性固伤 ×1.5」
              然后 × (1+通用增伤) × 状态伤害倍率 × 次数 × (1+定音) × (1+特殊增伤) × (1+特定增伤)
    派生结算动作: L = Σ(窗口内各动作的 L) × 结算比例 × (1 + 结算增伤)

    输出: adps = 总伤 / 战斗时间 ; graduationRate = adps / 基准ADPS
"""

from __future__ import annotations

from typing import Any

ELEMENT_ORDER = ("mingjin", "lieshi", "qiansi", "pozhu")
ELEMENT_NAME_TO_KEY = {"鸣金": "mingjin", "裂石": "lieshi", "牵丝": "qiansi", "破竹": "pozhu"}

CRIT_RATE_CAP = 0.80
RESOLVE_RATE_CAP = 0.40
ELEMENT_FLAT_MULTIPLIER = 1.5
PENETRATION_POSITIVE_DIVISOR = 200.0
PENETRATION_NEGATIVE_DIVISOR = 100.0


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _sum_buff(buff_entries: list[dict], path: str) -> float:
    """按字段路径对一组增益求和；path 形如 'penetration.qiansi'。"""
    total = 0.0
    head, _, tail = path.partition(".")
    for entry in buff_entries:
        value = entry.get(head)
        if value is None:
            continue
        if tail:
            value = value.get(tail, 0.0)
        total += float(value or 0.0)
    return total


def _penetration_bonus(net: float) -> float:
    """穿透净额 → 伤害乘区。净额为正按 0.5%/点，为负按 1%/点。"""
    if net > 0:
        return net / PENETRATION_POSITIVE_DIVISOR
    return net / PENETRATION_NEGATIVE_DIVISOR


def _mid(low: float, high: float) -> float:
    return (low + high) / 2.0


# --------------------------------------------------------------------------- #
# 攻击池：面板攻击 + 食物 + 生效属性补正，再乘套装系数
# --------------------------------------------------------------------------- #
def build_attack_pools(package: dict, inputs: dict) -> dict:
    build = package["build"]
    set_multiplier = float(build["setMultiplier"])
    food = build["foodBonus"]
    augment = build["elementAttackAugment"]
    active_key = ELEMENT_NAME_TO_KEY[build["element"]]

    phys = inputs["attack"]["physical"]
    pools: dict[str, Any] = {
        "physical": {
            # 游戏机制：最小外功 > 最大外功时伤害不再区间随机，而是固定取最小外功，
            # 所以小 = 面板小 + 食物小，大 = max(面板小 + 食物小, 面板大 + 食物大)
            "min": (float(phys["min"]) + float(food["min"])) * set_multiplier,
            "max": max(
                float(phys["min"]) + float(food["min"]),
                float(phys["max"]) + float(food["max"]),
            )
            * set_multiplier,
        },
        "elements": {},
    }
    for key in ELEMENT_ORDER:
        src = inputs["attack"]["elements"][key]
        is_active = key == active_key
        aug_min = float(augment["min"]) if is_active else 0.0
        aug_max = float(augment["max"]) if is_active else 0.0
        pools["elements"][key] = {
            # 同上：属性大攻取 max(面板小, 面板大)，再加生效属性补正
            "min": (float(src["min"]) + aug_min) * set_multiplier,
            "max": (max(float(src["min"]), float(src["max"])) + aug_max) * set_multiplier,
        }
    return pools


# --------------------------------------------------------------------------- #
# 单个标准动作
# --------------------------------------------------------------------------- #
def evaluate_skill_action(
    action: dict,
    package: dict,
    inputs: dict,
    pools: dict,
    skill_table: dict,
    buff_table: dict,
) -> dict:
    skill_name = action["skill"]
    if skill_name not in skill_table:
        raise KeyError(f"技能表中不存在技能: {skill_name!r}")
    skill = skill_table[skill_name]
    buffs = [buff_table[b] for b in action["buffs"] if b in buff_table]
    build = package["build"]
    target = package["target"]
    active_key = ELEMENT_NAME_TO_KEY[build["element"]]
    repeat = float(action.get("repeat", 1) or 0.0)

    forced_precise = bool(skill.get("forcedPrecise"))
    forced_crit = bool(skill.get("forcedCrit"))
    forced_resolve = bool(skill.get("forcedResolve"))

    # ---- 通用增伤 ----
    type_bonus = 0.0
    for entry in build["typeBonuses"]:
        if entry["name"] == skill.get("type"):
            type_bonus = sum(float(inputs["bonuses"][field]) for field in entry["add"])
            break
    general_damage = (
        float(inputs["bonuses"]["bossBonus"])
        + float(build["generalDamageFlatBonus"])
        + type_bonus
        + float(skill.get("generalDamage") or 0.0)
        + _sum_buff(buffs, "generalDamage")
    )

    # ---- 固伤（只对特定武器类型吃固伤加成） ----
    flat_gate = 1.0 + (
        float(build["flatDamageBonus"]) if skill.get("type") in build["flatDamageTypes"] else 0.0
    )
    physical_flat = float(skill.get("physicalFlat") or 0.0) * flat_gate
    element_flat = float(skill.get("elementFlat") or 0.0) * flat_gate

    # ---- 外功分支的即时值与乘区 ----
    physical_bonus = float(skill.get("physicalBonus") or 0.0) + _sum_buff(buffs, "physicalBonus")
    physical_min = (
        pools["physical"]["min"] * (1.0 + physical_bonus)
        + float(skill.get("minPhysical") or 0.0)
        + _sum_buff(buffs, "minPhysical")
        - float(target["defense"])
    )
    physical_max = (
        pools["physical"]["max"] * (1.0 + physical_bonus)
        + float(skill.get("maxPhysical") or 0.0)
        + _sum_buff(buffs, "maxPhysical")
        - float(target["defense"])
    )
    physical_penetration = _penetration_bonus(
        float(inputs["attack"]["physical"]["penetration"])
        - float(target["physicalResist"])
        + float(skill.get("physicalPenetration") or 0.0)
        + _sum_buff(buffs, "physicalPenetration")
    )
    physical_damage_bonus = (
        float(build["basePhysicalDamageBonus"])
        + float(skill.get("physicalDamageBonus") or 0.0)
        + _sum_buff(buffs, "physicalDamageBonus")
    )

    # ---- 四个属性分支 ----
    element_attack_bonus = float(skill.get("elementAttackBonus") or 0.0) + _sum_buff(
        buffs, "elementAttackBonus"
    )
    elements: dict[str, dict] = {}
    for key in ELEMENT_ORDER:
        src = inputs["attack"]["elements"][key]
        instant_min = pools["elements"][key]["min"] * (1.0 + element_attack_bonus)
        instant_max = pools["elements"][key]["max"] * (1.0 + element_attack_bonus)
        penetration = _penetration_bonus(
            float(src["penetration"])
            - float(target["elementResist"])
            + float((skill.get("penetration") or {}).get(key) or 0.0)
            + _sum_buff(buffs, f"penetration.{key}")
        )
        damage_bonus = (
            float(src["damageBonus"] or 0.0)
            + float((skill.get("elementDamageBonus") or {}).get(key) or 0.0)
            + _sum_buff(buffs, f"elementDamageBonus.{key}")
        )
        is_active = key == active_key
        ratio = float(skill.get("elementRatio") or 0.0) if is_active else float(
            skill.get("physicalRatio") or 0.0
        )
        flat = element_flat * ELEMENT_FLAT_MULTIPLIER if is_active else 0.0
        elements[key] = {
            "min": instant_min,
            "max": instant_max,
            "ratio": ratio,
            "flat": flat,
            "penetration": penetration,
            "damageBonus": damage_bonus,
        }

    physical_ratio = float(skill.get("physicalRatio") or 0.0)

    def substrate(kind: str) -> float:
        """按取档类型把五个分支相加：mid=小大取中值，big=取大攻，small=取小攻。"""
        if kind == "mid":
            attack = _mid(physical_min, physical_max)
        elif kind == "big":
            attack = physical_max
        elif kind == "small":
            attack = physical_min
        else:
            raise ValueError(kind)
        total = (attack * physical_ratio + physical_flat) * (1.0 + physical_penetration) * (
            1.0 + physical_damage_bonus
        )
        for key in ELEMENT_ORDER:
            data = elements[key]
            if kind == "mid":
                instant = _mid(data["min"], data["max"])
            elif kind == "big":
                instant = data["max"]
            else:
                instant = data["min"]
            total += (instant * data["ratio"] + data["flat"]) * (1.0 + data["penetration"]) * (
                1.0 + data["damageBonus"]
            )
        return total

    # ---- 四态概率 ----
    precision = float(inputs["precision"])
    # 游戏机制：只有精准命中才可能触发会心，所以强制会心必然精准（生效精准一并拉满）
    effective_precision = 1.0 if forced_crit else precision
    effective_precision = min(effective_precision, 1.0)

    crit_rate = min(
        CRIT_RATE_CAP,
        float(inputs["critRate"]) + float(skill.get("critRate") or 0.0) + _sum_buff(buffs, "critRate"),
    )
    direct_crit = (
        float(build["directCritRate"]) + _sum_buff(buffs, "directCritRate")
        if not forced_crit
        else 0.0
    )
    crit_share = 0.0 if forced_resolve else (1.0 if forced_crit else crit_rate + direct_crit)

    resolve_rate = min(
        RESOLVE_RATE_CAP,
        float(inputs["resolveRate"])
        + float(skill.get("resolveRate") or 0.0)
        + _sum_buff(buffs, "resolveRate"),
    )
    direct_resolve = (
        float(build["directResolveRate"]) + _sum_buff(buffs, "directResolveRate")
        if not forced_resolve
        else 0.0
    )
    resolve_share = 0.0 if forced_crit else (1.0 if forced_resolve else resolve_rate + direct_resolve)

    graze_share = (
        0.0 if forced_precise else (1.0 - effective_precision) * (1.0 - resolve_share)
    )
    crit_weight = min(
        (1.0 - resolve_share) * effective_precision,
        effective_precision * crit_share,
    )
    normal_weight = 1.0 - resolve_share - crit_weight - graze_share

    crit_damage_multiplier = (
        1.0
        + float(build["critDamageBonus"])
        + float(skill.get("critDamage") or 0.0)
        + _sum_buff(buffs, "critDamage")
    )
    resolve_damage_multiplier = (
        1.0
        + float(build["resolveDamageBonus"])
        + float(skill.get("resolveDamage") or 0.0)
        + _sum_buff(buffs, "resolveDamage")
    )

    # ---- 全局乘区 ----
    tuning_multiplier = 1.0 + (
        float(inputs["tuningBonus"]) if skill.get("tuningCategory") == build["tuningCategory"] else 0.0
    )
    special_damage_bonus = _sum_buff(buffs, "specialDamageBonus") + float(target["dungeonTalent"])
    specific_damage_bonus = float(skill.get("specificBonus") or 0.0) + _sum_buff(buffs, "specificBonus")

    tail = (
        (1.0 + general_damage)
        * repeat
        * tuning_multiplier
        * (1.0 + special_damage_bonus)
        * (1.0 + specific_damage_bonus)
    )

    mid_substrate = substrate("mid")
    crit_expectation = mid_substrate * tail * crit_damage_multiplier
    resolve_expectation = substrate("big") * tail * resolve_damage_multiplier
    normal_expectation = mid_substrate * tail
    graze_expectation = substrate("small") * tail

    damage = (
        crit_expectation * crit_weight
        + resolve_expectation * resolve_share
        + normal_expectation * normal_weight
        + graze_expectation * graze_share
    )

    return {
        "index": action["index"],
        "kind": "skill",
        "skill": skill_name,
        "damage": damage,
        "critExpectation": crit_expectation,
        "resolveExpectation": resolve_expectation,
        "normalExpectation": normal_expectation,
        "grazeExpectation": graze_expectation,
        "weights": {
            "crit": crit_weight,
            "resolve": resolve_share,
            "normal": normal_weight,
            "graze": graze_share,
        },
    }


# --------------------------------------------------------------------------- #
# 顶层
# --------------------------------------------------------------------------- #
def evaluate_rotation(package: dict, inputs: dict, keep_details: bool = False) -> dict:
    pools = build_attack_pools(package, inputs)
    skill_table = package["skills"]
    buff_table = package["buffs"]
    rotation = package["rotation"]
    actions = rotation["actions"]

    results: list[dict] = [None] * len(actions)  # type: ignore[list-item]

    # 第一遍：标准动作
    for action in actions:
        if action.get("type", "skill") == "skill":
            results[action["index"]] = evaluate_skill_action(
                action, package, inputs, pools, skill_table, buff_table
            )

    # 第二遍：派生结算动作（窗口可能引用比自身更晚的动作，所以必须分开两遍）
    for action in actions:
        if action.get("type") != "settlement":
            continue
        buffs = [buff_table[b] for b in action["buffs"] if b in buff_table]
        window_sum = sum(float(results[i]["damage"]) for i in action["window"])
        settlement_bonus = _sum_buff(buffs, "settlementBonus")
        damage = window_sum * float(action["ratio"]) * (1.0 + settlement_bonus)
        results[action["index"]] = {
            "index": action["index"],
            "kind": "settlement",
            "damage": damage,
            "windowSum": window_sum,
            "ratio": float(action["ratio"]),
            "settlementBonus": settlement_bonus,
        }

    total_damage = sum(float(r["damage"]) for r in results)
    clear_time = float(rotation["clearTime"])
    adps = total_damage / clear_time if clear_time else 0.0
    benchmark = float(rotation["benchmarkAdps"])
    output = {
        "packageId": package["id"],
        "adps": adps,
        "graduationRate": adps / benchmark if benchmark else 0.0,
        "totalDamage": total_damage,
    }
    if keep_details:
        output["actions"] = results
    return output


def load_package(path) -> dict:
    import json
    from pathlib import Path

    return json.loads(Path(path).read_text(encoding="utf-8"))


def evaluate_files(package_path, input_path, keep_details: bool = False) -> dict:
    return evaluate_rotation(load_package(package_path), load_package(input_path), keep_details)
