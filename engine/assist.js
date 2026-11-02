'use strict';

/**
 * assist.js — 助手内核（纯函数、零 IO）：意图规则 / 事实快照 / 知识库检索
 *
 * 三层分工（见 评价系统设计.md 助手章）：
 *   ① 事实快照 `compactFacts` —— 由引擎现算，喂给模型时**只许引用它**，模型不产数字；
 *   ② 意图规则 `intentOf` —— 短语/自由文本先过规则，命中就走确定性动作，不劳模型；
 *   ③ 知识检索 `searchKb` —— md 切段 + 中文 bigram 打分，命中就贴原文，不命中就说不知道。
 *
 * 这个文件不 import 任何 UI，也不读写 localStorage —— 才能在 node 里直接测。
 */

// ---------- 1. 部位 / 武器类型识别 ----------

/** 部位词表：顺序 = 优先级（"护腕"要先于泛化的单字，避免互相吃掉） */
const SLOT_WORDS = [
  ['冠胄', /(冠胄|头盔|头甲|帽子|头部)/],
  ['胸甲', /(胸甲|护胸|上衣|衣甲|胸)/],
  ['胫甲', /(胫甲|护腿|腿甲|裤|下装)/],
  ['腕甲', /(腕甲|护腕|手腕|手套|臂甲)/],
  ['环', /(指环|戒指|戒|环)/],
  ['佩', /(玉佩|佩饰|坠子|挂件|佩)/],
  ['武器', /(武器|长枪|枪|长剑|剑|刀|弓|棍|双刃|兵刃)/],
];

const WEAPON_TYPES = [
  ['枪', /枪/], ['剑', /剑/], ['刀', /刀/], ['弓', /弓/], ['棍', /棍/],
];

/** 从一句话里认出部位名；认不出返回 null */
export function slotOf(text) {
  const t = String(text || '');
  for (const [slot, re] of SLOT_WORDS) if (re.test(t)) return slot;
  return null;
}

/** 从一句话里认出武器类型（只在讲到武器时有意义） */
export function weaponTypeOf(text) {
  const t = String(text || '');
  for (const [type, re] of WEAPON_TYPES) if (re.test(t)) return type;
  return null;
}

// ---------- 2. 意图规则 ----------
//
// 设计立场：**不做意图分类器**，做"命中即确定、不命中才交给模型"的规则表。
// 规则命中 = 零延迟 + 零成本 + 永不误判；模型只在玩家说人话时兜底。

const RULES = [
  {
    act: 'entry',
    // "我新得了一件胫甲" / "刚打了个护腕" / "录入装备"
    re: /(录入|新增|记录|添加).{0,6}(装备|件)?|(新得|刚得|刚出|刚打|打到|出了|捡到|掉了|拿到|搞到)/,
    needSlot: false,
  },
  { act: 'backpack', re: /(背包|仓库|库存|我都有什么|有哪些装备|看看装备)/ },
  { act: 'quota', re: /(配额|缺口|还差|缺什么|缺哪|词条要求|需要哪些词条|补齐)/ },
  { act: 'composition', re: /(组合|搭配|怎么配|更优|最优|换哪件|还能提升|有没有更好)/ },
  { act: 'plan', re: /(切换|换成|切到|换到).{0,6}(方案|流派|分支|套路)|(改|换)方案/ },
  { act: 'stats', re: /(属性|面板|伤害|会心|毕业率|多少攻击)/ },
];

/**
 * 规则意图识别。命中返回 `{ act, slot, weaponType, via:'rule' }`，不命中返回 null（交给模型）。
 * 注意 entry 的附加条件：说"新得"但没讲部位也算命中（她再追问一件），
 * 但只说"装备"两个字不算 —— 那是闲聊，不是录入指令。
 */
export function intentOf(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const slot = slotOf(t);
  for (const r of RULES) {
    if (!r.re.test(t)) continue;
    if (r.act === 'entry' && !slot && !/(录入|新增|记录|添加)/.test(t)) {
      // "刚出了个好东西" 之类：仍然算录入意图，但不知道部位 → 让她追问
      return { act: 'entry', slot: null, weaponType: null, via: 'rule', ask: 'slot' };
    }
    return { act: r.act, slot, weaponType: slot === '武器' ? weaponTypeOf(t) : null, via: 'rule' };
  }
  return null;
}

// ---------- 3. 事实快照 ----------
//
// 喂给模型的唯一事实来源。一行一条，短、扁平、无嵌套 —— 模型读得懂，人也扫得懂。

/**
 * @param {object} f 由 UI 侧组装（字段都可缺）：
 *   方案 / 品相 / 缺口[{affix,n}] / 已穿 / 背包 / 焦点 / 转律 / 组合 / 最近
 * @returns {string} 紧凑的多行文本
 */
