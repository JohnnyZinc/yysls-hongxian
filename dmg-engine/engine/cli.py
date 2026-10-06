"""命令行入口：python -m engine.cli --package packages/x.json --input inputs/x.json"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .core import evaluate_files, evaluate_rotation, load_package

PROJECT = Path(__file__).resolve().parents[1]


def resolve(path_str: str) -> Path:
    path = Path(path_str)
    return path if path.is_absolute() else PROJECT / path


def main() -> None:
    parser = argparse.ArgumentParser(description="期望伤害引擎")
    parser.add_argument("--package", required=True, help="流派包 JSON 路径")
    parser.add_argument("--input", required=True, help="输入快照 JSON 路径")
    parser.add_argument("--details", action="store_true", help="附带输出每个动作的明细")
    args = parser.parse_args()

    result = evaluate_files(resolve(args.package), resolve(args.input), keep_details=args.details)
    printable = {
        "packageId": result["packageId"],
        "adps": round(result["adps"], 4),
        "graduationRate": round(result["graduationRate"], 6),
        "totalDamage": round(result["totalDamage"], 4),
    }
    print(json.dumps(printable, ensure_ascii=False, indent=2))
    if args.details:
        for entry in result["actions"]:
            print(f"  #{entry['index']:3d} {entry['kind']:10s} {entry['damage']:14.2f}")


if __name__ == "__main__":
    main()
