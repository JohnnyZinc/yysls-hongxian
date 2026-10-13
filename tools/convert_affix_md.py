# -*- coding: utf-8 -*-
"""把三份词条 MD（115阶词条数值区间表/各部位词条池表/神力词条）转换为
当前赛季目录下的 affixes.json（赛季由 data/version/manifest.json 声明）

规则（用户确认）：
  - 气血最大值/外功防御词条的承音值 = 最大值 × 0.94（原表缺失，按统一规则补齐）
  - 定音词条无承音惩罚（承音装备的定音词条可达到最大值）
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

MANIFEST = "data/version/manifest.json"
RANGES_MD = r"参考\115阶词条数值区间表.md"
POOLS_MD = r"参考\各部位词条池表.md"


def current_season_dir():
    """读 manifest 声明的当前赛季 → data/version/<赛季id>/ 目录"""
    with open(MANIFEST, encoding="utf-8") as f:
        season = json.load(f).get("当前赛季")
    if not season:
        raise SystemExit(f'{MANIFEST} 缺少 "当前赛季" 字段')
    return f"data/version/{season}"


def parse_pct(v):
    """'7.2%' → 0.072；纯数字 → float"""
    v = str(v).strip()
    if v.endswith("%"):
        return round(float(v[:-1]) / 100, 6)
    return float(v)


def parse_range_table(path):
    """解析区间表 markdown → {词条: {min, 承音, max}}"""
    rows = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 4 or cells[0] in ("词条", "") or set(cells[0]) <= set("- :"):
                continue
            name, lo, cheng, hi = cells[0], cells[1], cells[2], cells[3]
            rec = {"min": parse_pct(lo), "max": parse_pct(hi)}
            if cheng:
                rec["承音"] = parse_pct(cheng)
            else:
                # 数据缺失：按统一规则 最大值×94% 补齐
                rec["承音"] = round(rec["max"] * 0.94, 6)
                rec["承音来源"] = "推算(94%)"
            rows[name] = rec
    return rows


def parse_pools(path):
    """解析词条池 markdown → {池名: {槽位组: [词条...]}} + 定音区间"""
    text = open(path, encoding="utf-8").read()
    sections = re.split(r"^## ", text, flags=re.M)[1:]
    pools = {}
    dingyin_ranges = {}
    skill_dingyin = []
    for sec in sections:
        title, _, body = sec.partition("\n")
        title = title.strip()
        groups = {}
        last_group = None
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith("- 外功穿透的数值区间"):
                continue
            m = re.match(r"^外功穿透的数值区间为 ([\d.~%]+)，外功抗性的数值区间为 ([\d.~%]+)，无相穿透的数值区间为 ([\d.~%]+)", line)
            if m:
                for name, rng in zip(("外功穿透", "外功抗性", "无相穿透"), m.groups()):
                    lo, hi = rng.split("~")
                    dingyin_ranges[name] = {"min": parse_pct(lo), "max": parse_pct(hi)}
                continue
            m = re.match(r"^以上这些指定技能增伤的数值区间均为 ([\d.~%]+)", line)
            if m:
                lo, hi = m.group(1).split("~")
                dingyin_ranges["技能定音"] = {"min": parse_pct(lo), "max": parse_pct(hi)}
                continue
            # "- 词条、词条" 续行：追加到上一个组
            m = re.match(r"^-\s+(.+)$", line)
            if m and last_group:
                items = [x.strip() for x in re.split(r"[、，]", m.group(1)) if x.strip()]
                groups[last_group].extend(items)
                continue
            m = re.match(r"^([^：:]+)[：:](.*)$", line)
            if m:
                slot_part, list_part = m.group(1).strip(), m.group(2).strip()
                if "数值区间" in slot_part:
                    continue
                items = [x.strip() for x in re.split(r"[、，]", list_part) if x.strip()]
                groups[slot_part] = items
                last_group = slot_part
        if title == "定音词条池":
            for slot, items in groups.items():
                if "冠胄" in slot:
                    skill_dingyin = list(items)
                    groups[slot] = ["技能定音"]
        pools[title] = groups
    return pools, dingyin_ranges, skill_dingyin


def main():
    out_dir = current_season_dir()
    out_path = f"{out_dir}/affixes.json"
    ranges = parse_range_table(RANGES_MD)
    pools, dingyin_ranges, skill_dingyin = parse_pools(POOLS_MD)

    out = {
        "version": {"装备等阶": 115},
        "词条区间": ranges,
        "定音区间": dingyin_ranges,
        "规则": {
            "定音词条无承音惩罚": True,
            "承音上限默认系数": 0.94,
        },
        "词条池": pools,
    }
    if skill_dingyin:
        out["护甲定音词条"] = skill_dingyin

    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"-> {out_path}")
    print(f"词条区间 {len(ranges)} 条; 定音区间 {list(dingyin_ranges)}; "
          f"池: { {k: len(v) for k, v in pools.items()} }; 护甲定音词条 {len(skill_dingyin)} 条")


if __name__ == "__main__":
    main()
