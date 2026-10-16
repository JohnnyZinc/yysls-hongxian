'use strict';

/**
 * test_studio.js — 三栏工作台 UI 无头冒烟测试
 *
 * 用最小 DOM/fetch/localStorage 桩在 Node 里跑真实的 web/studio.js：
 *   1. init：右栏流派/流/口径下拉、DPS 毕业率、属性面板；中栏默认「录入装备」按钮
 *   2. 旧档迁移：部位 左武器/右武器 → 武器（武器不分左右——用户定稿）
 *   3. 录入表单（边录入边评价）：部位=武器+武器类型、实时潜力、无同类已穿戴时无毕业率变化
 *   4. 武器按类型对比：穿上双刀后再录一把双刀 → 毕业率变化出现；转律标记单选语义
 *   5. 背包/已穿戴两维评价（ΔDPS+匹配度，监测只在右栏）；穿上/脱下/删除；存档
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

// ---- 预置旧版存档（部位=右武器 + weaponType=绳镖），验证迁移与类型对比 ----
globalThis.localStorage._m['yysls-evaluator-v1'] = JSON.stringify({
  buildId: 'pozhufeng.115.3.2',
  flowId: 'dawai',
  selections: {},
  equipped: {
    右武器: {
      slot: '右武器', weaponType: '绳镖',
      初始: { 属性: '最大外功攻击', 数值: 139.6 },
      调律: [
        { 属性: '最大外功攻击', 数值: 139.6 },
        { 属性: '劲', 数值: 88.4 },
        { 属性: '绳镖武学增伤', 数值: 0.113 },
        { 属性: '会心率', 数值: 0.162 },
      ],
      定音: { 属性: '外功穿透', 数值: 19.4 },
    },
  },
  backpack: [],
});

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
check('左栏：已穿戴 8 物理位渲染（两个武器位+六防具/饰品）', L().includes('腕甲') && L().includes('武器'));
check('左栏：背包空提示', L().includes('背包') && L().includes('0 件未穿戴'));
check('右栏：方案默认已加载（心法/武库/套装/弓玦）',
  state.selections.心法[0] === '易水歌' && state.selections.武库 === '破竹'
  && state.selections.装备套装 === '燕归' && state.selections.弓玦 === '饮羽');

// ---- 2. 旧档迁移：武器不分左右 ----
check('迁移：旧档 右武器 部位归一为 武器（weaponType 保留）',
  state.equipped['右武器']?.slot === '武器' && state.equipped['右武器']?.weaponType === '绳镖');
check('迁移：已穿戴武器卡按 武器·类型 显示（部位名不再出现）',
  L().includes('武器 · 绳镖') && !L().includes('>右武器<'));

// ---- 3. 录入表单（部位=武器 + 武器类型）→ 无同类已穿戴 ----
actions.openEditor('冠胄');
check('录入：空槽位打开表单并预选部位', state.editing === true && state.draft.slot === '冠胄');
check('录入：未录词条时无实时评价', !C().includes('实时评价'));
actions.setDraftSlot('武器');
check('录入：部位=武器（不分左右）+ 类型跟随流派', state.draft.slot === '武器' && state.draft.weaponType === '双刀');
check('录入：部位下拉无 左武器/右武器 选项', !C().includes('>左武器<') && !C().includes('>右武器<'));
check('录入：调律行有转律复选框', C().includes('data-ed-field="转律"'));
actions.setDraftWeaponType('双刀');
actions.setDraftAffix('初始', null, '最大外功攻击');
check('录入：录第1条词条即显示潜力', C().includes('实时评价') && C().includes('当前潜力') && C().includes('已录 1/5'));
actions.setDraftAffix('调律', 0, '最大外功攻击');
actions.setDraftAffix('调律', 1, '劲');
actions.setDraftAffix('调律', 2, '双刀武学增伤');
actions.setDraftAffix('调律', 3, '会心率');
check('录入：初始+调律数值自动填区间值', state.draft.初始.数值 > 0 && state.draft.调律[2].数值 > 0);
check('录入：结构录满（5/5）', C().includes('已录 5/5'));
check('录入：当前无双刀已穿戴 → 无替换基准（无判定徽章），显示无可对比说明',
  C().includes('无可对比') && C().includes('不同类型不比较') && !C().includes('verdict-badge big'));
const uid = actions.addDraft();
check('添加：成功进背包并自动选中（背包视图）', !!uid && state.selected?.kind === 'backpack' && state.editing === false);
check('背包视图：ΔDPS 无可对比说明 + 匹配度，监测不在单件视图',
  C().includes('无可对比') && C().includes('② 匹配度') && !C().includes('监测发现（假设穿上后）'));
check('背包视图：匹配度=天', C().includes('天'));

// ---- 4. 穿上双刀 → 两把武器位（双刀+绳镖） ----
actions.equip(uid);
check('穿上：双刀入第一个空武器位（存储键 左武器），部位=武器',
  state.equipped['左武器']?.slot === '武器' && state.equipped['左武器']?.weaponType === '双刀'
  && state.selected?.kind === 'equipped');
check('已穿戴视图：标题按 武器·类型 显示，无 ΔDPS', C().includes('已穿戴 · 武器 · 双刀') && C().includes('无 ΔDPS'));
check('已穿戴视图：匹配度=天', C().includes('天'));
check('右栏：整体监测发现显示配额缺口（只穿两件武器）', R().includes('配额缺口'));

// ---- 5. 再录一把双刀 → 有同类已穿戴 → 毕业率变化出现 ----
actions.openEditor('武器');
check('录入：再次打开默认保留 武器+双刀', state.draft.slot === '武器' && state.draft.weaponType === '双刀');
actions.setDraftAffix('初始', null, '最大外功攻击');
actions.setDraftAffix('调律', 0, '最大外功攻击');
actions.setDraftAffix('调律', 1, '劲');
actions.setDraftAffix('调律', 2, '双刀武学增伤');
actions.setDraftAffix('调律', 3, '会心率');
check('录入：有同类已穿戴 → 毕业率变化（假设穿上）出现', C().includes('毕业率变化（假设穿上）'));

// ---- 5.5 转律标记：单选语义 ----
actions.setDraftConverted(1, true);
check('转律：勾选调律2 → 仅其带转律标记', state.draft.调律[1]?.转律 === true
  && state.draft.调律.every((a, i) => i === 1 || !a?.转律));
actions.setDraftConverted(3, true);
check('转律：改勾调律4 → 标记迁移（单选）',
  state.draft.调律[3]?.转律 === true && !state.draft.调律[1]?.转律);
actions.setDraftConverted(3, false);
check('转律：取消勾选 → 全部未标记', state.draft.调律.every((a) => !a?.转律));
const uid2 = actions.addDraft();
check('同类型对比：背包视图出现 ΔDPS（与同类型已穿戴对比）', !!uid2 && C().includes('① ΔDPS') && !C().includes('无可对比'));
check('同类型对比：词条完全相同 → 等价', C().includes('等价'));
actions.removeBackpack(uid2);
check('删除：背包清空、中栏回到录入装备按钮', state.backpack.length === 0 && C().includes('录入装备'));

// ---- 6. 脱下 / 删除 ----
actions.unequip('左武器');
check('脱下：双刀回背包（部位=武器）', state.selected?.kind === 'backpack' && state.equipped['左武器'] == null);
actions.removeBackpack(state.selected.uid);
check('清理：背包清空', state.backpack.length === 0);

// ---- 6.5 录入后直接穿上（一步入包+装备；非武器部位） ----
actions.openEditor('环');
actions.setDraftAffix('初始', null, '最大外功攻击');
actions.setDraftAffix('调律', 0, '最大外功攻击');
actions.setDraftAffix('调律', 1, '全武学增伤');
actions.setDraftAffix('调律', 2, '劲');
actions.setDraftAffix('调律', 3, '会心率');
const uid3 = actions.addAndEquip();
check('直接穿上：一步入包+装备（原为空位，无旧件）',
  !!uid3 && state.equipped['环'] != null && !state.backpack.some((b) => b.uid === uid3)
  && state.selected?.kind === 'equipped' && state.editing === false);
actions.unequip('环');
actions.removeBackpack(state.selected.uid);
check('清理：环位回到空、背包清空', state.equipped['环'] == null && state.backpack.length === 0);

// ---- 7. 存档（迁移结果持久化） ----
const saved = JSON.parse(localStorage.getItem('yysls-evaluator-v1') || 'null');
check('存档：与评价器共用 key；迁移后的 部位=武器 持久化',
  !!saved && saved.flowId === 'dawai' && Array.isArray(saved.backpack)
  && saved.equipped?.['右武器']?.slot === '武器');

// ---- 汇总 ----
console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
