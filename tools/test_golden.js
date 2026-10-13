'use strict';

/**
 * test_golden.js — 黄金基准（快照测试）
 *
 * 目的：为"去 Excel 化"重构提供替代验收手段。
 *   当前引擎已被 Excel 对表验证（面板 45/45、六流派 DPS 偏差 0.0000%），
 *   把它的输出固化为 JSON 基准后，基准的验证力可以继承：
 *   以后任何重构跑本测试，数值超出容差即视为改坏；
 *   有意变更时用 --update 重新固化，人工审查差异后提交。
 *
 * 覆盖三层（重构会碰到的一切路径）：
 *   1. 面板层：computePanel（鸣金虹算例，与 test_panel 同输入，快照原始输出）
 *   2. DPS 层：calcDPS 六流派（build 默认面板，含逐事件 L 值）
 *   3. ΔDPS 层：evaluateSwap（真实 build + 满配 gear 全链路，四个判定场景）
 *
 * 数值容差：相对 1e-9——放行浮点重结合的末位噪声，
 *   拦截任何真实的逻辑改动（真实改动偏差通常 ≥1e-6）。
 *
 * 运行：node tools/test_golden.js            比对快照
 *       node tools/test_golden.js --update   重新固化基准（审查差异后提交）
 */

import fs from 'node:fs';
import { computePanel } from '../engine/panel.js';
import { calcDPS } from '../engine/dps.js';
import { loadBuild } from './load-build.js';
import { derivePrescription } from '../engine/quota.js';
import { evaluateSwap } from '../engine/swap.js';

const UPDATE = process.argv.includes('--update');
const GOLDEN_DIR = 'data/golden';

const BUILDS = [
  ['pozhufeng.115.3.2', '破竹风'],
  ['qiansiyu.115.3.5', '牵丝玉'],
  ['pozhuchen.115.3.3', '破竹尘'],
  ['pozhuzun.115.3.6', '破竹樽'],
  ['lieshiwei.115.3.1', '裂石威'],
  ['qiansilin.115.3.1', '牵丝霖'],
];

// —— 工具：键序无关的稳定序列化（写入基准用） ——
const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v === undefined ? null : v;
};

// —— 工具：带容差的递归对比 ——
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
function collectDiffs(path, a, b, out) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!near(a, b)) out.push(`${path}: 实际=${a} 基准=${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: 数组长度 实际=${a.length} 基准=${b.length}`);
    else a.forEach((x, i) => collectDiffs(`${path}[${i}]`, x, b[i], out));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) out.push(`${path}.${k}: 基准有而实际无=${JSON.stringify(b[k])}`);
      else if (!(k in b)) out.push(`${path}.${k}: 实际有而基准无=${JSON.stringify(a[k])}`);
      else collectDiffs(`${path}.${k}`, a[k], b[k], out);
    }
  } else if (a !== b) {
    out.push(`${path}: 实际=${JSON.stringify(a)} 基准=${JSON.stringify(b)}`);
  }
  return out;
}

// ============ 1. 面板层快照 ============
function panelCase() {
  const version = JSON.parse(fs.readFileSync('data/version/nanlvxianghe-shang.115.json', 'utf-8'));
  return computePanel({
    version,
    affixes: { 词条区间: {} },
    build: { 流派: '鸣金虹' },
    gear: [],
    selections: {
      弓玦: '饮羽',
      装备套装: '玉斗',
      心法: ['凝神章', '无名心法', '威猛歌', '千山法'],
      武库: '鸣金',
    },
  });
}

// ============ 2. DPS 层快照 ============
function dpsCase(prefix) {
  const ctx = loadBuild(prefix);
  const r = calcDPS(ctx, { debug: true });
  return {
    dps: r.dps,
    totalDamage: r.totalDamage,
    graduationRate: r.graduationRate,
    perEvent: (r.perEvent || []).map((e) => ({ row: e.row, skill: e.skill, L: e.L })),
  };
}

// ============ 3. ΔDPS 层快照（与 test_swap 同一夹具） ============
const affixes = JSON.parse(fs.readFileSync('data/version/affixes-115.json', 'utf-8'));
const version = JSON.parse(fs.readFileSync('data/version/nanlvxianghe-shang.115.json', 'utf-8'));
const flowsDoc = JSON.parse(fs.readFileSync('data/template/pozhufeng/pozhufeng.dawai.json', 'utf-8'));
const daWai = { ...flowsDoc, flowId: 'dawai' };
const buildCtx = loadBuild('pozhufeng.115.3.2');
const prescription = derivePrescription(affixes, daWai, ['双刀', '绳镖'], buildCtx.build.dingyin_affix);
const swapSelections = {
  装备套装: buildCtx.build.selectors.set,
  武库: buildCtx.build.selectors.weapon_attribute,
};

