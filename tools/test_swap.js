'use strict';

/**
 * test_swap.js — 系统③ΔDPS 单件替换对比验证
 *
 * 基准：真实破竹风 build（panel→dps 全链路）+ P1a 满配 gear。
 * 覆盖：
 *   1. 更差（换掉双刀增+会心）→ 保留旧件、新件候补（地）
 *   2. 更好（反向替换）→ 建议替换、旧件留作候补
 *   3. 等价-同档-数值微差（单条大外 roll −1.2）→ 死区内，按当前 DPS 排序
 *   4. 等价-跨档（死区放大）→ 档位优先于当前 DPS（新件天 > 旧件地 → 建议替换（长期价值））
 *   5. 空位替换 → 从无到有
 *   6. 面板差异解释、结果自描述、确定性
 */

import fs from 'node:fs';
import { loadBuild } from './load-build.js';
import { derivePrescription } from '../engine/quota.js';
import { evaluateSwap } from '../engine/swap.js';

const affixes = JSON.parse(fs.readFileSync('data/version/affixes-115.json', 'utf-8'));
const version = JSON.parse(fs.readFileSync('data/version/nanlvxianghe-shang.115.json', 'utf-8'));
const flowsDoc = JSON.parse(fs.readFileSync('data/template/pozhufeng/pozhufeng.dawai.json', 'utf-8'));
const daWai = { ...flowsDoc, flowId: 'dawai' };
const buildCtx = loadBuild('pozhufeng.115.3.2');
const prescription = derivePrescription(affixes, daWai, ['双刀', '绳镖'], buildCtx.build.dingyin_affix);
const selections = { 装备套装: buildCtx.build.selectors.set, 武库: buildCtx.build.selectors.weapon_attribute };

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
}

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
  调律: tunings.map(a => ({ 属性: a, 数值: V(a) })),
});

// —— 满配 8 件（大外流，与 test_monitor 同结构但带真实数值） ——
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

// —— 1. 更差：天 → 地件 ——
const rA = evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear: fullGear, newItem: diLeft, prescription,
});
check('更差：DPS 下降且超死区', rA.ok === true && rA.before.dps > 0 && rA.deltaPct < -rA.deadZone && rA.verdict === '更差');
check('更差：推荐保留旧件；新件为地档候补',
  rA.recommendation === '保留旧件' && rA.swapRecommended === false
  && rA.gradeOld.tier === '天' && rA.gradeNew.tier === '地' && rA.候补 === true);
check('更差：旧件去向=传家宝继续使用', rA.旧件去向.includes('传家宝'));
check('更差：面板差异含 会心率↓ 与 势↑（新件带的势、丢掉的会心）',
  rA.panelDiff.some(r => r.属性 === '会心率' && r.方向 === '↓')
  && rA.panelDiff.some(r => r.属性 === '势' && r.方向 === '↑'));

// —— 2. 更好：地件 → 天件（反向替换） ——
const rB = evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear: fullGear.map(g => (g.slot === '左武器' ? diLeft : g)),
  newItem: tianLeft, prescription,
});
check('更好：DPS 上升且超死区', rB.verdict === '更好' && rB.deltaPct > rB.deadZone && rB.swapRecommended === true);
check('更好：推荐替换；旧件（地）留作候补',
  rB.recommendation === '建议替换' && rB.gradeNew.tier === '天' && rB.gradeOld.tier === '地' && rB.候补 === false);
check('更好：旧件去向=过渡主力留作候补', rB.旧件去向.includes('过渡主力'));

// —— 3. 等价-同档-数值微差：单条大外 roll −1.2 ——
const nearLeft = clonePiece(tianLeft);
nearLeft.调律[0].数值 = V('最大外功攻击') - 1.2;
function clonePiece(p) { return JSON.parse(JSON.stringify(p)); }
const rC = evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear: fullGear, newItem: nearLeft, prescription,
});
check('等价-数值微差：|Δ%| 在死区内', rC.verdict === '等价' && Math.abs(rC.deltaPct) <= rC.deadZone);
check('等价-同档：按当前 DPS 排序（旧件略优→保留旧件）',
  rC.tieBreak === '旧件当前数值略优' && rC.swapRecommended === false
  && rC.gradeOld.tier === '天' && rC.gradeNew.tier === '天');
check('等价-同档：新件也是天 → 按传家宝必留规则判候补',
  rC.候补 === true && rC.新件去向.includes('候补'));

// —— 4. 等价-跨档：死区放大，档位优先于当前 DPS ——
const rD = evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear: fullGear.map(g => (g.slot === '左武器' ? diLeft : g)),
  newItem: tianLeft, prescription, deadZone: 0.5,
});
check('等价-跨档：死区内判定为等价', rD.verdict === '等价');
check('等价-跨档：档位优先（新件天>旧件地→建议替换（长期价值））',
  rD.tieBreak === '新件档位更高' && rD.recommendation.includes('建议替换') && rD.swapRecommended === true);
check('等价-跨档：被替换的旧件（地）留作候补', rD.旧件去向.includes('候补'));

// —— 5. 空位替换 ——
const rE = evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear: fullGear.filter(g => g.slot !== '左武器'),
  newItem: tianLeft, prescription,
});
check('空位：replacedOld=false，从无到有 DPS 上升',
  rE.replacedOld === false && rE.verdict === '更好' && rE.deltaPct > 0);
check('空位：gradeOld 标记空位', rE.gradeOld?.空位 === true);

// —— 6. 自描述 / 确定性 / 错误处理 ——
check('自描述：buildId、死区、口径齐全',
  rA.buildId === 'pozhufeng' && rA.deadZone === 0.005
  && typeof rA.口径 === 'string' && rA.口径.includes('等价'));
const rA2 = evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear: fullGear, newItem: diLeft, prescription,
});
check('确定性：同一输入两次结果一致', rA2.deltaAbs === rA.deltaAbs && rA2.verdict === rA.verdict);
const rErr = evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear: fullGear, newItem: { 初始: { 属性: '劲', 数值: 1 } },
});
check('错误处理：新件缺 slot → 拒绝', rErr.ok === false && rErr.errors.length > 0);

// —— 汇总 ——

console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
