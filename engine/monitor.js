'use strict';

/**
 * monitor.js — 系统②属性数值监测（纯函数、无 IO）
 *
 * 范围（评价系统设计.md §5，用户定稿）：
 *   1. 达标线评估：破竹风 v1 = 精准率≥98%、黄字会心率≥65%
 *      ——精准率即黄字精准率（用户确认：精准只有白字/黄字两层，黄字=生效；游戏面板显示的白字更高）；
 *      只读 panel.stats，不跑 DPS；技能级指标（如最终生效会心概率 BT）留待后续版本支持。
 *   2. 全局配额统计：当前实装 8 件的词条计数 vs 配额行（需要/实装/缺口/溢出 + 未配额词条）。
 *      定音词条不入配额（独立池，且可随意变音）。
 *   3. 小外流启用度（用户定稿简化版）：仅小外流方案（flow.小外流===true）适用；
 *      最小外功 > 最大外功 = 已达成（伤害固定取最小外功）→ 不提示；
 *      否则只提示「最小 < 最大」这一事实，**不下结论**——成因可能是缺小外/敏，
 *      也可能是大外/劲/势多了，故不再输出"还差几条小外词条"这类折算。
 *
 * 口径分离（设计文档 §2）：监测=当前实装记账，与匹配度的"结构档位"分离——
 * 同一条会心词条可以"匹配度合法、监测溢出"，两个系统各说各的事。
 * 分层排序（原 §5.5）为搁置的进阶功能，本模块不消费 priorityLayers。
 */

import { canonicalAffix, aliasMapOf } from './quota.js';

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

// 注意区分两种口径：技能级「最终生效会心概率」（逐技能 BT，含技能标记）不在面板层，
// 后续版本经 calcDPS debug 接入；面板级「最终生效会心率」是不含技能标记的基准值。
/** 面板级达标线指标登记表：指标名 → { stat: panel.stats 键, 口径 }
 *  （对外导出：方案数据校验 tools/check_templates.js 用它做白名单，避免两处维护） */
export const PANEL_METRICS = {
  精准率: { stat: '精准率', 口径: '黄字精准率（精准无直接项，黄字=生效；游戏面板显示的白字更高，勿直接对比）' },
  会心率: { stat: '会心率', 口径: '黄字会心率（面板值，无 cap、不含直接会心率）' },
  会意率: { stat: '会意率', 口径: '黄字会意率（面板值，无 cap、不含直接会意率）' },
  最终生效会心率: { stat: '最终生效会心率', 口径: '面板基准值（不含技能级标记/强制标记；孤忠不辞类技能级口径待逐技能接入）' },
  最终生效会意率: { stat: '最终生效会意率', 口径: '面板基准值（会意不受精准命中影响，不含技能级标记）' },
  最终生效会心会意率: { stat: '最终生效会心会意率', 口径: '面板基准值 = 最终生效会心率 + 最终生效会意率（不含技能级标记）' },
};

/**
 * 三率的**游戏机制上限**（与「方案达标线」是两件事，勿混）：
 *   - 达标线 = 方案作者写在 flow.thresholds 里的期望值，达不到只是"不够好"；
 *   - 上限   = 游戏硬性截断，超出部分**完全浪费**（结算按上限值，面板再多也不生效）。
 * 权威数值在 version.constants（与 panel.js / dps.js 同族常量），本表只登记键位与缺省。
 */
export const RATE_CAPS = {
  精准率: { stat: '精准率', capKey: '精准率上限', 默认: 1 },
  会心率: { stat: '会心率', capKey: '黄字会心率上限', 默认: 0.8 },
  会意率: { stat: '会意率', capKey: '黄字会意率上限', 默认: 0.4 },
};

export const RATE_CAP_NOTE = '游戏机制上限：超出部分按上限结算，面板值再多也不生效（与方案达标线不同——达标线是作者的期望值）';

/**
 * 三率上限溢出评估：面板值 vs 游戏上限，全量返回（UI 只渲染溢出项）。
 * @param panelStats computePanel 的 stats
 * @param constants version.constants（缺键时按 RATE_CAPS.默认 兜底）
 * @returns {{ rows: Array }} 每行 { 指标, 面板值, 上限, 溢出 }
 */
export function evaluateRateCaps(panelStats, constants) {
  const rows = [];
  for (const [指标, def] of Object.entries(RATE_CAPS)) {
    const value = num(panelStats?.[def.stat]);
    const cv = constants?.[def.capKey];
    const 上限 = typeof cv === 'number' ? cv : def.默认;
    rows.push({
      指标,
      面板值: value,
      上限,
      溢出: Math.max(0, value - 上限),
      口径: RATE_CAP_NOTE,
    });
  }
  return { rows };
}

/**
 * 达标线评估：逐条阈值对照面板值。
 * 阈值本身写在方案（flow.thresholds）；每条的**口径**由本模块登记表 PANEL_METRICS 权威承载
 * ——方案里不再写 thresholdNotes（该字段已彻底移除，口径注释归引擎，避免两处口径打架）。
 * @returns {{ rows: Array, warnings: string[] }}
 */
