'use strict';

/**
 * quota.js — 配额推导器（纯函数、无 IO，Node/浏览器双端共用）
 *
 * 职责（评价系统设计.md §3 / 数据架构盘点.md 议题A）：
 *   输入：版本包词条池（affixes JSON）+ 分支配额（flow.quota.lines）+ 流派武器类型（weaponTypes）
 *   输出：按武器排列枚举求解后合并的每部位 { 初始强制, 必备集合（含 any_of 组）, 自由集 }
 *
 * 机制确认（用户定稿）：
 *   - 指定武学增伤跟武器类型走：双刀武器只能出双刀增，其他武器/部位不可能出；
 *   - 流派携带的两把武器跨左右槽自由排列（双刀可在左也可在右）；
 *   - 因此武器槽的指定增供应按"排列"枚举：每种排列下，左/右槽的调律池各含本排列
 *     类型的指定增；推导器对每种排列完整求解后合并（min取最小/max取最大）；
 *   - 合并后每把武器的必备集合出现 any_of 组需求："恰好 1 条本类型指定增（双刀增/绳镖增任一）"；
 *   - 一件装备同时携带两条指定增 → 与任何排列矛盾 → 物理不可能（评分拒绝）。
 *
 * 其余口径（不变）：
 *   - 40 槽供需匹配 → 最大流判可行；封禁/预填探测得 min/max；
 *   - 配额行计数按"恰好"，总和必须 = 40；
 *   - 词条名先经 canonicalAffix 归一（教训4）；
 *   - verifyItemFits 做"整件预指派后其余部位能否补齐"的精确复核（按排列取或）。
 *   - pins 机制已废除（被排列枚举取代）。
 */

// ———— 别名归一（社区叫法 → 词条真名；议题C 计划迁往 affixes JSON） ————

const ALIAS = {
  最大外功: '最大外功攻击', 大外: '最大外功攻击',
  最小外功: '最小外功攻击', 小外: '最小外功攻击',
  大鸣金: '最大鸣金攻击', 小鸣金: '最小鸣金攻击',
  大裂石: '最大裂石攻击', 小裂石: '最小裂石攻击',
  大牵丝: '最大牵丝攻击', 小牵丝: '最小牵丝攻击',
  大破竹: '最大破竹攻击', 小破竹: '最小破竹攻击',
  大无相: '最大无相攻击', 小无相: '最小无相攻击',
  全武: '全武学增伤', 全武学增效: '全武学增伤',
  首领增: '对首领单位增伤', 首领增伤: '对首领单位增伤',
  玩家增: '对玩家单位增效',
  全奇术增: '全奇术增伤',
  会心: '会心率', 会意: '会意率', 精准: '精准率',
};

export function canonicalAffix(name) {
  const n = String(name ?? '').trim();
  return ALIAS[n] || n;
}

// 神力词条：转律池不含（转不进来），转掉不可再生（议题C 计划迁往 affixes JSON）
export const SHENLI_AFFIXES = new Set([
  '全武学增伤', '对首领单位增伤', '对玩家单位增效', '全奇术增伤',
  '剑武学增伤', '枪武学增伤', '伞武学增伤', '扇武学增伤', '双刀武学增伤',
  '绳镖武学增伤', '横刀武学增伤', '陌刀武学增伤', '拳甲武学增伤', '鼓武学增伤',
]);

// ———— 部位模型 ————