// 词条数值：承音值（≈max×94%）；增伤类区间不在词条区间表中，用现实量级近似值
const FALLBACK = { 双刀武学增伤: 0.1, 绳镖武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
const V = (name) => {
  const r = affixes.词条区间[name];
  if (r) return r.承音 ?? r.max;
  return FALLBACK[name] ?? 0;
};
const mk = (slot, initial, tunings) => ({
  slot,
  初始: { 属性: initial, 数值: V(initial) },
  调律: tunings.map((a) => ({ 属性: a, 数值: V(a) })),
});
function clonePiece(p) { return JSON.parse(JSON.stringify(p)); }

// 满配 8 件（大外流，与 test_swap 同结构同数值）
const fullGear = [
  mk('左武器', '最大外功攻击', ['最大外功攻击', '劲', '双刀武学增伤', '会心率']),
  mk('右武器', '最大外功攻击', ['最大外功攻击', '劲', '绳镖武学增伤', '会心率']),
  mk('环', '最大外功攻击', ['最大外功攻击', '全武学增伤', '劲', '会心率']),
  mk('佩', '最大外功攻击', ['最大外功攻击', '全武学增伤', '劲', '精准率']),
  mk('冠胄', '精准率', ['最大外功攻击', '劲', '会心率', '势']),
  mk('胸甲', '会心率', ['最大外功攻击', '劲', '会心率', '势']),
  mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率']),
  mk('腕甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率']),
];
// 地件左武器：缺双刀增（神力不可转得）、带气血（无效可转）
const diLeft = mk('左武器', '最大外功攻击', ['最大外功攻击', '劲', '势', '气血最大值']);
const tianLeft = fullGear[0];
// 等价-同档：单条大外 roll −1.2
const nearLeft = clonePiece(tianLeft);
nearLeft.调律[0].数值 = V('最大外功攻击') - 1.2;

const swapArgs = (currentGear, newItem, extra = {}) => ({
  buildCtx, version, affixes, selections: swapSelections,
  currentGear, newItem, prescription, ...extra,
});

const pickSwap = (r) => ({
  ok: r.ok,
  verdict: r.verdict,
  recommendation: r.recommendation,
  swapRecommended: r.swapRecommended,
  tieBreak: r.tieBreak,
  beforeDps: r.before.dps,
  afterDps: r.after.dps,
  deltaPct: r.deltaPct,
  deadZone: r.deadZone,
  gradeOldTier: r.gradeOld.tier,
  gradeNewTier: r.gradeNew.tier,
});

// ============ 主流程 ============
let pass = 0;
let fail = 0;

function runCase(label, file, produce) {
  const actual = stable(produce());
  const file2 = `${GOLDEN_DIR}/${file}`;
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file2, JSON.stringify(actual, null, 2) + '\n', 'utf-8');
    console.log(`✎ ${label} → ${file2}`);
    return;
  }
  if (!fs.existsSync(file2)) {
    fail += 1;
    console.log(`✗ ${label}: 基准缺失，请先 node tools/test_golden.js --update`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(file2, 'utf-8'));
  const diffs = collectDiffs(label, actual, expected, []);
  if (diffs.length === 0) {
    pass += 1;
    console.log(`✓ ${label}`);
  } else {
    fail += 1;
    console.log(`✗ ${label}: ${diffs.length} 处偏差`);
    for (const d of diffs.slice(0, 8)) console.log(`    ${d}`);
    if (diffs.length > 8) console.log(`    …共 ${diffs.length} 处`);
  }
}

// 面板：鸣金虹算例
runCase('面板:鸣金虹算例', 'panel-mingjinhong.json', () => {
  const r = panelCase();
  return {
    stats: r.stats,
    五维达标率: r.五维达标率,
    主属性达标率: r.主属性达标率,
    warnings: r.warnings,
  };
});

// DPS：六流派
for (const [prefix, name] of BUILDS) {
  runCase(`DPS:${name}`, `dps-${prefix}.json`, () => dpsCase(prefix));
}

// ΔDPS：四个判定场景
runCase('ΔDPS:更差(天→地)', 'swap-pozhufeng.json', () => ({
  更差: pickSwap(evaluateSwap(swapArgs(fullGear, diLeft))),
  更好: pickSwap(evaluateSwap(swapArgs(fullGear.map((g) => (g.slot === '左武器' ? diLeft : g)), tianLeft))),
  等价同档: pickSwap(evaluateSwap(swapArgs(fullGear, nearLeft))),
  等价跨档: pickSwap(evaluateSwap(swapArgs(fullGear.map((g) => (g.slot === '左武器' ? diLeft : g)), tianLeft, { deadZone: 0.5 }))),
}));

if (UPDATE) {
  console.log(`\n基准已固化到 ${GOLDEN_DIR}/，请人工审查差异后提交。`);
} else {
  console.log(`\n通过 ${pass}/${pass + fail}`);
  if (fail) process.exitCode = 1;
}
