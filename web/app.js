'use strict';

/**
 * app.js — 装备→面板→DPS 验证台（零依赖 vanilla ESM）
 */
import { computePanel, toDpsPanel } from '../engine/panel.js';
import { calcDPS } from '../engine/dps.js';

const BUILDS = [
  ['pozhufeng.115.3.2', '破竹风'],
  ['qiansiyu.115.3.5', '牵丝玉'],
  ['pozhuchen.115.3.3', '破竹尘'],
  ['pozhuzun.115.3.6', '破竹樽'],
  ['lieshiwei.115.3.1', '裂石威'],
  ['qiansilin.115.3.1', '牵丝霖（奶妈·DPS仅供参考）'],
];
const SLOTS = ['左武器', '右武器', '环', '佩', '冠胄', '胸甲', '胫甲', '腕甲'];
const WEAPON_SLOTS = ['左武器', '右武器'];
const WEAPON_TYPES = ['剑', '枪', '横刀', '陌刀', '伞', '扇', '绳镖', '双刀', '拳甲', '鼓'];
const STORAGE_KEY = 'yysls-panel-verify-v1';

const state = {
  buildId: null,
  data: null,           // { build, skills, effects }
  version: null,
  affixes: null,
  dingyinMap: null,
  selections: { 弓玦: '', 装备套装: '', 心法: ['', '', '', ''], 武库: '' },
  gear: SLOTS.map(() => ({
    weaponType: '', 承音: false,
    初始: { 属性: '', 数值: null },
    调律: [0, 1, 2, 3].map(() => ({ 属性: '', 数值: null })),
    定音: { 属性: '', 数值: null },
  })),
};

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

/* 启动诊断：让每一步在页面上可见，任何失败都有具体提示 */
const boot = (text, cls) => window.__bootStatus && window.__bootStatus(text, cls);
boot('② 引擎模块已加载，拉取数据中…');

// ---------- 数据加载 ----------

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
  // 注意解包：skills.json/effects.json 顶层含 _source 等元数据，数据在 .skills/.effects
  return { build, skills: skillsJson.skills, effects: effectsJson.effects };
}

// ---------- 词条池 ----------

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

/** 查词条数值区间（decimal），无则 null */
function rangeOf(name) {
  return lookupRange(state.affixes, name);
}

/** 词条别名：池内词条名 → 区间表行名 */
const RANGE_ALIAS = {
  全奇术增伤: '奇术增伤',
  对首领单位增伤: '首领单位增伤',
  对玩家单位增伤: '玩家单位增效',
  对玩家单位增效: '玩家单位增效',
};

/**
 * 词条名 → 数值区间（纯函数，供UI与测试共用）
 * 覆盖：区间表精确名 / 定音区间 / 指定武学增伤→'武器增伤' /
 *       护甲定音55条→'技能定音' / 别名表；无数据返回 null
 */
function lookupRange(affixData, name) {
  if (!name) return null;
  const A = affixData.词条区间 || {};
  const D = affixData.定音区间 || {};
  if (A[name]) return A[name];
  if (D[name]) return D[name];
  if (/武学增伤$/.test(name) && name !== '全武学增伤'
      && WEAPON_TYPES.some((t) => name.startsWith(t))) {
    return A['武器增伤'] || null; // 各武器指定武学增伤共用'武器增伤'区间
  }
  if (Array.isArray(affixData.护甲定音词条) && affixData.护甲定音词条.includes(name)) {
    return D['技能定音'] || null; // 护甲定音技能增伤/增疗共用'技能定音'区间
  }
  if (RANGE_ALIAS[name]) return A[RANGE_ALIAS[name]] || null;
  return null;
}

/** 百分比词条输入按"百分点"录入（如 10.6 = 10.6%），绝对值词条直接录 */
function isPercentAffix(name) {
  const r = rangeOf(name);
  if (r && r.max != null) return r.max <= 1;
  return /率$|增伤$|增效$|增疗$/.test(name || '');
}

