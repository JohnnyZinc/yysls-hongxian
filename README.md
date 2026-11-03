# 调律台 · 燕云十六声装备调律评价工作台

把一个角色当前穿着的 8 件装备丢进来，它告诉你：**配额还缺什么、这件是穿/转律/放背包/分解、转成什么最划算、有没有更好的组合，以及离毕业还差多少。**

纯静态站点：没有后端、没有构建、没有 `npm install`，`npm run serve` 就能跑，也可以直接挂在 GitHub Pages 上（项目级站点 + 自定义二级域名）。

**在线**：<https://hongxian.xianshan.link/>（GitHub Pages 项目级站点 + 自定义二级域名；`https://johnnyzinc.github.io/yysls-hongxian/` 会 301 过来）· **源码**：<https://github.com/JohnnyZinc/yysls-hongxian>（main 分支推送后 Pages 自动重建）

---

## 目录结构

```
index.html          站点入口（唯一页面）
sw.js               Service Worker：本地缓存静态资源，二次打开基本 0 网络（改资源后把 CACHE_VERSION 加一）
web/                前端：studio.js（页面与交互）/ assist.js（助手）/ studio.css 等
assets/             静态素材：字体（文鼎楷，单文件子集）、装备图标、心法卡（webp）、立绘、背景
data/               游戏数据（站点运行时读的就是这里）
  schools/            各流派 DPS 三件套：<buildId>.json / .skills.json / .effects.json
  template/           方案文件（流派/分支/方案 + 套装/武库/心法/配额），index.json 为离线索引
  version/            赛季 manifest、属性与词条区间
  golden/ debug/      测试基准与采集样本（仅测试用）
engine/             纯 JS 引擎（无 DOM 依赖，可单测）
  dps 逐事件模拟 · panel 面板 · quota 配额 · advisor 档位与转律 · dispose 四分类处置
  search 组合搜索 · transform 转律 · graduate 毕业率 · inspect 三视图 · swap ΔDPS · monitor 监测 · assist 意图
tools/              开发脚本（站点不依赖）
  test_*.js 测试 · build_static_index.js 生成方案索引 · serve.js 本地服务 · check_site.js 站点体检
  check_templates.js 数据校验 · cutout.py / normalize_portraits.py 立绘处理 · fetch_*/extract_* 素材与数据采集
  one-off/            一次性脚本（历史任务用，不参与测试链，见 tools/one-off/README.md）
notes/              设计与交接文档（见下方「文档索引」）
知识库/             助手知识库：机制 md + index.json，页面按需检索（也可直接当人读的资料）
EXCEL计算器/        社区 DPS / 面板计算器 Excel（数据来源，站点不读）
素材库/ .tmp/ .cache/ .workbuddy/    本机产物，已被 .gitignore，不入库
```

站点数据结构：**引擎一套，流派数据 N 套**。加新流派 = 往 `data/schools/` 与 `data/template/` 放数据，不改代码。

---

## 本地运行

```bash
npm run serve          # → http://127.0.0.1:4173/    （只需 Node 20+，零依赖）
```

页面就是根目录的 `index.html`，和托管后的形态完全一致（含子路径部署）。

## 测试与自检

```bash
npm run test:all       # 15 套 580 项 + 站点体检，全绿才算完成
npm run check:site     # 只体检静态站：绝对路径 / 引用缺失 / 运行时数据 / Pages 文件
npm run check:data     # 方案文件结构校验（配额总数、字段齐备性）
npm run build:index    # 新增/改名/删除方案文件后，重建 data/template/index.json
```

目前：**580 项断言全绿**（引擎 14 套 + 工作台 83 + 助手 81），另有站点体检 225 项
（含绝对路径、SW 预缓存清单、字体子集、界面图片引用等）。

---

## 部署到 GitHub Pages（项目级，多仓库各自一个二级域名）

站点已经准备好：相对路径 + 根目录 `.nojekyll` + 离线方案索引，**不需要任何构建步骤**。

