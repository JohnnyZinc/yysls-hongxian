# -*- coding: utf-8 -*-
"""
对比四个流派的 skills / effects，找出共同内容与差异。
输出：控制台摘要 + data/comparison_report.json（完整细节）
"""
import json
import math
import sys

sys.stdout.reconfigure(encoding="utf-8")

BUILDS = [
    ("pozhufeng.115.3.2", "破竹风"),
    ("qiansiyu.115.3.5", "牵丝玉"),
    ("pozhuchen.115.3.3", "破竹尘"),
    ("pozhuzun.115.3.6", "破竹樽"),
    ("lieshiwei.115.3.1", "裂石威"),
    ("qiansilin.115.3.1", "牵丝霖"),
]
NAME_OF = dict(BUILDS)


def load(kind, prefix):
    with open(f"data/{prefix}.{kind}.json", encoding="utf-8") as f:
        return json.load(f)[kind]


def eq(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)
    if isinstance(a, dict) and isinstance(b, dict):
        keys = set(a) | set(b)
        return all(eq(a.get(k), b.get(k)) for k in keys)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(eq(x, y) for x, y in zip(a, b))
    return a == b


def diff_fields(a, b):
    keys = set(a) | set(b)
    return sorted(k for k in keys if not eq(a.get(k), b.get(k)))


def cluster(name_values):
    """{build_id: record} -> [(代表record, [build_ids]), ...] 按值相等聚类"""
    clusters = []
    for bid, rec in name_values.items():
        for rep, members in clusters:
            if eq(rep, rec):
                members.append(bid)
                break
        else:
            clusters.append((rec, [bid]))
    return clusters


def compare(kind):
    data = {bid: load(kind, bid) for bid, _ in BUILDS}
    all_names = set()
    for d in data.values():
        all_names |= set(d.keys())

    report = {"all4_identical": [], "all4_conflict": {}, "partial": {}, "unique": {}}
    for name in sorted(all_names):
        holders = {bid: data[bid][name] for bid in data if name in data[bid]}
        if len(holders) == 4:
            clusters = cluster(holders)
            if len(clusters) == 1:
                report["all4_identical"].append(name)
            else:
                rep, rep_members = clusters[0]
                diffs = []
                for rec, members in clusters[1:]:
                    fields = diff_fields(rep, rec)
                    diffs.append({
                        "group_a": [NAME_OF[b] for b in rep_members],
                        "group_b": [NAME_OF[b] for b in members],
                        "fields": {
                            f: {"A": rep.get(f), "B": rec.get(f)} for f in fields
                        },
                    })
                report["all4_conflict"][name] = {
                    "clusters": [[NAME_OF[b] for b in m] for _, m in clusters],
                    "diffs": diffs,
                }
        elif len(holders) > 1:
            clusters = cluster(holders)
            report["partial"][name] = {
                "holders": [NAME_OF[b] for b in holders],
                "clusters": [[NAME_OF[b] for b in m] for _, m in clusters],
            }
        else:
            bid = next(iter(holders))
            report["unique"].setdefault(bid, []).append(name)
    return report, {NAME_OF[b]: len(data[b]) for b in data}


def print_report(kind, report, counts):
    print("=" * 64)
    print(f"【{kind} 对比】 各流派条目数: {counts}")
    print()
    ident = report["all4_identical"]
    print(f"◆ 四流派共有且数值完全一致（可抽为共享数据）: {len(ident)} 个")
    for i in range(0, len(ident), 6):
        print("   " + "、".join(ident[i:i + 6]))
    print()

    conflict = report["all4_conflict"]
    print(f"◆ 四流派共有但存在差异: {len(conflict)} 个")
    for name, info in conflict.items():
        cl = " vs ".join("+".join(c) for c in info["clusters"])
        print(f"   · {name}: {cl}")
        for d in info["diffs"]:
            fields_desc = "; ".join(
                f"{f}({d['fields'][f]['A']} vs {d['fields'][f]['B']})"
                for f in d["fields"])
            print(f"     差异字段: {fields_desc}")
    print()

    partial = report["partial"]
    print(f"◆ 仅部分流派共有: {len(partial)} 个")
    for name, info in partial.items():
        cl = " vs ".join("+".join(c) for c in info["clusters"])
        same = "（数值一致）" if len(info["clusters"]) == 1 else "（数值有差异）"
        print(f"   · {name}: {'/'.join(info['holders'])} {same} {cl if len(info['clusters'])>1 else ''}")
    print()

    unique = report["unique"]
    total_unique = sum(len(v) for v in unique.values())
    print(f"◆ 流派独有: {total_unique} 个")
    for bid, names in unique.items():
        print(f"   · {NAME_OF[bid]}({len(names)}): {'、'.join(names)}")
    print()


def main():
    full = {}
    for kind in ("skills", "effects"):
        report, counts = compare(kind)
        print_report(kind, report, counts)
        full[kind] = report
    with open("data/comparison_report.json", "w", encoding="utf-8") as f:
        json.dump(full, f, ensure_ascii=False, indent=2)
    print("完整报告已写入 data/comparison_report.json")


if __name__ == "__main__":
    main()
