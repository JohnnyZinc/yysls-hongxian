# 期望伤害引擎（dmg-engine）

把四份 Excel 计算器（破竹风 3.1 / 破竹尘 3.1 / 牵丝玉 3.2 / 破竹樽 3.5）里的算法抽成一个
**与流派无关的引擎** + **四份流派包** + **一份输入快照**。

模型里没有单元格、行、列的概念；所有标识符（变量名、键名）统一用拼音。

```
dmg-engine/
├── engine/
│   ├── core.py        引擎：四态加权、五分支求和、结算施放、输出
│   └── cli.py         命令行入口
├── packages/          4 份流派包（武学奇术表 + 增益表 + 轴 + 配装 + 目标）
├── inputs/            4 份输入快照（默认值取自原表面板）
├── tools/
│   ├── extract.py     从原始 xlsx 生成 packages/ 与 inputs/（只读原表）
│   ├── verify.py      引擎重算的总伤/ADPS 与原表缓存值比对
│   ├── diff_actions.py 逐次施放比对（用于定位差异）
│   └── example_override.py  参数敏感性示例
├── reference-snapshot.json   抽取时留下的原表参考值（供校验）
└── README.md
```

## 快速开始

```sh
PY="C:/Users/johnn/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe"

# 1) 从原表重新生成数据（改原表后重跑）
"$PY" dmg-engine/tools/extract.py

# 2) 校验：引擎重算必须与原表一致
"$PY" dmg-engine/tools/verify.py

# 3) 算一次
"$PY" -m engine.cli --liupaibao packages/pozhu_zun_3.5.json --shuru inputs/pozhu_zun_3.5.json
```

`verify.py` 当前结果（相对误差容忍 1e-9）：

| 流派包 | 总伤（引擎） | 总伤（原表） | 相对误差 | ADPS | 毕业率 |
|---|---|---|---|---|---|
| pozhu_feng_3.1 | 16149223.71 | 16149223.71 | 1.85e-15 | 182477.10 | 1.000000 |
| pozhu_chen_3.1 | 16685750.18 | 16685750.18 | 1.00e-15 | 173629.03 | 1.000000 |
| qiansi_yu_3.2 | 17881355.87 | 17881355.87 | 0.00e+00 | 199346.22 | 1.000000 |
| pozhu_zun_3.5 | 16951729.73 | 16951729.73 | 2.20e-15 | 179573.41 | 1.000000 |

`diff_actions.py`：四个流派包共 **643 次施放逐一比对，0 个不一致**。

## 引擎模型

```
总伤 = Σ 每一次施放的伤害
adps = 总伤 / 战斗时间
毕业率 = adps / 毕业率基准
```

### 技能施放

```
L = 会心期望·会心占比 + 会意期望·会意占比 + 普通期望·普通占比 + 擦伤期望·擦伤占比

每个状态的底稿 = 外功分支 + 鸣金分支 + 裂石分支 + 牵丝分支 + 破竹分支
    分支 = (即时攻击 × 倍率 + 固伤) × (1 + 该分支穿透) × (1 + 该分支伤害加成)
    只有「武学属性」那一支使用属性倍率，并且只有它吃「属性固伤 × 1.5」

会心期望 = 底稿(小大取中值) × (1+通用增伤) × 会心伤害倍率 × 次数 × (1+定音加成) × (1+特殊增伤) × (1+特定增伤)
会意期望 = 底稿(取大攻)     × (1+通用增伤) × 会意伤害倍率 × 次数 × (1+定音加成) × (1+特殊增伤) × (1+特定增伤)
普通期望 = 底稿(小大取中值) × (1+通用增伤) ×              次数 × (1+定音加成) × (1+特殊增伤) × (1+特定增伤)
擦伤期望 = 底稿(取小攻)     × (1+通用增伤) ×              次数 × (1+定音加成) × (1+特殊增伤) × (1+特定增伤)
```

- 实际属性由面板推导：`最小/最大外功 = (面板 + 食物加成) × 套装乘区`，
  `属性最小/最大攻击 = (面板 + 生效属性的最小/最大无相攻击) × 套装乘区`
  （外功分支再减目标防御）。
