'use strict';

/**
 * swap.js — 系统③ΔDPS：单件替换对比（纯函数、无 IO）
 *
 * 流程（评价系统设计.md §6 / §12.2 武器桶模型）：
 *   录入新装备 → 识别槽位 → 找当前同槽位装备（无则视为空位）
 *   **同槽可能有多件**（双枪流派：一个类型桶容量 2）⇒ 逐件试换，取 ΔDPS 最优者为被替换者，
 *   输出 targetIndex / targetSlotKey / gearAfter（不能再靠 sameEquipKey 找"那一件"——
 *   同类型两件会被它认成同一件，导致替换时两把一起被删）
 *   → 当前装备 vs 替换后装备：各跑 panel.js → dps.js
 *   → Δ% = DPS后/DPS前 − 1 → 三档判定（死区 |Δ%|≤阈值 等价，可配，默认 0.5%；
 *      方案文件可经 flow.死区 覆盖默认值——由 inspect 层传入，盘点 §2.2 #9）
 *   → 等价时次级排序：匹配度档位 > 当前 DPS（跨档一律档位优先——承音会收敛 roll，
 *     档位代表长期价值；同档之间才比当前数值）
 *   → 面板差异解释（v1 = 面板差异级：哪些面板属性变了、方向如何）
 *   → 去向/收藏建议：被替换的旧件与未上台的新件按档位给出留/弃建议（防误删蒙尘宝物）
 *
 * 口径：
 *   - DPS 是内部裁决依据，结论不直接展示绝对 DPS 的"好坏"，只展示差值方向与幅度；
 *   - ΔDPS 对"流"无感（引擎 min/max 收敛自动处理小外反转）；
 *   - 死区内的 Δ% 属噪声级，这正是等价时引入档位次级排序的原因；
 *   - prescription 可选：提供则做档位次级排序与去向建议，不提供则仅按当前 DPS 排序。
 */

import { computePanel } from './panel.js';
import { calcDPS } from './dps.js';
import { gradeItem } from './advisor.js';

const TIER_RANK = { 天: 3, 地: 2, 玄: 1, 黄: 0 };

/** 计算一套装备的 DPS（computePanel → calcDPS，统一面板 schema 直通，无第二层转换） */
export function evalGearDps({ buildCtx, version, affixes, gear, selections, graduateDps }) {
  const pr = computePanel({
    version,
    affixes,
    build: { 流派: buildCtx.build.name },
    gear: gear || [],
    selections: selections || {},
  });
  const pi = buildCtx.build.panel_input || {};
  const override = {
    stats: pr.stats,
    五维达标率: pr.五维达标率,
    主属性达标率: pr.主属性达标率,
    // 固伤加成/食物属于 build 级战斗配置（非装备面板属性），沿用 build 基准值
    flatBonus: pi.flat_dmg_bonus ? pi.flat_dmg_bonus.default : 0,
    food: {
      ext: pi.food_ext ? pi.food_ext.default : 0,
      elem: pi.food_elem ? pi.food_elem.default : 0,
    },
  };
  const r = calcDPS(buildCtx, { panel: override, graduateDps, constants: version?.constants });
  return { panel: pr, dps: r.dps, graduationRate: r.graduationRate };
}

/** 面板差异解释：逐键 diff 两份 panel.stats（数值键），按绝对变化降序 */
export function diffPanels(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const rows = [];
  for (const k of keys) {
    const a = before?.[k];
    const b = after?.[k];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (Math.abs(b - a) < 1e-9) continue;
    rows.push({ 属性: k, 前: a, 后: b, 变化: b - a, 方向: b > a ? '↑' : '↓' });
  }
  rows.sort((x, y) => Math.abs(y.变化) - Math.abs(x.变化));
  return rows;
}

/** 装备件 → 匹配度输入形状 */
function toGradeItem(piece) {
  return {
    weaponType: piece?.weaponType || '', // 剑只匹配剑槽，缺此字段会漏判本槽必备
    initial: piece?.初始?.属性,
    tunings: (piece?.调律 || []).map((t) => t?.属性),
    converted: (piece?.调律 || []).map((t) => !!t?.转律),
    dingyin: piece?.定音?.属性,
  };
}

/**
 * 装备同一性：非武器按部位；武器不分左右（部位=武器，只是两个槽位）按类型——剑只与剑对比（用户定稿）。
 * 旧数据（部位=左武器/右武器）仍按部位相等处理，行为不变。
 */
