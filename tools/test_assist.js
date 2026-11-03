'use strict';

/**
 * test_assist.js — 助手内核（engine/assist.js）+ 接入纪律的静态断言
 *
 * 分两段：
 *   A. 纯函数：意图规则 / 部位识别 / 分词 / 知识库解析与检索 / 事实快照；
 *   B. 接入纪律：三栏开关只有一个变量、助手的配置不落进装备存档、assist 不反向依赖 studio。
 *
 * UI 交互（消息流、卡片、流式渲染）不在本文件测 —— 那需要真 DOM，
 * 用浏览器手测；这里只保"算错就会误导玩家"的部分。
 */

import fs from 'node:fs';
import {
  intentOf, slotOf, weaponTypeOf, tokenize, parseKb, searchKb, hitsToContext, compactFacts,
} from '../engine/assist.js';

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
};

// ============ A1. 部位识别 ============
console.log('\n— A1. 部位识别 —');
check('「护腕」认出腕甲（不被泛化的"腕/臂"抢走）', slotOf('刚打了个护腕') === '腕甲');
check('「胫甲」认出胫甲', slotOf('我新得了一件胫甲') === '胫甲');
check('「戒指」认出环', slotOf('出了个戒指') === '环');
check('「长枪」认出武器 + 类型枪', slotOf('这把长枪还行') === '武器' && weaponTypeOf('这把长枪还行') === '枪');
check('认不出的句子返回 null', slotOf('今天天气不错') === null);

// ============ A2. 意图规则 ============
console.log('\n— A2. 意图规则 —');
const I = (t) => intentOf(t) || {};
check('「我新得了一件胫甲」→ 录入 + 部位', I('我新得了一件胫甲').act === 'entry' && I('我新得了一件胫甲').slot === '胫甲');
check('「刚打了个护腕」→ 录入 + 腕甲', I('刚打了个护腕').act === 'entry' && I('刚打了个护腕').slot === '腕甲');
check('「新得了个好东西」→ 录入但不知道部位（回头追问）',
  I('新得了个好东西').act === 'entry' && I('新得了个好东西').ask === 'slot');
check('「看看背包」→ backpack', I('看看背包').act === 'backpack');
check('「我这套还差什么」→ quota', I('我这套还差什么').act === 'quota');
check('「有没有更好的组合」→ composition', I('有没有更好的组合').act === 'composition');
check('「切换方案」→ plan', I('切换方案').act === 'plan');
check('「看属性面板」→ stats', I('看属性面板').act === 'stats');
check('闲聊不误判（返回 null，交给模型）', intentOf('今天天气不错') === null);
check('「录入装备」没说部位也算命中', I('录入装备').act === 'entry');

// ============ A3. 分词 ============
console.log('\n— A3. 分词 —');
check('中文按 bigram 切', tokenize('转律').includes('转律') && tokenize('转律规则').includes('律规'));
check('单字查询不被吃掉', tokenize('敏').includes('敏'));
check('英文数字按词切', tokenize('DPS 123').includes('dps') && tokenize('DPS 123').includes('123'));
check('空串返回空数组', tokenize('').length === 0);

// ============ A4. 知识库解析 ============
console.log('\n— A4. 知识库解析 —');
const md = `---\ntitle: 测试篇\ntags: 甲, 乙\nsummary: 这是一段描述\n---\n\n# 测试篇\n\n开头说明。\n\n## 第一段\n\n正文一。\n\n## 第二段\n\n正文二。\n`;
const doc = parseKb(md, 't.md');
check('front-matter 解析出 title/tags/summary',
  doc.meta.title === '测试篇' && doc.meta.tags.join(',') === '甲,乙' && doc.meta.summary === '这是一段描述');
check('按 ## 切段，开头说明并进首段', doc.sections.length === 3 && doc.sections[0].body.includes('开头说明'));
check('段标题取「## 」后的文字', doc.sections[1].heading === '第一段' && doc.sections[2].heading === '第二段');
check('没有 front-matter 时用 # 标题兜底',
  parseKb('# 无头篇\n\n正文。\n', 'x.md').meta.title === '无头篇');

