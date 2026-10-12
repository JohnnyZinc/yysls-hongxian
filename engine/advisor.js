'use strict';

/**
 * advisor.js — 系统①匹配度：单件装备词条匹配度（纯函数、无 IO）
 *
 * 设计（评价系统设计.md §4）：
 *   - roll 数值完全不入档（承音会收敛到 max×94%，数值差异由 ΔDPS 系统承载）
 *   - 先算"转律最优解"：初始词条不可动；4 条调律中最多转 1 条、目标限该部位转律池；
 *     枚举"不转 + 每条调律→每个可行目标"，取 (k, m) 字典序最优
 *     —— k=无效词条数（不在该部位"必备∪自由"集合），m=缺必备数；先消灭无效、再看缺必备
 *   - 档位（转律最优解后）：天=(0,0) 传家宝 / 地=(0,≥1) 全对但缺必备 / 玄=k=1 / 黄=k≥2
 *   - 定音不入档（可随意变音），仅提示
 *   - 评档后用 quota.verifyItemFits 做"其余 7 部位能否补齐配额"的精确复核
 *
 * 转律目标的合法性：目标 ∈ 该部位转律池，且不与剩余调律重复（可与初始重复）。
 * 因此"缺必备"只有在以下情况才真补不齐（机械自动判定，无需人工判读）：
 *   缺的是神力/精准率（不在任何转律池）、初始位卡死（如初始≠大外时凑不齐 2 大外）、
 *   或唯一可转名额被无效词条占用。其余情况 → 天·需1次转律。
 */

import { canonicalAffix, SHENLI_AFFIXES, verifyItemFits } from './quota.js';

const ARMOR_SLOTS = new Set(['冠胄', '胸甲', '胫甲', '腕甲']);

/** 评价一件装备在给定部位、给定配额推导结果下的匹配度 */
export function gradeItem(prescription, slotName, item) {
  const rx = prescription?.slots?.[slotName];
  if (!rx) return { ok: false, errors: [`未知部位：${slotName}（prescription 无该部位）`] };

  const initial = canonicalAffix(item.initial);
  const tunings = (item.tunings || []).map(canonicalAffix);
  const errors = [], warnings = [], notes = [];

  if (tunings.length !== 4) {
    return { ok: false, errors: [`调律词条需 4 条，实际 ${tunings.length} 条（不完整装备不做可靠评价）`] };
  }
  if (new Set(tunings).size !== tunings.length) {
    return { ok: false, errors: ['调律词条互相重复，不是合法装备（调律词条之间不能重复）'] };
  }

  // ———— 候选枚举：不转 + 每条调律 × 转律池可行目标 ————
  const candidates = [{ conversion: null, ...evalState(rx, initial, tunings) }];
  for (let j = 0; j < tunings.length; j++) {
    const rest = tunings.filter((_, i) => i !== j);
    for (const to of rx.conversionPool) {
      if (rest.includes(to)) continue; // 调律互不重复（可与初始重复）
      const vt = tunings.map((t, i) => (i === j ? to : t));
      candidates.push({ conversion: { from: tunings[j], to, index: j }, ...evalState(rx, initial, vt) });
    }
  }
  // 字典序：(k, m) 最优 → 不转优先（省资源）→ 确定性次序
  candidates.sort((a, b) =>
    a.k - b.k ||
    a.m - b.m ||
    (a.conversion ? 1 : 0) - (b.conversion ? 1 : 0) ||
    (a.conversion && b.conversion
      ? (a.conversion.index - b.conversion.index || a.conversion.to.localeCompare(b.conversion.to, 'zh'))
      : 0));
  const best = candidates[0];

  // ———— 档位 ————
  const tier = best.k === 0 ? (best.m === 0 ? '天' : '地') : (best.k === 1 ? '玄' : '黄');
  const needsConversion = !!best.conversion;

  // ———— 建议与警示 ————
  if (best.conversion) {
    notes.push(`转律建议：${best.conversion.from} → ${best.conversion.to}${best.m === 0 && best.k === 0 ? '（即可毕业）' : ''}`);
  }
  if (best.invalid.some(u => u.position === 'initial')) {
    notes.push('存在初始位无效词条：初始词条无法转律，档次无法通过转律提升');
  }
  if (needsConversion && SHENLI_AFFIXES.has(best.conversion.from)) {
    warnings.push(`「${best.conversion.from}」是神力词条，转掉永久损失（转律池不含神力），请确认后再转`);
  }
  if (needsConversion && SHENLI_AFFIXES.has(best.conversion.to)) {
    warnings.push('转律池不含神力词条，此目标不可达（不应出现，请检查数据）');
  }

  // ———— 全局可行性精确复核（评档基于转律后状态） ————
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

  // ———— 定音提示（不入档） ————
  if (item.dingyin && prescription.idealArmorDingyin && ARMOR_SLOTS.has(slotName)) {
    notes.push(item.dingyin === prescription.idealArmorDingyin
      ? '定音与流派理想一致'
      : `定音「${item.dingyin}」≠ 流派理想「${prescription.idealArmorDingyin}」（可随时变音，仅提示不计档）`);
  }

  return {
    ok: true,
    slot: slotName,
    buildId: prescription.buildId,
    flowId: prescription.flowId,
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
    errors,
    口径: '转律最优解后的 (k,m) 字典序评档；roll 数值不入档；定音不入档',
  };
}

/** 评一个 (初始, 调律×4) 状态的 (k, m) 与明细 */
function evalState(rx, initial, tunings) {
  const validSet = new Set([...rx.required.map(r => r.affix), ...rx.freeSet]);
  const initialPoolSet = new Set(rx.initialPool);
  const tuningPoolSet = new Set(rx.tuningPool);

  let k = 0;
  const invalid = [];
  const units = [{ position: 'initial', affix: initial }, ...tunings.map(a => ({ position: 'tuning', affix: a }))];
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
  for (const r of rx.required) {
    const occ = (initial === r.affix ? 1 : 0) + tunings.filter(t => t === r.affix).length;
    const d = Math.max(0, r.count - occ);
    if (d > 0) {
      m += d;
      missing.push({ type: '数量', affix: r.affix, deficit: d });
    }
  }
  return { k, m, invalid, missing };
}
