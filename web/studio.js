'use strict';

/**
 * studio.js — 两栏工作台 UI（P2 v7，零依赖 vanilla ESM）
 *
 * 布局（2026-11-02 起两栏；原「助手」占位列已删，见 评价系统设计.md §11.10.3）：
 *   左栏  `#st-leftcol`：已穿戴 8 部位（两行各 4 + 第五列套装/武库徽标） + 背包卡（纵叠）
 *         背包的「＋录入装备」按钮在卡片标题内；恒按当前方案品阶排序。
 *   右栏  自上而下：
 *          ① 流派/分支/方案选择（左）与 毕业率大字读数（右）同卡同行；
 *          ② 四本心法独立成卡（不再与口径同卡，尺寸由本卡宽反解 --mind-w）；
 *          ③ 词条配额（两栏）；④ 属性面板（两栏）——③④ 合成一张面板。
 *        属性面板（用户定稿：固定字段顺序、无分组标题；攻击=最小/最大合并行，见 statsHtml / atkRangeText），
 *        三率不再单列达标/溢出两张表，直接给数值上色（绿=达标，黄=不足方案阈值，红=超游戏机制上限）。
 *   弹窗  录入装备（点背包卡里的按钮或点空槽位）/ 装备详情（点背包卡片）；
 *         关闭 = 点遮罩、点右上角关闭、按 Esc。
 *   已穿戴槽两段式（用户定稿 2026-10-30）：第一次点 = 背包筛到同部位（武器槽 2026-10-31 起只列本槽类型），
 *         其它类型另起一行），再点同一槽 = 打开该件详情弹窗；背包点一下即开弹窗。
 *
 * 录入体验（用户定稿）：边录入边评价——每录一条词条显示当前潜力（天地玄黄）；
 * 结构录满后给出换装对比结论（更好/更差/等价，不显示幅度），并在入包前给出「穿上/保留背包/回收删除」建议。
 *
 * 复用 P1 引擎（quota/advisor/monitor/swap/inspect/graduate），不给综合结论。
 * 存档在 localStorage（key: yysls-evaluator-v1）。键名沿用历史值，改动会清空玩家已录装备库，勿轻易更名。
 */

import { derivePrescription, lookupAffixRange, weaponTypesOf } from '../engine/quota.js';
import { gradeItem, gradeItemPotential, adviseConversion, stateOf, routesToTier, surveyFlows } from '../engine/advisor.js';
import { computeGraduateDps } from '../engine/graduate.js';
import { inspectOverall } from '../engine/inspect.js';
import { evalGearDps, evaluateSwap } from '../engine/swap.js';
import { disposeItem, disposeWorn } from '../engine/dispose.js';
import { searchBestComposition } from '../engine/search.js';
import { RATE_CAPS, RATE_CAP_NOTE } from '../engine/monitor.js';
import { mountAssist } from './assist.js';

// ---------- 常量 ----------

let SCHOOLS = [];      // [[id, name]] 流派清单，来自 manifest.流派；接流派 = manifest 加一条，零代码
let BUILD_PACKS = [];  // [{ id, 流派, 分支 }] build 包（=技能轴）清单；分支归属单点声明，不靠文件名解析
// 槽位模型（用户定稿：武器不分左右，一个流派只是携带两把特定武器）：
//   装备件 slot = '武器' + weaponType（背包武器可穿任意一个武器位）；对比按类型（剑只比剑）。
//   equipped 存储键用 武器1/武器2 —— 两个物理武器位，无左右含义（旧档 左武器/右武器 在读取时迁移）。
// 纸娃娃槽位列（对齐燕小叽站点 HomeEquipmentLoadoutPanel）：每列两个槽位，武器列上大下小（6fr:4fr），
//   槽位尺寸（用户定稿 2026-10-26，比例单位 u，间距统一 100u；写法统一为「宽×长」）：
//     环/佩/武库 400×400、武器与弓玦 400×700、冠胄/胸甲/胫甲/腕甲 400×550（竖版）；
//   五列同宽（400）⇒ 等分；列高 1100u ⇒ 自然等高；行高由槽位 aspect-ratio 决定（不再写死 fr）。
const SLOT_COLUMNS = [
  { slots: ['武器1', '环'] },
  { slots: ['武器2', '佩'] },
  { slots: ['冠胄', '胫甲'] },
  { slots: ['胸甲', '腕甲'] },
];
const EQUIP_KEYS = SLOT_COLUMNS.flatMap((c) => c.slots); // equipped 存储键（8 个物理位）
const WEAPON_KEYS = ['武器1', '武器2'];             // 两个武器物理位（无左右含义）
// 槽位/模态框图片素材（燕小叽站点同款，已本地化到 assets/img/；路径映射在 version.json「界面图片」）
const IMG_BASE = 'assets/img/';
const slotImg = (rel) => (rel ? IMG_BASE + rel : '');
/**
 * 写进 CSS `url('…')` 的资源要走绝对地址 —— 这是纯静态托管（尤其 /<repo>/ 子路径）的唯一坑。
 * 原因：<img src="assets/…"> 按**文档**解析，但内联 style 里声明的 url() 会被浏览器
 * 按「消费它的那条规则」所在样式表（web/studio.css）重新解析，相对路径会变成 web/assets/… → 404。
 * 合并成一次计算，避免每个调用点各自 new URL。测试桩没有 document.baseURI 时退化为相对路径。
 */
const CSS_DIR = (() => {
  try { return new URL('.', document.baseURI).href; } catch { return ''; }
})();
const cssUrl = (rel) => (rel ? `url('${CSS_DIR}${rel}')` : '');
/**
 * 装备图：武器按类型、防具/饰品按部位；无映射（新类型未补图）时返回空，由调用方回退 glyph。
 * 两套素材（用户定稿 2026-10-26）：装备槽用「装备槽武器图标素材」（竖版 360×770 立绘），
 * 背包用「背包内武器图标素材」（方版 512×512）；其余部位两处共用同一张。
 * key 既可以是存储键（武器1/武器2）也可以是部位值（武器）——背包件只有部位值，两种都要认。
 */
function equipImageOf(cfg, key, weaponType) {
  const c = cfg || {};
  return (isWeaponKey(key) || isWeaponSlot(key)) ? slotImg(c['武器']?.[weaponType]) : slotImg(c[key]);
}
function slotImageOf(key, weaponType) {
  return equipImageOf(state.version.界面图片?.槽位图, key, weaponType);
}
/** 背包件图（背包容器的武器用方版素材） */
function bagImageOf(piece) {
  return equipImageOf(state.version.界面图片?.背包图, piece.slot, piece.weaponType);
}
/** 心法 → {品质, 流派} 反查表（唯一来源：version.json「界面图片.心法品质 / 心法所属流派」）。
 *  品质分 金/蓝/紫 三档（决定卡底色），流派 12 组（11 流派 + 通用，决定卡上的流派横幅）。
 *  按 version 对象缓存，切赛季/换版本自动失效。 */
let mindMetaCache = null;
function mindMeta() {
  if (mindMetaCache && mindMetaCache.version === state.version) return mindMetaCache.byName;
  const ip = state.version.界面图片 || {};
  const byName = new Map();
  for (const [q, list] of Object.entries(ip['心法品质'] || {})) {
    for (const n of list || []) byName.set(n, { quality: q });
  }
  for (const [sid, list] of Object.entries(ip['心法所属流派'] || {})) {
    for (const n of list || []) {
      const e = byName.get(n) || {};
      e.school = sid;
      byName.set(n, e);
    }
  }
  mindMetaCache = { version: state.version, byName };
  return byName;
}
/** 流派横幅（254×68 的「流派·名」条幅）；缺图的流派返回 ''（如破竹·樽，官方素材集没有） */
function schoolBannerOf(schoolId) {
  if (!schoolId) return '';
  return slotImg(state.version.界面图片?.['流派横幅']?.[schoolId]);
}
/** 心法图标（2026-10-30 换官方素材，用户定稿口径：图标与卡底官方是分离的两张图，运行时组合）。
 *  - card=true（口径卡里的四格）：卡底（`心法卡底`，300×476 竖版，**按品质金/蓝/紫分色**）
 *    + 白描图标 + 流派横幅 + 心法名，四层拼成一张卡；名字用文字渲染而非烧进图里 →
 *    任意尺寸都清晰、窄栏可等比缩；
 *  - card=false（选择弹窗的小图标）：只出图标本身（名字由 `.st-picker-opt .n` 另外给，避免重复）。
 *  尺寸走 CSS 变量 --mind-w（宽度），高按卡底 300:476 比例由 CSS 算，不再写内联 px。
 *  ⚠ size 不传 = **不写内联**，交给容器（`.st-kj-row`）按面板宽度反解的 --mind-w 继承 ——
 *    心法卡（第二十版独立成行）必须走这条，否则拿到的是弹窗小图的固定内联尺寸而非
 *    由 .st-minds 面板宽反解的 --mind-w，四张卡就不会等比铺满整行。 */
function mindTileHtml(key, size, opts = {}) {
  const { card = false } = opts;
  const ip = state.version.界面图片 || {};
  const icon = key ? slotImg(ip['心法图']?.[key]) : '';
  const style = size ? `--mind-w:${size}px` : '';
  if (card) {
    const meta = key ? mindMeta().get(key) : null;
    const bg = slotImg(ip['心法卡底']?.[meta?.quality] || ip['心法卡底']?.['紫']);
    const bgVar = bg ? `--mind-bg:${cssUrl(bg)}` : '';
    const styleAttr = [style, bgVar].filter(Boolean).join(';');
    const banner = schoolBannerOf(meta?.school);
    // 官方没有横幅的流派（破竹·樽：原始数据里 liupai_pic_big_url 就是空串，游戏里也不显示）→ 留空。
    // 但仍占一个同比例的空位，四张卡的图标/名字才不会一高一低。
    const tag = banner
      ? `<img class="st-mind-tag" src="${banner}" alt="">`
      : (meta?.school ? '<span class="st-mind-tag st-mind-tag--blank"></span>' : '');
    return `<span class="st-mind-card${key ? '' : ' st-mind-card--empty'}"${meta?.quality ? ` data-q="${meta.quality}"` : ''} style="${styleAttr}">`
      + (icon ? `<img class="st-mind-icon" src="${icon}" alt="">` : '<span class="st-mind-plus">＋</span>')
      // 顺序照官方卡构图：图标（顶部尖角内）→ 流派横幅 → 心法名（压底）
      + tag
      + (key ? `<span class="st-mind-cap">${escapeHtml(key)}</span>` : '')
      + '</span>';
  }
  if (icon) {
    return `<img class="st-mind-img" src="${icon}" alt="${escapeHtml(key || '')}" loading="lazy" style="${style}">`;
  }
  return `<div class="st-mind-tile" style="${style}">${escapeHtml(key || '')}</div>`;
}
/** 流派清单（按 version.json「界面图片.流派顺序」展示；未列入的排末尾，用户定稿顺序） */
function schoolList() {
  const rank = new Map((state.version.界面图片?.['流派顺序'] || []).map((id, i) => [id, i]));
  return [...SCHOOLS].sort((a, b) => (rank.get(a[0]) ?? 99) - (rank.get(b[0]) ?? 99));
}
/**
 * 当前流派的两把武器（唯一来源：build.weapon_categories）。
 * ⚠️ 必须按「是否在武器类型清单中」过滤，不能靠 slice(1,3) 截位置：
 *   - Excel 提取的包首项是「通用增伤」，slice(1,3) 恰好取到两把武器；
 *   - 燕小叽站点提取的包（如 lieshijun.chuntang.115.3.0）**没有通用增伤首项**，
 *     首项就是武器，slice(1,3) 会取到「奇术」，导致 derivePrescription 判「未知武器类型」→
 *     整条方案变 infeasible（界面显示「无模板」）。过滤法对两种包格式都成立。
 */
function currentWeaponLabels() {
  const wt = new Set(weaponTypesOf(state.affixes));
  return (state.data?.build?.weapon_categories || []).map((c) => c.label).filter((l) => wt.has(l)).slice(0, 2);
}
// 位置名（用户定稿）：宫=初始位，商/角/徵/羽=四条调律位
const POS_LABELS = ['宫', '商', '角', '徵', '羽'];
const posLabel = (kind, idx = null) => (kind === '初始' ? '宫' : POS_LABELS[idx + 1]);
const posLabelOfUnit = (u) => (u?.position === 'initial' ? '宫' : POS_LABELS[(u?.index ?? 0) + 1]);

const WEAPON_SLOT = '武器';                        // 武器件的部位值
const ARMOR_SLOTS = ['环', '佩', '冠胄', '胸甲', '胫甲', '腕甲'];
const SLOTS = [WEAPON_SLOT, ...ARMOR_SLOTS];       // 录入表单/引擎语境的部位清单
const 攻具 = [WEAPON_SLOT, '环', '佩'];
const isWeaponKey = (key) => WEAPON_KEYS.includes(key);
// 武器类型清单改为派生（单一来源 = affixes 的"指定武学增伤包括"，盘点 §2.2 #3）
const WEAPON_TYPES = () => weaponTypesOf(state.affixes);
const FLOWS_API = (prefix) => `api/template/${encodeURIComponent(prefix)}`;
const STORAGE_KEY = 'yysls-evaluator-v1'; // 键名沿用历史值（改名=清空玩家装备库）
const TIER_CLASS = { 天: 'tian', 地: 'di', 玄: 'xuan', 黄: 'huang' };
// 品阶排序权重（用户定稿 2026-10-30：背包恒按当前方案的品阶排序，天→地→玄→黄）
const TIER_RANK = { 天: 0, 地: 1, 玄: 2, 黄: 3 };
const TIER_UNKNOWN_RANK = 9;

// ---------- 草稿（录入表单数据） ----------

/**
 * 定音槽的固定值（2026-11-02 玩家定稿：玩家不再录入定音）。
 *
 * 定音对流派是定死的、可随意重掷（engine/panel.js 同口径：名字不参与判断、数值才是事实）。
 * 让玩家填只会填错 —— 背包里一件装备带着 A 方案的防具定音名，穿上到 B 方案时按名字参与计算，
 * DPS 直接错，而玩家完全看不出来。所以改成：**不录入、不显示、穿戴时按所在槽位自动取值**。
 *
 *   攻具四件（武器1/武器2/环/佩）= 方案的攻具定音（本工具所有流派都是「外功穿透」）
 *   防具四件（冠胄/胸甲/胫甲/腕甲）= 方案的防具定音，数值走「技能定音」区间（quota.js 同口径）
 *
 * 数值取区间**上限**：这是这件装备的定音能到的最好值，不随玩家实际掷出的低值打折。
 */
function dingyinOf(slotKey) {
  const flow = currentFlow();
  const A = state.affixes;
  const isAtk = ATK_GEAR_KEYS.includes(slotKey) || slotKey === WEAPON_SLOT;
  const name = isAtk
    ? (flow?.攻具定音 || '外功穿透')
    : (flow?.防具定音 || '技能定音');
  const r = lookupRange(A, name)
    || lookupRange(A, isAtk ? '外功穿透' : '技能定音');
  return { 属性: name, 数值: r?.max ?? (isAtk ? 19.4 : 0.106) };
}

/** 给一件装备补上它所在槽位的定音槽（不写回 pool：定音随方案变，存起来就会脏） */
function withDingyin(piece, slotKey) {
  if (!piece) return piece;
  return { ...piece, 定音: dingyinOf(slotKey ?? piece.slot) };
}

function newDraft(slot = WEAPON_SLOT, weaponType = '', flow = null, affixData = null) {
  return {
    slot, weaponType, 承音: false,
    初始: { 属性: '', 数值: null },
    调律: [0, 1, 2, 3].map(() => ({ 属性: '', 数值: null })),
  };
}

/** 已有装备 → 草稿（「调律」按钮 = 改这件装备）：原样读回，定音沿用原值不回落方案默认 */
function draftFromPiece(piece) {
  return {
    slot: piece.slot,
    weaponType: piece.weaponType || '',
    承音: !!piece.承音,
    初始: { 属性: piece.初始?.属性 || '', 数值: piece.初始?.数值 ?? null },
    调律: [0, 1, 2, 3].map((i) => {
      const a = piece.调律?.[i] || {};
      const out = { 属性: a.属性 || '', 数值: a.数值 ?? null };
      if (a.转律) out.转律 = true;
      return out;
    }),
  };
}

// ---------- 状态 ----------

// 领域三层（用户定稿 2026-10-22）：流派 ⊃ 分支（=技能轴/build 包）⊃ 方案（词条分配口径）
// 多角色（用户定稿 2026-10-30）：一个玩家可能有多个账号/角色，**装备与口径按角色隔离、互不互通**。
//   角色快照 = { name, school, branch, plan, selections, equipped, backpack }，切角色 = 整体换一套。
const state = {
  charId: null,         // 当前角色 id
  charName: '',         // 当前角色名（顶栏按钮 / 角色卡显示）
  roster: {},           // { [charId]: 角色快照 }（含当前角色；save 时用 state 覆盖自己那份）
  school: null,         // 流派 id（lieshijun / pozhufeng …）
  branch: null,         // 分支 id（无分支的流派为 null）；分支 = 打法 = 技能轴
  plan: null,           // 方案 id（dawai / xiaowai）；方案 = 剩余词条怎么分
  meta: null,           // { name, 分支: { id: { name } } }，来自 data/template/<流派>/_meta.json
  data: null,           // { build, skills, effects }
  version: null,
  affixes: null,
  flows: null,          // { school, flows: [flow,...] } | null（流派无模板时为 null）
  buildId: null,        // 由 (流派, 分支) 解析出的 build 包 id；null = 该流派无任何技能轴
  buildStatus: 'missing', // exact=分支自带轴 / borrowed=借用同流派其它分支的轴 / missing=无轴可用
  borrowedBranch: null, // borrowed 时：借用的轴所属分支 id
  prescription: null,   // derivePrescription 结果（仅当前流）
  graduate: null,       // computeGraduateDps 结果；null = 回退 build 包 Excel I16
  selections: { 弓玦: '', 装备套装: '', 心法: ['', '', '', ''], 武库: '' },
  // 装备库（用户定稿 2026-10-30）：**pool 是该角色唯一的装备库**（按 uid 唯一），
  //   equipped / backpack 都是它的视图——
  //   equipped = 当前配置的 loadout 指向的件；backpack = pool 里没被当前配置穿上的件。
  //   每个「配置」（流派+分支+方案）存一份 loadout ⇒ 切方案自动换装，没配过的方案槽位是空的。
  pool: [],             // [piece + uid] 该角色全部装备件（唯一来源）
  loadouts: {},         // { [configKey]: { [slotKey]: uid } } 各配置的已穿戴
  equipped: {},         // 派生视图：{ [slot]: piece }（由 pool + 当前 loadout 重建，勿直接改）
  backpack: [],         // 派生视图：[piece + uid] 当前配置未穿戴的件
  // 背包筛选（用户定稿 2026-10-30）：点已穿戴槽 = 先把背包筛到同部位（第一次点），
  //   再点同一槽才开详情弹窗；null = 不筛选（显示全部，按品阶排序）。值为 equipped 存储键。
  bagFilter: null,
  selected: null,       // { kind:'equipped', slot } | { kind:'backpack', uid } | null
  editing: false,       // 处于录入表单模式（弹窗）
  picker: null,         // 弓玦/武库特殊槽弹出的选择模态框草稿 { 装备套装, 弓玦, 武库 }（站点同款）
  mindPicker: null,     // 心法图标条弹出的选择模态框草稿 { active, minds[4] }（站点 TimelineMindPickerModal 同款）
  schoolPicker: null,   // 流派选择模态框：null=关闭 | { school:null }=选流派 | { school:id }=选该流派的分支·方案
  composition: false,   // 组合总览模态框（2026-11-02 从右栏常驻挪到「背包·组合」按钮 + 助手提示）
  switching: false,     // 正在切配置（选分支+方案会连跑两次 render，期间助手不许主动开口）
  configPicker: false,  // 配置（分支·方案）菜单展开中（2026-10-30 第六版：横幅下方原地展开，不再用模态框）
  charPicker: null,     // 角色管理模态框：{ mode:'list'|'rename'|'delete', target, draftName }
  draft: newDraft(),
  editTarget: null,     // 正在修改的装备 { kind:'equipped', slot } | { kind:'backpack', uid }；null = 新录入
  uidSeq: 1,
  overall: null,        // 每次渲染时计算的整体视图（栏4 毕业率/配额/属性面板的来源）
  search: null,         // 组合搜索缓存 { key, result }（key 变了才重算，避免每次渲染都跑）
};

const $ = (sel) => document.querySelector(sel);
const mainEl = $('#app');         // 两栏容器：统一扫 [data-sel-kind]/[data-act] 绑定事件（栏位会变，元素不会消失）
const leftEl = $('#st-left');     // 栏1：口径 + 已穿戴槽位
const centerEl = $('#st-center'); // 栏2：背包
const rightEl = $('#st-right');   // 栏4：毕业率 + 词条配额 + 属性面板
const modalEl = $('#st-modal');   // 弹窗宿主：录入装备 / 装备详情（常驻详情区已取消）
let assist = null;                // 助手实例（mountAssist 的返回值；init 完成后才有）
const boot = (text, cls) => window.__bootStatus && window.__bootStatus(text, cls);

// ---------- 通用工具 ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function optionList(values, current, labelOf) {
  const opt = (v) => `<option value="${escapeHtml(v)}" ${v === current ? 'selected' : ''}>${escapeHtml(labelOf ? labelOf(v) : v)}</option>`;
  return `<option value="" ${!current ? 'selected' : ''}>— 未选 —</option>` + values.map(opt).join('');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadBuildData(buildId) {
  // 目录取 manifest 声明的流派，而非从文件名猜（分支归属是数据的事）
  const pack = BUILD_PACKS.find((p) => p.id === buildId);
  const dir = `data/schools/${pack?.流派 || buildId.split('.')[0]}`;
  const [build, skillsJson, effectsJson] = await Promise.all([
    fetchJson(`${dir}/${buildId}.json`),
    fetchJson(`${dir}/${buildId}.skills.json`),
    fetchJson(`${dir}/${buildId}.effects.json`),
  ]);
  return { build, skills: skillsJson.skills, effects: effectsJson.effects };
}

/**
 * build 包（=技能轴）解析：分支 → 包。
 * 精确匹配该分支的包；无则借用同流派其它分支的包（临时举措，UI 明确提示）；
 * 该流派一个包都没有 → missing（DPS/面板不可用，仅配额方案可展示）。
 */
function resolveBuild(school, branch) {
  const b = branch ?? null;
  const exact = BUILD_PACKS.find((p) => p.流派 === school && (p.分支 ?? null) === b);
  if (exact) return { id: exact.id, status: 'exact', borrowedBranch: null };
  const any = BUILD_PACKS.find((p) => p.流派 === school);
  if (any) return { id: any.id, status: 'borrowed', borrowedBranch: any.分支 ?? null };
  return { id: null, status: 'missing', borrowedBranch: null };
}

/**
 * 分支模板发现：文件名主干即 flowId。
 * 清单来源两级：① 静态索引 data/template/index.json（纯静态托管唯一可行路径，
 * 由 tools/build_static_index.js 生成，新增方案后跑 npm run build:index）；
 * ② 回退本地 serve.js 的 api/template/ 端点（静态托管下 404，被 catch 掉）。
 * 注意：所有取数路径都是相对文档根（index.html 所在目录）的，勿写成 /data/… 绝对路径。
 */
async function flowListing(prefix) {
  try {
    const idx = await fetchJson('data/template/index.json');
    if (idx?.prefix?.[prefix]) return { files: idx.prefix[prefix] };
  } catch { /* 未生成索引 → 走服务端回退 */ }
  return fetchJson(FLOWS_API(prefix));
}

async function loadFlows(school) {
  const listing = await flowListing(school);
  const flows = [];
  for (const f of (listing.files || []).filter((x) => !x.startsWith('_'))) {
    const doc = await fetchJson(`data/template/${school}/${f}`);
    // 分支/方案为方案文件自带字段；flowId 仍拼成「分支.方案」（存档键沿用，勿改格式）
    const branch = doc.分支 ?? null;
    const plan = doc.方案 ?? null;
    flows.push({ ...doc, branch, plan, flowId: branch ? `${branch}.${plan}` : String(plan ?? '') });
  }
  return { school, flows };
}

/** 各流派元数据缓存：`state.meta` 只有**当前**流派，跨方案的名字要能同步查，
 *  否则「这件正被「鸣金虹·dawai」使用」会把分支退化成拼音 id（真实踩过）。 */
const META_BY_SCHOOL = {};

/** 流派元数据（分支中文名等）；缺文件时降级为仅 id */
async function loadSchoolMeta(school) {
  let m;
  try { m = await fetchJson(`data/template/${school}/_meta.json`); } catch { m = { name: school }; }
  META_BY_SCHOOL[school] = m;
  return m;
}

/** 预热全部流派的 _meta.json（11 份小文件）：背包卡的「他方案在用」悬停要同步给中文名 */
async function ensureAllMetas() {
  await Promise.all((SCHOOLS || []).map(async ([id]) => {
    if (META_BY_SCHOOL[id]) return;
    await loadSchoolMeta(id);
  }));
}