const WEAPON_SLOTS = ['左武器', '右武器'];
const ARMOR_RING_CONV_KEY = '冠胄、胸甲、胫甲、腕甲、环、佩的转律词条池';
const SLOT_DEFS = [
  { slot: '左武器', initialKey: '武器', tuningKey: '武器的调律词条池', conversionKey: '武器的转律词条池' },
  { slot: '右武器', initialKey: '武器', tuningKey: '武器的调律词条池', conversionKey: '武器的转律词条池' },
  { slot: '环', initialKey: '环', tuningKey: '环和佩的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '佩', initialKey: '佩', tuningKey: '环和佩的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '冠胄', initialKey: '冠胄', tuningKey: '冠胄和胸甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '胸甲', initialKey: '胸甲', tuningKey: '冠胄和胸甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '胫甲', initialKey: '胫甲', tuningKey: '胫甲和腕甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '腕甲', initialKey: '腕甲', tuningKey: '胫甲和腕甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
];

/**
 * 由版本包构建 8 部位词条池模型。
 * weaponTypes = 流派携带的武器类型（如 ['双刀','绳镖']，来自 build.weapon_categories）。
 * 武器调律池的"指定武学增伤"伞形展开为流派自身类型的指定增（跟武器类型走，用户确认），
 * 且左右槽同池（类型跨槽自由排列，排列约束在求解层处理）。
 */
export function loadSlotModel(affixes, weaponTypes = []) {
  const pools = affixes.词条池;
  const known = new Set((pools.调律词条池['指定武学增伤包括'] || []).map(canonicalAffix));
  const types = (weaponTypes || []).map(canonicalAffix).filter(Boolean);
  const specAffixes = [...new Set(types.filter((t) => known.has(`${t}武学增伤`)).map((t) => `${t}武学增伤`))];
  const unknownTypes = types.filter((t) => !known.has(`${t}武学增伤`));
  const slots = {};
  for (const def of SLOT_DEFS) {
    const initialPool = (pools.初始词条池[def.initialKey] || []).map(canonicalAffix);
    const tuningPool = [];
    for (const a of (pools.调律词条池[def.tuningKey] || []).map(canonicalAffix)) {
      if (a === '指定武学增伤') tuningPool.push(...specAffixes);
      else tuningPool.push(a);
    }
    const conversionPool = (pools.转律词条池[def.conversionKey] || []).map(canonicalAffix);
    slots[def.slot] = {
      initialPool: [...new Set(initialPool)],
      tuningPool: [...new Set(tuningPool)],
      conversionPool: [...new Set(conversionPool)],
    };
  }
  return { slots, specAffixes, unknownTypes };
}

// ———— 最大流（Edmonds-Karp，规模极小：≤40 单元） ————

function addEdge(cap, u, v, c) {
  if (!cap.has(u)) cap.set(u, new Map());
  const row = cap.get(u);
  if (!row.has(v)) row.set(v, 0);
  row.set(v, row.get(v) + c);
  if (!cap.has(v)) cap.set(v, new Map());
  if (!cap.get(v).has(u)) cap.get(v).set(u, 0);
}

function maxFlow(cap, s, t) {
  let flow = 0;
  for (;;) {
    const parent = new Map([[s, null]]);
    const q = [s];
    for (let head = 0; head < q.length && !parent.has(t); head++) {
      const u = q[head];
      const row = cap.get(u);
      if (!row) continue;
      for (const [v, c] of row) {
        if (c > 0 && !parent.has(v)) { parent.set(v, u); q.push(v); }
      }
    }
    if (!parent.has(t)) break;
    let bp = Infinity;
    for (let v = t; parent.get(v); v = parent.get(v)) {
      const u = parent.get(v);
      bp = Math.min(bp, cap.get(u).get(v));
    }
    for (let v = t; parent.get(v); v = parent.get(v)) {
      const u = parent.get(v);
      cap.get(u).set(v, cap.get(u).get(v) - bp);
      cap.get(v).set(u, (cap.get(v).get(u) || 0) + bp);
    }
    flow += bp;
  }
  return flow;
}

// ———— 流网络 spec ————

function buildGraph(spec) {
  const cap = new Map();
  let target = 0;
  spec.lines.forEach((L, i) => {
    if (L.count <= 0) return;
    const ln = `L${i}`;
    addEdge(cap, 'S', ln, L.count);
    for (const c of L.members) addEdge(cap, ln, `M${i}|${c}`, L.count);
    target += L.count;
  });
  for (const [slot, s] of Object.entries(spec.slots)) {
    const vn = `V|${slot}`, wn = `W|${slot}`;
    spec.lines.forEach((L, i) => {
      if (L.count <= 0) return;
      for (const c of L.members) {
        const mn = `M${i}|${c}`;
        if (s.initialCap > 0 && s.initialPool.has(c) && !s.bannedInitial.has(c)) addEdge(cap, mn, vn, 1);
        if (s.tuningCap > 0 && s.tuningPool.has(c) && !s.bannedTuning.has(c)) addEdge(cap, mn, wn, 1);
      }
    });
    if (s.initialCap > 0) addEdge(cap, vn, 'T', s.initialCap);
    if (s.tuningCap > 0) addEdge(cap, wn, 'T', s.tuningCap);
  }
  return { cap, target };
}

function feasible(spec) {
  const { cap, target } = buildGraph(spec);
  return maxFlow(cap, 'S', 'T') === target;
}

function cloneSpec(spec) {
  return {
    lines: spec.lines.map((L) => ({ members: [...L.members], count: L.count })),
    slots: Object.fromEntries(Object.entries(spec.slots).map(([k, s]) => [k, {
      initialPool: s.initialPool,   // 只读共享
      tuningPool: s.tuningPool,     // 只读共享
      initialCap: s.initialCap,
      tuningCap: s.tuningCap,
      bannedInitial: new Set(s.bannedInitial),
      bannedTuning: new Set(s.bannedTuning),
    }])),
  };
}

function reduceLine(spec, affix, n, lineOf) {
  const li = lineOf.get(affix);
  if (li === undefined) return false;
  if (spec.lines[li].count < n) return false;
  spec.lines[li].count -= n;
  return true;
}

/** 恰好预填 1 个单元到指定位置（另一位置封禁），其余需求能否补齐 */
function probeSingle(baseSpec, slot, c, lineOf, asInitial) {
  const sp = cloneSpec(baseSpec);
  if (!reduceLine(sp, c, 1, lineOf)) return false;
  if (asInitial) {
    sp.slots[slot].initialCap = 0;
    sp.slots[slot].bannedTuning.add(c);
  } else {
    sp.slots[slot].tuningCap -= 1;
    sp.slots[slot].bannedInitial.add(c);
  }
  return feasible(sp);
}

// ———— 主入口：推导每部位必备/自由集（按武器排列枚举） ————

/**
 * @param affixes     版本包 affixes JSON（含 词条池）
 * @param flow        单个分支对象 { name, quota:{lines}, thresholds?, ... }（无 flowId/pins，由文件名与模型取代）
 * @param weaponTypes 流派携带的武器类型 [左类型来源, 右类型来源] 的类型集合，
 *                    如 ['双刀','绳镖']（来自 build.weapon_categories，跨槽自由排列）
 */
export function derivePrescription(affixes, flow, weaponTypes = [], dingyinAffix = null) {
  const model = loadSlotModel(affixes, weaponTypes);
  const errors = [], warnings = [];
  const fail = () => ({ feasible: false, errors, warnings, buildId: flow.buildId ?? null, flowId: flow.flowId ?? null });

  if (model.unknownTypes.length) {
    errors.push(`未知武器类型（不在"指定武学增伤包括"清单中）：${model.unknownTypes.join('/')}`);
  }
  const lines = (flow?.quota?.lines || []).map((l) => ({
    members: l.any_of.map(canonicalAffix),
    count: l.count,
  }));
  const hasSpecLine = lines.some((L) => L.members.some((m) => /武学增伤$/.test(m) && m !== '全武学增伤'));
  if (hasSpecLine && model.specAffixes.length === 0) {
    errors.push('配额含指定武学增伤，但未提供流派武器类型（weaponTypes）');
  }

  // 1) 配额行校验
  const total = lines.reduce((a, L) => a + L.count, 0);
  if (total !== 40) errors.push(`配额总和 ${total} ≠ 40（8部位 × [1初始+4调律]）`);
  const legalSomewhere = (c) => Object.values(model.slots).some((s) => s.initialPool.includes(c) || s.tuningPool.includes(c));
  const lineOf = new Map();
  lines.forEach((L, i) => {
    for (const c of L.members) {
      if (!legalSomewhere(c)) errors.push(`词条「${c}」不在任何部位的初始/调律池中（检查别名或拼写）`);
      if (lineOf.has(c)) errors.push(`词条「${c}」同时出现在多条配额行中（当前模型不支持）`);
      else lineOf.set(c, i);
    }
  });

  // 2) 武器排列枚举（类型跨左右槽自由排列）
  const types = (weaponTypes || []).map(canonicalAffix).filter(Boolean);
  const typeArr = [types[0] ?? null, types[1] ?? null];
  const arrangements = [];
  const seenArr = new Set();
  for (const arr of [typeArr, [typeArr[1], typeArr[0]]]) {
    const key = arr.join('|');
    if (!seenArr.has(key)) { seenArr.add(key); arrangements.push(arr); }
  }

  if (errors.length) return fail();

  // 3) 基础 spec（槽位同池：含流派全部指定增）+ 各排列 spec（错型指定增按槽封禁）
  const baseSpec = {
    lines: lines.map((L) => ({ members: [...L.members], count: L.count })),
    slots: Object.fromEntries(Object.entries(model.slots).map(([slot, s]) => [slot, {
      initialPool: new Set(s.initialPool),
      tuningPool: new Set(s.tuningPool),
      initialCap: 1,
      tuningCap: 4,
      bannedInitial: new Set(),
      bannedTuning: new Set(),
    }])),
  };
  const arrangementSpecs = arrangements.map((arr) => {
    const sp = cloneSpec(baseSpec);
    WEAPON_SLOTS.forEach((slot, i) => {
      const my = arr[i];
      for (const t of new Set([...typeArr])) {
        if (t && t !== my) sp.slots[slot].bannedTuning.add(`${t}武学增伤`);
      }
    });
    return { arrangement: { 左武器: arr[0], 右武器: arr[1] }, spec: sp };
  });

  if (!arrangementSpecs.some(({ spec }) => feasible(spec))) {
    const got = Math.max(...arrangementSpecs.map(({ spec }) => {
      const { cap, target } = buildGraph(spec);
      return maxFlow(cap, 'S', 'T');
    }));
    errors.push(`配额在该词条池约束下不可行：最多安放 ${got}/40 条`);
    return fail();
  }

  // 4) 逐排列探测 → 合并
  const demandAffixes = [...new Set(lines.filter((L) => L.count > 0).flatMap((L) => L.members))];

  const probeArrangement = (arrSpec) => {
    const perSlot = {};
    for (const [slot, sModel] of Object.entries(model.slots)) {
      const sSpec = arrSpec.slots[slot];
      const affixInfo = {};
      const required = [];
      const freeSet = [];

      let initialForced = null;
      if (sSpec.initialCap > 0) {
        const forced = [];
        for (const c of sModel.initialPool) {
          if (!demandAffixes.includes(c)) continue;
          const sp = cloneSpec(arrSpec);
          sp.slots[slot].bannedInitial.add(c);
          if (!feasible(sp)) forced.push(c);
        }
        if (forced.length > 1) warnings.push(`${slot} 初始位探测到多个强制词条（${forced.join('/')}），取第一个`);
        initialForced = forced[0] ?? null;
      }

      for (const c of demandAffixes) {
        const canInitial = sModel.initialPool.includes(c) && sSpec.initialCap > 0;
        const canTuning = sModel.tuningPool.includes(c) && sSpec.tuningCap > 0;
        if (!canInitial && !canTuning) { affixInfo[c] = { min: 0, max: 0, outOfPool: true }; continue; }

        let min;
        {
          const sp = cloneSpec(arrSpec);
          sp.slots[slot].bannedInitial.add(c);
          sp.slots[slot].bannedTuning.add(c);
          if (feasible(sp)) min = 0;
          else if (canInitial && canTuning) {
            const spI = cloneSpec(arrSpec); spI.slots[slot].bannedInitial.add(c);
            const spT = cloneSpec(arrSpec); spT.slots[slot].bannedTuning.add(c);
            min = (!feasible(spI) && !feasible(spT)) ? 2 : 1;
          } else min = 1;
        }

        let max = 0;
        if (canInitial && canTuning) {
          const sp2 = cloneSpec(arrSpec);
          let ok2 = reduceLine(sp2, c, 2, lineOf);
          if (ok2) {
            sp2.slots[slot].initialCap = 0;
            sp2.slots[slot].tuningCap -= 1;
            sp2.slots[slot].bannedTuning.add(c);
            ok2 = feasible(sp2);
          }
          if (ok2) max = 2;
          else if (probeSingle(arrSpec, slot, c, lineOf, true) || probeSingle(arrSpec, slot, c, lineOf, false)) max = 1;
        } else {
          max = probeSingle(arrSpec, slot, c, lineOf, canInitial) ? 1 : 0;
        }

        affixInfo[c] = { min, max };
        if (min > 0) required.push({ affix: c, count: min, source: 'derived' });
        if (min === 0 && max >= 1) freeSet.push(c);
      }

      // 组需求探测（v1：流派指定增组——全部指定增同时封禁后不可行 ⇒ 每槽强制 1 条任选）
      if (slot === '左武器' || slot === '右武器') {
        if (model.specAffixes.length >= 2) {
          const sp = cloneSpec(arrSpec);
          for (const c of model.specAffixes) sp.slots[slot].bannedTuning.add(c);
          if (!feasible(sp)) {
            required.push({ any_of: [...model.specAffixes], count: 1, source: 'derived-group' });
            // 组已覆盖成员的强制语义，剔除成员的 per-affix 条目防重复计数
            for (let i = required.length - 1; i >= 0; i--) {
              if (required[i].affix && model.specAffixes.includes(required[i].affix)) required.splice(i, 1);
            }
          }
        }
      }

      perSlot[slot] = { initialForced, required, freeSet, affixInfo };
    }
    return perSlot;
  };

  const perArr = arrangementSpecs.map(({ spec, arrangement }) => ({
    arrangement,
    slots: probeArrangement(spec),
  }));

  // —— 合并（min取最小/max取最大/组取全部排列皆强制者；池取并集） ——
  const mergedSlots = {};
  for (const slot of Object.keys(model.slots)) {
    const inAll = perArr.map((p) => p.slots[slot]);
    const affixInfo = {};
    const allAffixes = new Set(inAll.flatMap((s) => Object.keys(s.affixInfo)));
    for (const c of allAffixes) {
      const vals = inAll.map((s) => s.affixInfo[c] ?? { min: 0, max: 0 });
      affixInfo[c] = { min: Math.min(...vals.map((v) => v.min)), max: Math.max(...vals.map((v) => v.max)) };
    }
    const required = [];
    for (const c of allAffixes) {
      if ((affixInfo[c]?.min ?? 0) > 0) required.push({ affix: c, count: affixInfo[c].min, source: 'derived' });
    }
    // 组需求：所有排列都强制 ⇒ 合并后仍强制（且成员无 per-affix 强制时才加，防重复计数）
    const groupCount = perArr.filter((p) => p.slots[slot].required.some((r) => r.any_of)).length;
    if (groupCount === perArr.length) {
      const members = perArr[0].slots[slot].required.find((r) => r.any_of).any_of;
      if (!required.some((r) => r.any_of && r.any_of.some((m) => members.includes(m)))) {
        required.push({ any_of: members, count: 1, source: 'derived-group' });
      }
    }
    const freeSet = [...new Set(inAll.flatMap((s) => s.freeSet))].sort((a, b2) => a.localeCompare(b2, 'zh'));
    required.sort((a, b2) => (a.affix ?? a.any_of.join('/')).localeCompare(b2.affix ?? b2.any_of.join('/'), 'zh'));
    mergedSlots[slot] = {
      initialForced: inAll.every((s) => s.initialForced === inAll[0].initialForced) ? inAll[0].initialForced : null,
      required,
      freeSet,
      affixInfo,
      initialPool: model.slots[slot].initialPool,
      tuningPool: model.slots[slot].tuningPool,
      conversionPool: model.slots[slot].conversionPool,
    };
  }

  const arrangementsOut = perArr.map((p) => ({
    arrangement: p.arrangement,
    slots: Object.fromEntries(Object.entries(p.slots).map(([slot, s]) => [slot, {
      initialForced: s.initialForced,
      required: s.required,
      freeSet: s.freeSet,
      affixInfo: s.affixInfo,
      initialPool: model.slots[slot].initialPool,
      tuningPool: model.slots[slot].tuningPool.filter((a) => !arrangementSpecs[perArr.indexOf(p)].spec.slots[slot].bannedTuning.has(a)),
      conversionPool: model.slots[slot].conversionPool,
    }])),
  }));

  return {
    feasible: true,
    buildId: flow.buildId ?? null,
    flowId: flow.flowId ?? null,
    flowName: flow.name ?? null,
    idealArmorDingyin: dingyinAffix ?? null,
    thresholds: flow.thresholds ?? null,
    priorityLayers: flow.priorityLayers ?? null,
    weaponTypes: { 左武器: arrangements[0][0], 右武器: arrangements[0][1] },
    errors: [],
    warnings,
    arrangements: arrangementsOut,
    mergedSlots,
    _base: { baseSpec, arrangementSpecs, lineOf },
  };
}

/**
 * 精确复核：把一件装备的有效单元预指派到其槽位（该槽位退出网络），
 * 其余部位能否恰好补齐全部配额。按武器排列取"或"——单元在该排列的池中非法时，
 * 该排列整体被排除（装备的武器类型是固定的，不能"占槽不占需求"地硬塞）。
 * @returns true/false；prescription 无 _base（手工构造）时返回 null
 */
export function verifyItemFits(prescription, slotName, item) {
  const base = prescription._base;
  const merged = prescription.mergedSlots?.[slotName];
  if (!base || !merged) return null;
  const initial = canonicalAffix(item.initial);
  const tunings = (item.tunings || []).map(canonicalAffix);
  const units = [{ position: 'initial', affix: initial }, ...tunings.map((a) => ({ position: 'tuning', affix: a }))];

  let anyCompatible = false;
  for (const { spec: arrSpec } of base.arrangementSpecs) {
    const sSpec = arrSpec.slots[slotName];
    // 该排列下装备是否物理合法：任一单元错型/出池 ⇒ 排除该排列
    const legal = units.every((u) => {
      if (u.position === 'initial') return merged.initialPool.includes(u.affix);
      return merged.tuningPool.includes(u.affix) && !sSpec.bannedTuning.has(u.affix);
    });
    if (!legal) continue;
    anyCompatible = true;

    const sp = cloneSpec(arrSpec);
    sp.slots[slotName].initialCap = 0;
    sp.slots[slotName].tuningCap = 0;
    let ok = true;
    for (const u of units) {
      const info = merged.affixInfo[u.affix];
      if (!info || info.max < 1) continue; // 无效单元：占槽不占需求
      if (!reduceLine(sp, u.affix, 1, base.lineOf)) { ok = false; break; }
    }
    if (!ok) continue;
    const { cap, target } = buildGraph(sp);
    if (maxFlow(cap, 'S', 'T') === target) return true;
  }
  return anyCompatible ? false : null;
}
