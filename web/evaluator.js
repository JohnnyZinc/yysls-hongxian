'use strict';

/**
 * evaluator.js — 装备评价工作台（P2 UI v1，零依赖 vanilla ESM）
 *
 * 三视图按用户操作场景（用户定稿）：
 *   什么都不选 → 整体：DPS 毕业率 + 属性面板 + 当前监测发现
 *   点击已穿戴装备 → 匹配度+转律建议 + 当前实装监测；无 ΔDPS（穿戴中不比较）
 *   点击背包未穿戴装备 → 与同部位已穿戴的 ΔDPS + 匹配度 + 假设穿上后的监测（前瞻）
 * 三系统并列罗列、不给综合结论。
 *
 * 装备库持久化在 localStorage（yysls-evaluator-v1）；面板/DPS 验证台（app.js）不受影响。
 */

import { derivePrescription } from '../engine/quota.js';
import { gradeItem } from '../engine/advisor.js';
import { inspectEquipped, inspectCandidate, inspectOverall } from '../engine/inspect.js';

// ---------- 常量 ----------

const BUILDS = [
  ['pozhufeng.115.3.2', '破竹风'],
  ['qiansiyu.115.3.5', '牵丝玉'],
  ['pozhuchen.115.3.3', '破竹尘'],
  ['pozhuzun.115.3.6', '破竹樽'],
  ['lieshiwei.115.3.1', '裂石威'],
  ['qiansilin.115.3.1', '牵丝霖（奶妈）'],
];
const SLOTS = ['左武器', '右武器', '环', '佩', '冠胄', '胸甲', '胫甲', '腕甲'];
const WEAPON_SLOTS = ['左武器', '右武器'];
const WEAPON_TYPES = ['剑', '枪', '横刀', '陌刀', '伞', '扇', '绳镖', '双刀', '拳甲', '鼓'];
const FLOWS_URL = (buildId) => `/data/template/${buildId.split('.')[0]}.flows.json`;
const STORAGE_KEY = 'yysls-evaluator-v1';
const TIER_CLASS = { 天: 'tian', 地: 'di', 玄: 'xuan', 黄: 'huang' };

// ---------- 状态 ----------

function newDraft(slot = '左武器', weaponType = '') {
  return {
    slot, weaponType, 承音: false,
    初始: { 属性: '', 数值: null },
    调律: [0, 1, 2, 3].map(() => ({ 属性: '', 数值: null })),
    定音: { 属性: '', 数值: null },
  };
}

const state = {
  buildId: null,
  data: null,           // { build, skills, effects }
  version: null,
  affixes: null,
  dingyinMap: null,
  flows: null,          // { buildId, flows: [flow,...] } | null（流派无模板时为 null）
  flowId: null,
  prescription: null,   // derivePrescription 结果（仅当前流）
  selections: { 弓玦: '', 装备套装: '', 心法: ['', '', '', ''], 武库: '' },
  equipped: {},         // { [slot]: piece }（全局装备库，切流派不清空）
  backpack: [],         // [piece + uid]
  selected: null,       // { kind:'equipped', slot } | { kind:'backpack', uid } | null
  draft: newDraft(),
  uidSeq: 1,
};

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const boot = (text, cls) => window.__bootStatus && window.__bootStatus(text, cls);

// ---------- 通用工具（与验证台同款） ----------

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
  const [build, skillsJson, effectsJson] = await Promise.all([
    fetchJson(`/data/${buildId}.json`),
    fetchJson(`/data/${buildId}.skills.json`),
    fetchJson(`/data/${buildId}.effects.json`),
  ]);
  return { build, skills: skillsJson.skills, effects: effectsJson.effects };
}

// ---------- 词条池 / 区间（与验证台同款） ----------

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

async function switchBuild(buildId) {
  state.buildId = buildId;
  boot('④ 拉取流派数据中…');
  state.data = await loadBuildData(buildId);
  const b = state.data.build;
  state.selections.装备套装 = state.selections.装备套装 || b.selectors.set;
  state.selections.武库 = b.selectors.weapon_attribute;
  // 流派配额模板（仅部分流派有；404 优雅降级）
  state.flows = null;
  state.flowId = null;
  state.prescription = null;
  try {
    const doc = await fetchJson(FLOWS_URL(buildId));
    state.flows = doc;
    // 保留存档里的流选择（若仍存在）；否则取第一个
    if (!doc.flows.some((f) => f.flowId === state.flowId)) {
      state.flowId = doc.flows[0]?.flowId ?? null;
    }
  } catch { /* 无模板：仅 DPS/面板可用 */ }
  applyFlow();
  // 编辑器默认武器类型跟随流派（左/右武器）
  const cats = (b.weapon_categories || []).slice(1, 3).map((c) => c.label);
  state.draft = newDraft(state.draft.slot === '右武器' ? '右武器' : '左武器',
    state.draft.slot === '右武器' ? (cats[1] || '') : (cats[0] || ''));
  save();
  renderHeader();
  render();
  boot('✓ 就绪');
}

