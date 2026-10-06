# 期望伤害引擎（dmg-engine）

把四份 Excel 计算器（破竹风 3.1 / 破竹尘 3.1 / 牵丝玉 3.2 / 破竹樽 3.5）里的算法抽成一个
**与流派无关的引擎** + **四份流派数据包** + **一份玩家输入快照**。

模型里没有单元格、行、列的概念：只有动作（action）、技能（skill）、增益（buff）、
流派参数（build）、目标（target）、输入（input）、输出（output）。

```
dmg-engine/
├── engine/
│   ├── core.py        引擎：四态加权、五分支求和、派生结算动作、输出
│   └── cli.py         命令行入口
├── packages/          4 份流派包（技能表 + 增益表 + 时间轴 + 固定参数 + 场景）
├── inputs/            4 份玩家输入快照（默认值取自原表的面板）
├── tools/
│   ├── extract.py     从原始 xlsx 生成 packages/ 与 inputs/（只读原表）
│   ├── verify.py      引擎重算的 总伤/ADPS 与原表缓存值比对
│   └── diff_actions.py 逐动作比对（用于定位差异）
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
"$PY" -m engine.cli --package packages/pozhu_zun_3.5.json --input inputs/pozhu_zun_3.5.json
```

`verify.py` 当前结果（相对误差容忍 1e-9）：

| 流派 | 总伤（引擎） | 总伤（原表） | 相对误差 | ADPS | 毕业率 |
|---|---|---|---|---|---|
| pozhu_feng_3.1 | 16149223.71 | 16149223.71 | 1.85e-15 | 182477.10 | 1.000000 |
| pozhu_chen_3.1 | 16685750.18 | 16685750.18 | 1.00e-15 | 173629.03 | 1.000000 |
| qiansi_yu_3.2 | 17881355.87 | 17881355.87 | 0.00e+00 | 199346.22 | 1.000000 |
| pozhu_zun_3.5 | 16951729.73 | 16951729.73 | 2.20e-15 | 179573.41 | 1.000000 |

`diff_actions.py`：四个流派共 **643 个动作逐一比对，0 个不一致**。

## 引擎模型

```
总伤 = Σ 每个动作的伤害
adps = 总伤 / 战斗时间
graduationRate = adps / 基准ADPS
```

### 标准动作

```
L = 会心期望·会心占比 + 会意期望·会意占比 + 普通期望·普通占比 + 擦伤期望·擦伤占比

每个状态的底稿 = 外功分支 + 鸣金分支 + 裂石分支 + 牵丝分支 + 破竹分支
    分支 = (即时攻击 × 倍率 + 固伤) × (1 + 该分支穿透加成) × (1 + 该分支伤害加成)
    只有「生效属性」那一支使用属性倍率，并且只有它吃「属性固伤 × 1.5」

会心期望 = 底稿(小大攻取中值) × (1+通用增伤) × 会心伤害倍率 × 次数 × (1+定音) × (1+特殊增伤) × (1+特定增伤)
会意期望 = 底稿(取大攻)       × (1+通用增伤) × 会意伤害倍率 × 次数 × (1+定音) × (1+特殊增伤) × (1+特定增伤)
普通期望 = 底稿(小大攻取中值) × (1+通用增伤) ×              次数 × (1+定音) × (1+特殊增伤) × (1+特定增伤)
擦伤期望 = 底稿(取小攻)       × (1+通用增伤) ×              次数 × (1+定音) × (1+特殊增伤) × (1+特定增伤)
```

- 即时攻击由攻击池推导：`外功小/大 = (面板小/大 + 食物) × 套装系数`，
  属性小/大 `= (面板该属性小/大 + 生效属性补正) × 套装系数`，再 `×(1+外功加成/属攻加成)`
  `+ 技能自带 + 增益 − 目标防御`（防御只减外功分支）。
