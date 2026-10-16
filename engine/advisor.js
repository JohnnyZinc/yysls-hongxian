'use strict';

/**
 * advisor.js — 系统①匹配度：单件装备词条匹配度（纯函数、无 IO）
 *
 * 设计（评价系统设计.md §4 / 数据架构盘点.md 议题A）：
 *   - roll 数值完全不入档（承音收敛；数值差异由 ΔDPS 系统承载）
 *   - prescription 按武器排列给出多套 per-排列 prescriptions（指定增跟武器类型走、
 *     类型跨左右槽自由排列——用户确认）；评分对"装备可兼容的排列"取 (k,m) 最优
 *   - 必备集合支持 any_of 组需求（如"恰好 1 条本武器类型的指定增"）
 *   - 档位（最优排列+最优转律后）：天=(0,0) / 地=(0,≥1) / 玄=k=1 / 黄=k≥2
 *   - 一件装备的词条组合与任何排列矛盾（如一把武器两条指定增）→ 物理不可能，拒绝评分
 *   - 定音不入档（可随意变音），仅提示；评档后用 verifyItemFits 做全局精确复核
 */

import { canonicalAffix, SHENLI_AFFIXES, verifyItemFits } from './quota.js';

const ARMOR_SLOTS = new Set(['冠胄', '胸甲', '胫甲', '腕甲']);

// 武器不分左右槽（用户定稿）：录入/评价部位 = 武器；引擎在 左武器/右武器 两个排列槽位间取最优
const WEAPON_SLOT_KEY = '武器';
const WEAPON_SLOT_KEYS = ['左武器', '右武器'];
function resolveSlotKeys(slotName) {
  return slotName === WEAPON_SLOT_KEY ? WEAPON_SLOT_KEYS : [slotName];
}

const membersOf = (r) => (r.any_of ? r.any_of : [r.affix]);

/** 评价一个 (初始, 调律×4) 状态的 (k, m) 与明细（required 支持 any_of 组） */
function evalState(rx, initial, tunings) {
  const required = rx.required || [];
  const validSet = new Set([...required.flatMap(membersOf), ...rx.freeSet]);
  const initialPoolSet = new Set(rx.initialPool);
  const tuningPoolSet = new Set(rx.tuningPool);

  let k = 0;
  const invalid = [];
  const units = [{ position: 'initial', affix: initial }, ...tunings.map((a) => ({ position: 'tuning', affix: a }))];
  for (const u of units) {
    const posOk = u.position === 'initial' ? initialPoolSet.has(u.affix) : tuningPoolSet.has(u.affix);
    if (!posOk || !validSet.has(u.affix)) {
      k += 1;
      invalid.push({ position: u.position, affix: u.affix });
    }
  }

  let m = 0;
  const missing = [];
  if (rx.initialForced && initial !== rx.initialForced) {
    m += 1;
    missing.push({ type: '初始位', affix: rx.initialForced });
  }
  for (const r of required) {
    const members = membersOf(r);
    const occ = members.reduce((acc, x) => acc + (initial === x ? 1 : 0) + tunings.filter((t) => t === x).length, 0);
    const d = Math.max(0, r.count - occ);
    if (d > 0) {
      m += d;
      missing.push({ type: r.any_of ? '任选' : '数量', affix: r.any_of ?? r.affix, deficit: d });
    }
  }
  return { k, m, invalid, missing };
}

/** 枚举候选：不转 + 调律转律（至多改 1 条；已标记转律位的装备只能继续转那一条——用户定稿） */
function enumerateCandidates(rx, initial, tunings, converted = []) {
  const out = [{ conversion: null, ...evalState(rx, initial, tunings) }];
  const markedIdx = converted.indexOf(true);
  for (let j = 0; j < tunings.length; j++) {
    if (markedIdx >= 0 && j !== markedIdx) continue;
    const rest = tunings.filter((_, i) => i !== j);
    for (const to of rx.conversionPool) {
      if (rest.includes(to)) continue; // 调律互不重复（可与初始重复）
      const vt = tunings.map((t, i) => (i === j ? to : t));
      out.push({ conversion: { from: tunings[j], to, index: j }, ...evalState(rx, initial, vt) });
    }
  }
  return out;
}

function lexLess(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  if (a[2] !== b[2]) return a[2] < b[2];
  return a[3] < b[3];
}