- 穿透：`净额 = 输入穿透 − 目标对应抗性 + 技能 + 增益`；`净额 > 0` 记 `0.5%/点`，否则记 `1%/点`。
- 通用增伤 `= 首领增 + 通用增伤固定值 + 类型增伤 + 技能自带 + 增益`。
- 四态占比：`会心占比 = min((1−会意占比)·精准率, 精准率·会心率)`，
  `擦伤占比 = (1−精准率)·(1−会意占比)`（强制精准时为 0），`普通占比 = 1 − 其余三项`。
- 会心率上限 80%、会意率上限 40%；直接会心/会意率在封顶之后相加，且不再封顶；
  会心与会意互斥；强制会心会把生效精准拉满。

### 结算施放

```
L = Σ(范围内各次施放的 L) × 结算比例 × (1 + 结算增伤)
```

范围用**施放序号**表示（不是行区间）。范围可能包含比结算施放更晚的施放，因此引擎分两遍求值：
先算全部技能施放，再算结算施放。没有结算施放的流派包（牵丝玉）直接跳过这段。

## 流派包 schema

```jsonc
{
  "moshiBanben": 1,
  "bianhao": "pozhu_zun_3.5",
  "mingcheng": "破竹樽", "banben": "3.5",
  "laiyuan": "参考/破竹樽115阶竞速轴属性毕业率进阶计算器3.5.xlsx",
  "beizhu": ["抽取时的提示"],
  "peizhuang": {
    "wuxueShuxing": "破竹",                    // 武学属性（生效属性）
    "taozhuangChengqu": 1.05,                 // 套装乘区
    "shiwuJiacheng": { "zuixiao": 240, "zuida": 480 },   // 食物加成
    "waigongShanghaiJiachengJizhun": 0.0,     // 外功伤害加成基准
    "gushangJiacheng": 0.6,                   // 固伤加成
    "gushangJiachengLeixing": ["拳甲", "双刀"],  // 吃固伤加成的类型
    "zhijieHuixinlv": 0.133,                  // 直接会心率
    "zhijieHuiyilv": 0.0,                     // 直接会意率
    "huixinshangJiacheng": 0.54,              // 会心伤害加成
    "huiyishangJiacheng": 0.35,               // 会意伤害加成
    "dingyinFenlei": "酩酊技",                 // 生效定音槽的分类
    "tongyongZengshangGudingzhi": 0.095,      // 通用增伤固定值
    "leixingZengshang": [                      // 技能类型 → 引用哪些增伤输入项
      { "mingcheng": "拳甲", "yinyongXiang": ["quanwuZeng", "wuqiZeng1"] },
      { "mingcheng": "双刀", "yinyongXiang": ["quanwuZeng", "wuqiZeng2"] },
      { "mingcheng": "单体奇术", "yinyongXiang": ["qishuZeng1"] },
      { "mingcheng": "群体奇术", "yinyongXiang": ["qishuZeng2"] }
    ],
    "wuXiangGongji": { "zuixiao": 79.2, "zuida": 250.8, "zuoyongYu": "wuxueShuxing" }
  },
  "mubiao": { "fangyu": 618.3, "waikang": 8, "shukang": 30, "fubenTianfu": 0.06 },
  "zhou": {
    "zhandouShijian": 94.4,
    "biyelvJizhunAdps": 179573.41,
    "shifang": [
      { "xuhao": 0, "leixing": "jineng", "jineng": "长鲸吸川(拳甲+浅醉)", "cishu": 1,
        "zengyi": ["易水歌2层", "沧海帖2层", "离猎", "浅醉"] },
      { "xuhao": 28, "leixing": "jiesuan", "bili": 0.2, "fanwei": [7, 9, 10], "zengyi": ["步乱"] }
    ]
  },
  "wuxueQishu": {
    "长鲸吸川(拳甲+浅醉)": {
      "leixing": "拳甲",
      "waigongBeilv": 1.862784, "waigongGushang": 0,
      "shuxingBeilv": 2.794176, "shuxingGushang": 0,
      "tongyongZengshang": 0, "zuixiaoWaigong": 0, "zuidaWaigong": 0,
      "waigongJiacheng": 0, "waigongChuantou": 0, "waigongShanghaiJiacheng": 0,
      "shugongJiacheng": 0,
      "chuantou": { "mingjin": 0, "lieshi": 0, "qiansi": 0, "pozhu": 0 },
      "shuxingJiacheng": { "mingjin": 0, "lieshi": 0, "qiansi": 0, "pozhu": 0 },
      "huixinlv": 0, "huixinshang": 0, "huiyilv": 0, "huiyishang": 0,
      "xuli": 0,
      "qiangzhiJingzhun": false, "qiangzhiHuixin": false, "qiangzhiHuiyi": false,
      "dingyinFenlei": "酩酊技", "tedingZengshang": 0
    }
  },
  "zengyi": {
    "步乱": { "jiesuanZengshang": 0.2, "tongyongZengshang": 0,
              "chuantou": { "mingjin": 0, "lieshi": 0, "qiansi": 0, "pozhu": 0 }, "...": 0 }
  }
}
```

