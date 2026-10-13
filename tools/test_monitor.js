'use strict';

/**
 * test_monitor.js — 系统②属性数值监测验证
 *
 * 覆盖：
 *   1. 全局配额统计：满配 8 件（大外流 40 词条恰好配齐）→ 全部 缺口0/溢出0；
 *      别名计数；缺一条（未配额词条识别）；溢出（会心9→溢1、精准缺1）
 *   2. 达标线评估：黄字精准率 98% 线（达标/未达标/差距）、未知指标警示、缺失面板按 0
 *   3. 小外流启用度：未反转（距反转差值+承音折算词条数）、已反转、大外流不适用
 *   4. 集成：computePanel(破竹风, 空装备) → analyzeFlow 真实面板值贯通 + 结果自描述
 */

import fs from 'node:fs';
import { computePanel } from '../engine/panel.js';
import { analyzeFlow, evaluateThresholds, quotaCensus, enablement } from '../engine/monitor.js';

const affixes = JSON.parse(fs.readFileSync('data/version/affixes-115.json', 'utf-8'));
const version = JSON.parse(fs.readFileSync('data/version/nanlvxianghe-shang.115.json', 'utf-8'));
const flowsDoc = JSON.parse(fs.readFileSync('data/template/pozhufeng/pozhufeng.dawai.json', 'utf-8'));
const daWai = { ...flowsDoc, flowId: 'dawai' };
const xiaoWai = { ...JSON.parse(fs.readFileSync('data/template/pozhufeng/pozhufeng.xiaowai.json', 'utf-8')), flowId: 'xiaowai' };

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
}
const clone = o => JSON.parse(JSON.stringify(o));
const piece = (slot, initial, tunings) => ({
  slot,
  初始: { 属性: initial, 数值: 0 },
  调律: tunings.map(a => ({ 属性: a, 数值: 0 })),
});
const rowOf = (census, affix) => census.rows.find(r => r.词条.includes(affix));

// ———— 1. 配额统计：大外流满配 8 件（40 词条恰好配齐） ————

const fullGear = [
  piece('左武器', '最大外功攻击', ['最大外功攻击', '劲', '双刀武学增伤', '会心率']),
  piece('右武器', '最大外功攻击', ['最大外功攻击', '劲', '绳镖武学增伤', '会心率']),
  piece('环', '最大外功攻击', ['最大外功攻击', '全武学增伤', '劲', '会心率']),
  piece('佩', '最大外功攻击', ['最大外功攻击', '全武学增伤', '劲', '精准率']),
  piece('冠胄', '精准率', ['最大外功攻击', '劲', '会心率', '势']),
  piece('胸甲', '会心率', ['最大外功攻击', '劲', '会心率', '势']),
  piece('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率']),
  piece('腕甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率']),
];

const fullCensus = quotaCensus(fullGear, daWai);
check('满配统计：总实装 40', fullCensus.total实装 === 40);
check('满配统计：所有配额行 缺口0 溢出0',
  fullCensus.rows.every(r => r.缺口 === 0 && r.溢出 === 0 && r.实装 === r.需要));
check('满配统计：无未配额词条', Object.keys(fullCensus.未配额词条).length === 0);
check('满配统计：定音词条不计入（gear 未填定音即不计）', fullCensus.total实装 === 40);

// 别名计数：把左武器初始改写为社区叫法"大外"，结果不变
const aliasGear = clone(fullGear);
aliasGear[0].初始.属性 = '大外';
const aliasCensus = quotaCensus(aliasGear, daWai);
check('别名计数：「大外」归一到最大外功攻击（仍 12/12）',
  rowOf(aliasCensus, '最大外功攻击').实装 === 12 && Object.keys(aliasCensus.未配额词条).length === 0);

// 缺口 + 未配额词条：冠胄调律 势→气血
const gapGear = clone(fullGear);
gapGear[4].调律[3].属性 = '气血最大值';
const gapCensus = quotaCensus(gapGear, daWai);
check('缺口统计：势 缺1', rowOf(gapCensus, '势').缺口 === 1 && rowOf(gapCensus, '势').实装 === 1);
check('未配额词条：气血最大值 ×1 被识别为无配额占用',
  gapCensus.未配额词条['气血最大值'] === 1);