- 穿透：`净额 = 输入穿透 − 目标对应抗性 + 技能 + 增益`；`净额 > 0` 记 `0.5%/点`，否则记 `1%/点`。
- 通用增伤 `= 首领增 + 流派固定项 + 类型增伤 + 技能自带 + 增益`。
- 四态占比：`会心占比 = min((1−会意占比)·精准, 精准·会心)`，
  `擦伤占比 = (1−精准)·(1−会意)`（强制精准时为 0），`普通占比 = 1 − 其余三项`。
- 会心率上限 80%、会意率上限 40%；直接会心/会意率在封顶之后相加，且不再封顶；
  会心与会意互斥；强制会心会把生效精准拉满。

### 派生结算动作

```
L = Σ(窗口内各动作的 L) × 结算比例 × (1 + 结算增伤)
```

窗口用**动作序号**表示（不是行区间）。窗口可能包含比结算动作更晚的动作，因此引擎分两遍求值：
先算全部标准动作，再算结算动作。没有结算动作的流派（牵丝玉）直接跳过这一段。

## 流派包 schema

```jsonc
{
  "schemaVersion": 1,
  "id": "pozhu_zun_3.5",
  "name": "破竹樽", "version": "3.5",
  "source": "参考/破竹樽115阶竞速轴属性毕业率进阶计算器3.5.xlsx",
  "notes": ["抽取时的提示"],
  "build": {
    "element": "破竹",                       // 生效属性
    "setMultiplier": 1.05,                   // 套装系数（撼天/倾觞/烟柳…已折算成数值）
    "foodBonus": { "min": 240, "max": 480 }, // 食物加成
    "basePhysicalDamageBonus": 0.0,          // 外功伤害加成基准
    "flatDamageBonus": 0.6,                  // 固伤加成
    "flatDamageTypes": ["拳甲", "双刀"],      // 吃固伤加成的技能类型
    "directCritRate": 0.133,                 // 直接会心率
    "directResolveRate": 0.0,                // 直接会意率
    "critDamageBonus": 0.54,                 // 会心伤害加成
    "resolveDamageBonus": 0.35,              // 会意伤害加成
    "tuningCategory": "酩酊技",               // 生效定音槽的分类名
    "generalDamageFlatBonus": 0.095,         // 通用增伤的固定项
    "typeBonuses": [                          // 技能类型 → 引用哪些增伤输入
      { "name": "拳甲", "add": ["allWeaponBonus", "weaponBonus1"] },
      { "name": "双刀", "add": ["allWeaponBonus", "weaponBonus2"] },
      { "name": "单体奇术", "add": ["skillTypeBonus1"] },
      { "name": "群体奇术", "add": ["skillTypeBonus2"] }
    ],
    "elementAttackAugment": { "min": 79.2, "max": 250.8, "appliesTo": "activeElement" }
  },
  "target": { "defense": 618.3, "physicalResist": 8, "elementResist": 30, "dungeonTalent": 0.06 },
  "rotation": {
    "clearTime": 94.4,
    "benchmarkAdps": 179573.41,
    "actions": [
      { "index": 0, "type": "skill", "skill": "长鲸吸川(拳甲+浅醉)", "repeat": 1,
        "buffs": ["易水歌2层", "沧海帖2层", "离猎", "浅醉"] },
      { "index": 28, "type": "settlement", "ratio": 0.2, "window": [7, 9, 10], "buffs": ["步乱"] }
    ]
  },
  "skills": {
    "长鲸吸川(拳甲+浅醉)": {
      "type": "拳甲",
      "physicalRatio": 1.862784, "physicalFlat": 0, "elementRatio": 2.794176, "elementFlat": 0,
      "generalDamage": 0, "minPhysical": 0, "maxPhysical": 0,
      "physicalBonus": 0, "physicalPenetration": 0, "physicalDamageBonus": 0,
      "elementAttackBonus": 0,
      "penetration": { "mingjin": 0, "lieshi": 0, "qiansi": 0, "pozhu": 0 },
      "elementDamageBonus": { "mingjin": 0, "lieshi": 0, "qiansi": 0, "pozhu": 0 },
      "critRate": 0, "critDamage": 0, "resolveRate": 0, "resolveDamage": 0,
      "charge": 0,
      "forcedPrecise": false, "forcedCrit": false, "forcedResolve": false,
      "tuningCategory": "酩酊技", "specificBonus": 0
    }
  },
  "buffs": {
    "步乱": { "settlementBonus": 0.2, "generalDamage": 0, "penetration": { "...": 0 }, "...": 0 }
  }
}
```