/** 页头（#app 之外）：流下拉选项 + 口径摘要。在 switchBuild/switchFlow 后调用 */
function renderHeader() {
  const flowSel = $('#ev-flow');
  if (state.flows) {
    flowSel.disabled = false;
    flowSel.innerHTML = state.flows.flows
      .map((f) => `<option value="${f.flowId}" ${f.flowId === state.flowId ? 'selected' : ''}>${f.name}</option>`).join('');
  } else {
    flowSel.disabled = true;
    flowSel.innerHTML = '<option value="">— 无模板 —</option>';
  }
  const b = state.data?.build;
  const meta = [];
  if (b) meta.push(`${b.name} · 主属性 ${b.selectors.weapon_attribute} · 套装 ${b.selectors.set}`);
  meta.push(state.flows
    ? `配额模板：${state.flows.flows.map((f) => f.name).join('/')}`
    : '⚠ 无配额模板——匹配度/监测不可用，仅 DPS/面板');
  $('#ev-meta').textContent = meta.join(' · ');
}

function applyFlow() {
  const flow = currentFlow();
  state.prescription = flow ? derivePrescription(state.affixes, flow) : null;
  if (state.prescription && !state.prescription.feasible) {
    state.prescription = null; // 模板不可行时按"无模板"降级
  }
}

function switchFlow(flowId) {
  state.flowId = flowId;
  applyFlow();
  state.selected = null;
  save();
  renderHeader();
  render();
}

// ---------- 渲染 ----------

function tierBadgeHtml(piece, big = false) {
  if (!state.prescription) return '<span class="tier-badge">无模板</span>';
  const g = gradeItem(state.prescription, piece.slot, toGradeItem(piece));
  if (!g.ok) return `<span class="tier-badge" title="${escapeHtml((g.errors || []).join('；'))}">?</span>`;
  const cls = TIER_CLASS[g.tier] || '';
  const label = `${g.tier}${g.substate ? '·需转律' : ''}`;
  return `<span class="tier-badge ${cls} ${big ? 'big' : ''}" title="${escapeHtml(g.口径)}">${escapeHtml(label)}</span>`;
}

function toGradeItem(piece) {
  return {
    initial: piece?.初始?.属性,
    tunings: (piece?.调律 || []).map((t) => t?.属性),
    dingyin: piece?.定音?.属性,
  };
}

function affSummaryHtml(piece) {
  const rows = [['初始', piece.初始], ...piece.调律.map((a, i) => [`调律${i + 1}`, a]), ['定音', piece.定音]]
    .filter(([, a]) => a && a.属性);
  return rows.map(([k, a]) => `<div class="aff"><span class="k">${k}</span><span>${escapeHtml(a.属性)}</span><span>${escapeHtml(fmtAffixValue(a.属性, a.数值))}</span></div>`).join('');
}

function equippedCardHtml(slot) {
  const piece = state.equipped[slot];
  if (!piece) {
    return `<div class="ev-empty" data-sel-kind="equipped" data-sel-slot="${escapeHtml(slot)}">${slot}<br>空位——背包中的同部位可穿上</div>`;
  }
  const sel = state.selected?.kind === 'equipped' && state.selected.slot === slot;
  return `
    <div class="ev-card ${sel ? 'selected' : ''}" data-sel-kind="equipped" data-sel-slot="${escapeHtml(slot)}">
      <h4><span>${escapeHtml(slot)}${piece.承音 ? ' <span class="muted">承音</span>' : ''}</span>${tierBadgeHtml(piece)}</h4>
      ${affSummaryHtml(piece)}
      <div class="btns">
        <button data-act="unequip" data-slot="${escapeHtml(slot)}">脱下</button>
        <button data-act="removeEquipped" data-slot="${escapeHtml(slot)}">删除</button>
      </div>
    </div>`;
}

