'use strict';

/**
 * test_search.js — 全局组合搜索（engine/search.js，评价系统设计.md §11.8）
 *
 * 覆盖：
 *   1. 候选池只有当前那套 ⇒ 已最优（status=optimal，无换件）；
 *   2. 池里多一件更好的同部位 ⇒ improved，且 swapIn 精确指向那一件；
 *   3. 部位空着 ⇒ 补空位；
 *   4. 双枪流派：同一件装备不能同时占两个枪位（按 uid 去重）；
 *   5. 判据是「配额优先」：配额不劣于当前才值得比 DPS。
 */

import fs from 'node:fs';
import { loadBuild } from './load-build.js';
import { derivePrescription, solveAssignment } from '../engine/quota.js';
import { loadVersionData } from './load-version.js';
import { searchBestComposition } from '../engine/search.js';

const { version, affixes } = loadVersionData();
const flow = { ...JSON.parse(fs.readFileSync('data/template/pozhufeng/pozhufeng.dawai.json', 'utf-8')), flowId: 'dawai' };
const rx = derivePrescription(affixes, flow, ['双刀', '绳镖']);
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

const FALLBACK = { 双刀武学增伤: 0.1, 绳镖武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
const V = (n) => {
  const r = affixes.词条区间[n];
  return r ? (r.承音 ?? r.max) : (FALLBACK[n] ?? 0);
};
const mk = (slot, initial, tunings, uid) => ({
  slot, uid,
  weaponType: slot === '武器' ? '双刀' : undefined,
  初始: { 属性: initial, 数值: V(initial) },
  调律: tunings.map((a) => ({ 属性: a, 数值: V(a) })),
});

/** 用毕业分配造一套 8 件 */
function graduate() {
  const units = solveAssignment(rx._base.arrangementSpecs[0].spec, rx._base.lineOf);
  const bySlot = {};
  for (const u of units) (bySlot[u.slot] ||= []).push(u.affix);
  return Object.entries(bySlot).map(([key, list]) => ({
    slot: key.startsWith('武器') ? '武器' : key,
    slotKey: key,
    weaponType: rx.slotTypes?.[key] || undefined,
    uid: `g_${key}`,
    初始: { 属性: list[0], 数值: V(list[0]) },
    调律: list.slice(1).map((a) => ({ 属性: a, 数值: V(a) })),
  }));
}

const SEARCH = (pool, currentGear, extra = {}) => searchBestComposition({
  buildCtx, version, affixes, selections,
  prescription: rx, flow, pool, currentGear,
  deadZone: 0.005, ...extra,
});

const g8 = graduate();

// —— 1. 池子里只有当前这套 → 已最优 ——
console.log('— 1. 候选池 = 当前这套 → 已最优 —');
{
  const r = SEARCH(g8, g8);
  check('1.1 搜索可用', r.ok === true);
  check('1.2 status = optimal', r.status === 'optimal');
  check('1.3 无换件', r.swapIn.length === 0);
  check('1.4 Δ ≈ 0', Math.abs(r.deltaPct) < 1e-9);
  check('1.5 未触发截断', r.truncated === false);
}

// —— 2. 当前组合有一件退化件，池里留着好的 → improved ——
console.log('\n— 2. 池里有更好的同部位 → improved —');
{
  const goodShin = g8.find((g) => g.slot === '胫甲');
  // 把当前穿的胫甲改差（会心率 → 体）：口径上多出缺口，DPS 也降
  const badShin = JSON.parse(JSON.stringify(goodShin));
  badShin.uid = 'bad_shin';
  const i = badShin.调律.findIndex((t) => t.属性 === '会心率');
  badShin.调律[i] = { 属性: '体', 数值: V('体') };
  const cur = g8.map((g) => (g.slot === '胫甲' ? badShin : g));

  const r = SEARCH([...cur, goodShin], cur);
  check('2.1 status = improved', r.status === 'improved');
  check('2.2 换件里有那件好胫甲', r.swapIn.some((s) => s.piece?.uid === goodShin.uid));
  check('2.3 换件数量为 1（其余保持）', r.swapIn.length === 1);
  check('2.4 DPS 提升为正', r.deltaPct > 0);
  check('2.5 结果里不含重复 uid', new Set(r.bestGear.map((g) => g.uid)).size === r.bestGear.length);
  check('2.6 缺口比当前更少', r.gap < r.currentGap || r.overflow < r.currentOverflow);
}

// —— 3. 部位空着 → 补空位 ——
console.log('\n— 3. 部位空着 → 补空位 —');
{
  const noShin = g8.filter((g) => g.slot !== '胫甲');
  const shin = g8.find((g) => g.slot === '胫甲');
  const r = SEARCH([...noShin, shin], noShin);
  check('3.1 status = improved', r.status === 'improved');
  check('3.2 换件 = 刚才空着的那件', r.swapIn.some((s) => s.piece?.uid === shin.uid));
  check('3.3 补齐后是 8 件', r.bestGear.length === 8);
}

// —— 4. 双枪流派：同一件不能占两个枪位 ——
console.log('\n— 4. 双枪流派：同一件不重复占槽 —');
{
  const dualFlow = {
    ...JSON.parse(fs.readFileSync('data/template/mingjinhong/mingjinhong.dawai.json', 'utf-8')),
    flowId: 'dawai',
    quota: {
      lines: JSON.parse(fs.readFileSync('data/template/mingjinhong/mingjinhong.dawai.json', 'utf-8'))
        .quota.lines.map((l) => {
          if (l.any_of[0] === '剑武学增伤') return { any_of: ['枪武学增伤'], count: 2 };
          if (l.any_of[0] === '最大外功攻击') return { ...l, count: 11 };
          return l;
        }),
    },
  };
  const rxDual = derivePrescription(affixes, dualFlow, ['枪', '枪']);
  const units = solveAssignment(rxDual._base.arrangementSpecs[0].spec, rxDual._base.lineOf);
  const bySlot = {};
  for (const u of units) (bySlot[u.slot] ||= []).push(u.affix);
  const gearDual = Object.entries(bySlot).map(([key, list]) => ({
    slot: key.startsWith('武器') ? '武器' : key,
    slotKey: key,
    weaponType: rxDual.slotTypes?.[key] || undefined,
    uid: `d_${key}`,
    初始: { 属性: list[0], 数值: V(list[0]) },
    调律: list.slice(1).map((a) => ({ 属性: a, 数值: V(a) })),
  }));
  // 池里只留一把枪（武器2 那把不给），另外 7 个部位正常
  const onlyOneGun = gearDual.filter((g) => g.slotKey !== '武器2');
  const r = searchBestComposition({
    buildCtx, version, affixes, selections,
    prescription: rxDual, flow: dualFlow, pool: onlyOneGun, currentGear: onlyOneGun,
    deadZone: 0.005,
  });
  check('4.1 搜索可用', r.ok === true);
  const gunCount = r.bestGear.filter((g) => g.slot === '武器').length;
  check('4.2 同一把枪只占一个槽（不会复制成两把）', gunCount <= 1);
  check('4.3 结果内 uid 无重复', new Set(r.bestGear.map((g) => g.uid)).size === r.bestGear.length);
}

// —— 5. 判据口径：配额不劣才比 DPS ——
console.log('\n— 5. 判据口径 —');
{
  // 造一件"结构很烂但某词条数值高"的件，不能因为 DPS 高就压过配额更好的组合
  const junkShin = mk('胫甲', '气血最大值', ['体', '御', '外功防御', '气血最大值'], 'junk_shin');
  const r = SEARCH([...g8, junkShin], g8);
  check('5.1 废件不会进最优组合', !r.bestGear.some((g) => g.uid === 'junk_shin'));
  check('5.2 保持 optimal', r.status === 'optimal');
  check('5.3 口径自描述包含字典序', /缺口/.test(r.口径));
}

// —— 6. 性能与规模 ——
console.log('\n— 6. 规模 —');
{
  const t0 = Date.now();
  const r = SEARCH([...g8, mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率'], 'x1')], g8);
  const ms = Date.now() - t0;
  check('6.1 8 件 × ~2 候选：耗时 < 3000ms', ms < 3000);
  console.log(`   耗时 ${ms}ms，节点 ${r.nodes}，叶子 ${r.leaves}`);
}

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗', f);
  process.exitCode = 1;
}
