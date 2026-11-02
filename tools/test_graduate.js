'use strict';

/**
 * test_graduate.js — 毕业基准生成器验证（盘点 §3.3 / 议题B）
 *
 * 覆盖：
 *   1. 物化：8 部位 × 5 词条 = 40 条，全部取**承音值**（毕业=玩家现实可达；定音区间无承音概念故取最大值）；定音按方案预填（攻具=攻具定音，护甲=防具定音）
 *   2. 全局配额：物化装备跑 quotaCensus → 全部 缺口0/溢出0（构造即按配额行扣减）
 *   3. 终极自检：物化装备逐件匹配度全"天"
 *   4. 基准：dps>0；大外流/小外流基准不同（按流各自一个基准）
 *   5. 接线：calcDPS 的 graduateDps 覆盖生效；缺省回退 build 包 Excel I16
 *   6. 对照：打印 生成基准 vs Excel I16 偏差（校验信号，不设断言——偏差大=配额理解与作者不一致）
 */

import { loadBuild } from './load-build.js';
import { loadVersionData } from './load-version.js';
import { derivePrescription, lookupAffixRange } from '../engine/quota.js';
import { gradeItem } from '../engine/advisor.js';
import { quotaCensus } from '../engine/monitor.js';
import { computePanel } from '../engine/panel.js';
import { calcDPS } from '../engine/dps.js';
import { materializeGraduateGear, computeGraduateDps } from '../engine/graduate.js';

const { version, affixes } = loadVersionData();
const ctx = loadBuild('pozhufeng.115.3.2');
const flowDoc = JSON.parse(await (await import('node:fs/promises')).readFile('data/template/pozhufeng/pozhufeng.dawai.json', 'utf-8'));
const daWai = { ...flowDoc, flowId: 'dawai' };

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
}

const prescription = derivePrescription(affixes, daWai, ['双刀', '绳镖']);
check('推导可行', prescription.feasible === true);

// —— 1. 物化形状 ——
const mat = materializeGraduateGear(prescription, affixes, daWai);
check('物化成功', mat.ok === true);
if (!mat.ok) console.error('物化失败：', mat.errors);
check('8 部位齐全', mat.gear?.length === 8);
check('40 词条（8×5）', mat.gear?.every((p) => (p.初始.属性 ? 1 : 0) + p.调律.filter((t) => t.属性).length === 5) === true);
check('词条全有数值', mat.gear?.every((p) => [p.初始, ...p.调律].every((a) => typeof a.数值 === 'number')) === true);
check('护甲定音=方案防具定音', mat.gear?.filter((p) => !['武器1', '武器2', '环', '佩'].includes(p.slot)).every((p) => p.定音?.属性 === daWai.防具定音) === true);
check('攻具定音=方案攻具定音', mat.gear?.filter((p) => ['武器1', '武器2', '环', '佩'].includes(p.slot)).every((p) => p.定音?.属性 === daWai.攻具定音) === true);
check('定音数值=定音区间最大值（护甲定音经技能定音别名）', mat.gear?.every((p) => {
  const expected = affixes.定音区间[p.定音.属性]?.max
    ?? (affixes.护甲定音词条?.includes(p.定音.属性) ? affixes.定音区间['技能定音']?.max : undefined);
  return p.定音?.数值 === expected;
}) === true);

// —— 1b. 数值口径：承音值（用户定稿 2026-10-22：毕业=玩家现实可达，满值只是理想 roll）——
const allAffixes = (mat.gear || []).flatMap((p) => [p.初始, ...p.调律]);
check('毕业词条数值=承音值（区间承音值，非满值）', allAffixes.length === 40
  && allAffixes.every((a) => a.数值 === lookupAffixRange(affixes, a.属性)?.承音));
check('承音值≠满值（断言有效：确有词条两者不同）',
  allAffixes.some((a) => {
    const r = lookupAffixRange(affixes, a.属性);
    return r && r.承音 != null && r.承音 !== r.max;
  }));
check('物化装备标为承音（与承音值口径自洽，panel 不会报超限）',
  (mat.gear || []).every((p) => p.承音 === true));
const prGrad = computePanel({
  version, affixes, build: { 流派: ctx.build.name }, gear: mat.gear,
  selections: { 装备套装: '燕归', 武库: '破竹', 弓玦: '', 心法: ['', '', '', ''] },
});
check('毕业基准面板无警告（尤无承音超限噪声）', (prGrad.warnings || []).length === 0);

// —— 2. 全局配额 0 缺口/0 溢出 ——
const census = quotaCensus(mat.gear, daWai);
check('配额全部恰好满足（0 缺口 0 溢出）',
  census.rows?.length > 0 && census.rows.every((r) => r.缺口 === 0 && r.溢出 === 0));

// —— 3. 终极自检：逐件全"天" ——
const tiers = mat.gear.map((p) => gradeItem(prescription, p.slot, { initial: p.初始.属性, tunings: p.调律.map((t) => t.属性) }));
check('物化装备逐件匹配度全"天"', tiers.every((g) => g.ok && g.tier === '天'));

// —— 4. 基准生成 + 按流粒度 ——
const selections = { 装备套装: '燕归', 武库: '破竹', 弓玦: '', 心法: ['', '', '', ''] };
const gen = computeGraduateDps({ buildCtx: ctx, version, affixes, selections, prescription, flow: daWai });
check('毕业基准生成成功', gen.ok === true && gen.dps > 0);
check('Excel I16 对照存在', gen.excelBaseline === ctx.build.graduate_dps);
check('偏差字段为数值', typeof gen.deviation === 'number');

const xiaoDoc = JSON.parse(await (await import('node:fs/promises')).readFile('data/template/pozhufeng/pozhufeng.xiaowai.json', 'utf-8'));
const xiaoWai = { ...xiaoDoc, flowId: 'xiaowai' };
const pXiao = derivePrescription(affixes, xiaoWai, ['双刀', '绳镖']);
const genXiao = computeGraduateDps({ buildCtx: ctx, version, affixes, selections, prescription: pXiao, flow: xiaoWai });
check('小外流基准生成成功', genXiao.ok === true && genXiao.dps > 0);
check('按流基准：大外/小外基准不同', genXiao.dps !== gen.dps);

// —— 5. 接线：calcDPS graduateDps 覆盖 + 缺省回退 ——
const rDefault = calcDPS(ctx, {});
check('缺省回退 build.graduate_dps', rDefault.graduateDps === ctx.build.graduate_dps);
const rOverride = calcDPS(ctx, { graduateDps: gen.dps });
check('graduateDps 覆盖生效', rOverride.graduateDps === gen.dps && Math.abs(rOverride.graduationRate - rOverride.dps / gen.dps) < 1e-12);

// —— 6. 对照打印（信息性） ——
console.log(`\n对照（校验信号，不设断言）：`);
console.log(`  大外流：生成基准 ${gen.dps.toFixed(2)} vs Excel I16 ${gen.excelBaseline}（偏差 ${(gen.deviation * 100).toFixed(2)}%）`);
console.log(`  小外流：生成基准 ${genXiao.dps.toFixed(2)} vs Excel I16 ${gen.excelBaseline}（偏差 ${(genXiao.deviation * 100).toFixed(2)}%）`);

console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：', fails);
  process.exit(1);
}
