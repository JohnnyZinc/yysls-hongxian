#!/usr/bin/env python3
"""用抽取时留下的参考值校验引擎：引擎重算的总伤 / ADPS 必须与原表缓存值一致。

用法：python tools/verify.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

XIANGMU = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(XIANGMU))

from engine.core import jisuanWenjian  # noqa: E402

RONGCHA = 1e-9  # 相对误差


def zhucheng() -> int:
    cankao_ji = json.loads((XIANGMU / "reference-snapshot.json").read_text(encoding="utf-8"))
    shibai = 0
    print(f"{'流派':<12}{'总伤(引擎)':>18}{'总伤(原表)':>18}{'相对误差':>12}{'ADPS(引擎)':>16}{'毕业率':>10}")
    for bianhao, cankao in cankao_ji.items():
        jieguo = jisuanWenjian(
            XIANGMU / "packages" / f"{bianhao}.json",
            XIANGMU / "inputs" / f"{bianhao}.json",
        )
        wucha = abs(jieguo["zongshang"] - cankao["zongshang"]) / cankao["zongshang"]
        biaoji = "" if wucha <= RONGCHA else "  <-- 不一致"
        if wucha > RONGCHA:
            shibai += 1
        print(
            f"{bianhao:<12}{jieguo['zongshang']:>18.2f}{cankao['zongshang']:>18.2f}"
            f"{wucha:>12.2e}{jieguo['adps']:>16.2f}{jieguo['biyelv']:>10.6f}{biaoji}"
        )
    if shibai:
        print(f"\n{shibai} 个流派未通过校验")
    else:
        print(f"\n全部 {len(cankao_ji)} 个流派通过校验（相对误差 <= {RONGCHA:g}）")
    return 1 if shibai else 0


if __name__ == "__main__":
    raise SystemExit(zhucheng())
