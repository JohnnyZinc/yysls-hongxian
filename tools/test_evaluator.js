'use strict';

/**
 * test_evaluator.js — 装备评价器 UI 无头冒烟测试
 *
 * 用最小 DOM/fetch/localStorage 桩在 Node 里跑真实的 web/evaluator.js：
 *   1. init：流派/流下拉、整体视图（DPS>0、监测发现区块）
 *   2. __test.actions 添加天档左武器 → 背包视图（ΔDPS+匹配度+前瞻监测）
 *   3. 穿上 → 已穿戴视图（无 ΔDPS、档位天、实装监测缺口可见）
 *   4. 脱下/删除 → 回到整体视图
 */

import fs from 'node:fs';

// ---- DOM / 浏览器环境桩（同 test_web） ----
const els = new Map();
function makeEl(sel) {
  return {
    _sel: sel, _html: '', textContent: '', value: '', dataset: {},
    onchange: null, onclick: null, checked: false,
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    querySelector(s) { return document.querySelector(s); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}
globalThis.document = {
  querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
  querySelectorAll() { return []; },
  addEventListener() {},
};
globalThis.window = { addEventListener() {} };
globalThis.localStorage = {
  _m: {},
  getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); },
};
globalThis.location = { protocol: 'http:' };
globalThis.CSS = { escape: (s) => s };
globalThis.fetch = async (url) => {
  const p = String(url).replace(/^\//, '');
  if (p.startsWith('api/template/')) {
    // serve.js 的目录列举端点桩：返回 data/template/<流派>/ 下的分支模板文件
    const dir = 'data/template/' + p.replace('api/template/', '');
    try {
      const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      return { ok: true, json: async () => ({ prefix: dir.split('/').pop(), files }) };
    } catch {
      return { ok: false, status: 404, json: async () => ({ prefix: '', files: [] }) };
    }
  }
  const data = await fs.promises.readFile(p, 'utf-8');
  return { ok: true, json: async () => JSON.parse(data) };
};

// ---- 跑真实的 evaluator.js ----
const mod = await import('../web/evaluator.js');
await new Promise((r) => setTimeout(r, 300)); // 等 init 完成

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
};
const view = () => {
  // 无头桩不解析 HTML：#view 段从 app.innerHTML 切出（#view 后仅剩页脚说明）
  const html = document.querySelector('#app').innerHTML;
  const i = html.indexOf('<div id="view">');
  return i >= 0 ? html.slice(i) : '';
};
const appHtml = () => document.querySelector('#app').innerHTML;
const { state, actions } = mod.__test;

// ---- 1. 初始渲染（整体视图） ----
const buildSel = document.querySelector('#ev-build').innerHTML;
for (const name of ['破竹风', '牵丝玉', '破竹尘', '破竹樽', '裂石威', '牵丝霖（奶妈）']) {
  check(`流派下拉含 ${name}`, buildSel.includes(name));
}
const flowSel = document.querySelector('#ev-flow');
check('流下拉含 大外流/小外流（破竹风模板）且可点', flowSel.innerHTML.includes('大外流') && flowSel.innerHTML.includes('小外流') && flowSel.disabled === false);
check('页头口径摘要已更新（无模板警告不出现）',
  document.querySelector('#ev-meta').textContent.includes('配额模板') && !document.querySelector('#ev-meta').textContent.includes('无配额模板'));
check('整体视图：DPS/毕业率/监测发现渲染', view().includes('DPS') && view().includes('毕业率') && view().includes('监测发现'));
const dpsMatch = view().match(/dps-big">([\d.]+)/);
check('整体视图：DPS > 0（空装备=固定层面板）', !!dpsMatch && parseFloat(dpsMatch[1]) > 0);
check('整体视图：属性面板含三率', view().includes('精准率') && view().includes('会心率'));

// ---- 1.5 切流（大外流 → 小外流 → 回大外流） ----
mod.__test.switchFlow('xiaowai');
check('切流：flowId/推导器切到小外流，下拉选中项同步',
  state.flowId === 'xiaowai' && state.prescription.flowId === 'xiaowai'
  && flowSel.innerHTML.includes('value="xiaowai" selected'));
check('切流：整体视图仍可用（小外流启用度出现在监测中）',
  view().includes('DPS') && view().includes('启用度'));
mod.__test.switchFlow('dawai');
check('切回大外流：推导器复原', state.flowId === 'dawai' && state.prescription.flowId === 'dawai');

// ---- 2. 添加天档左武器 → 背包视图 ----
actions.setDraftSlot('左武器');
actions.setDraftWeaponType('双刀');
actions.setDraftAffix('初始', null, '最大外功攻击');
actions.setDraftAffix('调律', 0, '最大外功攻击');
actions.setDraftAffix('调律', 1, '劲');
actions.setDraftAffix('调律', 2, '双刀武学增伤');
actions.setDraftAffix('调律', 3, '会心率');
check('编辑器：初始+调律数值自动填区间/承音值', state.draft.初始.数值 > 0 && state.draft.调律[2].数值 > 0);
check('添加到背包：成功并切到背包视图', actions.addDraft() === true && state.selected?.kind === 'backpack');
check('背包视图：ΔDPS/匹配度/前瞻监测三段齐备',
  view().includes('ΔDPS（与同部位已穿戴对比）') && view().includes('匹配度') && view().includes('监测发现（假设穿上后）'));
check('背包视图：补空位 → 更好（从无到有）', view().includes('更好'));
check('背包视图：匹配度=天', state.backpack.length === 1 && view().includes('天'));
check('背包视图：实装监测显示配额缺口（仅穿1件）', view().includes('配额缺口'));

// ---- 3. 穿上 → 已穿戴视图 ----
const uid = state.selected.uid;
actions.equip(uid);
check('穿上：装备移入已穿戴、视图切为已穿戴',
  state.equipped['左武器'] != null && !state.backpack.some((b) => b.uid === uid) && state.selected?.kind === 'equipped');
check('已穿戴视图：明确标注无 ΔDPS', view().includes('无 ΔDPS'));
check('已穿戴视图：匹配度=天（传家宝）', view().includes('天'));
check('已穿戴视图：实装监测显示配额缺口（只穿1件，大外缺10）', view().includes('缺 10'));
check('已穿戴视图：背包里出现被替换下来的旧件（本例为空位，无）',
  !state.backpack.some((b) => b.slot === '左武器' && b.uid === uid));

// ---- 4. 脱下 / 删除 ----
actions.unequip('左武器');
check('脱下：回到背包并切到背包视图', state.selected?.kind === 'backpack' && state.equipped['左武器'] == null);
actions.removeBackpack(state.selected.uid);
check('删除：背包清空、回到整体视图',
  state.backpack.length === 0 && appHtml().includes('整体（未选中装备）') && view().includes('DPS'));

// ---- 5. 存档 ----
const saved = JSON.parse(localStorage.getItem('yysls-evaluator-v1') || 'null');
check('存档：equipped/backpack/flowId 持久化', !!saved && saved.flowId === 'dawai' && Array.isArray(saved.backpack));

// ---- 汇总 ----
console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
