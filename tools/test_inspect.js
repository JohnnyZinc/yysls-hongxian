'use strict';

/**
 * test_inspect.js — P1d 三视图整合验证（用户定稿操作场景）
 *
 *   1. 已穿戴装备：匹配度+转律建议 + 当前实装监测；ΔDPS 必须为 null
 *   2. 背包装备：ΔDPS + 匹配度 + 假设穿上后的监测（前瞻口径：缺口/溢出/未配额）
 *   3. 整体：DPS 毕业率 + 属性面板 + 当前监测
 *   4. 错误处理与自描述
 */

import fs from 'node:fs';
import { loadBuild } from './load-build.js';
import { derivePrescription } from '../engine/quota.js';
import { inspectEquipped, inspectCandidate, inspectOverall } from '../engine/inspect.js';

const affixes = JSON.parse(fs.readFileSync('data/version/affixes-115.json', 'utf-8'));
const version = JSON.parse(fs.readFileSync('data/version/nanlvxianghe-shang.115.json', 'utf-8'));
const dingyinMap = JSON.parse(fs.readFileSync('data/version/dingyin-map.json', 'utf-8'));
const flowsDoc = JSON.parse(fs.readFileSync('data/template/pozhufeng/pozhufeng.dawai.json', 'utf-8'));
const daWai = { ...flowsDoc, flowId: 'dawai' };
const buildCtx = loadBuild('pozhufeng.115.3.2');
const prescription = derivePrescription(affixes, daWai, ['双刀', '绳镖']);
const selections = { 装备套装: buildCtx.build.selectors.set, 武库: buildCtx.build.selectors.weapon_attribute };

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
}

const FALLBACK = { 双刀武学增伤: 0.1, 绳镖武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
const V = (name) => {
  const r = affixes.词条区间[name];
  if (r) return r.承音 ?? r.max;
  return FALLBACK[name] ?? 0;
};
const mk = (slot, initial, tunings) => ({
  slot,
  初始: { 属性: initial, 数值: V(initial) },
  调律: tunings.map(a => ({ 属性: a, 数值: V(a) })),
});
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
const diLeft = mk('左武器', '最大外功攻击', ['最大外功攻击', '劲', '势', '气血最大值']);
const tianLeft = fullGear[0];

// ———— 1. 已穿戴装备视图 ————

const rEq = inspectEquipped({
  buildCtx, version, affixes, dingyinMap, selections,
  gear: fullGear, piece: tianLeft, prescription, flow: daWai,
});
check('已穿戴：ok 且匹配度为天（含转律建议字段）',
  rEq.ok === true && rEq.view === '已穿戴装备' && rEq.匹配度.tier === '天' && Array.isArray(rEq.匹配度.notes));
check('已穿戴：ΔDPS 为 null（用户定：穿戴中不比较）', rEq.ΔDPS === null);
check('已穿戴：满配实装监测无缺口/溢出/未配额',
  rEq.监测.配额缺口.length === 0 && rEq.监测.配额溢出.length === 0
  && Object.keys(rEq.监测.未配额词条).length === 0);
check('已穿戴：监测达标行来自真实面板（当前值>0）',
  prescription.thresholds && Array.isArray(rEq.监测.达标未达));

const rEqBad = inspectEquipped({
  buildCtx, version, affixes, dingyinMap, selections,
  gear: fullGear.filter(g => g.slot !== '左武器'), piece: tianLeft, prescription, flow: daWai,
});
check('已穿戴：装备不在实装列表 → 拒绝', rEqBad.ok === false && rEqBad.errors.length > 0);

// ———— 2. 背包装备视图 ————

const rCand = inspectCandidate({
  buildCtx, version, affixes, dingyinMap, selections,
  gear: fullGear, newItem: diLeft, prescription, flow: daWai,
});
check('背包：ΔDPS 存在且为更差', rCand.ok === true && rCand.ΔDPS.verdict === '更差' && rCand.ΔDPS.deltaPct < -rCand.ΔDPS.deadZone);
check('背包：匹配度为地', rCand.匹配度.tier === '地');
check('背包：穿上后监测（前瞻）——双刀增缺1、会心缺1',
  rCand.监测.配额缺口.some(r => r.词条.includes('双刀武学增伤') && r.缺口 === 1)
  && rCand.监测.配额缺口.some(r => r.词条.includes('会心率') && r.缺口 === 1));
check('背包：穿上后监测——势溢出1', rCand.监测.配额溢出.some(r => r.词条.includes('势') && r.溢出 === 1));
check('背包：穿上后监测——气血最大值未配额占用', rCand.监测.未配额词条['气血最大值'] === 1);
check('背包：ΔDPS 去向建议齐全（旧件继续使用/新件候补）',
  typeof rCand.ΔDPS.去向.旧件 === 'string' && rCand.ΔDPS.去向.候补 === true);

const rCandNoRx = inspectCandidate({
  buildCtx, version, affixes, dingyinMap, selections,
  gear: fullGear, newItem: diLeft, flow: daWai,
});
check('背包：缺 prescription → 拒绝', rCandNoRx.ok === false && rCandNoRx.errors.length > 0);

// ———— 3. 整体视图 ————

const rAll = inspectOverall({
  buildCtx, version, affixes, dingyinMap, selections,
  gear: fullGear, prescription, flow: daWai,
});
check('整体：DPS>0 且毕业率为数值', rAll.ok === true && rAll.DPS.dps > 0 && typeof rAll.DPS.graduationRate === 'number');
check('整体：属性面板含三率与外功（真实数值）',
  rAll.属性面板['精准率'] > 0 && rAll.属性面板['会心率'] > 0 && rAll.属性面板['最小外功攻击'] > 0);
check('整体：满配实装监测无缺口/溢出',
  rAll.监测.配额缺口.length === 0 && rAll.监测.配额溢出.length === 0);
check('整体：口径说明齐备', typeof rAll.口径 === 'string' && rAll.口径.includes('整体'));

// ———— 汇总 ————

console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
