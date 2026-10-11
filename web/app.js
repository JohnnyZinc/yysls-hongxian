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

// ---------- 数据加载 ----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadBuildData(buildId) {
  const [build, skills, effects] = await Promise.all([
    fetchJson(`/data/${buildId}.json`),
    fetchJson(`/data/${buildId}.skills.json`),
    fetchJson(`/data/${buildId}.effects.json`),
  ]);
  return { build, skills, effects };
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
    const base = [...(pools['武器'] || [])];
    const spec = `${weaponType}武学增伤`;
    if ((pools['指定武学增伤包括'] || []).includes(spec)) base.push(spec);
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

/** 百分比词条输入按"百分点"录入（如 10.6 = 10.6%），绝对值词条直接录 */
function isPercentAffix(name) {
  if (!name) return false;
  const r1 = state.affixes.词条区间[name];
  if (r1 && r1.max != null) return r1.max <= 1;
  const r2 = state.affixes.定音区间[name];
  if (r2 && r2.max != null) return r2.max <= 1;
  return /率$|增伤$|增效$|增疗$/.test(name);
}

function rangeHint(name) {
  const r = state.affixes.词条区间[name] || state.affixes.定音区间[name];
  if (!r || r.max == null) return '';
  const unit = r.max <= 1 ? '%' : '';
  const fmt = (x) => (r.max <= 1 ? (x * 100).toFixed(x * 100 % 1 ? 2 : 1) : x);
  return `区间 ${fmt(r.min)}~${fmt(r.max)}${unit}${r.承音 != null ? ` · 承音 ${fmt(r.承音)}` : ''}`;
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
  const val = aff.数值 == null ? '' : (pct ? +(aff.数值 * 100).toFixed(4) : aff.数值);
  const id = `${slot}-${kind}-${index}`;
  return `
    <div class="affix-row">
      <span class="tag">${kind === '调律' ? '调律' + (index + 1) : kind}</span>
      <select data-slot="${slot}" data-kind="${kind}" data-idx="${index}" data-field="属性">${optionList(pool, name)}</select>
      <input type="number" step="any" data-slot="${slot}" data-kind="${kind}" data-idx="${index}" data-field="数值" value="${val}">
      <span class="unit">${pct ? '%' : ''}</span>
    </div>
    <div class="hint">${name ? rangeHint(name) : ''}</div>`;
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
  app.innerHTML = `
    <h2>可选层</h2>
    <div class="row">
      <label>弓玦</label><select id="sel-gongjue">${optionList(Object.keys(v.弓玦), state.selections.弓玦)}</select>
      <label>装备套装</label><select id="sel-set">${optionList(Object.keys(v.装备套装), state.selections.装备套装)}</select>
      <label>武库</label><select id="sel-arsenal">${optionList(Object.keys(v.武库), state.selections.武库)}</select>
      ${[0, 1, 2, 3].map((i) => `<label>心法${i + 1}</label><select id="sel-xinfa-${i}">${optionList(Object.keys(v.心法), state.selections.心法[i])}</select>`).join('')}
    </div>
    <h2>装备词条（8部位）</h2>
    <div class="gear-grid">${SLOTS.map((s, i) => gearCardHtml(s, i)).join('')}</div>
    <div class="row" style="margin-top:14px">
      <button id="btn-calc">计算面板与 DPS</button>
      <button id="btn-clear" style="background:var(--line)">清空装备</button>
      <span class="muted">百分比词条按"数值+百分号"录入（如 14.4 表示 14.4%）；区间提示中的"承音"为承音装备的数值上限</span>
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
        target.数值 = null; // 换词条清空数值
        save();
        renderCard(slot);   // 刷新单位与区间提示
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
    el.onchange = (e) => { state.gear[+e.target.dataset.chengyin].承音 = e.target.checked; save(); };
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
      ['五维 体/劲/御/敏/势', ['体', '劲', '御', '敏', '势'].map((s) => pr.stats[s]).join(' / ')],
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
              .map(([k, v]) => `<div><span>${k}</span><span>${/率$/.test(k) ? pct(v) : (+v.toFixed(4)).toString()}</span></div>`).join('')}
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
}

init().catch((err) => {
  app.innerHTML = `<p style="color:var(--warn)">初始化失败：${escapeHtml(err.message)}</p>`;
});