/** 数值框 placeholder：区间（承音勾选时显示承音上限）；无区间数据显示待补 */
function placeholderFor(name, isChengyin) {
  const r = rangeOf(name);
  if (!r || r.max == null) return name ? '区间待补' : '';
  const pct = r.max <= 1;
  const fmt = (x) => (pct ? +(x * 100).toFixed(4) : x);
  if (isChengyin && r.承音 != null) return `承音≤${fmt(r.承音)}`;
  return `${fmt(r.min)}~${fmt(r.max)}`;
}

// ---------- 渲染 ----------

function optionList(values, current, labelOf) {
  const opt = (v) => {
    const t = labelOf ? labelOf(v) : v;
    return `<option value="${escapeHtml(v)}" ${v === current ? 'selected' : ''}>${escapeHtml(t)}</option>`;
  };
  return `<option value="" ${!current ? 'selected' : ''}>— 未选 —</option>` + values.map(opt).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function affixRowHtml(kind, index, piece, slot) {
  const isLaw = kind === '调律';
  const aff = isLaw ? (piece.调律[index] || { 属性: '', 数值: null }) : piece[kind];
  const pool = kind === '初始' ? initialPool(slot)
    : isLaw ? lawPool(slot, piece.weaponType)
      : dingyinPool(slot);
  const name = aff.属性 || '';
  const pct = isPercentAffix(name);
  const locked = piece.承音 && kind !== '定音'; // 承音锁定非定音词条数值
  const val = aff.数值 == null ? '' : (pct ? +(aff.数值 * 100).toFixed(4) : aff.数值);
  const ph = placeholderFor(name, piece.承音 && kind !== '定音');
  return `
    <div class="affix-row">
      <span class="tag">${isLaw ? '调律' + (index + 1) : kind}</span>
      <select data-slot="${slot}" data-kind="${kind}" data-idx="${index}" data-field="属性">${optionList(pool, name)}</select>
      <input type="number" step="any" data-slot="${slot}" data-kind="${kind}" data-idx="${index}" data-field="数值" value="${val}" placeholder="${escapeHtml(ph)}" ${locked ? 'disabled' : ''} title="${escapeHtml(ph)}">
      <span class="unit">${pct ? '%' : ''}</span>
    </div>`;
}

function gearCardHtml(slot, index) {
  const piece = state.gear[index];
  const isWeapon = isWeaponSlot(slot);
  return `
    <div class="card" data-slot="${slot}">
      <h3>${slot}
        <span>
          ${isWeapon ? `<select data-wtype="${index}">${optionList(WEAPON_TYPES, piece.weaponType)}</select>` : ''}
          <label class="muted">承音</label><input type="checkbox" data-chengyin="${index}" ${piece.承音 ? 'checked' : ''}>
        </span>
      </h3>
      ${affixRowHtml('初始', 0, piece, slot)}
      ${[0, 1, 2, 3].map((i) => affixRowHtml('调律', i, piece, slot)).join('')}
      ${affixRowHtml('定音', 0, piece, slot)}
    </div>`;
}

function render() {
  const v = state.version;
  const b = state.data ? state.data.build : null;
  const main = b ? b.selectors.weapon_attribute : '';
  // 弓玦标注提供三率中的哪一个（如 饮羽（精准率））
  const gongjueLabel = (n) => {
    const rec = v.弓玦[n] || {};
    const stat = Object.keys(rec).find((k) => /率$/.test(k));
    return stat ? `${n}（${stat}）` : n;
  };
  app.innerHTML = `
    <h2>可选层</h2>
    <div class="row">
      <label>弓玦</label><select id="sel-gongjue">${optionList(Object.keys(v.弓玦), state.selections.弓玦, gongjueLabel)}</select>
      <label>装备套装</label><select id="sel-set">${optionList(Object.keys(v.装备套装), state.selections.装备套装)}</select>
      <label>武库</label><select id="sel-arsenal">${optionList(Object.keys(v.武库), state.selections.武库)}</select>
      ${[0, 1, 2, 3].map((i) => `<label>心法${i + 1}</label><select id="sel-xinfa-${i}">${optionList(Object.keys(v.心法), state.selections.心法[i])}</select>`).join('')}
    </div>
    <h2>装备词条（8部位）</h2>
    <div class="gear-grid">${SLOTS.map((s, i) => gearCardHtml(s, i)).join('')}</div>
    <div class="row" style="margin-top:14px">
      <button id="btn-calc">计算面板与 DPS</button>
      <button id="btn-clear" style="background:var(--line)">清空装备</button>
      <span class="muted">选词条自动填最大值；百分比词条按"数值=百分号数值"录入（如 14.4 表示 14.4%）；勾选承音后词条自动设为承音值并锁定（定音词条不受承音限制）</span>
    </div>
    <div id="results"></div>`;
  bindEvents();
}

// ---------- 事件 ----------

function save() {
  const { buildId, selections, gear } = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ buildId, selections, gear }));
}