流派包里**没有**：单元格/行/列坐标、真气系数（已删除）、任何"开关"（团队增益 √、心法选择
已固化成数值或常量）。

## 输入 schema（玩家可改的部分）

```jsonc
{
  "schemaVersion": 1,
  "packageId": "pozhu_zun_3.5",
  "precision": 0.9943,        // 精准率
  "critRate": 0.7655,         // 会心率
  "resolveRate": 0.0913,      // 会意率
  "tuningBonus": 0.32,        // 定音加成（分类名在流派包里）
  "attack": {
    "physical":  { "min": 4473, "max": 3417.6, "penetration": 58.7, "damageBonus": null },
    "elements": {                // 非生效属性通常为 0，但模型允许同时有值、一起参与计算
      "mingjin": { "min": 0, "max": 0, "penetration": 0, "damageBonus": 0 },
      "lieshi":  { "min": 0, "max": 0, "penetration": 0, "damageBonus": 0 },
      "qiansi":  { "min": 0, "max": 0, "penetration": 0, "damageBonus": 0 },
      "pozhu":   { "min": 539, "max": 1475, "penetration": 30, "damageBonus": 0.15 }
    }
  },
  "bonuses": {                  // 键名与流派包 typeBonuses 的 add 一一对应
    "allWeaponBonus": 0.0847,   // 全武增
    "bossBonus": 0.0892,        // 首领增
    "weaponBonus1": 0.0854,     // 各武器增
    "weaponBonus2": 0.0854,
    "skillTypeBonus1": 0.0,     // 奇术增
    "skillTypeBonus2": 0.0
  }
}
```

说明：

- `attack.physical.damageBonus` 固定为 `null`：外功伤害加成是流派包的
  `build.basePhysicalDamageBonus`。
- 只写"该流派包真正引用的"增伤项。例如牵丝玉把两个奇术类型合并成一行，
  所以它的输入快照里没有 `skillTypeBonus2`（该流派包的 `notes` 会说明）。
- 各元素都能同时给值：引擎对五个分支分别求和，`element` 只决定"哪一支用属性倍率、
  哪一支吃属性固伤×1.5"，不会抑制其它分支。

## 输出

| 字段 | 含义 |
|---|---|
| `adps` | 总伤 / 战斗时间 |
| `graduationRate` | adps / 流派包 `benchmarkAdps` |
| `totalDamage` | 中间量，便于对照；不需要时可以忽略 |
| `actions`（可选，`--details`） | 每个动作的明细，仅用于排轴诊断 |

## 字段归属总表

| 归属 | 内容 |
|---|---|
| 引擎 | 四态占比与加权、五分支求和、穿透分档、即时攻击推导、派生结算动作、`adps`/`graduationRate` |
| 流派包 · 技能表 | 类型、外功倍率/固伤、属性倍率/固伤、定音分类名、强制精准/会心/会意、特定增伤、蓄力 |
| 流派包 · 增益表 | 各乘区字段；末列拆成 `specificBonus`（作用于标准动作）与 `settlementBonus`（只作用于结算动作） |
| 流派包 · 时间轴 | 动作 `{skill, repeat, buffs[]}` + 结算动作 `{window, ratio, buffs[]}` |
| 流派包 · 固定参数 | 生效属性、套装系数、食物加成、外功伤害加成基准、固伤加成及适用类型、直接会心/会意率、会心/会意伤害加成、定音分类名、通用增伤固定项、类型增伤映射、生效属性补正、战斗时间、基准 ADPS |
| 流派包 · 场景 | 目标防御、外抗、属抗、副本天赋 |
| 输入 | 精准率、会心率、会意率、定音加成；外功小/大攻与穿透；四个属性的小/大攻、穿透、伤害加成；全武增、首领增、各武器增、奇术增 |
| 输出 | `adps`、`graduationRate` |

