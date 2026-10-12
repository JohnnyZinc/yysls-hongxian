'use strict';

/**
 * test_quota.js — 配额推导器验证
 *
 * 基准：评价系统设计.md §3.1 的破竹风·大外流供应分析（手算结论）：
 *   - 12 大外供应恰好 12 → 全锁死（双武器初始必须大外）；
 *   - 10 劲供应恰好 10 → 全锁死（胫腕初始必须劲）；
 *   - 神力 6 条全锁死（双刀/绳镖=武器调律 pin、全武=环佩调律、首领=胫腕调律）；
 *   - 剩余 12 自由槽（冠胸初始 2 + 调律自由 10）恰填 2精准+8会心+2势；
 *   - 小外流：12 小外锁死、大破竹 6=6 锁死（只能出在防具+环佩调律）、
 *     大无相只能出在武器、劲/势无需求（结构无效）。
 * 另含：不可行配额报错、pin 校验、别名归一、verifyItemFits 精确复核。
 */

import fs from 'node:fs';
import { derivePrescription, loadSlotModel, canonicalAffix, verifyItemFits } from '../engine/quota.js';

const affixes = JSON.parse(fs.readFileSync('data/version/affixes-115.json', 'utf-8'));
const flowsDoc = JSON.parse(fs.readFileSync('data/template/pozhufeng.flows.json', 'utf-8'));
const daWai = flowsDoc.flows.find(f => f.flowId === 'daWai');
const xiaoWai = flowsDoc.flows.find(f => f.flowId === 'xiaoWai');

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
}
const clone = o => JSON.parse(JSON.stringify(o));
const sameSet = (a, b) => [...a].sort().join('|') === [...b].sort().join('|');
const req = (rx, affix) => rx.required.find(r => r.affix === affix);

// ———— 0. 别名与模型 ————

check('别名：大外→最大外功攻击', canonicalAffix('大外') === '最大外功攻击');
check('别名：全武学增效→全武学增伤', canonicalAffix('全武学增效') === '全武学增伤');
check('别名：会心→会心率', canonicalAffix('会心') === '会心率');
const model = loadSlotModel(affixes);
check('模型：武器调律池展开指定武学增伤（含双刀/剑）',
  model['左武器'].tuningPool.includes('双刀武学增伤') && model['左武器'].tuningPool.includes('剑武学增伤'));
check('模型：转律池不含神力与精准率',
  !model['左武器'].conversionPool.includes('全武学增伤') && !model['左武器'].conversionPool.includes('精准率'));

// ———— 1. 大外流推导 ————

const daWaiRx = derivePrescription(affixes, daWai);
check('大外流：推导可行且无错误', daWaiRx.feasible === true && daWaiRx.errors.length === 0);
check('大外流：结果自描述（buildId/flowId）', daWaiRx.buildId === 'pozhufeng.115.3.2' && daWaiRx.flowId === 'daWai');

const lw = daWaiRx.slots['左武器'];
check('大外流·左武器：初始强制=最大外功攻击（12大外锁死的推论）', lw.initialForced === '最大外功攻击');
check('大外流·左武器：必备 大外×2（1初始+1调律）', req(lw, '最大外功攻击')?.count === 2);
check('大外流·左武器：必备 劲×1', req(lw, '劲')?.count === 1);
check('大外流·左武器：必备 双刀增×1（pin）', req(lw, '双刀武学增伤')?.count === 1);
check('大外流·左武器：自由集 = {势,精准率,会心率}', sameSet(lw.freeSet, ['势', '精准率', '会心率']));
check('大外流·左武器：大外 min=2 max=2', lw.affixInfo['最大外功攻击']?.min === 2 && lw.affixInfo['最大外功攻击']?.max === 2);
check('大外流·左武器：被钉走的绳镖增无效（武器类型锁定假设生效）', lw.affixInfo['绳镖武学增伤'] === undefined);

const rw = daWaiRx.slots['右武器'];
check('大外流·右武器：初始强制=大外，必备含绳镖增×1',
  rw.initialForced === '最大外功攻击' && req(rw, '绳镖武学增伤')?.count === 1);
check('大外流·右武器：被钉走的双刀增无效', rw.affixInfo['双刀武学增伤'] === undefined);

const huan = daWaiRx.slots['环'];
check('大外流·环：初始强制=大外，必备含全武×1',
  huan.initialForced === '最大外功攻击' && req(huan, '全武学增伤')?.count === 1);
check('大外流·环：大外 min=2（初始+调律都锁死）', huan.affixInfo['最大外功攻击']?.min === 2);

const gz = daWaiRx.slots['冠胄'];
check('大外流·冠胄：初始位无强制（精准/会心自由）', gz.initialForced === null);
check('大外流·冠胄：必备 = {大外×1, 劲×1}', req(gz, '最大外功攻击')?.count === 1 && req(gz, '劲')?.count === 1);
check('大外流·冠胄：自由集 = {精准率,会心率,势}（会意/气血/外防无需求→无效）',
  sameSet(gz.freeSet, ['精准率', '会心率', '势']));
check('大外流·冠胄：大无相无需求→无效', gz.affixInfo['最大无相攻击'] === undefined);

