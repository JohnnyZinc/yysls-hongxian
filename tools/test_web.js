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
await import('../web/app.js');
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

// ---- 触发计算 ----
const calcBtn = document.querySelector('#btn-calc');
assert.ok(typeof calcBtn.onclick === 'function', '计算按钮未绑定 onclick');
calcBtn.onclick();

const resultsHtml = document.querySelector('#results').innerHTML;
assert.ok(resultsHtml.includes('DPS'), '结果缺少 DPS');
assert.ok(resultsHtml.includes('毕业率'), '结果缺少毕业率');
assert.ok(resultsHtml.includes('精准率'), '结果缺少精准率');
assert.ok(!resultsHtml.includes('计算出错'), `计算出错: ${resultsHtml.slice(0, 300)}`);

console.log('UI 冒烟测试通过：初始化/渲染/计算 全链路 OK');
console.log('  (DPS 为空装备默认面板值，属预期)');