// 溢出：冠胄初始 精准率→会心率 → 会心9溢1、精准缺1
const overGear = clone(fullGear);
overGear[4].初始.属性 = '会心率';
const overCensus = quotaCensus(overGear, daWai);
check('溢出统计：会心 溢出1', rowOf(overCensus, '会心率').溢出 === 1);
check('溢出统计：精准率 缺口1', rowOf(overCensus, '精准率').缺口 === 1);

// ———— 2. 达标线评估 ————

const stats = { 精准率: 0.972, 会心率: 0.66, 会意率: 0.09 };
const th = evaluateThresholds(stats, daWai);
check('达标线：两行（生效精准率/会心率）', th.rows.length === 2);
const prRow = th.rows.find(r => r.指标 === '生效精准率');
const crRow = th.rows.find(r => r.指标 === '会心率');
check('达标线：黄字精准率 97.2% < 98% → 未达标，差距 0.008',
  prRow.达标 === false && Math.abs(prRow.差距 - 0.008) < 1e-9 && prRow.当前值 === 0.972);
check('达标线：黄字会心率 66% ≥ 65% → 达标', crRow.达标 === true && crRow.差距 === 0);
check('达标线：每行带口径字段（来自 monitor.js 指标登记表，非文件注记）',
  th.rows.every(r => typeof r.口径 === 'string' && r.口径.length > 0));

const unknownFlow = clone(daWai);
unknownFlow.thresholds = { 最终生效会心概率: 0.75 };
const thUnknown = evaluateThresholds(stats, unknownFlow);
check('达标线：技能级指标 → 警示且不误评',
  thUnknown.rows.length === 0 && thUnknown.warnings.some(w => w.includes('技能级')));

const thEmpty = evaluateThresholds({}, daWai);
check('达标线：面板缺失按 0 处理（未达标）',
  thEmpty.rows.every(r => r.当前值 === 0 && r.达标 === false));

// ———— 3. 小外流启用度 ————

const en1 = enablement({ 最小外功: 4000, 最大外功: 4200 }, xiaoWai, affixes);
check('启用度：小外流适用，未反转，差值 200',
  en1.适用 === true && en1.已反转 === false && en1.距反转差值 === 200);
check('启用度：承音折算 ≈2 条小外', en1.折算词条数 === 2);

const en2 = enablement({ 最小外功: 4300, 最大外功: 4200 }, xiaoWai, affixes);
check('启用度：已反转（最小>最大，固定取小外）', en2.已反转 === true && en2.距反转差值 === 0 && en2.折算词条数 === undefined);

const en3 = enablement({ 最小外功: 4000, 最大外功: 4200 }, daWai, affixes);
check('启用度：大外流标记不适用（配额无最小外功行）', en3.适用 === false && en3.已反转 === false);

// ———— 4. 集成：computePanel 真实面板贯通 ————

const pr = computePanel({
  version,
  affixes,
  build: { 流派: '破竹风' },
  gear: [],
  selections: {},
});
const report = analyzeFlow({ panelStats: pr.stats, gear: fullGear, flow: daWai, affixes });
check('集成：报告 ok 且自描述（buildId/flowId/口径）',
  report.ok === true && report.buildId === 'pozhufeng' && report.flowId === 'dawai'
  && typeof report.口径.说明 === 'string');
check('集成：达标线当前值来自真实面板（精准率一致）',
  report.达标线.rows.find(r => r.指标 === '生效精准率').当前值 === pr.stats['精准率']);
check('集成：配额统计与单测一致（满配全零缺口）',
  report.配额统计.rows.every(r => r.缺口 === 0 && r.溢出 === 0));
check('集成：空装备真实面板产出有限数值（固定层参与）', pr.stats['精准率'] > 0);

const reportX = analyzeFlow({ panelStats: pr.stats, gear: fullGear, flow: xiaoWai, affixes });
check('集成：小外流报告含启用度且适用',
  reportX.ok === true && reportX.启用度?.适用 === true && reportX.启用度.最小外功 > 0);

const badReport = analyzeFlow({ panelStats: null, gear: [], flow: daWai });
check('集成：缺 panelStats → 拒绝并报错', badReport.ok === false && badReport.errors.length > 0);

// ———— 汇总 ————

console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
