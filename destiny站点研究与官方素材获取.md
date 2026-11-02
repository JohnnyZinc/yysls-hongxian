# yysls.destiny.cool 站点研究 + 官方素材获取

研究日期：2026-10-24
研究对象：https://yysls.destiny.cool/（「燕云十六声 · 调律毕业率计算器」，与本项目同类工具）

## 一、结论速览

你的判断是对的：**它的数据确实来自燕云官方微信小程序**——但不是网页直接调小程序，而是
**用一个 Windows 小工具拉起微信 PC 里的小程序完成授权，拿到网易 access_token，再拿 token 去打官方接口**。

素材（图标）则是另一条独立链路：**站点自己托管了一批游戏解包字典 JSON**，图片是网易 CDN 直链，
**不需要任何 token，纯静态可下载**。这条链路我们已经完整复用，60 个心法图标全部拿到了本地。

## 二、三层架构

```
┌ 第 1 层：素材（无需登录，静态）
│   /equip/decoded/*.json  ← 游戏解包字典（站点托管）
│   图片直链 h72.fp.ps.netease.com
│
├ 第 2 层：玩家账号数据（需 token）
│   https://s3.game.163.com/7540694694f2dddc/game/regional/data?access_token=xxx
│
└ 第 3 层：token 获取（需微信 PC）
    yysls_token.exe → 拉起微信小程序 → 用户授权 → access_token
```

## 三、第 1 层：素材字典（本项目已落地）

站点在 `rc()` 里一次性并行加载 10 个 JSON（源码：`Promise.all([Qn('equip/decoded/...')])`，
`Qn` 就是 `fetch`）：

| 文件 | 内容 | 大小 |
|---|---|---|
| `xinfa.json` | **心法**字典（本文重点） | 28 KB |
| `kongfu.json` | 武学 | 10 KB |
| `equip_icon.json` | 装备图标 | 390 KB |
| `equip_name.json` | 装备名 | 167 KB |
| `equip_suit.json` | 套装 | — |
| `equip_tiaolv.json` / `equip_dingyin.json` / `equip_prop.json` | 调律 / 定音 / 属性 | — |
| `qishu.json` | 奇术 | — |
| `head.json` | 头像 | 86 KB |

`xinfa.json` 条目结构（60 条，key 是官方 id）：

```json
{
  "id": 1, "name": "生龙活虎",
  "icon_url":        "https://h72.fp.ps.netease.com/file/6733623b5337b5a3926c8372mP6YrHJ805",
  "bg_icon_url":     "https://h72.fp.ps.netease.com/file/6733623c9ef32828f2e2e586omDirtLo05",
  "liupai_pic_url":  "https://h72.fp.ps.netease.com/file/673362364bc5d682f71423749rhqHok405",
  "liupai_pic_big_url": "...",
  "is_post": 1, "type_name": "通用"
}
```

- **CDN 无防盗链**：带 `Referer: https://yysls.destiny.cool/` 或不带都能下，60/60 成功。
- **桶不允许列举**，必须知道 id/字典才能取（和燕小叽的 COS 一个性质）。

## 四、第 2、3 层：账号数据与 token（本项目暂不需要）

接口（源码常量 `sn`）：

```
https://s3.game.163.com/7540694694f2dddc/game/regional/data?access_token=<token>
https://s3.game.163.com/7540694694f2dddc/game/regional/data/goose?access_token=<token>   // 另一数据集
https://s3.game.163.com/7540694694f2dddc/hun/basic?access_token=<token>                  // 百业
https://s3.game.163.com/7540694694f2dddc/hun/customize/info?access_token=<token>
https://s3.game.163.com/7540694694f2dddc/hun/station?access_token=<token>
```

token 获取（站点「令牌帮助」弹窗原文）：

1. 下载 Windows 版令牌工具（站点 `/downloads/yysls_token_tool.zip`）
2. 运行 `yysls_token.exe`
3. 工具**自动打开微信里的燕云十六声小程序**
4. 按提示授权后即拿到 access token（没拿到就重开小程序）
5. 开源代码：https://github.com/elstp/yysls_token（可自行编译）

前提：小程序里已完成微信授权 + 绑定过游戏账号。
**token 有效期几小时到一天**（站点原文："令牌一般几小时到一天就会过期，这是官方小程序的限制"）。
凭证只存本地浏览器 localStorage（`yysls-accounts` / `yysls-active-account`）。

> 也就是说：想让自己项目也能读"当前账号装备的心法"，路子是同一条——跑那个 token 工具，
> 拿 token 打 `s3.game.163.com` 接口。返回里 `passiveSlots` 是已装备心法 id 数组，
> `xinfaInfo` 是各心法重数，用 `maps.xinfa[id]` 就能查到名字和图标。

## 五、与本项目对照

- 项目 `version.json` 心法 60 个，`界面图片.心法图` 只有 48 条 → 缺 12 张。
- 官方字典 60 条，**全部命中**。缺的 12 个官方 id：

