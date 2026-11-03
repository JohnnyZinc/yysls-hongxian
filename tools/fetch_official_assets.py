#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 yysls.destiny.cool 的解包字典抓取燕云十六声官方图片素材。

数据源：https://yysls.destiny.cool/equip/decoded/<name>.json
（站点自托管的一份游戏解包字典，图片是网易 CDN 直链，无鉴权、无防盗链）

用法：
    python tools/fetch_official_assets.py              # 全量（缺什么下什么）
    python tools/fetch_official_assets.py --only head  # 只抓某一类
    python tools/fetch_official_assets.py --dry-run    # 只统计不下载

输出到 素材库/official/<类别>/<字段>/<id>.png（原始素材库，已被 .gitignore 忽略），并生成 index.json；
挑中要用的再拷进 assets/img/ 里入库。
"""
import argparse
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://yysls.destiny.cool/equip/decoded"
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://yysls.destiny.cool/"}

# 字典名 -> 输出类别
DICTS = {
    "xinfa": "xinfa",       # 心法
    "kongfu": "kongfu",     # 武学
    "equip_icon": "equip",  # 装备图标
    "qishu": "qishu",       # 奇术
    "head": "head",         # 头像
}
# 无图片字段，仅用于对齐事实
NO_IMAGE = ["equip_name", "equip_tiaolv", "equip_dingyin", "equip_prop", "equip_suit"]

MAGIC_EXT = {
    b"\x89PNG": ".png",
    b"\xff\xd8\xff": ".jpg",
    b"GIF8": ".gif",
    b"RIFF": ".webp",
}


def root_dir():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fetch(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def cache_dir():
    d = os.path.join(root_dir(), ".cache", "destiny")
    os.makedirs(d, exist_ok=True)
    return d


def load_dict(name):
    p = os.path.join(cache_dir(), name + ".json")
    if not os.path.exists(p):
        open(p, "wb").write(fetch(f"{BASE}/{name}.json"))
    return json.load(open(p, encoding="utf-8"))


def collect(data):
    """返回 [(key, field, url, entry)]：遍历字典树，挑出所有 http(s) 图片字段。"""
    out = []

    def walk(node, key):
        if isinstance(node, dict):
            for f, v in node.items():
                if isinstance(v, str) and v.startswith("http"):
                    out.append((key, f, v, node))
                else:
                    walk(v, key)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, key if isinstance(v, (list,)) else f"{key}_{i}")

    if isinstance(data, dict):
        for k, v in data.items():
            walk(v, str(k))
    else:
        walk(data, "0")
    return out


def ext_of(data):
    for magic, ext in MAGIC_EXT.items():
        if data[:len(magic)] == magic:
            return ext
    return ".png"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="只抓某个类别，如 head")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    # 注意：全量素材 300MB+，不进 web/（部署目录），统一放项目根「素材库/」；
    # 站点要用的图另从素材库拷贝。
    out_root = os.path.join(root_dir(), "素材库", "official")
    index = {}
    jobs = []  # (url, dest_without_ext)

    for name, cat in DICTS.items():
        if args.only and cat != args.only:
            continue
        data = load_dict(name)
        items = collect(data)
        seen = {}
        for key, field, url, entry in items:
            seen.setdefault(field, set())
            if url in seen[field]:
                continue
            seen[field].add(url)
            fname = url.rsplit("/", 1)[-1]
            dest = os.path.join(out_root, cat, field, fname)
            jobs.append((url, dest))
            idx = index.setdefault(cat, {}).setdefault(key, {})
            idx[field] = {"url": url, "file": os.path.relpath(dest, out_root).replace("\\", "/")}
            for nf in ("name", "type_name", "liupai_name", "weapon_type"):
                if isinstance(entry.get(nf), str) and "name_" + nf not in idx:
                    idx["name_" + nf] = entry[nf]
        print(f"{name:12s} -> {cat:6s} 字段 {({k: len(v) for k, v in seen.items()})}")

    print(f"待下载去重 URL：{len(jobs)}")
    if args.dry_run:
        return

    def work(job):
        url, dest = job
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if any(os.path.exists(dest + e) for e in set(MAGIC_EXT.values()) | {".png"}):
            return None
        try:
            b = fetch(url, timeout=45)
            open(dest + ext_of(b), "wb").write(b)
            return None
        except Exception as e:
            return (url, str(e))

    errs = [r for r in ThreadPoolExecutor(args.workers).map(work, jobs) if r]
    print("下载完成，失败", len(errs), errs[:5])

    index_path = os.path.join(out_root, "index.json")
    old = {}
    if os.path.exists(index_path):
        old = json.load(open(index_path, encoding="utf-8"))
    for cat, entries in index.items():
        old.setdefault(cat, {}).update(entries)
    json.dump(old, open(index_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    total = sum(len(v) for k, v in old.items())
    print("index.json ->", index_path, "类别", list(old), "条目", total)

    size = 0
    for dp, _, fs in os.walk(out_root):
        for f in fs:
            size += os.path.getsize(os.path.join(dp, f))
    print("official/ 总体积 MB", round(size / 1048576, 1))


if __name__ == "__main__":
    main()
