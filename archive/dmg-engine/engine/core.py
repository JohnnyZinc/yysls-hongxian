"""期望伤害引擎：与流派无关的那部分计算（所有标识符用拼音）。

模型（与规格一致，不出现任何单元格/行/列概念）：

    总伤 = Σ 每一次施放的伤害
    技能施放: L = 会心期望·会心占比 + 会意期望·会意占比 + 普通期望·普通占比 + 擦伤期望·擦伤占比
              每个状态 = 外功分支 + 鸣金分支 + 裂石分支 + 牵丝分支 + 破竹分支
              分支 = (即时攻击 × 倍率 + 固伤) × (1 + 该分支穿透) × (1 + 该分支伤害加成)
              只有「武学属性」那一支使用属性倍率，并且只有它吃「属性固伤 × 1.5」
              然后 × (1+通用增伤) × 状态伤害倍率 × 次数 × (1+定音加成) × (1+特殊增伤) × (1+特定增伤)
    结算施放: L = Σ(范围内各次施放的 L) × 结算比例 × (1 + 结算增伤)

    输出: adps = 总伤 / 战斗时间 ; 毕业率 = adps / 毕业率基准
"""

from __future__ import annotations

from typing import Any

SHUXING_CIXU = ("mingjin", "lieshi", "qiansi", "pozhu")
SHUXING_MINGCHENG_DAO_JIAN = {"鸣金": "mingjin", "裂石": "lieshi", "牵丝": "qiansi", "破竹": "pozhu"}

HUIXINLV_SHANGXIAN = 0.80
HUIYILV_SHANGXIAN = 0.40
SHUXING_GUSHANG_BEISHU = 1.5
CHUANTOU_ZHENG_CHUSHU = 200.0
CHUANTOU_FU_CHUSHU = 100.0


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _zengyiQiuhe(zengyiTiaomu: list[dict], ziduanLujing: str) -> float:
    """按字段路径对一组增益求和；ziduanLujing 形如 'chuantou.qiansi'。"""
    zongji = 0.0
    tou, _, wei = ziduanLujing.partition(".")
    for tiaomu in zengyiTiaomu:
        zhi = tiaomu.get(tou)
        if zhi is None:
            continue
        if wei:
            zhi = zhi.get(wei, 0.0)
        zongji += float(zhi or 0.0)
    return zongji


def _chuantouJiacheng(jinge: float) -> float:
    """穿透净额 → 伤害乘区。净额为正按 0.5%/点，为负按 1%/点。"""
    if jinge > 0:
        return jinge / CHUANTOU_ZHENG_CHUSHU
    return jinge / CHUANTOU_FU_CHUSHU


def _quZhongzhi(xiao: float, da: float) -> float:
    return (xiao + da) / 2.0


# --------------------------------------------------------------------------- #
# 实际属性：面板攻击 + 食物加成 + 无相攻击，再乘套装乘区
# --------------------------------------------------------------------------- #
def jisuanShijiShuxing(liupaiBao: dict, shuru: dict) -> dict:
    peizhuang = liupaiBao["peizhuang"]
    taozhuangChengqu = float(peizhuang["taozhuangChengqu"])
    shiwu = peizhuang["shiwuJiacheng"]
    wuXiang = peizhuang["wuXiangGongji"]
    shengxiao = SHUXING_MINGCHENG_DAO_JIAN[peizhuang["wuxueShuxing"]]

    waigong = shuru["gongji"]["waigong"]
    jieguo: dict[str, Any] = {
        "waigong": {
            # 游戏机制：最小外功 > 最大外功时伤害不再区间随机，而是固定取最小外功，
            # 所以最小 = 面板最小 + 食物最小，最大 = max(面板最小 + 食物最小, 面板最大 + 食物最大)
            "zuixiao": (float(waigong["zuixiao"]) + float(shiwu["zuixiao"])) * taozhuangChengqu,
            "zuida": max(
                float(waigong["zuixiao"]) + float(shiwu["zuixiao"]),
                float(waigong["zuida"]) + float(shiwu["zuida"]),
            )
            * taozhuangChengqu,
        },
        "shuxing": {},
    }
    for jian in SHUXING_CIXU:
        yuan = shuru["gongji"]["shuxing"][jian]
        shifouShengxiao = jian == shengxiao
        wuXiangZuixiao = float(wuXiang["zuixiao"]) if shifouShengxiao else 0.0
        wuXiangZuida = float(wuXiang["zuida"]) if shifouShengxiao else 0.0
        jieguo["shuxing"][jian] = {
            # 同上：属性最大攻击取 max(面板最小, 面板最大)，再加生效属性的无相攻击
            "zuixiao": (float(yuan["zuixiao"]) + wuXiangZuixiao) * taozhuangChengqu,
            "zuida": (max(float(yuan["zuixiao"]), float(yuan["zuida"])) + wuXiangZuida)
            * taozhuangChengqu,
        }
    return jieguo


