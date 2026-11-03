#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取 yysls.destiny.cool 站点自身的 UI 图片素材（不是游戏解包素材，那批见 fetch_official_assets.py）。

素材分两类：
  1. 站点自己的 /assets/*.png|jpg|webp（logo、导航底纹、宣纸底、KV 大图…）
  2. 站点引用的官网壁纸 https://www.yysls.cn/pc/gw/... （进 wallpaper/ 子目录）

⚠ 历史坑（2026-10-24 踩过，勿复现）：
  - 千万别用正则从完整 URL 里抠文件名再拼到站点域名上——壁纸在 www.yysls.cn 不在站点域，
    拼错会 404。必须保留完整 URL。
  - open(path,'wb') 之后再 fetch，请求失败会留下 0 字节空文件。必须先下到内存、成功才写盘。

用法：
    python tools/one-off/fetch_site_assets.py
"""
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ORIGIN = "https://yysls.destiny.cool"
UA = {"User-Agent": "Mozilla/5.0", "Referer": ORIGIN + "/"}
IMG_EXT = ("png", "jpg", "jpeg", "webp", "gif", "svg")


def root_dir():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def get_text(url):
    return get(url).decode("utf-8", "ignore")


def collect_assets(text):
    """返回 (完整URL集合, 站内相对路径集合)。

    站内路径必须保留完整（如 /assets/wallpaper/xx.webp），只取文件名会拼错目录 → 404。
    """
    ext = "|".join(IMG_EXT)
    full = set(re.findall(r"https?://[\w\.\-]+/[^\s`'\"()]+?\.(?:%s)" % ext, text))
    site = set(re.findall(r"/assets/[\w\-/\.]+\.(?:%s)" % ext, text))
    # new URL(`yysls-logo-xxx.png`, import.meta.url)
    for m in re.findall(r"new URL\(`([\w\-\.]+\.(?:%s))`" % ext, text):
        site.add("/assets/" + m)
    return full, site


def main():
    out = os.path.join(root_dir(), "素材库", "site")
    wall = os.path.join(out, "wallpaper")
    os.makedirs(wall, exist_ok=True)

    html = get_text(ORIGIN + "/")
    chunks = set(re.findall(r"/assets/[\w\-\.]+\.(?:js|css)", html))
    # 懒加载分包：入口 js 里的 "/assets/xxx-hash.js" 或 import("./xxx-hash.js")
    for e in list(chunks):
        if not e.endswith(".js"):
            continue
        try:
            t = get_text(ORIGIN + e)
        except Exception:
            continue
        chunks |= {"/assets/" + c for c in re.findall(r"assets/([\w\-\.]+\.js)", t)}
        chunks |= {"/assets/" + c for c in re.findall(r"import\(\"\./([\w\-\.]+\.js)\"\)", t)}

    full, rel = set(), set()
    for c in sorted(chunks):
        try:
            t = get_text(ORIGIN + c)
        except Exception as err:
            print("跳过", c, err)
            continue
        f, r = collect_assets(t)
        full |= f
        rel |= r
    print(f"扫描 {len(chunks)} 个 js/css；完整 URL {len(full)} 个，站内资源名 {len(rel)} 个")

    # 官网原图（www.yysls.cn）与站点自托管（/assets/...）分开存，避免同名混淆
    wall_official = os.path.join(out, "wallpaper-official")
    os.makedirs(wall_official, exist_ok=True)

    jobs = []
    for u in sorted(full):
        base = u.rsplit("/", 1)[-1].split("?")[0]
        dest = os.path.join(wall_official if "yysls.cn" in u else out, base)
        jobs.append((u, dest))
    for path in sorted(rel):
        sub = path[len("/assets/"):].replace("/", os.sep)
        jobs.append((ORIGIN + path, os.path.join(out, sub)))

    def work(job):
        url, dest = job
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        base, ext = os.path.splitext(dest)
        for e in (ext, ".png", ".jpg", ".webp", ".svg", ".gif"):
            if os.path.exists(base + e) and os.path.getsize(base + e) > 0:
                return None
        try:
            data = get(url, timeout=45)
        except Exception as err:
            return (url, str(err)[:50])
        if not data:
            return (url, "空响应")
        open(base + ext, "wb").write(data)
        return None

    errs = [r for r in ThreadPoolExecutor(8).map(work, jobs) if r]
    ok = len(jobs) - len(errs)
    print(f"下载成功 {ok} / {len(jobs)}；失败 {len(errs)}")
    for u, e in errs[:10]:
        print("  失败:", u, e)

    for d in (out, wall):
        n = sum(len(fs) for _, _, fs in os.walk(d))
        sz = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(d) for f in fs)
        print(f"{d}: {n} 个文件，{round(sz/1048576,1)} MB")
    empty = [os.path.join(dp, f) for dp, _, fs in os.walk(out) for f in fs
             if os.path.getsize(os.path.join(dp, f)) == 0]
    print("残留空文件:", len(empty))


if __name__ == "__main__":
    main()
