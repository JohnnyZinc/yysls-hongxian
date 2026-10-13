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

/** 枚举候选：不转 + 每条调律 × 转律池可行目标 */
function enumerateCandidates(rx, initial, tunings) {
  const out = [{ conversion: null, ...evalState(rx, initial, tunings) }];
  for (let j = 0; j < tunings.length; j++) {
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

/** 评价一件装备在给定部位、给定配额推导结果下的匹配度 */
export function gradeItem(prescription, slotName, item) {
  const arrangements = prescription?.arrangements || [];
  if (!arrangements.length || !arrangements.some((a) => a.slots[slotName])) {
    return { ok: false, errors: [`未知部位或 prescription 缺少该部位的排列数据：${slotName}`] };
  }

  const initial = canonicalAffix(item.initial);
  const tunings = (item.tunings || []).map(canonicalAffix);
  if (tunings.length !== 4) {
    return { ok: false, errors: [`调律词条需 4 条，实际 ${tunings.length} 条（不完整装备不做可靠评价）`] };
  }
  if (new Set(tunings).size !== tunings.length) {
    return { ok: false, errors: ['调律词条互相重复，不是合法装备（调律词条之间不能重复）'] };
  }

  const units = [{ position: 'initial', affix: initial }, ...tunings.map((a) => ({ position: 'tuning', affix: a }))];

  // —— 按排列评分，取 (k, m, 转律代价) 字典序最优 ——
  const pairs = [];
  for (const arr of arrangements) {
    const rx = arr.slots[slotName];
    if (!rx) continue;
    const initialPoolSet = new Set(rx.initialPool);
    const tuningPoolSet = new Set(rx.tuningPool);
    // 兼容性：装备的每个单元都必须在该排列的池中（错型指定增 ⇒ 该排列对这件装备不存在）
    const compatible = units.every((u) => (u.position === 'initial'
      ? initialPoolSet.has(u.affix)
      : tuningPoolSet.has(u.affix)));
    if (!compatible) continue;
    for (const cand of enumerateCandidates(rx, initial, tunings)) {
      pairs.push({
        arr, rx, ...cand,
        score: [cand.k, cand.m, cand.conversion ? 1 : 0,
          cand.conversion ? cand.conversion.index : 0,
          cand.conversion ? cand.conversion.to : ''],
      });
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

  if (item.dingyin && prescription.idealArmorDingyin && ARMOR_SLOTS.has(slotName)) {
    notes.push(item.dingyin === prescription.idealArmorDingyin
      ? '定音与流派理想一致'
      : `定音「${item.dingyin}」≠ 流派理想「${prescription.idealArmorDingyin}」（可随时变音，仅提示不计档）`);
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