# --------------------------------------------------------------------------- #
# 单次技能施放
# --------------------------------------------------------------------------- #
def jisuanJinengQiwang(
    shifang: dict,
    liupaiBao: dict,
    shuru: dict,
    shijiShuxing: dict,
    wuxueQishu: dict,
    zengyiBiao: dict,
) -> dict:
    jinengMing = shifang["jineng"]
    if jinengMing not in wuxueQishu:
        raise KeyError(f"武学奇术表里没有这个技能: {jinengMing!r}")
    jineng = wuxueQishu[jinengMing]
    zengyiTiaomu = [zengyiBiao[m] for m in shifang["zengyi"] if m in zengyiBiao]
    peizhuang = liupaiBao["peizhuang"]
    mubiao = liupaiBao["mubiao"]
    shengxiao = SHUXING_MINGCHENG_DAO_JIAN[peizhuang["wuxueShuxing"]]
    cishu = float(shifang.get("cishu", 1) or 0.0)

    qiangzhiJingzhun = bool(jineng.get("qiangzhiJingzhun"))
    qiangzhiHuixin = bool(jineng.get("qiangzhiHuixin"))
    qiangzhiHuiyi = bool(jineng.get("qiangzhiHuiyi"))

    # ---- 通用增伤 ----
    leixingZengshang = 0.0
    for tiaomu in peizhuang["leixingZengshang"]:
        if tiaomu["mingcheng"] == jineng.get("leixing"):
            leixingZengshang = sum(float(shuru["zengshang"][m]) for m in tiaomu["yinyongXiang"])
            break
    tongyongZengshang = (
        float(shuru["zengshang"]["shoulingZeng"])
        + float(peizhuang["tongyongZengshangGudingzhi"])
        + leixingZengshang
        + float(jineng.get("tongyongZengshang") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "tongyongZengshang")
    )

    # ---- 固伤（只对特定类型吃固伤加成） ----
    gushangXishu = 1.0 + (
        float(peizhuang["gushangJiacheng"])
        if jineng.get("leixing") in peizhuang["gushangJiachengLeixing"]
        else 0.0
    )
    waigongGushang = float(jineng.get("waigongGushang") or 0.0) * gushangXishu
    shuxingGushang = float(jineng.get("shuxingGushang") or 0.0) * gushangXishu

    # ---- 外功分支 ----
    waigongJiacheng = float(jineng.get("waigongJiacheng") or 0.0) + _zengyiQiuhe(
        zengyiTiaomu, "waigongJiacheng"
    )
    jishiXiaoWai = (
        shijiShuxing["waigong"]["zuixiao"] * (1.0 + waigongJiacheng)
        + float(jineng.get("zuixiaoWaigong") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "zuixiaoWaigong")
        - float(mubiao["fangyu"])
    )
    jishiDaWai = (
        shijiShuxing["waigong"]["zuida"] * (1.0 + waigongJiacheng)
        + float(jineng.get("zuidaWaigong") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "zuidaWaigong")
        - float(mubiao["fangyu"])
    )
    waigongChuantou = _chuantouJiacheng(
        float(shuru["gongji"]["waigong"]["chuantou"])
        - float(mubiao["waikang"])
        + float(jineng.get("waigongChuantou") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "waigongChuantou")
    )
    waigongShanghaiJiacheng = (
        float(peizhuang["waigongShanghaiJiachengJizhun"])
        + float(jineng.get("waigongShanghaiJiacheng") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "waigongShanghaiJiacheng")
    )

    # ---- 四个属性分支 ----
    shugongJiacheng = float(jineng.get("shugongJiacheng") or 0.0) + _zengyiQiuhe(
        zengyiTiaomu, "shugongJiacheng"
    )
    shuxingFenzhi: dict[str, dict] = {}
    for jian in SHUXING_CIXU:
        yuan = shuru["gongji"]["shuxing"][jian]
        jishiXiao = shijiShuxing["shuxing"][jian]["zuixiao"] * (1.0 + shugongJiacheng)
        jishiDa = shijiShuxing["shuxing"][jian]["zuida"] * (1.0 + shugongJiacheng)
        chuantou = _chuantouJiacheng(
            float(yuan["chuantou"])
            - float(mubiao["shukang"])
            + float((jineng.get("chuantou") or {}).get(jian) or 0.0)
            + _zengyiQiuhe(zengyiTiaomu, f"chuantou.{jian}")
        )
        shanghaiJiacheng = (
            float(yuan["shanghaiJiacheng"] or 0.0)
            + float((jineng.get("shuxingJiacheng") or {}).get(jian) or 0.0)
            + _zengyiQiuhe(zengyiTiaomu, f"shuxingJiacheng.{jian}")
        )
        shifouShengxiao = jian == shengxiao
        beilv = float(jineng.get("shuxingBeilv") or 0.0) if shifouShengxiao else float(
            jineng.get("waigongBeilv") or 0.0
        )
        gushang = shuxingGushang * SHUXING_GUSHANG_BEISHU if shifouShengxiao else 0.0
        shuxingFenzhi[jian] = {
            "zuixiao": jishiXiao,
            "zuida": jishiDa,
            "beilv": beilv,
            "gushang": gushang,
            "chuantou": chuantou,
            "shanghaiJiacheng": shanghaiJiacheng,
        }

    waigongBeilv = float(jineng.get("waigongBeilv") or 0.0)

    def dizhi(quzhi: str) -> float:
        """按取档方式把五个分支相加：zhong=小大取中值，da=取大攻，xiao=取小攻。"""
        if quzhi == "zhong":
            gongji = _quZhongzhi(jishiXiaoWai, jishiDaWai)
        elif quzhi == "da":
            gongji = jishiDaWai
        elif quzhi == "xiao":
            gongji = jishiXiaoWai
        else:
            raise ValueError(quzhi)
        zongji = (gongji * waigongBeilv + waigongGushang) * (1.0 + waigongChuantou) * (
            1.0 + waigongShanghaiJiacheng
        )
        for jian in SHUXING_CIXU:
            shuju = shuxingFenzhi[jian]
            if quzhi == "zhong":
                jishi = _quZhongzhi(shuju["zuixiao"], shuju["zuida"])
            elif quzhi == "da":
                jishi = shuju["zuida"]
            else:
                jishi = shuju["zuixiao"]
            zongji += (jishi * shuju["beilv"] + shuju["gushang"]) * (
                1.0 + shuju["chuantou"]
            ) * (1.0 + shuju["shanghaiJiacheng"])
        return zongji

    # ---- 四态占比 ----
    jingzhunlv = float(shuru["jingzhunlv"])
    # 游戏机制：只有精准命中才可能触发会心，所以强制会心必然精准
    shengxiaoJingzhun = 1.0 if qiangzhiHuixin else jingzhunlv
    shengxiaoJingzhun = min(shengxiaoJingzhun, 1.0)

    huixinlv = min(
        HUIXINLV_SHANGXIAN,
        float(shuru["huixinlv"])
        + float(jineng.get("huixinlv") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "huixinlv"),
    )
    zhijieHuixin = (
        float(peizhuang["zhijieHuixinlv"]) + _zengyiQiuhe(zengyiTiaomu, "zhijieHuixinlv")
        if not qiangzhiHuixin
        else 0.0
    )
    huixinZhanbi = 0.0 if qiangzhiHuiyi else (1.0 if qiangzhiHuixin else huixinlv + zhijieHuixin)

    huiyilv = min(
        HUIYILV_SHANGXIAN,
        float(shuru["huiyilv"])
        + float(jineng.get("huiyilv") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "huiyilv"),
    )
    zhijieHuiyi = (
        float(peizhuang["zhijieHuiyilv"]) + _zengyiQiuhe(zengyiTiaomu, "zhijieHuiyilv")
        if not qiangzhiHuiyi
        else 0.0
    )
    huiyiZhanbi = 0.0 if qiangzhiHuixin else (1.0 if qiangzhiHuiyi else huiyilv + zhijieHuiyi)

    cashangZhanbi = (
        0.0 if qiangzhiJingzhun else (1.0 - shengxiaoJingzhun) * (1.0 - huiyiZhanbi)
    )
    huixinQuanzhong = min(
        (1.0 - huiyiZhanbi) * shengxiaoJingzhun,
        shengxiaoJingzhun * huixinZhanbi,
    )
    putongQuanzhong = 1.0 - huiyiZhanbi - huixinQuanzhong - cashangZhanbi

    huixinshangBeishu = (
        1.0
        + float(peizhuang["huixinshangJiacheng"])
        + float(jineng.get("huixinshang") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "huixinshang")
    )
    huiyishangBeishu = (
        1.0
        + float(peizhuang["huiyishangJiacheng"])
        + float(jineng.get("huiyishang") or 0.0)
        + _zengyiQiuhe(zengyiTiaomu, "huiyishang")
    )

    # ---- 全局乘区 ----
    dingyinBeishu = 1.0 + (
        float(shuru["dingyinJiacheng"])
        if jineng.get("dingyinFenlei") == peizhuang["dingyinFenlei"]
        else 0.0
    )
    teshuZengshang = _zengyiQiuhe(zengyiTiaomu, "teshuZengshang") + float(mubiao["fubenTianfu"])
    tedingZengshang = float(jineng.get("tedingZengshang") or 0.0) + _zengyiQiuhe(
        zengyiTiaomu, "tedingZengshang"
    )

    weibu = (
        (1.0 + tongyongZengshang)
        * cishu
        * dingyinBeishu
        * (1.0 + teshuZengshang)
        * (1.0 + tedingZengshang)
    )

    zhongzhiDizhi = dizhi("zhong")
    huixinQiwang = zhongzhiDizhi * weibu * huixinshangBeishu
    huiyiQiwang = dizhi("da") * weibu * huiyishangBeishu
    putongQiwang = zhongzhiDizhi * weibu
    cashangQiwang = dizhi("xiao") * weibu

    shanghai = (
        huixinQiwang * huixinQuanzhong
        + huiyiQiwang * huiyiZhanbi
        + putongQiwang * putongQuanzhong
        + cashangQiwang * cashangZhanbi
    )

    return {
        "xuhao": shifang["xuhao"],
        "leixing": "jineng",
        "jineng": jinengMing,
        "shanghai": shanghai,
        "huixinQiwang": huixinQiwang,
        "huiyiQiwang": huiyiQiwang,
        "putongQiwang": putongQiwang,
        "cashangQiwang": cashangQiwang,
        "zhanbi": {
            "huixin": huixinQuanzhong,
            "huiyi": huiyiZhanbi,
            "putong": putongQuanzhong,
            "cashang": cashangZhanbi,
        },
    }


