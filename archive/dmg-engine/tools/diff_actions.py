#!/usr/bin/env python3
"""逐次施放比对：引擎算出的每次施放伤害 vs 原表 L 列缓存值。

用于定位总伤不一致的原因，以及确认没有互相抵消的误差。
用法：python tools/diff_actions.py [流派包编号]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import openpyxl

XIANGMU = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(XIANGMU))

from engine.core import jisuanWenjian  # noqa: E402

GONGZUOQU = XIANGMU.parent


def qiwang_lie(liupaibao: dict) -> list[float]:
    lujing = GONGZUOQU / liupaibao["laiyuan"]
    qiwang = openpyxl.load_workbook(lujing, data_only=True)["期望"]
    zhi_lie = []
    for hang in range(2, qiwang.max_row + 1):
        zhi = qiwang.cell(row=hang, column=12).value
        if isinstance(zhi, (int, float)):
            zhi_lie.append(float(zhi))
    return zhi_lie


def zhucheng() -> int:
    zhi_kan = sys.argv[1] if len(sys.argv) > 1 else None
    for baolu in sorted((XIANGMU / "packages").glob("*.json")):
        liupaibao = json.loads(baolu.read_text(encoding="utf-8"))
        if zhi_kan and liupaibao["bianhao"] != zhi_kan:
            continue
        jieguo = jisuanWenjian(baolu, XIANGMU / "inputs" / baolu.name, baoliuMingxi=True)
        cankao = qiwang_lie(liupaibao)
        yinqing = [t["shanghai"] for t in jieguo["shifang"]]
        print(f"\n=== {liupaibao['bianhao']}  施放数 引擎={len(yinqing)} 原表={len(cankao)} ===")
        if len(yinqing) != len(cankao):
            print("  施放数不一致！")
            continue
        butong = []
        for xu, (jia, yi) in enumerate(zip(yinqing, cankao)):
            chidu = max(abs(yi), 1.0)
            if abs(jia - yi) / chidu > 1e-9:
                butong.append((xu, jia, yi))
        print(f"  不一致施放数: {len(butong)}")
        for xu, jia, yi in butong[:15]:
            tiaomu = jieguo["shifang"][xu]
            biaoqian = tiaomu.get("jineng") or tiaomu.get("leixing")
            print(f"    #{xu:3d} {biaoqian:<24} 引擎={jia:14.2f} 原表={yi:14.2f} 差={(jia - yi) / max(abs(yi), 1):+.4%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(zhucheng())
