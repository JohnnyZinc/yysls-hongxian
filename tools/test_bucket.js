'use strict';

/**
 * test_bucket.js — 武器桶模型（评价系统设计.md §12）
 *
 * 背景：下个版本将上线「鸣金霆 = 两把枪」。旧代码把「武器类型」当装备身份（单射），
 * 双枪变多射后会出现：两把枪被当成同一件 → 替换时两把一起被删（实测件数 2→1、结论反向）。
 *
 * 覆盖：
 *   1. 双枪流派可推导；两槽 required 相同 ⇒ 槽位等价 = true；
 *   2. 双类型流派（剑+枪）⇒ 槽位等价 = false（不同类型，各自独立，桶语义不适用）；
 *   3. 桶内两件时换第三把：件数保持 2（不再一次删两把），替换目标 = ΔDPS 最优的那把；
 *   4. 新件比两把都差 ⇒ verdict 更差、仍不删件；
 *   5. targetIndex / gearAfter 与实际替换一致。
 *
 * 说明：DPS 数值本身无意义（借破竹风 build 跑面板），只用于比较方向与替换目标。
 */

import fs from 'node:fs';
import { loadBuild } from './load-build.js';
import { derivePrescription, solveAssignment } from '../engine/quota.js';
import { loadVersionData } from './load-version.js';
import { evaluateSwap, sameEquipKey } from '../engine/swap.js';

const { version, affixes } = loadVersionData();

/** 合成「双枪流派」：剑增(1) → 枪增(2)，大外 12→11，保持 40 槽 */
const baseFlow = JSON.parse(fs.readFileSync('data/template/mingjinhong/mingjinhong.dawai.json', 'utf-8'));
const dualFlow = {
  ...baseFlow,
  flowId: 'dawai',
  quota: {
    lines: baseFlow.quota.lines.map((l) => {
      if (l.any_of[0] === '剑武学增伤') return { any_of: ['枪武学增伤'], count: 2 };
      if (l.any_of[0] === '最大外功攻击') return { ...l, count: 11 };
      return l;
    }),
  },
};
const rxDual = derivePrescription(affixes, dualFlow, ['枪', '枪']);
const rxNormal = derivePrescription(affixes, baseFlow, ['剑', '枪']);

const buildCtx = loadBuild('pozhufeng.115.3.2');
const selections = {
  装备套装: buildCtx.build.selectors.set,
  武库: buildCtx.build.selectors.weapon_attribute,
};

let pass = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('✓', name); } else { failures.push(name); console.log('✗', name); }
};

const reqSig = (s) => JSON.stringify((s?.required || []).map((r) => ({ a: r.affix, c: r.count })));

// —— 1. 双枪流派推导 ——
console.log('— 1. 双枪流派：配额推导 —');
check('1.1 双枪配额可行', rxDual.feasible === true);
check('1.2 两槽都绑定「枪」',
  rxDual.weaponTypes['武器1'] === '枪' && rxDual.weaponTypes['武器2'] === '枪');
{
  const arr = rxDual.arrangements[0];
  check('1.3 两槽 required 完全相同', reqSig(arr.slots['武器1']) === reqSig(arr.slots['武器2']));
  check('1.4 槽位等价 = true（桶内无序）', rxDual.槽位等价 === true);
  check('1.5 两槽都能出「枪武学增伤」',
    arr.slots['武器1'].tuningPool.includes('枪武学增伤') && arr.slots['武器2'].tuningPool.includes('枪武学增伤'));
}
check('1.6 双类型流派（剑+枪）槽位等价 = false', rxNormal.槽位等价 === false);

