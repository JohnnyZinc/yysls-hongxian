# -*- coding: utf-8 -*-
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

with open("data/qiansilin.115.3.1.skills.json", encoding="utf-8") as f:
    d = json.load(f)["skills"]

print("牵丝霖 N/a 技能的非空字段:")
for k, v in d["N/a"].items():
    if v is not None:
        print(f"  {k}: {v}")

print()
print("牵丝霖 全部技能名:", list(d.keys()))

# 牵丝霖时间轴里 N/a 事件的 count 分布
with open("data/qiansilin.115.3.1.json", encoding="utf-8") as f:
    b = json.load(f)
na_counts = [e["count"] for e in b["timeline"] if e["skill"] == "N/a"]
print()
print(f"牵丝霖 N/a 事件数: {len(na_counts)}, count分布: {sorted(set(na_counts))}")
