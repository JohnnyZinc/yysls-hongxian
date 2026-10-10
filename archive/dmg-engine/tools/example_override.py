#!/usr/bin/env python3
"""示例：拿流派包直接做参数敏感性分析（这里以「武器增伤 +1%」和「会心率 +5%」为例）。

用法：python tools/example_override.py [流派包编号]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

XIANGMU = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(XIANGMU))

from engine.core import SHUXING_MINGCHENG_DAO_JIAN, jisuanZhou  # noqa: E402


def duqu(bianhao: str) -> tuple[dict, dict]:
    liupaibao = json.loads((XIANGMU / "packages" / f"{bianhao}.json").read_text(encoding="utf-8"))
    shuru = json.loads((XIANGMU / "inputs" / f"{bianhao}.json").read_text(encoding="utf-8"))
    return liupaibao, shuru


def zhucheng() -> None:
    bianhao = sys.argv[1] if len(sys.argv) > 1 else "pozhu_zun_3.5"
    liupaibao, shuru = duqu(bianhao)

    jizhun = jisuanZhou(liupaibao, shuru)
    print(
        f"{liupaibao['mingcheng']} {liupaibao['banben']}  基线: "
        f"ADPS={jizhun['adps']:.2f} 毕业率={jizhun['biyelv']:.6f}"
    )

    shiyan = ["武器增伤1 +1%", "会心率 +5%", "对应属性穿透 +10", "技能施放次数整体 +5%"]
    for biaoqian in shiyan:
        shiyan_shuru = json.loads(json.dumps(shuru))
        if biaoqian == "武器增伤1 +1%":
            shiyan_shuru["zengshang"]["wuqiZeng1"] += 0.01
        elif biaoqian == "会心率 +5%":
            shiyan_shuru["huixinlv"] += 0.05
        elif biaoqian == "对应属性穿透 +10":
            jian = SHUXING_MINGCHENG_DAO_JIAN[liupaibao["peizhuang"]["wuxueShuxing"]]
            shiyan_shuru["gongji"]["shuxing"][jian]["chuantou"] += 10
        else:
            for shifang in liupaibao["zhou"]["shifang"]:
                if shifang.get("leixing", "jineng") == "jineng" and shifang.get("cishu"):
                    shifang["cishu"] = shifang["cishu"] * 1.05
        jieguo = jisuanZhou(liupaibao, shiyan_shuru)
        bianhua = jieguo["adps"] / jizhun["adps"] - 1.0
        print(
            f"  {biaoqian:<18} ADPS={jieguo['adps']:>12.2f}  "
            f"毕业率={jieguo['biyelv']:.6f}  Δ={bianhua:+.3%}"
        )


if __name__ == "__main__":
    zhucheng()