1. 推到 GitHub，仓库 **Settings → Pages**：
   - Source = `Deploy from a branch`
   - Branch = `main`，目录 = `/ (root)`
2. 默认地址就是项目级站点：`https://<user>.github.io/<repo>/` —— 多个仓库各有一个，互不冲突。
3. 想要自己的二级域名（每个仓库各一个子域名）：
   - 仓库根新建 `CNAME` 文件，内容只有一行，例如 `gear.example.com`（不带协议、不带路径）
   - 你的域名 DNS 加一条 **CNAME**：`gear` → `<user>.github.io`（不要带仓库名）
   - **Settings → Pages → Custom domain** 填同一个域名，等证书签发后勾上 `Enforce HTTPS`
   - 注意：一个域名只能对应一个站点，所以「多个仓库」= 多个子域名，各配各的 CNAME 文件
   - 每个仓库还可以在 Pages 设置里同时保留 `*.github.io/<repo>/` 与自定义域名两种访问方式
   - **本仓库已经配好**：`CNAME` = `hongxian.xianshan.link`，DNS 指向 `johnnyzinc.github.io`，
     HTTPS 已强制；换域名时改这三处（CNAME 文件 / DNS / Pages 设置）。
4. `.nojekyll`：根目录那个空文件别删。`data/template/*/_meta.json` 这种下划线开头的文件，
   没有它会被 GitHub 的 Jekyll 流程吞掉，结果就是「分支下拉框空掉」。

> 站点是公开的：仓库里的一切（`tools/`、`notes/`、`知识库/`、`EXCEL计算器/` 等）都能被按 URL 直接访问。
> 这些是游戏数据与个人笔记，不含任何密钥；如果以后不想公开，改成发布 `docs/` 目录即可（需要加一步构建）。

## 性能与缓存（2026-11-03 优化，已上线）

GitHub Pages 对静态文件的响应头是固定的 **`Cache-Control: max-age=600`**，不支持自定义头。
也就是说：**隔十几分钟再打开，浏览器仍要为几十个资源逐个发条件请求**，跨境链路下这就很慢。
所以站点自己做了三件事：

1. **Service Worker（根目录 `sw.js`）**
   - 首次访问照常联网；之后导航 network-first（4s 超时回落缓存），`assets/`、`web/`、`engine/`
     走 stale-while-revalidate（先用缓存秒开、后台更新），`data/` 与 `知识库/` network-first
     （1.5s 超时回落缓存，保证数据新鲜）。
   - **改了任何静态资源想立刻生效**：把 `sw.js` 里的 `CACHE_VERSION` 加一（`v1` → `v2`）。
     不加也能生效，只是老用户的旧缓存要等下一次后台更新。
   - 本地 `npm run serve` 也会注册（方便验证）；`file://` 打开不会。
2. **字体单文件子集**：原先把楷体切成 71 个 woff2（2.76MB、90+ 个请求），现在合并裁剪成
   一个 `assets/fonts/kai/gkai00mp.woff2`（**357KB**，覆盖站点全部 1463 个用字），并在
   `index.html` 里 preload。新文案出现生僻字时该字会走系统楷体回退，视觉几乎无差；
   要补字用 `tools/one-off/font_subset.py`（脚本头写了怎么从 git 历史取回分片）。
3. **首屏图片 WebP**：背景、心法卡底、流派横幅、武库/武学图标等 16 张 PNG 转 WebP（q86），
   体积 **991KB → 328KB**。图片引用集中在 `data/version/<赛季>/version.json` 的「界面图片」，
   换图/换格式改那里一处即可，`npm run check:site` 第 9 项会逐个验证文件存在。

效果：本地二次打开 111 个请求里 110 个由 SW 直接命中（transfer ≈ 0）；线上首次打开仍受
跨境 RTT 影响（字体 357KB + 首屏图 328KB + JS/CSS ≈ 300KB）。

