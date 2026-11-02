'use strict';

/**
 * search.js — 全局组合搜索（评价系统设计.md §11.8，纯函数、无 IO）
 *
 * 目的：补单件视角的盲区。单件回答不了"多件联动"——例：8 件各带 1 条小外，
 * 单看每件都不该穿，合起来才反转。只有整套搜索能看出来。
 *
 * 判据（与 §11.5 同口径，**配额优先、DPS 只在同档破僵局**）：
 *   score = (缺口总数, 溢出总数, -DPS) 字典序
 *   即：先让这套配置尽可能贴满配额，配额相同时才比 DPS。
 *
 * 搜索空间：
 *   - 只搜**当前配置**的 8 个槽，不跨方案（跨方案 DPS 不可比，跨方案只用配额判 §11.7）；
 *   - 候选池 = **整个装备库**（含当前正穿着的件，不只是背包）；
 *   - 武器按**类型桶**分配：槽位绑定类型由 prescription.weaponTypes 给出（双枪时两槽都是枪）；
 *   - 每件取「原样 / 结构最优的转律后」两态（转律让 k 或 m 变好时才加）；
 *   - 同一件装备不能占两个槽（按 uid 去重）。
 *
 * 成本：剪枝发生在**纯计数层**（超配额即剪，不跑 panel/dps），只有达到当前最优配额的叶子
 * 才算 DPS。因此可穷举；仍设 maxNodes/maxLeaves 兜底，超限返回 truncated。
 */

import { gradeItem, stateOf } from './advisor.js';
import { evalGearDps } from './swap.js';
import { transformedItem, toGradeShape } from './transform.js';
import { canonicalAffix, aliasMapOf } from './quota.js';

const SLOT_KEYS = ['武器1', '武器2', '环', '佩', '冠胄', '胸甲', '胫甲', '腕甲'];

/** 装备件的词条列表（初始 + 4 条调律；定音不进配额） */
function unitsOf(piece) {
  const out = [];
  if (piece?.初始?.属性) out.push(piece.初始.属性);
  for (const t of piece?.调律 || []) if (t?.属性) out.push(t.属性);
  return out;
}

/** 建立 词条 → 配额行下标 映射（any_of 行内成员共享同一行） */
function buildLineIndex(flow, affixes) {
  const aliasMap = aliasMapOf(affixes);
  const lines = (flow?.quota?.lines || []).map((L) => ({
    members: (L.any_of || []).map((m) => canonicalAffix(m, aliasMap)),
    count: L.count,
  }));
  const idxOf = new Map();
  lines.forEach((L, i) => { for (const m of L.members) if (!idxOf.has(m)) idxOf.set(m, i); });
  return { lines, idxOf, aliasMap };
}

/**
 * 某槽的候选状态（原样 + 至多一个"结构更优"的转律态）。
 * 只保留**结构严格改善**的转律：k 或 m 下降；不改善的不进搜索（省规模，且 DPS 由搜索统一裁决）。
 */
function statesOf(piece, slot, prescription, affixes) {
  const base = { piece, conversion: null };
  const g0 = gradeItem(prescription, slot, toGradeShape(piece));
  if (!g0.ok) return [base];
  const st = stateOf(prescription, slot, toGradeShape(piece));
  if (!st.ok) return [base];

  const gitem = toGradeShape(piece);
  const tunings = gitem.tunings;
  const markedIdx = (gitem.converted || []).indexOf(true);
  let best = null;
  for (let j = 0; j < tunings.length; j++) {
    if (markedIdx >= 0 && j !== markedIdx) continue;
    for (const to of st.conversionPool || []) {
      if (to === tunings[j]) continue;
      if (tunings.some((t, k) => k !== j && t === to)) continue;
      const trial = transformedItem(piece, { index: j, to, from: tunings[j] }, affixes);
      const gt = gradeItem(prescription, slot, toGradeShape(trial));
      if (!gt.ok) continue;
      const better = gt.k < g0.k || (gt.k === g0.k && gt.m < g0.m);
      if (!better) continue;
      const score = [gt.k, gt.m];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
        best = { score, piece: trial, conversion: { index: j, to, from: tunings[j] } };
      }
    }
  }
  return best ? [base, best] : [base];
}

