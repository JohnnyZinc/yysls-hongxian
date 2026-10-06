#!/usr/bin/env python3
"""用抽取时留下的参考值校验引擎：引擎重算的 总伤 / ADPS 必须与原表缓存值一致。

用法：python tools/verify.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from engine.core import evaluate_files  # noqa: E402

TOLERANCE = 1e-9  # 相对误差


def main() -> int:
    reference = json.loads((PROJECT / "reference-snapshot.json").read_text(encoding="utf-8"))
    failures = 0
    print(f"{'流派':<12}{'总伤(引擎)':>18}{'总伤(原表)':>18}{'相对误差':>12}{'ADPS(引擎)':>16}{'毕业率':>10}")
    for key, ref in reference.items():
        result = evaluate_files(
            PROJECT / "packages" / f"{key}.json",
            PROJECT / "inputs" / f"{key}.json",
        )
        rel = abs(result["totalDamage"] - ref["totalDamage"]) / ref["totalDamage"]
        flag = "" if rel <= TOLERANCE else "  <-- 不一致"
        if rel > TOLERANCE:
            failures += 1
        print(
            f"{key:<12}{result['totalDamage']:>18.2f}{ref['totalDamage']:>18.2f}"
            f"{rel:>12.2e}{result['adps']:>16.2f}{result['graduationRate']:>10.6f}{flag}"
        )
    if failures:
        print(f"\n{failures} 个流派未通过校验")
    else:
        print(f"\n全部 {len(reference)} 个流派通过校验（相对误差 <= {TOLERANCE:g}）")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
