'use strict';

/**
 * studio.js — 三栏工作台 UI（P2 v2，零依赖 vanilla ESM）
 *
 * 布局（用户定稿）：
 *   左栏  上：已穿戴 8 部位（两行各 4）；下：背包（未穿戴装备）。
 *   中栏  默认 = 「录入装备」按钮；点击装备 → 词条数值 + 评价（ΔDPS/匹配度，监测属全局组合放右栏）；
 *         再次点击同一件 → 取消选中回到按钮；点按钮 → 录入表单。
 *   右栏  上：流派（+流）；下：心法×4/武库/装备套装/弓玦套装；再下：DPS 毕业率；再下：属性面板 + 整体监测发现。
 *
 * 录入体验（用户定稿）：边录入边评价——每录一条词条显示当前潜力（天地玄黄）；
 * 结构录满后显示毕业率变化，并在入包前给出「穿上/保留背包/回收删除」建议。
 *
 * 复用 P1 引擎（quota/advisor/monitor/swap/inspect/graduate），不给综合结论。
 * 存档与评价器共用 localStorage key（yysls-evaluator-v1），两个页面互通同一装备库。
 */

import { derivePrescription } from '../engine/quota.js';
import { gradeItem, gradeItemPotential } from '../engine/advisor.js';
import { computeGraduateDps } from '../engine/graduate.js';
import { inspectEquipped, inspectCandidate, inspectOverall } from '../engine/inspect.js';
import { evalGearDps, evaluateSwap } from '../engine/swap.js';

// ---------- 常量 ----------

let BUILDS = []; // 由 manifest.json 的"流派"清单驱动；接流派 = manifest 加一条，零代码
const SLOT_ROWS = [ // 左栏两行槽位：上行武器+饰品，下行防具
  ['左武器', '右武器', '环', '佩'],
  ['冠胄', '胸甲', '胫甲', '腕甲'],
];
const SLOTS = SLOT_ROWS.flat();
const WEAPON_SLOTS = ['左武器', '右武器'];
const WEAPON_TYPES = ['剑', '枪', '横刀', '陌刀', '伞', '扇', '绳镖', '双刀', '拳甲', '鼓'];
const FLOWS_API = (prefix) => `/api/template/${encodeURIComponent(prefix)}`;
const STORAGE_KEY = 'yysls-evaluator-v1'; // 与装备评价器共用存档，装备库互通
const TIER_CLASS = { 天: 'tian', 地: 'di', 玄: 'xuan', 黄: 'huang' };
const 攻具 = ['左武器', '右武器', '环', '佩'];

// ---------- 草稿（录入表单数据） ----------

/** 方案对该部位定音槽的推荐词条（攻具=攻具定音，护甲=防具定音） */
function planDingyin(slot, flow) {
  if (!flow) return '';
  return (攻具.includes(slot) ? flow.攻具定音 : flow.防具定音) || '';
}

function newDraft(slot = '左武器', weaponType = '', flow = null, affixData = null) {
  const A = affixData;
  const dyName = planDingyin(slot, flow);
  let dyVal = null;
  if (dyName && A) {
    const r = lookupRange(A, dyName);
    if (r && r.max != null) dyVal = r.max;
  }
  return {
    slot, weaponType, 承音: false,
    初始: { 属性: '', 数值: null },
    调律: [0, 1, 2, 3].map(() => ({ 属性: '', 数值: null })),
    定音: { 属性: dyName, 数值: dyVal },
  };
}

// ---------- 状态 ----------

const state = {
  buildId: null,
  data: null,           // { build, skills, effects }
  version: null,
  affixes: null,
  flows: null,          // { prefix, flows: [flow,...] } | null（流派无模板时为 null）
  flowId: null,
  prescription: null,   // derivePrescription 结果（仅当前流）
  graduate: null,       // computeGraduateDps 结果；null = 回退 build 包 Excel I16
  selections: { 弓玦: '', 装备套装: '', 心法: ['', '', '', ''], 武库: '' },
  equipped: {},         // { [slot]: piece }
  backpack: [],         // [piece + uid]
  selected: null,       // { kind:'equipped', slot } | { kind:'backpack', uid } | null
  editing: false,       // 中栏处于录入表单模式
  draft: newDraft(),
  uidSeq: 1,
  overall: null,        // 每次渲染时计算的整体视图（右栏毕业率/属性/监测的来源）
};

const $ = (sel) => document.querySelector(sel);
const leftEl = $('#st-left');
const centerEl = $('#st-center');
const rightEl = $('#st-right');
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
  const dir = `/data/schools/${buildId.split('.')[0]}`;
  const [build, skillsJson, effectsJson] = await Promise.all([
    fetchJson(`${dir}/${buildId}.json`),
    fetchJson(`${dir}/${buildId}.skills.json`),
    fetchJson(`${dir}/${buildId}.effects.json`),
  ]);
  return { build, skills: skillsJson.skills, effects: effectsJson.effects };
}

/** 分支模板发现：serve.js 列举 data/template/<流派>/ 目录，逐文件拉取（文件名主干即 flowId） */
async function loadFlows(buildId) {
  const prefix = buildId.split('.')[0];
  const listing = await fetchJson(FLOWS_API(prefix));
  const flows = [];
  for (const f of listing.files || []) {
    const stem = f.replace(/\.json$/, '');
    const flowId = stem.startsWith(`${prefix}.`) ? stem.slice(prefix.length + 1) : stem;
    const doc = await fetchJson(`/data/template/${prefix}/${f}`);
    flows.push({ ...doc, buildId: doc.buildId || prefix, flowId });
  }
  return { prefix, flows };
}

// ---------- 词条池 / 区间（与评价器同款） ----------

const isWeaponSlot = (slot) => WEAPON_SLOTS.includes(slot);

function initialPool(slot) {
  const g = state.affixes.词条池['初始词条池'];
  return g[isWeaponSlot(slot) ? '武器' : slot] || [];
}

