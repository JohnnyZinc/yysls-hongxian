'use strict';

/**
 * test_studio.js — 三栏工作台 UI 无头冒烟测试
 *
 * 用最小 DOM/fetch/localStorage 桩在 Node 里跑真实的 web/studio.js：
 *   1. init：右栏流派/流/口径下拉、DPS 毕业率、属性面板；中栏默认「录入装备」按钮
 *   2. 录入表单：部位预选、词条区间自动填值、添加到背包
 *   3. 选中背包件 → 中栏三维评价（ΔDPS 更好 + 匹配度天 + 前瞻监测）；再次点击 → 取消选中回按钮
 *   4. 穿上 → 已穿戴视图（无 ΔDPS、档位天、实装监测缺口可见）；脱下/删除 → 回到按钮
 */

import fs from 'node:fs';

// ---- DOM / 浏览器环境桩（同 test_web / test_evaluator） ----
const els = new Map();
function makeEl(sel) {
  return {
    _sel: sel, _html: '', textContent: '', value: '', dataset: {},
    onchange: null, onclick: null, checked: false, disabled: false,
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

// ---- 跑真实的 studio.js ----
const mod = await import('../web/studio.js');
await new Promise((r) => setTimeout(r, 400)); // 等 init 完成

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
};
const L = () => document.querySelector('#st-left').innerHTML;
const C = () => document.querySelector('#st-center').innerHTML;
const R = () => document.querySelector('#st-right').innerHTML;
const { state, actions } = mod.__test;

// ---- 1. 初始渲染 ----
check('右栏：流派下拉含九流派（manifest 驱动）',
  R().includes('破竹风') && R().includes('牵丝玉') && R().includes('裂石钧（双切）') && R().includes('牵丝霖（奶妈）'));
check('右栏：流下拉含 大外流/小外流（破竹风模板）', R().includes('大外流') && R().includes('小外流'));
check('右栏：心法×4 / 武库 / 装备套装 / 弓玦套装 下拉齐备',
  R().includes('心法1') && R().includes('心法4') && R().includes('武库') && R().includes('装备套装') && R().includes('弓玦套装'));
check('右栏：DPS 毕业率渲染且为百分比', R().includes('DPS 毕业率') && /st-grad-num">\d+(\.\d+)?%<\/div>/.test(R()));
check('右栏：属性面板含三率/五维/攻击', R().includes('精准率') && R().includes('五维与生存') && R().includes('最大外功攻击'));
check('右栏：整体监测发现区块存在', R().includes('整体监测发现'));
check('中栏默认：录入装备按钮（未选中装备）', C().includes('录入装备') && C().includes('st-open-editor'));
check('左栏：已穿戴 8 部位渲染', L().includes('左武器') && L().includes('腕甲'));
check('左栏：背包空提示', L().includes('背包') && L().includes('0 件未穿戴'));
check('右栏：方案默认已加载（心法/武库/套装/弓玦）',
  state.selections.心法[0] === '易水歌' && state.selections.武库 === '破竹'
  && state.selections.装备套装 === '燕归' && state.selections.弓玦 === '饮羽');

// ---- 1.5 切流 ----
mod.__test.switchFlow('xiaowai');
check('切流：flowId/推导器切到小外流，右栏下拉同步',
  state.flowId === 'xiaowai' && state.prescription.flowId === 'xiaowai' && R().includes('value="xiaowai" selected'));
check('切流：右栏监测出现小外流启用度', R().includes('启用度'));
mod.__test.switchFlow('dawai');
check('切回大外流：推导器复原', state.flowId === 'dawai' && state.prescription.flowId === 'dawai');

// ---- 2. 录入表单 → 添加到背包 ----
actions.openEditor('冠胄');
check('录入：空槽位打开表单并预选部位', state.editing === true && state.draft.slot === '冠胄');
actions.setDraftSlot('左武器');
actions.setDraftWeaponType('双刀');
actions.setDraftAffix('初始', null, '最大外功攻击');
actions.setDraftAffix('调律', 0, '最大外功攻击');
actions.setDraftAffix('调律', 1, '劲');
actions.setDraftAffix('调律', 2, '双刀武学增伤');
actions.setDraftAffix('调律', 3, '会心率');
check('录入：初始+调律数值自动填区间值', state.draft.初始.数值 > 0 && state.draft.调律[2].数值 > 0);
check('录入：中栏出现 6 词条行与按钮', C().includes('调律4') && C().includes('添加到背包') && C().includes('取消'));
const uid = actions.addDraft();
check('添加：成功进背包并自动选中（背包视图）', !!uid && state.selected?.kind === 'backpack' && state.editing === false);
check('背包视图：ΔDPS/匹配度/监测三维评价齐备',
  C().includes('① ΔDPS') && C().includes('② 匹配度') && C().includes('③ 监测发现（假设穿上后）'));
check('背包视图：补空位 → 更好（从无到有）', C().includes('更好'));
check('背包视图：匹配度=天', C().includes('天'));
check('左栏：背包卡片出现且计数=1', L().includes('1 件未穿戴') && L().includes('双刀'));

// ---- 3. 取消选中 / 再次选中 ----
actions.select({ kind: 'backpack', uid });
check('再次点击：取消选中，中栏回到录入装备按钮', state.selected === null && C().includes('录入装备') && !C().includes('ΔDPS'));
actions.select({ kind: 'backpack', uid });
check('再点一次：重新选中，三维评价回来', state.selected?.kind === 'backpack' && C().includes('① ΔDPS'));

// ---- 4. 穿上 → 已穿戴视图 ----
actions.equip(uid);
check('穿上：装备移入已穿戴、视图切为已穿戴',
  state.equipped['左武器'] != null && !state.backpack.some((b) => b.uid === uid) && state.selected?.kind === 'equipped');
check('已穿戴视图：明确标注无 ΔDPS', C().includes('无 ΔDPS'));
check('已穿戴视图：匹配度=天（传家宝）', C().includes('天'));
check('已穿戴视图：实装监测显示配额缺口（只穿1件，大外缺10）', C().includes('缺 10'));
check('已穿戴视图：词条表格展示初始/调律/定音', C().includes('调律 2') && C().includes('双刀武学增伤'));

// ---- 5. 脱下 / 删除 ----
actions.unequip('左武器');
check('脱下：回到背包并切到背包视图', state.selected?.kind === 'backpack' && state.equipped['左武器'] == null);
const uid2 = state.selected.uid;
actions.removeBackpack(uid2);
check('删除：背包清空、中栏回到录入装备按钮', state.backpack.length === 0 && C().includes('录入装备'));

// ---- 6. 存档 ----
const saved = JSON.parse(localStorage.getItem('yysls-evaluator-v1') || 'null');
check('存档：与评价器共用 key，equipped/backpack/flowId 持久化',
  !!saved && saved.flowId === 'dawai' && Array.isArray(saved.backpack));

// ---- 汇总 ----
console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
