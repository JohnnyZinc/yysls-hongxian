'use strict';

/**
 * quota.js — 配额推导器（纯函数、无 IO，Node/浏览器双端共用）
 *
 * 职责（评价系统设计.md §3）：
 *   输入：版本包词条池（affixes JSON）+ 全局配额（flow.quota.lines）[+ 可选 pins]
 *   输出：每部位 { 初始强制, 必备集合（含数量）, 自由集 } + 可行性报告
 *
 * 方法：
 *   40 槽（8 部位 × [1 初始 + 4 调律]）供需匹配 → 最大流判可行；
 *   对每个"部位×词条"做封禁/预填探测：
 *     全部封禁后仍可行            ⇒ min=0（不强制）
 *     初始位与调律位分别封禁均不可行 ⇒ min=2（两个位置都被锁死）
 *     预填后仍可行                ⇒ max（可同时占初始+调律各 1）
 *     min=0 且 max≥1              ⇒ 自由（进入 freeSet）
 *   pins = 用户钉定的预指派（如"指定武学增伤按武器类型锁定"假设），
 *          参与全网计算：钉走的需求与槽位容量同步扣减，从而也影响其他部位的自由集。
 *
 * 口径备注：
 *   - 配额行计数按"恰好"；所有行总和必须 = 40（8 部位 × 5 词条槽），pins 是其中一部分。
 *   - 词条名先经 canonicalAffix 归一（教训4：别名兼容）。
 *   - 局部必备/自由是全局可行的必要条件刻画；advisor 评完档后再用 verifyItemFits
 *     做"整件预指派后其余 7 部位能否补齐配额"的精确复核。
 */

// ———— 别名归一（社区叫法 → 词条真名） ————

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

// 神力词条：转律池不含（转不进来），转掉不可再生
export const SHENLI_AFFIXES = new Set([
  '全武学增伤', '对首领单位增伤', '对玩家单位增效', '全奇术增伤',
  '剑武学增伤', '枪武学增伤', '伞武学增伤', '扇武学增伤', '双刀武学增伤',
  '绳镖武学增伤', '横刀武学增伤', '陌刀武学增伤', '拳甲武学增伤', '鼓武学增伤',
]);

// ———— 部位模型 ————

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
 * 武器调律池中的"指定武学增伤"是伞形类别，展开为 10 种具体武器增伤。
 */
