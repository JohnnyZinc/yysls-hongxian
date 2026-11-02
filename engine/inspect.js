'use strict';

/**
 * inspect.js — P1d 三系统整合：三种查看视图（纯函数、无 IO）
 *
 * 用户操作场景（用户定稿）：
 *   1. 点击已穿戴装备 → 匹配度+转律建议 + 当前实装的溢出/不足；
 *      不显示 ΔDPS（穿戴中的装备不与其他同部位装备比较）。
 *   2. 点击背包未穿戴装备 → 与同部位已穿戴装备的 ΔDPS + 匹配度/转律建议
 *      + 假设穿上该装备后会出现的溢出/不足（前瞻口径）。
 *   3. 什么都不选 → 组合 DPS 毕业率 + 属性面板 + 当前溢出/不足。
 *
 * 不给综合结论——三系统并列罗列、各说各的口径（用户定：三者地位相当，不调和）。
 * 监测摘要只罗列"发现"（未达标/缺口/溢出/未配额词条/启用度），达标项不占版面。
 */

import { gradeItem } from './advisor.js';
import { evalGearDps, evaluateSwap } from './swap.js';
import { analyzeFlow } from './monitor.js';

/** 装备件 → 匹配度输入形状（与 swap.js 同规则） */
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
 * 从监测报告提炼"发现"。
 * 配额：UI 走 配额行（全量，含达标行——统一「实装/需要 + 配色」展示，用户定稿）；
 * 缺口/溢出两份切片保留给程序化消费（如 test_inspect 的前瞻断言）。
 */
function monitoringDigest(analysis) {
  return {
    达标行: analysis.达标线.rows, // 全量（含达标行——统一「当前/阈值 + 配色」展示，用户定稿）
    达标未达: analysis.达标线.rows.filter((r) => !r.达标),
    三率溢出: (analysis.三率上限?.rows || []).filter((r) => r.溢出 > 0), // 游戏机制上限（与方案达标线两回事）
    配额行: analysis.配额统计.rows,
    配额缺口: analysis.配额统计.rows.filter((r) => r.缺口 > 0),
    配额溢出: analysis.配额统计.rows.filter((r) => r.溢出 > 0),
    未配额词条: analysis.配额统计.未配额词条,
    启用度: analysis.启用度,
  };
}

/**
 * 视图一：点击已穿戴装备。
 * 匹配度+转律建议（含收藏价值）+ 当前实装的溢出/不足；无 ΔDPS。
 */
export function inspectEquipped({ buildCtx, version, affixes, selections, gear, piece, prescription, flow, graduateDps }) {
  const errors = [];
  if (!piece?.slot) errors.push('piece 缺少 slot（部位）');
  if (!prescription) errors.push('缺少 prescription（配额推导结果，匹配度需要）');
  if (!flow) errors.push('缺少 flow（达标线/配额来源）');
  if (piece?.slot && !gear?.some((g) => g?.slot === piece.slot)) errors.push(`gear 中找不到该槽位的已穿戴装备：${piece.slot}`);
  if (errors.length) return { ok: false, view: '已穿戴装备', errors };

  const 匹配度 = gradeItem(prescription, piece.slot, toGradeItem(piece));
  const { panel: pr } = evalGearDps({ buildCtx, version, affixes, gear, selections, graduateDps });
  const analysis = analyzeFlow({ panelStats: pr.stats, gear, flow, affixes, 方案类型: version?.方案类型, constants: version?.constants });

  return {
    ok: true,
    view: '已穿戴装备',
    slot: piece.slot,
    buildId: prescription.buildId ?? null,
    flowId: prescription.flowId ?? null,
    匹配度,
    监测: monitoringDigest(analysis),
    ΔDPS: null, // 用户定：穿戴中的装备不与其他同部位装备比较
    errors: [],
    口径: '已穿戴装备不显示 ΔDPS；监测=当前实装记账；匹配度=结构档位（转律最优解）',
  };
}