function bindEvents() {
  $('#sel-gongjue').onchange = (e) => { state.selections.弓玦 = e.target.value; save(); };
  $('#sel-set').onchange = (e) => { state.selections.装备套装 = e.target.value; save(); };
  $('#sel-arsenal').onchange = (e) => { state.selections.武库 = e.target.value; save(); };
  [0, 1, 2, 3].forEach((i) => {
    $(`#sel-xinfa-${i}`).onchange = (e) => { state.selections.心法[i] = e.target.value; save(); };
  });

  for (const el of app.querySelectorAll('[data-field]')) {
    el.onchange = (e) => {
      const { slot, kind, idx, field } = e.target.dataset;
      const piece = state.gear[SLOTS.indexOf(slot)];
      const target = kind === '调律' ? piece.调律[+idx] : piece[kind];
      if (field === '属性') {
        target.属性 = e.target.value;
        // 选词条自动填最大值；承音状态下填承音值
        const r = rangeOf(target.属性);
        if (r && r.max != null) {
          target.数值 = (piece.承音 && kind !== '定音' && r.承音 != null) ? r.承音 : r.max;
        } else {
          target.数值 = null;
        }
        save();
        renderCard(slot);
      } else {
        const pct = isPercentAffix(target.属性);
        target.数值 = e.target.value === '' ? null : pct ? +e.target.value / 100 : +e.target.value;
        save();
      }
    };
  }
  for (const el of app.querySelectorAll('[data-wtype]')) {
    el.onchange = (e) => {
      const i = +e.target.dataset.wtype;
      const prev = state.gear[i].weaponType;
      state.gear[i].weaponType = e.target.value;
      // 换武器类型时清空不再合法的指定武学增伤
      const prevSpec = `${prev}武学增伤`;
      state.gear[i].调律.forEach((a) => { if (a.属性 === prevSpec) a.属性 = ''; });
      save();
      renderCard(SLOTS[i]);
    };
  }
  for (const el of app.querySelectorAll('[data-chengyin]')) {
    el.onchange = (e) => {
      const i = +e.target.dataset.chengyin;
      const piece = state.gear[i];
      piece.承音 = e.target.checked;
      if (piece.承音) {
        // 勾选承音：非定音词条数值自动设为承音值并锁定（定音无承音惩罚，不动）
        const snap = (a) => {
          if (!a || !a.属性) return;
          const r = rangeOf(a.属性);
          if (r && r.承音 != null) a.数值 = r.承音;
        };
        snap(piece.初始);
        piece.调律.forEach(snap);
      }
      // 取消勾选：数值保持不变，恢复可编辑
      save();
      renderCard(SLOTS[i]);
    };
  }
  $('#btn-calc').onclick = compute;
  $('#btn-clear').onclick = () => {
    state.gear = SLOTS.map(() => ({
      weaponType: '', 承音: false,
      初始: { 属性: '', 数值: null },
      调律: [0, 1, 2, 3].map(() => ({ 属性: '', 数值: null })),
      定音: { 属性: '', 数值: null },
    }));
    save();
    render();
  };
}