export function loadSlotModel(affixes) {
  const pools = affixes.词条池;
  const umbrella = (pools.调律词条池['指定武学增伤包括'] || []).map(canonicalAffix);
  const slots = {};
  for (const def of SLOT_DEFS) {
    const initialPool = (pools.初始词条池[def.initialKey] || []).map(canonicalAffix);
    const tuningPool = [];
    for (const a of (pools.调律词条池[def.tuningKey] || []).map(canonicalAffix)) {
      if (a === '指定武学增伤') tuningPool.push(...umbrella);
      else tuningPool.push(a);
    }
    const conversionPool = (pools.转律词条池[def.conversionKey] || []).map(canonicalAffix);
    slots[def.slot] = {
      initialPool: [...new Set(initialPool)],
      tuningPool: [...new Set(tuningPool)],
      conversionPool: [...new Set(conversionPool)],
    };
  }
  return slots;
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
    // BFS 找增广路
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

/**
 * spec = {
 *   lines: [{ members: [词条], count: 剩余需求 }],
 *   slots: { [部位]: { initialPool:Set, tuningPool:Set, initialCap, tuningCap,
 *                     bannedInitial:Set, bannedTuning:Set } },
 * }
 */
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
    lines: spec.lines.map(L => ({ members: [...L.members], count: L.count })),
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

/** 把词条 c 的需求行扣减 n（预指派）；需求不足返回 false（该探测直接判不可行） */
function reduceLine(spec, affix, n, lineOf) {
  const li = lineOf.get(affix);
  if (li === undefined) return false;
  if (spec.lines[li].count < n) return false;
  spec.lines[li].count -= n;
  return true;
}

/**
 * 恰好预填 1 个单元到指定位置（另一位置封禁），其余需求能否补齐。
 */
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

// ———— 主入口：推导每部位必备/自由集 ————

/**
 * @param affixes 版本包 affixes JSON（含 词条池）
 * @param flow    单个流对象 { flowId, name, quota:{lines}, pins?, ... }
 */
export function derivePrescription(affixes, flow) {
  const slotsModel = loadSlotModel(affixes);
  const errors = [], warnings = [];
  const fail = () => ({ feasible: false, errors, warnings, buildId: flow.buildId, flowId: flow.flowId });

  // 1) 配额行归一与校验
  const lines = (flow.quota?.lines || []).map(l => ({
    members: l.any_of.map(canonicalAffix),
    count: l.count,
  }));
  const total = lines.reduce((a, L) => a + L.count, 0);
  if (total !== 40) errors.push(`配额总和 ${total} ≠ 40（8部位 × [1初始+4调律]）`);
  const legalSomewhere = c => Object.values(slotsModel).some(s => s.initialPool.includes(c) || s.tuningPool.includes(c));
  const lineOf = new Map();
  lines.forEach((L, i) => {
    for (const c of L.members) {
      if (!legalSomewhere(c)) errors.push(`词条「${c}」不在任何部位的初始/调律池中（检查别名或拼写）`);
      if (lineOf.has(c)) errors.push(`词条「${c}」同时出现在多条配额行中（当前模型不支持）`);
      else lineOf.set(c, i);
    }
  });

  // 2) pins 校验与预指派
  const initialCap = {}, tuningCap = {};
  for (const slot of Object.keys(slotsModel)) { initialCap[slot] = 1; tuningCap[slot] = 4; }
  const pinnedUnits = [];
  for (const p of flow.pins || []) {
    const s = slotsModel[p.slot];
    if (!s) { errors.push(`pin 部位未知：${p.slot}`); continue; }
    const affix = canonicalAffix(p.affix);
    const pos = p.position === 'initial' ? 'initial' : 'tuning';
    const pool = pos === 'initial' ? s.initialPool : s.tuningPool;
    if (!pool.includes(affix)) { errors.push(`pin 非法：${p.slot} 的${pos === 'initial' ? '初始' : '调律'}池不含「${affix}」`); continue; }
    if (!lineOf.has(affix)) { errors.push(`pin 词条「${affix}」不在配额行中`); continue; }
    const capNow = pos === 'initial' ? initialCap[p.slot] : tuningCap[p.slot];
    if (capNow < p.count) { errors.push(`pin 超出 ${p.slot} 的${pos === 'initial' ? '初始' : '调律'}容量`); continue; }
    if (lines[lineOf.get(affix)].count < p.count) { errors.push(`pin 数量超过「${affix}」配额行剩余需求`); continue; }
    if (pos === 'initial') initialCap[p.slot] -= p.count;
    else tuningCap[p.slot] -= p.count;
    lines[lineOf.get(affix)].count -= p.count;
    pinnedUnits.push({ slot: p.slot, affix, position: pos, count: p.count });
  }
  if (errors.length) return fail();

  // 3) 基础 spec 与整体可行性
  const baseSpec = {
    lines: lines.map(L => ({ members: [...L.members], count: L.count })),
    slots: Object.fromEntries(Object.entries(slotsModel).map(([slot, s]) => [slot, {
      initialPool: new Set(s.initialPool),
      tuningPool: new Set(s.tuningPool),
      initialCap: initialCap[slot],
      tuningCap: tuningCap[slot],
      bannedInitial: new Set(),
      bannedTuning: new Set(),
    }])),
  };
  if (!feasible(baseSpec)) {
    const { cap, target } = buildGraph(baseSpec);
    const got = maxFlow(cap, 'S', 'T');
    const pinnedTotal = pinnedUnits.reduce((a, p) => a + p.count, 0);
    errors.push(`配额在该词条池/pin 约束下不可行：含 pin 最多安放 ${got + pinnedTotal}/40 条`);
    return fail();
  }

  // 4) 逐部位探测 min / max / 初始强制
  const demandAffixes = [...new Set(lines.filter(L => L.count > 0).flatMap(L => L.members))];
  const out = {
    feasible: true,
    buildId: flow.buildId,
    flowId: flow.flowId,
    flowName: flow.name,
    idealArmorDingyin: flow.idealArmorDingyin ?? null,
    thresholds: flow.thresholds ?? null,
    priorityLayers: flow.priorityLayers ?? null,
    errors: [],
    warnings,
    slots: {},
    // 内部状态（verifyItemFits 复用；手工构造 prescription 时可省略）
    _base: { baseSpec, lineOf, pinnedUnits },
  };

  for (const [slot, sModel] of Object.entries(slotsModel)) {
    const sSpec = baseSpec.slots[slot];
    const affixInfo = {};
    const required = [];
    const freeSet = [];

    const slotPins = pinnedUnits.filter(p => p.slot === slot);
    const pinnedInitial = slotPins.find(p => p.position === 'initial') || null;

    // 初始强制探测：封禁"某词条占据初始位"后整体不可行 ⇒ 该词条强制为初始
    let initialForced = pinnedInitial ? pinnedInitial.affix : null;
    if (!initialForced && sSpec.initialCap > 0) {
      const forced = [];
      for (const c of sModel.initialPool) {
        if (!demandAffixes.includes(c)) continue;
        const sp = cloneSpec(baseSpec);
        sp.slots[slot].bannedInitial.add(c);
        if (!feasible(sp)) forced.push(c);
      }
      if (forced.length > 1) warnings.push(`${slot} 初始位探测到多个强制词条（${forced.join('/')}），取第一个`);
      initialForced = forced[0] ?? null;
    }

    // min/max 探测（只探有剩余需求的词条；需求 0（含被 pin 钉走的）一律无效）
    for (const c of demandAffixes) {
      const canInitial = sModel.initialPool.includes(c) && sSpec.initialCap > 0;
      const canTuning = sModel.tuningPool.includes(c) && sSpec.tuningCap > 0;
      if (!canInitial && !canTuning) continue;

      // min：全封禁可行⇒0；否则仅当初始/调律两个位置分别封禁都不可行⇒2；其余⇒1
      let min;
      {
        const sp = cloneSpec(baseSpec);
        sp.slots[slot].bannedInitial.add(c);
        sp.slots[slot].bannedTuning.add(c);
        if (feasible(sp)) min = 0;
        else if (canInitial && canTuning) {
          const spI = cloneSpec(baseSpec); spI.slots[slot].bannedInitial.add(c);
          const spT = cloneSpec(baseSpec); spT.slots[slot].bannedTuning.add(c);
          min = (!feasible(spI) && !feasible(spT)) ? 2 : 1;
        } else min = 1;
      }

      // max：双位置先探"初始+调律各 1"（恰 2 单元），不行再探恰 1 单元（任一位置）
      let max = 0;
      if (canInitial && canTuning) {
        const sp2 = cloneSpec(baseSpec);
        let ok2 = reduceLine(sp2, c, 2, lineOf);
        if (ok2) {
          sp2.slots[slot].initialCap = 0;          // 初始位被 c 消费
          sp2.slots[slot].tuningCap -= 1;          // 调律位被 c 消费一个
          sp2.slots[slot].bannedTuning.add(c);     // 流不能再往调律塞 c
          ok2 = feasible(sp2);
        }
        if (ok2) max = 2;
        else if (probeSingle(baseSpec, slot, c, lineOf, true) || probeSingle(baseSpec, slot, c, lineOf, false)) max = 1;
      } else {
        max = probeSingle(baseSpec, slot, c, lineOf, canInitial) ? 1 : 0;
      }

      affixInfo[c] = { min, max };
      if (min > 0) required.push({ affix: c, count: min, source: 'derived' });
      if (min === 0 && max >= 1) freeSet.push(c);
    }

    for (const pu of slotPins) {
      const exist = required.find(r => r.affix === pu.affix);
      if (exist) exist.count += pu.count;
      else required.push({ affix: pu.affix, count: pu.count, source: 'pinned' });
    }
    required.sort((a, b) => a.affix.localeCompare(b.affix, 'zh'));
    freeSet.sort((a, b) => a.localeCompare(b, 'zh'));

    out.slots[slot] = {
      initialForced,
      required,
      freeSet,
      affixInfo,
      initialPool: sModel.initialPool,
      tuningPool: sModel.tuningPool,
      conversionPool: sModel.conversionPool,
    };
  }

  return out;
}

/**
 * 精确复核：把一件装备的有效单元预指派到其槽位（该槽位整体退出网络），
 * 其余 7 部位能否恰好补齐全部配额。
 * 无效单元只占槽不占需求；已被 pin 预指派的单元不重复扣减。
 * @returns true/false；prescription 无 _base（手工构造）时返回 null
 */
export function verifyItemFits(prescription, slotName, item) {
  const base = prescription._base;
  const rx = prescription.slots[slotName];
  if (!base || !rx) return null;
  const initial = canonicalAffix(item.initial);
  const tunings = (item.tunings || []).map(canonicalAffix);
  const validSet = new Set([...rx.required.flatMap(r => r.affix), ...rx.freeSet]);
  const units = [{ position: 'initial', affix: initial }, ...tunings.map(a => ({ position: 'tuning', affix: a }))];

  const sp = cloneSpec(base.baseSpec);
  sp.slots[slotName].initialCap = 0;
  sp.slots[slotName].tuningCap = 0;
  for (const u of units) {
    const posOk = u.position === 'initial' ? rx.initialPool.includes(u.affix) : rx.tuningPool.includes(u.affix);
    const info = rx.affixInfo[u.affix];
    if (!posOk || !info || info.max < 1) continue; // 无效单元：占槽不占需求
    const alreadyPinned = base.pinnedUnits.some(p => p.slot === slotName && p.affix === u.affix && p.position === u.position);
    if (alreadyPinned) continue; // pin 已在 baseSpec 中扣减过
    if (!reduceLine(sp, u.affix, 1, base.lineOf)) return false;
  }
  const { cap, target } = buildGraph(sp);
  return maxFlow(cap, 'S', 'T') === target;
}
