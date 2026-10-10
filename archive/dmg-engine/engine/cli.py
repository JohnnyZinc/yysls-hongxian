"""命令行入口：python -m engine.cli --liupaibao liupaibao/x.json --shuru shuru/x.json"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .core import jisuanWenjian

XIANGMU = Path(__file__).resolve().parents[1]


def jiexi(lujingZi: str) -> Path:
    lujing = Path(lujingZi)
    return lujing if lujing.is_absolute() else XIANGMU / lujing


def main() -> None:
    jiexiqi = argparse.ArgumentParser(description="期望伤害引擎")
    jiexiqi.add_argument("--liupaibao", required=True, help="流派包 JSON 路径")
    jiexiqi.add_argument("--shuru", required=True, help="输入快照 JSON 路径")
    jiexiqi.add_argument("--mingxi", action="store_true", help="附带输出每次施放的明细")
    canshu = jiexiqi.parse_args()

    jieguo = jisuanWenjian(jiexi(canshu.liupaibao), jiexi(canshu.shuru), baoliuMingxi=canshu.mingxi)
    keyin = {
        "liupaiBaoBianhao": jieguo["liupaiBaoBianhao"],
        "adps": round(jieguo["adps"], 4),
        "biyelv": round(jieguo["biyelv"], 6),
        "zongshang": round(jieguo["zongshang"], 4),
    }
    print(json.dumps(keyin, ensure_ascii=False, indent=2))
    if canshu.mingxi:
        for tiaomu in jieguo["shifang"]:
            print(f"  #{tiaomu['xuhao']:3d} {tiaomu['leixing']:8s} {tiaomu['shanghai']:14.2f}")


if __name__ == "__main__":
    main()