// —— 构造一套双枪装备（真实形状：slot 恒为「武器」，武器1/2 是存储位）——
// 词条数值取承音值（≈max×94%），与生产口径一致；缺区间表的增伤类用现实量级近似
const FALLBACK = { 枪武学增伤: 0.1, 双刀武学增伤: 0.1, 绳镖武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
const V = (n) => {
  const r = affixes.词条区间[n];
  return r ? (r.承音 ?? r.max) : (FALLBACK[n] ?? 0);
};
function buildGear(rx) {
  const units = solveAssignment(rx._base.arrangementSpecs[0].spec, rx._base.lineOf);
  const bySlot = {};
  for (const u of units) (bySlot[u.slot] ||= []).push(u.affix);
  return Object.entries(bySlot).map(([key, list]) => ({
    slot: key.startsWith('武器') ? '武器' : key,
    slotKey: key,
    weaponType: rx.slotTypes?.[key] || '',
    uid: `p_${key}`,
    初始: { 属性: list[0], 数值: V(list[0]) },
    调律: list.slice(1).map((a) => ({ 属性: a, 数值: V(a) })),
  }));
}
const gear = buildGear(rxDual);
const swordOf = (g) => g.filter((x) => x.slotKey === '武器1')[0];
const gun2Of = (g) => g.filter((x) => x.slotKey === '武器2')[0];

/**
 * 造一把"更差"的枪：把一条**影响 DPS** 的有效词条换成废词条「体」。
 * 注意不能拿「枪武学增伤」开刀——破竹风 build 的乘区不含枪增伤，改了 DPS 也不动（分不出高下）。
 */
function degrade(piece) {
  const p = JSON.parse(JSON.stringify(piece));
  const at = (name) => p.调律.findIndex((t) => t.属性 === name);
  const i = at('会意率') >= 0 ? at('会意率') : at('枪武学增伤');
  if (i >= 0) { p.调律[i].属性 = '体'; p.调律[i].数值 = V('体'); }
  return p;
}

// —— 2. 同一性的局限（保留现状，但不再用于挑选替换目标）——
console.log('\n— 2. sameEquipKey 对两把枪返回 true（因此不能再用来找替换目标）—');
check('2.1 sameEquipKey(两把枪) = true', sameEquipKey(swordOf(gear), gun2Of(gear)) === true);

// —— 3. 桶内两件时换第三把 ——
console.log('\n— 3. 双枪已满，换第三把 —');
{
  // 把武器2 改差：会意率 → 体（体不在武器有效集 ⇒ k=1 ⇒ 玄，且 DPS 下降）
  const worse2 = degrade(gun2Of(gear));
  const round = gear.map((g) => (g.slotKey === '武器2' ? worse2 : g));

  // 新枪与武器1 结构相同（等价），因此替换武器2 的 ΔDPS 更大
  const newItem = JSON.parse(JSON.stringify(swordOf(round)));
  newItem.uid = 'new_gun';

  const r = evaluateSwap({
    buildCtx, version, affixes, selections,
    currentGear: round, newItem, prescription: rxDual,
  });
  check('3.1 对比可用', r.ok === true);
  check('3.2 替换后仍是 2 把枪（旧实现会掉到 1 把）', r.gearAfter.length === round.length);
  check('3.3 武器1 那把仍在（未被误删）',
    r.gearAfter.some((g) => g.uid === `p_武器1`));
  check('3.4 被替换的是较差的那把（武器2）',
    r.targetIndex === round.findIndex((g) => g.slotKey === '武器2'));
  check('3.5 targetSlotKey 指向武器2', r.targetSlotKey === '武器2');
  check('3.6 结论为更好', r.verdict === '更好');
}

// —— 4. 新件比两把都差 ——
console.log('\n— 4. 新枪比两把都差 —');
{
  const bad = degrade(swordOf(gear));
  bad.uid = 'bad_gun';

  const r = evaluateSwap({
    buildCtx, version, affixes, selections,
    currentGear: gear, newItem: bad, prescription: rxDual,
  });
  check('4.1 对比可用', r.ok === true);
  check('4.2 结论为更差', r.verdict === '更差');
  check('4.3 仍保持 2 把枪', r.gearAfter.length === gear.length);
  check('4.4 replacedOld 为真（有基准可比）', r.replacedOld === true);
}

// —— 5. 单类型流派回归：一把枪不能进剑槽 ——
console.log('\n— 5. 双类型流派不受影响 —');
{
  const g = buildGear(rxNormal);
  const sword = g.find((x) => x.slotKey === '武器1'); // 剑
  const gun = g.find((x) => x.slotKey === '武器2');   // 枪
  check('5.1 剑与枪不同一', sameEquipKey(sword, gun) === false);
  const r = evaluateSwap({
    buildCtx, version, affixes, selections,
    currentGear: g, newItem: { ...gun, uid: 'new_gun2' }, prescription: rxNormal,
  });
  check('5.2 换枪不影响剑（件数不变）', r.ok && r.gearAfter.length === g.length);
  check('5.3 被替换的是枪位', r.targetSlotKey === '武器2');
}

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗', f);
  process.exitCode = 1;
}
