# -*- coding: utf-8 -*-
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")


def load_eff(p):
    with open(f"data/{p}.effects.json", encoding="utf-8") as f:
        return json.load(f)["effects"]


def load_sk(p):
    with open(f"data/{p}.skills.json", encoding="utf-8") as f:
        return json.load(f)["skills"]


def nz(rec):
    return {k: v for k, v in rec.items() if v is not None}


fx = load_eff("pozhufeng.115.3.5")
zy = load_eff("pozhuzun.115.3.5")
qs = load_eff("qiansiyu.115.3.2")
ch = load_eff("pozhuchen.115.3.1")

print("--- 离猎 名称与数值对比 ---")
print("风 离猎(拐):", nz(fx["离猎(拐)"]))
print("樽 离猎    :", nz(zy["离猎"]))
print()
print("--- 步乱 名称与数值对比 ---")
print("风 步乱(拐):", nz(fx["步乱(拐)"]))
print("尘 步乱(拐):", nz(ch["步乱(拐)"]))
print("樽 步乱    :", nz(zy["步乱"]))
print()
print("--- 易水歌1层: 牵丝玉 vs 破竹风 ---")
print("牵丝玉:", nz(qs["易水歌1层"]))
print("破竹风:", nz(fx["易水歌1层"]))
print()
print("牵丝玉 5惊春:", nz(qs.get("5惊春", {})))
print("牵丝玉 阴阳 :", nz(qs.get("阴阳", {})))
print()

fs = load_sk("pozhufeng.115.3.5")
cs = load_sk("pozhuchen.115.3.1")
print("--- 绳Q 差异 (风 vs 尘) ---")
for k in fs["绳Q"]:
    a, b = fs["绳Q"][k], cs["绳Q"].get(k)
    if a != b:
        print(f"  {k}: 风={a} 尘={b}")
print("--- 结算 差异 (风 vs 尘) ---")
for k in fs["结算"]:
    a, b = fs["结算"][k], cs["结算"].get(k)
    if a != b:
        print(f"  {k}: 风={a} 尘={b}")