export function sameEquipKey(a, b) {
  if (a?.slot !== b?.slot) return false;
  if (a?.slot !== '武器') return true;
  return String(a?.weaponType ?? '') === String(b?.weaponType ?? '');
}

function collectWorthOf(tier) {
  if (tier === '天') return '传家宝：必留，承音投到底';
  if (tier === '地') return '过渡主力：同槽出天再换';
  if (tier === '玄') return '无长期价值：当前槽位最优可先用，别再投入转律/承音';
  if (tier === '黄') return '无长期价值：临时用，可淘汰';
  return null;
}

/**
 * 单件替换对比。
 * @param {{
 *   buildCtx, version, affixes, selections,
 *   currentGear: Array,     // 当前实装（可少于 8 件，空位即缺该槽位）
 *   newItem: Object,        // 待评价的新装备（须含 slot）
 *   deadZone?: number,      // 等价死区 |Δ%|，默认 0.005（0.5%）
 *   prescription?: Object,  // 配额推导结果（可选，用于档位次级排序与去向建议）
 * }} input
 */
export function evaluateSwap({
  buildCtx, version, affixes, selections,
  currentGear, newItem,
  deadZone = 0.005,
  prescription = null,
  graduateDps,
}) {
  const errors = [];
  if (!newItem?.slot) errors.push('新装备缺少 slot（部位）');
  if (!Array.isArray(currentGear)) errors.push('currentGear 必须是装备数组');
  if (!buildCtx?.build?.name) errors.push('buildCtx 不完整（需 build.name）');
  if (errors.length) return { ok: false, errors };

  const slot = newItem.slot;
  // 同槽候选：非武器按部位；武器按**类型桶**（同一类型可能有多个槽，如双枪流派）
  const targets = currentGear
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => sameEquipKey(g, newItem));
  // 武器按类型对比：当前未穿戴该类型 ⇒ 无替换基准（不同类型不比较，用户定稿）
  if (slot === '武器' && !targets.length) {
    return {
      ok: false,
      errors: ['武器按类型对比：当前未穿戴同类型武器，无法替换对比（不同类型不比较）'],
    };
  }

  const before = evalGearDps({ buildCtx, version, affixes, gear: currentGear, selections, graduateDps });

  // 桶语义（评价系统设计.md §12.2）：桶内可能多件（双枪）⇒ 逐件试换，取 ΔDPS 最优者为被替换者。
  // 非武器空位（targets 为空）⇒ 直接追加。
  let targetIndex = -1;
  let after = null;
  if (!targets.length) {
    const gearAfter = [...currentGear, newItem];
    after = evalGearDps({ buildCtx, version, affixes, gear: gearAfter, selections, graduateDps });
  } else {
    let bestDps = -Infinity;
    for (const t of targets) {
      const cand = currentGear.map((g, i) => (i === t.i ? newItem : g));
      const r = evalGearDps({ buildCtx, version, affixes, gear: cand, selections, graduateDps });
      if (r.dps > bestDps) { bestDps = r.dps; targetIndex = t.i; after = r; }
    }
  }
  const gearAfter = targetIndex >= 0
    ? currentGear.map((g, i) => (i === targetIndex ? newItem : g))
    : [...currentGear, newItem];
  const oldItem = targetIndex >= 0 ? currentGear[targetIndex] : null;

  const deltaAbs = after.dps - before.dps;
  const deltaPct = before.dps > 0 ? deltaAbs / before.dps : 0;

  // —— 三档判定 ——
  let verdict;
  if (deltaPct > deadZone) verdict = '更好';
  else if (deltaPct < -deadZone) verdict = '更差';
  else verdict = '等价'; // 用户定稿文案：对外只报更好/更差/等价，不展示变化幅度

  // —— 档位（可选） ——
  let gradeNew = null;
  let gradeOld = null;
  if (prescription) {
    gradeNew = gradeItem(prescription, slot, toGradeItem(newItem));
    gradeOld = oldItem ? gradeItem(prescription, slot, toGradeItem(oldItem)) : { ok: true, tier: null, 空位: true };
  }
  const rankNew = gradeNew?.ok && gradeNew.tier ? TIER_RANK[gradeNew.tier] : null;
  const rankOld = gradeOld?.ok
    ? (gradeOld.tier ? TIER_RANK[gradeOld.tier] : (oldItem ? null : -1)) // 空位视为最低
    : null;

  // —— 等价次级排序：档位 > 当前 DPS ——
  let tieBreak = null;
  if (verdict === '等价') {
    if (rankNew != null && rankOld != null && rankNew !== rankOld) {
      tieBreak = rankNew > rankOld ? '新件档位更高' : '旧件档位更高';
    } else if (Math.abs(deltaAbs) > 1e-9) {
      tieBreak = deltaAbs > 0 ? '新件当前数值略优' : '旧件当前数值略优';
    } else {
      tieBreak = '完全并列';
    }
  }

  // —— 推荐结论 ——
  const swapRecommended =
    verdict === '更好' ||
    (verdict === '等价' && (
      tieBreak === '新件档位更高' ||
      tieBreak === '新件当前数值略优' ||
      (rankNew != null && rankOld === -1) // 相同 + 补空位且有档位
    ));
  let recommendation;
  if (verdict === '更好') recommendation = '建议替换';
  else if (verdict === '更差') recommendation = '保留旧件';
  else if (tieBreak === '新件档位更高') recommendation = '两件相当，但新件匹配度更高——建议替换（长期价值）';
  else if (tieBreak === '旧件档位更高') recommendation = '两件相当，但旧件匹配度更高——保留旧件';
  else if (tieBreak === '新件当前数值略优') recommendation = '两件相当，新件当前数值略优——可替换';
  else if (tieBreak === '旧件当前数值略优') recommendation = '两件相当，旧件当前数值略优——保留旧件';
  else recommendation = '两件完全相当——任意选择';

  // —— 去向/收藏建议（防误删蒙尘宝物） ——
  const newTier = gradeNew?.ok ? (gradeNew.tier ?? null) : null;
  const oldTier = gradeOld?.ok ? (gradeOld.tier ?? null) : null;
  let 旧件去向 = null;
  if (oldItem) {
    if (!swapRecommended) {
      旧件去向 = oldTier === '天' ? '旧件为传家宝，继续使用'
        : oldTier === '地' ? '旧件为过渡主力，继续使用'
        : oldTier ? '旧件继续使用（无长期价值，出更优再换）' : '旧件继续使用';
    } else {
      旧件去向 = oldTier === '天' ? '旧件是传家宝：虽被替换仍强烈建议留作候补'
        : oldTier === '地' ? '旧件为过渡主力：建议留作候补'
        : oldTier ? '旧件无长期价值：可淘汰'
        : '旧件去向按需处理';
    }
  }
  let 新件去向 = null;
  if (swapRecommended) {
    const w = collectWorthOf(newTier);
    新件去向 = w ? `新件上台：${w}` : '新件上台';
  } else {
    新件去向 = newTier === '天' ? '新件值得保留（候补）：传家宝，旧件退役后顶上'
      : newTier === '地' ? '新件值得保留（候补）：过渡主力'
      : newTier ? '新件无长期价值：可不留'
      : '按需保留';
  }
  const 候补 = !swapRecommended && (newTier === '天' || newTier === '地');

  return {
    ok: true,
    slot,
    buildId: buildCtx.build.id ?? null,
    targetIndex, // 被替换件在 currentGear 里的下标；-1 = 空位（未替换任何件）
    targetSlotKey: oldItem?.slotKey ?? null, // 被替换件的槽位 key（gear 件带 slotKey 时才有）
    gearAfter, // 替换后的整套装备（供整合层复用，保证与 ΔDPS 同一口径）
    replacedOld: !!oldItem,
    before: { dps: before.dps, graduationRate: before.graduationRate },
    after: { dps: after.dps, graduationRate: after.graduationRate },
    deltaAbs,
    deltaPct, // Δ% = DPS后/DPS前 − 1
    deadZone,
    verdict,
    recommendation,
    tieBreak,
    swapRecommended,
    gradingAvailable: !!prescription,
    gradeOld: gradeOld ? { tier: gradeOld.tier ?? null, k: gradeOld.k ?? null, m: gradeOld.m ?? null, 空位: !!gradeOld.空位 } : null,
    gradeNew: gradeNew ? { tier: gradeNew.tier ?? null, k: gradeNew.k ?? null, m: gradeNew.m ?? null } : null,
    旧件去向,
    新件去向,
    候补,
    panelDiff: diffPanels(before.panel.stats, after.panel.stats),
    afterPanelStats: after.panel.stats, // 供整合层做"假设穿上后"的监测（与 ΔDPS 同一面板口径）
    errors: [],
    口径: 'Δ% = DPS后/DPS前 − 1；|Δ%|≤死区 判"等价"；等价次级排序=匹配度档位>当前DPS；对外只报更好/更差/等价，不展示幅度',
  };
}
