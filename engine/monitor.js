'use strict';

/**
 * monitor.js — 系统②属性数值监测（纯函数、无 IO）
 *
 * 范围（评价系统设计.md §5，用户定稿）：
 *   1. 达标线评估：破竹风 v1 = 生效精准率≥98%、黄字会心率≥65%
 *      ——生效精准率即黄字精准率（用户确认：精准只有白字/黄字两层，黄字=生效）；
 *      只读 panel.stats，不跑 DPS；技能级指标（如最终生效会心概率 BT）留待后续版本支持。
 *   2. 全局配额统计：当前实装 8 件的词条计数 vs 配额行（需要/实装/缺口/溢出 + 未配额词条）。
 *      定音词条不入配额（独立池，且可随意变音）。
 *   3. 小外流启用度：面板 最小外功 vs 最大外功——小外流只有 最小>最大 之后才固定按
 *      最小外功取值（设计文档 §5.4）；输出距反转差值并按小外词条承音值折算词条数。
 *
 * 口径分离（设计文档 §2）：监测=当前实装记账，与匹配度的"结构档位"分离——
 * 同一条会心词条可以"匹配度合法、监测溢出"，两个系统各说各的事。
 * 分层排序（原 §5.5）为搁置的进阶功能，本模块不消费 priorityLayers。
 */

import { canonicalAffix } from './quota.js';

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

// 面板级达标线指标登记表：指标名 → { stat: panel.stats 键, 口径 }
// 注意区分两种口径：技能级「最终生效会心概率」（逐技能 BT，含技能标记）不在面板层，
// 后续版本经 calcDPS debug 接入；面板级「最终生效会心率」是不含技能标记的基准值。
const PANEL_METRICS = {
  生效精准率: { stat: '精准率', 口径: '黄字精准率（精准无直接项，黄字=生效，用户确认）' },
  会心率: { stat: '会心率', 口径: '黄字会心率（面板值，无 cap、不含直接会心率）' },
  会意率: { stat: '会意率', 口径: '黄字会意率（面板值，无 cap、不含直接会意率）' },
  最终生效会心率: { stat: '最终生效会心率', 口径: '面板基准值（不含技能级标记/强制标记；孤忠不辞类技能级口径待逐技能接入）' },
  最终生效会意率: { stat: '最终生效会意率', 口径: '面板基准值（会意不受精准命中影响，不含技能级标记）' },
  最终生效会心会意率: { stat: '最终生效会心会意率', 口径: '面板基准值 = 最终生效会心率 + 最终生效会意率（不含技能级标记）' },
};

/**
 * 达标线评估：逐条阈值对照面板值。
 * @returns {{ rows: Array, warnings: string[], notes: string|null }}
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
  return { rows, warnings, notes: flow?.thresholdNotes || null };
}

/**
 * 全局配额统计：对实装装备的初始+调律词条按配额行计数。
 * @param gear 8 件装备：{ slot, 初始:{属性,数值?}, 调律:[{属性,数值?}×4], 定音:{...}(不计) }
 * @returns {{ rows: Array, 未配额词条: Object, total实装: number }}
 */
export function quotaCensus(gear, flow) {
  const counts = new Map();
  for (const piece of gear || []) {
    const units = [];
    if (piece?.初始?.属性) units.push(piece.初始.属性);
    for (const t of piece?.调律 || []) if (t?.属性) units.push(t.属性);
    for (const u of units) {
      const a = canonicalAffix(u);
      counts.set(a, (counts.get(a) || 0) + 1);
    }
  }
  const rows = (flow?.quota?.lines || []).map((L) => {
    const members = L.any_of.map(canonicalAffix);
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
 * 小外流启用度：反转条件 = 面板最小外功 > 最大外功。
 * @returns null 当面板缺少外功数值；否则含 适用 标记（配额含最小外功行才适用）
 */
export function enablement(panelStats, flow, affixes) {
  const lo = num(panelStats?.['最小外功攻击']);
  const hi = num(panelStats?.['最大外功攻击']);
  if (!lo && !hi) return null;
  const 已反转 = lo > hi;
  const 差值 = 已反转 ? 0 : Math.max(0, hi - lo);
  const out = {
    适用: (flow?.quota?.lines || []).some((L) => L.any_of.map(canonicalAffix).includes('最小外功攻击')),
    最小外功攻击: lo,
    最大外功攻击: hi,
    已反转,
    距反转差值: 差值,
  };
  // 按小外词条承音值折算"还差几条"（向上取整，估算口径）
  const chengyin = num(affixes?.词条区间?.['最小外功攻击']?.承音);
  if (!已反转 && chengyin > 0) {
    out.折算词条数 = Math.ceil(差值 / chengyin);
    out.折算口径 = `按小外词条承音值 ${chengyin}/条 估算`;
  }
  return out;
}

/**
 * 汇总：一个流（flow）的完整监测报告。
 * @param {{ panelStats: Object, gear: Array, flow: Object, affixes?: Object }} input
 */
export function analyzeFlow({ panelStats, gear, flow, affixes }) {
  if (!flow) return { ok: false, errors: ['缺少 flow（流派×轴×流的评价层配置）'] };
  if (!panelStats) return { ok: false, errors: ['缺少 panelStats（请先 computePanel）'] };
  const thresholds = evaluateThresholds(panelStats, flow);
  const census = quotaCensus(gear, flow);
  const enable = enablement(panelStats, flow, affixes);
  return {
    ok: true,
    buildId: flow.buildId ?? null,
    flowId: flow.flowId,
    flowName: flow.name ?? null,
    达标线: thresholds,
    配额统计: census,
    启用度: enable,
    errors: [],
    口径: {
      达标线: flow.thresholdNotes || null,
      说明: '监测=当前实装记账（缺口/溢出/达标），与匹配度的结构档位口径分离；定音不入统计（独立池、可随意变音）',
    },
  };
}