# --------------------------------------------------------------------------- #
# 顶层
# --------------------------------------------------------------------------- #
def jisuanZhou(liupaiBao: dict, shuru: dict, baoliuMingxi: bool = False) -> dict:
    shijiShuxing = jisuanShijiShuxing(liupaiBao, shuru)
    wuxueQishu = liupaiBao["wuxueQishu"]
    zengyiBiao = liupaiBao["zengyi"]
    zhou = liupaiBao["zhou"]
    shifangLie = zhou["shifang"]

    jieguo: list[dict] = [None] * len(shifangLie)  # type: ignore[list-item]

    # 第一遍：技能施放
    for shifang in shifangLie:
        if shifang.get("leixing", "jineng") == "jineng":
            jieguo[shifang["xuhao"]] = jisuanJinengQiwang(
                shifang, liupaiBao, shuru, shijiShuxing, wuxueQishu, zengyiBiao
            )

    # 第二遍：结算施放（范围可能引用比自身更晚的施放，所以必须分开两遍）
    for shifang in shifangLie:
        if shifang.get("leixing") != "jiesuan":
            continue
        zengyiTiaomu = [zengyiBiao[m] for m in shifang["zengyi"] if m in zengyiBiao]
        fanweiHe = sum(float(jieguo[i]["shanghai"]) for i in shifang["fanwei"])
        jiesuanZengshang = _zengyiQiuhe(zengyiTiaomu, "jiesuanZengshang")
        shanghai = fanweiHe * float(shifang["bili"]) * (1.0 + jiesuanZengshang)
        jieguo[shifang["xuhao"]] = {
            "xuhao": shifang["xuhao"],
            "leixing": "jiesuan",
            "shanghai": shanghai,
            "fanweiHe": fanweiHe,
            "bili": float(shifang["bili"]),
            "jiesuanZengshang": jiesuanZengshang,
        }

    zongshang = sum(float(r["shanghai"]) for r in jieguo)
    zhandouShijian = float(zhou["zhandouShijian"])
    adps = zongshang / zhandouShijian if zhandouShijian else 0.0
    jizhun = float(zhou["biyelvJizhunAdps"])
    shuchu = {
        "liupaiBaoBianhao": liupaiBao["bianhao"],
        "adps": adps,
        "biyelv": adps / jizhun if jizhun else 0.0,
        "zongshang": zongshang,
    }
    if baoliuMingxi:
        shuchu["shifang"] = jieguo
    return shuchu


def duquLiupaiBao(lujing) -> dict:
    import json
    from pathlib import Path

    return json.loads(Path(lujing).read_text(encoding="utf-8"))


def jisuanWenjian(liupaiBaoLujing, shuruLujing, baoliuMingxi: bool = False) -> dict:
    return jisuanZhou(duquLiupaiBao(liupaiBaoLujing), duquLiupaiBao(shuruLujing), baoliuMingxi)