function backpackCardHtml(piece) {
  const sel = state.selected?.kind === 'backpack' && state.selected.uid === piece.uid;
  return `
    <div class="ev-card ${sel ? 'selected' : ''}" data-sel-kind="backpack" data-sel-uid="${escapeHtml(piece.uid)}">
      <h4><span>${escapeHtml(piece.slot)}${piece.承音 ? ' <span class="muted">承音</span>' : ''}</span>${tierBadgeHtml(piece)}</h4>
      ${affSummaryHtml(piece)}
      <div class="btns">
        <button class="primary" data-act="equip" data-uid="${escapeHtml(piece.uid)}">穿上</button>
        <button data-act="removeBackpack" data-uid="${escapeHtml(piece.uid)}">删除</button>
      </div>
    </div>`;
}

function editorHtml() {
  const p = state.draft;
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
    <div class="affix-row">
      <span class="tag">部位</span>
      <select id="ed-slot">${SLOTS.map((s) => `<option value="${s}" ${s === p.slot ? 'selected' : ''}>${s}</option>`).join('')}</select>
      ${isWeaponSlot(p.slot) ? `<select id="ed-wtype">${optionList(WEAPON_TYPES, p.weaponType)}</select>` : ''}
      <label class="muted">承音</label><input type="checkbox" id="ed-chengyin" ${p.承音 ? 'checked' : ''}>
      <button id="ed-add" style="margin-left:auto">添加到背包</button>
      <button id="ed-reset" style="background:var(--line)">重填</button>
    </div>
    ${row('初始')}${[0, 1, 2, 3].map((i) => row('调律', i)).join('')}${row('定音')}
    <p class="muted" style="margin:6px 0 0">选词条自动填区间最大值；勾选承音自动改为承音值（定音不受限）；百分比词条按百分号数值录入</p>`;
}

function render() {
  const b = state.data ? state.data.build : null;
  const meta = [];
  if (b) meta.push(`${b.name} · 主属性 ${b.selectors.weapon_attribute} · 套装 ${b.selectors.set}`);
  if (state.flows) meta.push(`配额模板：${state.flows.flows.map((f) => f.name).join('/')}`);
  else meta.push('⚠ 无配额模板——匹配度/监测不可用，仅 DPS/面板');
  app.innerHTML = `
    <h2>口径（半固定层）</h2>
    <div class="row">
      <label>弓玦</label><select id="ev-gongjue">${optionList(Object.keys(state.version.弓玦), state.selections.弓玦)}</select>
      <label>装备套装</label><select id="ev-set">${optionList(Object.keys(state.version.装备套装), state.selections.装备套装)}</select>
      <label>武库</label><select id="ev-arsenal">${optionList(Object.keys(state.version.武库), state.selections.武库)}</select>
      ${[0, 1, 2, 3].map((i) => `<label>心法${i + 1}</label><select id="ev-xinfa-${i}">${optionList(Object.keys(state.version.心法), state.selections.心法[i])}</select>`).join('')}
    </div>
    <h2>添加装备（进背包）</h2>
    <div class="card" id="ev-editor">${editorHtml()}</div>
    <h2>已穿戴（点击卡片查看评价）</h2>
    <div class="ev-grid">${SLOTS.map((s) => equippedCardHtml(s)).join('')}</div>
    <h2>背包（候选装备，点击卡片查看对比）</h2>
    <div class="ev-grid">${state.backpack.length ? state.backpack.map((p) => backpackCardHtml(p)).join('') : '<div class="ev-empty">空——在上方添加装备，或把已穿戴的脱下</div>'}</div>
    <h2>${escapeHtml(viewTitle())}</h2>
    <div id="view">${viewHtml()}</div>
    <p class="muted" style="margin-top:10px">装备库为全局（切流派只切换评价口径）；${escapeHtml(meta.join(' · '))}</p>`;
  bind();
}

// ---------- 视图渲染（三视图） ----------

function viewTitle() {
  const s = state.selected;
  if (!s) return '整体（未选中装备）';
  if (s.kind === 'equipped') return `已穿戴 · ${s.slot}`;
  const p = backpackByUid(s.uid);
  return `背包 · ${p ? p.slot : '已移除'}`;
}

function viewHtml() {
  const flow = currentFlow();
  if (!state.prescription || !flow) {
    return `<div class="results"><p class="muted">当前流派暂无配额模板（data/template/&lt;流派&gt;.flows.json）——匹配度与监测不可用，仅 DPS/面板可在验证台查看。切到破竹风可体验完整三视图。</p></div>`;
  }
  const ctx = () => ({
    buildCtx: state.data, version: state.version, affixes: state.affixes,
    dingyinMap: state.dingyinMap, selections: state.selections,
  });
  const s = state.selected;
  try {
    if (!s) {
      return overallHtml(inspectOverall({ ...ctx(), gear: equippedList(), prescription: state.prescription, flow }));
    }
    if (s.kind === 'equipped') {
      const piece = state.equipped[s.slot];
      if (!piece) { state.selected = null; return viewHtml(); }
      return equippedHtml(inspectEquipped({ ...ctx(), gear: equippedList(), piece, prescription: state.prescription, flow }));
    }
    const piece = backpackByUid(s.uid);
    if (!piece) { state.selected = null; return viewHtml(); }
    return candidateHtml(inspectCandidate({ ...ctx(), gear: equippedList(), newItem: piece, prescription: state.prescription, flow }));
  } catch (err) {
    return `<div class="results"><ul class="warnings"><li>视图计算出错：${escapeHtml(err.message)}</li></ul></div>`;
  }
}

function statRowsHtml(stats, main) {
  const pct = (x) => pctFmt(x);
  const rows = [
    ['精准率', pct(stats['精准率'])],
    ['会心率', pct(stats['会心率']) + (stats['会心率'] > 0.8 ? ' ⚠溢出' : '')],
    ['会意率', pct(stats['会意率']) + (stats['会意率'] > 0.4 ? ' ⚠溢出' : '')],
    ['直接会心率', pct(stats['直接会心率'])],
    ['直接会意率', pct(stats['直接会意率'])],
    ['最小外功', stats['最小外功'].toFixed(1)],
    ['最大外功', stats['最大外功'].toFixed(1)],
    [`最小${main}`, stats[`最小${main}`].toFixed(1)],
    [`最大${main}`, stats[`最大${main}`].toFixed(1)],
    ['外功穿透', stats['外功穿透'].toFixed(2)],
    ['全武增', pct(stats['全武增'])],
    ['首领增', pct(stats['首领增'])],
    ['会心伤害', pct(stats['会心伤害'])],
    ['会意伤害', pct(stats['会意伤害'])],
    ['五维 体/劲/御/敏/势', ['体', '劲', '御', '敏', '势'].map((s) => stats[s].toFixed(1)).join(' / ')],
    ['气血最大值', String(Math.round(stats['气血最大值']))],
  ];
  return `<div class="stat-grid">${rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')}</div>`;
}

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
        ? `已反转（最小外功 ${e.最小外功.toFixed(0)} ＞ 最大外功 ${e.最大外功.toFixed(0)}）——伤害固定取最小外功`
        : `未反转：最小 ${e.最小外功.toFixed(0)} / 最大 ${e.最大外功.toFixed(0)}，距反转差 ${e.距反转差值} 点${e.折算词条数 != null ? ` ≈ ${e.折算词条数} 条小外词条（${escapeHtml(e.折算口径 || '')}）` : ''}`
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
    parts.push(`<div class="digest"><div class="digest-title">缺必备</div>${g.missing.map((m) =>
      `<div>${m.type === '初始位' ? `初始位应为「${escapeHtml(m.affix)}」` : `「${escapeHtml(m.affix)}」还差 ${m.deficit} 条`}</div>`).join('')}</div>`);
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

function overallHtml(r) {
  const main = state.data.build.selectors.weapon_attribute;
  return `
    <div class="results">
      <div>DPS <span class="dps-big">${r.DPS.dps.toFixed(2)}</span>
        <span class="muted">毕业率 ${r.DPS.graduationRate != null ? pctFmt(r.DPS.graduationRate) : '—'}</span></div>
      ${r.面板警告?.length ? `<ul class="warnings">${r.面板警告.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      <h3 class="sec">玩家属性面板</h3>
      ${statRowsHtml(r.属性面板, main)}
      <h3 class="sec">监测发现（当前实装）</h3>
      ${digestHtml(r.监测)}
    </div>`;
}

function equippedHtml(r) {
  const g = r.匹配度;
  return `
    <div class="results">
      <div class="verdict-row">
        <span class="tier-badge big ${TIER_CLASS[g.tier] || ''}">${escapeHtml(g.tier ?? '—')}${g.substate ? '（需1次转律）' : ''}</span>
        <span class="muted">已穿戴装备：不与其他同部位装备比较，无 ΔDPS</span>
      </div>
      ${gradeDetailHtml(g)}
      <h3 class="sec">监测发现（当前实装）</h3>
      ${digestHtml(r.监测)}
    </div>`;
}

function candidateHtml(r) {
  const d = r.ΔDPS;
  const cls = d.verdict === '更好' ? 'better' : d.verdict === '更差' ? 'worse' : 'equal';
  const sign = d.deltaPct >= 0 ? '+' : '';
  return `
    <div class="results">
      <h3 class="sec" style="margin-top:0">ΔDPS（与同部位已穿戴对比）</h3>
      <div class="verdict-row">
        <span class="verdict-badge big ${cls}">${escapeHtml(d.verdict)}</span>
        <span class="delta-big ${d.deltaPct > 0 ? 'up' : d.deltaPct < 0 ? 'down' : ''}">${sign}${(d.deltaPct * 100).toFixed(2)}%</span>
        <span>${escapeHtml(d.recommendation)}</span>
      </div>
      <div class="muted">DPS ${d.before.dps.toFixed(1)} → ${d.after.dps.toFixed(1)}${d.tieBreak ? ` · 次级排序：${escapeHtml(d.tieBreak)}` : ''}</div>
      ${d.去向 ? `<div style="margin-top:6px">去向：旧件——${escapeHtml(d.去向.旧件 || '—')}；新件——${escapeHtml(d.去向.新件 || '—')}${d.去向.候补 ? ' · <b>候补</b>' : ''}</div>` : ''}
      ${panelDiffHtml(d.panelDiff)}
      <h3 class="sec">匹配度</h3>
      <div class="verdict-row">
        <span class="tier-badge big ${TIER_CLASS[r.匹配度.tier] || ''}">${escapeHtml(r.匹配度.tier ?? '—')}${r.匹配度.substate ? '（需1次转律）' : ''}</span>
        <span class="muted">${escapeHtml(r.匹配度.口径 || '')}</span>
      </div>
      ${gradeDetailHtml(r.匹配度)}
      <h3 class="sec">监测发现（假设穿上后）</h3>
      ${digestHtml(r.监测)}
    </div>`;
}

// ---------- 事件绑定 ----------

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    buildId: state.buildId, flowId: state.flowId, selections: state.selections,
    equipped: state.equipped, backpack: state.backpack,
  }));
}

function bind() {
  $('#ev-gongjue').onchange = (e) => { state.selections.弓玦 = e.target.value; save(); render(); };
  $('#ev-set').onchange = (e) => { state.selections.装备套装 = e.target.value; save(); render(); };
  $('#ev-arsenal').onchange = (e) => { state.selections.武库 = e.target.value; save(); render(); };
  [0, 1, 2, 3].forEach((i) => {
    $(`#ev-xinfa-${i}`).onchange = (e) => { state.selections.心法[i] = e.target.value; save(); render(); };
  });
  $('#ed-slot').onchange = (e) => actions.setDraftSlot(e.target.value);
  const wtype = $('#ed-wtype');
  if (wtype) wtype.onchange = (e) => actions.setDraftWeaponType(e.target.value);
  $('#ed-chengyin').onchange = (e) => actions.setDraftChengyin(e.target.checked);
  $('#ed-add').onclick = () => actions.addDraft();
  $('#ed-reset').onclick = () => actions.resetDraft();
  for (const el of app.querySelectorAll('[data-ed-field]')) {
    el.onchange = onDraftFieldChange;
  }
  for (const el of app.querySelectorAll('[data-sel-kind]')) {
    el.onclick = () => actions.select({
      kind: el.dataset.selKind,
      slot: el.dataset.selSlot || undefined,
      uid: el.dataset.selUid || undefined,
    });
  }
  for (const el of app.querySelectorAll('[data-act]')) {
    el.onclick = (e) => {
      e.stopPropagation();
      const { act, uid, slot } = el.dataset;
      if (act === 'equip') actions.equip(uid);
      else if (act === 'unequip') actions.unequip(slot);
      else if (act === 'removeBackpack') actions.removeBackpack(uid);
      else if (act === 'removeEquipped') actions.removeEquipped(slot);
    };
  }
}