/** 评价一件装备在给定部位、给定配额推导结果下的匹配度（部位=武器 时在左右两个武器槽位间取最优） */
export function gradeItem(prescription, slotName, item) {
  const arrangements = prescription?.arrangements || [];
  const slotKeys = resolveSlotKeys(slotName);
  if (!arrangements.length || !slotKeys.some((sk) => arrangements.some((a) => a.slots[sk]))) {
    return { ok: false, errors: [`未知部位或 prescription 缺少该部位的排列数据：${slotName}`] };
  }

  const initial = canonicalAffix(item.initial);
  const tunings = (item.tunings || []).map(canonicalAffix);
  const converted = (item.converted || []).map((c) => !!c);
  if (tunings.length !== 4) {
    return { ok: false, errors: [`调律词条需 4 条，实际 ${tunings.length} 条（不完整装备不做可靠评价）`] };
  }
  if (new Set(tunings).size !== tunings.length) {
    return { ok: false, errors: ['调律词条互相重复，不是合法装备（调律词条之间不能重复）'] };
  }

  const units = [{ position: 'initial', affix: initial }, ...tunings.map((a) => ({ position: 'tuning', affix: a }))];

  // —— 按排列×槽位评分，取 (k, m, 转律代价) 字典序最优 ——
  const pairs = [];
  for (const arr of arrangements) {
    for (const sk of slotKeys) {
      const rx = arr.slots[sk];
      if (!rx) continue;
      const initialPoolSet = new Set(rx.initialPool);
      const tuningPoolSet = new Set(rx.tuningPool);
      // 兼容性：装备的每个单元都必须在该排列的池中（错型指定增 ⇒ 该排列对这件装备不存在）
      const compatible = units.every((u) => (u.position === 'initial'
        ? initialPoolSet.has(u.affix)
        : tuningPoolSet.has(u.affix)));
      if (!compatible) continue;
      for (const cand of enumerateCandidates(rx, initial, tunings, converted)) {
        pairs.push({
          arr, rx, ...cand,
          score: [cand.k, cand.m, cand.conversion ? 1 : 0,
            cand.conversion ? cand.conversion.index : 0,
            cand.conversion ? cand.conversion.to : ''],
        });
      }
    }
  }
  if (!pairs.length) {
    return {
      ok: false,
      errors: ['词条组合与任何武器排列矛盾（如一把武器同时携带两条指定武学增伤——指定增跟武器类型走）'],
    };
  }
  pairs.sort((a, b) => (lexLess(a.score, b.score) ? -1 : lexLess(b.score, a.score) ? 1 : 0));
  const best = pairs[0];
  const rx = best.rx;

  const tier = best.k === 0 ? (best.m === 0 ? '天' : '地') : (best.k === 1 ? '玄' : '黄');
  const needsConversion = !!best.conversion;

  const notes = [], warnings = [];
  const markedIdx = converted.indexOf(true);
  if (markedIdx >= 0) notes.push(`已转律：仅调律${markedIdx + 1}可再转律`);
  if (best.conversion) {
    notes.push(`转律建议：${best.conversion.from} → ${best.conversion.to}${best.k === 0 && best.m === 0 ? '（即可毕业）' : ''}`);
  }
  if (best.invalid.some((u) => u.position === 'initial')) {
    notes.push('存在初始位无效词条：初始词条无法转律，档次无法通过转律提升');
  }
  if (needsConversion && SHENLI_AFFIXES.has(best.conversion.from)) {
    warnings.push(`「${best.conversion.from}」是神力词条，转掉永久损失（转律池不含神力），请确认后再转`);
  }
  if (needsConversion && SHENLI_AFFIXES.has(best.conversion.to)) {
    warnings.push('转律池不含神力词条，此目标不可达（不应出现，请检查数据）');
  }

  // —— 全局可行性精确复核（基于最优排列 + 转律后状态） ——
  const verifyItem = best.conversion
    ? { initial, tunings: tunings.map((t, i) => (i === best.conversion.index ? best.conversion.to : t)) }
    : { initial, tunings };
  let globalFitVerified = null;
  try {
    globalFitVerified = verifyItemFits(prescription, slotName, verifyItem);
  } catch (e) {
    globalFitVerified = null;
    warnings.push(`全局复核异常：${e.message}`);
  }
  if (globalFitVerified === false) {
    warnings.push('结构档位达标，但其余 7 部位无法补齐配额（局部必备/自由是必要条件，此处为精确复核结果）');
  }

  return {
    ok: true,
    slot: slotName,
    buildId: prescription.buildId ?? null,
    flowId: prescription.flowId ?? null,
    flowName: prescription.flowName ?? null,
    tier,
    substate: tier === '天' && needsConversion ? '天·需1次转律' : null,
    k: best.k,
    m: best.m,
    needsConversion,
    conversion: best.conversion,
    invalidAffixes: best.invalid,
    missing: best.missing,
    globalFitVerified,
    notes,
    warnings,
    errors: [],
    口径: '转律最优解后的 (k,m) 字典序评档（按可兼容武器排列取最优）；roll 数值不入档；定音不入档',
  };
}