/**
 * 视图二：点击背包中未穿戴的装备。
 * 与同部位已穿戴装备的 ΔDPS + 匹配度/转律建议 + 假设穿上后的溢出/不足。
 */
export function inspectCandidate({
  buildCtx, version, affixes, selections, gear, newItem, prescription, flow, deadZone, graduateDps,
}) {
  const errors = [];
  if (!newItem?.slot) errors.push('newItem 缺少 slot（部位）');
  if (!prescription) errors.push('缺少 prescription（配额推导结果，匹配度需要）');
  if (!flow) errors.push('缺少 flow（达标线/配额来源）');
  if (errors.length) return { ok: false, view: '背包装备', errors };

  // 等价死区：方案文件可配（flow.死区，如 0.003 = 0.3%）；未配置走 evaluateSwap 默认 0.005
  const swap = evaluateSwap({
    buildCtx, version, affixes, selections,
    currentGear: gear, newItem, prescription,
    deadZone: deadZone ?? flow?.死区, graduateDps,
  });
  if (!swap.ok) return { ok: false, view: '背包装备', errors: swap.errors }; // 如：武器无同类型已穿戴
  const 匹配度 = gradeItem(prescription, newItem.slot, toGradeItem(newItem));
  // 假设穿上后的实装：**直接复用 evaluateSwap 的 gearAfter**，保证与 ΔDPS 同一口径。
  // 不能自行 filter(sameEquipKey)——同类型多件（双枪）时会把两件一起删掉（评价系统设计.md §12.2）。
  const gearAfter = swap.gearAfter;
  const analysis = analyzeFlow({ panelStats: swap.afterPanelStats, gear: gearAfter, flow, affixes, 方案类型: version?.方案类型, constants: version?.constants });

  return {
    ok: true,
    view: '背包装备',
    slot: newItem.slot,
    buildId: prescription.buildId ?? null,
    flowId: prescription.flowId ?? null,
    ΔDPS: {
      verdict: swap.verdict,
      deltaPct: swap.deltaPct,
      deadZone: swap.deadZone,
      recommendation: swap.recommendation,
      tieBreak: swap.tieBreak,
      before: swap.before,
      after: swap.after,
      replacedOld: swap.replacedOld,
      去向: { 旧件: swap.旧件去向, 新件: swap.新件去向, 候补: swap.候补 },
      panelDiff: swap.panelDiff,
    },
    匹配度,
    监测: monitoringDigest(analysis), // 假设穿上该装备后
    errors: [],
    口径: 'ΔDPS=与同部位已穿戴对比（死区内为等价，次级排序=匹配度档位>当前DPS）；监测=假设穿上后的实装记账（前瞻口径）',
  };
}

/**
 * 视图三：什么都不选中——整体装备组合。
 * DPS 毕业率 + 属性面板 + 当前溢出/不足。
 */
export function inspectOverall({ buildCtx, version, affixes, selections, gear, prescription, flow, graduateDps }) {
  const errors = [];
  if (!flow) errors.push('缺少 flow（达标线/配额来源）');
  if (errors.length) return { ok: false, view: '整体', errors };

  const { panel: pr, dps, graduationRate } = evalGearDps({ buildCtx, version, affixes, gear, selections, graduateDps });
  const analysis = analyzeFlow({ panelStats: pr.stats, gear, flow, affixes, 方案类型: version?.方案类型, constants: version?.constants });

  return {
    ok: true,
    view: '整体',
    buildId: buildCtx.build.id ?? null,
    flowId: flow.flowId ?? null,
    DPS: { dps, graduationRate },
    属性面板: pr.stats,
    面板警告: pr.warnings ?? [],
    监测: monitoringDigest(analysis),
    errors: [],
    口径: `整体视图=当前装备组合的 DPS 毕业率+属性面板+实装记账；无选中装备，无替换比较；毕业率分母=${graduateDps != null ? '当前方案配额物化基准（议题B）' : 'build 包 Excel I16'}`,
  };
}