function onDraftFieldChange(e) {
  const { edKind: kind, edIdx, edField: field } = e.target.dataset;
  const target = kind === '调律' ? state.draft.调律[+edIdx] : state.draft[kind];
  if (field === '属性') {
    actions.setDraftAffix(kind, edIdx == null ? null : +edIdx, e.target.value);
  } else {
    const pct = isPercentAffix(target.属性);
    target.数值 = e.target.value === '' ? null : (pct ? +e.target.value / 100 : +e.target.value);
  }
  save();
  render();
}

// ---------- 动作（UI 事件与无头测试共用） ----------

const actions = {
  select(ref) { state.selected = ref; render(); },

  setDraftSlot(slot) {
    const cats = (state.data?.build.weapon_categories || []).slice(1, 3).map((c) => c.label);
    const wt = slot === '左武器' ? (cats[0] || state.draft.weaponType)
      : slot === '右武器' ? (cats[1] || state.draft.weaponType)
        : state.draft.weaponType;
    state.draft = newDraft(slot, isWeaponSlot(slot) ? wt : '');
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

  resetDraft() {
    state.draft = newDraft(state.draft.slot, state.draft.weaponType);
    save(); render();
  },

  addDraft() {
    const p = state.draft;
    if (!p.初始.属性) return false;
    const piece = {
      slot: p.slot,
      weaponType: p.weaponType || undefined,
      承音: p.承音 || undefined,
      初始: { 属性: p.初始.属性, 数值: p.初始.数值 },
      调律: p.调律.map((a) => ({ 属性: a.属性, 数值: a.数值 })),
      定音: { 属性: p.定音.属性, 数值: p.定音.数值 },
    };
    const uid = 'b' + (state.uidSeq++);
    state.backpack.push({ ...piece, uid });
    state.selected = { kind: 'backpack', uid };
    state.draft = newDraft(p.slot, p.weaponType);
    save(); render();
    return true;
  },

  equip(uid) {
    const i = state.backpack.findIndex((b) => b.uid === uid);
    if (i < 0) return;
    const piece = state.backpack.splice(i, 1)[0];
    const old = state.equipped[piece.slot];
    if (old) state.backpack.push({ ...old, uid: 'b' + (state.uidSeq++) });
    state.equipped[piece.slot] = piece;
    state.selected = { kind: 'equipped', slot: piece.slot };
    save(); render();
  },

  unequip(slot) {
    const piece = state.equipped[slot];
    if (!piece) return;
    delete state.equipped[slot];
    const uid = 'b' + (state.uidSeq++);
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
  app.innerHTML = `<div class="results"><ul class="warnings"><li><b>${escapeHtml(title)}</b></li><li>${escapeHtml(detail)}</li></ul></div>`;
}

window.addEventListener('error', (e) => showError('脚本错误', e.message));
window.addEventListener('unhandledrejection', (e) => showError('异步错误', String(e.reason)));

if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    showError('打开方式错误', '本页面需要通过本地服务器打开：请访问 http://127.0.0.1:4173/web/evaluator.html （在工作区根目录运行 node tools/serve.js 启动）');
  });
}

