'use strict';

/**
 * test_web.js — 验证台 UI 无头冒烟测试
 *
 * 用最小 DOM/fetch/localStorage 桩在 Node 里跑真实的 web/app.js：
 *   1. init() 成功：流派下拉有 6 个选项，主表格渲染出 8 个部位卡片
 *   2. 点击"计算"（直接调用按钮的 onclick）：结果区出现 DPS 与毕业率
 *
 * 运行： node tools/test_web.js
 */
import fs from 'node:fs';
import assert from 'node:assert';

// ---- DOM / 浏览器环境桩 ----
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
  const data = await fs.promises.readFile(p, 'utf-8');
  return { ok: true, json: async () => JSON.parse(data) };
};

// ---- 跑真实的 app.js ----
const appMod = await import('../web/app.js');
await new Promise((r) => setTimeout(r, 200)); // 等 init() 完成

const selHtml = document.querySelector('#build-select').innerHTML;
for (const name of ['破竹风', '牵丝玉', '破竹尘', '破竹樽', '裂石威', '牵丝霖']) {
  assert.ok(selHtml.includes(name), `流派下拉缺少 ${name}`);
}

const appHtml = document.querySelector('#app').innerHTML;
for (const slot of ['左武器', '右武器', '环', '佩', '冠胄', '胸甲', '胫甲', '腕甲']) {
  assert.ok(appHtml.includes(slot), `装备卡缺少部位 ${slot}`);
}
for (const key of ['弓玦', '装备套装', '武库', '心法1', '计算面板与 DPS']) {
  assert.ok(appHtml.includes(key), `页面缺少 ${key}`);
}
// 回归：武器调律下拉必须同时含指定武学增伤与普通词条（曾因池键名不匹配只剩前者）
assert.ok(appHtml.includes('双刀武学增伤'), '武器调律下拉缺少指定武学增伤');
assert.ok(appHtml.includes('最小外功攻击'), '武器调律下拉缺少普通词条');
// 弓玦标注三率
assert.ok(appHtml.includes('饮羽（精准率）'), '弓玦选项未标注提供的三率');
// 区间提示并入数值框 placeholder，不再单独占行
assert.ok(appHtml.includes('placeholder='), '数值框缺少区间 placeholder');
assert.ok(!appHtml.includes('class="hint"'), '区间提示不应单独成行');

// ---- lookupRange：词条名→区间 的完整覆盖回归 ----
const A = JSON.parse(fs.readFileSync('data/version/affixes-115.json', 'utf-8'));
const lr = (n) => appMod.lookupRange(A, n);
assert.ok(lr('最大外功攻击').max === 139.6, '普通词条区间查找失败');
assert.ok(lr('双刀武学增伤').max === 0.113, '指定武学增伤应映射到武器增伤区间');
assert.ok(lr('伞武学增伤').max === 0.113, '指定武学增伤(伞)应映射到武器增伤区间');
assert.ok(lr('全武学增伤').max === 0.056, '全武学增伤用自己的区间');
assert.ok(lr('对首领单位增伤').max === 0.059, '对首领单位增伤应映射到首领单位增伤区间');
assert.ok(lr('对玩家单位增伤').max === 0.059, '对玩家单位增伤应映射到玩家单位增效区间');
assert.ok(lr('全奇术增伤').max === 0.176, '全奇术增伤应映射到奇术增伤区间');
assert.ok(lr('粟子游尘鼠鼠增伤').max === 0.106, '护甲定音应映射到技能定音区间');
assert.ok(lr('嗟夫刀法护盾增效').max === 0.106, '护盾增效等非增伤结尾定音也应映射');
assert.ok(lr('外功穿透').max === 19.4, '定音外功穿透区间');
assert.ok(lr('最大无相攻击').max === 79.2 && lr('最大无相攻击').承音 === 74.5, '无相攻击词条区间（与鸣金一致）');
assert.ok(lr('最小无相攻击').min === 39.6, '最小无相攻击区间');

// ---- 触发计算 ----
const calcBtn = document.querySelector('#btn-calc');
assert.ok(typeof calcBtn.onclick === 'function', '计算按钮未绑定 onclick');
calcBtn.onclick();

const resultsHtml = document.querySelector('#results').innerHTML;
assert.ok(resultsHtml.includes('DPS'), '结果缺少 DPS');
assert.ok(resultsHtml.includes('毕业率'), '结果缺少毕业率');
assert.ok(resultsHtml.includes('精准率'), '结果缺少精准率');
assert.ok(!resultsHtml.includes('计算出错'), `计算出错: ${resultsHtml.slice(0, 300)}`);
// 回归：skills/effects 必须正确解包，DPS 不得为 0（曾因整包未解包全事件零倍率）
const dpsMatch = resultsHtml.match(/dps-big">([\d.]+)/);
assert.ok(dpsMatch && parseFloat(dpsMatch[1]) > 0, `DPS 应大于 0（skills/effects 解包回归），实际=${dpsMatch ? dpsMatch[1] : '无'}`);
// 面板关键值抽查（空装备=固定层+默认选区）
assert.ok(resultsHtml.includes('精准率'), '面板关键值缺失');

console.log('UI 冒烟测试通过：初始化/渲染/计算 全链路 OK');
console.log('  (DPS 为空装备默认面板值，属预期)');