// ---------- 词条池 / 区间（与评价器同款） ----------

const isWeaponSlot = (slot) => slot === WEAPON_SLOT;

function initialPool(slot) {
  const g = state.affixes.词条池['初始词条池'];
  return g[isWeaponSlot(slot) ? '武器' : slot] || [];
}

/**
 * 部位调律词条下拉选项。
 * 武器池里的「指定武学增伤」是**伞形占位项**：选定武器类型后须替换成该类型的具体词条
 * （如 双刀武学增伤），占位项本身不可选——它与具体词条同时在下拉里出现会让玩家选到
 * 一个不存在的词条（真实装备上只会有「双刀武学增伤」，不会有「指定武学增伤」）。
 * 未选武器类型时占位项也一并剔除（无从展开）。
 */
function lawPool(slot, weaponType) {
  const pools = state.affixes.词条池['调律词条池'];
  if (isWeaponSlot(slot)) {
    const base = pools['武器'] || pools['武器的调律词条池'] || [];
    const spec = `${weaponType}武学增伤`;
    const known = pools['指定武学增伤包括'] || [];
    const legal = weaponType && known.includes(spec);
    const out = [];
    let replaced = false;
    for (const a of base) {
      if (a === '指定武学增伤') { if (legal) { out.push(spec); replaced = true; } continue; }
      out.push(a);
    }
    // 占位项不在池中（数据结构变更）时兜底补在末尾，避免具体指定增整个消失
    if (legal && !replaced) out.push(spec);
    return out;
  }
  const key = slot === '冠胄' || slot === '胸甲' ? '冠胄和胸甲的调律词条池'
    : slot === '环' || slot === '佩' ? '环和佩的调律词条池'
      : '胫甲和腕甲的调律词条池';
  return pools[key] || [];
}

function dingyinPool(slot) {
  if (isWeaponSlot(slot) || slot === '环' || slot === '佩') {
    return state.affixes.词条池['定音词条池']['武器、环、佩的定音词条池'] || [];
  }
  return state.affixes.护甲定音词条 || [];
}

/** 词条名 → 数值区间（委托 engine/quota.js 的 lookupAffixRange 单一来源实现） */
function lookupRange(affixData, name) {
  return lookupAffixRange(affixData, name);
}

function isPercentAffix(name) {
  const r = lookupRange(state.affixes, name);
  if (r && r.max != null) return r.max <= 1;
  return /率$|增伤$|增效$|增疗$/.test(name || '');
}

function placeholderFor(name, isChengyin) {
  const r = lookupRange(state.affixes, name);
  if (!r || r.max == null) return name ? '区间待补' : '';
  const pct = r.max <= 1;
  const fmt = (x) => (pct ? +(x * 100).toFixed(4) : x);
  if (isChengyin && r.承音 != null) return `承音≤${fmt(r.承音)}`;
  return `${fmt(r.min)}~${fmt(r.max)}`;
}

// ---------- 展示格式化 ----------

const pctFmt = (x, digits = 2) => `${(x * 100).toFixed(digits)}%`;

function fmtAffixValue(name, v) {
  if (v == null) return '';
  return isPercentAffix(name) ? `+${(v * 100).toFixed(2)}%` : `+${+(+v).toFixed(2)}`;
}

/** 属性面板（栏4 底部）的数值格式化：比率/增伤/定音用百分号，攻击与五维用数值 */
function fmtStatValue(key, v) {
  if (v == null) return '—';
  if (/率$|增伤$|增效$|加成$|定音$/.test(key) && Math.abs(v) <= 1) return pctFmt(v);
  if (key === '气血最大值') return String(Math.round(v));
  return (+v.toFixed(1)).toString();
}

// ---------- 数据与口径 ----------

/** flowId = 「分支.方案」（存档与测试沿用该格式，勿改） */
const flowIdOf = (branch, plan) => (branch ? `${branch}.${plan}` : String(plan ?? ''));

/** 当前方案 = (分支, 方案) 命中的那一条；找不到则退回第一条（数据缺项时也不至于全空） */
function currentFlow() {
  if (!state.flows) return null;
  return state.flows.flows.find((f) => (f.branch ?? null) === (state.branch ?? null) && f.plan === state.plan)
    || state.flows.flows[0] || null;
}

/**
 * 已穿戴八件（引擎输入的唯一出口）。
 * 这里**注入定音**：pool 里不存定音（定音随方案走），凡是把装备喂给引擎的地方都从这里取，
 * 于是 panel / dispose / 组合搜索拿到的定音恒等于当前方案该有的那个。
 */
function equippedList() {
  return EQUIP_KEYS.map((k) => (state.equipped[k] ? withDingyin(state.equipped[k], k) : null))
    .filter(Boolean);
}

/** 同类已穿戴装备：非武器按部位；武器按类型（不分左右，用户定稿） */
function comparableEquipped(piece) {
  if (!piece) return null;
  if (piece.slot !== WEAPON_SLOT) return state.equipped[piece.slot] || null;
  return WEAPON_KEYS.map((k) => state.equipped[k])
    .find((g) => g?.slot === WEAPON_SLOT && String(g?.weaponType ?? '') === String(piece.weaponType ?? '')) || null;
}

function wornWeaponTypes() {
  return WEAPON_KEYS.map((k) => state.equipped[k]?.weaponType).filter(Boolean).join('/') || '（无）';
}

function backpackByUid(uid) {
  return poolByUid(uid); // 装备件只存在于 pool（背包只是"当前配置没穿"的视图）
}

/** 生成不与装备库现有件冲突的 uid（装备件只存在于 pool，uid 全局唯一） */
function nextUid() {
  const used = new Set(state.pool.map((b) => b.uid));
  let n = state.uidSeq;
  let uid = `b${n}`;
  while (used.has(uid)) { n += 1; uid = `b${n}`; }
  state.uidSeq = n + 1;
  return uid;
}

// ---------- 装备库与配置（用户定稿 2026-10-30）----------
// 「配置」= 流派 + 分支 + 方案（如 鸣金虹·大外流 / 裂石钧·纯唐轴·小外流）。
//   每个配置各存一份 **loadout（8 个槽位 → 装备 uid）** ⇒ 切方案自动换装；
//   没配过的配置切过去槽位是空的（不是"装备丢了"）。
//   装备件本身只存在于角色的 pool 里（按 uid 唯一），不会被任何配置独占——
//   所以 A 配置穿过的件，切到 B 配置时照样在背包里能看见、能穿上。

/** 配置键：`流派|分支|方案`（用 | 分隔：流派 id 里有点号，别用 . 拼） */
function configKeyOf(school, branch, plan) {
  return [school ?? '', branch ?? '', plan ?? ''].join('|');
}
const currentConfigKey = () => configKeyOf(state.school, state.branch, state.plan);

/** 当前配置的 loadout（只读用途；要改请走 actions，改完必须 rebuildGear） */
function currentLoadout() {
  return state.loadouts[currentConfigKey()] || {};
}

function poolByUid(uid) {
  return state.pool.find((p) => p.uid === uid) || null;
}

/**
 * 由 pool + 当前配置的 loadout 重建两个视图：
 *   equipped = loadout 指向的件；backpack = pool 里没被本配置穿上的件。
 * 切流派/分支/方案、以及任何装备增删后都必须调一次（唯一入口，勿各处手改 equipped/backpack）。
 */
function rebuildGear() {
  const load = currentLoadout();
  const equipped = {};
  const used = new Set();
  for (const key of EQUIP_KEYS) {
    const uid = load[key];
    const p = uid ? poolByUid(uid) : null;
    if (p) { equipped[key] = p; used.add(p.uid); }
  }
  state.equipped = equipped;
  state.backpack = state.pool.filter((p) => !used.has(p.uid));
}

/** 写当前配置的 loadout（传 uid=null 即脱下该槽） */
function setLoadoutSlot(key, uid) {
  const k = currentConfigKey();
  if (!state.loadouts[k]) state.loadouts[k] = {};
  if (uid) state.loadouts[k][key] = uid;
  else delete state.loadouts[k][key];
}

/** 从装备库彻底删一件（同时从所有配置的 loadout 里摘掉，避免留下悬空 uid） */
function removePieceFromPool(uid) {
  state.pool = state.pool.filter((p) => p.uid !== uid);
  for (const [k, load] of Object.entries(state.loadouts)) {
    for (const [slot, suid] of Object.entries(load)) if (suid === uid) delete state.loadouts[k][slot];
  }
}

/** 已配置的「装备套」数量（角色卡上展示：这个角色配了几套） */
function loadoutCount() {
  return Object.values(state.loadouts).filter((l) => Object.keys(l || {}).length).length;
}

/** 配置键 → 可读名（鸣金虹·纯唐轴·大外流；缺段自动跳过） */
function configLabelOf(key) {
  const [school, branch, plan] = String(key).split('|');
  // ① 跨方案条目（XFLOW）的 label 由**各自流派**的 _meta 生成，最准，直接用。
  //    注意 key 格式不同：loadout 是 `流派|分支|方案`，XFLOW 是 `流派.分支.方案`。
  const hit = XFLOW.entries?.find((e) => e.key === `${school}.${flowIdOf(branch || null, plan || null)}`);
  if (hit) return hit.label;
  // ② 还没预热到：用该流派自己的 meta 查分支中文名（不是当前流派的 state.meta）
  const meta = school === state.school ? state.meta : META_BY_SCHOOL[school];
  const bn = branch ? (meta?.分支?.[branch]?.name || branchLabel(branch)) : '';
  const pn = PLAN_CN[plan] || planLabel(plan) || '';
  return [meta?.name || schoolNameOf(school), bn, pn].filter(Boolean).join('·');
}

/** 穿着该件的**其他**配置（当前配置除外）——背包卡「他方案在用」标识的数据源。
 *  返回 [{ key, school, label }]：school 用来取该配置所属流派的印章（第二十九版），
 *  label 是「鸣金虹·纯唐轴·大外流」这样的可读名（悬停 title 列出全部）。 */
function configsUsingPiece(uid) {
  const cur = currentConfigKey();
  return Object.entries(state.loadouts)
    .filter(([k, load]) => k !== cur && Object.values(load || {}).includes(uid))
    .map(([k]) => ({ key: k, school: String(k).split('|')[0], label: configLabelOf(k) }));
}

// ---------- 多角色（用户定稿 2026-10-30）----------
// 一个玩家可能有多个账号/角色：**装备、流派与口径都按角色独立保存，互不互通**。
// 角色快照 = { name, school, branch, plan, selections, equipped, backpack }，切角色 = 整体换一套。

const DEFAULT_CHAR_NAME = '默认角色';

function blankSelections() {
  return { 弓玦: '', 装备套装: '', 防具套装: '', 心法: ['', '', '', ''], 武库: '' };
}

/** 口径是否还是空的（新角色用它判断要不要套方案默认） */
function isEmptySelections(sel) {
  if (!sel) return true;
  const s = { ...blankSelections(), ...sel };
  return !s.弓玦 && !s.装备套装 && !s.防具套装 && !s.武库 && [0, 1, 2, 3].every((i) => !s.心法[i]);
}

function blankChar(name, school = null) {
  return { name, school, branch: null, plan: null, selections: blankSelections(), pool: [], loadouts: {} };
}

/** 角色归档归一：补默认字段 + 跑旧档迁移（左/右武器、指定增占位、调律去重、装备入库） */
function normalizeChar(c) {
  const fid = c.flowId ?? null;
  const dot = fid ? String(fid).indexOf('.') : -1;
  const sel = blankSelections();
  if (c.selections) {
    for (const k of ['弓玦', '装备套装', '防具套装', '武库']) if (typeof c.selections[k] === 'string') sel[k] = c.selections[k];
    if (Array.isArray(c.selections.心法)) sel.心法 = [0, 1, 2, 3].map((i) => c.selections.心法[i] || '');
  }
  // 装备库（v3）：旧档（v1/v2）的 equipped + backpack 合并进 pool，并给当前配置补一份 loadout。
  // ⚠ 顺序要害：**先做存储键归一（左/右武器 → 武器1/武器2）再入库**——
  //   否则 loadout 里记的是「右武器」这种旧键，rebuildGear 按 EQUIP_KEYS 读不到 ⇒ 装备整批丢失。
  let pool = Array.isArray(c.pool) ? c.pool.map((p) => ({ ...p })) : null;
  const loadouts = {};
  for (const [k, v] of Object.entries(c.loadouts || {})) loadouts[k] = { ...(v || {}) };
  const equipped = { ...(c.equipped || {}) };
  for (const oldKey of ['左武器', '右武器']) {
    if (!equipped[oldKey]) continue;
    const nk = oldKey === '左武器' ? '武器1' : '武器2';
    if (!equipped[nk]) equipped[nk] = equipped[oldKey];
    delete equipped[oldKey];
  }
  if (!pool) {
    pool = [];
    const bag = Array.isArray(c.backpack) ? c.backpack : [];
    // uid 先全量扫一遍再分配，避免给无 uid 的已穿戴件发到背包件已占用的号
    let seq = 0;
    const bump = (p) => { const m = /^b(\d+)$/.exec(p?.uid || ''); if (m) seq = Math.max(seq, +m[1]); };
    [...Object.values(equipped), ...bag].forEach(bump);
    const take = (p) => {
      if (p.uid) return p.uid;
      seq += 1;
      return `b${seq}`;
    };
    const load = {};
    for (const [slot, p] of Object.entries(equipped)) {
      if (!p) continue;
      const uid = take(p);
      pool.push({ ...p, uid });
      load[slot] = uid;
    }
    for (const p of bag) pool.push({ ...p, uid: take(p) });
    const key = configKeyOf(c.school || String(c.buildId || '').split('.')[0] || null,
      c.branch ?? (dot > 0 ? String(fid).slice(0, dot) : null),
      c.plan ?? (dot > 0 ? String(fid).slice(dot + 1) : fid));
    if (Object.keys(load).length) loadouts[key] = load;
  }
  const out = {
    name: c.name || DEFAULT_CHAR_NAME,
    school: c.school || String(c.buildId || '').split('.')[0] || null,
    branch: c.branch ?? (dot > 0 ? String(fid).slice(0, dot) : null),
    plan: c.plan ?? (dot > 0 ? String(fid).slice(dot + 1) : fid),
    selections: sel,
    pool,
    loadouts,
  };
  // 迁移：装备件的部位值 左武器/右武器 → 武器
  const normalizeSlot = (p) => { if (p && (p.slot === '左武器' || p.slot === '右武器')) p.slot = WEAPON_SLOT; };
  // 迁移：伞形占位项「指定武学增伤」归一为本件武器类型的具体词条
  const normalizeSpec = (p) => {
    if (!p || p.slot !== WEAPON_SLOT) return;
    for (const a of [p.初始, ...(p.调律 || [])]) {
      if (!a || a.属性 !== '指定武学增伤') continue;
      a.属性 = p.weaponType ? `${p.weaponType}武学增伤` : '';
      if (!a.属性) a.数值 = null;
    }
  };
  // 迁移：四条调律互不重复（保留首次出现，其余清空）
  const normalizeDup = (p) => {
    if (!p || !Array.isArray(p.调律)) return;
    const seen = new Set();
    for (const a of p.调律) {
      if (!a || !a.属性) continue;
      if (seen.has(a.属性)) { a.属性 = ''; a.数值 = null; } else seen.add(a.属性);
    }
  };
  const migrate = (p) => { normalizeSlot(p); normalizeSpec(p); normalizeDup(p); };
  out.pool.forEach(migrate);
  return out;
}

/** 读存档 → { id, roster }；旧档（v1 顶层装备）就地升级为单角色「默认角色」 */
function loadRoster() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
  if (saved?.角色 && Object.keys(saved.角色).length) {
    const roster = {};
    for (const [id, c] of Object.entries(saved.角色)) roster[id] = normalizeChar(c);
    const cur = roster[saved.当前角色] ? saved.当前角色 : Object.keys(roster)[0];
    return { id: cur, roster };
  }
  if (saved && (saved.school || saved.buildId || saved.equipped || saved.backpack)) {
    return { id: 'c1', roster: { c1: normalizeChar({ ...saved, name: saved.name || DEFAULT_CHAR_NAME }) } };
  }
  return { id: 'c1', roster: { c1: blankChar(DEFAULT_CHAR_NAME) } };
}

function charList() {
  return Object.entries(state.roster).map(([id, c]) => ({ id, ...c }));
}

/** 角色装备统计（装备库件数 / 配了几套），用于角色卡与删除确认 */
function charCountOf(c) {
  const pool = Array.isArray(c?.pool) ? c.pool : null;
  if (pool) {
    return { total: pool.length, sets: Object.values(c.loadouts || {}).filter((l) => Object.keys(l || {}).length).length };
  }
  // 旧形状（v1/v2 未升级）兜底
  const worn = Object.values(c?.equipped || {}).filter(Boolean).length;
  const bag = (c?.backpack || []).length;
  return { total: worn + bag, sets: worn ? 1 : 0 };
}

function schoolNameOf(id) {
  return SCHOOLS.find(([s]) => s === id)?.[1] || id || '未选流派';
}

function nextCharId() {
  let n = Object.keys(state.roster).length + 1;
  while (state.roster[`c${n}`]) n += 1;
  return `c${n}`;
}

/** uid 计数器对齐当前角色的装备库存量，避免切角色后新件撞号 */
function syncUidSeq() {
  let maxSeq = 0;
  const scan = (p) => { const m = /^b(\d+)$/.exec(p?.uid || ''); if (m) maxSeq = Math.max(maxSeq, +m[1]); };
  state.pool.forEach(scan);
  state.uidSeq = maxSeq + 1;
}

/** 角色快照 → state（装备深拷贝，与其它角色不共享引用） */
function applyChar(c) {
  state.charName = c.name || DEFAULT_CHAR_NAME;
  state.school = c.school ?? null;
  state.branch = c.branch ?? null;
  state.plan = c.plan ?? null;
  state.selections = { ...blankSelections(), ...JSON.parse(JSON.stringify(c.selections || {})) };
  state.pool = JSON.parse(JSON.stringify(Array.isArray(c.pool) ? c.pool : []));
  // 迁移（2026-11-02）：定音改由**槽位**决定，pool 里不再存 ——
  // 旧档里的定音名带着"当时那套方案"的名字，留着会随导出分享传播，也会诱导玩家以为它是装备属性。
  for (const p of state.pool) delete p.定音;
  state.loadouts = JSON.parse(JSON.stringify(c.loadouts || {}));
  state.bagFilter = null;
  state.selected = null;
  state.editing = false;
  state.editTarget = null;
  state.picker = null;
  state.mindPicker = null;
  state.schoolPicker = null;
  state.configPicker = false;
  state.charPicker = null;
  syncUidSeq();
  rebuildGear(); // equipped/backpack 由 pool + 当前配置的 loadout 派生
}

/**
 * 切换角色：先落盘当前角色，再整体换一套（流派/口径/装备），最后按该角色流派重新拉轴包。
 * 已有口径的角色不会被方案默认覆盖（keepSelections）——玩家自己调过的心法/套装要保住。
 */
async function switchChar(id) {
  const c = state.roster[id];
  if (!c) return false;
  save();            // 切走前先把**当前**角色落盘（此时 charId 还是旧的）
  state.charId = id; // 之后所有 save() 都写到新角色名下（漏了这步会把新角色的空白快照写进旧角色）
  const fresh = isEmptySelections(c.selections);
  applyChar(c);
  const school = SCHOOLS.some(([s]) => s === state.school) ? state.school : SCHOOLS[0][0];
  await switchSchool(school, { keepSelections: !fresh });
  return true;
}

// ---------- 三层切换：流派 ⊃ 分支（=技能轴） ⊃ 方案 ----------