// ============ A5. 知识库检索（用真实语料）============
console.log('\n— A5. 知识库检索 —');
const KB_DIR = '知识库';
const kbFiles = JSON.parse(fs.readFileSync(`${KB_DIR}/index.json`, 'utf-8')).files;
const docs = kbFiles.map((f) => parseKb(fs.readFileSync(`${KB_DIR}/${f}`, 'utf-8'), f));
check(`索引里的 ${kbFiles.length} 篇都能解析出段落`, docs.every((d) => d.sections.length > 0));
check('每篇都有 title 与 summary（索引靠它筛文档）',
  docs.every((d) => d.meta.title && d.meta.summary));

const hitTransform = searchKb(docs, '转律能转几条');
check('问「转律能转几条」命中转律篇',
  hitTransform.length > 0 && hitTransform[0].file === 'rule-transform.md');
check('命中结果带 heading 与正文（能贴原文，不让模型瞎编）',
  hitTransform[0].heading && hitTransform[0].body.includes('最多只能转一条'));

const hitTier = searchKb(docs, '废词条影响品相吗');
check('问「废词条影响品相」命中品相篇', hitTier.some((h) => h.file === 'rule-tier.md'));

const hitQuota = searchKb(docs, '配额缺口怎么算');
check('问「配额缺口」命中配额篇', hitQuota.some((h) => h.file === 'rule-quota.md'));

check('无关问题检索不到（空结果 ⇒ 她该说"拿不准"）', searchKb(docs, '今天天气不错').length === 0);
check('limit 生效', searchKb(docs, '转律 品相 配额', { limit: 2 }).length <= 2);

const ctx = hitsToContext(hitTransform);
check('引用块带出处标题（便于她照原文说）', ctx.includes('【') && ctx.includes('转律'));

// ============ A6. 事实快照 ============
console.log('\n— A6. 事实快照 —');
const f = compactFacts({
  方案: '裂石钧·纯唐轴·小外流',
  品相: '地',
  缺口: [{ affix: '敏', n: 1 }, { affix: '小外', n: 2 }],
  已穿: 7, 背包: 5, 焦点: '胫甲',
});
check('快照含方案与品相', f.includes('裂石钧·纯唐轴·小外流') && f.includes('地'));
check('缺口拼成「敏×1、小外×2」', f.includes('敏×1、小外×2'));
check('缺口为空时说"无"（不是留空）', compactFacts({ 缺口: [] }).includes('无'));
check('缺字段不输出空行', !compactFacts({ 方案: 'A' }).includes('：\n'));

// ============ B. 接入纪律 ============
console.log('\n— B. 接入纪律 —');
const cssText = fs.readFileSync('web/studio.css', 'utf-8');
const htmlText = fs.readFileSync('index.html', 'utf-8');
const assistSrc = fs.readFileSync('web/assist.js', 'utf-8');
const studioSrc = fs.readFileSync('web/studio.js', 'utf-8');

check('三栏列宽：左 1/3、右 1/4、中间吃剩余（4:5:3）',
  cssText.includes('.studio.assist-on')
  && cssText.includes('minmax(0, 4fr) minmax(0, 5fr) minmax(0, 3fr)'));
check('整页不出滚动条（body 锁 100vh + overflow hidden）',
  /body\s*\{[^}]*height:\s*100vh/.test(cssText) && /body\s*\{[^}]*overflow:\s*hidden/.test(cssText));
check('背包与属性面板各自内部滚（页面不滚，内容多的卡自己滚）',
  cssText.includes('#st-center .st-bp-groups') && cssText.includes('#st-stats-box'));
check('默认仍是两栏（没加类时不受助手影响）',
  cssText.includes('grid-template-areas: "leftcol right"'));
check('助手列在中间（leftcol → assist → right）',
  cssText.includes('"leftcol assist right"'));
check('移动端助手全屏，两栏退成图标',
  cssText.includes('data-mview="gear"') && cssText.includes('data-mview="read"') && cssText.includes('#st-dock'));
check('HTML 有助手容器与移动端切换条',
  htmlText.includes('id="st-assist"') && htmlText.includes('id="st-dock"'));
