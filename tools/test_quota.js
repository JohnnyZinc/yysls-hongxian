'use strict';

/**
 * test_quota.js — 配额推导器验证（排列枚举版）
 *
 * 机制（用户确认）：
 *   - 指定武学增伤跟武器类型走（双刀武器只能出双刀增），但类型跨左右槽自由排列；
 *   - 推导器按排列枚举求解后合并：每把武器必备"恰好1条本类型指定增（any_of 组）"，
 *     双刀增/绳镖增在左武器都是自由项（min=0, max=1）；
 *   - 一件装备同时携带两条指定增 → 与任何排列矛盾 → 评分拒绝（advisor 侧）。
 * 基准：破竹风·大外流供应分析（12大外/10劲/神力6 全锁死）+ 小外流（12小外/6大破竹/
 * 8敏每部位1条/大无相双武器调律各1）。
 */

import fs from 'node:fs';
import { derivePrescription, loadSlotModel, canonicalAffix, verifyItemFits } from '../engine/quota.js';
import { loadVersionData } from './load-version.js';

const { affixes } = loadVersionData();
const SCHOOLS_DIR = 'data/template/pozhufeng';
// 装载器行为：flowId = 文件名去掉流派前缀与 .json
const daWai = { ...JSON.parse(fs.readFileSync(`${SCHOOLS_DIR}/pozhufeng.dawai.json`, 'utf-8')), flowId: 'dawai' };
const xiaoWai = { ...JSON.parse(fs.readFileSync(`${SCHOOLS_DIR}/pozhufeng.xiaowai.json`, 'utf-8')), flowId: 'xiaowai' };
const WT = ['双刀', '绳镖'];

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
}
const clone = o => JSON.parse(JSON.stringify(o));
const sameSet = (a, b) => [...a].sort().join('|') === [...b].sort().join('|');
const req = (rx, affix) => rx.required.find(r => r.affix === affix);
const group = (rx) => rx.required.find(r => r.any_of);

// ———— 0. 别名与模型 ————

check('别名：大外→最大外功攻击', canonicalAffix('大外') === '最大外功攻击');
check('别名：全武学增效→全武学增伤', canonicalAffix('全武学增效') === '全武学增伤');
const model = loadSlotModel(affixes, ['双刀', '剑']);
check('模型：武器调律池按流派类型展开指定增（双刀+剑）',
  model.slots['左武器'].tuningPool.includes('双刀武学增伤') && model.slots['左武器'].tuningPool.includes('剑武学增伤')
  && !model.slots['左武器'].tuningPool.includes('枪武学增伤'));
check('模型：未知武器类型被识别', loadSlotModel(affixes, ['双刀', '魔杖']).unknownTypes.length === 1);
check('模型：转律池不含神力与精准率',
  !model.slots['左武器'].conversionPool.includes('全武学增伤') && !model.slots['左武器'].conversionPool.includes('精准率'));

// ———— 1. 大外流推导 ————

const daWaiRx = derivePrescription(affixes, daWai, WT);
check('大外流：推导可行且无错误', daWaiRx.feasible === true && daWaiRx.errors.length === 0);
check('大外流：两个武器排列（类型跨槽自由）', daWaiRx.arrangements.length === 2
  && daWaiRx.arrangements[0].arrangement.左武器 === '双刀' && daWaiRx.arrangements[1].arrangement.左武器 === '绳镖');
check('大外流：结果自描述（buildId/flowId）', daWaiRx.buildId === 'pozhufeng' && daWaiRx.flowId === 'dawai');

const lw = daWaiRx.mergedSlots['左武器'];
check('大外流·左武器：初始强制=最大外功攻击（12大外锁死的推论）', lw.initialForced === '最大外功攻击');
check('大外流·左武器：必备 大外×2（1初始+1调律）', req(lw, '最大外功攻击')?.count === 2);
check('大外流·左武器：必备 劲×1', req(lw, '劲')?.count === 1);
check('大外流·左武器：必备组 恰好1条指定增（双刀增/绳镖增任一）',
  group(lw)?.count === 1 && sameSet(group(lw).any_of, ['双刀武学增伤', '绳镖武学增伤']));