function renderCard(slot) {
  const card = app.querySelector(`.card[data-slot="${CSS.escape(slot)}"]`);
  if (!card) return;
  const i = SLOTS.indexOf(slot);
  card.outerHTML = gearCardHtml(slot, i);
  bindEvents();
}

// ---------- 计算 ----------

function collectPieces() {
  const pieces = [];
  for (let i = 0; i < state.gear.length; i++) {
    const piece = state.gear[i];
    const affixes = [piece.初始, ...piece.调律, piece.定音]
      .filter((a) => a.属性 && typeof a.数值 === 'number');
    if (!affixes.length) continue; // 空位不入参
    pieces.push({
      slot: SLOTS[i],
      承音: piece.承音,
      初始: affixes[0],
      调律: affixes.slice(1, 5),
      定音: affixes[5] || null,
    });
  }
  return pieces;
}

function compute() {
  const box = $('#results');
  const main = state.data.build.selectors.weapon_attribute;
  const pieces = collectPieces();
  try {
    const pr = computePanel({
      version: state.version,
      affixes: state.affixes,
      build: { 流派: state.data.build.name },
      gear: pieces,
      selections: state.selections,
    });
    const dpsPanel = toDpsPanel(pr, { 主属性: main }, state.dingyinMap);
    const pi = state.data.build.panel_input;
    dpsPanel.flatBonus = pi.flat_dmg_bonus ? pi.flat_dmg_bonus.default : 0;
    dpsPanel.food = { ext: pi.food_ext ? pi.food_ext.default : 0, elem: pi.food_elem ? pi.food_elem.default : 0 };
    const r = calcDPS(state.data, { panel: dpsPanel });

    const pct = (x) => (x * 100).toFixed(2) + '%';
    const rows = [
      ['精准率', pct(pr.stats['精准率'])],
      ['会心率', pct(pr.stats['会心率']) + (pr.stats['会心率'] > 0.8 ? ' ⚠溢出' : '')],
      ['会意率', pct(pr.stats['会意率']) + (pr.stats['会意率'] > 0.4 ? ' ⚠溢出' : '')],
      ['最小外功', pr.stats['最小外功'].toFixed(1)],
      ['最大外功', pr.stats['最大外功'].toFixed(1)],
      [`最小${main}`, pr.stats[`最小${main}`].toFixed(1)],
      [`最大${main}`, pr.stats[`最大${main}`].toFixed(1)],
      ['外功穿透', pr.stats['外功穿透'].toFixed(2)],
      ['全武增', pct(pr.stats['全武增'])],
      ['首领增', pct(pr.stats['首领增'])],
      ['直接会心率', pct(pr.stats['直接会心率'])],
      ['直接会意率', pct(pr.stats['直接会意率'])],
      ['会心伤害', pct(pr.stats['会心伤害'])],
      ['会意伤害', pct(pr.stats['会意伤害'])],
      ['五维 体/劲/御/敏/势', ['体', '劲', '御', '敏', '势'].map((s) => pr.stats[s].toFixed(1)).join(' / ')],
      ['五维达标率', pct(pr.五维达标率)],
      ['主属性达标率', pct(pr.主属性达标率)],
      ['气血最大值', pr.stats['气血最大值']],
    ];
    const weaponStr = Object.entries(pr.武器增).map(([t, v]) => `${t} ${pct(v)}`).join('，') || '无';
    const dingStr = Object.entries(pr.技能定音).map(([n, v]) => `${n} ${pct(v)}`).join('，') || '无';

    box.innerHTML = `
      <div class="results">
        <div>DPS <span class="dps-big">${r.dps.toFixed(2)}</span>
          <span class="muted">毕业率 ${(r.graduationRate * 100).toFixed(2)}%
          （轴时长 ${r.duration}s · 毕业DPS ${r.graduateDps} · ${r.buildId}）</span></div>
        <ul class="warnings">${pr.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        <div class="stat-grid">${rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')}</div>
        <p class="muted" style="margin:8px 0 0">武器增伤：${weaponStr}　技能定音：${dingStr}</p>
        <details><summary>全部面板属性</summary>
          <div class="stat-grid" style="margin-top:8px">
            ${Object.entries(pr.stats).filter(([, v]) => typeof v === 'number')
              .map(([k, v]) => `<div><span>${k}</span><span>${/率$|增$|增效$|定音$|加成$|伤害$|减免$/.test(k) ? pct(v) : (+v.toFixed(4)).toString()}</span></div>`).join('')}
          </div>
        </details>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="results"><ul class="warnings"><li>计算出错：${escapeHtml(err.message)}</li></ul></div>`;
  }
}