> 还想更快的话：在 Cloudflare 给 `xianshan.link` 开橙云代理（边缘缓存 + Brotli），
> 或把站点迁到 Cloudflare Pages / Vercel（可以自定义 `immutable` 缓存头并做资源指纹）。
> 当前 GitHub Pages 方案零成本、零构建，代价就是首屏冷启动的一次跨境往返。

## 路径纪律（唯一的坑）

**站点内所有资源一律用相对路径**：`web/…`、`assets/…`、`data/…`。

不要写 `/data/…`、`/web/…` 这种以斜杠开头的路径——本地 `serve.js` 能跑通，但挂到
`https://<user>.github.io/<repo>/` 时会解析到域名根，页面直接白屏。

改完任何页面/引擎/数据，跑一遍 `npm run check:site`，它会把这类问题挡在提交前。

---

## 存档位置

浏览器 `localStorage`，不涉及服务端：

- `yysls-evaluator-v1`：角色、装备库、各配置已穿戴（导出分享用的就是这一份）
- `yysls-assist-v1` / `yysls-assist-shown-v1`：助手配置与提示去重表（独立 key，绝不混进装备档）

---

## 文档索引（都在 `notes/`）

| 文档 | 内容 |
| --- | --- |
| [交接文档](notes/交接文档.md) | **新会话先读这篇**：完成度、代码地图、关键决策、踩坑、路线图 |
| [评价系统设计](notes/评价系统设计.md) | P1 三系统权威版：配额推导、档位、处置、转律 |
| [PRD](notes/PRD.md) | 产品需求与验收口径 |
| [数据架构盘点](notes/数据架构盘点.md) | JSON 化现状审计与重构议题 |
| [立绘提示词](notes/立绘提示词.md) | 角色立绘的形象锁定与出图流程 |
| [燕小叽站点研究与纯唐轴提取](notes/燕小叽站点研究与纯唐轴提取.md) | 外部站点踩点与数据提取记录 |
| [destiny 站点研究与官方素材获取](notes/destiny站点研究与官方素材获取.md) | 素材来源与抓取方式 |

### 2026-11-03 目录重构对照（老文档里看到旧路径时按此换算）

| 旧 | 新 |
| --- | --- |
| `web/studio.html` | `index.html` |
| `web/assets/` | `assets/` |
| 根目录 `交接文档.md` / `PRD.md` / … | `notes/…` |
| `/data/…`、`/web/…`、`/api/template/…` 绝对路径 | `data/…`、`web/…`、`api/template/…` 相对路径 |
| `.workbuddy/memory/*`（曾在库里） | 不再入库，只留在本机 |
| `data/kb/`（助手知识库） | `知识库/`（上移到根目录，md 与数据分离） |
| `参考/*.xlsx` | `EXCEL计算器/*.xlsx` |
| `参考/*.md` | `知识库/*.md` |
| `archive/`（旧 Python 实现 / 旧 Excel） | 已删除，需要时查 git 历史 |

---

## 知识库（`知识库/`）

助手「周红线」回答游戏机制时，不靠模型记忆，而是按需检索这里的 md：

- `index.json` 是清单（只列 md）；每篇 md 顶部 front-matter 写 `title` / `tags` / `summary` / `type`（`rule`=机制，只许照原文说；`guide`=经验，可自由组织）
- 正文按 `##` 切段，检索用中文 bigram + 术语直配打分，取前 3 段作为对话的事实依据
- 加资料：把 md 放进 `知识库/`、补 front-matter、在 `index.json` 里登记一行，跑 `npm run test:all`（会验证每篇都能解析）
- `官方心法图标样例.png` 只是图标参考图，不参与检索

---

## 已知未决

- 立绘 `angry` 缺图（缺图自动回落 `idle`，补上不用改代码）
- 会心伤害 35% / 会意伤害 20% 的等级加成是**假设**（实测可精确复现，但未拿到官方表）
- 鸣金虹 / 鸣金影仍是 110 阶轴；裂石钧纯唐轴暂借双切轴
- 毕业率可能 >100%（毕业基准是配额的一个可行解，属设计意图，不是 bug）
