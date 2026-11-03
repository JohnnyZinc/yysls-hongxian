# tools/one-off —— 一次性脚本（不在测试链里）

这里的脚本都是**当时为某次具体任务写的**，跑完就结束了；`package.json` 的 `test` / `test:all` /
`check:site` 都不会调用它们，删掉也不影响站点与引擎。留档的目的只是下次要重做同一件事时不用重写。

放这里之前都在 `tools/` 根下，与每天要跑的测试混在一起；2026-11-03 按「测试链 / 一次性」分开。

## 清单

| 文件 | 做什么 | 怎么跑 |
|---|---|---|
| `make_mind_tag.mjs` | 把游戏内截图裁出的流派横幅归一化成官方 mind-tag 规格（254×68） | `node tools/one-off/make_mind_tag.mjs <源图> <输出png> [锐化系数]` |
| `pnglite.mjs` | 零依赖 PNG 读写（RGBA8/RGB8），`make_mind_tag.mjs` 的依赖 | 不单独跑，被 import |
| `check-graduate-ui.mjs` | 逐流派×逐流核对毕业基准来源（方案生成 / Excel I16 回退） | `node tools/one-off/check-graduate-ui.mjs` |
| `extract_panel_fixture.py` | 提取面板计算器 v0.1 主表 W 列缓存值，生成 `data/debug/panel-v01-expected.json` | `python tools/one-off/extract_panel_fixture.py`（需 openpyxl，路径写死在脚本里） |
| `fetch_site_assets.py` | 抓 yysls.destiny.cool 站点自身的 UI 素材（不是游戏解包素材） | `python tools/one-off/fetch_site_assets.py` |
| `xinfa-bg/make_bg.py` | 批量擦除流派横版标签上的白色书法字，输出纯笔触底图 | `python tools/one-off/xinfa-bg/make_bg.py`（需 numpy/opencv/Pillow） |
| `xinfa-bg/verify_final.py` | 核验上面那批底图：尺寸/alpha 一致、中部无残留亮字 | `python tools/one-off/xinfa-bg/verify_final.py` |

## 注意

- 这些脚本多数**依赖本机路径**（`素材库/`、`C:\Users\johnn\Downloads\...`）或联网，
  在别人机器上直接跑多半会失败——它们不是可复现的构建步骤。
- 真正每天要跑的：`npm test`（引擎 + 数据）、`npm run test:all`（含 `check:site` 与两个 UI 测试）。
- 若要重做某件事，优先看脚本头部的注释（踩过的坑都写在里面）。