// ---------- 全局错误可见化 + file:// 检测 ----------

function showError(title, detail) {
  const box = $('#results') || app;
  box.innerHTML = `<div class="results"><ul class="warnings"><li><b>${escapeHtml(title)}</b></li><li>${escapeHtml(detail)}</li></ul></div>`;
}

window.addEventListener('error', (e) => showError('脚本错误', e.message));
window.addEventListener('unhandledrejection', (e) => showError('异步错误', String(e.reason)));

if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    showError('打开方式错误', '本页面需要通过本地服务器打开：请访问 http://127.0.0.1:4173/ （在工作区根目录运行 node tools/serve.js 启动）');
  });
}

// ---------- 启动 ----------

async function init() {
  state.version = await fetchJson('/data/version/nanlvxianghe-shang.115.json');
  state.affixes = await fetchJson('/data/version/affixes-115.json');
  state.dingyinMap = await fetchJson('/data/version/dingyin-map.json');
  boot('③ 数据已加载，初始化界面中…');

  // 恢复上次输入
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.buildId) {
      state.buildId = saved.buildId;
      state.selections = { ...state.selections, ...saved.selections };
      state.gear = saved.gear || state.gear;
    }
  } catch { /* 忽略损坏的存档 */ }

  const sel = $('#build-select');
  sel.innerHTML = BUILDS.map(([id, name]) => `<option value="${id}" ${id === state.buildId ? 'selected' : ''}>${name}</option>`).join('');
  sel.onchange = () => switchBuild(sel.value);

  if (state.buildId && BUILDS.some(([id]) => id === state.buildId)) {
    await switchBuild(state.buildId);
  } else {
    await switchBuild(BUILDS[0][0]);
  }
}

async function switchBuild(buildId) {
  state.buildId = buildId;
  boot('④ 拉取流派数据中…');
  state.data = await loadBuildData(buildId);
  const b = state.data.build;
  $('#build-meta').textContent =
    `${b.name} · ${b.game_version}阶${b.calc_version ? ` · 计算器${b.calc_version}` : ''} · 主属性 ${b.selectors.weapon_attribute} · 套装 ${b.selectors.set}`;
  // 切流派：武器类型/武库重置为该流派默认（武库按主属性选择）
  const cats = (b.weapon_categories || []).slice(1, 3).map((c) => c.label);
  state.gear[0].weaponType = cats[0] || '';
  state.gear[1].weaponType = cats[1] || '';
  state.selections.武库 = b.selectors.weapon_attribute;
  save();
  render();
  boot('✓ 就绪');
}

init().catch((err) => {
  app.innerHTML = `<p style="color:var(--warn)">初始化失败：${escapeHtml(err.message)}</p>`;
});

// 供无头测试复用（lookupRange 为纯函数）
export { lookupRange };
