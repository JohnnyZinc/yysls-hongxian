'use strict';

/**
 * test_advisor.js — 系统①匹配度验证
 *
 * 基准一：评价系统设计.md §4.2 的十个用例（鸣金虹剑，用户提供实例整理）：
 *   剑的毕业模板 = 必备 2大外[1初始] + 1剑增；自由 = 势/会意率/劲/大无相。
 * 基准二：破竹风·大外流真实推导结果上的评价用例（含 verifyItemFits 精确复核）。
 */

import fs from 'node:fs';
import { derivePrescription, loadSlotModel } from '../engine/quota.js';
import { gradeItem } from '../engine/advisor.js';

const affixes = JSON.parse(fs.readFileSync('data/version/affixes-115.json', 'utf-8'));
const flowsDoc = JSON.parse(fs.readFileSync('data/template/pozhufeng.flows.json', 'utf-8'));
const daWai = flowsDoc.flows.find(f => f.flowId === 'daWai');

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
}
const it = (initial, tunings) => ({ initial, tunings });

// ———— 基准一：鸣金虹剑十例（合成配额，算法与流派无关） ————

const weapon = loadSlotModel(affixes)['左武器'];
const swordRx = {
  buildId: '鸣金虹-示例',
  flowId: 'sword-test',
  flowName: '剑模板测试',
  slots: {
    左武器: {
      initialForced: '最大外功攻击',
      required: [
        { affix: '最大外功攻击', count: 2, source: 'derived' },
        { affix: '剑武学增伤', count: 1, source: 'pinned' },
      ],
      freeSet: ['势', '会意率', '劲', '最大无相攻击'],
      affixInfo: {
        最大外功攻击: { min: 2, max: 2 },
        剑武学增伤: { min: 1, max: 1 },
        势: { min: 0, max: 1 },
        会意率: { min: 0, max: 1 },
        劲: { min: 0, max: 1 },
        最大无相攻击: { min: 0, max: 1 },
      },
      initialPool: weapon.initialPool,
      tuningPool: weapon.tuningPool,
      conversionPool: weapon.conversionPool,
    },
  },
};
const g = item => gradeItem(swordRx, '左武器', item);

// 用例1：[初始=大外；调律=大外,剑增,势,劲] → 天
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '剑武学增伤', '势', '劲']));
  check('剑例1：全对齐 → 天', r.tier === '天' && r.k === 0 && r.m === 0 && r.needsConversion === false);
}
// 用例2：[初始=大外；调律=大外,剑增,势,会意] → 天
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '剑武学增伤', '势', '会意率']));
  check('剑例2：全对齐（自由项换会意）→ 天', r.tier === '天' && r.needsConversion === false);
}
// 用例3a：[初始=大外；调律=剑增,势,劲,会意] → 天·需转律（自由项转成缺失的大外）
{
  const r = g(it('最大外功攻击', ['剑武学增伤', '势', '劲', '会意率']));
  check('剑例3a：缺1大外但可转律补齐 → 天·需1次转律',
    r.tier === '天' && r.substate === '天·需1次转律'
    && r.conversion?.to === '最大外功攻击' && r.globalFitVerified === null);
}
// 用例3b：[初始=势；调律=大外,剑增,劲,会意] → 地（初始≠大外，2大外永久凑不齐）
{
  const r = g(it('势', ['最大外功攻击', '剑武学增伤', '劲', '会意率']));
  check('剑例3b：初始≠大外卡死 → 地（转律救不回）',
    r.tier === '地' && r.k === 0 && r.m > 0 && r.needsConversion === false);
}
// 用例4：[初始=大外；调律=大外,势,会意,劲] → 地（缺剑增，神力转不进来）
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '势', '会意率', '劲']));
  check('剑例4：缺剑增（神力不可转得）→ 地',
    r.tier === '地' && r.missing.some(x => x.affix === '剑武学增伤'));
}
// 用例5：[初始=大外；调律=大外,剑增,势,敏] → 天·需转律（敏→自由项）
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '剑武学增伤', '势', '敏']));
  check('剑例5：敏(调律)可转 → 天·需1次转律',
    r.tier === '天' && r.needsConversion === true && r.conversion?.from === '敏'
    && swordRx.slots['左武器'].freeSet.includes(r.conversion.to));
}
// 用例6：[初始=敏；调律=大外,剑增,势,劲] → 玄（初始无效救不回）
{
  const r = g(it('敏', ['最大外功攻击', '剑武学增伤', '势', '劲']));
  check('剑例6：初始位无效 → 玄', r.tier === '玄' && r.k === 1
    && r.notes.some(n => n.includes('初始')));
}
// 用例7a：[初始=最小外功；调律=大外,剑增,势,劲] → 玄
{
  const r = g(it('最小外功攻击', ['最大外功攻击', '剑武学增伤', '势', '劲']));
  check('剑例7a：初始=最小外功（无效且不可转）→ 玄', r.tier === '玄' && r.k === 1);
}
// 用例7b：[初始=大外；调律=大外,剑增,势,最小外功] → 天·需转律（小外→劲）
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '剑武学增伤', '势', '最小外功攻击']));
  check('剑例7b：调律位小外可转 → 天·需1次转律',
    r.tier === '天' && r.needsConversion === true && r.conversion?.from === '最小外功攻击');
}
// 用例8：[初始=敏；调律=小外,气血,势,劲] → 黄（转律后仍剩2条无效）
{
  const r = g(it('敏', ['最小外功攻击', '气血最大值', '势', '劲']));
  check('剑例8：三条无效转剩两条 → 黄', r.tier === '黄' && r.k === 2);
}
// 补充：无效词条是神力时，最优转律会转掉神力 → 警示"转掉永久损失"
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '剑武学增伤', '全武学增伤', '势']));
  check('剑补充：转掉神力词条触发永久损失警示',
    r.tier === '天' && r.conversion?.from === '全武学增伤' && r.warnings.some(w => w.includes('神力')));
}
// 补充：调律重复 → 拒绝评价
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '最大外功攻击', '势', '劲']));
  check('剑补充：调律词条重复 → 拒绝评价', r.ok === false);
}
// 补充：调律不足 4 条 → 拒绝评价
{
  const r = g(it('最大外功攻击', ['最大外功攻击', '剑武学增伤', '势']));
  check('剑补充：调律不足4条 → 拒绝评价', r.ok === false);
}