/**
 * 搜索当前配置下"现有装备能达到的最优组合"。
 * @returns {{
 *   ok, status:'improved'|'complete'|'optimal'|'infeasible',
 *   currentDps, bestDps, deltaPct, gap, overflow, currentGap, currentOverflow,
 *   bestGear, slots, swapIn:[{slot,piece,conversion}], keep:[...], truncated, nodes, leaves, message
 * }}
 */
export function searchBestComposition({
  buildCtx, version, affixes, selections,
  prescription, flow,
  pool = [], currentGear = [],
  deadZone = 0.005,
  graduateDps,
  maxNodes = 400000,
  maxLeaves = 4000,
}) {
  if (!prescription || !flow) return { ok: false, errors: ['搜索需要 prescription 与 flow'] };
  if (!buildCtx?.build?.name) return { ok: false, errors: ['buildCtx 不完整'] };

  const { lines, idxOf } = buildLineIndex(flow, affixes);
  const aliasMap = aliasMapOf(affixes);
  const wtMap = prescription.weaponTypes || {};

  /** 某槽能收哪些件 */
  const fitsSlot = (piece, key) => {
    if (!piece) return false;
    if (key.startsWith('武器')) return piece.slot === '武器' && String(piece.weaponType ?? '') === String(wtMap[key] ?? '');
    return piece.slot === key;
  };

  // 候选：每槽（状态列表），按 uid 去重
  const buckets = SLOT_KEYS.map((key) => {
    const seen = new Set();
    const out = [];
    for (const p of pool) {
      if (!fitsSlot(p, key)) continue;
      const uid = p?.uid ?? null;
      if (uid && seen.has(uid)) continue;
      if (uid) seen.add(uid);
      for (const s of statesOf(p, key.startsWith('武器') ? '武器' : key, prescription, affixes)) {
        out.push({ ...s, key, uid });
      }
    }
    return out;
  });

  // 每个状态预计算配额行命中
  const lineHits = (piece) => {
    const hits = [];
    for (const a of unitsOf(piece)) {
      const i = idxOf.get(canonicalAffix(a, aliasMap));
      if (i != null) hits.push(i);
    }
    return hits;
  };
  for (const b of buckets) for (const s of b) s.hits = lineHits(s.piece);

  const dpsOf = (gear) => evalGearDps({ buildCtx, version, affixes, gear, selections, graduateDps }).dps;

  // 当前组合基线；同时把"当前每个槽穿什么"作为 best.slots 的初值，
  // 这样"没有更优解"时 swapIn 为空、status 才能正确落在 optimal（而不是 infeasible）
  const currentDps = dpsOf(currentGear);
  const curCounts = new Array(lines.length).fill(0);
  for (const p of currentGear) for (const i of lineHits(p)) curCounts[i] += 1;
  const gapOver = (counts) => {
    let gap = 0, over = 0;
    for (let i = 0; i < lines.length; i++) {
      const d = counts[i] - lines[i].count;
      if (d > 0) over += d; else gap += -d;
    }
    return { gap, over };
  };
  const curCensus = gapOver(curCounts);

  const curBySlot0 = new Map();
  for (const p of currentGear) {
    for (const key of SLOT_KEYS) if (fitsSlot(p, key) && !curBySlot0.has(key)) curBySlot0.set(key, p);
  }
  const curSlots = SLOT_KEYS.map((key) => {
    const p = curBySlot0.get(key);
    return p ? { piece: p, conversion: null, uid: p?.uid ?? null, key } : null;
  });

  let best = { gear: currentGear, dps: currentDps, ...curCensus, slots: curSlots };
  let nodes = 0, leaves = 0, truncated = false;
  const counts = new Array(lines.length).fill(0);
  const used = new Set();
  const chosen = new Array(SLOT_KEYS.length).fill(null);

  const st = { nodes: 0, leaves: 0 };

  const dfs = (i) => {
    if (truncated) return;
    st.nodes += 1;
    if (st.nodes > maxNodes) { truncated = true; return; }
    if (i === SLOT_KEYS.length) {
      st.leaves += 1;
      if (st.leaves > maxLeaves) { truncated = true; return; }
      const { gap, over } = gapOver(counts);
      const better = gap < best.gap
        || (gap === best.gap && over < best.over)
        || (gap === best.gap && over === best.over);
      if (!better) return; // 配额更差 ⇒ 连 DPS 都不必算
      const gear = chosen.filter(Boolean).map((s) => s.piece); // chosen 里是状态对象，取 piece
      let dps;
      try { dps = dpsOf(gear); } catch { return; }
      const improves = gap < best.gap
        || (gap === best.gap && over < best.over)
        || (gap === best.gap && over === best.over && dps > best.dps);
      if (improves) best = { gear, dps, gap, over, slots: chosen.slice() };
      return;
    }

    // 空槽选项（玩家可能某个部位真没穿）
    dfs(i + 1);

    for (const s of buckets[i]) {
      if (s.uid && used.has(s.uid)) continue; // 同一件不能占两个槽
      let ok = true;
      for (const li of s.hits) {
        counts[li] += 1;
        if (counts[li] > lines[li].count) ok = false;
      }
      if (ok) {
        chosen[i] = s;
        if (s.uid) used.add(s.uid);
        dfs(i + 1);
        if (s.uid) used.delete(s.uid);
        chosen[i] = null;
      }
      for (const li of s.hits) counts[li] -= 1;
      if (truncated) return;
    }
  };
  dfs(0);

  nodes = st.nodes; leaves = st.leaves;
  const deltaPct = currentDps > 0 ? best.dps / currentDps - 1 : 0;

  // 差异：按槽比对
  const curBySlot = curBySlot0;
  const swapIn = [];
  const keep = [];
  if (best.slots) {
    best.slots.forEach((s, i) => {
      const key = SLOT_KEYS[i];
      const cur = curBySlot.get(key) || null;
      if (!s) return;
      const same = cur && (s.uid != null && cur.uid != null
        ? s.uid === cur.uid
        : cur === s.piece);
      if (!same) swapIn.push({ slot: key, piece: s.piece, conversion: s.conversion || null });
      else if (s.conversion) swapIn.push({ slot: key, piece: s.piece, conversion: s.conversion });
      else keep.push({ slot: key, piece: s.piece });
    });
  }

  // 三态
  const 配额更优 = best.gap < curCensus.gap || best.over < curCensus.over;
  const dps更优 = deltaPct > deadZone;
  const 全空 = (best.slots || []).every((s) => !s);
  let status;
  if (全空) status = 'infeasible';
  else if (!swapIn.length && !配额更优) status = 'optimal';
  else if (best.gap === 0 && best.over === 0 && (curCensus.gap > 0 || curCensus.over > 0) && !dps更优) status = 'complete';
  else status = 'improved';

  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
  let message;
  if (status === 'optimal') message = '当前组合已是最优';
  else if (status === 'complete') message = `背包能补齐缺口（${curCensus.gap} → 0）`;
  else if (status === 'infeasible') message = '没有可用的完整组合';
  else message = `现在能换 ${swapIn.length} 件 · 本套 DPS ${pct(deltaPct)}`;

  return {
    ok: true,
    status,
    currentDps,
    bestDps: best.dps,
    deltaPct,
    gap: best.gap,
    overflow: best.over,
    currentGap: curCensus.gap,
    currentOverflow: curCensus.over,
    bestGear: best.gear,
    slots: best.slots,
    swapIn,
    keep,
    truncated,
    nodes,
    leaves,
    message,
    errors: [],
    口径: 'score=(缺口,溢出,-DPS) 字典序；只搜当前配置 8 槽；候选含整个装备库；武器按类型桶；每件取原样/结构更优转律态',
  };
}
