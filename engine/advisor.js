'use strict';

/**
 * advisor.js — 系统①匹配度：单件装备词条匹配度（纯函数、无 IO）
 *
 * 设计（评价系统设计.md §4 / 数据架构盘点.md 议题A）：
 *   - roll 数值完全不入档（承音收敛；数值差异由 ΔDPS 系统承载）
 *   - prescription 按武器排列给出多套 per-排列 prescriptions（指定增跟武器类型走、
 *     类型跨左右槽自由排列——用户确认）；评分对"装备可兼容的排列"取 (k,m) 最优
 *   - 必备集合支持 any_of 组需求（如"恰好 1 条本武器类型的指定增"）
 *   - 档位只有天地玄黄四档（用户定稿：不存在"天·需转律"这类子状态）：
 *       完整装备按「当前词条」评定：天=(0,0) / 地=(0,≥1) / 玄=k=1 / 黄=k≥2；
 *       转律能升到哪档由 notes/tierAfter 单独说明，不并入档位。
 *       录入中的装备（潜力）= 空位最优填充 + 至多 1 次转律后的可达档位。
 *   - 一件装备的词条组合与任何排列矛盾（如一把武器两条指定增）→ 物理不可能，拒绝评分
 *   - 定音不入档（可随意变音），仅提示；评档后用 verifyItemFits 做全局精确复核
 */

import { canonicalAffix, verifyItemFits, verifyGearFits, demandAffixesOf, lookupAffixRange } from './quota.js';
import { transformedItem } from './transform.js';
import { quotaCensus } from './monitor.js';

// 词条元数据（别名表/神力清单）随 prescription 传递（单一来源 = affixes JSON）；
// 手工构造的 prescription 缺元数据时按"无别名/无神力"降级处理。
const metaOf = (prescription) => ({
  aliasMap: prescription?._aliasMap || {},
  shenli: prescription?._shenli || new Set(),
});

const ARMOR_SLOTS = new Set(['冠胄', '胸甲', '胫甲', '腕甲']);

// 武器不分左右（用户定稿 2026-10-27）：游戏只有两个武器槽，槽位身份 = 流派绑定的武器类型。
// 录入/评价部位 = 武器；引擎在 武器1/武器2 两槽间取最优。装备若声明了 weaponType（剑/枪），
// 只匹配该类型的槽位——否则"无指定增的剑"会被当成枪槽而漏掉剑增必备（曾误判天档）。
const TIER_RANK = { 天: 3, 地: 2, 玄: 1, 黄: 0 };

/**
 * 转律不得「用一个必备换另一个必备」——转后不能新增/加大任何一条**本槽必备缺口**。
 *
 * 背景（2026-11-01 玩家实测）：裂石钧·纯唐轴·小外流，胫甲已缺「敏」（地档，m=1），
 * 而其余四个词条里「最小外功攻击」是本槽必备。把这条必备转成「敏」后 m 仍是 1
 * （洞从敏挪到小外），`(k,m)` 比较完全看不出问题，于是被判成合格候选 —— 甚至因为
 * 能让「敏」这一行缺口变少而被判成"全局必需"。玩家看到的建议是"把小外转成敏"，
 * 而小外是必备，照做只会换来另一个缺口。
 *
 * 判据：按**词条身份**（而非总数 m）比较转前/转后的必备缺口，任何一条变多即否决。
 *
 * @param before gradeItem/stateOf 的 `missing` 数组（转前）
 * @param after  同上（转后）
 */
/**
 * 配额行级 Pareto：转律**不能让任何一行的缺口变大**。
 *
 * 只看「缺口总数变小」是不够的 —— 把 A 行的洞挪成 B 行的洞，总数不变但一行变差。
 * 这类"拆东墙补西墙"在总数上看不出来，在玩家眼里就是"转了跟没转一样，还多烧一次材料"。
 *
 * @param before quotaCensus().rows（转前）
 * @param after  同上（转后）
 */
export function noRowWorse(before, after) {
  if (!before || !after) return true; // 拿不到行级数据就不拦
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) if ((after[i].缺口 ?? 0) > (before[i].缺口 ?? 0)) return false;
  return true;
}