// ———— 潜力评分（录入中的不完整装备） ————

/** 单个排列下的最优填充：空位从池中挑最有利词条 + 已录调律允许至多 1 次转律（与 gradeItem 同口径；
 *  已标记转律位的装备只能转那一条——markedIdx 传入），取 (k, m, 转律次数) 字典序最优 */
function bestFillState(rx, initial, tuningsIn, markedIdx = -1) {
  const initialPool = rx.initialPool || [];
  const tuningPool = rx.tuningPool || [];
  const conversionPool = rx.conversionPool || [];
  const conversionSet = new Set(conversionPool);
  const validSet = new Set([...(rx.required || []).flatMap(membersOf), ...rx.freeSet]);
  const reqMembers = [...new Set((rx.required || []).flatMap(membersOf))];

  // 有用目标 = 必备行成员（可减 m）；"任意有效词条"与占用情况相关，用占位符惰性物化
  const FILL_ANY = '\u0000FILL'; // 空位 → 未占用的调律池词条（优先有效集内）
  const CONV_ANY = '\u0000CONV'; // 转律 → 未占用的转律池词条（优先有效集内）
  const fillInitial = reqMembers.filter((a) => initialPool.includes(a));
  const fillTuning = reqMembers.filter((a) => tuningPool.includes(a));
  const convTuning = reqMembers.filter((a) => conversionSet.has(a));
  const fillerInitial = initialPool.find((a) => validSet.has(a)) || initialPool[0] || '';

  // 每个位置的候选值：0=初始位，1..4=调律位
  const options = [
    initial ? [initial] : [...new Set([...(rx.initialForced ? [rx.initialForced] : []), ...fillInitial, fillerInitial].filter(Boolean))],
  ];
  for (let i = 0; i < 4; i++) {
    const cur = tuningsIn[i];
    if (cur) {
      const opts = [cur]; // 保留不转
      if (markedIdx < 0 || markedIdx === i) { // 已标记转律位时，其余词条不能再转（用户定稿）
        for (const a of convTuning) if (a !== cur) opts.push(a); // 转律到有用目标（减 m）
        if (!validSet.has(cur) && conversionPool.length) opts.push(CONV_ANY); // 无效词条转成任意有效目标（减 k）
      }
      options.push(opts);
    } else {
      options.push([...new Set(fillTuning).add(FILL_ANY)]); // 空位：有用目标或任意未占用有效词条
    }
  }

  /** 从池中挑一个未占用词条：优先有效集内（彼此等价），否则任意（诚实计 k） */
  const pickUnused = (pool, used) => {
    let fallback = '';
    for (const a of pool) {
      if (used.has(a)) continue;
      if (validSet.has(a)) return a;
      if (!fallback) fallback = a;
    }
    return fallback;
  };

  let best = null;
  const raw = new Array(5).fill('');
  const dfs = (p, usedTuning, convCount) => {
    if (p === 5) {
      // 物化占位符（同类候选彼此等价，贪心逐个解析不影响最优性）
      const values = raw.slice();
      const used = new Set(values.filter((v) => v && v !== FILL_ANY && v !== CONV_ANY));
      let feasible = true;
      for (let i = 1; i <= 4 && feasible; i++) {
        if (values[i] === FILL_ANY) {
          const v = pickUnused(tuningPool, used);
          if (!v) { feasible = false; break; }
          values[i] = v; used.add(v);
        }
      }
      for (let i = 1; i <= 4 && feasible; i++) {
        if (values[i] === CONV_ANY) {
          const v = pickUnused(conversionPool, used);
          if (!v) { feasible = false; break; }
          values[i] = v; used.add(v);
        }
      }
      if (!feasible) return;
      const finalConversions = [];
      for (let i = 0; i < 4; i++) {
        if (tuningsIn[i] && values[i + 1] !== tuningsIn[i]) finalConversions.push({ from: tuningsIn[i], to: values[i + 1] });
      }
      const st = evalState(rx, values[0], values.slice(1));
      const score = [st.k, st.m, finalConversions.length];
      if (!best || lexLess(score, best.score)) best = { ...st, conversions: finalConversions, score };
      return;
    }
    for (const v of options[p]) {
      if (p >= 1) {
        if (v !== FILL_ANY && v !== CONV_ANY && usedTuning.has(v)) continue; // 调律互不重复（可与初始重复）
        const from = tuningsIn[p - 1];
        const isConv = !!(from && v !== from);
        if (isConv && convCount >= 1) continue; // 转律至多 1 次（gradeItem 同口径）
        raw[p] = v;
        usedTuning.add(v);
        dfs(p + 1, usedTuning, convCount + (isConv ? 1 : 0));
        usedTuning.delete(v);
      } else {
        raw[p] = v;
        dfs(p + 1, usedTuning, convCount);
      }
    }
  };
  dfs(0, new Set(), 0);
  return best;
}