check('大外流·左武器：自由集 = {双刀增,绳镖增,势,精准率,会心率}',
  sameSet(lw.freeSet, ['双刀武学增伤', '绳镖武学增伤', '势', '精准率', '会心率']));
check('大外流·左武器：大外 min=2 max=2', lw.affixInfo['最大外功攻击']?.min === 2 && lw.affixInfo['最大外功攻击']?.max === 2);
check('大外流·左武器：双刀增 min=0 max=1（可左可右，排列自由）',
  lw.affixInfo['双刀武学增伤']?.min === 0 && lw.affixInfo['双刀武学增伤']?.max === 1);
check('大外流·左武器：绳镖增同样 min=0 max=1（左武器可以是绳镖）',
  lw.affixInfo['绳镖武学增伤']?.min === 0 && lw.affixInfo['绳镖武学增伤']?.max === 1);

const rw = daWaiRx.mergedSlots['右武器'];
check('大外流·右武器：与左武器同构（初始大外+劲+指定增组）',
  rw.initialForced === '最大外功攻击' && req(rw, '最大外功攻击')?.count === 2
  && req(rw, '劲')?.count === 1 && group(rw)?.count === 1);

const huan = daWaiRx.mergedSlots['环'];
check('大外流·环：初始强制=大外，必备含全武×1',
  huan.initialForced === '最大外功攻击' && req(huan, '全武学增伤')?.count === 1);
check('大外流·环：大外 min=2（初始+调律都锁死）', huan.affixInfo['最大外功攻击']?.min === 2);

const gz = daWaiRx.mergedSlots['冠胄'];
check('大外流·冠胄：初始位无强制（精准/会心自由）', gz.initialForced === null);
check('大外流·冠胄：必备 = {大外×1, 劲×1}（无指定增组——非武器槽）',
  req(gz, '最大外功攻击')?.count === 1 && req(gz, '劲')?.count === 1 && group(gz) === undefined);
check('大外流·冠胄：自由集 = {精准率,会心率,势}（会意/气血/外防无需求→无效）',
  sameSet(gz.freeSet, ['精准率', '会心率', '势']));
check('大外流·冠胄：大无相无需求→无效', gz.affixInfo['最大无相攻击'] === undefined);

const jing = daWaiRx.mergedSlots['胫甲'];
check('大外流·胫甲：初始强制=劲（10劲锁死的推论）', jing.initialForced === '劲');
check('大外流·胫甲：必备 = {大外×1, 劲×2, 首领增×1}',
  req(jing, '最大外功攻击')?.count === 1 && req(jing, '劲')?.count === 2 && req(jing, '对首领单位增伤')?.count === 1);

// ———— 2. 小外流推导 ————

const xiaoWaiRx = derivePrescription(affixes, xiaoWai, WT);
check('小外流：推导可行且无错误', xiaoWaiRx.feasible === true && xiaoWaiRx.errors.length === 0);

const xlw = xiaoWaiRx.mergedSlots['左武器'];
check('小外流·左武器：初始强制=最小外功攻击', xlw.initialForced === '最小外功攻击');
check('小外流·左武器：必备 = {小外×2, 敏×1, 大无相×1, 指定增组×1}——整表唯一（仅武器类型可换）',
  req(xlw, '最小外功攻击')?.count === 2 && req(xlw, '敏')?.count === 1
  && req(xlw, '最大无相攻击')?.count === 1 && group(xlw)?.count === 1);
check('小外流·左武器：大无相 min=1（初始位被小外锁死后只能走双武器调律）',
  xlw.affixInfo['最大无相攻击']?.min === 1 && xlw.affixInfo['最大无相攻击']?.max === 1);
check('小外流·左武器：劲/大外无需求→无效', xlw.affixInfo['劲'] === undefined && xlw.affixInfo['最大外功攻击'] === undefined);