async function init() {
  state.version = await fetchJson('/data/version/nanlvxianghe-shang.115.json');
  state.affixes = await fetchJson('/data/version/affixes-115.json');
  state.dingyinMap = await fetchJson('/data/version/dingyin-map.json');
  boot('③ 数据已加载，恢复存档…');
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.buildId) {
      state.buildId = saved.buildId;
      state.flowId = saved.flowId ?? null;
      state.selections = { ...state.selections, ...saved.selections };
      state.equipped = saved.equipped || {};
      state.backpack = saved.backpack || [];
      state.uidSeq = state.backpack.length + 1;
    }
  } catch { /* 忽略损坏的存档 */ }

  const sel = $('#ev-build');
  sel.innerHTML = BUILDS.map(([id, name]) => `<option value="${id}" ${id === state.buildId ? 'selected' : ''}>${name}</option>`).join('');
  sel.onchange = () => switchBuild(sel.value);
  const flowSel = $('#ev-flow');
  flowSel.onchange = () => switchFlow(flowSel.value);
  await switchBuild(state.buildId && BUILDS.some(([id]) => id === state.buildId) ? state.buildId : BUILDS[0][0]);
}

init().catch((err) => {
  app.innerHTML = `<p style="color:var(--warn)">初始化失败：${escapeHtml(err.message)}</p>`;
});

// 供无头冒烟测试驱动（actions 与 UI 事件同一份实现）
export const __test = { state, actions, currentFlow, equippedList, switchFlow, renderHeader };