function lawPool(slot, weaponType) {
  const pools = state.affixes.词条池['调律词条池'];
  if (isWeaponSlot(slot)) {
    const base = [...(pools['武器'] || pools['武器的调律词条池'] || [])];
    const spec = `${weaponType}武学增伤`;
    if ((pools['指定武学增伤'] || pools['指定武学增伤包括'] || []).includes(spec)) base.push(spec);
    return base;
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

const RANGE_ALIAS = {
  全奇术增伤: '奇术增伤',
  对首领单位增伤: '首领单位增伤',
  对玩家单位增伤: '玩家单位增效',
  对玩家单位增效: '玩家单位增效',
};

function lookupRange(affixData, name) {
  if (!name) return null;
  const A = affixData.词条区间 || {};
  const D = affixData.定音区间 || {};
  if (A[name]) return A[name];
  if (D[name]) return D[name];
  if (/武学增伤$/.test(name) && name !== '全武学增伤' && WEAPON_TYPES.some((t) => name.startsWith(t))) {
    return A['武器增伤'] || null;
  }
  if (Array.isArray(affixData.护甲定音词条) && affixData.护甲定音词条.includes(name)) {
    return D['技能定音'] || null;
  }
  if (RANGE_ALIAS[name]) return A[RANGE_ALIAS[name]] || null;
  return null;
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

function fmtMetric(x) {
  return Math.abs(x) <= 1 ? pctFmt(x) : (+x.toFixed(2)).toString();
}

/** 右栏属性面板的数值格式化：比率/增伤/定音用百分号，攻击与五维用数值 */
function fmtStatValue(key, v) {
  if (v == null) return '—';
  if (/率$|增伤$|增效$|加成$|定音$/.test(key) && Math.abs(v) <= 1) return pctFmt(v);
  if (key === '气血最大值') return String(Math.round(v));
  return (+v.toFixed(1)).toString();
}

// ---------- 数据与口径 ----------

function currentFlow() {
  if (!state.flows) return null;
  return state.flows.flows.find((f) => f.flowId === state.flowId) || state.flows.flows[0] || null;
}

function equippedList() {
  return SLOTS.map((s) => state.equipped[s]).filter(Boolean);
}

function backpackByUid(uid) {
  return state.backpack.find((b) => b.uid === uid) || null;
}

/** 生成不与现有装备冲突的 uid（含已穿戴件残留的旧 uid） */
function nextUid() {
  const used = new Set(state.backpack.map((b) => b.uid));
  for (const p of Object.values(state.equipped)) if (p?.uid) used.add(p.uid);
  let n = state.uidSeq;
  let uid = `b${n}`;
  while (used.has(uid)) { n += 1; uid = `b${n}`; }
  state.uidSeq = n + 1;
  return uid;
}

// ---------- 流派 / 流切换与方案 ----------

async function switchBuild(buildId) {
  state.buildId = buildId;
  boot('④ 拉取流派数据中…');
  state.data = await loadBuildData(buildId);
  const b = state.data.build;
  // 流派配额模板（仅部分流派有；404 优雅降级）
  state.flows = null;
  state.flowId = null;
  state.prescription = null;
  try {
    state.flows = await loadFlows(buildId);
    if (!state.flows.flows.some((f) => f.flowId === state.flowId)) {
      state.flowId = state.flows.flows[0]?.flowId ?? null;
    }
  } catch { /* 无模板：仅 DPS/面板可用 */ }
  applyFlow();
  applyPlanDefaults(); // 切流派：以方案默认覆盖口径选择（与评价器同款行为）
  // 录入草稿默认武器类型跟随流派（左/右武器）
  const cats = (b.weapon_categories || []).slice(1, 3).map((c) => c.label);
  state.draft = newDraft(
    state.draft.slot,
    state.draft.slot === '右武器' ? (cats[1] || '') : state.draft.slot === '左武器' ? (cats[0] || '') : '',
    currentFlow(), state.affixes,
  );
  save();
  render();
  boot('✓ 就绪');
}

function applyFlow() {
  const flow = currentFlow();
  if (!flow) { state.prescription = null; return; }
  // 流派武器类型（指定增跟武器类型走、跨槽自由排列）：来自 build.weapon_categories
  const weaponTypes = (state.data?.build.weapon_categories || []).slice(1, 3).map((c) => c.label);
  const p = derivePrescription(state.affixes, flow, weaponTypes);
  state.prescription = p && p.feasible ? p : null; // 模板不可行时按"无模板"降级
}

/** 方案推荐值 → 口径选择默认（用户改动只进面板，不动 DPS 参照系） */
function applyPlanDefaults() {
  const b = state.data?.build;
  const flow = currentFlow();
  state.selections.装备套装 = flow?.装备套装 || b?.selectors?.set || '';
  state.selections.武库 = flow?.武库 || b?.selectors?.weapon_attribute || '';
  state.selections.弓玦 = flow?.弓玦 || '';
  const xf = Array.isArray(flow?.心法) ? flow.心法 : [];
  state.selections.心法 = [0, 1, 2, 3].map((i) => xf[i] || '');
  refreshGraduate();
}

/** 毕业基准：按当前方案配额物化毕业装备生成；失败/无方案时 null → 回退 Excel I16 */
function refreshGraduate() {
  const flow = currentFlow();
  state.graduate = (state.prescription && flow)
    ? computeGraduateDps({
        buildCtx: state.data, version: state.version, affixes: state.affixes,
        selections: state.selections, prescription: state.prescription, flow,
      })
    : null;
}

function switchFlow(flowId) {
  state.flowId = flowId;
  applyFlow();
  applyPlanDefaults();
  state.selected = null;
  state.editing = false;
  save();
  render();
}

// ---------- 整体视图（右栏数据源） ----------

/** 有模板走 inspectOverall（含监测）；无模板降级为仅 DPS/面板；失败返回错误视图 */
function computeOverallSafe() {
  const flow = currentFlow();
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
  bind();
}

// ===== 左栏 =====

function pieceAffixRows(piece) {
  return [
    ['初', piece.初始],
    ...piece.调律.map((a, i) => [`律${i + 1}`, a]),
    ['定', piece.定音],
  ].filter(([, a]) => a && a.属性);
}

function tierBadgeHtml(piece, big = false) {
  if (!state.prescription) return '<span class="tier-badge">无模板</span>';
  const g = gradeItem(state.prescription, piece.slot, toGradeItem(piece));
  if (!g.ok) return `<span class="tier-badge" title="${escapeHtml((g.errors || []).join('；'))}">?</span>`;
  const cls = TIER_CLASS[g.tier] || '';
  const label = `${g.tier}${g.substate ? '·转' : ''}`;
  return `<span class="tier-badge ${cls} ${big ? 'big' : ''}" title="${escapeHtml(g.口径)}">${escapeHtml(label)}</span>`;
}

function toGradeItem(piece) {
  return {
    initial: piece?.初始?.属性,
    tunings: (piece?.调律 || []).map((t) => t?.属性),
    dingyin: piece?.定音?.属性,
  };
}

function slotCardHtml(slot) {
  const piece = state.equipped[slot];
  const selected = state.selected?.kind === 'equipped' && state.selected.slot === slot;
  if (!piece) {
    return `
      <div class="st-slot empty ${selected ? 'selected' : ''}" data-act="openEditor" data-slot="${escapeHtml(slot)}" title="点击录入${escapeHtml(slot)}装备">
        <div class="name">${escapeHtml(slot)}</div>
        <div class="empty-hint">空位<br>点击录入</div>
      </div>`;
  }
  const rows = pieceAffixRows(piece)
    .map(([k, a]) => `<div title="${escapeHtml(k)}·${escapeHtml(a.属性)} ${escapeHtml(fmtAffixValue(a.属性, a.数值))}"><span class="k">${k}</span> ${escapeHtml(a.属性)}</div>`)
    .join('');
  return `
    <div class="st-slot ${selected ? 'selected' : ''}" data-sel-kind="equipped" data-sel-slot="${escapeHtml(slot)}">
      <div class="name"><span>${escapeHtml(slot)}${piece.承音 ? '<span class="muted">·承</span>' : ''}</span>${tierBadgeHtml(piece)}</div>
      <div class="affixes">${rows || '<div>未录词条</div>'}</div>
    </div>`;
}

function bpCardHtml(piece) {
  const selected = state.selected?.kind === 'backpack' && state.selected.uid === piece.uid;
  const rows = pieceAffixRows(piece)
    .map(([k, a]) => `<div><span class="k">${k}</span><span class="n" title="${escapeHtml(a.属性)}">${escapeHtml(a.属性)}</span><span class="v">${escapeHtml(fmtAffixValue(a.属性, a.数值))}</span></div>`)
    .join('');
  return `
    <div class="st-bp-card ${selected ? 'selected' : ''}" data-sel-kind="backpack" data-sel-uid="${escapeHtml(piece.uid)}">
      <div class="st-bp-head">
        <span>${escapeHtml(piece.slot)}${piece.weaponType ? ` · ${escapeHtml(piece.weaponType)}` : ''}${piece.承音 ? ' <span class="muted">承音</span>' : ''}</span>
        ${tierBadgeHtml(piece)}
      </div>
      <div class="st-bp-affixes">${rows || '<div class="muted">未录词条</div>'}</div>
    </div>`;
}

function renderLeft() {
  const n = state.backpack.length;
  leftEl.innerHTML = `
    <section class="st-panel">
      <div class="st-sec-title"><span>已穿戴（8 部位）</span><span class="muted">点击查看评价</span></div>
      ${SLOT_ROWS.map((row) => `<div class="st-slots" style="margin-bottom:8px">${row.map(slotCardHtml).join('')}</div>`).join('')}
    </section>
    <section class="st-panel">
      <div class="st-sec-title"><span>背包</span><span class="muted">${n} 件未穿戴</span></div>
      <div class="st-backpack">
        ${n ? state.backpack.map(bpCardHtml).join('') : '<p class="muted">空——点「录入装备」添加，或把已穿戴的脱下</p>'}
      </div>
    </section>`;
}

// ===== 中栏 =====

function affixTableHtml(piece) {
  const rows = [['初始', piece.初始], ...piece.调律.map((a, i) => [`调律 ${i + 1}`, a]), ['定音', piece.定音]];
  return `
    <table class="st-affix-table">
      <tr><th>位置</th><th>词条</th><th style="text-align:right">数值</th></tr>
      ${rows.map(([k, a]) => `
        <tr>
          <td class="pos">${k}</td>
          <td>${a?.属性 ? escapeHtml(a.属性) : '<span class="muted">— 未录 —</span>'}</td>
          <td class="num">${a?.属性 ? escapeHtml(fmtAffixValue(a.属性, a.数值)) || '<span class="muted">待补</span>' : ''}</td>
        </tr>`).join('')}
    </table>`;
}

function detailHeadHtml(title, piece, actionBtns) {
  return `
    <div class="st-detail-head">
      <h3>${escapeHtml(title)}${piece.承音 ? ' <span class="muted">承音</span>' : ''} ${tierBadgeHtml(piece, true)}</h3>
      <div class="st-detail-actions">${actionBtns}</div>
    </div>`;
}

function evalDeltaHtml(d) {
  const cls = d.verdict === '更好' ? 'better' : d.verdict === '更差' ? 'worse' : 'equal';
  const sign = d.deltaPct >= 0 ? '+' : '';
  return `
    <div class="verdict-row">
      <span class="verdict-badge big ${cls}">${escapeHtml(d.verdict)}</span>
      <span class="delta-big ${d.deltaPct > 0 ? 'up' : d.deltaPct < 0 ? 'down' : ''}">${sign}${(d.deltaPct * 100).toFixed(2)}%</span>
      <span>${escapeHtml(d.recommendation)}</span>
    </div>
    <div class="muted">DPS ${d.before.dps.toFixed(1)} → ${d.after.dps.toFixed(1)}${d.tieBreak ? ` · 次级排序：${escapeHtml(d.tieBreak)}` : ''}</div>
    ${d.去向 ? `<div style="margin-top:6px">去向：旧件——${escapeHtml(d.去向.旧件 || '—')}；新件——${escapeHtml(d.去向.新件 || '—')}${d.去向.候补 ? ' · <b>候补</b>' : ''}</div>` : ''}
    ${panelDiffHtml(d.panelDiff)}`;
}

function renderCenter() {
  const s = state.selected;
  let html = '';
  if (state.editing) {
    html = `<section class="st-panel st-editor">
      <div class="st-sec-title"><span>录入装备（进背包）</span><span class="muted">选词条自动填区间最大值</span></div>
      ${editorHtml()}
    </section>`;
  } else if (s?.kind === 'equipped' && state.equipped[s.slot]) {
    html = equippedDetailHtml(state.equipped[s.slot], s.slot);
  } else if (s?.kind === 'backpack') {
    const piece = backpackByUid(s.uid);
    if (!piece) { state.selected = null; html = idleHtml(); }
    else html = candidateDetailHtml(piece);
  } else {
    html = idleHtml();
  }
  centerEl.innerHTML = html;
}

function idleHtml() {
  return `
    <section class="st-panel st-idle">
      <button id="st-open-editor" class="big">＋ 录入装备</button>
      <p class="muted">点击左侧装备卡片，查看词条与评价<br>再次点击同一卡片取消选中</p>
    </section>`;
}

function equippedDetailHtml(piece, slot) {
  const flow = currentFlow();
  let body;
  if (!state.prescription || !flow) {
    body = '<p class="muted">当前流派暂无配额模板——匹配度与监测不可用。</p>';
  } else {
    try {
      const r = inspectEquipped({
        buildCtx: state.data, version: state.version, affixes: state.affixes,
        selections: state.selections, gear: equippedList(), piece,
        prescription: state.prescription, flow,
        graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
      });
      body = `
        <div class="st-eval"><h4>① 匹配度（留什么）</h4>${gradeDetailHtml(r.匹配度)}</div>
        <div class="st-eval"><h4>② ΔDPS（穿什么）</h4><div class="dim-note">已穿戴装备：不与其他同部位装备比较，无 ΔDPS。换成背包同部位装备可看对比；全局的溢出/不足见右栏「整体监测发现」。</div></div>`;
    } catch (err) {
      body = `<ul class="warnings"><li>评价计算出错：${escapeHtml(err.message)}</li></ul>`;
    }
  }
  return `
    <section class="st-panel">
      ${detailHeadHtml(`已穿戴 · ${slot}`, piece, `
        <button class="primary" data-act="unequip" data-slot="${escapeHtml(slot)}">脱下</button>
        <button class="ghost" data-act="removeEquipped" data-slot="${escapeHtml(slot)}">删除</button>`)}
      ${affixTableHtml(piece)}
      ${body}
    </section>`;
}

function candidateDetailHtml(piece) {
  const flow = currentFlow();
  let body;
  if (!state.prescription || !flow) {
    body = '<p class="muted">当前流派暂无配额模板——匹配度与监测不可用。</p>';
  } else {
    try {
      const r = inspectCandidate({
        buildCtx: state.data, version: state.version, affixes: state.affixes,
        selections: state.selections, gear: equippedList(), newItem: piece,
        prescription: state.prescription, flow,
        graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
      });
      const d = r.ΔDPS;
      body = `
        <div class="st-eval"><h4>① ΔDPS（穿什么）——与同部位已穿戴对比</h4>${evalDeltaHtml(d)}</div>
        <div class="st-eval"><h4>② 匹配度（留什么）</h4>${gradeDetailHtml(r.匹配度)}</div>
        <div class="dim-note">监测发现属全局装备组合口径，见右栏「整体监测发现」。</div>`;
    } catch (err) {
      body = `<ul class="warnings"><li>评价计算出错：${escapeHtml(err.message)}</li></ul>`;
    }
  }
  return `
    <section class="st-panel">
      ${detailHeadHtml(`背包 · ${piece.slot}${piece.weaponType ? ` · ${piece.weaponType}` : ''}`, piece, `
        <button class="primary" data-act="equip" data-uid="${escapeHtml(piece.uid)}">穿上</button>
        <button class="ghost" data-act="removeBackpack" data-uid="${escapeHtml(piece.uid)}">删除</button>`)}
      ${affixTableHtml(piece)}
      ${body}
    </section>`;
}

// ===== 录入表单（边录入边评价） =====

/** 草稿 → 装备件形状（供引擎评价与入包共用） */
function draftPiece() {
  const p = state.draft;
  return {
    slot: p.slot,
    weaponType: p.weaponType || undefined,
    承音: p.承音 || undefined,
    初始: { 属性: p.初始.属性, 数值: p.初始.数值 },
    调律: p.调律.map((a) => ({ 属性: a.属性, 数值: a.数值 })),
    定音: { 属性: p.定音.属性, 数值: p.定音.数值 },
  };
}

/** 录入表单的实时评价状态：潜力（部分录入）+ 毕业率变化与三向建议（结构录满） */
function editorEvalState() {
  const p = state.draft;
  const n = (p.初始.属性 ? 1 : 0) + p.调律.filter((a) => a.属性).length;
  const complete = !!(p.初始.属性 && p.调律.every((a) => a.属性));
  let pot = null;
  if (state.prescription && n > 0) {
    pot = gradeItemPotential(state.prescription, p.slot, toGradeItem(p));
  }
  let swap = null;
  if (complete) {
    try {
      swap = evaluateSwap({
        buildCtx: state.data, version: state.version, affixes: state.affixes,
        selections: state.selections, currentGear: equippedList(), newItem: draftPiece(),
        prescription: state.prescription,
        graduateDps: state.graduate?.ok ? state.graduate.dps : undefined,
      });
    } catch { swap = null; }
  }
  let advice = null;
  if (swap?.ok) {
    if (swap.verdict === '更好' || (swap.verdict === '等价' && swap.swapRecommended)) {
      advice = { key: 'equip', text: swap.replacedOld ? '直接穿上（替换当前同部位）' : '直接穿上（补上空位）' };
    } else if (swap.候补) {
      advice = { key: 'keep', text: '保留到背包（候补：当前穿戴更优，但这件有长期价值）' };
    } else {
      advice = { key: 'discard', text: '直接回收删除（不如当前穿戴，且无长期价值）' };
    }
  }
  return { n, complete, pot, swap, advice };
}

function potentialReasonHtml(pot) {
  const reasons = [];
  if (pot.missing?.length) {
    reasons.push(`还缺：${pot.missing.map((m) => {
      const label = Array.isArray(m.affix) ? `(${m.affix.join('/')})` : m.affix;
      return m.deficit ? `${label}×${m.deficit}` : label;
    }).join('、')}`);
  }
  if (pot.invalidAffixes?.length) {
    reasons.push(`无效词条：${pot.invalidAffixes.map((u) => u.affix).join('、')}`);
  }
  if (reasons.length) {
    return `<div class="digest">${reasons.map((r) => `<div>${escapeHtml(r)}</div>`).join('')}</div>`;
  }
  return '';
}

function editorEvalHtml(s) {
  const parts = [];
  parts.push(`<div class="st-sec-title" style="margin-top:12px"><span>实时评价（尚未入包）</span><span class="muted">已录 ${s.n}/5 词条</span></div>`);
  if (s.pot) {
    if (!s.pot.ok) {
      parts.push(`<ul class="warnings">${(s.pot.errors || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`);
    } else {
      const cls = TIER_CLASS[s.pot.tier] || '';
      const sub = s.pot.substate ? '（需1次转律）' : '';
      parts.push(`
        <div class="verdict-row">
          <span class="muted">当前潜力</span>
          <span class="tier-badge big ${cls}" title="${escapeHtml(s.pot.口径)}">${escapeHtml(s.pot.tier)}${sub}</span>
          <span class="muted">空位按最优填充 + 转律后最高可达</span>
        </div>
        ${potentialReasonHtml(s.pot)}
        ${s.pot.warnings?.length ? `<ul class="warnings">${s.pot.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}`);
    }
  } else if (s.n > 0) {
    parts.push('<p class="muted">当前流派无配额模板——潜力不可评，仅 DPS 可比。</p>');
  }
  if (s.swap?.ok) {
    const d = s.swap;
    const cls = d.verdict === '更好' ? 'better' : d.verdict === '更差' ? 'worse' : 'equal';
    const grBefore = d.before.graduationRate;
    const grAfter = d.after.graduationRate;
    const dpp = grBefore != null && grAfter != null ? grAfter - grBefore : null;
    const sign = dpp != null && dpp >= 0 ? '+' : '';
    parts.push(`
      <h4 class="sec" style="margin-top:12px">毕业率变化（假设穿上）</h4>
      <div class="verdict-row">
        <span class="verdict-badge big ${cls}">${escapeHtml(d.verdict)}</span>
        ${dpp != null ? `<span class="delta-big ${dpp > 0 ? 'up' : dpp < 0 ? 'down' : ''}">${sign}${(dpp * 100).toFixed(2)}pp</span>` : ''}
        <span>${escapeHtml(d.recommendation)}</span>
      </div>
      <div class="muted">毕业率 ${grBefore != null ? escapeHtml(pctFmt(grBefore)) : '—'} → ${grAfter != null ? escapeHtml(pctFmt(grAfter)) : '—'} · DPS ${d.deltaPct >= 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(2)}%</div>`);
  } else if (s.complete && !s.swap) {
    parts.push('<p class="muted" style="margin-top:8px">毕业率变化暂不可计算（数据不全或引擎出错）。</p>');
  }
  if (s.advice) {
    parts.push(`<div style="margin-top:8px">建议：<b>${escapeHtml(s.advice.text)}</b></div>`);
  }
  return `<div class="st-live-eval">${parts.join('')}</div>`;
}

function editorHtml() {
  const p = state.draft;
  const s = editorEvalState();
  const complete = s.complete;
  const row = (kind, idx = null) => {
    const aff = kind === '调律' ? p.调律[idx] : p[kind];
    const pool = kind === '初始' ? initialPool(p.slot)
      : kind === '调律' ? lawPool(p.slot, p.weaponType)
        : dingyinPool(p.slot);
    const name = aff.属性 || '';
    const pct = isPercentAffix(name);
    const val = aff.数值 == null ? '' : (pct ? +(aff.数值 * 100).toFixed(4) : aff.数值);
    const ph = placeholderFor(name, p.承音 && kind !== '定音');
    const idxAttr = idx == null ? '' : ` data-ed-idx="${idx}"`;
    return `
      <div class="affix-row">
        <span class="tag">${kind === '调律' ? '调律' + (idx + 1) : kind}</span>
        <select data-ed-kind="${kind}"${idxAttr} data-ed-field="属性">${optionList(pool, name)}</select>
        <input type="number" step="any" data-ed-kind="${kind}"${idxAttr} data-ed-field="数值" value="${val}" placeholder="${escapeHtml(ph)}" title="${escapeHtml(ph)}">
        <span class="unit">${pct ? '%' : ''}</span>
      </div>`;
  };
  return `
    <div class="st-editor-head">
      <label>部位</label>
      <select id="ed-slot">${SLOTS.map((s) => `<option value="${s}" ${s === p.slot ? 'selected' : ''}>${s}</option>`).join('')}</select>
      ${isWeaponSlot(p.slot) ? `<label>武器</label><select id="ed-wtype">${optionList(WEAPON_TYPES, p.weaponType)}</select>` : ''}
      <label>承音</label><input type="checkbox" id="ed-chengyin" ${p.承音 ? 'checked' : ''}>
    </div>
    ${row('初始')}${[0, 1, 2, 3].map((i) => row('调律', i)).join('')}${row('定音')}
    <p class="muted" style="margin:6px 0 0">选词条自动填区间最大值；勾选承音自动改为承音值（定音不受限）；百分比词条按百分号数值录入</p>
    ${s.n > 0 ? editorEvalHtml(s) : ''}
    <div class="st-editor-btns">
      ${complete ? `<button id="ed-equip" class="${s.advice?.key === 'equip' ? 'primary' : 'ghost'}">直接穿上</button>` : ''}
      <button id="ed-add" class="${!s.advice || s.advice.key === 'keep' ? 'primary' : 'ghost'}">添加到背包</button>
      <button id="ed-discard" class="${s.advice?.key === 'discard' ? 'primary' : 'ghost'}">丢弃</button>
      <button id="ed-cancel" class="ghost">取消</button>
    </div>`;
}

// ===== 右栏 =====

function gradHtml() {
  const o = state.overall;
  const g = state.graduate;
  if (!o?.ok) {
    return `<ul class="warnings">${(o?.errors || ['整体计算失败']).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  }
  const rate = o.DPS.graduationRate;
  const notes = [];
  if (g?.ok) {
    const dev = g.deviation != null ? `，偏差 ${(g.deviation * 100).toFixed(1)}%` : '';
    notes.push(`基准=当前方案配额物化（Excel I16 对照 ${Math.round(g.excelBaseline || 0)}${dev}）`);
  } else if (g && !g.ok) {
    notes.push(`⚠ 毕业基准生成失败：${(g.errors || []).join('；')}（回退 Excel I16）`);
  } else if (o.degraded) {
    notes.push('无配额模板：匹配度/监测不可用，毕业率按 build 包 Excel I16 基准');
  } else {
    notes.push('基准=build 包 Excel I16');
  }
  return `
    <div class="st-grad-num">${rate != null ? escapeHtml(pctFmt(rate)) : '—'}</div>
    <div class="muted st-grad-note">DPS 毕业率 = 当前装备组合 DPS ÷ 毕业基准。${escapeHtml(notes.join('；'))}</div>
    ${o.面板警告?.length ? `<ul class="warnings">${o.面板警告.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}`;
}

const STAT_GROUPS_TEMPLATE = [
  ['三率', ['精准率', '会心率', '会意率', '直接会心率', '直接会意率', '最终生效会心率', '最终生效会意率', '最终生效会心会意率']],
  ['攻击与穿透', ['最小外功攻击', '最大外功攻击', '最小{main}攻击', '最大{main}攻击', '外功穿透']],
  ['增伤与定音', ['全武学增伤', '对首领单位增伤', '全奇术增伤', '技能定音', '会心伤害加成', '会意伤害加成']],
  ['五维与生存', ['体', '劲', '御', '敏', '势', '气血最大值']],
];

/** 属性面板（其余非零属性归入"其他"组；零值过滤是 UI 的事——交接文档 §0.5） */
function statsHtml() {
  const o = state.overall;
  if (!o?.ok || !o.属性面板) return '<p class="muted">整体计算失败，无属性面板。</p>';
  const stats = o.属性面板;
  const main = state.data?.build.selectors.weapon_attribute || '';
  const shown = new Set();
  const overflowMark = (k) => (k === '会心率' && stats[k] > 0.8) || (k === '会意率' && stats[k] > 0.4) ? ' ⚠溢出' : '';
  const rowHtml = (k) => {
    shown.add(k);
    return `<div><span>${escapeHtml(k)}</span><span>${escapeHtml(fmtStatValue(k, stats[k]))}${overflowMark(k)}</span></div>`;
  };
  const groupHtml = (title, keys) => {
    const rows = keys
      .map((k) => k.replace('{main}', main))
      .filter((k) => stats[k] != null)
      .map(rowHtml).join('');
    return rows ? `<div class="st-stat-group"><h5>${title}</h5><div class="st-stats">${rows}</div></div>` : '';
  };
  let html = STAT_GROUPS_TEMPLATE.map(([t, ks]) => groupHtml(t, ks)).join('');
  // 其他非零属性：具名/无相攻击、指定武学增伤、穿透/加成、抗性防御等
  const EXTRA = [
    '最小鸣金攻击', '最大鸣金攻击', '最小裂石攻击', '最大裂石攻击', '最小牵丝攻击', '最大牵丝攻击',
    '最小破竹攻击', '最大破竹攻击', '最小无相攻击', '最大无相攻击',
    ...WEAPON_TYPES.map((t) => `${t}武学增伤`),
    '鸣金穿透', '鸣金加成', '裂石穿透', '裂石加成', '牵丝穿透', '牵丝加成',
    '破竹穿透', '破竹加成', '无相穿透', '外功伤害加成', '对玩家单位增效',
    '外功抗性', '外功防御', '外功伤害减免', '外功治疗加成', '鸣金伤害加成',
  ];
  const extraRows = EXTRA
    .filter((k) => !shown.has(k) && stats[k] != null && stats[k] !== 0)
    .map(rowHtml).join('');
  if (extraRows) html += `<div class="st-stat-group"><h5>其他（非零）</h5><div class="st-stats">${extraRows}</div></div>`;
  return html;
}

function renderRight() {
  const b = state.data?.build;
  const flow = currentFlow();
  const flowSel = state.flows
    ? `<select id="st-flow">${state.flows.flows
        .map((f) => `<option value="${escapeHtml(f.flowId)}" ${f.flowId === state.flowId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}</select>`
    : `<select id="st-flow" disabled><option value="">— 无模板 —</option></select>`;
  const monitoring = state.overall?.ok && state.overall.监测
    ? digestHtml(state.overall.监测)
    : '<p class="muted">无配额模板——监测不可用。</p>';
  rightEl.innerHTML = `
    <section class="st-panel">
      <div class="st-sec-title"><span>口径（半固定层）</span><button id="st-plan-reset" class="st-plan-reset">恢复方案默认</button></div>
      <div class="st-field"><label>流派</label><select id="st-build">${BUILDS.map(([id, name]) => `<option value="${escapeHtml(id)}" ${id === state.buildId ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></div>
      <div class="st-field"><label>流（方案）</label>${flowSel}</div>
      ${[0, 1, 2, 3].map((i) => `<div class="st-field"><label>心法${i + 1}</label><select id="st-xinfa-${i}">${optionList(Object.keys(state.version.心法), state.selections.心法[i])}</select></div>`).join('')}
      <div class="st-field"><label>武库</label><select id="st-arsenal">${optionList(Object.keys(state.version.武库), state.selections.武库)}</select></div>
      <div class="st-field"><label>装备套装</label><select id="st-set">${optionList(Object.keys(state.version.装备套装), state.selections.装备套装)}</select></div>
      <div class="st-field"><label>弓玦套装</label><select id="st-gongjue">${optionList(Object.keys(state.version.弓玦), state.selections.弓玦)}</select></div>
    </section>
    <section class="st-panel">
      <div class="st-sec-title"><span>DPS 毕业率</span></div>
      ${gradHtml()}
    </section>
    <section class="st-panel">
      <div class="st-sec-title"><span>属性面板</span><span class="muted">${b ? escapeHtml(b.name) + ' · 主属性 ' + escapeHtml(b.selectors.weapon_attribute) : ''}</span></div>
      ${statsHtml()}
    </section>
    <section class="st-panel">
      <div class="st-sec-title"><span>整体监测发现（当前实装）</span></div>
      ${monitoring}
    </section>
    <p class="muted st-foot-meta">装备库为全局（切流派只切换评价口径）；完整评价语境 = 流派 × 轴 × 流${flow ? ` · 当前：${escapeHtml(state.flows?.flows.find((f) => f.flowId === state.flowId)?.name || flow.flowId)}` : ''}</p>`;
}

// ---------- 评价明细（与评价器同款展示） ----------

function digestHtml(d) {
  const parts = [];
  if (d.达标未达.length) {
    parts.push(`<div class="digest"><div class="digest-title">三率/关键属性未达标</div>${d.达标未达.map((r) =>
      `<div>「${escapeHtml(r.指标)}」当前 ${fmtMetric(r.当前值)} ＜ 阈值 ${fmtMetric(r.阈值)}（差 ${pctFmt(r.差距)}）</div>`).join('')}</div>`);
  }
  if (d.配额缺口.length) {
    parts.push(`<div class="digest"><div class="digest-title">配额缺口</div>${d.配额缺口.map((r) =>
      `<div>「${escapeHtml(r.词条.join('/'))}」需要 ${r.需要} / 实装 ${r.实装}（缺 ${r.缺口}）</div>`).join('')}</div>`);
  }
  if (d.配额溢出.length) {
    parts.push(`<div class="digest"><div class="digest-title">配额溢出</div>${d.配额溢出.map((r) =>
      `<div>「${escapeHtml(r.词条.join('/'))}」实装 ${r.实装} / 需要 ${r.需要}（多 ${r.溢出}）</div>`).join('')}</div>`);
  }
  const un = Object.entries(d.未配额词条 || {});
  if (un.length) {
    parts.push(`<div class="digest"><div class="digest-title">未配额词条（白占槽位）</div>${un.map(([k, n]) =>
      `<div>「${escapeHtml(k)}」×${n}</div>`).join('')}</div>`);
  }
  if (d.启用度 && d.启用度.适用) {
    const e = d.启用度;
    parts.push(`<div class="digest"><div class="digest-title">小外流启用度</div><div>${
      e.已反转
        ? `已反转（最小外功攻击 ${e.最小外功攻击.toFixed(0)} ＞ 最大外功攻击 ${e.最大外功攻击.toFixed(0)}）——伤害固定取最小外功攻击`
        : `未反转：最小外功攻击 ${e.最小外功攻击.toFixed(0)} / 最大外功攻击 ${e.最大外功攻击.toFixed(0)}，距反转差 ${e.距反转差值} 点${e.折算词条数 != null ? ` ≈ ${e.折算词条数} 条小外词条（${escapeHtml(e.折算口径 || '')}）` : ''}`
    }</div></div>`);
  }
  if (!parts.length) return '<p class="muted">监测无发现：三率全部达标，配额无缺口/溢出。</p>';
  return parts.join('');
}

function gradeDetailHtml(g) {
  if (!g.ok) {
    return `<ul class="warnings">${(g.errors || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  }
  const parts = [];
  if (typeof g.k === 'number') {
    parts.push(`<div class="muted">无效词条 ${g.k} 条 · 缺必备 ${g.m} 条${g.globalFitVerified === false ? ' · ⚠ 全局复核未通过' : ''}${g.globalFitVerified === true ? ' · 全局复核 ✓' : ''}</div>`);
  }
  if (g.missing?.length) {
    parts.push(`<div class="digest"><div class="digest-title">缺必备</div>${g.missing.map((m) => {
      const label = Array.isArray(m.affix) ? `任选：${m.affix.join('/')}` : escapeHtml(m.affix);
      return `<div>${m.type === '初始位' ? `初始位应为「${escapeHtml(m.affix)}」` : `「${label}」还差 ${m.deficit} 条`}</div>`;
    }).join('')}</div>`);
  }
  if (g.invalidAffixes?.length) {
    parts.push(`<div class="digest"><div class="digest-title">无效词条</div>${g.invalidAffixes.map((u) =>
      `<div>「${escapeHtml(u.affix)}」（${u.position === 'initial' ? '初始' : '调律'}位）</div>`).join('')}</div>`);
  }
  if (g.notes?.length) parts.push(`<div class="digest">${g.notes.map((n) => `<div>${escapeHtml(n)}</div>`).join('')}</div>`);
  if (g.warnings?.length) parts.push(`<ul class="warnings">${g.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);
  return parts.join('') || '<p class="muted">无明细</p>';
}

function panelDiffHtml(diff) {
  if (!diff?.length) return '';
  const rows = diff.slice(0, 8).map((r) => {
    const isRate = Math.abs(r.前) <= 1 || Math.abs(r.后) <= 1;
    const f = (x) => (isRate ? pctFmt(x) : (+x.toFixed(1)).toString());
    return `<tr><td>${escapeHtml(r.属性)}</td><td class="num">${f(r.前)} → ${f(r.后)}</td><td class="num ${r.方向 === '↑' ? 'up' : 'down'}">${r.方向}</td></tr>`;
  }).join('');
  return `<details><summary>面板差异（前 → 后）</summary><table class="diff-table">${rows}</table></details>`;
}

// ---------- 事件绑定 ----------

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    buildId: state.buildId, flowId: state.flowId, selections: state.selections,
    equipped: state.equipped, backpack: state.backpack,
  }));
}

function bind() {
  // 左栏：选中装备（再次点击取消）；空槽位 → 直接进入录入表单
  for (const el of leftEl.querySelectorAll('[data-sel-kind]')) {
    el.onclick = () => actions.select({
      kind: el.dataset.selKind,
      slot: el.dataset.selSlot || undefined,
      uid: el.dataset.selUid || undefined,
    });
  }
  for (const el of leftEl.querySelectorAll('[data-act="openEditor"]')) {
    el.onclick = () => actions.openEditor(el.dataset.slot);
  }
  // 中栏
  const openBtn = $('#st-open-editor');
  if (openBtn) openBtn.onclick = () => actions.openEditor();
  const edSlot = $('#ed-slot');
  if (edSlot) edSlot.onchange = (e) => actions.setDraftSlot(e.target.value);
  const wtype = $('#ed-wtype');
  if (wtype) wtype.onchange = (e) => actions.setDraftWeaponType(e.target.value);
  const chengyin = $('#ed-chengyin');
  if (chengyin) chengyin.onchange = (e) => actions.setDraftChengyin(e.target.checked);
  const edAdd = $('#ed-add');
  if (edAdd) edAdd.onclick = () => actions.addDraft();
  const edEquip = $('#ed-equip');
  if (edEquip) edEquip.onclick = () => actions.addAndEquip();
  const edDiscard = $('#ed-discard');
  if (edDiscard) edDiscard.onclick = () => actions.resetDraft();
  const edCancel = $('#ed-cancel');
  if (edCancel) edCancel.onclick = () => actions.cancelEditor();
  for (const el of centerEl.querySelectorAll('[data-ed-field]')) {
    el.onchange = onDraftFieldChange;
  }
  // 中栏详情的动作按钮（穿上/脱下/删除）
  for (const el of centerEl.querySelectorAll('[data-act]')) {
    el.onclick = (e) => {
      e.stopPropagation();
      const { act, uid, slot } = el.dataset;
      if (act === 'equip') actions.equip(uid);
      else if (act === 'unequip') actions.unequip(slot);
      else if (act === 'removeBackpack') actions.removeBackpack(uid);
      else if (act === 'removeEquipped') actions.removeEquipped(slot);
    };
  }
  // 右栏：口径选择
  const buildSel = $('#st-build');
  if (buildSel) buildSel.onchange = () => actions.changeBuild(buildSel.value);
  const flowSel = $('#st-flow');
  if (flowSel && !flowSel.disabled) flowSel.onchange = () => switchFlow(flowSel.value);
  const planReset = $('#st-plan-reset');
  if (planReset) planReset.onclick = () => actions.resetPlanDefaults();
  $('#st-gongjue').onchange = (e) => actions.setSelection('弓玦', e.target.value);
  $('#st-set').onchange = (e) => actions.setSelection('装备套装', e.target.value);
  $('#st-arsenal').onchange = (e) => actions.setSelection('武库', e.target.value);
  [0, 1, 2, 3].forEach((i) => {
    $(`#st-xinfa-${i}`).onchange = (e) => actions.setSelection('心法', e.target.value, i);
  });
}

function onDraftFieldChange(e) {
  const { edKind: kind, edIdx, edField: field } = e.target.dataset;
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
  /** 点击装备：选中 → 中栏详情；再次点击同一件 → 取消选中回到录入按钮 */
  select(ref) {
    const cur = state.selected;
    const same = cur && ref
      && cur.kind === ref.kind
      && (ref.kind === 'equipped' ? cur.slot === ref.slot : cur.uid === ref.uid);
    state.selected = same ? null : ref;
    state.editing = false;
    render();
    return state.selected;
  },

  /** 打开录入表单；传 slot 可预选部位（左栏空槽位点击） */
  openEditor(slot) {
    state.editing = true;
    state.selected = null;
    if (slot && SLOTS.includes(slot) && slot !== state.draft.slot) {
      const cats = (state.data?.build.weapon_categories || []).slice(1, 3).map((c) => c.label);
      const wt = slot === '左武器' ? (cats[0] || '') : slot === '右武器' ? (cats[1] || '') : '';
      state.draft = newDraft(slot, isWeaponSlot(slot) ? wt : '', currentFlow(), state.affixes);
    }
    render();
  },

  cancelEditor() {
    state.editing = false;
    render();
  },

  changeBuild(buildId) {
    switchBuild(buildId).catch((err) => {
      centerEl.innerHTML = `<section class="st-panel"><ul class="warnings"><li>切换流派失败：${escapeHtml(err.message)}</li></ul></section>`;
      boot('切流失败', 'err');
    });
  },

  setSelection(field, value, idx = null) {
    if (field === '心法') state.selections.心法[idx] = value;
    else state.selections[field] = value;
    refreshGraduate();
    save();
    render();
  },

  resetPlanDefaults() {
    applyPlanDefaults();
    save();
    render();
  },

  setDraftSlot(slot) {
    const cats = (state.data?.build.weapon_categories || []).slice(1, 3).map((c) => c.label);
    const wt = slot === '左武器' ? (cats[0] || state.draft.weaponType)
      : slot === '右武器' ? (cats[1] || state.draft.weaponType)
        : state.draft.weaponType;
    state.draft = newDraft(slot, isWeaponSlot(slot) ? wt : '', currentFlow(), state.affixes);
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
    target.属性 = name;
    const r = lookupRange(state.affixes, name);
    if (r && r.max != null) {
      target.数值 = (state.draft.承音 && kind !== '定音' && r.承音 != null) ? r.承音 : r.max;
    } else {
      target.数值 = null;
    }
    save(); render();
  },

  addDraft() {
    const p = state.draft;
    if (!p.初始.属性) return null;
    const uid = nextUid();
    state.backpack.push({ ...draftPiece(), uid });
    state.editing = false;
    state.selected = { kind: 'backpack', uid };
    state.draft = newDraft(p.slot, p.weaponType, currentFlow(), state.affixes);
    save(); render();
    return uid;
  },

  /** 录入后直接穿上（入包 + 装备一步完成；被替换的旧件进背包） */
  addAndEquip() {
    const uid = actions.addDraft();
    if (!uid) return null;
    actions.equip(uid);
    return uid;
  },

  equip(uid) {
    const i = state.backpack.findIndex((b) => b.uid === uid);
    if (i < 0) return;
    const piece = state.backpack.splice(i, 1)[0];
    const old = state.equipped[piece.slot];
    if (old) state.backpack.push({ ...old, uid: nextUid() });
    state.equipped[piece.slot] = piece;
    state.selected = { kind: 'equipped', slot: piece.slot };
    save(); render();
  },

  unequip(slot) {
    const piece = state.equipped[slot];
    if (!piece) return;
    delete state.equipped[slot];
    const uid = nextUid();
    state.backpack.push({ ...piece, uid });
    state.selected = { kind: 'backpack', uid };
    save(); render();
  },

  removeBackpack(uid) {
    state.backpack = state.backpack.filter((b) => b.uid !== uid);
    if (state.selected?.kind === 'backpack' && state.selected.uid === uid) state.selected = null;
    save(); render();
  },

  removeEquipped(slot) {
    delete state.equipped[slot];
    if (state.selected?.kind === 'equipped' && state.selected.slot === slot) state.selected = null;
    save(); render();
  },
};

// ---------- 启动 ----------

function showError(title, detail) {
  leftEl.innerHTML = `<section class="st-panel"><ul class="warnings"><li><b>${escapeHtml(title)}</b></li><li>${escapeHtml(detail)}</li></ul></section>`;
}

window.addEventListener('error', (e) => showError('脚本错误', e.message));
window.addEventListener('unhandledrejection', (e) => showError('异步错误', String(e.reason)));

if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    showError('打开方式错误', '本页面需要通过本地服务器打开：请访问 http://127.0.0.1:4173/web/studio.html （在工作区根目录运行 node tools/serve.js 启动）');
  });
}

async function init() {
  // manifest 单点声明当前赛季与流派清单；旧赛季目录原地保留但不加载
  const manifest = await fetchJson('/data/version/manifest.json');
  const season = manifest['当前赛季'];
  BUILDS = (manifest['流派'] || []).map((b) => [b.id, b.name]);
  if (!BUILDS.length) throw new Error('manifest.json 缺少流派清单（"流派"字段）');
  state.version = await fetchJson(`/data/version/${season}/version.json`);
  state.affixes = await fetchJson(`/data/version/${season}/affixes.json`);
  boot('③ 数据已加载，恢复存档…');
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.buildId) {
      state.buildId = saved.buildId;
      state.flowId = saved.flowId ?? null;
      state.selections = { ...state.selections, ...saved.selections };
      state.equipped = saved.equipped || {};
      state.backpack = saved.backpack || [];
      // uid 计数器对齐存量（含已穿戴件残留的旧 uid），避免新件撞号
      let maxSeq = 0;
      const scan = (p) => { const m = /^b(\d+)$/.exec(p?.uid || ''); if (m) maxSeq = Math.max(maxSeq, +m[1]); };
      state.backpack.forEach(scan);
      Object.values(state.equipped).forEach(scan);
      state.uidSeq = maxSeq + 1;
    }
  } catch { /* 忽略损坏的存档 */ }
  await switchBuild(state.buildId && BUILDS.some(([id]) => id === state.buildId) ? state.buildId : BUILDS[0][0]);
}

init().catch((err) => {
  leftEl.innerHTML = `<section class="st-panel"><p style="color:var(--warn)">初始化失败：${escapeHtml(err.message)}</p></section>`;
});

// 供无头冒烟测试驱动（actions 与 UI 事件同一份实现）
export const __test = { state, actions, currentFlow, equippedList, switchFlow, computeOverallSafe };
