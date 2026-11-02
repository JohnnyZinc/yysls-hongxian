'use strict';

/**
 * quota.js — 配额推导器（纯函数、无 IO，Node/浏览器双端共用）
 *
 * 职责（评价系统设计.md §3 / 数据架构盘点.md 议题A）：
 *   输入：版本包词条池（affixes JSON）+ 分支配额（flow.quota.lines）+ 流派武器类型（weaponTypes）
 *   输出：按武器排列枚举求解后合并的每部位 { 初始强制, 必备集合（含 any_of 组）, 自由集 }
 *
 * 机制确认（用户定稿 2026-10-27，取代旧的"左右武器排列枚举"）：
 *   - 游戏武器不分左右，一个流派只是携带两把特定武器（如鸣金虹=剑+枪）；
 *   - 两个武器槽位无名无左右含义，槽位身份 = 流派武器列表里绑定的类型；
 *     槽位 key 用 武器1/武器2（与流派无关，换流派不丢装备），显示名取当前流派类型；
 *   - 指定武学增伤跟武器类型走：剑只能出剑增，枪与其他 7 部位都不可能出剑增；
 *     因此武器槽的调律池在建模时直接只含「本槽类型」的指定增，不做排列枚举；
 *   - ⇒ 配额里 1 条剑增只能由剑槽承担 ⇒ 剑槽的必备里剑增 min=1（旧模型因跨排列取 min
 *     被抹成 0、掉进自由集，导致"无剑增的剑"被误判天档——已修）；
 *   - 一件装备同时携带两条指定增 → 与任何槽位矛盾 → 物理不可能（评分拒绝）。
 *
 * 其余口径（不变）：
 *   - 40 槽供需匹配 → 最大流判可行；封禁/预填探测得 min/max；
 *   - 配额行计数按"恰好"，总和必须 = 40；
 *   - 词条名先经 canonicalAffix 归一（教训4）；
 *   - verifyItemFits 做"整件预指派后其余部位能否补齐"的精确复核。
 *   - pins 机制已废除；排列枚举机制已废除（槽位无名，互换即同一配置）。
 */

// ———— 词条元数据（单一来源 = affixes JSON；本节只是访问器，盘点 §2.2 #2/#3/#4） ————
//
// 数据约定（affixes JSON 顶层字段）：
//   别名       社区叫法 → 词条真名（如 大外→最大外功攻击；换季随社区叫法演变直接改数据）
//   神力词条   神力清单（转律池不含、转掉不可再生）
//   区间键别名 词条真名 → 区间表行名（如 全奇术增伤→奇术增伤）
// 武器类型清单不单独存：由 调律词条池."指定武学增伤包括" 去掉"武学增伤"后缀派生。

/** 社区叫法 → 真名映射（来自 affixes.别名；无该字段时返回空对象＝恒等） */
export function aliasMapOf(affixes) {
  return affixes?.别名 || {};
}

/** 神力词条集合（来自 affixes.神力词条） */
export function shenliSetOf(affixes) {
  return new Set(affixes?.神力词条 || []);
}

/** 武器类型清单（派生自"指定武学增伤包括"，去后缀） */
export function weaponTypesOf(affixes) {
  return (affixes?.词条池?.调律词条池?.['指定武学增伤包括'] || [])
    .map((s) => String(s).replace(/武学增伤$/, ''))
    .filter(Boolean);
}

/**
 * 词条名 → 数值区间记录（词条区间/定音区间共用查找逻辑）。
 * 覆盖：区间表精确名 / 定音区间 / 指定武学增伤→'武器增伤' /
 *       护甲定音55条→'技能定音' / 区间键别名；无数据返回 null。
 * UI 三页与 graduate.js 共用本函数（单一来源，勿再各写一份）。
 */
export function lookupAffixRange(affixes, name) {
  if (!name) return null;
  const A = affixes?.词条区间 || {};
  const D = affixes?.定音区间 || {};
  if (A[name]) return A[name];
  if (D[name]) return D[name];
  if (/武学增伤$/.test(name) && name !== '全武学增伤'
      && weaponTypesOf(affixes).some((t) => name.startsWith(t))) {
    return A['武器增伤'] || null; // 各武器指定武学增伤共用'武器增伤'区间
  }
  if (Array.isArray(affixes?.护甲定音词条) && affixes.护甲定音词条.includes(name)) {
    return D['技能定音'] || null; // 护甲定音技能增伤/增疗共用'技能定音'区间
  }
  const alias = affixes?.区间键别名 || {};
  if (alias[name]) return A[alias[name]] || null;
  return null;
}