check('移动端三视图由 data-mview 独占（assist-on 开着也能切，否则全屏面板盖住一切）',
  cssText.includes('body[data-mview="gear"] #st-leftcol { display: flex !important; }')
  && cssText.includes('body[data-mview="assist"] #st-assist { display: flex !important; }'));
check('移动端面板底部让出 52px 给切换栏（否则输入框被它盖住）',
  cssText.includes('inset: 0 0 52px 0'));
check('移动端页面锁死一屏，滚动收进 .studio（底栏永远贴底，不用"滑回去"）',
  cssText.includes('height: 100dvh')
  && cssText.includes('overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain'));
check('底部三视图文案 = 红线 / 装备 / 面板',
  studioSrc.includes('data-mview-btn="assist" aria-selected="true">红线')
  && studioSrc.includes('data-mview-btn="read" aria-selected="false">面板'));
check('卡片用容器查询（同一张卡要活在三栏中列与手机全屏两种宽度）',
  cssText.includes('container-type: inline-size') && cssText.includes('@container'));

check('助手配置不落进装备存档（那个档会被导出分享）',
  !/localStorage\.\w+\(\s*['"]yysls-evaluator-v1/.test(assistSrc) && assistSrc.includes('yysls-assist-v1'));
check('提示去重表单独存', assistSrc.includes('yysls-assist-shown-v1'));
check('assist 不反向 import studio（避免循环依赖）',
  !/from\s+['"]\.\/studio\.js['"]/.test(assistSrc));
check('studio 通过依赖注入挂载助手', studioSrc.includes('mountAssist(assistHost)'));
check('没配 key 时不发请求，走模板话术（模型挂了助手不能消失）',
  assistSrc.includes('!S.cfg.key') && assistSrc.includes('templateReply'));
check('主动提示按「件×结论」去重，不按时间窗（连录多件都要能提示）',
  assistSrc.includes('S.shown[key] === sig') && !/24\s*\*\s*60/.test(assistSrc));
check('组合提示要防抖复核：切分支+方案连跑两次 render，中间态不许开口',
  studioSrc.includes('compositionSig(now) !== sig') && studioSrc.includes('compTimer'));
check('底部短句默认不出现（导航类按钮不许塞进对话；只有她追问时才给）',
  assistSrc.includes('function setChips') && assistSrc.includes('setChips([])')
  && !assistSrc.includes("label: '看看背包'") && !assistSrc.includes("label: '看配额'"));
check('助手按需查数：六个取数工具 + 单件决策 + 知识库（不做关键词路由）',
  (assistSrc.match(/name: 'get_/g) || []).length === 6
  && assistSrc.includes("name: 'evaluate_piece'") && assistSrc.includes("name: 'search_kb'"));
check('工具循环有轮次上限，且末轮前明确喊停（思考模型容易一直"还差一块"）',
  assistSrc.includes('MAX_ROUNDS = 6') && assistSrc.includes('不要再调用工具'));
check('兼容多家思考链字段 + MiniMax 需显式 reasoning_split',
  assistSrc.includes('thinking_content') && assistSrc.includes('reasoning_split'));
check('输出被截断时如实告知（finish_reason=length）',
  assistSrc.includes("finishReason === 'length'"));
check('工具结果以 role:tool 回传，带 tool_call_id',
  assistSrc.includes("role: 'tool'") && assistSrc.includes('tool_call_id'));
check('七个数据工具在 studio 侧都有实现',
  ['get_loadout', 'get_backpack', 'get_quota', 'get_panel', 'get_plan', 'evaluate_piece', 'get_focus']
    .every((n) => studioSrc.includes(`case '${n}'`)));
check('装备编号挂在行尾（行首会变成它的名字，模型就会念出来）',
  studioSrc.includes('[${pc.uid}]') && studioSrc.includes('[${p.uid}]'));
check('面板工具不返回 DPS / 毕业率（数字不可靠，不许进对话）',
  !/DPS \$\{Math\.round/.test(studioSrc) && assistSrc.includes('不许提 DPS'));
check('主动提示读 parts.结论（四段式重构后「建议」已废，读错会把文案说反）',
  studioSrc.includes('r.parts?.结论') && !studioSrc.includes('r.parts?.建议'));
check('单件建议必须走引擎：evaluate_piece 用 disposeItem，不靠模型推',
  studioSrc.includes('function evaluateText') && studioSrc.includes('disposeResultOf(piece)'));
check('思考链与工具记录折叠进「过程」，不占正文',
  assistSrc.includes('st-think') && assistSrc.includes('reasoning_content')
  && !assistSrc.includes("note(`· 看了"));
check('知识库引用块标了「机制 / 经验」类别（机制类只许照原文说）',
  ctx.includes('（机制）') || ctx.includes('（经验）'));
check('流派选择改两级、一个动作切完（不再先切流派再切方案，杜绝中间态）',
  studioSrc.includes('pickSchoolSeal') && studioSrc.includes('async gotoFlow(')
  && studioSrc.includes('state.switching = true'));
check('印章展开只动自己那一格：印章左滑、原位滑入分支·方案（不换页、不重排）',
  cssText.includes('.st-flow-list') && cssText.includes('.st-school-cell.open .st-school-card')
  && studioSrc.includes('st-flow-list'));

// ============ C. 立绘 ============
console.log('\n— C. 立绘 —');
{
  const manifest = JSON.parse(fs.readFileSync('assets/img/char/manifest.json', 'utf-8'));
  check('立绘清单在，且四张齐（idle/talk/think/unsure）',
    ['idle', 'talk', 'think', 'unsure'].every((m) => manifest.moods.includes(m)));
  check('清单里的每张图都真的存在（网页只用 webp，母本 png 在素材库）',
    manifest.moods.every((m) => fs.existsSync(`assets/img/char/hongxian-${m}.webp`))
    && manifest.moods.every((m) => fs.existsSync(`素材库/周红线/_抠图/hongxian-${m}.png`)));
  check('不再有「立绘 · 占位」占位文案', !assistSrc.includes('立绘 · 占位'));
  check('立绘按清单渲染，且是背景层（绝对定位、不吃点击）',
    assistSrc.includes('st-assist-portrait') && cssText.includes('.st-assist-face {')
    && cssText.includes('position: absolute; inset: 0; z-index: 0; pointer-events: none'));
  check('五种情绪靠 data-mood 交叉淡入（不换 src，换 src 会闪白）',
    assistSrc.includes('data-mood=') && cssText.includes('.st-assist-face[data-mood="idle"] .st-assist-portrait[data-m="idle"]')
    && cssText.includes('transition: opacity'));
  check('缺哪张图就回落 idle（图是后补的，不能因为少一张就空一块）',
    assistSrc.includes("S.moods.includes(m) ? m : 'idle'"));
  check('情绪跟着对话阶段走：等待=think、开口=talk、报错/追问=unsure、说「不理你」=angry',
    assistSrc.includes("setMood('think')") && assistSrc.includes("setMood('unsure')")
    && /不理你\|哼/.test(assistSrc));
  check('桌面：立绘高度 = 对话框高度的 2/3（按高度定，不按栏宽 —— 否则宽屏上头顶顶到标题行）',
    cssText.includes('--pt-h: 66%') && /\.st-assist-portrait \{[\s\S]*?height: var\(--pt-h\)/.test(cssText));
  check('桌面：文字避让宽度跟着立绘高度算（cqh，不是 %，% 是相对宽度算的）',
    cssText.includes('container-type: size')
    && cssText.includes('calc(var(--pt-hc) * 0.315 + 22px)'));
  {
    const at = cssText.indexOf('.st-assist-portrait {');
    const base = cssText.slice(at, cssText.indexOf('}', at));
    check('桌面不叠遮罩（抠好的透明底 + 文字已避让，再压一层就是白糊一层）',
      at > -1 && !base.includes('mask-image'));
  }
  check('移动端：立绘满屏高 + 对话贴底堆（腰线以上不放字）',
    /#st-assist \.st-assist-portrait \{[\s\S]*?height: 100%/.test(cssText)
    && cssText.includes('margin-top: auto; max-height: 46%')
    && cssText.includes('#st-assist .st-assist-head { order: 2;'));
}

// ---- 汇总 ----
console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.log('失败：\n- ' + fails.join('\n- '));
  process.exit(1);
}
console.log('全部通过');