// ———— 基准二：破竹风·大外流真实推导上的评价 ————

const daWaiRx = derivePrescription(affixes, daWai);
const gp = (slot, item) => gradeItem(daWaiRx, slot, item);

{
  const r = gp('左武器', it('最大外功攻击', ['最大外功攻击', '劲', '双刀武学增伤', '会心率']));
  check('破竹风·毕业剑 → 天，全局复核通过',
    r.tier === '天' && r.needsConversion === false && r.globalFitVerified === true);
}
{
  const r = gp('左武器', it('最大外功攻击', ['最大外功攻击', '劲', '势', '精准率']));
  check('破竹风·缺双刀增的剑 → 地（缺必备但神力转不进来）',
    r.tier === '地' && r.k === 0 && r.m === 1 && r.missing.some(x => x.affix === '双刀武学增伤'));
}
{
  const r = gp('左武器', it('最大外功攻击', ['最大外功攻击', '劲', '双刀武学增伤', '敏']));
  check('破竹风·调律敏可转 → 天·需1次转律，转后全局复核通过',
    r.tier === '天' && r.substate === '天·需1次转律'
    && r.conversion?.from === '敏' && r.globalFitVerified === true);
}
{
  const r = gp('左武器', it('敏', ['最大外功攻击', '劲', '双刀武学增伤', '势']));
  check('破竹风·初始敏 → 玄', r.tier === '玄' && r.k === 1);
}
{
  const r = gp('环', it('最大外功攻击', ['最大外功攻击', '全武学增伤', '劲', '会心率']));
  check('破竹风·毕业环 → 天，全局复核通过', r.tier === '天' && r.globalFitVerified === true);
}
{
  const r = gp('环', it('最大外功攻击', ['最大外功攻击', '劲', '精准率', '会心率']));
  check('破竹风·缺全武的环 → 地', r.tier === '地' && r.missing.some(x => x.affix === '全武学增伤'));
}
{
  const r = gp('胫甲', it('劲', ['最大外功攻击', '劲', '对首领单位增伤', '精准率']));
  check('破竹风·毕业胫甲（初始劲+调律劲）→ 天，全局复核通过',
    r.tier === '天' && r.globalFitVerified === true);
}
{
  const r = gp('胫甲', it('精准率', ['最大外功攻击', '劲', '对首领单位增伤', '会心率']));
  check('破竹风·初始非劲的胫甲 → 地（初始位卡死+缺1劲）',
    r.tier === '地' && r.m === 2);
}
{
  const r = gp('冠胄', it('精准率', ['最大外功攻击', '劲', '会心率', '气血最大值']));
  check('破竹风·冠胄带气血 → 天·需转律（气血→势，势是该部位唯一可达自由项）',
    r.tier === '天' && r.substate === '天·需1次转律'
    && r.conversion?.from === '气血最大值' && r.conversion?.to === '势'
    && r.globalFitVerified === true);
}
{
  const r = gp('冠胄', it('精准率', ['最大外功攻击', '劲', '气血最大值', '外功防御']));
  check('破竹风·冠胄两条无需求词条 → 玄（转律救1条仍剩1条，且会心率已被占用）',
    r.tier === '玄' && r.k === 1);
}
// 结果自描述
{
  const r = gp('左武器', it('最大外功攻击', ['最大外功攻击', '劲', '双刀武学增伤', '会心率']));
  check('结果自描述：含 buildId/flowId/口径',
    r.buildId === 'pozhufeng.115.3.2' && r.flowId === 'daWai' && typeof r.口径 === 'string');
}

// ———— 汇总 ————

console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