/** 当前流派下实际存在的分支（按方案文件出现顺序去重）；无分支的流派返回 [null] */
function branchesOf() {
  const out = [];
  for (const f of state.flows?.flows || []) {
    const b = f.branch ?? null;
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

/** 某分支下实际存在的方案 id 列表（方案矩阵可以不平衡：分支 A 只有大外、分支 B 大小外都有） */
function plansOf(branch) {
  return (state.flows?.flows || [])
    .filter((f) => (f.branch ?? null) === (branch ?? null))
    .map((f) => f.plan).filter(Boolean);
}

/** 分支显示名：查 _meta.json（运维维护中文名，代码不写死） */
function branchLabel(id) {
  return state.meta?.分支?.[id]?.name || id || '';
}

/** 方案显示名：查 version.方案类型 枚举（换季/加方案类型 = 改数据，零代码） */
function planLabel(id) {
  return state.version?.方案类型?.[id]?.name || id || '';
}

/** 默认分支：优先选"自带技能轴"的那个，避免一进页面就落在算不出来的分支上
 *  多分支都有轴时，按 manifest 里 build 包的声明顺序取第一个（清单顺序 = 站主意图的优先级） */
function defaultBranch(branches) {
  for (const p of BUILD_PACKS) {
    if (p.流派 === state.school && branches.includes(p.分支 ?? null)) return p.分支 ?? null;
  }
  return branches.find((b) => resolveBuild(state.school, b).status === 'exact') ?? branches[0] ?? null;
}

/** 按 (流派, 分支) 解析并加载技能轴；轴未变则不重复拉取 */
async function applyBuild() {
  const r = resolveBuild(state.school, state.branch);
  state.buildStatus = r.status;
  state.borrowedBranch = r.borrowedBranch;
  if (r.id === state.buildId && state.data) return;
  state.buildId = r.id;
  state.data = r.id ? await loadBuildData(r.id) : null;
}

/**
 * @param opts.keepSelections 切**角色**时为 true：沿用该角色自己存过的口径（心法/套装/弓玦/武库），
 *                            不被方案默认覆盖；切流派时仍为 false（换流派 = 换一套默认口径）。
 */
async function switchSchool(school, opts = {}) {
  state.school = school;
  state.flows = null;
  state.prescription = null;
  state.bagFilter = null; // 换流派 = 换评价体系，背包筛选不再有参照
  boot('④ 拉取流派数据中…');
  state.meta = await loadSchoolMeta(school);
  try {
    state.flows = await loadFlows(school);
  } catch { /* 无模板：仅 DPS/面板可用 */ }
  // 选流派后自动定下默认分支与方案，保证 (流派,分支,方案) 三元组始终完整
  const branches = branchesOf();
  if (!branches.includes(state.branch)) state.branch = defaultBranch(branches);
  const plans = plansOf(state.branch);
  if (!plans.includes(state.plan)) state.plan = plans[0] ?? null;
  await applyBuild();
  applyFlow();
  // 切流派：以方案默认覆盖口径选择（与评价器同款行为）；切角色则不覆盖（keepSelections）
  if (!opts.keepSelections) applyPlanDefaults();
  else refreshGraduate(); // 沿用旧口径时也要按当前 prescription/selections 重算毕业基准（否则沿用上一个角色的）
  rebuildGear(); // 换配置 = 换一套已穿戴（每个 流派+分支+方案 各存一份 loadout）
  // 录入草稿默认武器类型跟随流派（部位=武器，不分左右）
  const cats = currentWeaponLabels();
  state.draft = newDraft(
    state.draft.slot,
    state.draft.slot === WEAPON_SLOT ? (state.draft.weaponType || cats[0] || '') : '',
    currentFlow(), state.affixes,
  );
  save();
  render();
  boot('✓ 就绪');
}

async function switchBranch(branch) {
  state.branch = branch;
  const plans = plansOf(branch);
  if (!plans.includes(state.plan)) state.plan = plans[0] ?? null;
  await applyBuild();  // 分支 = 技能轴，可能要换 build 包
  applyFlow();
  applyPlanDefaults();
  rebuildGear(); // 换配置 = 换一套已穿戴（该配置没配过 ⇒ 槽位全空）
  state.selected = null;
  state.editing = false;
  state.editTarget = null;
  save();
  render();
}

function switchPlan(plan) {
  state.plan = plan;
  applyFlow();
  applyPlanDefaults();
  rebuildGear(); // 同上：大外流/小外流各穿各的
  state.selected = null;
  state.editing = false;
  state.editTarget = null;
  save();
  render();
}

function applyFlow() {
  const flow = currentFlow();
  if (!flow) { state.prescription = null; return; }
  // 流派武器类型（指定增跟武器类型走、跨槽自由排列）：来自 build.weapon_categories
  const weaponTypes = currentWeaponLabels();
  const p = derivePrescription(state.affixes, flow, weaponTypes);
  state.prescription = p && p.feasible ? p : null; // 模板不可行时按"无模板"降级
}

/** 方案推荐值 → 口径选择默认（用户改动只进面板，不动 DPS 参照系）
 *  ⚠ 方案文件字段已更名（2026-10-30）：`装备套装`→`攻具套装`、`弓玦`→`弓玦套装`，并新增 `防具套装`。
 *  但 `state.selections` 的攻具/弓玦键**仍叫 `装备套装` / `弓玦`**——那是存档里的口径键（v3 存档 + panel.js 的
 *  optSource 都按这两个键取值），改名等于把玩家的口径选择全部清空，所以只换数据源、不换键。
 *  `防具套装` 是新键（2026-10-30 起）：版本包 `防具套装` 表暂为空效果（防具套只给气血等非 DPS 属性），不参与面板计算。 */
function applyPlanDefaults() {
  const b = state.data?.build;
  const flow = currentFlow();
  state.selections.装备套装 = flow?.攻具套装 || b?.selectors?.set || '';
  state.selections.防具套装 = flow?.防具套装 || '';
  state.selections.武库 = flow?.武库 || b?.selectors?.weapon_attribute || '';
  state.selections.弓玦 = flow?.弓玦套装 || '';
  const xf = Array.isArray(flow?.心法) ? flow.心法 : [];
  state.selections.心法 = [0, 1, 2, 3].map((i) => xf[i] || '');
  refreshGraduate();
}

/** 毕业基准：按当前方案配额物化毕业装备生成；失败/无方案时 null → 回退 Excel I16 */
function refreshGraduate() {
  const flow = currentFlow();
  state.graduate = (state.prescription && flow && state.data)
    ? computeGraduateDps({
        buildCtx: state.data, version: state.version, affixes: state.affixes,
        selections: state.selections, prescription: state.prescription, flow,
      })
    : null;
}

/** 兼容入口：按「分支.方案」复合 id 切换（存档与测试沿用该格式，勿改） */
async function switchFlow(flowId) {
  const s = String(flowId ?? '');
  const i = s.indexOf('.');
  const branch = i > 0 ? s.slice(0, i) : null;
  const plan = i > 0 ? s.slice(i + 1) : s;
  if ((branch ?? null) !== (state.branch ?? null)) return switchBranch(branch);
  return switchPlan(plan);
}

// ---------- 整体视图（栏4 数据源） ----------

/** 有模板走 inspectOverall（含监测）；无模板降级为仅 DPS/面板；失败返回错误视图 */
function computeOverallSafe() {
  const flow = currentFlow();
  // 缺技能轴（build 包尚未提供）：面板算不了，明确降级而非抛错
  if (!state.data) {
    return { ok: false, view: '整体', errors: ['该流派的技能轴（build 包）尚未提供，属性面板暂不可用'] };
  }
  const ctx = {
    buildCtx: state.data, version: state.version, affixes: state.affixes,
    selections: state.selections, gear: equippedList(),
    graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
  };
  try {
    if (flow && state.prescription) {
      return inspectOverall({ ...ctx, prescription: state.prescription, flow });
    }
    const { panel, dps, graduationRate } = evalGearDps(ctx);
    return {
      ok: true, view: '整体', degraded: true,
      DPS: { dps, graduationRate },
      属性面板: panel.stats,
      面板警告: panel.warnings ?? [],
      监测: null,
      errors: [],
    };
  } catch (err) {
    return { ok: false, view: '整体', errors: [String(err.message || err)] };
  }
}

// ---------- 渲染 ----------

function render() {
  state.overall = computeOverallSafe();
  renderLeft();
  renderCenter();
  renderRight();
  renderModal();
  renderCharButton(); // 顶栏角色按钮（多角色入口，不属于四栏）
  renderDock();       // 移动端三视图切换条（桌面隐藏）
  assist?.refresh();
  maybeNotifyComposition();
  bind();
}

/**
 * 三种主动开口情形之二：背包里凑出了更优组合。
 *
 * ⚠ 不能就地开口（2026-11-02 玩家实测的坑）：切换分支+方案会连跑两三次 render
 *   （`switchBranch` 一次、`switchPlan` 一次），中间那次用的是「新分支 + 默认方案」的配额，
 *   甚至 equipped 正被 rebuildGear 重建 —— 这时候搜出来的换装清单跟目标方案毫无关系，
 *   等最终态一算却是"已最优"。所以这里只**记下结论签名并防抖**，等状态静下来再复核一次；
 *   期间又变过就直接作废，绝不把中间态说给玩家。
 */
let compBase = null;
let compTimer = 0;

function compositionSig(r) {
  const swaps = r?.swapIn || [];
  return (r?.status || '') + '|' + swaps.map((s) => `${s.slot}:${s.piece?.uid || ''}`).join(',');
}

function maybeNotifyComposition() {
  if (!assist) return;
  if (state.switching) return; // 切配置的两段式中间态：不记基线也不开口，切完由 finally 再判一次
  const r = state.search?.result;
  const sig = compositionSig(r);
  if (compBase === null) { compBase = sig; return; } // 首次渲染只记基线
  if (sig === compBase) return;
  compBase = sig;
  if (!r?.swapIn?.length || r.status === 'optimal' || r.status === 'infeasible') return;

  clearTimeout(compTimer);
  compTimer = setTimeout(() => {
    const now = state.search?.result;
    if (compositionSig(now) !== sig) return; // 期间又变过 ⇒ 这条不是最终结论
    if (!now?.swapIn?.length || now.status === 'optimal' || now.status === 'infeasible') return;
    assist.notify({
      key: 'composition',
      sig,
      say: `${now.message}。要不要看看怎么换？`,
      cardData: {
        kind: 'composition',
        message: now.message,
        rows: now.swapIn.map((s) => ({
          slot: s.slot,
          names: [s.piece?.初始?.属性, ...(s.piece?.调律 || []).map((t) => t?.属性)].filter(Boolean).join(' / '),
        })),
      },
    });
  }, 600);
}

/** 移动端底部三视图切换（红线 / 装备 / 面板）；桌面端由 CSS 隐藏。
 *  data-mview-btn 的键（assist/gear/read）是内部约定，别跟着显示名改 —— assist.js 靠它定位。 */
function renderDock() {
  const dock = document.querySelector('#st-dock');
  if (!dock || dock.dataset.ready === '1') return;
  dock.innerHTML = `<button data-mview-btn="assist" aria-selected="true">红线</button>`
    + `<button data-mview-btn="gear" aria-selected="false">装备</button>`
    + `<button data-mview-btn="read" aria-selected="false">面板</button>`;
  dock.dataset.ready = '1';
}

// ===== 栏1：口径 + 已穿戴槽位（用户定稿 2026-10-30：口径与装备槽并成一栏放在最左） =====

// ===== 左栏：已穿戴槽位 + 背包（口径卡在右栏顶部） =====

function renderLeft() {
  // 当前配置（流派+分支+方案）从没配过装备 ⇒ 槽位全空是**预期行为**，明说一句免得玩家以为装备丢了
  const neverConfigured = state.backpack.length > 0 && !Object.keys(currentLoadout()).length;
  const configNote = neverConfigured
    ? `<div class="st-config-note muted">本方案还没配装备</div>`
    : '';
  leftEl.innerHTML = `
    <section class="st-panel">
      ${configNote}
      <div class="st-slots">
        ${SLOT_COLUMNS.map((col) => `<div class="st-slot-col">${col.slots.map(slotCardHtml).join('')}</div>`).join('')}
        <div class="st-slot-col">
          ${specialSlotHtml('弓玦')}${specialSlotHtml('武库')}
        </div>
      </div>
    </section>`;
}

// ===== 栏1/栏2 共用小工具 =====

function pieceAffixRows(piece, showDingyin = false) {
  return [
    ['宫', piece.初始],
    ...piece.调律.map((a, i) => [POS_LABELS[i + 1], a]),
    ...(showDingyin ? [['定', piece.定音]] : []),
  ].filter(([, a]) => a && a.属性);
}

function tierBadgeHtml(piece, big = false) {
  if (!state.prescription) return '<span class="tier-badge">无模板</span>';
  const g = gradeItem(state.prescription, piece.slot, toGradeItem(piece));
  if (!g.ok) return `<span class="tier-badge" title="${escapeHtml((g.errors || []).join('；'))}">?</span>`;
  const cls = TIER_CLASS[g.tier] || '';
  // 等阶只有天地玄黄四档；转律建议（含转后等阶）在详情里单独说明
  return `<span class="tier-badge ${cls} ${big ? 'big' : ''}" title="${escapeHtml(g.口径)}">${escapeHtml(g.tier)}</span>`;
}

/**
 * 该件在当前方案下的品阶权重（背包排序唯一依据；同档内保持录入顺序）。
 * 无模板/评估失败（?）一律排到末尾，不参与天地玄黄序列。
 */
function tierRankOf(piece) {
  if (!state.prescription || !piece) return TIER_UNKNOWN_RANK;
  try {
    const g = gradeItem(state.prescription, piece.slot, toGradeItem(piece));
    if (!g.ok || !g.tier) return TIER_UNKNOWN_RANK;
    return TIER_RANK[g.tier] ?? TIER_UNKNOWN_RANK;
  } catch {
    return TIER_UNKNOWN_RANK;
  }
}

function toGradeItem(piece) {
  return {
    // weaponType 必须传入：引擎据此只匹配本类型的武器槽（剑只比剑槽），
    // 否则"无指定增的剑"会被当成另一个武器槽而漏掉本槽必备（曾误判天档）
    weaponType: piece?.weaponType || '',
    initial: piece?.初始?.属性,
    tunings: (piece?.调律 || []).map((t) => t?.属性),
    converted: (piece?.调律 || []).map((t) => !!t?.转律),
    dingyin: piece?.定音?.属性,
  };
}

/** 槽位尺寸类（用户定稿比例，宽×长）：武器/弓玦 400×700、环/佩/武库 400×400、四防具 400×550 */
const SLOT_SIZE = {
  武器1: 'st-slot--w', 武器2: 'st-slot--w',
  环: 'st-slot--s', 佩: 'st-slot--s',
  冠胄: 'st-slot--a', 胸甲: 'st-slot--a', 胫甲: 'st-slot--a', 腕甲: 'st-slot--a',
};
const slotSizeClass = (key) => SLOT_SIZE[key] || 'st-slot--s';

/** 攻具四件 / 防具四件（2026-10-30 定稿）：左上角套装徽标按这两组分流——
 *  攻具四件显 `selections.装备套装`（攻具套，存档老键），防具四件显 `selections.防具套装`。 */
const ATK_GEAR_KEYS = ['武器1', '武器2', '环', '佩'];
const DEF_GEAR_KEYS = ['冠胄', '胸甲', '胫甲', '腕甲'];

/** 槽位显示名：武器写「武器 · 类型」，防具/饰品写部位名（用户定稿：不分左右） */
function slotNameOf(key) {
  const p = state.equipped[key];
  if (isWeaponKey(key)) return p?.slot === WEAPON_SLOT ? `武器 · ${p.weaponType || '?'}` : '武器';
  return key;
}

/** 已穿戴单槽位（纸娃娃样式，对齐燕小叽站点 HomeEquipmentLoadoutPanel）：
 *  空位 = 大「+」+部位名（点击录入）；已装备 = 装备图 + 等阶徽章（天地玄黄，右上角）
 *  + 承音徽章（右下角）；攻具四件左上角显攻具套装、防具四件显防具套装；
 *  hover title 给名称与词条摘要；金色底图。
 *  点击语义（用户定稿 2026-10-30，两段式）：第一次点 = 把背包筛到同部位（不开弹窗），
 *  再点同一槽 = 打开该件详情弹窗；背包件仍是点一下直接开弹窗。 */
function slotCardHtml(key) {
  const piece = state.equipped[key];
  const selected = state.selected?.kind === 'equipped' && state.selected.slot === key;
  const filtering = state.bagFilter === key;
  const size = slotSizeClass(key);
  if (!piece) {
    const emptyLabel = isWeaponKey(key) ? '武器' : key;
    // 空槽点击 = **只筛背包**（2026-11-02 玩家定稿）。录入入口统一走背包的「＋ 录入装备」——
    // 玩家点空槽常常只是想看看这个部位有什么能穿的，不该被直接塞一个录入表单。
    return `
      <div class="st-slot ${size} empty ${selected ? 'selected' : ''} ${filtering ? 'filtering' : ''}" data-act="focusSlot" data-slot="${escapeHtml(key)}" title="点击查看背包里的${escapeHtml(emptyLabel)}">
        <span class="st-slot-plus">+</span>
        <span class="st-slot-empty-name">${escapeHtml(emptyLabel)}</span>
      </div>`;
  }
  // 武器写类型（剑/枪/双刀…）；防具写部位名——只进悬停 title 与 img alt（用户定稿：卡面不再挂文字说明）
  const label = piece.slot === WEAPON_SLOT ? (piece.weaponType || '武器') : key;
  // 装备图：武器按类型（槽位专用竖版素材）、防具按部位；无映射时回退 glyph 文字
  const img = slotImageOf(key, piece.weaponType);
  // 左上角套装徽标：攻具四件 = 攻具套装（selections 老键 装备套装）、防具四件 = 防具套装。
  // 徽标显**简称**（version.套装简称，用户 2026-10-30 定稿），全称进悬停 title。
  const atkGear = ATK_GEAR_KEYS.includes(key);
  const defGear = DEF_GEAR_KEYS.includes(key);
  const setName = atkGear ? state.selections.装备套装 : defGear ? (state.selections.防具套装 || '') : '';
  const shortName = setName ? (state.version.套装简称?.[setName] || setName) : '';
  const setBadge = setName
    ? `<span class="st-slot-set" title="当前${atkGear ? '攻具' : '防具'}套装：${escapeHtml(setName)}（第五列可改）">${escapeHtml(shortName)}</span>` : '';
  // 等阶徽章（天地玄黄）→ 右上角（用户定稿：全部槽位，不只武器）；承音徽章单独在右下角
  const tierTop = `<span class="st-slot-tier">${tierBadgeHtml(piece)}</span>`;
  const cyMark = piece.承音 ? '<span class="cy-badge st-slot-cy" title="承音装备：数值取承音值">承</span>' : '';
  const rows = pieceAffixRows(withDingyin(piece, key), true)
    .map(([k, a]) => `${k}·${a.属性} ${fmtAffixValue(a.属性, a.数值)}${a.转律 ? '（转）' : ''}`).join('；');
  const tip = `${label}${piece.承音 ? '·承音' : ''}｜${rows || '未录词条'}${isWeaponKey(key) ? '（对比与替换按武器类型）' : ''}｜${filtering ? '再次点击查看评价与词条' : '点击筛选同部位装备，再点一次看详情'}`;
  return `
    <div class="st-slot ${size} ${selected ? 'selected' : ''} ${filtering ? 'filtering' : ''}" data-act="focusSlot" data-slot="${escapeHtml(key)}" title="${escapeHtml(tip)}">
      ${setBadge}
      ${tierTop}
      ${img
        ? `<img class="st-slot-img" src="${img}" alt="${escapeHtml(label)}" loading="lazy">`
        : `<span class="st-slot-glyph">${escapeHtml(isWeaponKey(key) ? (piece.weaponType || '武器') : key.slice(0, 1))}</span>`}
      ${cyMark}
    </div>`;
}

/**
 * 第 5 列特殊槽：弓玦 / 武库。点击任一弹同一选择模态框。
 * 卡面不挂底部文字（用户定稿 2026-10-26）：
 *   弓玦 = 弓图标 + 套装名，名字放左上角用装备套装同款徽标（.st-slot-set）；
 *   武库 = 只有武库图标，不写名字；两者当前值都在悬停 title 里。
 */
function specialSlotHtml(kind) {
  if (kind === '弓玦') {
    const key = state.selections.弓玦;
    const icon = slotImg(state.version.界面图片?.['弓玦图标']);
    const tip = key ? ` · 当前 ${escapeHtml(gongjueLabel(key))}` : ' · 未选';
    return `
      <div class="st-slot st-slot--w st-slot--special" data-act="openSetPicker" title="点击选择弓玦套装${tip}">
        ${icon ? `<img class="st-slot-img" src="${icon}" alt="" loading="lazy">` : ''}
        <span class="st-slot-set" title="当前弓玦套装（点击可改）">${escapeHtml(key || '未选')}</span>
      </div>`;
  }
  const key = state.selections.武库;
  const img = slotImg(state.version.界面图片?.['武库']?.[key]);
  const tip = key ? ` · 当前 ${escapeHtml(key)}武库` : ' · 未选';
  return `
    <div class="st-slot st-slot--s st-slot--special" data-act="openSetPicker" title="点击选择武库${tip}">
      ${img ? `<img class="st-slot-img" src="${img}" alt="" loading="lazy">` : ''}
    </div>`;
}

/**
 * 背包卡片（用户定稿 2026-10-26）：与已穿戴槽同款形态——金色背景图 + 装备图 + 等阶徽章，
 * 卡面无任何文字（名称/词条都在悬停 title，点开详情看完整评价）。
 * 武器用「背包内武器图标素材」（方版），其余部位与装备槽共用同一张。
 */
function bpCardHtml(piece) {
  const selected = state.selected?.kind === 'backpack' && state.selected.uid === piece.uid;
  const label = piece.slot === WEAPON_SLOT ? (piece.weaponType || '武器') : piece.slot;
  const img = bagImageOf(piece);
  const rows = pieceAffixRows(piece)
    .map(([k, a]) => `${k}·${a.属性} ${fmtAffixValue(a.属性, a.数值)}${a.转律 ? '（转）' : ''}`).join('；');
  const tip = `${label}${piece.承音 ? '·承音' : ''}｜${rows || '未录词条'}｜点击查看评价与词条`;
  // 「他方案在用」标识（用户定稿 2026-10-31 第二十九版）：被**其他**配置穿在身上的件，
  // 背包卡左下角显示**对应流派的印章**（多个配置时按流派去重，同派只留一枚——
  // 印章代表流派，同派重复无信息量；具体是哪些配置在悬停 title 里列全）。
  // 流派图缺失时回落到单字「用」，标识本身不丢。
  const usedBy = configsUsingPiece(piece.uid);
  const usedSeals = [];
  for (const c of usedBy) {
    const src = slotImg(state.version.界面图片?.['流派图']?.[c.school]);
    if (src && !usedSeals.includes(src)) usedSeals.push(src);
  }
  const usedTip = escapeHtml(`已被其他方案使用：${usedBy.map((c) => c.label).join('、')}`);
  // 一枚好件可能同时被好几个流派穿着：左下角横向最多排 3 枚印章，其余并成「+N」
  // （再多会顶到卡片右缘的承音徽标），完整清单仍在 title 里。
  const MAX_SEALS = 3;
  const sealShown = usedSeals.slice(0, MAX_SEALS);
  const sealMore = usedSeals.length - sealShown.length;
  const usedMark = usedBy.length
    ? `<span class="st-bp-used${usedSeals.length ? '' : ' is-text'}" title="${usedTip}">${
      usedSeals.length
        ? sealShown.map((s) => `<img class="st-bp-used-seal" src="${s}" alt="" loading="lazy">`).join('')
          + (sealMore > 0 ? `<span class="st-bp-used-more">+${sealMore}</span>` : '')
        : '用'
    }</span>`
    : '';
  return `
    <div class="st-bp-card ${selected ? 'selected' : ''}" data-sel-kind="backpack" data-sel-uid="${escapeHtml(piece.uid)}" title="${escapeHtml(tip)}">
      <span class="st-bp-tier">${tierBadgeHtml(piece)}</span>
      ${img
        ? `<img class="st-bp-img" src="${img}" alt="${escapeHtml(label)}" loading="lazy">`
        : `<span class="st-bp-glyph">${escapeHtml(piece.slot === WEAPON_SLOT ? (piece.weaponType || '武器') : piece.slot.slice(0, 1))}</span>`}
      ${usedMark}
      ${piece.承音 ? '<span class="cy-badge st-bp-cy" title="承音装备：数值取承音值">承</span>' : ''}
    </div>`;
}

/**
 * 背包分组（用户定稿 2026-10-31 第二十六版）：
 *   - 可见性：武器只保留**当前方案可用的类型**（流派的两把武器；未来可能两把同类型，
 *     Set 天然去重），其余类型的武器一律不进背包（见 bagVisible）；
 *   - 排序：一律按**当前方案的品阶**（天→地→玄→黄），同档内保持录入顺序；
 *   - 筛选：点已穿戴槽后只列同部位；武器槽**只列本槽类型**，不再给「其他类型」分行。
 * @returns [{ label, items }] label 为空串 = 不显示分组标题
 */
function backpackGroups() {
  // 品阶只算一次（gradeItem 在渲染里被调多次：卡徽章 + 排序）
  const cache = new Map();
  const rankOf = (p) => {
    if (!cache.has(p.uid)) cache.set(p.uid, tierRankOf(p));
    return cache.get(p.uid);
  };
  const byTier = (a, b) => rankOf(a) - rankOf(b);
  const items = state.backpack.filter(bagVisible);

  const key = state.bagFilter;
  const worn = key ? state.equipped[key] : null;
  if (!key) return [{ label: '', items: [...items].sort(byTier) }];
  if (!isWeaponKey(key)) return [{ label: '', items: items.filter((p) => p.slot === key).sort(byTier) }];
  // 武器槽：有已穿戴 = 只看该类型；槽空 = 列本方案可用的全部武器类型
  const wt = worn ? String(worn.weaponType ?? '') : '';
  const weapons = items.filter((p) => p.slot === WEAPON_SLOT);
  const list = wt ? weapons.filter((p) => String(p.weaponType ?? '') === wt) : weapons;
  return [{ label: '', items: list.sort(byTier) }];
}

/** 槽位卡：已穿戴单槽位（纸娃娃样式，对齐燕小叽站点 HomeEquipmentLoadoutPanel） */

/** 当前方案可用的武器类型集合（用户定稿 2026-10-31）：
 *  每个流派固定用两把武器，未来可能两把同类型 → Set 去重（['枪','枪'] 仍是 {枪}）。
 *  返回 null = 拿不到武器声明（无 build/未知类型），此时不限制、不隐藏任何武器。 */
function planWeaponTypes() {
  const labels = currentWeaponLabels();
  if (!labels.length) return null;
  return new Set(labels.map(String));
}

/** 背包可见性（用户定稿 2026-10-31）：武器只留本方案可用的类型，其余类型不展示；
 *  防具/环/佩/弓玦不受影响。拿不到武器声明时一律可见（宁可多显示也不把人录的件藏没）。 */
function bagVisible(piece) {
  if (piece.slot !== WEAPON_SLOT) return true;
  const types = planWeaponTypes();
  if (!types) return true;
  return types.has(String(piece.weaponType ?? ''));
}
// ===== 栏2：背包（独立成栏，用户定稿 2026-10-30） =====

function renderCenter() {
  // 组合搜索有缓存（key 变才重算）：这里先跑一次，背包标题上的「组合」小圆点才不会滞后一帧
  computeSearchSafe();
  // 空槽也能筛（玩家点空槽看该部位有什么），所以不再要求 bagFilter 对应的槽有件
  const filterKey = EQUIP_KEYS.includes(state.bagFilter) ? state.bagFilter : null;
  const groups = backpackGroups();
  const shown = groups.reduce((s, g) => s + g.items.length, 0);
  // 筛选态只体现在标题上（用户定稿 2026-10-31 第二十七版）：背包 → 背包·环，
  // 不再挂「只看 X 的装备（N 件）」提示条与「显示全部」按钮——点别处即自动取消。
  const bagTitle = `背包${filterKey ? '·' + slotNameOf(filterKey) : ''}`;
  const bagBody = groups.map((g) => `
    <div class="st-bp-group">
      ${g.label ? `<div class="st-bp-group-title">${escapeHtml(g.label)}</div>` : ''}
      <div class="st-backpack">
        ${g.items.length
          ? g.items.map(bpCardHtml).join('')
          : `<p class="muted st-bp-empty">${shown === 0
            ? '空'
            : '（无）'}</p>`}
      </div>
    </div>`).join('');
  const hiddenWeapons = state.backpack.filter((p) => p.slot === WEAPON_SLOT && !bagVisible(p));
  // 「不可用武器已隐藏」只留一行灰字（用户定稿 2026-10-31：不展示非本方案武器，
  // 但不能让玩家以为录进去的件丢了——所以给个计数与去处提示，不占卡位）
  const hiddenNote = hiddenWeapons.length ? `
      <p class="st-bp-hidden muted" title="${escapeHtml([...new Set(hiddenWeapons.map((p) => p.weaponType || '武器'))].join('、'))}">
        另有 ${hiddenWeapons.length} 件非本方案武器已隐藏</p>` : '';
  centerEl.innerHTML = `
    <section class="st-panel">
      <div class="st-sec-title">
        <span>${escapeHtml(bagTitle)}</span>
        <span class="st-title-actions">
          <button class="st-mini${compositionImproved() ? ' has-dot' : ''}" data-act="openComposition"
            title="看看背包里能不能凑出更好的组合">组合</button>
          <button id="st-open-editor" class="st-add-btn">＋ 录入装备</button>
        </span>
      </div>
      <div class="st-bp-groups">${bagBody}</div>
      ${hiddenNote}
    </section>`;
}

// ===== 弹窗 =====

function affixTableHtml(piece, showDingyin = false) {
  // 定音只在**已穿戴**的词条面板出现（2026-11-02 玩家定稿）：
  // 背包件显示定音会让玩家以为"这件只能那个方案用"，而它根本还没定音。
  const rows = [
    ['宫', piece.初始],
    ...piece.调律.map((a, i) => [POS_LABELS[i + 1], a]),
    ...(showDingyin ? [['定音', piece.定音]] : []),
  ];
  return `
    <table class="st-affix-table">
      <tr><th>位置</th><th>词条</th><th style="text-align:right">数值</th></tr>
      ${rows.map(([k, a]) => `
        <tr>
          <td class="pos">${k}</td>
          <td>${a?.属性 ? `${a.转律 ? '<span class="conv-tag" title="已转律：之后只能继续转这一条">转</span>' : ''}${escapeHtml(a.属性)}` : '<span class="muted">— 未录 —</span>'}</td>
          <td class="num">${a?.属性 ? escapeHtml(fmtAffixValue(a.属性, a.数值)) || '<span class="muted">待补</span>' : ''}</td>
        </tr>`).join('')}
    </table>`;
}

/** 弹窗标题：武器按 类型 显示（不分左右），防具/饰品按部位 */
function pieceTitle(piece, kind, slotKey) {
  const label = piece.slot === WEAPON_SLOT ? `武器 · ${piece.weaponType || '?'}` : (slotKey || piece.slot);
  return `${kind} · ${label}`;
}

/** 修改模式弹窗标题：沿用详情标题的「部位/武器类型」写法 */
function editModalTitle() {
  const t = state.editTarget;
  if (!t) return '修改装备';
  const piece = t.kind === 'equipped' ? state.equipped[t.slot] : backpackByUid(t.uid);
  if (!piece) return '修改装备';
  return pieceTitle(piece, '修改', t.kind === 'equipped' ? t.slot : piece.slot);
}

/** 弹窗外壳：标题（含档位徽章）+ 动作按钮 + 关闭；遮罩点击/Esc 关闭在 bind() 中处理。
 *  extraCls 给个别弹窗改宽度用（配置弹窗内容少，收成一列更聚气） */
function modalShellHtml(title, piece, actionBtns, body, extraCls = '') {
  return `
    <div class="st-modal-backdrop">
      <div class="st-modal${extraCls ? ` ${extraCls}` : ''}" role="dialog" aria-modal="true">
        <div class="st-modal-head">
          <h3>${escapeHtml(title)}${piece?.承音 ? ' <span class="muted">承音</span>' : ''}${piece ? ` ${tierBadgeHtml(piece, true)}` : ''}</h3>
          <div class="st-modal-actions">${actionBtns}<button class="st-modal-close" data-act="closeModal">关闭</button></div>
        </div>
        <div class="st-modal-body">${body}</div>
      </div>
    </div>`;
}

/**
 * 面板差异表（前 → 后），作为「依据」折叠的一部分（2026-11-01 整合）。
 * 原来的「更好/更差/等价」判定徽章已删：处置行已给出精确的 DPS 百分比，徽章是同一结论的第二种说法。
 */

/**
 * 渲染弹窗：录入表单（state.editing）/ 装备详情（selected）/ 无（清空）。
 * 原常驻详情区的内容全部搬到这里——工作台没有常驻的详情区。
 */
function renderModal() {
  renderModalInner();
  try { bindCrossFlowOnce(); } catch { /* DOM 不可用（测试环境）时跳过 */ }
  // 首次打开详情时后台拉一次全流派模板：处置句要靠它说"正在被谁用"和"其他配法"。
  // 只触发一次（loading 一被赋值就不再进这个分支），完成后刷新一次弹窗。
  if (!XFLOW.entries && !XFLOW.loading) {
    ensureCrossFlows()
      .then(() => { if (state.selected) renderModal(); })
      .catch(() => { /* 拉不到就退化成只讲当前方案 */ });
  }
}

/** 跨方案折叠区：展开时才加载并填充（懒加载，避免打开详情就拉全流派模板） */
function bindCrossFlowOnce() {
  const xf = modalEl?.querySelector?.('details.st-xflow');
  if (!xf || xf.dataset.bound) return;
  xf.dataset.bound = '1';
  const body = xf.querySelector('.xflow-body');
  const kind = xf.dataset.kind, ref = xf.dataset.ref;
  xf.addEventListener('toggle', () => {
    if (!xf.open || !body) return;
    const piece = kind === 'equipped' ? state.equipped?.[ref] : backpackByUid(ref);
    // 取不到就明确报错，不要停在"展开后加载…"（曾因把部位值当存储键传而卡住）
    if (piece) fillCrossFlow(body, piece);
    else body.innerHTML = `<span class="muted">未找到该装备（${escapeHtml(kind)}/${escapeHtml(ref)}）</span>`;
  });
}

function renderModalInner() {
  const s = state.selected;
  if (state.composition) {
    modalEl.innerHTML = compositionModalHtml();
    return;
  }
  if (state.charPicker) {
    modalEl.innerHTML = charPickerHtml();
    return;
  }
  if (state.schoolPicker) {
    modalEl.innerHTML = schoolPickerHtml();
    return;
  }
  if (state.picker) {
    modalEl.innerHTML = setPickerHtml();
    return;
  }
  if (state.mindPicker) {
    modalEl.innerHTML = mindPickerHtml();
    return;
  }
  if (state.editing) {
    if (state.editTarget) {
      modalEl.innerHTML = modalShellHtml(editModalTitle(), null, '', `
        <div class="st-editor">
          <div class="st-sec-title"><span>词条</span></div>
          ${editorHtml()}
        </div>`);
      return;
    }
    modalEl.innerHTML = modalShellHtml('录入装备（进背包）', null, '', `
      <div class="st-editor">
        <div class="st-sec-title"><span>词条</span></div>
        ${editorHtml()}
      </div>`);
    return;
  }
  if (s?.kind === 'equipped' && state.equipped[s.slot]) {
    const piece = state.equipped[s.slot];
    modalEl.innerHTML = modalShellHtml(pieceTitle(piece, '已穿戴', s.slot), piece, `
      <button class="ghost" data-act="editPiece" data-kind="equipped" data-slot="${escapeHtml(s.slot)}" title="修改这件装备的词条（改完保存，仍留在原穿戴位）">调律</button>
      <button class="primary" data-act="unequip" data-slot="${escapeHtml(s.slot)}">脱下</button>
      <button class="ghost" data-act="removeEquipped" data-slot="${escapeHtml(s.slot)}">删除</button>`,
      equippedDetailHtml(piece, s.slot));
    return;
  }
  if (s?.kind === 'backpack') {
    const piece = backpackByUid(s.uid);
    if (!piece) { state.selected = null; modalEl.innerHTML = ''; return; }
    // 同部位有穿戴件时并排两张表，720 装不下 —— 加宽到 940
    const worn = comparableEquipped(piece);
    const wide = !!worn && worn.uid !== piece.uid ? 'st-modal--wide' : '';
    modalEl.innerHTML = modalShellHtml(pieceTitle(piece, '背包'), piece, `
      <button class="primary" data-act="equip" data-uid="${escapeHtml(piece.uid)}">穿上</button>
      <button class="ghost" data-act="editPiece" data-kind="backpack" data-uid="${escapeHtml(piece.uid)}" title="修改这件装备的词条（改完保存，仍在背包）">调律</button>
      <button class="ghost" data-act="removeBackpack" data-uid="${escapeHtml(piece.uid)}">删除</button>`,
      candidateDetailHtml(piece), wide);
    return;
  }
  modalEl.innerHTML = '';
}

/** 已穿戴详情（弹窗体，不含标题/动作按钮——由 modalShellHtml 提供）
 *  @param slotKey equipped 的**存储键**（武器1/武器2/环/…）——跨方案区块靠它取回本件，
 *                 不能传部位值 piece.slot（武器部位值是「武器」，在 equipped 里查不到） */
function equippedDetailHtml(piece, slotKey) {
  const flow = currentFlow();
  let body;
  if (!state.prescription || !flow) {
    body = '<p class="muted">当前流派暂无配额模板</p>';
  } else {
    // 已穿戴件与背包件同一套两段说话体（2026-11-01）：只是动作换成 留着 / 转律后继续用 / 可以分解，
    // 前缀换成「这件装备已经穿在身上，」——它跟「自己」没有可比性。
    let r;
    try {
      r = disposeWorn({
        buildCtx: state.data, version: state.version, affixes: state.affixes,
        selections: state.selections,
        prescription: state.prescription, slot: piece.slot, item: piece,
        currentGear: equippedList(),
        deadZone: flow.死区 ?? 0.005,
        graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
        crossFlow: crossFlowFor(piece),
        flow,
        usedBy: usedByOf(piece),
      });
    } catch (err) {
      body = `<ul class="warnings"><li>评价计算出错：${escapeHtml(err.message)}</li></ul>`;
    }
    if (!body) {
      if (!r.ok || r.action === '无法判断') {
        body = `<div class="st-eval"><div class="st-say muted">${escapeHtml(r.reason || r.errors?.[0] || '信息不足')}</div></div>`;
      } else {
        // 两段话 + 跨方案折叠同住一个 .st-eval（分成两块时未展开的那块只剩一根空竖条）
        body = `<div class="st-eval">${disposeSayHtml(r)}${crossFlowHtml(piece, 'equipped', slotKey)}</div>`;
      }
    }
  }
  return `${affixTableHtml(withDingyin(piece, slotKey), true)}${body}`;
}

/** 背包件详情（弹窗体，不含标题/动作按钮——由 modalShellHtml 提供） */
/** 跨方案结果（只服务处置兜底；未加载过时为 null，不影响主线判断） */
function crossFlowFor(piece) {
  if (!XFLOW.entries) return null;
  try {
    const curKey = `${state.school}.${currentFlow()?.flowId ?? ''}`;
    const isW = piece.slot === WEAPON_SLOT;
    const myType = String(piece.weaponType ?? '');
    const pool = XFLOW.entries.filter((e) => e.key !== curKey && (!isW || e.weaponTypes.includes(myType)));
    return surveyFlows(pool, piece.slot, toGradeItem(piece));
  } catch { return null; }
}

/**
 * 处置（评价系统设计.md §11）：穿上 / 转律后穿上 / 放背包 / 分解。
 * **只针对当前这一件**。
 *
 * 排版（2026-11-01 玩家定稿）：动作标签 + **一句话**：
 *   老大，这件{词条}，{品相}，{对比}，{建议}。
 * `{词条}` 段可点开，下方显隐具体缺什么 / 哪条无效 / 宫位为何去不掉。
 */
/**
 * 「这件正被哪些配法穿着」→ [{ label, tier }]（tier = 在那套下的品相）。
 * ⚠ 两种 key 格式不同：loadout 是 `流派|分支|方案`，XFLOW 是 `流派.分支.方案`；
 *    直接相等比较永远匹配不上，tier 会恒为 null（处置句就只剩方案名，不报品相）。
 */
function usedByOf(piece) {
  return configsUsingPiece(piece.uid).map((u) => {
    const [sc, br, pl] = String(u.key).split('|');
    const xkey = `${sc}.${flowIdOf(br || null, pl || null)}`;
    const e = XFLOW.entries?.find((x) => x.key === xkey);
    let tier = null;
    if (e) {
      try {
        const gd = gradeItem(e.rx, piece.slot, toGradeItem(piece));
        if (gd.ok) tier = gd.tier;
      } catch { /* 拿不到就不报那套的品相 */ }
    }
    return { label: u.label, tier };
  });
}

/**
 * 处置的原始结果（引擎返回的 r）。抽出来是为了「详情页渲染」和「助手主动提示」共用同一份判断 ——
 * 两处各算一遍迟早会分叉。出错时返回 `{ error }`，不抛。
 */
function disposeResultOf(piece) {
  const flow = currentFlow();
  if (!state.prescription || !flow || !state.data) return { error: null };
  // 已经穿在身上的那件必须走 disposeWorn（动作是 留着 / 转律后继续用 / 可以分解），
  // 不能拿背包版去算 —— 否则它会说"放背包"，而详情页说的是"留着"，同一件两个结论。
  // 详情页、助手 evaluate_piece、get_focus 都从这里取，所以这里判对，三处自然一致。
  const wornSlot = EQUIP_KEYS.find((k) => state.equipped[k]?.uid === piece.uid) || null;
  const args = {
    buildCtx: state.data, version: state.version, affixes: state.affixes,
    selections: state.selections,
    prescription: state.prescription, slot: piece.slot, item: piece,
    currentGear: equippedList(),
    deadZone: flow.死区 ?? 0.005,
    graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
    crossFlow: crossFlowFor(piece),
    flow, // 转律前后要做配额行级对比，判断"这条转律是不是全局必需"
    usedBy: usedByOf(piece),
  };
  try {
    return wornSlot ? disposeWorn(args) : disposeItem(args);
  } catch (err) {
    return { error: err };
  }
}

function disposeHtml(piece) {
  const flow = currentFlow();
  if (!state.prescription || !flow || !state.data) return '';
  const r = disposeResultOf(piece);
  if (r.error) {
    return `<div class="digest"><div class="digest-title">处置</div><div class="muted">计算出错：${escapeHtml(r.error.message)}</div></div>`;
  }
  if (!r.ok || r.action === '无法判断') {
    const why = r.reason || r.errors?.[0] || '信息不足';
    return `<div class="st-say muted">${escapeHtml(why)}</div>`;
  }

  return disposeSayHtml(r);
}

/**
 * 录完一件后由助手主动说一句（三种开口情形之一：这件值得动）。
 * 去重按「件 × 结论」：同一件同一结论只说一次，结论变了（比如后来凑出更优组合）会重说。
 */
function notifyPiece(uid) {
  if (!assist) return;
  const piece = poolByUid(uid);
  if (!piece) return;
  const r = disposeResultOf(piece);
  if (r.error || !r.ok || r.action === '无法判断') return;
  // 只有"值得动"才开口：放背包/分解交给详情页，不追着说
  if (r.action !== '穿上' && r.action !== '转律后穿上') return;
  const tier = r.tier || '';
  // 四段式重构后 parts 里叫「结论」（旧的 对比/建议 已废）——读错字段会让这句退化成兜底话
  const advice = r.parts?.结论 || '';
  assist.notify({
    key: `${uid}:dispose`,
    sig: `${r.action}|${tier}|${advice}`,
    say: `新录的这件是${tier ? `${tier}阶` : '能用的'}，${advice || '可以先留着'}。`,
  });
}

/**
 * 处置的两段话 → HTML（纯函数，输入只有引擎返回的 r，方便单测）。
 *
 * ① `老大，这件{词条}，{X阶}品相。[不过这件现在正被…穿着，在那套下它是Y阶品相。]`
 * ② `[如果你想要在当前方案使用这件装备，]{对比}，建议{动作}。[另外 N 套方案也能用得上。]`
 *
 * 两条渲染纪律（都踩过坑）：
 *   - 句子**任何位置**出现的「天阶/地阶/玄阶/黄阶」都要上色加粗——不只是①里那个 tag，
 *     还有②里的「在那个方案下它是天阶品相」「（地阶）」；
 *   - 「N 套」可能在第二段（使用中）、第三段（转律）、第四段（结论）里，所以上色与链接化
 *     必须在**同一次 escape 之后**做；分开写两个函数再套用，前一步的 <b> 会被后一步转义掉。
 */
function disposeSayHtml(r) {
  const p = r?.parts || {};
  // 品相只强调「X阶」两个字，按档位配色
  const tierTag = (t) => (t
    ? `<b class="tier" data-tier="${escapeHtml(t)}">${escapeHtml(t)}阶</b>`
    : '');
  // 句子里任何位置的「X阶」都按同一套色上色
  const tierify = (raw) => escapeHtml(String(raw ?? ''))
    .replace(/([天地玄黄])阶/g, (_m, t) => tierTag(t));
  // 上色 + 链接化一步到位。
  // ⚠ 两个替换必须在**同一次** escape 之后做：tierify 和 linkify 各自都先 escapeHtml，
  //    串起来用会把前一步生成的 <b> 转义成 &lt;b&gt;，档位色和链接一起失效。
  // ⚠ 正则必须允许「方案」缺省 —— 口语化成「另外 13 套里」之后，只认「套方案」就点不动了。
  const rich = (raw) => tierify(raw)
    .replace(/(\d+)(\s*套(?:方案)?)/, '<span class="st-link" data-act="toggleXflow">$1$2</span>');
  // 四段（2026-11-02 玩家定稿）：① 品相对比 ② 别处价值 ③ 转律 ④ 结论。
  // 拆段是为了让"这件"每段只有一个主语 —— 原来"这件装备"接在"你身上那件"后面会指代不明。
  // 建议不再整句加粗：只有「N 套」那一截是金色链接（.st-link 自带 500 字重）。
  const paras = [
    `老大，这件${tierify(p.词条)}，${tierTag(p.tier)}品相。`
      + (p.已穿档 ? `而你现在穿的这件是${tierTag(p.已穿档)}品相。` : '')
      + (p.穿在身上 ? '它正穿在你身上。' : '')
      + `${p.高下 || ''}`,
    p.使用中 ? `不过${rich(p.使用中)}。` : '',
    p.转律 ? `${rich(p.转律)}。` : '',
    p.结论 ? `总之，${rich(p.结论)}${p.跨方案 ? `；${rich(p.跨方案)}` : ''}。` : '',
  ].filter(Boolean);
  return paras.map((t) => `<div class="st-say">${t}</div>`).join('');
}

/**
 * 背包件 vs 同部位已穿戴：两张词条表并排 + 一句「两件差在哪」（2026-11-02 玩家定稿）。
 *
 * 只在**看背包里的一件**时出现。三种情况返回 '' 让详情退回单表：
 *   ① 同部位空着 —— 没有可比的；
 *   ② 看的是已穿戴件本身 —— 跟自己没可比性（那走 equippedDetailHtml）；
 *   ③ 录入/修改表单 —— 那还没有"对面那件"，走 editor 分支。
 *
 * 表是事实并列；下面那句**只描述差异，不建议穿脱**。穿不穿由 disposeItem 的处置句说 ——
 * 两处各下一个结论，就会出现"对比说不如现在、处置说换上"的自相矛盾。
 */
function wornCompareHtml(piece) {
  const worn = comparableEquipped(piece);
  if (!worn || worn.uid === piece.uid) return '';
  // 原先这里还有一句「你现在穿的是X阶，这件是Y阶」—— 2026-11-02 玩家定稿并进处置句了，
  // 单独一句会让玩家读两次才建立比较关系（处置句第一段现在自带这句）。
  return `<div class="st-cmp">
    <div class="st-cmp-col">
      <div class="st-cmp-hd"><b>这件</b>${tierBadgeHtml(piece)}</div>
      ${affixTableHtml(piece)}
    </div>
    <div class="st-cmp-col">
      <div class="st-cmp-hd"><b>现在穿的</b>${tierBadgeHtml(worn)}</div>
      ${affixTableHtml(worn)}
    </div>
  </div>`;
}

function candidateDetailHtml(piece) {
  const flow = currentFlow();
  if (!state.prescription || !flow) {
    return `${affixTableHtml(piece)}<p class="muted">当前流派暂无配额模板</p>`;
  }
  // 2026-11-01 玩家定稿：**一句话说完整件装备**，明细按需点开。
  // 原来还要跑一次 inspectCandidate 取「更好/更差」徽章与面板差异表 —— 两者都已删除，
  // 现在结论与理由全部由 disposeItem 一次给出，**省掉一次完整 DPS 计算**（开弹窗更快）。
  // 两段话和「其他方案」的折叠必须同住一个 .st-eval 引用块：
  // 分成两块时，折叠未展开的那块只剩左侧 2px 竖标（.st-eval 的 border-left），看起来像个空块。
  // 同部位穿着的东西并排放，才看得出差在哪；没得比就还是单表
  return `${wornCompareHtml(piece) || affixTableHtml(piece)}
    <div class="st-eval">${disposeHtml(piece)}${crossFlowHtml(piece, 'backpack', piece.uid)}</div>`;
}

// ===== 录入表单（边录入边评价） =====

/** 草稿 → 装备件形状（供引擎评价与入包共用）；转律标记随词条存储 */
function draftPiece() {
  const p = state.draft;
  return {
    slot: p.slot,
    weaponType: p.weaponType || undefined,
    承音: p.承音 || undefined,
    初始: { 属性: p.初始.属性, 数值: p.初始.数值 },
    调律: p.调律.map((a) => (a.转律
      ? { 属性: a.属性, 数值: a.数值, 转律: true }
      : { 属性: a.属性, 数值: a.数值 })),
  };
}

/**
 * 录入/修改表单的比较基准：改已穿戴件时把它自己排除掉，否则变成「和自己比」恒等价。
 * 新录入与改背包件都按当前已穿戴全套比较（等价「假设穿上」）。
 */
function baselineGearForEdit() {
  const t = state.editTarget;
  if (t?.kind === 'equipped') {
    return EQUIP_KEYS.filter((k) => k !== t.slot).map((k) => state.equipped[k]).filter(Boolean);
  }
  return equippedList();
}

/**
 * 录入表单的实时评价状态。
 *   - `pot`：词条没录满时的潜力（只用于"最多能到几阶"那半句）；
 *   - `disp`：录满后由 disposeItem / disposeWorn 出的完整结论 —— 与详情页同源。
 *   （旧的 evaluateSwap「更好/更差/等价」在这里已经不需要了：详情定稿不再报这类判定，
 *     而 disposeItem 内部本来就会跑一次 evaluateSwap，重复算两遍纯属浪费。）
 */
function editorEvalState() {
  const p = state.draft;
  const n = (p.初始.属性 ? 1 : 0) + p.调律.filter((a) => a.属性).length;
  const complete = !!(p.初始.属性 && p.调律.every((a) => a.属性));

  let pot = null;
  if (state.prescription && n > 0) {
    pot = gradeItemPotential(state.prescription, p.slot, toGradeItem(p));
  }

  let disp = null;
  let noCompare = false;
  if (complete && state.prescription && state.data) {
    const piece = { ...draftPiece(), uid: state.editTarget?.uid };
    const editingEquipped = state.editTarget?.kind === 'equipped';
    // 武器：没有同类型已穿戴、且两个武器位都被别的类型占着 ⇒ 放都放不进去，别给"穿上"
    noCompare = piece.slot === WEAPON_SLOT
      && !comparableEquipped(piece)
      && !WEAPON_KEYS.some((k) => !state.equipped[k]);
    if (!noCompare) {
      try {
        const common = {
          buildCtx: state.data, version: state.version, affixes: state.affixes,
          selections: state.selections, prescription: state.prescription,
          slot: piece.slot, item: piece,
          deadZone: currentFlow()?.死区 ?? 0.005,
          graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
          crossFlow: crossFlowFor(piece),
          flow: currentFlow(),
        };
        disp = editingEquipped
          ? disposeWorn({ ...common, currentGear: equippedList(), usedBy: usedByOf(piece) })
          : disposeItem({ ...common, currentGear: baselineGearForEdit() });
      } catch { disp = null; }
    }
  }
  return { n, complete, pot, disp, noCompare };
}

/**
 * 录入/修改表单的实时评价（2026-11-02 与详情页统一）。
 *
 * - **词条没录满**：只说潜力一句（还差几条、按已录的看最多到几阶），不给建议 ——
 *   信息不足时硬给结论比不给更糟。
 * - **录满**：与背包件/已穿戴件走同一个引擎出口，渲染也共用 `disposeSayHtml()`，
 *   所以动作词（穿上 / 转律后穿上 / 放背包 / 分解，或 留着 / 转律后继续用 / 可以分解）
 *   与详情页逐字一致。
 */
function editorEvalHtml(s) {
  const parts = [];
  const editing = !!state.editTarget;
  parts.push(`<div class="st-sec-title" style="margin-top:12px"><span>实时评价</span><span class="muted">已录 ${s.n}/5</span></div>`);

  if (s.disp) {
    if (!s.disp.ok || s.disp.action === '无法判断') {
      parts.push(`<div class="st-say muted">${escapeHtml(s.disp.reason || s.disp.errors?.[0] || '信息不足，暂时判断不了')}</div>`);
    } else {
      parts.push(`<div class="st-eval">${disposeSayHtml(s.disp)}</div>`);
    }
  } else if (s.noCompare) {
    parts.push(`<div class="st-say">老大，这件武器现在塞不进去——两个武器位被 ${escapeHtml(wornWeaponTypes())} 占着呢。先收着，等换流派或腾出位置。</div>`);
  } else if (s.pot?.ok) {
    const t = s.pot.tier;
    const left = 5 - s.n;
    parts.push(`<div class="st-say">老大，这件还差 ${left} 条词条没录，红线算不准；按已录的看，最多到<b class="tier" data-tier="${escapeHtml(t)}">${escapeHtml(t)}阶</b>。</div>`);
    if (s.pot.warnings?.length) {
      parts.push(`<ul class="warnings">${s.pot.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);
    }
  } else if (s.n > 0) {
    parts.push('<div class="st-say muted">当前流派暂无配额模板——等阶不可评。</div>');
  } else if (s.pot && !s.pot.ok) {
    parts.push(`<ul class="warnings">${(s.pot.errors || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`);
  }
  return `<div class="st-live-eval">${parts.join('')}</div>`;
}

/**
 * 录入 / 修改表单。
 *
 * 结构自 HEAD 版沿用（部位 / 武器类型 / 承音 + 5 行词条），2026-11-02 两处改动：
 *   ① 实时评价换成与详情页同一套两段说话体（见 editorEvalHtml）；
 *   ② 下方按钮的**主次**由处置结论决定（穿上类 → 「直接穿上」主按钮；放背包 → 「添加到背包」；
 *      分解 → 「丢弃」），不再用旧的"更好/更差/等价 + 建议"三向文案。
 * 修改模式（编辑已入库件）只留「保存修改 / 取消」。
 */
function editorHtml() {
  const p = state.draft;
  const s = editorEvalState();
  const complete = s.complete;
  const editing = !!state.editTarget;

  const row = (kind, idx = null) => {
    const aff = kind === '调律' ? p.调律[idx] : p[kind];
    const basePool = kind === '初始' ? initialPool(p.slot)
      : kind === '调律' ? lawPool(p.slot, p.weaponType)
        : dingyinPool(p.slot);
    // 调律位互斥：已被**其他**位置占用的词条不再出现在本位的候选里（自身已选值保留）
    const pool = kind === '调律'
      ? basePool.filter((a) => !p.调律.some((x, i) => i !== idx && x.属性 === a))
      : basePool;
    const name = aff.属性 || '';
    const pct = isPercentAffix(name);
    const val = aff.数值 == null ? '' : (pct ? +(aff.数值 * 100).toFixed(4) : aff.数值);
    const ph = placeholderFor(name, p.承音 && kind !== '定音');
    const idxAttr = idx == null ? '' : ` data-ed-idx="${idx}"`;
    const convCell = kind === '调律'
      ? `<label class="conv" title="勾选 = 这条已转律；转律后只能继续转这一条（其余词条不能再转）"><input type="checkbox" data-ed-kind="调律"${idxAttr} data-ed-field="转律" ${aff.转律 ? 'checked' : ''}>转律</label>`
      : '<span class="conv none"></span>';
    return `
      <div class="affix-row">
        <span class="tag">${kind === '调律' ? `调律${idx + 1}` : kind}</span>
        <select data-ed-kind="${kind}"${idxAttr} data-ed-field="属性">${optionList(pool, name)}</select>
        <input type="number" step="any" data-ed-kind="${kind}"${idxAttr} data-ed-field="数值" value="${val}" placeholder="${escapeHtml(ph)}" title="${escapeHtml(ph)}">
        ${convCell}
        <span class="unit">${pct ? '%' : ''}</span>
      </div>`;
  };

  // 主按钮跟着处置结论走：穿 / 背包 / 分解（转律后穿上仍属"穿"）
  const act = s.disp?.ok ? s.disp.action : null;
  const primaryEquip = act === '穿上' || act === '转律后穿上';
  const primaryDiscard = act === '分解' || act === '可以分解';
  const primaryBag = !editing && !primaryEquip && !primaryDiscard;

  const buttons = editing
    ? `<button id="ed-save" class="primary">保存修改</button>
       <button id="ed-cancel" class="ghost">取消</button>`
    : `${complete ? `<button id="ed-equip" class="${primaryEquip ? 'primary' : 'ghost'}">直接穿上</button>` : ''}
       <button id="ed-add" class="${primaryBag ? 'primary' : 'ghost'}">添加到背包</button>
       <button id="ed-discard" class="${primaryDiscard ? 'primary' : 'ghost'}">丢弃</button>
       <button id="ed-cancel" class="ghost">取消</button>`;

  return `
    <div class="st-editor-head">
      <label>部位</label>
      <select id="ed-slot"${editing ? ' disabled' : ''}>${SLOTS.map((x) => `<option value="${x}" ${x === p.slot ? 'selected' : ''}>${x}</option>`).join('')}</select>
      ${isWeaponSlot(p.slot) ? `<label>武器类型</label><select id="ed-wtype">${optionList(WEAPON_TYPES(), p.weaponType)}</select>` : ''}
      <label>承音</label><input type="checkbox" id="ed-chengyin" ${p.承音 ? 'checked' : ''}>
    </div>
    ${row('初始')}${[0, 1, 2, 3].map((i) => row('调律', i)).join('')}
    ${s.n > 0 ? editorEvalHtml(s) : ''}
    <div class="st-editor-btns">${buttons}</div>`;
}

// ===== 栏4 =====
// 用户定稿 2026-10-30：栏4 = 一张面板三段（毕业率 / 词条配额 / 属性面板），不给综合结论；
// 毕业率是「当前组合 vs 本方案毕业基准」的粗读数（单件换装对比仍只报 更好/更差/等价，不给数值）。
// 攻击区间合并行（用户定稿）：最小/最大不再各占一行，合成「X攻击」一行
//   正常         外功攻击  2813~6217
//   最小≥最大     外功攻击  6217↑               —— 反转后伤害固定取最小攻击
//   无相          无相攻击  250~79               —— 恒定按区间显示，不改写
const ATK_NO_REVERSE = new Set(['无相']);       // 无相攻击不参与反转改写

/** 属性攻击元素清单：派生自词条区间键（与 engine/panel.js attrAtkKeys 同源，盘点 §2.2 #6） */
function attrAtkElements() {
  const out = [];
  for (const k of Object.keys(state.affixes?.词条区间 || {})) {
    const m = /^最[小大](鸣金|裂石|牵丝|破竹|无相)攻击$/.exec(k);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 区间文本：{ text, reversed } —— 反转判定=最小≥最大（0/0 无数据除外），无相恒不反转 */
function atkRangeText(el, min, max) {
  const mn = fmtStatValue(`最小${el}攻击`, min);
  const mx = fmtStatValue(`最大${el}攻击`, max);
  const reversed = !ATK_NO_REVERSE.has(el) && min >= max && !(min === 0 && max === 0);
  return { text: reversed ? `${mn}↑` : `${mn}~${mx}`, reversed };
}

/** 合并行 HTML；单边缺键时退回原单行（保持旧样式） */
function atkPairRow(stats, el) {
  const minK = `最小${el}攻击`;
  const maxK = `最大${el}攻击`;
  const min = stats[minK];
  const max = stats[maxK];
  if (min == null && max == null) return '';
  if (min == null || max == null) {
    const k = min == null ? maxK : minK;
    return `<div><span>${escapeHtml(k)}</span><span>${escapeHtml(fmtStatValue(k, stats[k]))}</span></div>`;
  }
  const { text, reversed } = atkRangeText(el, min, max);
  const tip = ' title="最小≥最大：伤害固定取最小攻击"';
  return `<div><span>${escapeHtml(`${el}攻击`)}</span>`
    + `<span${reversed ? ` class="st-atk-rev"${tip}` : ''}>${escapeHtml(text)}</span></div>`;
}

// 护甲部位（定音计入 技能定音 的四件；武器/环/佩 的攻具定音不算——panel.js 同口径）
const ARMOR_DING_SLOTS = ARMOR_SLOTS.filter((s) => !攻具.includes(s));

/** 技能定音行的标签：用真实定音词条名（不用"指定技能增伤"/"技能定音"字样）；
 *  优先取已穿戴护甲上的实际定音名，其次方案 防具定音，最后兜底"技能定音" */
function dingyinLabel() {
  const names = [];
  for (const p of equippedList()) {
    if (!ARMOR_DING_SLOTS.includes(p?.slot)) continue;
    const n = p?.定音?.属性;
    if (n && !names.includes(n)) names.push(n);
  }
  if (names.length) return names.join('、');
  return (currentFlow() && currentFlow().防具定音) || '技能定音';
}

/**
 * 属性面板（用户定稿：单列平铺、固定字段顺序、无分组标题）
 * 顺序：外功攻击/外功穿透/无相攻击/主属性(攻击·穿透·加成)/其他属性攻击/三率/最终生效三率/
 *      会心·会意伤害加成/指定武学增伤/全武学增伤/全奇术增伤/对首领单位增伤/对玩家单位增效/
 *      技能定音(标签=定音词条名)/五维+气血最大值
 * 注：「其他属性攻击」与「指定武学增伤」只在非零时出现（零值过滤是 UI 的事——交接文档 §0.5）
 */
/**
 * 属性面板（栏4 底部，用户定稿 2026-10-30）：
 *   - 定序平铺、无分组标题；攻击=最小/最大合并一行（atkRangeText）；
 *   - **不再显示 体 / 御 / 气血最大值**（与配装决策无关，用户定稿删除）；
 *   - 三率不再单列「达标」与「溢出」两张表，直接给数值上色：
 *       红 = 超游戏机制上限（按上限值显示，真实面板值与上限写在 title）
 *       绿 = 已达方案达标线   黄 = 未达方案达标线
 *     两条口径不同：达标线 = 方案作者的期望值（不够好而已）；上限 = 游戏硬截断（超出完全浪费）。
 */
function statsHtml() {
  const o = state.overall;
  if (!o?.ok || !o.属性面板) return '<p class="muted">整体计算失败，无属性面板。</p>';
  const stats = o.属性面板;
  const main = state.data?.build?.selectors?.weapon_attribute || '';
  // 三率超游戏上限 → 直接显示上限值（真实值只在 hover），不弹任何溢出标记
  const capOf = (k) => {
    const def = RATE_CAPS[k];
    if (!def) return null;
    const cv = state.version?.constants?.[def.capKey];
    return typeof cv === 'number' ? cv : def.默认;
  };
  const thMap = new Map((o.监测?.达标行 || []).map((r) => [r.指标, r]));
  const rowHtml = (k, label = k) => {
    const raw = stats[k];
    const cap = capOf(k);
    const over = cap != null && raw > cap;
    const shown = over ? cap : raw;
    const th = thMap.get(k);
    let cls = '';
    let tip = '';
    if (over) {
      cls = ' st-v-over';
      tip = `面板值 ${pctFmt(raw)}，超出游戏上限 ${pctFmt(cap)}，按上限显示（${RATE_CAP_NOTE}）`;
    } else if (th) {
      if (th.达标) {
        cls = ' st-v-ok';
        tip = `已达方案达标线 ${pctFmt(th.阈值, 1)}（超出 ${pctFmt(th.当前值 - th.阈值, 1)}）`;
      } else {
        cls = ' st-v-low';
        tip = `未达方案达标线 ${pctFmt(th.阈值, 1)}，还差 ${pctFmt(th.差距, 1)}`;
      }
    }
    const tipAttr = tip ? ` title="${escapeHtml(tip)}"` : '';
    return `<div><span>${escapeHtml(label)}</span><span class="st-stat-v${cls}"${tipAttr}>${escapeHtml(fmtStatValue(k, shown))}</span></div>`;
  };
  const out = [];
  const push = (k, label) => { if (stats[k] != null) out.push(rowHtml(k, label)); };
  const pushAtk = (el) => { const h = atkPairRow(stats, el); if (h) out.push(h); };

  // 1~3 外功攻击 / 外功穿透 / 无相攻击
  pushAtk('外功');
  push('外功穿透');
  pushAtk('无相');
  // 4~6 主属性：攻击 / 穿透 / 加成
  if (main) {
    pushAtk(main);
    push(`${main}穿透`);
    push(`${main}加成`);
  }
  // 7 其他属性攻击（非主属性、非无相；非零才出）
  for (const el of attrAtkElements()) {
    if (el === main || el === '无相') continue;
    if (!stats[`最小${el}攻击`] && !stats[`最大${el}攻击`]) continue;
    pushAtk(el);
  }
  // 8~17 三率 → 最终生效三率 → 会心/会意伤害加成
  for (const k of ['精准率', '会心率', '会意率', '直接会心率', '直接会意率',
    '最终生效会心率', '最终生效会意率', '最终生效会心会意率', '会心伤害加成', '会意伤害加成']) push(k);
  // 18 指定武学增伤：按武器类型逐条列出（双武器=两条），非零才出
  for (const t of WEAPON_TYPES()) if (stats[`${t}武学增伤`]) push(`${t}武学增伤`);
  // 19~22 通用增伤
  for (const k of ['全武学增伤', '全奇术增伤', '对首领单位增伤', '对玩家单位增效']) push(k);
  // 23 技能定音（标签=定音词条名）
  push('技能定音', dingyinLabel());
  // 24~26 五维（用户定稿 2026-10-30：体 / 御 / 气血最大值 不再显示，只留劲/敏/势）
  for (const k of ['劲', '敏', '势']) push(k);
  return `<div class="st-stats">${out.join('')}</div>`;
}

/**
 * 弓玦显示名：原名后附俗称（精准弓/会心弓/会意弓）。
 * 俗称从它实际提供的面板属性派生（精准率→精准弓、会心率→会心弓、会意率→会意弓），不在代码里写死清单。
 * 用户定稿：三个弓玦分别标注，避免"惊弦/饮羽/追影"看不出加的是什么。
 */
function gongjueLabel(name) {
  const rec = state.version?.弓玦?.[name];
  if (!rec) return name;
  const kinds = Object.keys(rec).map((k) => `${k.replace(/率$/, '')}弓`);
  return kinds.length ? `${name}（${kinds.join('、')}）` : name;
}

/**
 * 口径卡——栏4 第 1 行（用户定稿 2026-10-30 第二十版）：
 *   左半 = 流派印章 + 竖排（流派名 / 分支·方案水墨横幅）
 *   右半 = 毕业率大字读数（从下方面板上移，与口径同卡同行）
 * 流派 UI 只留立绘 + 流派名（用户定稿：不挂元素角标、不标武器）。
 */
/** 配置（分支·方案）横幅：一条水墨条幅承载「分支 · 方案」当前值，点击开弹窗逐层选。
 *  用户定稿（2026-10-30）：分支/方案的切换频率低于切流派，不值得常驻两个下拉占版面，
 *  也不该用下拉（选项只有 1~2 个，下拉的成本全在「看不到有哪些选项」上）。
 *  文字用楷体 + 合成粗（本地字体只有 400 字重），靠字距与鎏金色做出「题额」的层次。 */
/** 当前配置的横幅文案：有分支写「分支·方案」，无分支只写方案（与官方「破竹·风」同款紧凑写法，
 *  中间不留空格——左栈在窄屏只有 ~118px，多两个空格就是 18px，足够把「大外流」挤成省略号）。 */
function configBandText() {
  const branches = branchesOf();
  const hasBranches = !(branches.length === 1 && branches[0] === null);
  return [hasBranches ? branchLabel(state.branch) : '', planLabel(state.plan)]
    .filter(Boolean).join('·');
}

/** 配置横幅的墨底（分支/方案横幅共用一张，跟随流派变色；缺图时回落到纯深底）。
 *  横幅底按**大流派**归并（鸣金/裂石/牵丝/破竹 各一张，同一大流派下仅外围飞溅像素有差异，
 *  肉眼同款），具体流派缺条目时回落到通用底 `TONGYONG.webp` 兜底。 */
function tagBgOf(schoolId) {
  if (!schoolId) return '';
  const ip = state.version.界面图片 || {};
  return slotImg(ip['流派横幅底']?.[schoolId] || ip['流派横幅底通用']);
}

/** 流派武学（用户定稿 2026-10-30 第二十三版）：当前流派的两门武学，两行「图标 + 名称」，
 *  展示在流派/分支/方案（左）与毕业率（右）之间。数据唯一来源 = version.json
 *  「界面图片.流派武学」（由素材库 official/index.json kongfu 段物化而来，图标已本地化）；
 *  流派缺表或某项缺图时整块/整行静默跳过（不占位、不报错）。 */
function kongfuListHtml() {
  const list = state.version.界面图片?.['流派武学']?.[state.school];
  if (!Array.isArray(list) || !list.length) return '';
  const rows = list.map((it) => {
    const src = slotImg(it.图);
    if (!src) return '';
    return `
      <div class="st-kf-row" title="${escapeHtml(it.名 || '')}">
        <img class="st-kf-icon" src="${src}" alt="" loading="lazy">
        <span class="st-kf-name">${escapeHtml(it.名 || '')}</span>
      </div>`;
  }).join('');
  if (!rows) return '';
  return `<div class="st-kj-kongfu">${rows}</div>`;
}

function koujingHtml() {
  const schoolName = state.meta?.name || SCHOOLS.find(([id]) => id === state.school)?.[1] || '';
  const art = slotImg(state.version.界面图片?.['流派图']?.[state.school]);
  const bandText = configBandText();
  const bandBg = tagBgOf(state.school);
  return `
    <section class="st-panel st-kj-panel">
      <div class="st-kj-row">
        <div class="st-kj-left">
          <button class="st-school-btn" data-act="openSchoolPicker" title="点击切换流派（装备库全局保留）">
            ${art ? `<img class="st-school-art" src="${art}" alt="" loading="lazy">` : ''}
          </button>
          <div class="st-kj-flows">
            <button class="st-school-name" data-act="openSchoolPicker"
                    title="点击切换流派（装备库全局保留）">${escapeHtml(schoolName || state.school || '未选择')}</button>
            <div class="st-config-wrap">
              <button class="st-config-band ${state.configPicker ? 'on' : ''}" data-act="toggleConfigPicker"
                      style="--tag-bg:${cssUrl(bandBg)}"
                      aria-haspopup="true" aria-expanded="${state.configPicker ? 'true' : 'false'}"
                      title="点击选择分支 / 方案（每个配置各存一套已穿戴，装备库全局保留）">
                <span class="st-config-band-t">${escapeHtml(bandText || '未选择配置')}</span>
              </button>
              ${state.configPicker ? configMenuHtml() : ''}
            </div>
          </div>
        </div>
        ${kongfuListHtml()}
        <div class="st-kj-grad" id="st-grad-box">
          <div class="st-sec-title"><span>毕业率</span></div>
          ${gradRateHtml()}
        </div>
      </div>
    </section>`;
}

/** 心法卡——栏4 第 2 行（用户定稿 2026-10-30 第二十版）：四本心法从口径卡里拆出来独立成卡，
 *  一整行平铺；卡片尺寸由本卡宽度反解的 --mind-w 决定（见 studio.css .st-minds）。 */
function mindsHtml() {
  return `
    <section class="st-panel st-minds-panel">
      <div class="st-minds">${xinfaStripHtml()}</div>
    </section>`;
}

/** 配置菜单的可选项 = (分支 × 方案) 的**完整组合**，一条一个组合（2026-10-30 第七版）。
 *  为什么不拆成「分支一段 + 方案一段」：那样选一个配置要点两次、还会经过「分支已换但这分支
 *  没有该方案」的中间态；组合列表点一下就直达，选项数最多 2×2 = 4 条，一屏放得下。
 *  顺序 = 方案优先、分支次之（纯唐·小外 / 双切·小外 / 纯唐·大外 / 双切·大外）。
 *  方案矩阵可以不齐（分支 A 只有大外、分支 B 大小外都有），所以逐分支取并集再回填。 */
function configOptions() {
  const branches = branchesOf();
  const hasBranches = !(branches.length === 1 && branches[0] === null);
  if (!hasBranches) return plansOf(null).map((plan) => ({ branch: null, plan }));
  const planOrder = [];
  for (const b of branches) for (const p of plansOf(b)) if (!planOrder.includes(p)) planOrder.push(p);
  const out = [];
  for (const p of planOrder) for (const b of branches) {
    if (plansOf(b).includes(p)) out.push({ branch: b, plan: p });
  }
  return out;
}

/** 配置（分支 · 方案）展开菜单：点横幅后在它正下方原样展开一列水墨条，选完自动收起。
 *  每条**复用 `.st-config-band`**（用户定稿第七版：展开的墨条要与页面上的横幅同大、左对齐；
 *  所以不再另设尺寸，宽度 100% + 同一个 5:1 比例 + 同一套字号，天然就是同宽同高）。
 *  菜单容器本身**没有背景框**（不要底色卡、不要内边距、不要圆角阴影）——墨条直接浮在页面上。
 *  收起时机：点条目（切换后）、点菜单与横幅以外的地方、Esc、开任何其他弹窗。 */
function configMenuHtml() {
  const bandBg = tagBgOf(state.school);
  const branches = branchesOf();
  const hasBranches = !(branches.length === 1 && branches[0] === null);
  const item = ({ branch, plan }) => {
    const on = (branch ?? null) === (state.branch ?? null) && plan === state.plan;
    const label = [hasBranches ? branchLabel(branch) : '', planLabel(plan)].filter(Boolean).join('·');
    return `
    <button class="st-config-band st-cfg-item ${on ? 'on' : ''}" role="menuitem"
            data-act="pickConfig" data-branch="${escapeHtml(branch ?? '')}" data-plan="${escapeHtml(plan ?? '')}"
            style="--tag-bg:${cssUrl(bandBg)}" aria-current="${on ? 'true' : 'false'}"
            title="${escapeHtml(label)}">
      <span class="st-config-band-t">${escapeHtml(label)}</span>
    </button>`;
  };
  return `<div class="st-config-menu" role="menu">${configOptions().map(item).join('')}</div>`;
}

/** 流派选择模态框（站点 MartialBuildPicker 同款）：立绘卡片网格，当前流派高亮，点击直接切换。
 *  卡片只留立绘 + 流派名（用户定稿：不挂元素角标、不标武器） */
/** 某流派下所有「分支·方案」（数据来自跨流派清单 XFLOW；未加载时返回空数组） */
function flowsOfSchool(schoolId) {
  return (XFLOW.entries || [])
    .filter((e) => e.school === schoolId)
    .map((e) => {
      const fid = String(e.key).slice(String(schoolId).length + 1); // '分支.方案' 或 '方案'
      const i = fid.indexOf('.');
      return {
        branch: i > 0 ? fid.slice(0, i) : null,
        plan: i > 0 ? fid.slice(i + 1) : fid,
        // label 是「流派·分支·方案」：二级页里已在标题写流派，条目不用再重复
        label: String(e.label || '').split('·').slice(1).join('·') || fid,
      };
    });
}

/**
 * 流派印章网格（2026-11-02 玩家定稿）。
 *
 * 点一枚多配置的印章 ⇒ **只有这一格**动：印章左滑淡出、原位滑入该流派的分支·方案水墨条；
 * 其余印章一动不动（不换页、不重排）。点条目即切、弹窗关闭。
 * 只有一套配置的流派（鸣金虹/鸣金英/裂石威）点了直接切，不展开。
 */
function schoolPickerHtml() {
  const openId = state.schoolPicker?.school || null;
  const loading = !XFLOW.entries;
  const cells = schoolList().map(([id, name]) => {
    const art = slotImg(state.version.界面图片?.['流派图']?.[id]);
    const flows = flowsOfSchool(id);
    const multi = flows.length > 1;
    const isOpen = multi && openId === id;
    const bg = tagBgOf(id); // 水墨条底：用该流派自己的横幅底，跟主页面的配置横幅同款
    const list = multi ? `<div class="st-flow-list"${bg ? ` style="--tag-bg:${cssUrl(bg)}"` : ''}>${flows.map((f) => {
      const cur = id === state.school
        && (f.branch ?? null) === (state.branch ?? null)
        && (f.plan ?? null) === (state.plan ?? null);
      return `<button class="st-config-band st-cfg-item${cur ? ' on' : ''}" data-act="gotoFlow"
        data-school="${escapeHtml(id)}"
        data-branch="${escapeHtml(f.branch || '')}"
        data-plan="${escapeHtml(f.plan || '')}"><span class="st-config-band-t">${escapeHtml(f.label)}</span></button>`;
    }).join('')}</div>` : '';
    return `<div class="st-school-cell${multi ? ' multi' : ''}${isOpen ? ' open' : ''}"
        data-act="pickSchoolSeal" data-id="${escapeHtml(id)}"
        title="${escapeHtml(name)}${multi ? `（${flows.length} 套配置）` : ''}">
      <div class="st-school-card ${id === state.school ? 'on' : ''}">
        ${art ? `<img class="st-school-card-art" src="${art}" alt="" loading="lazy">` : ''}
        <span class="st-school-card-name">${escapeHtml(name)}</span>
      </div>
      ${list}
    </div>`;
  }).join('');
  return modalShellHtml('选择配置', null, '', `
    ${loading ? '<p class="st-picker-hint">正在读取各流派的方案…</p>' : ''}
    <div class="st-school-grid">${cells}</div>`);
}

/**
 * 角色管理模态框（多角色，用户定稿 2026-10-30）：
 *   list   = 角色卡网格（点卡即切换；卡内「改」重命名、「删」删除）
 *   rename = 重命名表单；delete = 删除二次确认（显示将删掉的装备件数）
 */
function charPickerHtml() {
  const d = state.charPicker || { mode: 'list', target: null, draftName: '' };
  const list = charList();
  if (d.mode === 'rename') {
    const c = state.roster[d.target];
    return modalShellHtml('重命名角色', null, '', `
      <div class="st-char-form">
        <label for="char-rename-input">角色名</label>
        <input id="char-rename-input" type="text" maxlength="16" value="${escapeHtml(d.draftName ?? c?.name ?? '')}" placeholder="例如：大号·鸣金虹">
      </div>
      <div class="st-picker-foot">
        <button class="primary" data-act="charRenameConfirm">确认</button>
        <button class="ghost" data-act="charCancel">取消</button>
      </div>`);
  }
  if (d.mode === 'delete') {
    const c = state.roster[d.target];
    const n = charCountOf(c);
    return modalShellHtml('删除角色', null, '', `
      <ul class="warnings">
        <li>确定删除角色「${escapeHtml(c?.name || '')}」？将同时删除它的 ${n.total} 件装备（已配 ${n.sets} 套），<b>不可恢复</b>。</li>
      </ul>
      <div class="st-picker-foot">
        <button class="primary" data-act="charDeleteConfirm">确认删除</button>
        <button class="ghost" data-act="charCancel">取消</button>
      </div>`);
  }
  const cards = list.map((c) => {
    const n = charCountOf(c);
    const on = c.id === state.charId;
    const canDelete = list.length > 1; // 至少留一个角色
    return `
      <div class="st-char-card ${on ? 'on' : ''}" data-act="pickChar" data-id="${escapeHtml(c.id)}" title="${on ? '当前角色' : '切换到该角色'}">
        <span class="st-char-name">${escapeHtml(c.name || '')}</span>
        <span class="st-char-meta">${escapeHtml(schoolNameOf(c.school))}</span>
        <span class="st-char-meta">装备 ${n.total} 件 · 已配 ${n.sets} 套</span>
        <span class="st-char-ops">
          <button class="ghost st-char-op" data-act="charRename" data-id="${escapeHtml(c.id)}" title="重命名">改</button>
          ${canDelete ? `<button class="ghost st-char-op danger" data-act="charDelete" data-id="${escapeHtml(c.id)}" title="删除该角色及其全部装备">删</button>` : ''}
        </span>
      </div>`;
  }).join('');
  return modalShellHtml('角色', null, '', `
    <p class="st-picker-hint">一个账号一个角色：装备、流派与口径都按角色独立保存，<b>互不互通</b>。点卡片切换；新建的角色是空白的（流派沿用当前）。</p>
    <div class="st-char-grid">${cards}</div>
    <div class="st-char-new">
      <input id="char-new-name" type="text" maxlength="16" placeholder="新角色名（留空自动命名）" value="${escapeHtml(d.draftName || '')}">
      <button class="primary" data-act="charCreate">＋ 新建角色</button>
    </div>`);
}

/** 顶栏角色按钮：显示当前角色名（多角色入口） */
function renderCharButton() {
  const el = document.querySelector('#app-char-btn');
  if (!el) return;
  const n = charList().length;
  el.textContent = state.charName || DEFAULT_CHAR_NAME;
  el.title = `切换/新建角色（共 ${n} 个）——各角色的装备与口径互不互通`;
}

/** 心法条（对齐燕小叽站点 HomeMindMartialPanel 心法条）：四张图标横排，空位用占位图；
 *  点击任一槽 → 弹心法选择模态框（站点 TimelineMindPickerModal 同款交互）。
 *  名称已烧录在图标图内（站点同款），故有图不再外挂标签；空位才标「未选择」。
 *  用户定稿（第二十版）：独立成卡放在口径卡下一行，不再与流派/分支/方案同卡 */
function xinfaStripHtml(size = null) {
  return [0, 1, 2, 3].map((i) => {
    const key = state.selections.心法[i] || '';
    const attrs = state.version.心法?.[key] || {};
    const rows = Object.entries(attrs).map(([k, v]) => `${k} ${fmtAffixValue(k, v)}`).join('；');
    const tip = key ? `${key}：${rows || '无心法属性'}` : '未选择心法——点击选择';
    return `
      <div class="st-mind" data-act="openMindPicker" title="${escapeHtml(tip)}">
        ${mindTileHtml(key, size, { card: true })}
        ${key ? '' : '<span class="st-mind-name">未选择</span>'}
      </div>`;
  }).join('');
}

/** 心法选择模态框（站点 TimelineMindPickerModal 同款）：上排四个当前槽位（点击切换编辑目标，
 *  × 清空），下方可选心法网格（图标+名，悬停看属性）；点选进草稿，确认后统一应用 */
function mindPickerHtml() {
  const d = state.mindPicker;
  const slots = [0, 1, 2, 3].map((i) => {
    const key = d.minds[i] || '';
    return `
      <div class="st-picker-opt st-mind-slot ${d.active === i ? 'active' : ''}" data-act="mindSlot" data-idx="${i}"${d.minds[i] ? ` data-q="${mindMeta().get(d.minds[i])?.quality || ''}"` : ''}>
        ${mindTileHtml(key, 64)}
        <span class="n">${escapeHtml(key || '未选择')}</span>
        ${key ? `<button class="st-mind-clear" data-act="mindClear" data-idx="${i}" title="清空此槽">×</button>` : ''}
      </div>`;
  }).join('');
  const meta = mindMeta();
  const opts = Object.keys(state.version.心法).map((k) => {
    const rows = Object.entries(state.version.心法[k] || {}).map(([a, v]) => `${a} ${fmtAffixValue(a, v)}`).join('；');
    // data-q（金/蓝/紫）只给配色用：弹窗格子太小放不下流派横幅，用品质色描边区分稀有度
    const q = meta.get(k)?.quality || '';
    return `
      <div class="st-picker-opt ${d.minds[d.active] === k ? 'active' : ''}" data-act="mindPick" data-key="${escapeHtml(k)}"${q ? ` data-q="${q}"` : ''} title="${escapeHtml(rows)}">
        ${mindTileHtml(k, 44)}
        <span class="n">${escapeHtml(k)}</span>
      </div>`;
  }).join('');
  return modalShellHtml('选择心法', null, '', `
    <section class="st-picker-sec">
      <h4>当前槽位（点击选择要更换的位置）</h4>
      <div class="st-mind-slots">${slots}</div>
    </section>
    <div class="st-picker-scroll">
      <section class="st-picker-sec">
        <h4>可选心法（${Object.keys(state.version.心法).length} 种）</h4>
        <div class="st-picker-grid">${opts}</div>
      </section>
    </div>
    <div class="st-picker-foot">
      <button class="primary" data-act="confirmMindPicker">确认</button>
      <button class="ghost" data-act="closeModal">取消</button>
    </div>`);
}

// ===== 毕业率读数（现挂在口径卡右半，#st-grad-box 在 .st-kj-grad 里） =====

// ===== 栏4：毕业率 + 词条配额 + 属性面板（合成一张面板，用户定稿 2026-10-30） =====

/**
 * 毕业率读数：当前装备组合 DPS / 本方案毕业基准。
 * 基准 = 按配额物化出的毕业装备（`computeGraduateDps`），是配额的一个**可行解**而非上限，
 * 所以超过 100% 是正常现象（多选池方案可能略高），这里只做「到没到毕业线」的粗读数。
 * 配色：≥100% 绿 / ≥90% 黄 / 其余红；基准不可用时灰字说明原因。
 */
function gradRateHtml() {
  const rate = state.overall?.ok ? state.overall.DPS?.graduationRate : null;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    const why = !state.data ? '技能轴未提供'
      : !state.prescription ? '无配额模板'
      : '毕业基准计算失败（回退基准也不可用）';
    return `<div class="st-grad-row"><span class="st-grad-num tone-none">—</span>
      <span class="st-grad-note">${escapeHtml(why)}</span></div>`;
  }
  const tone = rate >= 1 ? 'ok' : rate >= 0.9 ? 'low' : 'bad';
  return `<div class="st-grad-row"><span class="st-grad-num tone-${tone}">${pctFmt(rate, 1)}</span></div>`;
}

// ===== 栏4：口径+毕业率（第 1 行）→ 心法（第 2 行）→ 配额 + 属性面板（第 3/4 行，合成一张面板） =====

/**
 * 组合总览（评价系统设计.md §11.8）：当前这套在**现有装备库**里还能不能更好。
 * 结果按 key 缓存——key 含"穿了哪些件 + 池子大小 + 配置 + 毕业基准"，只有这些变了才重算。
 * 判定恒在计数层剪枝，实测 8 件 × 2 候选约 100ms，可随换装即时重算。
 */
function computeSearchSafe() {
  const flow = currentFlow();
  if (!state.data || !state.prescription || !flow) return null;
  const worn = equippedList().map((g) => g.uid ?? g.slot).join(',');
  const key = `${state.school}|${state.branch}|${state.plan}|${state.pool.length}|${worn}|${state.graduate?.dps ?? ''}`;
  if (state.search && state.search.key === key) return state.search.result;
  let result;
  try {
    result = searchBestComposition({
      buildCtx: state.data, version: state.version, affixes: state.affixes,
      selections: state.selections,
      prescription: state.prescription, flow,
      pool: state.pool, currentGear: equippedList(),
      deadZone: flow.死区 ?? 0.005,
      graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
    });
  } catch (err) {
    result = { ok: false, errors: [String(err.message || err)] };
  }
  state.search = { key, result };
  return result;
}

/** 组合总览卡：一句话结论 + 可执行的换件清单（不给备选、不解释算法） */
/**
 * 组合总览（2026-11-02 玩家定稿）：右栏常驻卡撤掉，改成「背包·组合」按钮点开的模态框，
 * 以及助手主动提示时附带的一张卡。
 * 理由：它是"要不要换一整组"的一次性结论，不是每时每刻要盯着的读数；
 * 常驻在右栏既占掉属性面板的高度，又把结论与明细拆在两处。
 */
function compositionBodyHtml() {
  const r = computeSearchSafe();
  if (!r) return '<p class="muted">暂无可用的组合结果</p>';
  if (!r.ok) {
    return `<p class="muted">搜索失败：${escapeHtml((r.errors || ['未知错误'])[0])}</p>`;
  }
  if (r.status === 'optimal' || r.status === 'infeasible') {
    return `<p class="st-say">${escapeHtml(r.message)}</p>`;
  }
  const rows = r.swapIn.map((s) => {
    const nm = [s.piece?.初始?.属性, ...(s.piece?.调律 || []).map((t) => t?.属性)]
      .filter(Boolean).join(' / ');
    const conv = s.conversion ? `（转「${escapeHtml(s.conversion.from)}」→「${escapeHtml(s.conversion.to)}」）` : '';
    return `<li><b>${escapeHtml(s.slot)}</b>　${escapeHtml(nm)}${conv}</li>`;
  }).join('');
  const more = r.truncated ? '<p class="muted">（搜索量已达上限，结果可能不是全局最优）</p>' : '';
  return `<p class="st-say"><b>${escapeHtml(r.message)}</b></p><ul class="st-comp-list">${rows}</ul>${more}`;
}

function compositionModalHtml() {
  return modalShellHtml('组合总览', null, '', compositionBodyHtml());
}

/** 组合里"有活可干"（结论不是最优）—— 背包标题的小圆点与助手提示共用这一处判断 */
function compositionImproved() {
  const r = state.search?.result;
  return !!(r && r.swapIn?.length && r.status !== 'optimal' && r.status !== 'infeasible');
}

function renderRight() {
  const o = state.overall;
  const errs = o && !o.ok
    ? `<ul class="warnings">${(o.errors || ['整体计算失败']).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
    : '';
  // 词条配额（缺口/溢出配色）；三率达标与上限溢出已并入属性面板配色，不再单列
  const quota = o?.ok && o.监测
    ? digestHtml(o.监测)
    : '<p class="muted">无配额模板——配额不可用。</p>';
  const panelWarnings = o?.ok && o.面板警告?.length
    ? `<ul class="warnings">${o.面板警告.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : '';
  rightEl.innerHTML = `
    ${koujingHtml()}
    ${mindsHtml()}
    <section class="st-panel" id="st-main-panel">
      <div class="st-block" id="st-quota-box">
        <div class="st-sec-title"><span>词条配额</span></div>
        ${errs}${quota}${panelWarnings}
      </div>
      <div class="st-block" id="st-stats-box">
        <div class="st-sec-title"><span>属性面板</span></div>
        ${statsHtml()}
      </div>
    </section>`;
}

// ---------- 评价明细（与评价器同款展示） ----------

/**
 * 配额行的显示名：把「最小X攻击/最大X攻击」合并成「X攻击」（与属性面板同口径），
 * 任选池（any_of）才不至于一串显示不全。例：
 *   最大裂石/最小裂石/最大无相/最小无相（共 8）→ 裂石攻击/无相攻击
 * 完整候选名仍在行 title 里（悬停可见），统计口径不变（仍按原始词条名计数）。
 */
function quotaLabel(members) {
  const list = members.map(String);
  // 只有该元素的最小/最大**同时**在池里才合并；只有单边时保留原名
  // （否则小外流的「最小外功攻击 ×12」会被误显示成「外功攻击」，与大外流混淆）
  const both = new Map();
  for (const m of list) {
    const mm = /^最(小|大)(.+?)攻击$/.exec(m);
    if (!mm) continue;
    const rec = both.get(mm[2]) || { min: false, max: false };
    rec[mm[1] === '小' ? 'min' : 'max'] = true;
    both.set(mm[2], rec);
  }
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const mm = /^最[小大](.+?)攻击$/.exec(m);
    if (mm && both.get(mm[1]).min && both.get(mm[1]).max) {
      if (seen.has(mm[1])) continue;
      seen.add(mm[1]);
      out.push(`${mm[1]}攻击`);
    } else out.push(m);
  }
  return out.join('/');
}

/**
 * 词条配额块（栏4 中段）：只留配额记账与小外流启用度。
 * 三率达标 / 三率上限溢出**不再单列**（用户定稿 2026-10-30）——它们已经并入属性面板的数值配色，
 * 与属性面板里的同一行数字一一对应，避免同一个指标在两个地方各说一遍。
 */
function digestHtml(d) {
  const parts = [];
  // 配额：缺口/溢出/未配额三合一（用户定稿）——统一「词条名：实装/需要」，只给数值上色：
  //   相等=绿 / 少于=黄 / 多于=红 / 未配额（需要 0）整行红
  const qRows = (d.配额行 || []).map((r) => {
    const cls = r.缺口 > 0 ? 'low' : r.溢出 > 0 ? 'over' : 'ok';
    const tip = r.缺口 > 0 ? `缺 ${r.缺口} 条` : r.溢出 > 0 ? `多 ${r.溢出} 条` : '配额已满足';
    return `<div class="st-qrow" title="${escapeHtml(`任选池：${r.词条.join(' / ')}`)}">`
      + `<span>${escapeHtml(quotaLabel(r.词条))}</span>`
      + `<span class="st-q-${cls}" title="${escapeHtml(tip)}">${r.实装}/${r.需要}</span></div>`;
  });
  const unRows = Object.entries(d.未配额词条 || {}).map(([k, n]) =>
    `<div class="st-qrow st-q-over" title="未在方案配额中（白占槽位）"><span>${escapeHtml(k)}</span>`
    + `<span class="st-q-over">${n}/0</span></div>`);
  if (qRows.length || unRows.length) {
    parts.push(`<div class="digest">${qRows.join('')}${unRows.join('')}</div>`);
  }
  // 小外流启用度（仅小外流方案）：已达成（最小>最大）不提示；未达成只陈述事实，不下结论
  const e = d.启用度;
  if (e?.适用 && !e.已达反转) {
    parts.push(`<div class="digest"><div class="digest-title">小外流启用度</div>`
      + `<div class="st-xw-alert">⚠ 当前最小外功攻击 ${e.最小外功攻击.toFixed(0)} 小于最大外功攻击 ${e.最大外功攻击.toFixed(0)}</div></div>`);
  }
  if (!parts.length) return '<p class="muted">配额全部满足。</p>';
  return parts.join('');
}

// ---------- 转律建议（全局感知）与跨方案适配（用户定稿 2026-10-28/29） ----------
//   四条信息：① 当前方案的当前品阶 ② 当前方案的转律建议（前两条直接展示）
//             ③ 跨方案的品阶 ④ 跨方案转律建议（后两条折叠）
//   结构型/优化型不区分措辞；并列项平铺。

const PLAN_CN = { dawai: '大外流', xiaowai: '小外流' };

/** 当前整套装备 → DPS；build 缺失时返回 null（转律建议降级为不做 DPS 决胜） */
function dpsOfGear(gear) {
  if (!state.data || !state.version || !state.affixes) return null;
  try {
    return evalGearDps({
      buildCtx: state.data, version: state.version, affixes: state.affixes,
      gear, selections: state.selections,
      graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
    }).dps;
  } catch { return null; }
}

/**
 * 本件 + 当前已穿戴 = 评价用的整套（"假设穿上"）：
 * 背包/新录入件不在 equippedList 里，需顶替同部位（武器按同类型）的已穿戴件；无同部位则追加。
 */
function gearWithPiece(piece) {
  const list = equippedList();
  // **uid 优先**：同类型可能有两件（双枪流派），按类型顶替会换错那一件（§12.4）
  const i = piece?.uid != null ? list.findIndex((g) => g?.uid === piece.uid) : -1;
  if (i >= 0) return list.map((g, k) => (k === i ? piece : g));
  const isW = piece.slot === WEAPON_SLOT;
  let replaced = false;
  const out = list.map((g) => {
    if (replaced) return g;
    if (isW) {
      if (g.slot === WEAPON_SLOT && String(g.weaponType ?? '') === String(piece.weaponType ?? '')) {
        replaced = true; return piece;
      }
    } else if (g.slot === piece.slot) { replaced = true; return piece; }
    return g;
  });
  if (!replaced) out.push(piece);
  return out;
}

/**
 * 多槽桶已满时：算出该把哪一件换下来（桶语义，评价系统设计.md §12.2）。
 * 优先用 evaluateSwap 的 targetIndex（= ΔDPS 最优的被替换者）；算不出来则回退到"档位最低的那件"。
 */
function pickBucketSlotToReplace(boundKeys, piece) {
  try {
    if (state.data && state.version && state.affixes && state.prescription) {
      const gear = equippedList();
      const r = evaluateSwap({
        buildCtx: state.data, version: state.version, affixes: state.affixes,
        selections: state.selections, currentGear: gear, newItem: piece,
        prescription: state.prescription,
        deadZone: currentFlow()?.死区,
        graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
      });
      if (r.ok && r.targetIndex >= 0) {
        const target = gear[r.targetIndex];
        const k = EQUIP_KEYS.find((kk) => state.equipped[kk] === target);
        if (k) return k;
      }
    }
  } catch { /* 回退到档位比较 */ }
  const rank = { 天: 3, 地: 2, 玄: 1, 黄: 0 };
  let worst = null;
  let worstRank = Infinity;
  for (const k of boundKeys) {
    const g = state.equipped[k];
    if (!g) continue;
    let r = 0;
    try {
      const gd = gradeItem(state.prescription, g.slot, toGradeItem(g));
      r = gd.ok && gd.tier ? rank[gd.tier] : 0;
    } catch { r = 0; }
    if (r < worstRank) { worstRank = r; worst = k; }
  }
  return worst || boundKeys[0];
}

/** 全流派方案缓存（懒加载，只在首次展开跨方案时拉取一次） */
const XFLOW = { entries: null, loading: null };

/** 方案标签：流派名·分支中文名·方案中文名（分支中文名唯一来源 = _meta.json.分支.<id>.name） */
function flowLabel(meta, schoolName, branch, plan) {
  const bn = branch ? (meta?.分支?.[branch]?.name || branch) : '';
  const pn = PLAN_CN[plan] || plan || '';
  return [meta?.name || schoolName, bn, pn].filter(Boolean).join('·');
}

async function ensureCrossFlows() {
  if (XFLOW.entries) return XFLOW.entries;
  if (XFLOW.loading) return XFLOW.loading;
  XFLOW.loading = (async () => {
    const out = [];
    for (const [id, name] of (SCHOOLS || [])) {
      let meta, flows = [];
      try { meta = await loadSchoolMeta(id); } catch { continue; }
      const wt = (meta?.武器 || []).map(String);
      try { flows = (await loadFlows(id)).flows || []; } catch { continue; }
      for (const f of flows) {
        const pr = derivePrescription(state.affixes, f, wt);
        if (!pr || !pr.feasible) continue;
        out.push({
          key: `${id}.${f.flowId ?? ''}`, school: id,
          label: flowLabel(meta, name, f.branch ?? null, f.plan ?? null),
          weaponTypes: wt, rx: pr,
        });
      }
    }
    XFLOW.entries = out;
    return out;
  })();
  return XFLOW.loading;
}

/** ③④ 跨方案：只列「当前即天档」与「转律后可达天档」的方案；其他方案的地/玄/黄不提醒 */
async function fillCrossFlow(bodyEl, piece) {
  bodyEl.innerHTML = '<span class="muted">加载中…</span>';
  let entries;
  try { entries = await ensureCrossFlows(); } catch (err) {
    bodyEl.innerHTML = `<span class="muted">加载失败：${escapeHtml(err.message)}</span>`;
    return;
  }
  const curKey = `${state.school}.${currentFlow()?.flowId ?? ''}`;
  const isW = piece.slot === WEAPON_SLOT;
  const myType = String(piece.weaponType ?? '');
  // 武器件只评"该流派携带此类型"的方案；且排除当前方案（已在上面直接展示）
  const pool = (entries || []).filter((e) => e.key !== curKey
    && (!isW || e.weaponTypes.includes(myType)));
  let res;
  try {
    res = surveyFlows(pool, piece.slot, toGradeItem(piece));
  } catch (err) {
    bodyEl.innerHTML = `<span class="muted">计算出错：${escapeHtml(err.message)}</span>`;
    return;
  }
  const parts = [];
  if (res.天档.length) {
    parts.push(`<div class="digest"><div class="digest-title">当前即天档的方案</div>${
      res.天档.map((x) => `<div>${escapeHtml(x.label)}</div>`).join('')}</div>`);
  }
  if (res.可转天.length) {
    parts.push(`<div class="digest"><div class="digest-title">转律后可达天档的方案</div>${
      res.可转天.map((x) => `<div>${escapeHtml(x.label)}（当前${escapeHtml(x.tier)}）　${
        x.routes.map((r) => `将「${escapeHtml(r.from)}」转为「${escapeHtml(r.to)}」`).join('；')
      }</div>`).join('')}</div>`);
  }
  bodyEl.innerHTML = parts.join('') || '<span class="muted">其他方案下均非天档，且转律也无法达到天档</span>';
}

/** 跨方案折叠区（占位；展开时才加载并填充） */
function crossFlowHtml(piece, kind, refKey, summaryText = '') {
  // 背包件：入口是第四段里的「N 套方案」那个词，所以 summary 隐藏（保留 details 是为了懒加载）。
  // 已穿戴件没有那段话（它还没有整合），仍需要一个可见入口，由调用方传 summaryText。
  const summary = summaryText
    ? `<summary class="st-btn-link">${escapeHtml(summaryText)}</summary>`
    : '<summary hidden></summary>';
  return `<details class="st-xflow" data-kind="${escapeHtml(kind)}" data-ref="${escapeHtml(refKey)}">
    ${summary}
    <div class="xflow-body"><span class="muted">展开后加载…</span></div>
  </details>`;
}

// ---------- 事件绑定 ----------

/**
 * 落盘（多角色 + 装备库结构，用户定稿 2026-10-30）：
 *   { 版本: 3, 当前角色, 角色: { [id]: 角色快照 } }
 * 角色快照 = name + school/branch/plan + selections + pool + loadouts —— **装备按角色隔离**；
 *   pool = 该角色全部装备件（唯一，按 uid），loadouts = 每个「流派|分支|方案」各存一份已穿戴。
 * ⚠ 顶层与角色内仍冗余写 equipped/backpack 视图：万一回到旧版页面也能看到最后使用的角色（不丢数据）。
 */
function save() {
  const snap = currentCharSnapshot();
  state.roster[state.charId] = { ...(state.roster[state.charId] || {}), ...snap };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    版本: 3, 当前角色: state.charId, 角色: state.roster,
    // 旧字段冗余（兼容旧版页面读取）
    school: snap.school, branch: snap.branch, plan: snap.plan,
    buildId: state.buildId, flowId: flowIdOf(snap.branch, snap.plan),
    selections: snap.selections, equipped: snap.equipped, backpack: snap.backpack,
  }));
}

/** 当前角色的完整快照（装备深拷贝，避免与切角色后的 state 共享引用） */
function currentCharSnapshot() {
  return {
    name: state.charName,
    school: state.school, branch: state.branch, plan: state.plan,
    selections: JSON.parse(JSON.stringify(state.selections)),
    pool: JSON.parse(JSON.stringify(state.pool)),
    loadouts: JSON.parse(JSON.stringify(state.loadouts)),
    // 旧字段冗余（equipped/backpack 视图）：旧版页面可读，也不至于丢了"穿了什么"的直觉
    equipped: JSON.parse(JSON.stringify(state.equipped)),
    backpack: JSON.parse(JSON.stringify(state.backpack)),
  };
}

/** 配置菜单的「点外部收起」document 监听只绑一次（bind 每次 render 都会跑） */
let configMenuDocBound = false;
let bagFilterDocBound = false;

function bind() {
  // 装备区（栏1 槽位 + 栏2 背包）统一在 #app 内扫——栏位会调整，元素不会消失
  // 背包卡片 → 直接开详情弹窗（再次点同一件取消）；空槽位 → 直接进入录入表单
  for (const el of mainEl.querySelectorAll('[data-sel-kind]')) {
    el.onclick = () => actions.select({
      kind: el.dataset.selKind,
      slot: el.dataset.selSlot || undefined,
      uid: el.dataset.selUid || undefined,
    });
  }
  // 栏1：已穿戴槽位（两段式，用户定稿 2026-10-30）→ 第一次筛背包同部位，第二次开详情弹窗
  for (const el of mainEl.querySelectorAll('[data-act="focusSlot"]')) {
    el.onclick = () => actions.focusSlot(el.dataset.slot);
  }
  // 栏2：背包标题里的筛选条 → 取消筛选，显示全部
  for (const el of mainEl.querySelectorAll('[data-act="clearBagFilter"]')) {
    el.onclick = () => actions.clearBagFilter();
  }
  for (const el of mainEl.querySelectorAll('[data-act="openEditor"]')) {
    el.onclick = () => actions.openEditor(el.dataset.slot);
  }
  // 背包标题：「组合」按钮 → 组合总览模态框（原右栏常驻卡，2026-11-02 挪过来）
  for (const el of mainEl.querySelectorAll('[data-act="openComposition"]')) {
    el.onclick = () => actions.openComposition();
  }
  // 栏1：第 5 列特殊槽（弓玦/武库）→ 弹出同一选择模态框
  for (const el of mainEl.querySelectorAll('[data-act="openSetPicker"]')) {
    el.onclick = () => actions.openSetPicker();
  }
  // 栏1：心法图标条 → 弹心法选择模态框
  for (const el of mainEl.querySelectorAll('[data-act="openMindPicker"]')) {
    el.onclick = () => actions.openMindPicker();
  }
  // 栏1：流派按钮 → 弹流派选择模态框；配置横幅 → 原地展开分支·方案菜单（不弹窗）
  for (const el of mainEl.querySelectorAll('[data-act="openSchoolPicker"]')) {
    el.onclick = () => actions.openSchoolPicker();
  }
  for (const el of mainEl.querySelectorAll('[data-act="toggleConfigPicker"]')) {
    el.onclick = () => actions.toggleConfigPicker();
  }
  // 配置菜单里的条目（在 #app 里，不在 modalEl 内，所以要单独绑）：一条 = 一个（分支·方案）组合
  for (const el of mainEl.querySelectorAll('[data-act="pickConfig"]')) {
    el.onclick = () => actions.pickConfig(el.dataset.branch, el.dataset.plan);
  }
  // 配置菜单：点「横幅 + 菜单」以外的任何地方都收起（bind 每次 render 都跑，用标志只绑一次）。
  // 用冒泡阶段：目标自己的 onclick 先跑，所以点横幅 toggle 时不会被执行两遍。
  if (!configMenuDocBound) {
    configMenuDocBound = true;
    document.addEventListener('click', (e) => {
      if (!state.configPicker) return;
      if (e.target instanceof Element && e.target.closest('.st-config-wrap')) return;
      state.configPicker = false;
      render();
    });
  }
  // 背包部位筛选：只有**离开「装备槽 + 背包 + 弹窗」这一整块**才取消部位选中
  // （用户定稿 2026-10-31 第二十八版：点背包里的卡看详情/穿脱，不代表要放弃筛选）。
  // 仍走冒泡阶段：目标自己的 onclick 先跑，点槽位设筛选时不会被这条立刻清掉。
  if (!bagFilterDocBound) {
    bagFilterDocBound = true;
    document.addEventListener('click', (e) => {
      if (!state.bagFilter) return;
      // ⚠ 必须用 composedPath()：点背包卡 → 详情弹窗在同一次点击里 render()，
      //   e.target 已经脱离 DOM，closest() 爬不到 #st-center，会被误判成「点到了别处」。
      //   composedPath 是派发那一刻就定下的路径，不受重渲染影响。
      const path = (typeof e.composedPath === 'function' ? e.composedPath() : [])
        .filter((n) => n instanceof Element);
      if (!path.length) return;
      // ① 背包列（卡片、空态、＋录入装备）与弹窗内部的任何操作 → 保留筛选
      if (path.some((n) => n.id === 'st-center' || n.id === 'st-modal')) return;
      // ② 点装备槽（含空槽）= 换/重设筛选目标，focusSlot 自己处理，这里不抢
      if (path.some((n) => n.dataset && n.dataset.act === 'focusSlot')) return;
      actions.clearBagFilter();
    });
  }
  // 栏2：背包内的「＋录入装备」按钮
  const openBtn = $('#st-open-editor');
  if (openBtn) openBtn.onclick = () => actions.openEditor();
  // 顶栏：角色按钮 → 弹角色管理模态框（多角色入口）
  const charBtn = $('#app-char-btn');
  if (charBtn) charBtn.onclick = () => actions.openCharPicker();
  bindBarCollapse(); // 移动端顶栏随内容收起
  // 弹窗：角色名输入框（只进草稿，不重渲染——否则每敲一个字就失焦）
  const charNew = $('#char-new-name');
  if (charNew) charNew.oninput = (e) => actions.setCharDraftName(e.target.value);
  const charRename = $('#char-rename-input');
  if (charRename) charRename.oninput = (e) => actions.setCharDraftName(e.target.value);
  // 弹窗：点遮罩关闭（点弹窗内部不关）
  const backdrop = modalEl.querySelector('.st-modal-backdrop');
  if (backdrop) {
    backdrop.onclick = (e) => { if (e.target === backdrop) actions.closeModal(); };
  }
  const edSlot = $('#ed-slot');
  if (edSlot) edSlot.onchange = (e) => actions.setDraftSlot(e.target.value);
  const wtype = $('#ed-wtype');
  if (wtype) wtype.onchange = (e) => actions.setDraftWeaponType(e.target.value);
  const chengyin = $('#ed-chengyin');
  if (chengyin) chengyin.onchange = (e) => actions.setDraftChengyin(e.target.checked);
  const edSave = $('#ed-save');
  if (edSave) edSave.onclick = () => actions.saveEdit();
  const edAdd = $('#ed-add');
  if (edAdd) edAdd.onclick = () => actions.addDraft();
  const edEquip = $('#ed-equip');
  if (edEquip) edEquip.onclick = () => actions.addAndEquip();
  const edDiscard = $('#ed-discard');
  if (edDiscard) edDiscard.onclick = () => actions.resetDraft();
  const edCancel = $('#ed-cancel');
  if (edCancel) edCancel.onclick = () => (state.editTarget ? actions.cancelEdit() : actions.cancelEditor());
  for (const el of modalEl.querySelectorAll('[data-ed-field]')) {
    el.onchange = onDraftFieldChange;
  }
  // 弹窗里的动作按钮（穿上/脱下/删除/关闭弹窗/套装选择）
  for (const el of modalEl.querySelectorAll('[data-act]')) {
    el.onclick = (e) => {
      e.stopPropagation();
      const { act, uid, slot, kind, key, idx, id } = el.dataset;
      if (act === 'equip') actions.equip(uid);
      else if (act === 'editPiece') actions.editPiece({ kind: el.dataset.kind, slot, uid });
      else if (act === 'unequip') actions.unequip(slot);
      else if (act === 'removeBackpack') actions.removeBackpack(uid);
      else if (act === 'removeEquipped') actions.removeEquipped(slot);
      else if (act === 'pickSchool') actions.pickSchool(id);
      // 流派 → 分支·方案 两级选择（2026-11-02）
      else if (act === 'pickSchoolSeal') actions.pickSchoolSeal(id);
      else if (act === 'backToSchools') actions.backToSchools();
      else if (act === 'gotoFlow') actions.gotoFlow(el.dataset.school, el.dataset.branch || null, el.dataset.plan || null);
      else if (act === 'pickOpt') actions.pickOption(kind, key);
      else if (act === 'confirmPicker') actions.confirmPicker();
      else if (act === 'mindSlot') actions.pickMindSlot(+idx);
      else if (act === 'mindPick') actions.pickMind(key);
      else if (act === 'mindClear') actions.clearMind(+idx);
      else if (act === 'confirmMindPicker') actions.confirmMindPicker();
      // 多角色：点卡切换 / 新建 / 重命名 / 删除（两处确认）/ 取消
      else if (act === 'pickChar') actions.pickChar(id);
      else if (act === 'charCreate') actions.createChar(state.charPicker?.draftName);
      else if (act === 'charRename') actions.requestRename(id);
      else if (act === 'charRenameConfirm') actions.confirmRename();
      else if (act === 'charDelete') actions.requestDelete(id);
      else if (act === 'charDeleteConfirm') actions.confirmDelete();
      else if (act === 'charCancel') actions.cancelCharForm();
      else if (act === 'closeModal') actions.closeModal();
      // 第四段里的「N 套方案」：展开/收起跨方案列表（details 的 toggle 事件负责懒加载）
      else if (act === 'toggleXflow') {
        const d = modalEl.querySelector('details.st-xflow');
        if (d) {
          d.open = !d.open;
          el.classList.toggle('open', d.open);
        }
      }
    };
  }
}

function onDraftFieldChange(e) {
  const { edKind: kind, edIdx, edField: field } = e.target.dataset;
  if (field === '转律') { actions.setDraftConverted(+edIdx, e.target.checked); return; }
  const target = kind === '调律' ? state.draft.调律[+edIdx] : state.draft[kind];
  if (field === '属性') {
    actions.setDraftAffix(kind, edIdx == null ? null : +edIdx, e.target.value);
  } else {
    const pct = isPercentAffix(target.属性);
    target.数值 = e.target.value === '' ? null : (pct ? +e.target.value / 100 : +e.target.value);
    save();
    render();
  }
}

// ---------- 动作（UI 事件与无头测试共用） ----------

const actions = {
  /**
   * 点击已穿戴槽位（两段式，用户定稿 2026-10-30）：
   *   第一次点 = 背包筛到同部位（不开弹窗）；再点同一槽 = 打开该件详情弹窗。
   *   点别的槽 = 换筛选目标（仍不开弹窗）。背包件不走这里——它一下就开弹窗。
   * @returns 'filter' | 'detail'
   */
  focusSlot(slot) {
    // 空槽：只筛背包，再点一次取消（2026-11-02 玩家定稿）。
    // 录入入口收敛到背包的「＋ 录入装备」——空槽不再弹表单。
    if (!state.equipped[slot]) {
      state.bagFilter = state.bagFilter === slot ? null : slot;
      state.selected = null;
      state.editing = false;
      state.editTarget = null;
      render();
      return 'filter';
    }
    const detail = state.bagFilter === slot;
    state.bagFilter = slot;
    state.selected = detail ? { kind: 'equipped', slot } : null;
    state.editing = false;
    state.editTarget = null;
    render();
    return detail ? 'detail' : 'filter';
  },

  /** 取消背包筛选（背包标题里「显示全部」）：回到全部装备、仍按品阶排序 */
  clearBagFilter() {
    state.bagFilter = null;
    render();
  },

  /** 点击背包件：选中 → 详情弹窗；再次点击同一件 → 取消选中 */
  select(ref) {
    const cur = state.selected;
    const same = cur && ref
      && cur.kind === ref.kind
      && (ref.kind === 'equipped' ? cur.slot === ref.slot : cur.uid === ref.uid);
    state.selected = same ? null : ref;
    state.editing = false;
    state.editTarget = null;
    render();
    return state.selected;
  },

  /** 打开录入表单；传 slot 可预选部位（栏1 空槽位点击；部位=武器 不分左右） */
  openEditor(slot) {
    state.editing = true;
    state.editTarget = null;
    state.selected = null;
    state.configPicker = false;
    if (slot && SLOTS.includes(slot) && slot !== state.draft.slot) {
      const cats = currentWeaponLabels();
      const wt = slot === WEAPON_SLOT
        ? ((state.draft.slot === WEAPON_SLOT && state.draft.weaponType) || cats[0] || '')
        : '';
      state.draft = newDraft(slot, wt, currentFlow(), state.affixes);
    }
    render();
  },

  cancelEditor() {
    state.editing = false;
    state.editTarget = null;
    render();
  },

  /** 「调律」：把已有装备读回表单改；保存时原地覆盖（已穿戴保留穿戴位，背包保留 uid） */
  editPiece(ref) {
    if (!ref) return false;
    const kind = ref.kind || (ref.uid ? 'backpack' : 'equipped');
    const piece = kind === 'equipped' ? state.equipped[ref.slot] : backpackByUid(ref.uid);
    if (!piece) return false;
    state.editTarget = { kind, slot: ref.slot, uid: ref.uid };
    state.draft = draftFromPiece(piece);
    state.editing = true;
    state.selected = null;
    render();
    return true;
  },

  /** 保存修改：原地覆盖，回到该件详情 */
  saveEdit() {
    const t = state.editTarget;
    if (!t) return false;
    const piece = draftPiece();
    // 改的是装备库里那一件（uid 不变，所有配置里穿它的地方同步生效）
    const uid = t.kind === 'equipped' ? state.equipped[t.slot]?.uid : t.uid;
    const i = state.pool.findIndex((b) => b.uid === uid);
    if (i < 0) return false;
    state.pool[i] = { ...piece, uid };
    rebuildGear();
    if (t.kind === 'equipped') state.selected = { kind: 'equipped', slot: t.slot };
    else state.selected = { kind: 'backpack', uid: t.uid };
    state.editTarget = null;
    state.editing = false;
    save(); render();
    return true;
  },

  /** 取消修改：放弃改动，回到该件详情（区别于取消录入：录入关闭后无详情可回） */
  cancelEdit() {
    const t = state.editTarget;
    state.editing = false;
    state.editTarget = null;
    if (t?.kind === 'equipped' && state.equipped[t.slot]) state.selected = { kind: 'equipped', slot: t.slot };
    else if (t?.kind === 'backpack' && backpackByUid(t.uid)) state.selected = { kind: 'backpack', uid: t.uid };
    render();
  },

  /** 关闭弹窗：录入中 → 放弃录入；装备详情 → 取消选中；套装/心法/流派选择 → 放弃（都回到无弹窗状态） */
  closeModal() {
    state.editing = false;
    state.editTarget = null;
    state.selected = null;
    state.picker = null;
    state.mindPicker = null;
    state.schoolPicker = null;
    state.configPicker = false;
    state.charPicker = null;
    state.composition = false;
    render();
  },

  /** 打开组合总览模态框（入口：背包卡标题的「组合」按钮 / 助手提示卡） */
  openComposition() {
    state.composition = true;
    state.selected = null;
    state.editing = false;
    state.editTarget = null;
    state.configPicker = false;
    render();
    return true;
  },

  /** 打开套装/弓玦/武库选择模态框（第 5 列特殊槽点击；站点同款：攻具/防具/弓玦/武库共用同一模态框） */
  openSetPicker() {
    state.picker = {
      装备套装: state.selections.装备套装,
      防具套装: state.selections.防具套装 || '',
      弓玦: state.selections.弓玦,
      武库: state.selections.武库,
    };
    state.editing = false;
    state.editTarget = null;
    state.selected = null;
    state.configPicker = false; // 收起配置菜单，免得浮层盖在新弹窗上
    render();
  },

  /** 模态框内点选（只进草稿，确认后才应用） */
  pickOption(kind, key) {
    if (!state.picker || !(kind in state.picker)) return;
    state.picker[kind] = key;
    render();
  },

  /** 确认：三类选择统一应用（一次 refresh + save + render） */
  confirmPicker() {
    if (!state.picker) return;
    const p = state.picker;
    state.selections.装备套装 = p.装备套装;
    state.selections.防具套装 = p.防具套装;
    state.selections.弓玦 = p.弓玦;
    state.selections.武库 = p.武库;
    state.picker = null;
    refreshGraduate();
    save();
    render();
  },

  /** 打开心法选择模态框（心法图标条点击；站点 TimelineMindPickerModal 同款）。
   *  默认编辑目标 = 第一个空槽（全满则为第 1 槽） */
  openMindPicker() {
    const minds = [0, 1, 2, 3].map((i) => state.selections.心法[i] || '');
    state.mindPicker = { active: Math.max(0, minds.findIndex((m) => !m)), minds };
    state.editing = false;
    state.editTarget = null;
    state.selected = null;
    state.picker = null;
    state.configPicker = false;
    render();
  },

  /** 模态框内切换编辑目标槽位 */
  pickMindSlot(idx) {
    if (!state.mindPicker) return;
    state.mindPicker.active = idx;
    render();
  },

  /** 点选心法进当前目标槽（草稿），并自动前进到下一个空槽 */
  pickMind(key) {
    const d = state.mindPicker;
    if (!d || d.active < 0) return;
    d.minds[d.active] = key;
    const next = d.minds.findIndex((m) => !m);
    if (next >= 0) d.active = next;
    render();
  },

  /** 清空某个槽（草稿） */
  clearMind(idx) {
    const d = state.mindPicker;
    if (!d) return;
    d.minds[idx] = '';
    d.active = idx;
    render();
  },

  /** 确认：四本心法统一应用 */
  confirmMindPicker() {
    const d = state.mindPicker;
    if (!d) return;
    state.selections.心法 = [...d.minds];
    state.mindPicker = null;
    refreshGraduate();
    save();
    render();
  },

  /**
   * 丢弃：清空已填写的内容，录入面板回到该部位的空白初始状态（停留在录入面板，不关闭）。
   * 与「取消」的区别：取消 = 关闭录入面板；丢弃 = 清空白接着录下一件。
   * 保留部位与武器类型（同一部位连录多件时不必重选）；定音回到方案默认值。
   */
  resetDraft() {
    const p = state.draft;
    state.draft = newDraft(p.slot, p.weaponType, currentFlow(), state.affixes);
    render();
  },

  changeSchool(school) {
    switchSchool(school).catch((err) => {
      renderErrorModal('切换流派失败', err.message);
      boot('切流失败', 'err');
    });
  },

  changeBranch(branch) {
    switchBranch(branch).catch((err) => {
      renderErrorModal('切换分支失败', err.message);
      boot('切分支失败', 'err');
    });
  },

  /** 打开角色管理模态框（多角色入口，顶栏按钮） */
  openCharPicker() {
    state.charPicker = { mode: 'list', target: null, draftName: '' };
    state.editing = false;
    state.editTarget = null;
    state.selected = null;
    state.picker = null;
    state.mindPicker = null;
    state.schoolPicker = null;
    state.configPicker = false;
    render();
  },

  /** 点角色卡：直接切换（站点同款，无需二次确认）；点当前角色 = 仅关闭 */
  pickChar(id) {
    state.charPicker = null;
    render(); // 先关弹窗（切换是异步的，避免切换期间弹窗残留）
    if (id && id !== state.charId) actions.changeChar(id);
  },

  /** 切角色（异步：要重新拉该角色流派的数据） */
  changeChar(id) {
    switchChar(id).catch((err) => {
      renderErrorModal('切换角色失败', err.message);
      boot('切角色失败', 'err');
    });
  },

  /** 新建角色（空白：空装备、流派沿用当前），建完即切过去 */
  createChar(name) {
    const id = nextCharId();
    const nm = String(name || '').trim() || `角色 ${Object.keys(state.roster).length + 1}`;
    state.roster[id] = blankChar(nm, state.school);
    state.charPicker = null;
    render();
    actions.changeChar(id);
    return id;
  },

  /** 重命名：进入表单视图（草稿预填现名） */
  requestRename(id) {
    if (!state.roster[id]) return;
    state.charPicker = { mode: 'rename', target: id, draftName: state.roster[id].name || '' };
    render();
  },

  /** 角色名输入框：只进草稿，不重渲染（重渲染会让输入框每敲一个字就失焦） */
  setCharDraftName(v) {
    if (!state.charPicker) return;
    state.charPicker.draftName = String(v ?? '');
  },

  /** 确认重命名（空名保持原名） */
  confirmRename() {
    const d = state.charPicker;
    if (d?.mode !== 'rename') return false;
    const nm = String(d.draftName || '').trim();
    if (nm && state.roster[d.target]) {
      state.roster[d.target].name = nm;
      if (d.target === state.charId) state.charName = nm;
    }
    state.charPicker = null;
    save(); render();
    return true;
  },

  /** 删除：二次确认（会连同该角色全部装备一起删，不可恢复） */
  requestDelete(id) {
    if (!state.roster[id] || Object.keys(state.roster).length <= 1) return;
    state.charPicker = { mode: 'delete', target: id, draftName: '' };
    render();
  },

  confirmDelete() {
    const d = state.charPicker;
    if (d?.mode !== 'delete') return false;
    const id = d.target;
    if (!state.roster[id] || Object.keys(state.roster).length <= 1) { state.charPicker = null; render(); return false; }
    delete state.roster[id];
    state.charPicker = null;
    // 删的是当前角色 → 切到剩下的第一个
    if (id === state.charId) {
      const next = Object.keys(state.roster)[0];
      save();
      actions.changeChar(next);
      return true;
    }
    save(); render();
    return true;
  },

  /** 角色表单里的取消：回到角色列表视图 */
  cancelCharForm() {
    state.charPicker = { mode: 'list', target: null, draftName: '' };
    render();
  },

  /** 打开流派选择模态框（站点 MartialBuildPicker 同款）：先渲染，再拉齐 11 个 _meta 补武器条 */
  /**
   * 打开「流派 → 分支·方案」两级选择（2026-11-02 玩家定稿）。
   * 一个动作切完（`gotoFlow`），不再让玩家先切流派、再切分支方案——
   * 那样中间会真的落到「目标流派的默认方案」（装备为空），助手在那时说的话都是针对那个方案的。
   */
  openSchoolPicker() {
    state.schoolPicker = { school: null };
    state.editing = false;
    state.editTarget = null;
    state.selected = null;
    state.picker = null;
    state.mindPicker = null;
    state.configPicker = false;
    render();
    // 跨流派方案清单是懒加载的（详情页也在用同一份），首次打开先拉齐，到位后重绘
    if (!XFLOW.entries) {
      ensureCrossFlows()
        .then(() => { if (state.schoolPicker) render(); })
        .catch(() => { /* 拉不到就只按当前已有条目展示 */ });
    }
  },

  /** 点流派印章：多配置的在原地展开（再点一次收起），单配置的直接切过去 */
  pickSchoolSeal(id) {
    const list = flowsOfSchool(id);
    if (!list.length) return;
    if (list.length === 1) {
      actions.gotoFlow(id, list[0].branch, list[0].plan);
      return;
    }
    const same = state.schoolPicker?.school === id;
    state.schoolPicker = { school: same ? null : id };
    render();
  },

  /** 收起展开的印章（点印章本身也能收；Esc 关弹窗） */
  backToSchools() {
    state.schoolPicker = { school: null };
    render();
  },

  /**
   * 一次动作切到目标配置：流派 → 分支 → 方案。
   * `state.switching` 全程为真，助手的主动提示在中间静默，切完再由 `finally` 判一次。
   */
  async gotoFlow(school, branch, plan) {
    state.schoolPicker = null;
    state.configPicker = false;
    render(); // 先关弹窗（切换异步，避免弹窗残留）
    state.switching = true;
    try {
      if (school && school !== state.school) await switchSchool(school, { keepSelections: false });
      if ((branch ?? null) !== (state.branch ?? null)) await switchBranch(branch);
      if ((plan ?? null) !== (state.plan ?? null)) switchPlan(plan);
    } catch (err) {
      renderErrorModal('切换配置失败', err.message);
      boot('切配置失败', 'err');
    } finally {
      state.switching = false;
      maybeNotifyComposition();
    }
  },

  /** 模态框内点选流派：直接切换（站点同款，无需二次确认）；点当前流派 = 仅关闭 */
  pickSchool(id) {
    state.schoolPicker = null;
    render(); // 先关弹窗（切换过程异步，避免切换期间弹窗残留）
    if (id && id !== state.school) actions.changeSchool(id);
  },

  /** 点配置横幅：在横幅下方展开 / 收起分支·方案菜单（2026-10-30 第六版，取代模态框）。
   *  展开前顺手收起所有弹窗，避免菜单和模态框叠着。 */
  toggleConfigPicker() {
    const open = !state.configPicker;
    state.configPicker = open;
    if (open) {
      state.schoolPicker = null;
      state.charPicker = null;
      state.editing = false;
      state.editTarget = null;
      state.selected = null;
      state.picker = null;
      state.mindPicker = null;
    }
    render();
  },

  /** 菜单里点一条组合：**一次切完分支 + 方案**（用户定稿第七版：不许点两次），切完自动收起。
   *  两个值都没变 = 点的是当前项，只收起菜单。
   *  注意顺序：先 switchBranch（分支 = 技能轴，会重置方案到该分支的默认方案），再 switchPlan
   *  把方案纠正到点选的那个——反过来会被 switchBranch 覆盖掉。 */
  async pickConfig(branchRaw, plan) {
    const branch = branchRaw === '' ? null : branchRaw;
    state.configPicker = false;
    const branchChanged = (branch ?? null) !== (state.branch ?? null);
    const planChanged = (plan ?? null) !== (state.plan ?? null);
    if (!branchChanged && !planChanged) { render(); return; }
    // 这两步各自 render 一次，中间那次是「新分支 + 默认方案」的过渡态（甚至连 equipped 都是重建中的）。
    // 用一个开关把助手的组合提示压住，切完再统一判一次，免得把过渡态当成结论说给玩家。
    state.switching = true;
    try {
      if (branchChanged) await switchBranch(branch); // 内部含 render
      if (planChanged) switchPlan(plan); // 内部含 render
    } catch (err) {
      renderErrorModal('切换配置失败', err.message);
      boot('切配置失败', 'err');
    } finally {
      state.switching = false;
      maybeNotifyComposition();
    }
  },

  setSelection(field, value, idx = null) {
    if (field === '心法') state.selections.心法[idx] = value;
    else state.selections[field] = value;
    refreshGraduate();
    save();
    render();
  },

  setDraftSlot(slot) {
    const cats = currentWeaponLabels();
    const wt = slot === WEAPON_SLOT ? (state.draft.weaponType || cats[0] || '') : '';
    state.draft = newDraft(slot, wt, currentFlow(), state.affixes);
    save(); render();
  },

  setDraftWeaponType(wt) {
    state.draft.weaponType = wt;
    // 换武器类型时清空不再合法的指定武学增伤
    state.draft.调律.forEach((a) => {
      if (a.属性 && /武学增伤$/.test(a.属性) && a.属性 !== '全武学增伤' && !a.属性.startsWith(wt)) a.属性 = '';
    });
    save(); render();
  },

  setDraftChengyin(v) {
    state.draft.承音 = v;
    if (v) {
      const snap = (a) => {
        if (!a || !a.属性) return;
        const r = lookupRange(state.affixes, a.属性);
        if (r && r.承音 != null) a.数值 = r.承音;
      };
      snap(state.draft.初始);
      state.draft.调律.forEach(snap);
    }
    save(); render();
  },

  setDraftAffix(kind, idx, name) {
    const target = kind === '调律' ? state.draft.调律[idx] : state.draft[kind];
    if (!target) return;
    // 调律四位互不重复：其余位已占用的词条不可再选（下拉已过滤，此处兜底防旧档/程序路径绕过）
    if (kind === '调律' && name && state.draft.调律.some((a, j) => j !== idx && a.属性 === name)) return;
    target.属性 = name;
    const r = lookupRange(state.affixes, name);
    if (r && r.max != null) {
      target.数值 = (state.draft.承音 && kind !== '定音' && r.承音 != null) ? r.承音 : r.max;
    } else {
      target.数值 = null;
    }
    save(); render();
  },

  /** 转律标记（单选语义）：勾选某条 = 该条已转律，其余清除；取消勾选 = 全部未转律 */
  setDraftConverted(idx, v) {
    if (!state.draft.调律[idx]) return;
    state.draft.调律.forEach((a, i) => {
      if (i === idx && v) a.转律 = true;
      else delete a.转律;
    });
    save(); render();
  },

  addDraft(opts = {}) {
    const p = state.draft;
    if (!p.初始.属性) return null;
    const uid = nextUid();
    state.pool.push({ ...draftPiece(), uid }); // 新件进装备库（不自动穿：穿不穿由各配置的 loadout 决定）
    rebuildGear();
    state.editing = false;
    state.editTarget = null;
    state.selected = { kind: 'backpack', uid };
    state.draft = newDraft(p.slot, p.weaponType, currentFlow(), state.affixes);
    save(); render();
    if (!opts.silent) notifyPiece(uid); // 录完一句主动提示（只有值得动时才开口）
    return uid;
  },

  /** 录入后直接穿上（入包 + 装备一步完成；被替换的旧件进背包） */
  addAndEquip() {
    // 玩家自己点了"穿上"，不必再追着提示一遍
    const uid = actions.addDraft({ silent: true });
    if (!uid) return null;
    actions.equip(uid);
    return uid;
  },

  equip(uid) {
    const piece = poolByUid(uid);
    if (!piece) return;
    // 武器 = 类型桶（§12）：桶内无序、容量 = 该类型在本流派武器列表里的出现次数。
    //   有空格 → 填空；单槽桶满 → 替换该件；多槽桶满（双枪）→ 试换取 ΔDPS 最优。
    let key;
    if (piece.slot === WEAPON_SLOT) {
      const wt = String(piece.weaponType ?? '');
      const wtMap = state.prescription?.weaponTypes || null;
      if (wtMap) {
        // 该类型绑定的槽 = 桶；容量就是 bound.length（双枪流派为 2）
        const bound = WEAPON_KEYS.filter((k) => wtMap[k] != null && String(wtMap[k]) === wt);
        if (!bound.length) {
          // 该类型不属于当前流派 → 拒绝（防错型混放；桶按类型收件，天然挡住，§12.6）
          const schoolWeapons = WEAPON_KEYS.map((k) => wtMap[k]).filter(Boolean).join('+') || '（未知）';
          state.selected = { kind: 'backpack', uid };
          save(); render();
          boot(`当前流派不带「${wt || '该武器'}」（本流派武器：${schoolWeapons}），换流派或录对类型再穿`, 'err');
          return;
        }
        const empty = bound.filter((k) => !state.equipped[k]);
        if (empty.length) key = empty[0];
        else if (bound.length === 1) key = bound[0];
        else key = pickBucketSlotToReplace(bound, piece);
      } else {
        // 兜底（配额未就绪）：维持旧行为——同类型顶替，否则找空位
        key = WEAPON_KEYS.find((k) => {
          const g = state.equipped[k];
          return g?.slot === WEAPON_SLOT && String(g?.weaponType ?? '') === wt;
        }) || WEAPON_KEYS.find((k) => !state.equipped[k]);
        if (!key) {
          state.selected = { kind: 'backpack', uid };
          save(); render();
          boot(`两把武器位已被 ${wornWeaponTypes()} 占用——先脱下其中一把再穿 ${wt || '该武器'}`, 'err');
          return;
        }
      }
    } else {
      key = piece.slot;
    }
    // 只记"本配置这个槽穿哪件"：被顶替的旧件自动回到背包（它不再被本配置引用）
    setLoadoutSlot(key, uid);
    rebuildGear();
    state.selected = { kind: 'equipped', slot: key };
    save(); render();
  },

  unequip(slot) {
    const piece = state.equipped[slot];
    if (!piece) return;
    setLoadoutSlot(slot, null); // 脱下 = 本配置该槽不再引用，件回到背包（uid 不变）
    rebuildGear();
    state.selected = { kind: 'backpack', uid: piece.uid };
    // 槽位空了 ⇒ 该槽的背包筛选失去参照（武器还要靠它定"同类型"），撤掉
    if (state.bagFilter === slot) state.bagFilter = null;
    save(); render();
  },

  removeBackpack(uid) {
    removePieceFromPool(uid); // 从装备库删，同时摘掉所有配置对它的引用
    rebuildGear();
    if (state.selected?.kind === 'backpack' && state.selected.uid === uid) state.selected = null;
    save(); render();
  },

  removeEquipped(slot) {
    const piece = state.equipped[slot];
    if (piece) removePieceFromPool(piece.uid);
    rebuildGear();
    if (state.selected?.kind === 'equipped' && state.selected.slot === slot) state.selected = null;
    if (state.bagFilter === slot) state.bagFilter = null;
    save(); render();
  },
};

// ---------- 启动 ----------

function showError(title, detail) {
  // 错误视图占据栏1（最宽的一栏），不挤在背包栏里
  leftEl.innerHTML = `<section class="st-panel"><ul class="warnings"><li><b>${escapeHtml(title)}</b></li><li>${escapeHtml(detail)}</li></ul></section>`;
}

/** 错误弹窗（切流派失败等可恢复错误；关掉即可继续用） */
/** 套装/弓玦/武库选择模态框（燕小叽站点 EquipmentSetSelectorModal 同款）：
 *  四个分区各一选项网格（武库带图标；弓玦选项沿用「俗称」标注），点选进草稿，确认后统一应用。
 *  防具套装效果表暂为空（只给气血等非 DPS 属性），选项只显名字、无效果说明。 */
function setPickerHtml() {
  const d = state.picker;
  const metaOf = (kind, k) => {
    const a0 = Object.entries(state.version[kind]?.[k] || {})[0];
    return a0 ? `${a0[0]} +${fmtAffixValue(a0[0], a0[1])}` : '';
  };
  const sec = (title, kind, keys, labelOf) => `
    <section class="st-picker-sec">
      <h4>${title}</h4>
      <div class="st-picker-grid">
        ${keys.map((k) => {
          const meta = metaOf(kind, k);
          const img = kind === '武库' ? slotImg(state.version.界面图片?.['武库']?.[k]) : '';
          return `
            <div class="st-picker-opt ${d[kind] === k ? 'active' : ''}" data-act="pickOpt" data-kind="${kind}" data-key="${escapeHtml(k)}"
                 title="${escapeHtml(meta || '暂无效果说明')}">
              ${img ? `<img src="${img}" alt="" loading="lazy">` : ''}
              <span class="n">${escapeHtml(labelOf ? labelOf(k) : k)}</span>
              ${meta ? `<span class="m">${escapeHtml(meta)}</span>` : ''}
            </div>`;
        }).join('')}
      </div>
    </section>`;
  return modalShellHtml('选择攻具套装、防具套装、弓玦套装与武库', null, '', `
    ${sec('攻具套装', '装备套装', Object.keys(state.version.装备套装))}
    ${sec('防具套装', '防具套装', Object.keys(state.version.防具套装 || {}))}
    ${sec('弓玦套装', '弓玦', Object.keys(state.version.弓玦), gongjueLabel)}
    ${sec('武库', '武库', Object.keys(state.version.武库))}
    <div class="st-picker-foot">
      <button class="primary" data-act="confirmPicker">确认</button>
      <button class="ghost" data-act="closeModal">取消</button>
    </div>`);
}

function renderErrorModal(title, detail) {
  modalEl.innerHTML = modalShellHtml(title, null, '',
    `<ul class="warnings"><li>${escapeHtml(detail)}</li></ul>`);
  bind();
}

window.addEventListener('error', (e) => showError('脚本错误', e.message));
window.addEventListener('unhandledrejection', (e) => showError('异步错误', String(e.reason)));
// Esc 关闭弹窗（只注册一次，避免每次 render 叠加监听）
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 配置菜单只是一层浮层：Esc 先收它，不收下面（可能不存在）的弹窗
  if (state.configPicker) { state.configPicker = false; render(); return; }
  // 修改模式：Esc 只退出修改回到该件详情；其余弹窗一律关闭
  if (state.editTarget) { actions.cancelEdit(); return; }
  if (state.editing || state.selected || state.picker || state.mindPicker || state.schoolPicker || state.charPicker || state.composition) actions.closeModal();
});

if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    showError('打开方式错误', '本页面需要通过本地服务器打开：请访问 http://127.0.0.1:4173/ （在工作区根目录运行 node tools/serve.js 启动）');
  });
}

/** 顶栏注记：赛季 · 阶段 · 装备等阶（全部取自 version.json，换季自动跟随，无需改代码） */
function renderAppBarNote() {
  const el = document.querySelector('#app-bar-note');
  if (!el) return;
  const v = state.version?.version;
  if (!v) { el.textContent = ''; return; }
  const parts = [];
  if (v.赛季) parts.push(v.阶段 ? `${v.赛季}·${v.阶段}` : v.赛季);
  if (v.装备等阶) parts.push(`${v.装备等阶} 阶`);
  el.textContent = parts.join('　·　');
}

/**
 * 助手工具取数（2026-11-02）：给模型「按需查」用的纯文本事实块。
 *
 * 为什么不做成一次性塞进 prompt：新手说不出自己在问什么，模型得能自己决定先看哪块；
 * 而且这些明细合起来上千 token，一句闲聊不该全带上。
 * 这里只负责**取数与排版**，不判断该不该给 —— 那是模型（tool_calls）的事。
 */
/** 给模型看的面板只留「有数」的行：三十多个增伤项里大部分是 0，全给反而淹掉重点 */
const PANEL_KEEP_ZERO = new Set(['精准率', '会心率', '会意率']);

const pctText = (k, v) => {
  if (v == null || typeof v !== 'number') return String(v ?? '');
  // 「率」和「加成」的原始值多是 0~1 的小数，直接给模型看会被读成 0.5 条而不是 50%
  if (/率|加成/.test(String(k)) && Math.abs(v) <= 1) return `${(v * 100).toFixed(1)}%`;
  return String(Math.round(v * 10) / 10);
};

/** 一件装备 → 一行：「天阶 外功攻击 139.6 / 劲 88.4 / …」 */
function pieceLine(piece) {
  if (!piece) return '空';
  const tier = tierRankOf(piece);
  const parts = [piece.初始, ...(piece.调律 || [])]
    .filter((t) => t && t.属性)
    .map((t) => `${t.属性} ${pctText(t.属性, t.数值)}`);
  return `${tier ? `${tier}阶 ` : ''}${parts.join(' / ')}`;
}

/** 当前方案下已穿戴的八个部位 */
const LOADOUT_ORDER = ['武器1', '武器2', '冠胄', '胸甲', '胫甲', '腕甲', '环', '佩'];

function loadoutText() {
  const lines = LOADOUT_ORDER.map((k) => {
    const pc = state.equipped[k];
    return `${k}：${pieceLine(pc)}${pc ? ` [${pc.uid}]` : ''}`;
  });
  const n = LOADOUT_ORDER.filter((k) => state.equipped[k]).length;
  return `已穿戴 ${n}/8（方案 ${configLabelOf(currentConfigKey())}）\n`
    + `${lines.join('\n')}\n（行尾方括号里是给 evaluate_piece 传的参数，不是装备的名字）`;
}

/** 背包（可只给某个部位） */
function backpackText(slot) {
  const list = (state.backpack || []).filter((p) => !slot || p.slot === slot);
  if (!list.length) return slot ? `背包里没有「${slot}」` : '背包是空的';
  const lines = list.map((p) => `${p.slot}${p.weaponType ? `·${p.weaponType}` : ''}：${pieceLine(p)} [${p.uid}]`);
  return `背包 ${list.length} 件（行尾方括号是给 evaluate_piece 的参数，不是名字）\n${lines.join('\n')}`;
}

/** 词条配额逐行 */
function quotaText() {
  const mon = state.overall?.监测;
  const rows = mon?.配额行 || [];
  if (!rows.length) return '当前方案没有可用的配额模板';
  const lines = rows.map((r) => {
    const extra = r.缺口 > 0 ? `（缺 ${r.缺口}）` : (r.溢出 > 0 ? `（多 ${r.溢出}）` : '（齐）');
    return `${quotaLabel(r.词条)}：实装 ${r.实装} / 需要 ${r.需要}${extra}`;
  });
  const un = Object.entries(mon?.未配额词条 || {});
  return [
    `词条配额（${configLabelOf(currentConfigKey())}）`,
    lines.join('\n'),
    un.length ? `不在配额内的词条：${un.map(([k, n]) => `${k}×${n}`).join('、')}` : '',
  ].filter(Boolean).join('\n');
}

/** 属性面板 + DPS + 方案阈值 */
function panelText() {
  const o = state.overall;
  if (!o?.ok) return `面板算不出来：${o?.errors?.[0] || '未知原因'}`;
  const st = o.属性面板 || {};
  const th = currentFlow()?.thresholds || {};
  const rows = Object.entries(st)
    .filter(([k, v]) => v !== 0 || PANEL_KEEP_ZERO.has(k))
    .map(([k, v]) => `${k} ${pctText(k, v)}`);
  const thLine = Object.keys(th).length
    ? `方案阈值：${Object.entries(th).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join('、')}` : '';
  // ⚠ 故意不返回 DPS / 毕业率：本工具的伤害计算仅供内部排优先级，数值本身不可靠。
  //   给了模型它一定会转述成"你现在 DPS 多少"——玩家定过规矩，这类数字不许出现在对话里。
  return ['属性面板', rows.join('\n'), thLine].filter(Boolean).join('\n');
}

/** 方案要求：词条配额行、三率阈值、套装心法、方案说明（将来加 `说明` 字段自动带上） */
function planText() {
  const flow = currentFlow();
  if (!flow) return '当前没有选定方案';
  const q = (flow.quota?.lines || []).map((L) => `${L.any_of.join(' 或 ')} ×${L.count}`);
  const th = Object.entries(flow.thresholds || {}).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`);
  return [
    `方案：${configLabelOf(currentConfigKey())}`,
    `词条要求：${q.join('；') || '无'}`,
    th.length ? `三率阈值：${th.join('、')}` : '',
    `套装：攻具 ${flow.攻具套装 || '—'} / 防具 ${flow.防具套装 || '—'} / 弓玦 ${flow.弓玦套装 || '—'} / 武库 ${flow.武库 || '—'}`,
    `心法：${(flow.心法 || []).filter(Boolean).join('、') || '—'}`,
    flow.说明 ? `方案说明：${flow.说明}` : '',
  ].filter(Boolean).join('\n');
}

/** 单件决策：直接调引擎（disposeItem），把权威结论原样交给她 —— 她已经不止一次自己推错 */
function evaluateText(uid) {
  const piece = poolByUid(uid);
  if (!piece) return `没有编号为 ${uid} 的装备。先调 get_loadout / get_backpack，取每行末方括号里的编号。`;
  const r = disposeResultOf(piece);
  if (r.error) return `算不出来：${r.error.message}`;
  if (!r.ok || r.action === '无法判断') {
    return r.reason || (r.errors || ['信息不足，判断不了'])[0];
  }
  // 拆成结构化字段，不要给 r.reason —— 那是 UI 里给玩家看的完整句，
  // 模型会整句照抄，把她自己的语气全盖掉。
  const name = `${piece.slot}${piece.weaponType ? `·${piece.weaponType}` : ''}`;
  const p = r.parts || {};
  return [
    `${name}：${r.tier}阶`,
    p.已穿档 ? `现在穿的是：${p.已穿档}阶` : '',
    p.穿在身上 ? '这件正穿在玩家身上' : '',
    `引擎结论：${r.action}`,
    p.词条 ? `词条：${p.词条}` : '',
    p.高下 ? `对比：${p.高下}` : '',
    p.使用中 ? `使用中：${p.使用中}` : '',
    p.转律 ? `转律：${p.转律}` : '',
    p.结论 ? `结论：${p.结论}` : '',
    p.跨方案 ? `其他：${p.跨方案}` : '',
  ].filter(Boolean).join('\n');
}

/** 玩家此刻点开的那一件（详情弹窗里看着的）—— 他说「这件呢」时指的就是它 */
function focusText() {
  const sel = state.selected;
  if (!sel) return '玩家此刻没有点开某件装备。';
  const piece = sel.kind === 'backpack' ? poolByUid(sel.uid) : state.equipped[sel.slot];
  if (!piece) return '玩家此刻没有点开某件装备。';
  return `玩家正看着这件：\n${evaluateText(piece.uid)}`;
}

/** 助手工具分发：模型给名字与参数，这里返回纯文本 */
function toolDataOf(name, args = {}) {
  switch (name) {
    case 'get_loadout': return loadoutText();
    case 'get_backpack': return backpackText(args.slot);
    case 'get_quota': return quotaText();
    case 'get_panel': return panelText();
    case 'get_plan': return planText();
    case 'evaluate_piece': return evaluateText(args.id);
    case 'get_focus': return focusText();
    default: return `没有这个工具：${name}`;
  }
}

/**
 * 助手宿主（依赖注入）：把 state 的只读视图 + 已有动作交给 assist.js。
 * assist 不 import 本文件（否则循环依赖），它只认这个接口 —— 换成别的宿主也能跑。
 */
const assistHost = {
  state: () => state,
  configLabel: () => configLabelOf(currentConfigKey()),
  flowInfo: () => ({
    流派: schoolNameOf(state.school) || '',
    分支: state.branch ? branchLabel(state.branch) : '',
    方案: planLabel(state.plan) || '',
    方案标签: configLabelOf(currentConfigKey()),
  }),
  quotaRows: () => (state.overall?.监测?.配额行 || []).map((r) => ({
    affix: quotaLabel(r.词条), need: r.需要, have: r.实装, gap: r.缺口,
  })),
  bagPieces: () => (state.backpack || []).map((p) => ({
    uid: p.uid,
    slot: p.slot,
    weaponType: p.weaponType || null,
    name: p.slot + (p.weaponType ? `·${p.weaponType}` : ''),
    tier: tierRankOf(p),
    img: bagImageOf(p),
  })),
  openEntry: (opts) => actions.openEditor(opts?.slot || undefined),
  openPiece: (uid) => { if (backpackByUid(uid)) actions.select({ kind: 'backpack', uid }); },
  openGear: () => { document.body.setAttribute('data-mview', 'gear'); syncDock('gear'); },
  openRead: () => { document.body.setAttribute('data-mview', 'read'); syncDock('read'); },
  setAssist: (on) => assist?.setOpen(on),
  openComposition: () => actions.openComposition(),
  /** 助手工具取数（模型按需调用；见 toolDataOf） */
  toolData: (name, args) => toolDataOf(name, args),
  /** 组合结论（助手出卡用）：结论一句话 + 要换哪几件 */
  compositionInfo: () => {
    const r = state.search?.result;
    if (!r) return null;
    return {
      message: r.message || '',
      improved: compositionImproved(),
      rows: (r.swapIn || []).map((s) => ({
        slot: s.slot,
        names: [s.piece?.初始?.属性, ...(s.piece?.调律 || []).map((t) => t?.属性)].filter(Boolean).join(' / '),
      })),
    };
  },
};

/** 移动端 dock 的选中态（切视图的入口有三处：dock / 助手卡片 / 快捷键） */
function syncDock(view) {
  document.querySelectorAll('#st-dock [data-mview-btn]').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset.mviewBtn === view ? 'true' : 'false');
  });
  resetViewScroll();
}

/** 切视图时回顶并展开顶栏：新视图从第一条看起，别停在上一个视图的滚动位置 */
function resetViewScroll() {
  const st = document.querySelector('.studio');
  if (st) st.scrollTop = 0;
  delete document.body.dataset.bar;
}

/** 移动端顶栏随内容收起（一滚就收、回到顶部再展开）。bind 每次都跑，用标志只绑一次 */
let barBound = false;
function bindBarCollapse() {
  const st = document.querySelector('.studio');
  if (!st || barBound) return;
  barBound = true;
  st.addEventListener('scroll', () => {
    const mini = st.scrollTop > 12;
    if ((document.body.dataset.bar === 'mini') === mini) return;
    if (mini) document.body.dataset.bar = 'mini';
    else delete document.body.dataset.bar;
  }, { passive: true });
}

async function init() {
  // manifest 单点声明当前赛季与流派清单；旧赛季目录原地保留但不加载
  const manifest = await fetchJson('data/version/manifest.json');
  const season = manifest['当前赛季'];
  SCHOOLS = (manifest['流派'] || []).map((b) => [b.id, b.name]);
  if (!SCHOOLS.length) throw new Error('manifest.json 缺少流派清单（"流派"字段）');
  BUILD_PACKS = manifest['build包'] || [];
  if (!BUILD_PACKS.length) throw new Error('manifest.json 缺少 build 包清单（"build包"字段）');
  state.version = await fetchJson(`data/version/${season}/version.json`);
  state.affixes = await fetchJson(`data/version/${season}/affixes.json`);
  renderAppBarNote();
  boot('③ 数据已加载，恢复存档…');
  // 多角色：读名册 → 载入上次使用的角色（旧档 v1 就地升级为单角色「默认角色」，装备不丢）
  try {
    const { id, roster } = loadRoster();
    state.roster = roster;
    state.charId = id;
    applyChar(roster[id]);
  } catch { /* 忽略损坏的存档 */ }
  // 已有口径的角色不被方案默认覆盖（keepSelections）；空角色（新档/新建）才套默认
  await switchSchool(
    SCHOOLS.some(([id]) => id === state.school) ? state.school : SCHOOLS[0][0],
    { keepSelections: !isEmptySelections(state.selections) },
  );
  renderCharButton();
  // 其他流派的分支中文名（「他方案在用」的悬停与处置句要用）：后台预热，到位后重绘一次
  ensureAllMetas().then(() => render()).catch(() => { /* 拉不到就退回 id，不阻塞 */ });
  // 助手：宽屏三栏直接展开，窄屏/移动端收成图标；用户手动收起的偏好优先于宽度判断
  if (!assist) assist = mountAssist(assistHost);
  if (assist && !localStorage.getItem('yysls-assist-collapsed') && window.innerWidth >= 1600) {
    assist.setOpen(true);
  }
}

init().catch((err) => {
  leftEl.innerHTML = `<section class="st-panel"><p style="color:var(--warn)">初始化失败：${escapeHtml(err.message)}</p></section>`;
});

// 供无头冒烟测试驱动（actions 与 UI 事件同一份实现）
export const __test = {
  state, actions, currentFlow, equippedList, switchFlow, switchSchool, switchBranch, switchPlan,
  computeOverallSafe, lawPool, branchesOf, plansOf, branchLabel, planLabel, resolveBuild, flowIdOf,
  atkRangeText, attrAtkElements, quotaLabel, statsHtml, digestHtml, slotImageOf, slotImg, mindTileHtml,
  currentWeaponLabels, xinfaStripHtml, draftFromPiece, baselineGearForEdit, bagImageOf,
  tierRankOf, backpackGroups, slotNameOf, gradRateHtml, slotCardHtml, configOptions, configMenuHtml,
  switchChar, loadRoster, charList, charCountOf, blankChar, normalizeChar, isEmptySelections,
  configKeyOf, currentConfigKey, currentLoadout, rebuildGear, poolByUid, loadoutCount,
  configsUsingPiece, configLabelOf, bagVisible, planWeaponTypes, disposeSayHtml,
  toolDataOf, disposeResultOf, compositionImproved,
};