export function evaluateThresholds(panelStats, flow) {
  const thresholds = flow?.thresholds || {};
  const rows = [];
  const warnings = [];
  for (const [metric, threshold] of Object.entries(thresholds)) {
    const def = PANEL_METRICS[metric];
    if (!def) {
      warnings.push(`未知达标线指标「${metric}」（面板级当前支持：${Object.keys(PANEL_METRICS).join('/')}；技能级指标后续版本接入）`);
      continue;
    }
    const value = num(panelStats?.[def.stat]);
    rows.push({
      指标: metric,
      口径: def.口径,
      当前值: value,
      阈值: threshold,
      达标: value >= threshold - 1e-9,
      差距: Math.max(0, threshold - value),
    });
  }
  return { rows, warnings };
}

/**
 * 全局配额统计：对实装装备的初始+调律词条按配额行计数。
 * @param gear 8 件装备：{ slot, 初始:{属性,数值?}, 调律:[{属性,数值?}×4], 定音:{...}(不计) }
 * @param aliasMap 别名表（aliasMapOf(affixes)）；缺省时不做别名归一
 * @returns {{ rows: Array, 未配额词条: Object, total实装: number }}
 */
export function quotaCensus(gear, flow, aliasMap = null) {
  const counts = new Map();
  for (const piece of gear || []) {
    const units = [];
    if (piece?.初始?.属性) units.push(piece.初始.属性);
    for (const t of piece?.调律 || []) if (t?.属性) units.push(t.属性);
    for (const u of units) {
      const a = canonicalAffix(u, aliasMap);
      counts.set(a, (counts.get(a) || 0) + 1);
    }
  }
  const rows = (flow?.quota?.lines || []).map((L) => {
    const members = L.any_of.map((m) => canonicalAffix(m, aliasMap));
    const have = members.reduce((acc, m) => acc + (counts.get(m) || 0), 0);
    return {
      词条: members,
      需要: L.count,
      实装: have,
      缺口: Math.max(0, L.count - have),
      溢出: Math.max(0, have - L.count),
    };
  });
  const lineMembers = new Set(rows.flatMap((r) => r.词条));
  const 未配额词条 = {};
  for (const [a, n] of counts) if (!lineMembers.has(a)) 未配额词条[a] = n;
  const total实装 = [...counts.values()].reduce((acc, n) => acc + n, 0);
  return { rows, 未配额词条, total实装 };
}

/**
 * 小外流启用度：仅小外流方案适用（flow.小外流===true，数据字段；曾按"配额含最小外功行"
 * 判定，导致双切轴大外流/纯奶大外流（各只配 1、4 条）也误报，已废弃）。
 * @returns null = 不适用或无外功数据；否则 { 已达反转 }，UI 只在未达成时提示。
 */
export function enablement(panelStats, flow, 方案类型) {
  // 是否适用 = 查方案类型枚举表（version.方案类型），不再读手写的 小外流:true 布尔——
  // 布尔由表派生，杜绝漏标/误标（旧字段 小外流 已随三层重构废弃）。
  if (方案类型?.[flow?.方案]?.小外反超 !== true) return null;
  const lo = num(panelStats?.['最小外功攻击']);
  const hi = num(panelStats?.['最大外功攻击']);
  if (!lo && !hi) return null;
  return { 适用: true, 最小外功攻击: lo, 最大外功攻击: hi, 已达反转: lo > hi };
}

/**
 * 汇总：一个流（flow）的完整监测报告。
 * @param {{ panelStats: Object, gear: Array, flow: Object, affixes?: Object, constants?: Object }} input
 */
export function analyzeFlow({ panelStats, gear, flow, affixes, 方案类型, constants }) {
  if (!flow) return { ok: false, errors: ['缺少 flow（流派×分支×方案的词条方案）'] };
  if (!panelStats) return { ok: false, errors: ['缺少 panelStats（请先 computePanel）'] };
  const aliasMap = aliasMapOf(affixes);
  const thresholds = evaluateThresholds(panelStats, flow);
  const census = quotaCensus(gear, flow, aliasMap);
  const enable = enablement(panelStats, flow, 方案类型);
  const caps = evaluateRateCaps(panelStats, constants);
  return {
    ok: true,
    流派: flow.流派 ?? null,
    分支: flow.分支 ?? null,
    方案: flow.方案 ?? null,
    方案名: 方案类型?.[flow.方案]?.name ?? null,
    达标线: thresholds,
    三率上限: caps,
    配额统计: census,
    启用度: enable,
    errors: [],
    口径: {
      说明: '监测=当前实装记账（缺口/溢出/达标），与匹配度的结构档位口径分离；定音不入统计（独立池、可随意变音）；达标线口径由 PANEL_METRICS 登记表承载；三率上限=游戏机制截断，与方案达标线是两回事',
    },
  };
}
