#!/usr/bin/env python3
"""示例：拿流派包直接做参数敏感性分析（这里以「武器增伤 +1%」和「会心率 +5%」为例）。

用法：python tools/example_override.py [package_id]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from engine.core import evaluate_rotation  # noqa: E402


def load(key: str) -> tuple[dict, dict]:
    package = json.loads((PROJECT / "packages" / f"{key}.json").read_text(encoding="utf-8"))
    inputs = json.loads((PROJECT / "inputs" / f"{key}.json").read_text(encoding="utf-8"))
    return package, inputs


def main() -> None:
    key = sys.argv[1] if len(sys.argv) > 1 else "pozhu_zun_3.5"
    package, inputs = load(key)

    base = evaluate_rotation(package, inputs)
    print(f"{package['name']} {package['version']}  基线: ADPS={base['adps']:.2f} 毕业率={base['graduationRate']:.6f}")

    experiments = [
        ("武器增伤1 +1%", lambda d: d["bonuses"].__setitem__("weaponBonus1", d["bonuses"]["weaponBonus1"] + 0.01)),
        ("会心率 +5%", lambda d: d.__setitem__("critRate", d["critRate"] + 0.05)),
        ("对应属性穿透 +10", None),
        ("技能释放次数整体 +5%", None),
    ]

    for label, mutate in experiments:
        trial = json.loads(json.dumps(inputs))
        if label == "对应属性穿透 +10":
            element = package["build"]["element"]
            key_map = {"鸣金": "mingjin", "裂石": "lieshi", "牵丝": "qiansi", "破竹": "pozhu"}
            trial["attack"]["elements"][key_map[element]]["penetration"] += 10
        elif label == "技能释放次数整体 +5%":
            for action in package["rotation"]["actions"]:
                if action.get("type", "skill") == "skill" and action.get("repeat"):
                    action["repeat"] = action["repeat"] * 1.05
        else:
            mutate(trial)
        result = evaluate_rotation(package, trial)
        delta = result["adps"] / base["adps"] - 1.0
        print(f"  {label:<18} ADPS={result['adps']:>12.2f}  毕业率={result['graduationRate']:.6f}  Δ={delta:+.3%}")


if __name__ == "__main__":
    main()
