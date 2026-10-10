# -*- coding: utf-8 -*-
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

print("== 1. panel_input 污染检查（不应再出现 绳~/灯/白刀123 等时间统计标签）==")
for p in ["pozhufeng.115.3.2", "lieshiwei.115.3.1", "qiansilin.115.3.1"]:
    with open(f"data/{p}.json", encoding="utf-8") as f:
        d = json.load(f)
    keys = list(d["panel_input"].keys())
    print(f"  {p}: {keys}")

print()
print("== 2. 偏移布局时间轴抽查（裂石威/牵丝霖）==")
for p in ["lieshiwei.115.3.1", "qiansilin.115.3.1"]:
    with open(f"data/{p}.json", encoding="utf-8") as f:
        d = json.load(f)
    print(f"  {p}: {len(d['timeline'])}事件, 技能分布top5:")
    from collections import Counter
    c = Counter(e["skill"] for e in d["timeline"])
    for k, v in c.most_common(5):
        print(f"    {v}x {k}")
    print("  首事件:", d["timeline"][0])
    cond = [e for e in d["timeline"] if "count_conditional" in e]
    if cond:
        print("  条件次数示例:", cond[0])

print()
print("== 3. 关键build参数 ==")
for p, name in [("pozhufeng.115.3.2", "破竹风"), ("qiansiyu.115.3.5", "牵丝玉"),
                ("pozhuchen.115.3.3", "破竹尘"), ("pozhuzun.115.3.6", "破竹樽"),
                ("lieshiwei.115.3.1", "裂石威"), ("qiansilin.115.3.1", "牵丝霖")]:
    with open(f"data/{p}.json", encoding="utf-8") as f:
        d = json.load(f)
    print(f"  {name}: 属性={d['selectors']['weapon_attribute']} 套装={d['selectors']['set']} "
          f"时长={d['monster']['duration']['value']} 毕业DPS={d['graduate_dps']} "
          f"武器类别={[w['label'] for w in d['weapon_categories']]}")
