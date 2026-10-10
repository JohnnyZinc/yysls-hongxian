#!/usr/bin/env python3
"""从原始 xlsx 抽取「流派包」与「输入快照」为 JSON（标识符用拼音）。

设计约束：
  * 只读原表，不修改原表；
  * 输出里不出现任何单元格/行/列坐标，全部翻译成实体与字段；
  * 开关、心法、套装、目标、基准值、战斗时间 → 流派包；
  * 面板数值（精准率/会心率/会意率/各类增伤/定音加成/攻击与穿透）→ 输入快照；
  * 引擎负责的中间量（即时攻击、各乘区、四态占比、各期望值）一律不抽取，由引擎重算。

用法：python tools/extract.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import openpyxl

XIANGMU = Path(__file__).resolve().parents[1]
GONGZUOQU = XIANGMU.parent
LIUPAIBAO_MULU = XIANGMU / "packages"
SHURU_MULU = XIANGMU / "inputs"

SHUXING_JIAN = ("mingjin", "lieshi", "qiansi", "pozhu")
SHUXING_MINGCHENG_DAO_JIAN = {"鸣金": "mingjin", "裂石": "lieshi", "牵丝": "qiansi", "破竹": "pozhu"}

# 武学奇术表的列位（坐标只存在于本脚本内，不进入 JSON）
WUXUE_LIE = {
    2: "tongyongZengshang",
    3: "zuixiaoWaigong",
    4: "zuidaWaigong",
    5: "waigongJiacheng",
    6: "waigongChuantou",
    7: "waigongShanghaiJiacheng",
    8: "shugongJiacheng",
    9: ("chuantou", "mingjin"),
    10: ("shuxingJiacheng", "mingjin"),
    11: ("chuantou", "lieshi"),
    12: ("shuxingJiacheng", "lieshi"),
    13: ("chuantou", "qiansi"),
    14: ("shuxingJiacheng", "qiansi"),
    15: ("chuantou", "pozhu"),
    16: ("shuxingJiacheng", "pozhu"),
    17: "huixinlv",
    18: "huixinshang",
    19: "huiyilv",
    20: "huiyishang",
    21: "xuli",
    22: "qiangzhiJingzhun",
    23: "qiangzhiHuixin",
    24: "qiangzhiHuiyi",
    25: "leixing",
    26: "waigongBeilv",
    27: "waigongGushang",
    28: "shuxingBeilv",
    29: "shuxingGushang",
    30: "dingyinFenlei",
    32: "tedingZengshang",
    # 第 31 列（原表未命名，用于真气比例）按决定删除
}

ZENGYI_LIE = {
    2: "tongyongZengshang",
    3: "zuixiaoWaigong",
    4: "zuidaWaigong",
    5: "waigongJiacheng",
    6: "waigongChuantou",
    7: "waigongShanghaiJiacheng",
    8: "shugongJiacheng",
    9: ("chuantou", "mingjin"),
    10: ("shuxingJiacheng", "mingjin"),
    11: ("chuantou", "lieshi"),
    12: ("shuxingJiacheng", "lieshi"),
    13: ("chuantou", "qiansi"),
    14: ("shuxingJiacheng", "qiansi"),
    15: ("chuantou", "pozhu"),
    16: ("shuxingJiacheng", "pozhu"),
    17: "huixinlv",
    18: "huixinshang",
    19: "huiyilv",
    20: "huiyishang",
    21: "zhijieHuixinlv",
    22: "zhijieHuiyilv",
    23: "teshuZengshang",
    24: None,  # 最后一列：按表头决定是 tedingZengshang 还是 jiesuanZengshang
}

WENJIAN_LIE = [
    ("pozhu_feng_3.1", "破竹风", "3.1", "破竹风115阶竞速轴属性毕业率进阶计算器3.1.xlsx"),
    ("pozhu_chen_3.1", "破竹尘", "3.1", "破竹尘115阶竞速轴属性毕业率进阶计算器3.1.xlsx"),
    ("qiansi_yu_3.2", "牵丝玉", "3.2", "牵丝玉115阶竞速轴属性毕业率进阶计算器3.2.xlsx"),
    ("pozhu_zun_3.5", "破竹樽", "3.5", "破竹樽115阶竞速轴属性毕业率进阶计算器3.5.xlsx"),
]


def quzhi(gongzuobiao, hang: int, lie: int):
    return gongzuobiao.cell(row=hang, column=lie).value


def shuzhi(zhi) -> float:
    return float(zhi) if isinstance(zhi, (int, float)) else 0.0


def xieru(zidian: dict, jian, zhi) -> None:
    if isinstance(jian, tuple):
        zidian.setdefault(jian[0], {})[jian[1]] = zhi
    else:
        zidian[jian] = zhi


def zhaobiaoqian(gongzuobiao, biaoqian: str, lie: int, cong: int, dao: int):
    for hang in range(cong, dao + 1):
        dan = quzhi(gongzuobiao, hang, lie)
        if isinstance(dan, str) and dan.strip() == biaoqian:
            return hang
    return None


def chouqu(bianhao: str, mingcheng: str, banben: str, wenjianming: str) -> tuple[dict, dict, dict]:
    lujing = GONGZUOQU / "参考" / wenjianming
    gzb = openpyxl.load_workbook(lujing, data_only=True)
    gzb_gongshi = openpyxl.load_workbook(lujing, data_only=False)
    qiwang = gzb["期望"]
    qiwang_gongshi_biao = gzb_gongshi["期望"]
    wuxue_biao = gzb["武学奇术"]
    zengyi_biao = gzb["增益"]
    beizhu: list[str] = []

    # ---------------- 面板 / 流派固定参数 ----------------
    wuxue_shuxing = quzhi(qiwang, 1, 7)
    if wuxue_shuxing not in SHUXING_MINGCHENG_DAO_JIAN:
        raise ValueError(f"{bianhao}: 武学属性无法识别: {wuxue_shuxing!r}")

    waigong_zuixiao = shuzhi(quzhi(qiwang, 2, 2))
    waigong_zuida = shuzhi(quzhi(qiwang, 2, 3))
    waigong_chuantou = shuzhi(quzhi(qiwang, 2, 4))

    wuXiang_zuixiao = shuzhi(quzhi(qiwang, 7, 2))
    wuXiang_zuida = shuzhi(quzhi(qiwang, 7, 3))

    shuxing_biao: dict[str, dict] = {}
    for hang in range(3, 7):
        biaoqian = quzhi(qiwang, hang, 1)
        if biaoqian not in SHUXING_MINGCHENG_DAO_JIAN:
            raise ValueError(f"{bianhao}: 属性行标签无法识别: {biaoqian!r}")
        shuxing_biao[SHUXING_MINGCHENG_DAO_JIAN[biaoqian]] = {
            "zuixiao": shuzhi(quzhi(qiwang, hang, 2)),
            "zuida": shuzhi(quzhi(qiwang, hang, 3)),
            "chuantou": shuzhi(quzhi(qiwang, hang, 4)),
            "shanghaiJiacheng": shuzhi(quzhi(qiwang, hang, 5)),
        }
    for hang in range(11, 15):
        biaoqian = quzhi(qiwang, hang, 3)
        jian = SHUXING_MINGCHENG_DAO_JIAN.get(biaoqian)
        if jian and shuxing_biao[jian]["zuixiao"] != shuzhi(quzhi(qiwang, hang - 8, 2)):
            beizhu.append(f"{biaoqian} 的攻击面板行序与属性表行序不一致，已按属性表行序取值")

    jingzhunlv = shuzhi(quzhi(qiwang, 8, 2))
    huixinlv = shuzhi(quzhi(qiwang, 9, 2))
    huiyilv = shuzhi(quzhi(qiwang, 10, 2))
    zhijie_huixin = shuzhi(quzhi(qiwang, 11, 2))
    zhijie_huiyi = shuzhi(quzhi(qiwang, 12, 2))
    huixinshang_jiacheng = shuzhi(quzhi(qiwang, 13, 2))
    huiyishang_jiacheng = shuzhi(quzhi(qiwang, 14, 2))

    dingyin_hang = [
        hang
        for hang in range(8, 27)
        if isinstance(quzhi(qiwang, hang, 1), str)
        and quzhi(qiwang, hang, 1).strip().endswith("定音")
    ]
    dingyin_shengxiao = None
    dingyin_diuqi = []
    for hang in dingyin_hang:
        biaoqian = str(quzhi(qiwang, hang, 1)).strip()
        fenlei = biaoqian[: -len("定音")]
        jiacheng = shuzhi(quzhi(qiwang, hang, 2))
        if dingyin_shengxiao is None and jiacheng:
            dingyin_shengxiao = {"fenlei": fenlei, "jiacheng": jiacheng, "biaoqian": biaoqian}
        else:
            dingyin_diuqi.append({"fenlei": fenlei, "jiacheng": jiacheng, "biaoqian": biaoqian})
    if dingyin_shengxiao is None:
        raise ValueError(f"{bianhao}: 未找到生效的定音槽")
    if any(t["jiacheng"] for t in dingyin_diuqi):
        beizhu.append("存在多个非零定音槽，当前模型只支持一个，已保留第一个")
    for t in dingyin_diuqi:
        beizhu.append(f"空置/未使用的定音槽已丢弃: {t['biaoqian']}={t['jiacheng']}")

    gushang_hang = zhaobiaoqian(qiwang, "固伤加成", 1, 8, 27)
    gushang_jiacheng = shuzhi(quzhi(qiwang, gushang_hang, 2)) if gushang_hang else 0.0

    shiwu_hang = zhaobiaoqian(qiwang, "食物加成", 1, 8, 27)
    shiwu_zuixiao = shuzhi(quzhi(qiwang, shiwu_hang, 2)) if shiwu_hang else 0.0
    shiwu_zuida = shuzhi(quzhi(qiwang, shiwu_hang + 1, 2)) if shiwu_hang else 0.0

    waigong_shanghai_jiacheng_jizhun = shuzhi(quzhi(qiwang, 10, 7))

    # 类型 → 增伤来源：不假设固定行号，直接读公式
    # （各流派面板行数不同，例如牵丝玉把两个奇术增合并成一行，两个奇术类型引用同一个输入）
    danwei_dao_ziduan = {
        15: "quanwuZeng",
        16: "shoulingZeng",
        17: "wuqiZeng1",
        18: "wuqiZeng2",
        19: "qishuZeng1",
        20: "qishuZeng2",
    }
    leixing_zengshang = []
    gushang_leixing = []
    yinyong_danwei: set[int] = set()
    for xu, hang in enumerate((4, 5, 6, 7)):
        leixing_ming = quzhi(qiwang, hang, 6)
        if not (isinstance(leixing_ming, str) and leixing_ming):
            beizhu.append(f"类型名缺失（第 {xu + 1} 个类型行），已跳过")
            continue
        gongshi = qiwang_gongshi_biao.cell(row=hang, column=7).value
        if not (isinstance(gongshi, str) and gongshi.startswith("=")):
            raise ValueError(f"{bianhao}: 类型 {leixing_ming!r} 的增伤不是公式: {gongshi!r}")
        yinyong: list[str] = []
        for danwei in re.findall(r"\$?B\$?(\d+)", gongshi):
            hang_hao = int(danwei)
            if hang_hao not in danwei_dao_ziduan:
                raise ValueError(f"{bianhao}: 类型 {leixing_ming!r} 的增伤引用了未知输入项 B{danwei}")
            yinyong_danwei.add(hang_hao)
            ziduan = danwei_dao_ziduan[hang_hao]
            if ziduan not in yinyong:
                yinyong.append(ziduan)
        leixing_zengshang.append({"mingcheng": leixing_ming, "yinyongXiang": yinyong})
        if xu < 2:
            gushang_leixing.append(leixing_ming)

    # 通用增伤的基准项引用了「首领增」，它总是被引用
    jizhun_gongshi = qiwang_gongshi_biao.cell(row=3, column=7).value
    for danwei in re.findall(r"\$?B\$?(\d+)", jizhun_gongshi or ""):
        if int(danwei) in danwei_dao_ziduan:
            yinyong_danwei.add(int(danwei))
    if 16 not in yinyong_danwei:
        beizhu.append("未能从通用增伤公式里确认「首领增」输入项，已按默认行处理")
        yinyong_danwei.add(16)

    # 只把真正被引用的增伤项写进输入快照（避免出现指向别处的死字段）
    zengshang_shuru = {
        danwei_dao_ziduan[danwei]: shuzhi(quzhi(qiwang, danwei, 2))
        for danwei in sorted(yinyong_danwei)
    }
    for danwei, ziduan in danwei_dao_ziduan.items():
        if ziduan not in zengshang_shuru:
            beizhu.append(f"输入项 {ziduan} 未被该流派引用，未写入输入快照")
    shouling_zeng = zengshang_shuru["shoulingZeng"]

    tongyong_zengshang_dan = shuzhi(quzhi(qiwang, 3, 7))
    tongyong_zengshang_gudingzhi = tongyong_zengshang_dan - shouling_zeng

    gongji_jichu_zuixiao = waigong_zuixiao + shiwu_zuixiao
    taozhuang_chengqu = (
        shuzhi(quzhi(qiwang, 10, 4)) / gongji_jichu_zuixiao if gongji_jichu_zuixiao else 1.0
    )
    taozhuang_chengqu = round(taozhuang_chengqu, 6)

    mubiao = {
        "fangyu": shuzhi(quzhi(qiwang, 2, 9)),
        "waikang": shuzhi(quzhi(qiwang, 3, 9)),
        "shukang": shuzhi(quzhi(qiwang, 4, 9)),
        "fubenTianfu": shuzhi(quzhi(qiwang, 5, 9)),
    }
    zhandou_shijian = shuzhi(quzhi(qiwang, 8, 9))
    zongshang_cankao = shuzhi(quzhi(qiwang, 10, 9))
    adps_cankao = shuzhi(quzhi(qiwang, 12, 9))
    biyelv_cankao = shuzhi(quzhi(qiwang, 16, 9))
    if biyelv_cankao == 0 or adps_cankao == 0:
        raise ValueError(f"{bianhao}: 缺少总伤/ADPS/毕业率参考值")
    biyelv_jizhun_adps = adps_cankao / biyelv_cankao

    # ---------------- 时间轴 ----------------
    shifang_lie = []
    jiesuan_geshi = []
    hang_dao_xuhao: dict[int, int] = {}
    for hang in range(2, qiwang.max_row + 1):
        qiwang_zhi = quzhi(qiwang, hang, 12)
        qiwang_gongshi = qiwang_gongshi_biao.cell(row=hang, column=12).value
        if qiwang_zhi is None and qiwang_gongshi is None:
            continue
        if not (
            isinstance(qiwang_zhi, (int, float))
            or (isinstance(qiwang_gongshi, str) and qiwang_gongshi.startswith("="))
        ):
            continue  # 表头文字
        xuhao = len(shifang_lie)
        hang_dao_xuhao[hang] = xuhao
        jineng = quzhi(qiwang, hang, 18)
        cishu = quzhi(qiwang, hang, 17)
        zengyi = [
            quzhi(qiwang, hang, lie)
            for lie in range(19, 39)
            if isinstance(quzhi(qiwang, hang, lie), str)
            and quzhi(qiwang, hang, lie).strip() not in ("", "N/a")
        ]
        if isinstance(qiwang_gongshi, str) and "SUM(L" in qiwang_gongshi:
            shifang_lie.append(
                {
                    "xuhao": xuhao,
                    "leixing": "jiesuan",
                    "cishu": 1,
                    "zengyi": zengyi,
                    "bili": None,
                    "fanwei": None,
                }
            )
            jiesuan_geshi.append((xuhao, qiwang_gongshi))
        else:
            if not isinstance(qiwang_gongshi, str):
                raise ValueError(f"{bianhao}: 第 {xuhao} 次施放既不是公式也不是结算式，无法翻译")
            shifang_lie.append(
                {
                    "xuhao": xuhao,
                    "leixing": "jineng",
                    "jineng": jineng,
                    "cishu": shuzhi(cishu) if isinstance(cishu, (int, float)) else 0,
                    "zengyi": zengyi,
                }
            )

    for xuhao, gongshi in jiesuan_geshi:
        bili_pipei = re.search(r"\*\s*(\d+(?:\.\d+)?)\s*(%?)\s*\*", gongshi)
        if not bili_pipei:
            raise ValueError(f"{bianhao}: 结算施放 {xuhao} 未能解析比例: {gongshi}")
        bili = float(bili_pipei.group(1)) / (100.0 if bili_pipei.group(2) == "%" else 1.0)
        fanwei_hang: list[int] = []
        shengyu = gongshi
        for tou, wei in re.findall(r"L(\d+)\s*:\s*L(\d+)", gongshi):
            fanwei_hang.extend(range(int(tou), int(wei) + 1))
            shengyu = shengyu.replace(f"L{tou}:L{wei}", " ")
        for dan in re.findall(r"(?<![A-Za-z0-9])L(\d+)", shengyu):
            fanwei_hang.append(int(dan))
        fanwei = sorted({hang_dao_xuhao[h] for h in fanwei_hang if h in hang_dao_xuhao})
        queshi = [h for h in fanwei_hang if h not in hang_dao_xuhao]
        if queshi:
            raise ValueError(f"{bianhao}: 结算施放 {xuhao} 引用了不存在的施放 {queshi}")
        tiaomu = shifang_lie[xuhao]
        tiaomu["bili"] = bili
        tiaomu["fanwei"] = fanwei

    # ---------------- 武学奇术表 ----------------
    yongdao_jineng = sorted({s["jineng"] for s in shifang_lie if s["leixing"] == "jineng"})
    wuxue_qishu: dict[str, dict] = {}
    for hang in range(2, wuxue_biao.max_row + 1):
        jineng_ming = quzhi(wuxue_biao, hang, 1)
        if not isinstance(jineng_ming, str) or jineng_ming not in yongdao_jineng:
            continue
        tiaomu: dict = {}
        for lie, duiying in WUXUE_LIE.items():
            yuan = quzhi(wuxue_biao, hang, lie)
            if duiying in ("qiangzhiJingzhun", "qiangzhiHuixin", "qiangzhiHuiyi"):
                xieru(tiaomu, duiying, yuan == 1)
            elif duiying in ("leixing", "dingyinFenlei"):
                xieru(tiaomu, duiying, yuan if isinstance(yuan, str) else None)
            else:
                xieru(tiaomu, duiying, shuzhi(yuan))
        wuxue_qishu[jineng_ming] = tiaomu
    queshi_jineng = [j for j in yongdao_jineng if j not in wuxue_qishu]
    if queshi_jineng:
        raise ValueError(f"{bianhao}: 武学奇术表里缺少这些技能: {queshi_jineng}")

    # ---------------- 增益表 ----------------
    zuihou_biaotou = quzhi(zengyi_biao, 1, 24)
    if not isinstance(zuihou_biaotou, str):
        raise ValueError(f"{bianhao}: 增益表最后一列没有表头")
    if "结算增伤" in zuihou_biaotou:
        zuihou_ziduan = "jiesuanZengshang"
    elif "特定增伤" in zuihou_biaotou:
        zuihou_ziduan = "tedingZengshang"
    else:
        raise ValueError(f"{bianhao}: 未知的增益表最后一列: {zuihou_biaotou!r}")
    beizhu.append(f"增益表最后一列“{zuihou_biaotou}”映射为 {zuihou_ziduan}")

    yongdao_zengyi = sorted({z for s in shifang_lie for z in s["zengyi"]})
    zengyi_ku: dict[str, dict] = {}
    for hang in range(2, zengyi_biao.max_row + 1):
        zengyi_ming = quzhi(zengyi_biao, hang, 1)
        if not isinstance(zengyi_ming, str) or zengyi_ming not in yongdao_zengyi:
            continue
        tiaomu = {}
        for lie, duiying in ZENGYI_LIE.items():
            yuan = quzhi(zengyi_biao, hang, lie)
            if lie == 24:
                tiaomu[zuihou_ziduan] = shuzhi(yuan)
            else:
                xieru(tiaomu, duiying, shuzhi(yuan))
        zengyi_ku[zengyi_ming] = tiaomu
    queshi_zengyi = [z for z in yongdao_zengyi if z not in zengyi_ku]
    if queshi_zengyi:
        raise ValueError(f"{bianhao}: 增益表里缺少这些增益: {queshi_zengyi}")

    # ---------------- 组装 ----------------
    liupaibao = {
        "moshiBanben": 1,
        "bianhao": bianhao,
        "mingcheng": mingcheng,
        "banben": banben,
        "laiyuan": f"参考/{wenjianming}",
        "beizhu": beizhu,
        "peizhuang": {
            "wuxueShuxing": wuxue_shuxing,
            "taozhuangChengqu": taozhuang_chengqu,
            "shiwuJiacheng": {"zuixiao": shiwu_zuixiao, "zuida": shiwu_zuida},
            "waigongShanghaiJiachengJizhun": waigong_shanghai_jiacheng_jizhun,
            "gushangJiacheng": gushang_jiacheng,
            "gushangJiachengLeixing": gushang_leixing,
            "zhijieHuixinlv": zhijie_huixin,
            "zhijieHuiyilv": zhijie_huiyi,
            "huixinshangJiacheng": huixinshang_jiacheng,
            "huiyishangJiacheng": huiyishang_jiacheng,
            "dingyinFenlei": dingyin_shengxiao["fenlei"],
            "tongyongZengshangGudingzhi": tongyong_zengshang_gudingzhi,
            "leixingZengshang": leixing_zengshang,
            "wuXiangGongji": {
                "zuixiao": wuXiang_zuixiao,
                "zuida": wuXiang_zuida,
                "zuoyongYu": "wuxueShuxing",
            },
        },
        "mubiao": mubiao,
        "zhou": {
            "zhandouShijian": zhandou_shijian,
            "biyelvJizhunAdps": biyelv_jizhun_adps,
            "shifang": shifang_lie,
        },
        "wuxueQishu": wuxue_qishu,
        "zengyi": zengyi_ku,
    }

    shuru = {
        "moshiBanben": 1,
        "liupaiBaoBianhao": bianhao,
        "jingzhunlv": jingzhunlv,
        "huixinlv": huixinlv,
        "huiyilv": huiyilv,
        "dingyinJiacheng": dingyin_shengxiao["jiacheng"],
        "gongji": {
            "waigong": {
                "zuixiao": waigong_zuixiao,
                "zuida": waigong_zuida,
                "chuantou": waigong_chuantou,
                "shanghaiJiacheng": None,  # 外功伤害加成基准属于流派包
            },
            "shuxing": {jian: shuxing_biao[jian] for jian in SHUXING_JIAN},
        },
        # 各类增伤，键名与流派包 leixingZengshang 的 yinyongXiang 对应
        "zengshang": zengshang_shuru,
    }

    cankao = {
        "liupaiBaoBianhao": bianhao,
        "zongshang": zongshang_cankao,
        "adps": adps_cankao,
        "biyelv": biyelv_cankao,
        "biyelvJizhunAdps": biyelv_jizhun_adps,
        "shifangShumu": len(shifang_lie),
        "jiesuanShumu": len(jiesuan_geshi),
    }
    return liupaibao, shuru, cankao


def zhucheng() -> None:
    LIUPAIBAO_MULU.mkdir(exist_ok=True)
    SHURU_MULU.mkdir(exist_ok=True)
    cankao_ji = {}
    for bianhao, mingcheng, banben, wenjianming in WENJIAN_LIE:
        liupaibao, shuru, cankao = chouqu(bianhao, mingcheng, banben, wenjianming)
        (LIUPAIBAO_MULU / f"{bianhao}.json").write_text(
            json.dumps(liupaibao, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (SHURU_MULU / f"{bianhao}.json").write_text(
            json.dumps(shuru, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        cankao_ji[bianhao] = cankao
        print(
            f"{bianhao:16s} 施放 {cankao['shifangShumu']:3d} 次（结算 {cankao['jiesuanShumu']}）"
            f" 技能 {len(liupaibao['wuxueQishu']):2d} 增益 {len(liupaibao['zengyi']):2d}"
            f" 总伤 {cankao['zongshang']:.2f}"
        )
        for tiao in liupaibao["beizhu"]:
            print(f"    备注: {tiao}")
    (XIANGMU / "reference-snapshot.json").write_text(
        json.dumps(cankao_ji, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    zhucheng()