const jing = daWaiRx.slots['胫甲'];
check('大外流·胫甲：初始强制=劲（10劲锁死的推论）', jing.initialForced === '劲');
check('大外流·胫甲：必备 = {大外×1, 劲×2, 首领增×1}',
  req(jing, '最大外功攻击')?.count === 1 && req(jing, '劲')?.count === 2 && req(jing, '对首领单位增伤')?.count === 1);
check('大外流·胫甲：自由集 = {精准率,会心率,势}', sameSet(jing.freeSet, ['精准率', '会心率', '势']));

// ———— 2. 小外流推导 ————

const xiaoWaiRx = derivePrescription(affixes, xiaoWai);
check('小外流：推导可行且无错误', xiaoWaiRx.feasible === true && xiaoWaiRx.errors.length === 0);

const xlw = xiaoWaiRx.slots['左武器'];
check('小外流·左武器：初始强制=最小外功攻击', xlw.initialForced === '最小外功攻击');
check('小外流·左武器：必备 = {小外×2, 双刀增×1}',
  req(xlw, '最小外功攻击')?.count === 2 && req(xlw, '双刀武学增伤')?.count === 1);
check('小外流·左武器：必备含敏×1（8敏须分布8个部位）与大无相×1（初始位被小外锁死后只能走双武器调律）',
  req(xlw, '敏')?.count === 1 && req(xlw, '最大无相攻击')?.count === 1);
check('小外流·左武器：大无相 min=1 max=1', xlw.affixInfo['最大无相攻击']?.min === 1 && xlw.affixInfo['最大无相攻击']?.max === 1);
check('小外流·左武器：自由集为空（配额恰好卡满，左武器整表唯一）', xlw.freeSet.length === 0);
check('小外流·左武器：大外无需求→无效', xlw.affixInfo['最大外功攻击'] === undefined);

const xj = xiaoWaiRx.slots['胫甲'];
check('小外流·胫甲：初始位无强制（劲无需求，初始可在精准/会心中自由）', xj.initialForced === null);
check('小外流·胫甲：必备含大破竹×1', req(xj, '最大破竹攻击')?.count === 1);
const xgz = xiaoWaiRx.slots['冠胄'];
check('小外流·冠胄：必备含大破竹×1与敏×1；大无相无效（只能出在武器）',
  req(xgz, '最大破竹攻击')?.count === 1 && req(xgz, '敏')?.count === 1 && xgz.affixInfo['最大无相攻击'] === undefined);

// ———— 3. 校验与报错 ————

const tooMany = clone(daWai);
tooMany.flowId = 'infeasible-test';
tooMany.quota.lines.find(l => l.any_of[0] === '最大外功攻击').count = 13;
tooMany.quota.lines.find(l => l.any_of[0] === '势').count = 1;   // 保持总和 40
const infeasibleRx = derivePrescription(affixes, tooMany);
check('不可行配额：13 大外超出供应（总和仍 40）→ 可行=false 且报错',
  infeasibleRx.feasible === false && infeasibleRx.errors.some(e => e.includes('不可行')));

const badTotal = clone(daWai);
badTotal.quota.lines.find(l => l.any_of[0] === '最大外功攻击').count = 11;
const totalRx = derivePrescription(affixes, badTotal);
check('配额总和≠40 → 报错', totalRx.feasible === false && totalRx.errors.some(e => e.includes('40')));

const badPin = clone(daWai);
badPin.pins = [{ slot: '环', affix: '双刀武学增伤', position: 'tuning', count: 1 }];
const pinRx = derivePrescription(affixes, badPin);
check('pin 落在不含该词条的池（环×双刀增）→ 报错', pinRx.feasible === false && pinRx.errors.some(e => e.includes('pin')));

const unknownAffix = clone(daWai);
unknownAffix.quota.lines.find(l => l.any_of[0] === '会心率').any_of = ['会心大星'];
const unknownRx = derivePrescription(affixes, unknownAffix);
check('配额词条不在任何池中 → 报错（防模板抄错）', unknownRx.feasible === false && unknownRx.errors.some(e => e.includes('会心大星')));

// ———— 4. 别名整流等价 ————

const aliasFlow = clone(daWai);
aliasFlow.flowId = 'alias-test';
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
const aliasRx = derivePrescription(affixes, aliasFlow);
check('别名流：可行', aliasRx.feasible === true);
check('别名流：左武器推导结果与标准写法一致',
  aliasRx.slots['左武器'].initialForced === daWaiRx.slots['左武器'].initialForced
  && sameSet(aliasRx.slots['左武器'].freeSet, daWaiRx.slots['左武器'].freeSet)
  && aliasRx.slots['左武器'].required.every(r => req(daWaiRx.slots['左武器'], r.affix)?.count === r.count));

// ———— 5. verifyItemFits 精确复核 ————

check('复核：大外流毕业剑（初始+调律齐）→ 全局可补齐',
  verifyItemFits(daWaiRx, '左武器', { initial: '最大外功攻击', tunings: ['最大外功攻击', '劲', '双刀武学增伤', '会心率'] }) === true);
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