/**
 * 单件潜力评分（录入中的不完整装备）：
 * 已录词条固定，空位按"最优填充"补齐、已录调律允许转律，取 (k, m, 转律次数) 字典序最优，
 * 映射到与 gradeItem 相同的天地玄黄档位 —— 即"当前词条下这件装备最高能到什么档"。
 * 口径：初始位无效词条无法转律，会永久压低潜力上限；roll 数值与定音不入潜力档；
 * 全局精确复核（verifyItemFits）只对完整装备做，潜力阶段不复核。
 */
export function gradeItemPotential(prescription, slotName, partial) {
  const arrangements = prescription?.arrangements || [];
  const slotKeys = resolveSlotKeys(slotName);
  if (!arrangements.length || !slotKeys.some((sk) => arrangements.some((a) => a.slots[sk]))) {
    return { ok: false, errors: [`未知部位或 prescription 缺少该部位的排列数据：${slotName}`] };
  }
  const initial = partial?.initial ? canonicalAffix(partial.initial) : '';
  const tuningsIn = (partial?.tunings || []).map((t) => (t ? canonicalAffix(t) : '')).slice(0, 4);
  while (tuningsIn.length < 4) tuningsIn.push('');
  const converted = (partial?.converted || []).map((c) => !!c);
  const markedIdx = converted.indexOf(true);
  const enteredCount = (initial ? 1 : 0) + tuningsIn.filter(Boolean).length;
  if (enteredCount === 0) {
    return { ok: true, slot: slotName, empty: true, enteredCount: 0, tier: null, errors: [], 口径: '未录入词条，无潜力可评' };
  }

  let best = null;
  for (const arr of arrangements) {
    for (const sk of slotKeys) {
      const rx = arr.slots[sk];
      if (!rx) continue;
      // 兼容性：已录入单元必须在该排列的池中（错型指定增 ⇒ 该排列对这件装备不存在）
      const initialPoolSet = new Set(rx.initialPool);
      const tuningPoolSet = new Set(rx.tuningPool);
      const compatible = [
        ...(initial ? [{ position: 'initial', affix: initial }] : []),
        ...tuningsIn.filter(Boolean).map((a) => ({ position: 'tuning', affix: a })),
      ].every((u) => (u.position === 'initial' ? initialPoolSet.has(u.affix) : tuningPoolSet.has(u.affix)));
      if (!compatible) continue;
      const cand = bestFillState(rx, initial, tuningsIn, markedIdx);
      if (cand && (!best || lexLess(cand.score, best.score))) best = { ...cand, rx };
    }
  }
  if (!best) {
    return { ok: false, enteredCount, errors: ['已录入词条与任何武器排列矛盾（如一把武器同时携带两条指定武学增伤）'] };
  }

  const tier = best.k === 0 ? (best.m === 0 ? '天' : '地') : (best.k === 1 ? '玄' : '黄');
  const notes = [], warnings = [];
  if (markedIdx >= 0) notes.push(`已转律：仅调律${markedIdx + 1}可再转律`);
  if (best.conversions.length) {
    notes.push(`潜力按最优转律计（${best.conversions.length} 次：${best.conversions.map((c) => `${c.from}→${c.to}`).join('、')}）`);
  }
  for (const c of best.conversions) {
    if (SHENLI_AFFIXES.has(c.from)) warnings.push(`「${c.from}」是神力词条，转掉永久损失（转律池不含神力）`);
  }
  if (best.invalid.some((u) => u.position === 'initial')) {
    notes.push('初始位词条不在毕业需求内且无法转律——潜力上限被永久压低');
  }

  return {
    ok: true,
    slot: slotName,
    buildId: prescription.buildId ?? null,
    flowId: prescription.flowId ?? null,
    flowName: prescription.flowName ?? null,
    tier,
    substate: tier === '天' && best.conversions.length ? '天·需1次转律' : null,
    k: best.k,
    m: best.m,
    enteredCount,
    conversions: best.conversions,
    invalidAffixes: best.invalid,
    missing: best.missing,
    notes,
    warnings,
    errors: [],
    口径: '潜力 = 已录词条固定、空位最优填充+转律后的最高档位（(k,m) 字典序，按可兼容武器排列取最优）；roll 数值与定音不入档',
  };
}