流派包里**没有**：单元格/行/列坐标、真气系数（已删除）、以及任何"开关"
（团队增益 √、心法选择已固化成数值或常量）。

`zengyi` 里两个容易混淆的字段：

- `tedingZengshang`（特定增伤）：作用于**所有**施放；
- `jiesuanZengshang`（结算增伤）：只作用于**结算施放**。

（原表只有一列：破竹风/尘/樽用作"结算增伤"，牵丝玉用作"特定增伤"；引擎按语义拆开。）

## 输入 schema

```jsonc
{
  "moshiBanben": 1,
  "liupaiBaoBianhao": "pozhu_zun_3.5",
  "jingzhunlv": 0.9943,        // 精准率
  "huixinlv": 0.7655,          // 会心率
  "huiyilv": 0.0913,           // 会意率
  "dingyinJiacheng": 0.32,     // 定音加成（分类在流派包里）
  "gongji": {
    "waigong":  { "zuixiao": 4473, "zuida": 3417.6, "chuantou": 58.7, "shanghaiJiacheng": null },
    "shuxing": {                // 非生效属性通常为 0，但模型允许同时有值、一起参与计算
      "mingjin": { "zuixiao": 0, "zuida": 0, "chuantou": 0, "shanghaiJiacheng": 0 },
      "lieshi":  { "zuixiao": 0, "zuida": 0, "chuantou": 0, "shanghaiJiacheng": 0 },
      "qiansi":  { "zuixiao": 0, "zuida": 0, "chuantou": 0, "shanghaiJiacheng": 0 },
      "pozhu":   { "zuixiao": 539, "zuida": 1475, "chuantou": 30, "shanghaiJiacheng": 0.15 }
    }
  },
  "zengshang": {                // 键名与流派包 leixingZengshang 的 yinyongXiang 对应
    "quanwuZeng": 0.0847,       // 全武增
    "shoulingZeng": 0.0892,     // 首领增
    "wuqiZeng1": 0.0854,        // 各武器增
    "wuqiZeng2": 0.0854,
    "qishuZeng1": 0.0,          // 奇术增
    "qishuZeng2": 0.0
  }
}
```

说明：

- `gongji.waigong.shanghaiJiacheng` 固定为 `null`：外功伤害加成基准属于流派包
  `peizhuang.waigongShanghaiJiachengJizhun`。
- 只写"该流派包真正引用的"增伤项。例如牵丝玉把两个奇术类型合并成一行，
  所以它的输入快照里没有 `qishuZeng2`（流派包的 `beizhu` 会说明）。
- 各属性都能同时给值：引擎对五个分支分别求和，`wuxueShuxing` 只决定
  "哪一支用属性倍率、哪一支吃属性固伤×1.5"，不会抑制其它分支。

## 输出

| 字段 | 含义 |
|---|---|
| `adps` | 总伤 / 战斗时间 |
| `biyelv` | 毕业率 = adps / 流派包 `zhou.biyelvJizhunAdps` |
| `zongshang` | 中间量，便于对照；不需要时可以忽略 |
| `shifang`（可选，`--mingxi`） | 每次施放的明细，仅用于排轴诊断 |

## 字段归属总表（当前实现）

