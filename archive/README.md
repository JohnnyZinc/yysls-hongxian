# archive/ — 旧文件归档

本目录存放已被新实现取代的历史文件，仅作参考，不再维护。
当前活跃代码在根目录：`engine/`（DPS引擎）、`data/`（流派数据）、`tools/`（提取/对比/测试工具）。

## 目录内容

### dmg-engine/ — 旧版 Python 引擎（已被 engine/dps.js 取代）

更早的期望伤害引擎实现：与流派无关的 Python 引擎 + 4 份流派包 + 输入快照。
基于**旧版 Excel**（破竹风3.1 / 破竹尘3.1 / 牵丝玉3.2 / 破竹樽3.5）提取，
其 `tools/extract.py` 中的 Excel 路径已因旧版表格移入本目录而失效。

被取代的原因：
- 数据基于旧版 Excel（新版为 破竹风3.2 / 破竹尘3.3 / 牵丝玉3.5 / 破竹樽3.6）
- 新引擎 `engine/dps.js` 已通过全部 6 个流派的最新版 Excel 精确验证（偏差 0.0000%）
- 新引擎为 JS 实现，可直接用于本地网页应用，无需 Python 运行时

### legacy-excel/ — 旧版 Excel 计算器

- 破竹风 3.1（新版 3.2）
- 破竹尘 3.1（新版 3.3）
- 破竹樽 3.5（新版 3.6）
- 牵丝玉 3.2（新版 3.5）

最新版在 `参考/` 目录。若需复现 dmg-engine 的历史结果，把对应 xlsx 移回 `参考/` 即可。

### legacy-tools/ — 一次性分析与探测脚本（已完成使命）

| 脚本 | 用途 | 结论去向 |
|---|---|---|
| extract_pozhufeng.py | 第一版破竹风提取器（写死列号） | 被 tools/extract_calculator.py（动态表头映射）取代 |
| probe_shift.py | 探测裂石威/牵丝霖时间轴列偏移 | 已在 extract_calculator.py 中动态处理 |
| analyze_l_overrides.py | 定位 L 列覆盖公式（结算/醉杀） | 已实现在 extract_calculator.py + engine/dps.js |
| check_meridian_selector.py | 验证心法选择器与易水歌条件公式 | 结论：只用作者默认配置，条件值取缓存 |
| check_qiansilin_na.py | 确认牵丝霖 N/a 技能为零倍率占位 | 无需引擎处理 |
| verify_quirks.py | 验证 (拐)后缀增益同物同名异 | 结论写入归档前的对比报告 |
| verify_new.py | 旧版提取结果核验 | 被 tools/test_dps.js 取代 |

## 当前活跃结构（速览）

```
engine/dps.js            DPS 引擎（6流派精确对齐 Excel）
data/{流派}.{115}.{版本}.json          build（时间轴/面板/怪物/验证基准）
data/{流派}.{115}.{版本}.skills.json   武学奇术表
data/{流派}.{115}.{版本}.effects.json  增益表
data/comparison_report.json           六流派共享性对比报告
data/debug/                           逐事件 Excel 缓存值（调试用）
tools/extract_calculator.py           Excel → JSON 提取器
tools/compare_data.py                 多流派 skills/effects 对比
tools/test_dps.js                     引擎验证（node tools/test_dps.js）
tools/diff_event.js + dump_excel_rows.py  逐事件中间量对比
PRD.md                                产品需求文档
```