| 项目名 | 官方 id | 官方写法 |
|---|---|---|
| 生龙活虎 | 1 | 同 |
| 晚雪间 | 2 | 同 |
| 铁身诀 | 3 | 同 |
| 山月无影 | 4 | 同 |
| 沙摆尾 | 6 | 同 |
| 归雁经 | 43 | **归燕经**（字不同） |
| 长生无相 | 45 | 同 |
| 婆娑影 | 46 | 同 |
| 明晦同尘 | 47 | 同 |
| 丹心篆 | 48 | 同 |
| 星火燎原 | 102 | **燎原星火**（字序不同） |
| 大卷微身 | 704 | 同 |

（按名称自动匹配只命中 59/60，"归雁经↔归燕经"需硬编码一条。）

## 六、⚠ 素材形态差异（落地前必须决策）

同一本心法（易水歌）的两种素材：

- **燕小叽版（项目现用 48 张）**：深绿底、上尖下宽牌形，白色主体图形，**烧录了「通用」标签 + 心法名文字**
- **官方版（本次新下 60 张）**：512×512 RGBA 透明底，**纯白色线描图形，无任何文字**；
  配套 `bg_icon_url` 是心法专属暗色纹理，`liupai_pic_url` 是流派字（如「通」）

项目 UI 现状：`xinfaStripHtml()` 四槽心法条**只有图标、不挂名字标签**（注释写明"名称已烧录在图标图内"），
名字只在 `title` 悬停和选择模态框里出现。所以——

**直接把官方纯图标换上去，玩家在心法条上认不出是哪本心法**，除非同时改 UI 加名字标签。

### 三个落地选项

| 选项 | 做法 | 代价 |
|---|---|---|
| A 只补 12 张，风格混用 | 缺的 12 个用官方图标 | 免费，但 48 张卡牌 + 12 张白描混排，视觉不统一 |
| B 合成卡牌 | 官方 `bg` + 官方 `icon` + 自绘名字/类型标签（需无头浏览器渲染中文字，本机无 Pillow/Canvas） | 视觉最统一，工作量中等 |
| C 全量换官方图标 + UI 加名字标签 | 60 张统一用官方白描图标，心法条每格下方加 `<span>` 显示名字 | 统一且清晰，但要改 `xinfaStripHtml()`（属用户 2026-10 定稿过的 UI 口径，需拍板） |

## 七、已落地文件

> 2026-10-24 追加：素材已全量抓取，见下节。

- `web/assets/img/mind-official/<id>.png` —— 60 张官方心法图标（512×512 RGBA）
- `web/assets/img/mind-official/bg/<id>.png` —— 60 张心法背景纹理
- `web/assets/img/mind-official/index.json` —— 项目心法名 → 官方 id / 名称 / 图片相对路径 / 原始 CDN URL
- 合计约 11 MB

## 八、素材库全量清单（2026-10-24 已抓全）

抓取脚本：`tools/fetch_official_assets.py`（可重复运行，缺什么补什么，支持 `--only <类别>` / `--dry-run`）。
输出根目录 **`素材库/official/`**（343 MB，**已加进 .gitignore**，不入库、不进部署目录）。

| 类别 | 来源字典 | 字段 | 张数 | 体积 | 内容 |
|---|---|---|---|---|---|
| `xinfa` | xinfa.json | icon_url / bg_icon_url / liupai_pic_url / liupai_pic_big_url | 86 | 4.6 MB | 心法图标 60 + 背景 3 + 流派字 12 + 流派大字 11 |
| `kongfu` | kongfu.json | pic_url / liupai_pic_url | 40 | 0.8 MB | 武学图标 29 + 流派图 11 |
| `equip` | equip_icon.json | icon_url / long_icon_url | 573 | 117 MB | 装备图标 392 + 装备长图 181 |
| `qishu` | qishu.json | pic_url | 60 | 1.1 MB | 奇术图标 |
| `head` | head.json | pic_url | 686 | 199 MB | 头像（单张 ~290 KB，最大头） |

- **无图片字段**的字典：`equip_name` / `equip_tiaolv` / `equip_dingyin` / `equip_prop` / `equip_suit`（纯数值/文本）。
- 索引：`素材库/official/index.json`（类别 → 条目 → 字段 → 本地路径 + 原始 CDN URL，1230 条）。
- 项目心法名对照：`素材库/official/xinfa-map.json`（60 条，含归雁经→43 的硬编码）。
- 站点自身素材：`素材库/site/`（38 个 UI 图 + `wallpaper/` 13 张官网壁纸，共 ~22 MB）。
- 站点内可用副本：`web/assets/img/mind-official/<官方id>.png`（60 张心法图标，3.9 MB）。

⚠ 原图未压缩（512×512 PNG 为主），所以体积大。要用进站点时按类别挑，别整目录拷。