| 归属 | 内容 |
|---|---|
| 引擎 | 四态占比与加权、五分支求和、穿透分档、实际属性推导、结算施放、`adps`/`biyelv` |
| 流派包 · 武学奇术表 | `leixing`、`waigongBeilv`/`waigongGushang`、`shuxingBeilv`/`shuxingGushang`、`dingyinFenlei`、`qiangzhiJingzhun`/`qiangzhiHuixin`/`qiangzhiHuiyi`、`tedingZengshang`、`xuli` |
| 流派包 · 增益表 | 各乘区字段；末列拆成 `tedingZengshang` 与 `jiesuanZengshang` |
| 流派包 · 轴 | `shifang`：`{jineng, cishu, zengyi}` 与 `{jiesuan, fanwei, bili, zengyi}` |
| 流派包 · 配装 | `wuxueShuxing`、`taozhuangChengqu`、`shiwuJiacheng`、`waigongShanghaiJiachengJizhun`、`gushangJiacheng` 及 `gushangJiachengLeixing`、`zhijieHuixinlv`、`zhijieHuiyilv`、`huixinshangJiacheng`、`huiyishangJiacheng`、`dingyinFenlei`、`tongyongZengshangGudingzhi`、`leixingZengshang`、`wuXiangGongji`、`zhandouShijian`、`biyelvJizhunAdps` |
| 流派包 · 目标 | `fangyu`、`waikang`、`shukang`、`fubenTianfu` |
| 输入 | `jingzhunlv`、`huixinlv`、`huiyilv`、`dingyinJiacheng`；`gongji.waigong` / `gongji.shuxing` 的最小、最大、穿透、伤害加成；`zengshang` 各项 |
| 输出 | `adps`、`biyelv` |

## 游戏机制（引擎如实实现，属于正常行为，不要改动）

1. 会心率上限 80%、会意率上限 40%。
2. 精准是触发会心的前置：只有精准命中才可能触发会心，所以**强制会心必然精准**；
   强制精准则不会擦伤。
3. 当最小外功 > 最大外功时，普通伤害与会心伤害不再在该区间内随机取值，而是固定取最小外功；
   对应到实际属性就是 `外功最大 = max(面板最小 + 食物最小, 面板最大 + 食物最大)`、
   `属性最大 = max(面板最小, 面板最大) + 最小/最大无相攻击`。
4. 四态取档：会心/普通取小大攻中值，会意取大攻，擦伤取小攻。
5. 只有武学属性那一支吃属性倍率与 `属性固伤 × 1.5`。
6. 穿透净额为正记 0.5%/点，为负记 1%/点。
7. 会心与会意互斥；直接会心/会意率在封顶之后相加。
8. 结算施放按比例对范围内已造成的伤害再结算一次，**这是真实伤害，必须计入总伤**。
9. `cishu = 0` 的施放贡献 0（例如牵丝玉里心法非易水歌时的易水歌跳伤）。
10. 轴里的 `N/a` 填充与 `cishu = 0` 的施放**按原样保留**，不要清理。

## 按规格做的整理（与游戏机制无关，都是原表的写法问题）

当前数据下数值完全一致，已由 `verify.py` + `diff_actions.py` 证明：

1. 增益表末列按语义一拆为二（`tedingZengshang` / `jiesuanZengshang`）。
2. 牵丝穿透"净额为正"分支：原表四份的公式在求和项里引用的是裂石穿透的增益列
   （判断条件用的仍是牵丝穿透）。引擎按属性各自取值。
3. 删除真气系数（原本只服务真气比例，而真气比例不是输出）。
4. 保留"蓄力"（`xuli`）字段：这四份没有用到，但其它流派可能会用。

## 扩展一个新流派

1. 在 `tools/extract.py` 的 `WENJIAN_LIE` 里加一行（编号、名称、版本、文件名）；
2. 前提是该表沿用同一套结构（面板/目标/会心会意/各类增伤/定音/固伤/食物 + 轴 + 武学奇术表 + 增益表）；
3. 跑 `extract.py` → `verify.py`。若某处口径不同，`diff_actions.py` 会直接指出是哪一次施放差多少。

## 作为库使用

```python
import json, sys
sys.path.insert(0, "dmg-engine")
from engine.core import jisuanZhou

liupaiBao = json.load(open("dmg-engine/packages/pozhu_zun_3.5.json", encoding="utf-8"))
shuru = json.load(open("dmg-engine/inputs/pozhu_zun_3.5.json", encoding="utf-8"))

jizhun = jisuanZhou(liupaiBao, shuru)
shuru["zengshang"]["wuqiZeng1"] += 0.01          # 假设某个武器增伤词条 +1%
zhihou = jisuanZhou(liupaiBao, shuru)
print(jizhun["adps"], zhihou["adps"], zhihou["biyelv"])
```