/** 词条名归一（社区叫法 → 真名）。别名表由调用方传入（aliasMapOf(affixes)）；未传时恒等。 */
export function canonicalAffix(name, aliasMap = null) {
  const n = String(name ?? '').trim();
  return (aliasMap && aliasMap[n]) || n;
}

// ———— 部位模型 ————

// 两个武器槽位：游戏内不分左右，只是两个槽；槽位身份由流派武器类型按顺序绑定
const WEAPON_SLOTS = ['武器1', '武器2'];
const ARMOR_RING_CONV_KEY = '冠胄、胸甲、胫甲、腕甲、环、佩的转律词条池';
const SLOT_DEFS = [
  { slot: '武器1', initialKey: '武器', tuningKey: '武器的调律词条池', conversionKey: '武器的转律词条池' },
  { slot: '武器2', initialKey: '武器', tuningKey: '武器的调律词条池', conversionKey: '武器的转律词条池' },
  { slot: '环', initialKey: '环', tuningKey: '环和佩的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '佩', initialKey: '佩', tuningKey: '环和佩的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '冠胄', initialKey: '冠胄', tuningKey: '冠胄和胸甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '胸甲', initialKey: '胸甲', tuningKey: '冠胄和胸甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '胫甲', initialKey: '胫甲', tuningKey: '胫甲和腕甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
  { slot: '腕甲', initialKey: '腕甲', tuningKey: '胫甲和腕甲的调律词条池', conversionKey: ARMOR_RING_CONV_KEY },
];

/**
 * 由版本包构建 8 部位词条池模型。
 * weaponTypes = 流派携带的两把武器类型（如 ['剑','枪']，来自 template/<流派>/_meta.json 的 武器）。
 * 两个武器槽按该数组的顺序绑定类型（武器1←types[0]，武器2←types[1]）；槽位无左右含义。
 * 武器调律池的"指定武学增伤"只展开为「本槽绑定类型」的那一条：剑槽只能出剑增，
 * 枪槽只能出枪增 —— 这是游戏事实，不需要也不允许排列枚举。
 */
export function loadSlotModel(affixes, weaponTypes = []) {
  const pools = affixes.词条池;
  const aliasMap = aliasMapOf(affixes);
  const cano = (x) => canonicalAffix(x, aliasMap);
  const known = new Set((pools.调律词条池['指定武学增伤包括'] || []).map(cano));
  const types = (weaponTypes || []).map(cano).filter(Boolean);
  const specAffixes = [...new Set(types.filter((t) => known.has(`${t}武学增伤`)).map((t) => `${t}武学增伤`))];
  const unknownTypes = types.filter((t) => !known.has(`${t}武学增伤`));
  // 槽位 → 本槽可用的指定增（武器槽只含自己那一条；非武器槽不含指定增）
  const specOfSlot = (slot) => {
    const wi = WEAPON_SLOTS.indexOf(slot);
    if (wi < 0 || !types[wi]) return null;
    return [`${types[wi]}武学增伤`];
  };
  const slots = {};
  const slotTypes = {};
  for (const def of SLOT_DEFS) {
    const initialPool = (pools.初始词条池[def.initialKey] || []).map(cano);
    const mySpec = specOfSlot(def.slot);
    const tuningPool = [];
    for (const a of (pools.调律词条池[def.tuningKey] || []).map(cano)) {
      if (a === '指定武学增伤') {
        if (mySpec) tuningPool.push(...mySpec);
        else if (specAffixes.length) tuningPool.push(...specAffixes); // 未给类型时的兜底（保持不可行诊断）
      } else tuningPool.push(a);
    }
    const conversionPool = (pools.转律词条池[def.conversionKey] || []).map(cano);
    slots[def.slot] = {
      initialPool: [...new Set(initialPool)],
      tuningPool: [...new Set(tuningPool)],
      conversionPool: [...new Set(conversionPool)],
    };
    const wi = WEAPON_SLOTS.indexOf(def.slot);
    if (wi >= 0) slotTypes[def.slot] = types[wi] ?? null;
  }
  return { slots, specAffixes, unknownTypes, aliasMap, slotTypes };
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
 * @param flow        单个方案对象 { 流派, 分支, 方案, quota:{lines}, thresholds?, ... }
 * @param weaponTypes 流派携带的武器类型 [左类型来源, 右类型来源] 的类型集合，
 *                    如 ['双刀','绳镖']（来自 build.weapon_categories，跨槽自由排列）
 */
export function derivePrescription(affixes, flow, weaponTypes = []) {
  const model = loadSlotModel(affixes, weaponTypes);
  const aliasMap = model.aliasMap;
  const errors = [], warnings = [];
  // 自描述（三层）：流派 ⊃ 分支 ⊃ 方案；buildId/flowId 为历史字段，值由三层派生以保持下游兼容
  const selfDesc = () => ({
    流派: flow?.流派 ?? null,
    分支: flow?.分支 ?? null,
    方案: flow?.方案 ?? null,
    buildId: flow?.流派 ?? null,
    flowId: flow?.分支 ? `${flow.分支}.${flow.方案}` : (flow?.方案 ?? null),
  });
  const fail = () => ({ feasible: false, errors, warnings, ...selfDesc() });

  if (model.unknownTypes.length) {
    errors.push(`未知武器类型（不在"指定武学增伤包括"清单中）：${model.unknownTypes.join('/')}`);
  }
  const lines = (flow?.quota?.lines || []).map((l) => ({
    members: l.any_of.map((m) => canonicalAffix(m, aliasMap)),
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

  // 2) 武器槽绑定：槽位身份 = 流派武器列表顺序绑定的类型，不枚举排列（槽位不分左右）
  const types = (weaponTypes || []).map((t) => canonicalAffix(t, aliasMap)).filter(Boolean);
  const typeArr = [types[0] ?? null, types[1] ?? null];

  if (errors.length) return fail();

  // 3) 唯一 spec：各武器槽的调律池已在 loadSlotModel 按绑定类型裁剪（剑槽只含剑增），
  //    故无需 bannedTuning，也不存在"另一种排列"。
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
  const arrangementSpecs = [{
    arrangement: { 武器1: typeArr[0], 武器2: typeArr[1] },
    spec: baseSpec,
  }];

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

      // 指定增的必备性由 per-affix 探测自然得出（剑槽池只含剑增 ⇒ 封禁后不可行 ⇒ min=1），
      // 不再需要"任选组"需求（旧模型因槽位同池才需要 any_of 组）。

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
      // outOfPool 必须在合并后保留：它表达"该词条在本槽位完全不可出"（如绳镖增在双刀槽），
      // 下游（评分兼容性判断/UI）据此区分"自由但没选"与"物理不可能"
      if (vals.every((v) => v.outOfPool)) affixInfo[c].outOfPool = true;
    }
    const required = [];
    for (const c of allAffixes) {
      if ((affixInfo[c]?.min ?? 0) > 0) required.push({ affix: c, count: affixInfo[c].min, source: 'derived' });
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
      weaponType: model.slotTypes?.[slot] ?? null,
      initialPool: model.slots[slot].initialPool,
      tuningPool: model.slots[slot].tuningPool,
      conversionPool: model.slots[slot].conversionPool,
    }])),
  }));

  // 武器槽等价（评价系统设计.md §12.3）：两槽 required 完全相同 ⇒ 桶内无序，可用桶语义。
  // 为 false（如主手吃指定增、副手不吃）时，上层必须按指定槽评档，不能"跨槽取最优"（会虚高）。
  const reqSig = (s) => JSON.stringify((s?.required || [])
    .map((r) => (r.any_of ? { any: [...r.any_of].sort(), count: r.count } : { affix: r.affix, count: r.count }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const w1 = mergedSlots['武器1'];
  const w2 = mergedSlots['武器2'];
  const 槽位等价 = !!(w1 && w2 && reqSig(w1) === reqSig(w2));

  return {
    feasible: true,
    ...selfDesc(),
    thresholds: flow.thresholds ?? null,
    weaponTypes: { 武器1: typeArr[0], 武器2: typeArr[1] },
    slotTypes: model.slotTypes,
    槽位等价,
    errors: [],
    warnings,
    arrangements: arrangementsOut,
    mergedSlots,
    _base: { baseSpec, arrangementSpecs, lineOf },
    // 词条元数据随推导结果传递（单一来源=affixes JSON；advisor/monitor 消费）
    _aliasMap: aliasMap,
    _shenli: shenliSetOf(affixes),
    // 原始词条表引用：转律试算要按**目标词条**重取数值（承音值），
    // 不能沿用被转掉那条的数值（小外 131.2 转成敏会用 131.2，虚高 58%）。
    _affixes: affixes,
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
  if (!base) return null;
  const aliasMap = prescription._aliasMap || {};
  const slotKeys = verifySlotKeys(prescription, slotName, item, aliasMap);
  if (!slotKeys.length) return null;
  const initial = canonicalAffix(item.initial, aliasMap);
  const tunings = (item.tunings || []).map((t) => canonicalAffix(t, aliasMap));
  const units = [{ position: 'initial', affix: initial }, ...tunings.map((a) => ({ position: 'tuning', affix: a }))];

  let anyCompatible = false;
  for (const sk of slotKeys) {
    const merged = prescription.mergedSlots?.[sk];
    if (!merged) continue;
    for (const { spec: arrSpec } of base.arrangementSpecs) {
      const sSpec = arrSpec.slots[sk];
      if (!sSpec) continue;
      // 该排列下装备是否物理合法：任一单元错型/出池 ⇒ 排除该排列
      const legal = units.every((u) => {
        if (u.position === 'initial') return merged.initialPool.includes(u.affix);
        return merged.tuningPool.includes(u.affix) && !sSpec.bannedTuning.has(u.affix);
      });
      if (!legal) continue;
      anyCompatible = true;

      const sp = cloneSpec(arrSpec);
      sp.slots[sk].initialCap = 0;
      sp.slots[sk].tuningCap = 0;
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
  }
  return anyCompatible ? false : null;
}

/**
 * 本方案"被配额需求"的词条全集（配额行 any_of 的并集，已归一为真名）。
 *
 * 用途：转律目标的硬约束——**转成的词条必须在这里面**。
 * 转成不在配额里的词条（如大外流里的"会意率"）不减少任何缺口，只是把一条废词条
 * 换成另一条对装配毫无贡献的词条（k 会降、DPS 会微涨），对"凑满配额"没有意义，
 * 却会挤掉真正该转的方向（如补"劲"）。这类候选一律不产出建议。
 */
export function demandAffixesOf(prescription) {
  const spec = prescription?._base?.arrangementSpecs?.[0]?.spec;
  const out = new Set();
  for (const L of spec?.lines || []) {
    for (const m of L.members || []) out.add(m);
  }
  return out;
}

/**
 * 把一批**已固定的装备**钉进槽位后，检查"其余空槽自由填充"能否恰好配满配额。
 *
 * 与 verifyItemFits 的区别（关键）：
 *   verifyItemFits 只钉住**一件**，其余 7 个部位可以重新自由规划 ⇒ 回答"结构上还有没有解"；
 *   verifyGearFits 钉住**玩家实际拥有的全部件** ⇒ 回答"以这套固定件，还补得齐吗"。
 * 后者才是"该转成哪条词条"的正确判据：转 A 还是转 B，差别往往不在缺口数，
 * 而在"剩下的空位里到底还塞不塞得下"（例：劲缺 2，但只剩胸甲，而胸甲初始池不出劲）。
 *
 * @param gear 已固定件数组（装备件形状：slot / weaponType / 初始 / 调律）
 * @returns true=可配满 / false=配不满 / null=数据不足
 */
export function verifyGearFits(prescription, gear) {
  const base = prescription?._base;
  if (!base) return null;
  const aliasMap = prescription._aliasMap || {};
  let anyLegal = false;

  for (const { spec: arrSpec, arrangement } of base.arrangementSpecs) {
    const mapped = assignGearToSlots(gear, arrangement, aliasMap);
    if (!mapped) continue;
    const sp = cloneSpec(arrSpec);
    for (const { key } of mapped) {
      if (!sp.slots[key]) { mapped.length = 0; break; }
      sp.slots[key].initialCap = 0;
      sp.slots[key].tuningCap = 0;
    }
    if (!mapped.length) continue;

    let ok = true;
    for (const { piece, key } of mapped) {
      const merged = prescription.mergedSlots?.[key];
      if (!merged) { ok = false; break; }
      const units = pieceUnits(piece);
      // 物理合法性：初始位 / 调律位各自必须在池中
      for (let i = 0; i < units.length && ok; i++) {
        const c = canonicalAffix(units[i], aliasMap);
        const pool = i === 0 ? merged.initialPool : merged.tuningPool;
        if (!pool.includes(c)) ok = false;
      }
      if (!ok) break;
      anyLegal = true;
      for (const a of units) {
        const c = canonicalAffix(a, aliasMap);
        const info = merged.affixInfo[c];
        if (!info || info.max < 1) continue; // 无效词条：占槽不占需求
        if (!reduceLine(sp, c, 1, base.lineOf)) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    const { cap, target } = buildGraph(sp);
    if (maxFlow(cap, 'S', 'T') === target) return true;
  }
  return anyLegal ? false : null;
}

/** 装备件 → 槽位列表（初始 + 调律，含数值无关） */
function pieceUnits(piece) {
  const out = [];
  const init = piece?.初始?.属性 ?? piece?.initial;
  if (init) out.push(init);
  for (const t of piece?.调律 || []) if (t?.属性) out.push(t.属性);
  return out;
}

/** 把件分配到具体槽 key：武器按类型（同类型多槽顺序占位），防具按部位；分配失败返回 null */
function assignGearToSlots(gear, arrangement, aliasMap) {
  const used = new Set();
  const out = [];
  for (const p of gear || []) {
    if (!p) continue;
    if (p.slot === '武器') {
      const wt = canonicalAffix(p?.weaponType ?? '', aliasMap);
      const key = Object.keys(arrangement || {}).find((k) => !used.has(k)
        && arrangement[k] != null && canonicalAffix(arrangement[k], aliasMap) === wt);
      if (!key) return null;
      used.add(key);
      out.push({ piece: p, key });
    } else {
      out.push({ piece: p, key: p.slot });
    }
  }
  return out;
}

/**
 * 复核要针对哪些**槽位 key**。
 * 防具：就是部位本身。武器：按 weaponType 定位到绑定的槽（`武器` 不是 mergedSlots 的键，
 * 直接拿它查会永远返回 null ⇒ 武器件从来不做全局复核，这是双枪/转律可行性判断的致命缺口）。
 * 同类型双枪（槽位等价）时两个槽都试，任一行即可；类型不符则退回全部武器槽。
 */
function verifySlotKeys(prescription, slotName, item, aliasMap) {
  if (slotName !== '武器') return [slotName];
  const arr = prescription?._base?.arrangementSpecs?.[0]?.arrangement || {};
  const keys = Object.keys(arr).filter((k) => arr[k] != null);
  if (!keys.length) return [];
  const wt = canonicalAffix(item?.weaponType, aliasMap);
  if (!wt) return keys;
  const matched = keys.filter((k) => canonicalAffix(arr[k], aliasMap) === wt);
  return matched.length ? matched : keys;
}

/**
 * 从可行 spec 构造一套"配额词条 → 槽位"的物理分配（构造法贪心 + 可行性预言机：
 * 起步可行，每步只提交保持可行的放置，必然成功且恰好配满全部单元）。
 * 供毕业基准生成器物化毕业装备使用（盘点 §3.3 / 议题B）。
 * @param spec   某一武器排列的流网络 spec（prescription._base.arrangementSpecs[n].spec）
 * @param lineOf 词条 → 配额行下标（prescription._base.lineOf）
 * @returns [{ slot, affix }, ...]；初始/调律位置对面板无差别，不区分
 */
export function solveAssignment(spec, lineOf) {
  const sp = cloneSpec(spec);
  const units = [];
  for (const slot of Object.keys(sp.slots)) {
    const place = (asInitial) => {
      for (const L of sp.lines) {
        if (L.count <= 0) continue;
        for (const c of L.members) {
          const s = sp.slots[slot];
          if (asInitial && (s.initialCap <= 0 || !s.initialPool.has(c) || s.bannedInitial.has(c))) continue;
          if (!asInitial && (s.tuningCap <= 0 || !s.tuningPool.has(c) || s.bannedTuning.has(c))) continue;
          const trial = cloneSpec(sp);
          if (!reduceLine(trial, c, 1, lineOf)) continue;
          const ts = trial.slots[slot];
          // 初始放置只清容量（同词条还可占调律——毕业方案武器"初始+调律双大外"正是 min=2 语义）；
          // 调律放置后封禁同词条——流量模型 M→W 边容量 1 = 同部位调律词条互不重复
          if (asInitial) { ts.initialCap = 0; }
          else { ts.tuningCap -= 1; ts.bannedTuning.add(c); }
          if (!feasible(trial)) continue;
          sp.lines = trial.lines;
          sp.slots[slot] = ts;
          units.push({ slot, affix: c });
          return true;
        }
      }
      return false;
    };
    if (sp.slots[slot].initialCap > 0 && !place(true)) return null;
    while (sp.slots[slot].tuningCap > 0) {
      if (!place(false)) return null;
    }
  }
  return units;
}