## 与原表的关系

**游戏机制（引擎如实实现，属于正常行为，不要改动）**：

1. 会心率上限 80%、会意率上限 40%。
2. 精准是触发会心的前置：只有精准命中才可能触发会心，所以**强制会心必然精准**（生效精准一并拉满）；
   强制精准则不会擦伤。
3. 当最小外功攻击 > 最大外功攻击时，普通伤害与会心伤害不再在该区间内随机取值，而是固定取最小外功攻击；
   对应到攻击池就是 `外功大 = max(面板小 + 食物小, 面板大 + 食物大)`、`属性大 = max(面板小, 面板大) + 补正大`。
4. 四态取档：会心/普通取小大攻中值（区间随机取值的期望），会意取大攻，擦伤取小攻。
5. 只有生效属性那一支吃属性倍率与 `属性固伤 × 1.5`。
6. 穿透净额为正记 0.5%/点，为负记 1%/点。
7. 会心与会意互斥；直接会心/会意率在封顶之后相加。
8. 结算动作按比例对窗口内已造成的伤害再结算一次，**这是真实伤害，必须计入总伤**；引擎对它分两遍求值。
9. `repeat = 0` 的动作贡献 0（例如牵丝玉里心法非易水歌时的易水歌跳伤）。
10. 时间轴里的 `N/a` 填充行与 `repeat = 0` 的动作**按原样保留**，不要清理。

**按规格做的整理**（与游戏机制无关，都是原表的写法问题；当前数据下数值完全一致，
已由 `verify.py` + `diff_actions.py` 证明）：

1. 增益表末列按语义一拆为二（`specificBonus` / `settlementBonus`）。原表只有一列：
   破竹风/尘/樽用作"结算增伤"，牵丝玉用作"特定增伤"，而且破竹尘还把它同时加进了特定增伤；
   引擎按语义拆开，各自只作用于该作用的位置。
2. 牵丝穿透"净额为正"分支：原表四份的公式在求和项里引用的是裂石穿透的增益列（判断条件用的仍是
   牵丝穿透）。引擎按属性各自取值（当前数据下两种写法结果相同）。
3. 删除"真气系数"（原本只服务真气比例，而真气比例不是输出）。
4. 保留"蓄力"字段：这四份没有用到，但其它流派可能会用。

## 扩展一个新流派

1. 在 `tools/extract.py` 的 `FILES` 里加一行（id、名称、版本、文件名）；
2. 前提是该表沿用同一套结构（面板/怪物属性/会心会意/各类增伤/定音/固伤/食物 + 时间轴 + 武学奇术表 + 增益表）；
3. 跑 `extract.py` → `verify.py`。若某处口径不同，`diff_actions.py` 会直接指出是哪一个动作差多少。

## 作为库使用

```python
import json, sys
sys.path.insert(0, "dmg-engine")
from engine.core import evaluate_rotation

package = json.load(open("dmg-engine/packages/pozhu_zun_3.5.json", encoding="utf-8"))
inputs = json.load(open("dmg-engine/inputs/pozhu_zun_3.5.json", encoding="utf-8"))

base = evaluate_rotation(package, inputs)
inputs["bonuses"]["weaponBonus1"] += 0.01          # 假设某个武器增伤词条 +1%
after = evaluate_rotation(package, inputs)
print(base["adps"], after["adps"], after["graduationRate"])
```