export function noNewRequiredGap(before, after) {
  const norm = (list) => {
    const m = new Map();
    for (const x of list || []) {
      const key = Array.isArray(x.affix) ? [...x.affix].sort().join('/') : String(x.affix);
      m.set(key, (m.get(key) || 0) + (x.deficit ?? 1));
    }
    return m;
  };
  const b = norm(before);
  for (const [key, deficit] of norm(after)) if (deficit > (b.get(key) || 0)) return false;
  return true;
}
const WEAPON_SLOT_KEY = '武器';
const WEAPON_SLOT_KEYS = ['武器1', '武器2'];
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
  const units = [{ position: 'initial', affix: initial }, ...tunings.map((a, i) => ({ position: 'tuning', index: i, affix: a }))];
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

  const { aliasMap, shenli } = metaOf(prescription);
  const initial = canonicalAffix(item.initial, aliasMap);
  const tunings = (item.tunings || []).map((t) => canonicalAffix(t, aliasMap));
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
  const itemType = item?.weaponType ? canonicalAffix(item.weaponType, aliasMap) : '';
  for (const arr of arrangements) {
    for (const sk of slotKeys) {
      const rx = arr.slots[sk];
      if (!rx) continue;
      if (itemType && rx.weaponType && rx.weaponType !== itemType) continue; // 剑只匹配剑槽
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

  // 等阶只按「当前词条」评定（用户定稿：等阶只有天地玄黄四档，不存在"天·需转律"这类子状态）；
  // 转律能升到哪一档，由 notes 单独说明，不并入等阶本身。
  const cur = evalState(rx, initial, tunings);
  const tierOf = (s) => (s.k === 0 ? (s.m === 0 ? '天' : '地') : (s.k === 1 ? '玄' : '黄'));
  const tier = tierOf(cur);
  const needsConversion = !!best.conversion;
  const tierAfter = needsConversion ? tierOf(best) : null;

  const notes = [], warnings = [];
  // 建议门槛（用户定稿 2026-10-30）：转后能到天阶才写这条建议（转完仍是地/玄/黄的不给，太泛滥）。
  // `conversion / tierAfter` 字段照旧给出——它们是结构化数据，与"要不要建议"是两件事。
  if (best.conversion && tierAfter === '天') {
    notes.push(`转律建议：把「${best.conversion.from}」转成「${best.conversion.to}」，等阶 ${tier} → ${tierAfter}`);
  }
  if (cur.invalid.some((u) => u.position === 'initial')) {
    notes.push('存在宫位（初始位）无效词条：宫位词条无法转律，等阶无法通过转律提升');
  }
  if (needsConversion && shenli.has(best.conversion.from)) {
    warnings.push(`「${best.conversion.from}」是神力词条，转掉永久损失（转律池不含神力），请确认后再转`);
  }
  if (needsConversion && shenli.has(best.conversion.to)) {
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
  // 注：`globalFitVerified === false` 不再单独 push 警告。
  // 它与档位行上的「其余部位补不齐配额」是**同一条事实**，两处都显示等于说两遍；
  // 且 `结构档位达标` 的措辞在黄档（实测 24080 组全部未通过）是错的。展示统一交给 UI。

  return {
    ok: true,
    slot: slotName,
    buildId: prescription.buildId ?? null,
    flowId: prescription.flowId ?? null,
    flowName: prescription.flowName ?? null,
    tier,
    tierAfter,
    k: cur.k,
    m: cur.m,
    needsConversion,
    conversion: best.conversion,
    invalidAffixes: cur.invalid,
    missing: cur.missing,
    globalFitVerified,
    notes,
    warnings,
    errors: [],
    口径: '等阶按当前词条评定（(k,m) 字典序，按可兼容武器排列取最优）；转律建议另给出转后等阶 tierAfter；roll 数值不入档；定音不入档',
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
  const { aliasMap, shenli } = metaOf(prescription);
  const initial = partial?.initial ? canonicalAffix(partial.initial, aliasMap) : '';
  const tuningsIn = (partial?.tunings || []).map((t) => (t ? canonicalAffix(t, aliasMap) : '')).slice(0, 4);
  while (tuningsIn.length < 4) tuningsIn.push('');
  const converted = (partial?.converted || []).map((c) => !!c);
  const markedIdx = converted.indexOf(true);
  const enteredCount = (initial ? 1 : 0) + tuningsIn.filter(Boolean).length;
  if (enteredCount === 0) {
    return { ok: true, slot: slotName, empty: true, enteredCount: 0, tier: null, errors: [], 口径: '未录入词条，无潜力可评' };
  }

  let best = null;
  const itemType = partial?.weaponType ? canonicalAffix(partial.weaponType, aliasMap) : '';
  for (const arr of arrangements) {
    for (const sk of slotKeys) {
      const rx = arr.slots[sk];
      if (!rx) continue;
      if (itemType && rx.weaponType && rx.weaponType !== itemType) continue; // 剑只匹配剑槽
      // 兼容性：已录入单元必须在该槽位的池中（错型指定增 ⇒ 该槽位对这件装备不存在）
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

  // 等阶口径（用户定稿）：
  //   已录满 5 条 ⇒ 按「当前词条」评档，与 gradeItem 完全一致（等阶不含转律），
  //                  转律只作为建议单独说明——否则会出现"录入时显示天、入包后变地"的割裂；
  //   未录满     ⇒ 空位最优填充 + 至多 1 次转律后的可达档位（潜力本义）。
  const complete = enteredCount === 5;
  const tierOf = (s) => (s.k === 0 ? (s.m === 0 ? '天' : '地') : (s.k === 1 ? '玄' : '黄'));
  const base = complete ? evalState(best.rx, initial, tuningsIn) : best;
  const tier = tierOf(base);
  const tierAfter = complete && best.conversions.length ? tierOf(best) : null;

  const notes = [], warnings = [];
  if (best.conversions.length) {
    if (complete) {
      // 与 gradeItem 同门槛（2026-10-30）：转后能到天阶才写建议
      if (tierAfter === '天') {
        notes.push(`转律建议：把「${best.conversions[0].from}」转成「${best.conversions[0].to}」，等阶 ${tier} → ${tierAfter}`);
      }
    } else {
      notes.push(`潜力按最优转律计（${best.conversions.length} 次：${best.conversions.map((c) => `${c.from}→${c.to}`).join('、')}）`);
    }
  }
  for (const c of best.conversions) {
    if (shenli.has(c.from)) warnings.push(`「${c.from}」是神力词条，转掉永久损失（转律池不含神力）`);
  }
  if (base.invalid.some((u) => u.position === 'initial')) {
    notes.push(complete
      ? '宫位（初始位）词条不在毕业需求内且无法转律——等阶无法通过转律提升'
      : '宫位（初始位）词条不在毕业需求内且无法转律——潜力上限被永久压低');
  }

  return {
    ok: true,
    slot: slotName,
    buildId: prescription.buildId ?? null,
    flowId: prescription.flowId ?? null,
    flowName: prescription.flowName ?? null,
    tier,
    tierAfter,
    k: base.k,
    m: base.m,
    enteredCount,
    conversions: best.conversions,
    invalidAffixes: base.invalid,
    missing: base.missing,
    notes,
    warnings,
    errors: [],
    口径: complete
      ? '等阶按当前词条评定（与匹配度同口径）；转律建议另给出转后等阶；roll 数值与定音不入档'
      : '潜力 = 已录词条固定、空位最优填充+转律后的最高档位（(k,m) 字典序，按可兼容武器排列取最优）；roll 数值与定音不入档',
  };
}

// ———— 全局感知转律建议（用户定稿 2026-10-28） ————

/**
 * 只评「当前词条」的档位与 (k, m)，不枚举转律候选（比 gradeItem 轻）。
 * 与 gradeItem 同口径：按 weaponType 只匹配本类型武器槽，跨槽取 (k,m) 字典序最优。
 */
export function stateOf(prescription, slotName, item) {
  const arrangements = prescription?.arrangements || [];
  const slotKeys = resolveSlotKeys(slotName);
  if (!arrangements.length || !slotKeys.some((sk) => arrangements.some((a) => a.slots[sk]))) {
    return { ok: false, errors: [`未知部位或 prescription 缺少该部位的槽位数据：${slotName}`] };
  }
  const { aliasMap } = metaOf(prescription);
  const initial = canonicalAffix(item?.initial, aliasMap);
  const tunings = (item?.tunings || []).map((t) => canonicalAffix(t, aliasMap));
  if (tunings.length !== 4) return { ok: false, errors: [`调律词条需 4 条，实际 ${tunings.length} 条（不完整装备不做可靠评价）`] };
  if (new Set(tunings).size !== tunings.length) return { ok: false, errors: ['调律词条互相重复，不是合法装备'] };

  const itemType = item?.weaponType ? canonicalAffix(item.weaponType, aliasMap) : '';
  const units = [{ position: 'initial', affix: initial }, ...tunings.map((a) => ({ position: 'tuning', affix: a }))];

  let best = null, bestRx = null;
  for (const arr of arrangements) {
    for (const sk of slotKeys) {
      const rx = arr.slots[sk];
      if (!rx) continue;
      if (itemType && rx.weaponType && rx.weaponType !== itemType) continue; // 剑只匹配剑槽
      const initialPoolSet = new Set(rx.initialPool);
      const tuningPoolSet = new Set(rx.tuningPool);
      const compatible = units.every((u) => (u.position === 'initial' ? initialPoolSet.has(u.affix) : tuningPoolSet.has(u.affix)));
      if (!compatible) continue;
      const st = evalState(rx, initial, tunings);
      if (!best || lexLess([st.k, st.m], [best.k, best.m])) { best = st; bestRx = rx; }
    }
  }
  if (!best) return { ok: false, errors: ['词条组合与任何武器槽位矛盾（如一把武器同时携带两条指定武学增伤）'] };
  const tierOf = (s) => (s.k === 0 ? (s.m === 0 ? '天' : '地') : (s.k === 1 ? '玄' : '黄'));
  return {
    ok: true, slot: slotName, tier: tierOf(best), k: best.k, m: best.m,
    missing: best.missing, invalid: best.invalid,
    conversionPool: bestRx?.conversionPool || [],
  };
}

/**
 * 全局感知的转律建议（2026-11-01 大修，见 评价系统设计.md §11.6）
 *   - **等阶由当前词条决定**（局部）；转律建议另算，不并入等阶；
 *   - **门槛 = `Δ转后` 超死区**（不再是"转后必须到天阶"）：
 *     旧门槛会产出负收益建议——实测破竹风大外流·胫甲，地档缺劲件现状 +3.28%，
 *     转「会心率」→「劲」后掉到 +1.29%（转后到天但净损 2pp）；
 *   - 有 `dpsOf` ⇒ 逐候选实算 ΔDPS，取超死区者；无 `dpsOf` ⇒ **降级为"只给救废型"**
 *     （k 减少 = 消灭无效词条，收益必然为正）；
 *   - 排序：**DPS 主序、全局配额缺口为次**（配额是"最准"的，但这里已由 k/m 判定过结构，
 *     剩下能区分的是 DPS）；DPS 差落在死区内 → **并列列出**；
 *   - 结构型（档位升到天）/ 优化型（已是天档）分开标注；
 *   - 已标记转律位时只能继续转那一条（与 gradeItem 同口径）；
 *   - 无建议时 `门槛` 说明被卡在哪一条上。
 *
 * 候选空间：至多 1 条转律 ⇒ 4 调律位 × 转律池 ≈ 40~60 个，**全枚举**，不存在贪心近似问题。
 *
 * @param prescription 当前方案的 derivePrescription 结果
 * @param slotName     部位（武器 / 环 / 冠胄 / …）
 * @param item         { weaponType?, initial, tunings[4], converted?[4] }
 * @param opts.gear    当前整套装备（含本件），格式同 monitor.quotaCensus 期待的装备件
 * @param opts.flow    方案对象（quota）
 * @param opts.dpsOf   可选 (gear) => number；**强烈建议传**，不传则只能给救废型
 * @param opts.deadZone 相对阈值（默认 0.005），Δ 在此内视为没提升
 */
export function adviseConversion(prescription, slotName, item, opts = {}) {
  const { gear = null, flow = null, dpsOf = null, deadZone = 0.005, uid = null, affixes = null } = opts;
  const cur = stateOf(prescription, slotName, item);
  if (!cur.ok) return { ok: false, errors: cur.errors, suggestions: [] };
  if (!gear || !flow) {
    return { ok: false, errors: ['全局转律建议需要 gear（当前整套装备）与 flow（方案配额）'], suggestions: [] };
  }
  const aliasMap = metaOf(prescription).aliasMap;
  const rowsOf = (g) => {
    try { return quotaCensus(g, flow, aliasMap).rows; } catch { return null; }
  };
  const gapOf = (rows) => (rows || []).reduce((a, r) => a + (r.缺口 ?? 0), 0);

  // 定位本件在整套装备中的位置：**uid 优先**（同类型多件时按类型会找错，见 §12.4），
  // 次选武器按类型、防具按部位。
  const isWeaponSlot = slotName === WEAPON_SLOT_KEY || WEAPON_SLOT_KEYS.includes(slotName);
  let idx = uid ? gear.findIndex((g) => g?.uid != null && g.uid === uid) : -1;
  if (idx < 0) {
    idx = isWeaponSlot
      ? gear.findIndex((g) => (g.slot === WEAPON_SLOT_KEY || WEAPON_SLOT_KEYS.includes(g.slot))
          && String(g?.weaponType ?? '') === String(item?.weaponType ?? ''))
      : gear.findIndex((g) => g.slot === slotName);
  }
  if (idx < 0) return { ok: false, errors: [`当前整套装备里找不到本件（部位=${slotName}）`], suggestions: [] };

  const initial = canonicalAffix(item?.initial, aliasMap);
  const tunings = (item?.tunings || []).map((t) => canonicalAffix(t, aliasMap));
  const converted = (item?.converted || []).map((c) => !!c);
  const markedIdx = converted.indexOf(true);

  // —— 数值口径：词条变了，数值必须按**目标词条**重取（承音值优先）——
  // 旧实现只改 `属性`、沿用原位置的 `数值`，于是"小外(131.2) → 敏"会拿 131.2 当敏、
  // 虚高 58%；"外功防御(65.6) → 敏"会拿 65.6 当敏、虚低 21%。两个候选的 ΔDPS 直接反序
  // （实测：前者 +2.04%、后者 +1.71%，而正确取值下是 +0.93% / +2.12%）。
  const affixData = affixes || prescription?._affixes || null;
  const valueOf = (name, fallback) => {
    const rr = affixData ? lookupAffixRange(affixData, name) : null;
    return rr ? (rr.承音 ?? rr.max) : fallback;
  };
  /** 把 piece 的词条写成 names（初始位写 initName），变了的按目标词条重取数值 */
  const retune = (piece, names, initName) => {
    let out = piece;
    if (initName && (out.初始 || {}).属性 !== initName) {
      out = {
        ...out,
        初始: { ...(out.初始 || {}), 属性: initName, 数值: valueOf(initName, out.初始?.数值 ?? 0) },
      };
    }
    (names || []).forEach((t, k) => {
      const prev = (out.调律 || [])[k] || {};
      if (prev.属性 === t) return;
      out = affixData
        ? transformedItem(out, { index: k, to: t }, affixData)
        : { ...out, 调律: (out.调律 || []).map((x, i) => (i === k ? { ...x, 属性: t } : x)) };
    });
    return out;
  };

  // 基准整套：本件按 item 的当前词条写回
  const baseGear = gear.map((g, i) => (i === idx ? retune(g, tunings, initial) : g));
  const mkTrial = (arr) => baseGear.map((g, i) => (i === idx ? retune(g, arr) : g));
  const rowsBefore = rowsOf(baseGear);
  const gapBefore = gapOf(rowsBefore);

  // —— 候选枚举：枚举全部单条转律（游戏机制：至多 1 条），不做贪心筛选 ——
  //   候选规模 = 4 调律位 × 转律池(≈10~15) ≈ 40~60，可以全枚举，不存在"贪心可能出问题"。
  //   结构门槛（2026-11-01，与"档位优先"同源）：
  //     a) 转后 (k, m) 任一变大 ⇒ 档位下降 ⇒ 直接否决（哪怕 DPS 更高）；
  //     b) 必须「消灭无效词条」或「减少全局配额缺口」二者其一 —— 否则就是纯拆东墙，
  //        哪怕 DPS 能涨也不给（配额是最准的判据，DPS 只用来在合格候选里排序）。
  const pool = cur.conversionPool || [];
  // 「当前这套（本件按现状）到底配不配得满」——必修判定的基准。
  // 注意：这里钉住**整包已穿件**，比 verifyItemFits 的"其余 7 部位自由规划"严格得多，
  // 转 A 与转 B 的差别常常不在缺口数，而在剩余空位塞不塞得下（例：劲缺 2 但只剩胸甲）。
  // 转律目标必须是本方案配额真正需求的词条（见 demandAffixesOf 注释）
  const 需求集 = demandAffixesOf(prescription);
  // 还有废词条时，只能转废词条（先把 k 降下来）；把有效词条转掉只会让 k 留着不动
  const 无效调律 = new Set((cur.invalid || []).filter((u) => u.position === 'tuning').map((u) => u.affix));
  const 当前可行 = verifyGearFits(prescription, baseGear);
  // 「还在凑装」= 还有空槽。只有这个阶段"转对了才能配满"才成立；
  // 8 件已满时缺口是静态事实，硬转只会拿 DPS 换配额完备度，不该判必修（交给 DPS 判）。
  const 有空槽 = baseGear.length < 8;
  const cands = [];
  for (let j = 0; j < tunings.length; j++) {
    if (markedIdx >= 0 && j !== markedIdx) continue;
    const from = tunings[j];
    if (cur.k > 0 && !无效调律.has(from)) continue; // 有废词条 ⇒ 只转废的那条
    for (const to of pool) {
      if (to === from) continue;
      if (需求集.size && !需求集.has(canonicalAffix(to, metaOf(prescription).aliasMap))) continue; // 不在配额需求内 ⇒ 转了也不改善装配
      if (tunings.some((t, k) => k !== j && t === to)) continue; // 调律互不重复（可与初始重复）
      const trialTunings = tunings.map((t, k) => (k === j ? to : t));
      const st = stateOf(prescription, slotName, { weaponType: item?.weaponType, initial, tunings: trialTunings });
      if (!st.ok) continue;
      const 救废 = st.k < cur.k; // k 减少 = 消灭无效词条 ⇒ 收益必然为正（无效词条贡献≈0）
      const 结构不退 = st.k <= cur.k && st.m <= cur.m;
      if (!结构不退) continue;
      // 转律后到不了天/地 ⇒ 不建议（玩家定稿 2026-11-01）——见 dispose.bestConversion 同款门槛
      if ((TIER_RANK[st.tier] ?? -1) < TIER_RANK.地) continue;
      // 不得「用一个必备换另一个必备」：m 总数不变但洞挪了位置
      if (!noNewRequiredGap(cur.missing, st.missing)) continue;
      const rowsAfter = rowsOf(mkTrial(trialTunings));
      const gapAfter = gapOf(rowsAfter);
      // 缺口要「整体变少」且「没有任何一行变差」（见 noRowWorse：禁止把洞挪个位置）
      const 缺口改善 = gapAfter < gapBefore && noRowWorse(rowsBefore, rowsAfter);

      // 转后整套是否配得满（钉住已穿件 + 本件转后形态）
      const trialPiece = retune(baseGear[idx], trialTunings);
      const gfit = verifyGearFits(prescription, baseGear.map((g, k) => (k === idx ? trialPiece : g)));
      const fitRank = gfit === true ? 0 : gfit === null ? 1 : 2;
      // 必修：现在配不满、这样转之后就能配满 ⇒ 结构上非转不可，DPS 没涨也得转
      const 必修 = 有空槽 && gfit === true && 当前可行 === false;

      cands.push({
        from, to, index: j,
        tierAfter: st.tier, kAfter: st.k, mAfter: st.m,
        救废, 缺口改善, gapAfter, gfit, fitRank, 必修,
      });
    }
  }

  // —— 门槛（2026-11-01 改，见 评价系统设计.md §11.6）——
  //   旧门槛「转后必须到天阶」会给出**负收益建议**（实测：破竹风大外流胫甲，地档缺劲件
  //   现状 +3.28%，转「会心率」→「劲」后掉到 +1.29%）。故改为按 DPS 判定：
  //   有 dpsOf ⇒ Δ转后 必须超死区（相对）；
  //   无 dpsOf ⇒ 降级为"只给救废型"（k 减少，收益必然为正）。
  let dpsBefore = null;
  if (typeof dpsOf === 'function') {
    dpsBefore = dpsOf(baseGear);
    for (const c of cands) {
      const trialTunings = tunings.map((t, k) => (k === c.index ? c.to : t));
      c.dpsAfter = dpsOf(mkTrial(trialTunings));
      c.dpsGain = c.dpsAfter - dpsBefore;
      c.deltaPct = dpsBefore > 0 ? c.dpsGain / dpsBefore : 0;
    }
  }

  // 入选资格（配额优先，DPS 只是其中一条）：
  //   必修  = 现在配不满、这样转就能配满 ⇒ 结构上非转不可（DPS 不涨也要转）
  //   救废  = k 减少（消灭无效词条）⇒ 收益必然为正
  //   DPS   = 超死区（补缺型靠这条把关）
  const kept = cands.filter((c) => c.必修
    || c.救废
    || (typeof dpsOf === 'function' && c.deltaPct > deadZone));

  if (!kept.length) {
    let 门槛;
    if (typeof dpsOf === 'function') 门槛 = '转律后 DPS 未超过死区（拆东墙或边际不足）';
    else if (cur.k > 0) 门槛 = '转律无法消除无效词条（可转位置受限）';
    else 门槛 = '无 DPS 依据时只建议消灭无效词条的转律；本件当前无无效词条';
    return {
      ok: true, tier: cur.tier, k: cur.k, m: cur.m, gapBefore, gapAfter: gapBefore,
      suggestions: [], 并列: false, dpsBefore, deadZone: typeof dpsOf === 'function' ? deadZone : null,
      门槛,
      口径: '等阶按当前词条评定；转律门槛 = Δ转后 超死区（无 dpsOf 时降级为"只给救废型"）；未达门槛不建议转律',
    };
  }

  // —— 排序（2026-11-01 修正）：**可行性 → 必修 → 缺口 → DPS** ——
  // 旧版把 DPS 放第一，会出现"转成敏 DPS 最高，但转成敏这套根本配不满"的错误建议。
  kept.sort((a, b) => {
    if (a.fitRank !== b.fitRank) return a.fitRank - b.fitRank;
    if (a.必修 !== b.必修) return a.必修 ? -1 : 1;
    if (a.gapAfter !== b.gapAfter) return a.gapAfter - b.gapAfter;
    if (typeof dpsOf === 'function' && b.dpsGain !== a.dpsGain) return b.dpsGain - a.dpsGain;
    return a.index - b.index;
  });
  const bestFit = kept[0].fitRank;
  const bestMust = kept[0].必修;
  let top = kept.filter((c) => c.fitRank === bestFit && c.必修 === bestMust);
  if (typeof dpsOf === 'function' && top.every((c) => typeof c.dpsAfter === 'number')) {
    const bestDps = Math.max(...kept.filter((c) => c.fitRank === bestFit && c.必修 === bestMust).map((c) => c.dpsAfter));
    top = top.filter((c) => Math.abs((bestDps - c.dpsAfter) / (bestDps || 1)) <= deadZone); // 死区内并列
  }

  const suggestions = top.map((c) => ({
    from: c.from, to: c.to, position: c.index,
    kind: cur.tier === '天' ? '优化型' : '结构型',
    tierAfter: c.tierAfter,
    kBefore: cur.k, kAfter: c.kAfter, mBefore: cur.m, mAfter: c.mAfter,
    救废: c.救废,
    gapBefore, gapAfter: c.gapAfter, gapReduce: gapBefore - c.gapAfter,
    dpsAfter: c.dpsAfter ?? null, dpsGain: c.dpsGain ?? null, deltaPct: c.deltaPct ?? null,
    必修: c.必修, 可行: c.gfit,
  }));

  return {
    ok: true, tier: cur.tier, k: cur.k, m: cur.m,
    gapBefore, gapAfter: top[0].gapAfter, suggestions, 并列: suggestions.length > 1,
    dpsBefore, deadZone: typeof dpsOf === 'function' ? deadZone : null, 门槛: null,
    口径: '转律至多 1 条 ⇒ 全枚举不贪心；门槛 = Δ转后 超死区（无 dpsOf 时降级为"只给救废型"）；DPS 主序、全局配额缺口为次；死区内并列列出；结构型=升天，优化型=已是天档',
  };
}

/**
 * 单件视角：枚举单条转律，返回**所有**能把档位提到 targetTier 的 (from, to)。
 * 不看全局缺口 —— 用于「跨方案」扫描（跨流派时其他部位仍是本流派装备，全局缺口不可比），
 * 也用于"并列平铺"时列出全部等价选择。
 */
export function routesToTier(prescription, slotName, item, targetTier = '天') {
  const cur = stateOf(prescription, slotName, item);
  if (!cur.ok) return { ok: false, errors: cur.errors, tier: null, routes: [] };
  const aliasMap = metaOf(prescription).aliasMap;
  const initial = canonicalAffix(item?.initial, aliasMap);
  const tunings = (item?.tunings || []).map((t) => canonicalAffix(t, aliasMap));
  const converted = (item?.converted || []).map((c) => !!c);
  const markedIdx = converted.indexOf(true);
  const routes = [];
  for (let j = 0; j < tunings.length; j++) {
    if (markedIdx >= 0 && j !== markedIdx) continue;
    const from = tunings[j];
    for (const to of cur.conversionPool || []) {
      if (to === from) continue;
      if (tunings.some((t, k) => k !== j && t === to)) continue; // 调律互不重复
      const trial = tunings.map((t, k) => (k === j ? to : t));
      const st = stateOf(prescription, slotName, { weaponType: item?.weaponType, initial, tunings: trial });
      if (st.ok && st.tier === targetTier) routes.push({ from, to, position: j });
    }
  }
  return { ok: true, tier: cur.tier, k: cur.k, m: cur.m, routes };
}

/**
 * 跨方案扫描：这件装备在**其他方案**下，哪些「当前即天档」/「转律后可达天档」。
 * 只返回这两类 —— 其他方案的地/玄/黄不提醒（用户定稿）。
 * 单件视角，不算全局缺口、不算 DPS（跨流派 DPS 不可比）。
 *
 * @param entries [{ key, label, rx }]，rx = 该方案的 derivePrescription 结果
 * @returns { 天档: [{key,label}], 可转天: [{key,label,tier,routes:[{from,to}]}] }
 */
export function surveyFlows(entries, slotName, item) {
  const 天档 = [], 可转天 = [];
  for (const e of entries || []) {
    if (!e?.rx) continue;
    const st = stateOf(e.rx, slotName, item);
    if (!st.ok) continue;
    if (st.tier === '天') { 天档.push({ key: e.key, label: e.label }); continue; }
    const r = routesToTier(e.rx, slotName, item, '天');
    if (r.ok && r.routes.length) 可转天.push({ key: e.key, label: e.label, tier: st.tier, routes: r.routes });
  }
  return { 天档, 可转天 };
}
