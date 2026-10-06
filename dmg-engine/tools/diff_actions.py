#!/usr/bin/env python3
"""逐动作比对：引擎算出的每个动作伤害 vs 原表 L 列缓存值。

用于定位总伤一致/不一致的原因，以及确认没有互相抵消的误差。
用法：python tools/diff_actions.py [package_id]
"""
from __future__ import annotations

import sys
from pathlib import Path

import openpyxl

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from engine.core import evaluate_files  # noqa: E402

WORKSPACE = PROJECT.parent


def sheet_l_values(package: dict) -> list[float]:
    path = WORKSPACE / package["source"]
    ws = openpyxl.load_workbook(path, data_only=True)["期望"]
    values = []
    for r in range(2, ws.max_row + 1):
        v = ws.cell(row=r, column=12).value
        if isinstance(v, (int, float)):
            values.append(float(v))
    return values


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    import json

    for pkg_path in sorted((PROJECT / "packages").glob("*.json")):
        package = json.loads(pkg_path.read_text(encoding="utf-8"))
        if only and package["id"] != only:
            continue
        inputs_path = PROJECT / "inputs" / pkg_path.name
        result = evaluate_files(pkg_path, inputs_path, keep_details=True)
        reference = sheet_l_values(package)
        engine = [entry["damage"] for entry in result["actions"]]
        print(f"\n=== {package['id']}  动作数 引擎={len(engine)} 原表={len(reference)} ===")
        if len(engine) != len(reference):
            print("  动作数不一致！")
            continue
        bad = []
        for i, (a, b) in enumerate(zip(engine, reference)):
            scale = max(abs(b), 1.0)
            if abs(a - b) / scale > 1e-9:
                bad.append((i, a, b))
        print(f"  不一致动作数: {len(bad)}")
        for i, a, b in bad[:15]:
            action = result["actions"][i]
            label = action.get("skill") or action.get("kind")
            print(f"    #{i:3d} {label:<24} 引擎={a:14.2f} 原表={b:14.2f} 差={(a-b)/max(abs(b),1):+.4%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