const xj = xiaoWaiRx.mergedSlots['胫甲'];
check('小外流·胫甲：初始位无强制（劲无需求）', xj.initialForced === null);
check('小外流·胫甲：必备含大破竹×1', req(xj, '最大破竹攻击')?.count === 1);
const xgz = xiaoWaiRx.mergedSlots['冠胄'];
check('小外流·冠胄：必备含大破竹×1与敏×1；大无相出池（只能出在武器）',
  req(xgz, '最大破竹攻击')?.count === 1 && req(xgz, '敏')?.count === 1
  && xgz.affixInfo['最大无相攻击']?.max === 0);

// ———— 3. 校验与报错 ————

const tooMany = clone(daWai);
tooMany.quota.lines.find(l => l.any_of[0] === '最大外功攻击').count = 13;
tooMany.quota.lines.find(l => l.any_of[0] === '势').count = 1;   // 保持总和 40
const infeasibleRx = derivePrescription(affixes, tooMany, WT);
check('不可行配额：13 大外超出供应（总和仍 40）→ 可行=false 且报错',
  infeasibleRx.feasible === false && infeasibleRx.errors.some(e => e.includes('不可行')));

const badTotal = clone(daWai);
badTotal.quota.lines.find(l => l.any_of[0] === '最大外功攻击').count = 11;
check('配额总和≠40 → 报错', derivePrescription(affixes, badTotal, WT).errors.some(e => e.includes('40')));

const unknownAffix = clone(daWai);
unknownAffix.quota.lines.find(l => l.any_of[0] === '会心率').any_of = ['会心大星'];
check('配额词条不在任何池中 → 报错（防模板抄错）',
  derivePrescription(affixes, unknownAffix, WT).errors.some(e => e.includes('会心大星')));

check('缺武器类型但配额含指定增 → 报错',
  derivePrescription(affixes, daWai, []).errors.some(e => e.includes('武器类型')));

// ———— 4. 别名整流等价 ————

const aliasFlow = clone(daWai);
aliasFlow.quota = { lines: [
  { any_of: ['大外'], count: 12 },
  { any_of: ['双刀武学增伤'], count: 1 },
  { any_of: ['绳镖武学增伤'], count: 1 },
  { any_of: ['全武'], count: 2 },
  { any_of: ['首领增'], count: 2 },
  { any_of: ['精准'], count: 2 },
  { any_of: ['会心'], count: 8 },
  { any_of: ['劲'], count: 10 },
  { any_of: ['势'], count: 2 },
] };
const aliasRx = derivePrescription(affixes, aliasFlow, WT);
check('别名流：可行且左武器推导与标准写法一致',
  aliasRx.feasible === true
  && aliasRx.mergedSlots['左武器'].initialForced === lw.initialForced
  && sameSet(aliasRx.mergedSlots['左武器'].freeSet, lw.freeSet));

// ———— 5. verifyItemFits 精确复核（按排列取或） ————

check('复核：大外流毕业剑（双刀增在左）→ 全局可补齐',
  verifyItemFits(daWaiRx, '左武器', { initial: '最大外功攻击', tunings: ['最大外功攻击', '劲', '双刀武学增伤', '会心率'] }) === true);
check('复核：绳镖增放左武器（左武器是绳镖）→ 合法且可补齐',
  verifyItemFits(daWaiRx, '左武器', { initial: '最大外功攻击', tunings: ['最大外功攻击', '劲', '绳镖武学增伤', '会心率'] }) === true);
check('复核：大外流毕业环 → 全局可补齐',
  verifyItemFits(daWaiRx, '环', { initial: '最大外功攻击', tunings: ['最大外功攻击', '全武学增伤', '劲', '精准率'] }) === true);
check('复核：大外流毕业胫甲 → 全局可补齐',
  verifyItemFits(daWaiRx, '胫甲', { initial: '劲', tunings: ['最大外功攻击', '劲', '对首领单位增伤', '会心率'] }) === true);
check('复核：小外流毕业剑 → 全局可补齐',
  verifyItemFits(xiaoWaiRx, '左武器', { initial: '最小外功攻击', tunings: ['最小外功攻击', '双刀武学增伤', '敏', '最大无相攻击'] }) === true);

// ———— 汇总 ————

console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