export function compactFacts(f = {}) {
  const out = [];
  const push = (k, v) => { if (v != null && v !== '') out.push(`${k}：${v}`); };
  push('当前方案', f.方案);
  push('这套品相', f.品相);
  if (Array.isArray(f.缺口)) {
    push('配额缺口', f.缺口.length ? f.缺口.map((g) => `${g.affix}×${g.n}`).join('、') : '无');
  }
  if (f.已穿 != null) push('已穿件数', f.已穿);
  if (f.背包 != null) push('背包件数', f.背包);
  push('当前焦点', f.焦点);
  push('可转律', f.转律);
  push('组合结论', f.组合);
  if (Array.isArray(f.最近) && f.最近.length) push('最近做过', f.最近.join(' / '));
  return out.join('\n');
}

// ---------- 4. 知识库 ----------
//
// 语料小（几十篇），所以不建向量库：中文 bigram + 术语直配，段级打分取前几段。
// md 用 front-matter 写 title/tags/summary —— 那既是索引，也是"资料少时全塞"的退化路径。

/** 中文按 2-gram、英文数字按词切；单字查询单独兜住（"敏"这类词不能被 bigram 吃掉） */
export function tokenize(s) {
  const str = String(s || '').toLowerCase();
  const out = [];
  for (const m of str.matchAll(/[a-z0-9_]+/g)) out.push(m[0]);
  for (const m of str.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0];
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 解析一篇 md：front-matter + 按 `##` 切段（首个 `#` 标题段并入 summary 段） */
export function parseKb(text, file = '') {
  const src = String(text || '');
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  let body = src;
  if (fm) {
    body = src.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k) meta[k] = v;
    }
  }
  meta.file = file;
  if (!meta.title) meta.title = (body.match(/^#\s+(.+)$/m) || [])[1] || file;
  meta.tags = String(meta.tags || '').split(/[,，\s]+/).filter(Boolean);
  meta.summary = meta.summary || '';

  const sections = [];
  const parts = body.split(/^##\s+/m);
  const head = parts.shift() || '';
  const headText = head.replace(/^#\s+.*$/m, '').trim();
  if (headText) sections.push({ heading: meta.title, body: headText });
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const heading = (nl < 0 ? p : p.slice(0, nl)).trim();
    const b = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    if (heading) sections.push({ heading, body: b });
  }
  return { meta, sections };
}

/** 一段的检索词：标题单独算（权重见 searchKb），不再靠重复投喂 */
function sectionTokens(sec) {
  return [...tokenize(sec.body)];
}

/**
 * 检索：返回 `[{ file, title, heading, body, score }]`，按分降序。
 * 打分 = 段内命中率 + 标题命中率×0.5 + 文档级（title/tags/summary）命中率×0.6。
 * 三项都是**比例**，所以长段落不会靠堆字赢；`minScore` 默认 0.3（约等于"命中一个关键词"）。
 */
export function searchKb(docs, query, { limit = 3, minScore = 0.3 } = {}) {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const hits = [];
  for (const doc of docs || []) {
    if (!doc?.meta) continue;
    const metaSet = new Set([
      ...tokenize(doc.meta.title), ...tokenize(doc.meta.summary),
      ...doc.meta.tags.flatMap((t) => tokenize(t)),
    ]);
    const metaHit = (q.filter((t) => metaSet.has(t)).length / q.length) * 0.6;
    for (const sec of doc.sections || []) {
      const secSet = new Set(sectionTokens(sec));
      const headSet = new Set(tokenize(sec.heading));
      const hit = q.filter((t) => secSet.has(t)).length;
      const headHit = q.filter((t) => headSet.has(t)).length;
      if (!hit && !headHit) continue;
      const score = hit / q.length + (headHit / q.length) * 0.5 + metaHit;
      if (score >= minScore) {
        hits.push({
          file: doc.meta.file, title: doc.meta.title, heading: sec.heading, body: sec.body, score,
          type: doc.meta.type || 'rule', // rule=机制（只许照原文说）/ guide=经验（可自由组织）
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return hits.slice(0, limit);
}

/**
 * 把命中段拼成给模型的引用块（带出处 + 类别）。
 * 类别是有用的：机制类必须贴着原文说（转律几条、承音多少），经验类允许组织语言。
 */
export function hitsToContext(hits) {
  return (hits || []).map((h) => {
    const tag = h.type === 'guide' ? '经验' : '机制';
    return `【${h.title} · ${h.heading}】（${tag}）\n${h.body}`;
  }).join('\n\n');
}
