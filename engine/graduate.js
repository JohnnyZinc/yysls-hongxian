'use strict';

/**
 * graduate.js — 毕业基准生成器（盘点 §3.3 / 议题B）
 *
 * 毕业率的分母不再用 build 包写死的 Excel I16 常数，而是按当前流方案的配额
 * 物化一套毕业装备（40 词条全部承音值；定音按方案的 防具定音/攻具定音、数值取定音区间最大值）
 * → computePanel → calcDPS 生成基准 DPS。方案一改，基准自动变，零手工。
 *
 * 口径：
 *   - 物化装备与玩家装备走同一参照系（selections 可选层 + build 包固定参照系），
 *     毕业率 = 同参照系下的相对位置；
 *   - 自检：物化装备逐件匹配度必须全"天"（结构档位自洽，构造错误立刻暴露）；
 *   - build.graduate_dps（Excel I16）降级为对照：生成基准与它偏差大 =
 *     我们对配额的理解与 Excel 作者不一致，是校验信号；
 *   - 无方案/推导不可行的流派由调用方回退 build.graduate_dps（calcDPS 默认行为）。
 */

import { solveAssignment } from './quota.js';
import { computePanel } from './panel.js';
import { calcDPS } from './dps.js';
import { gradeItem } from './advisor.js';

// 词条 → 区间表键的系统性别名（与 panel.js/app.js 的口径同源约定；
// 独立维护是已知重复债，别名表迁移落地后并入同一来源，见盘点 §2.2 #2）
const RANGE_ALIAS = {
  全奇术增伤: '奇术增伤',
  对首领单位增伤: '首领单位增伤',
  对玩家单位增效: '玩家单位增效',
};
for (const t of ['剑', '枪', '横刀', '陌刀', '伞', '扇', '绳镖', '双刀', '拳甲', '鼓']) {
  RANGE_ALIAS[`${t}武学增伤`] = '武器增伤';
}

/** 词条的毕业数值 = 承音值（缺则退区间最大值；毕业=理想 roll） */
function affixValue(affixes, name) {
  const table = affixes?.词条区间 || {};
  const rec = table[name] || table[RANGE_ALIAS[name]];
  return rec ? (rec.承音 ?? rec.max) : null;
}

/**
 * 按推导结果物化一套毕业装备。
 * @returns { ok, gear?, errors, warnings }
 */
export function materializeGraduateGear(prescription, affixes, flow) {
  const errors = [];
  const warnings = [];
  const base = prescription?._base;
  if (!base || !base.arrangementSpecs?.length) {
    return { ok: false, errors: ['prescription 缺少 _base（手工构造的推导结果无法物化）'], warnings };
  }
  const units = solveAssignment(base.arrangementSpecs[0].spec, base.lineOf);
  if (!units || units.length !== 40) {
    return { ok: false, errors: [`配额分配失败：得到 ${units?.length ?? 0}/40 单元`], warnings };
  }

  const 定音区间 = affixes?.定音区间 || {};
  // 防具定音词条名 → '技能定音' 区间（55 条共用，系统性别名与 panel.js 同口径）
  const dingyinValue = (name) => {
    if (!name) return null;
    if (定音区间[name]) return 定音区间[name].max;
    if ((affixes?.护甲定音词条 || []).includes(name)) return 定音区间['技能定音']?.max ?? null;
    return null;
  };
  const 攻具 = new Set(['左武器', '右武器', '武器', '环', '佩']);

  const bySlot = {};
  for (const { slot, affix } of units) (bySlot[slot] ??= []).push(affix);
  const gear = [];
  for (const [slot, list] of Object.entries(bySlot)) {
    if (list.length !== 5) {
      errors.push(`${slot} 物化出 ${list.length}/5 词条`);
      continue;
    }
    const piece = {
      slot,
      承音: true,
      初始: { 属性: list[0], 数值: affixValue(affixes, list[0]) },
      调律: list.slice(1, 5).map((a) => ({ 属性: a, 数值: affixValue(affixes, a) })),
      定音: null,
    };
    const dyName = 攻具.has(slot) ? (flow?.攻具定音 || '') : (flow?.防具定音 || '');
    if (dyName) piece.定音 = { 属性: dyName, 数值: dingyinValue(dyName) };
    gear.push(piece);
  }
  if (errors.length) return { ok: false, errors, warnings };
  if (gear.length !== 8) return { ok: false, errors: [`物化出 ${gear.length}/8 部位`], warnings };
  return { ok: true, gear, errors, warnings };
}

/**
 * 生成当前流方案的毕业基准 DPS。
 * @param input { buildCtx, version, affixes, selections, prescription, flow }
 * @returns { ok, dps?, gear?, excelBaseline, deviation?, errors, warnings, 口径 }
 *          excelBaseline = build.graduate_dps（Excel I16 对照）；deviation = 生成值相对对照的偏差
 */
export function computeGraduateDps({ buildCtx, version, affixes, selections, prescription, flow }) {
  const errors = [];
  const warnings = [];
  if (!buildCtx?.build?.name) return { ok: false, errors: ['buildCtx 不完整（需 build.name）'], warnings };
  if (!prescription?.feasible) return { ok: false, errors: ['推导结果不可用，无法物化毕业装备'], warnings };

  const mat = materializeGraduateGear(prescription, affixes, flow);
  errors.push(...mat.errors);
  warnings.push(...mat.warnings);
  if (!mat.ok) return { ok: false, errors, warnings };

  // 终极自检：物化装备逐件匹配度必须全"天"
  for (const piece of mat.gear) {
    const g = gradeItem(prescription, piece.slot, {
      initial: piece.初始.属性,
      tunings: piece.调律.map((t) => t.属性),
    });
    if (!g.ok) errors.push(`自检失败：${piece.slot} 匹配度评估错误：${(g.errors || []).join('；')}`);
    else if (g.tier !== '天') errors.push(`自检失败：${piece.slot} 档位 ${g.tier} ≠ 天`);
  }
  if (errors.length) return { ok: false, gear: mat.gear, errors, warnings };

  const pr = computePanel({
    version,
    affixes,
    build: { 流派: buildCtx.build.name },
    gear: mat.gear,
    selections: selections || {},
  });
  const r = calcDPS(buildCtx, { panel: pr });
  const excelBaseline = buildCtx.build.graduate_dps ?? null;
  return {
    ok: true,
    dps: r.dps,
    gear: mat.gear,
    excelBaseline,
    deviation: excelBaseline ? (r.dps - excelBaseline) / excelBaseline : null,
    errors: [],
    warnings,
    口径: '毕业基准=当前方案配额物化毕业装备（40词条承音值+方案定音最大值）→ panel → DPS；build 包 Excel I16 降级为对照',
  };
}
