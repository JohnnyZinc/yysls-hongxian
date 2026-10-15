'use strict';

/**
 * dps.js — 燕云十六声 DPS 引擎原型
 *
 * 从社区 Excel 计算器（BiliBili@片雲 等）翻译的逐事件期望伤害模型：
 *   展开式时间轴（每事件标注生效增益）× 乘区公式（会心/会意/擦伤四态期望加权）
 *
 * 数据输入（见 data/ 目录）：
 *   build   = {build}.json         时间轴、面板默认值、怪物参数、武器类别、验证基准
 *   skills  = {build}.skills.json  武学/奇术表（倍率、固伤、标记、定音、真气）
 *   effects = {build}.effects.json 增益表（各乘区加成）
 *
 * 用法（纯函数，Node 与浏览器通用）：
 *   import { calcDPS } from './engine/dps.js';
 *   const r = calcDPS({ build, skills, effects });   // build=流派JSON对象
 *   const r2 = calcDPS(ctx, { panel: {...} });       // 覆盖部分面板（装备对比）
 *   const r3 = calcDPS(ctx, { debug: true });        // 返回逐事件明细
 *   （Node 侧读文件用 tools/load-build.js 的 loadBuild）
 *
 * 已知取舍（原型阶段）：
 *   - 只使用作者默认配置（心法选择、团队增益勾选），效果数值取 Excel 缓存值；
 *     面板输入（含全武增/首领增/类别增伤）已全部面板驱动，换装备即改 panel
 *   - 套装攻击乘数为提取时解析的生效值（如 倾觞×1.05），存于 build.set_attack_multiplier
 */

const num = (v) => (typeof v === 'number' ? v : 0);

// 增益表全部可加和字段
const EFFECT_FIELDS = [
  'generic_dmg', 'min_ext', 'max_ext', 'ext_dmg', 'ext_pen',
  'ext_skill_dmg', 'elem_skill_dmg',
  'mingjin_pen', 'mingjin_dmg', 'lieshi_pen', 'lieshi_dmg',
  'qiansi_pen', 'qiansi_dmg', 'pozhu_pen', 'pozhu_dmg',
  'crit_rate', 'crit_dmg', 'insight_rate', 'insight_dmg',
  'direct_crit_rate', 'direct_insight_rate',
  'spec_dmg', 'final_dmg', 'spec_bonus',
];

// 四系属性攻击（外功单独处理）：内部键名 + 游戏全称标签
const ATTRS = [['mingjin', '鸣金'], ['lieshi', '裂石'], ['qiansi', '牵丝'], ['pozhu', '破竹']];

const ZERO_SKILL = Object.freeze({ type: null });

/** 汇总一个事件生效列表中所有增益的各乘区数值 */
function aggregateEffects(names, effectsById) {
  const agg = {};
  for (const f of EFFECT_FIELDS) agg[f] = 0;
  for (const n of names) {
    const e = effectsById[n];
    if (!e) continue; // 未知增益按 0 处理（Excel XLOOKUP 默认 0）
    for (const f of EFFECT_FIELDS) {
      const v = e[f];
      if (typeof v === 'number') agg[f] += v;
    }
  }
  return agg;
}

/** 从 build JSON 组装作者默认面板（Excel 输入区缓存值；与 computePanel 同一 schema） */
function makePanel(build) {
  const pi = build.panel_input || {};
  const get = (key) => (pi[key] ? num(pi[key].default) : 0);
  const stats = {
    精准率: get('precise_rate'),
    会心率: get('crit_rate'),
    会意率: get('insight_rate'),
    直接会心率: get('direct_crit_rate'),
    直接会意率: get('direct_insight_rate'),
    会心伤害加成: get('crit_dmg_bonus'),
    会意伤害加成: get('insight_dmg_bonus'),
    全武学增伤: get('all_weapon_dmg'), // 全武增
    对首领单位增伤: get('boss_dmg'),   // 首领增
    全奇术增伤: 0,                     // 全奇术增伤只来自装备词条，作者基准恒为 0
    技能定音: get('dingyin'),
  };
  const bs = build.base_stats || {};
  stats['最小外功攻击'] = num(bs.external && bs.external.min);
  stats['最大外功攻击'] = num(bs.external && bs.external.max);
  stats['最小无相攻击'] = num(bs.wuxiang && bs.wuxiang.min);
  stats['最大无相攻击'] = num(bs.wuxiang && bs.wuxiang.max);
  const pd = build.pen_dmg || {};
  stats['外功穿透'] = num(pd.external && pd.external.pen);
  stats['外功伤害加成'] = num(pd.external && pd.external.dmg);
  for (const [key, label] of ATTRS) {
    stats[`最小${label}攻击`] = num(bs[key] && bs[key].min);
    stats[`最大${label}攻击`] = num(bs[key] && bs[key].max);
    stats[`${label}穿透`] = num(pd[key] && pd[key].pen);
    stats[`${label}加成`] = num(pd[key] && pd[key].dmg);
  }
  // 武器/奇术类别增伤：Excel 缓存值（作者基准），键 = config.categories 的 panel_key
  for (const c of (build.config && build.config.categories) || []) {
    let v = 0;
    for (const k of c.panel_keys || []) v += get(k);
    stats[c.panel_key] = v;
  }
  return {
    stats,
    flatBonus: get('flat_dmg_bonus'),
    food: { ext: get('food_ext'), elem: get('food_elem') },
  };
}

/** 简单深合并（覆盖用） */
function deepMerge(base, override) {
  if (override === undefined) return base;
  if (typeof base !== 'object' || base === null ||
      typeof override !== 'object' || override === null) return override;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(override)) out[k] = deepMerge(base ? base[k] : undefined, override[k]);
  return out;
}

/**
 * 计算 DPS。
 * @param ctx     loadBuild 的返回
 * @param options { panel: 面板覆盖对象, debug: 是否返回逐事件明细 }
 */
function calcDPS(ctx, options = {}) {
  const { build, skills, effects } = ctx;
  const panel = deepMerge(makePanel(build), options.panel);
  const debug = !!options.debug;

  const mainLabel = build.selectors.weapon_attribute;
  // 套装攻击乘数（从 Excel D10 公式解析的生效值，如 倾觞×1.05 / 撼天×1.06）
  const setMult = num(build.set_attack_multiplier) || 1;

  // —— 静态预计算 ——
  const S = panel.stats || {};
  // 守卫：面板必需键齐全性校验（缺键 → 抛错，杜绝静默按 0 计算的错数）
  const REQUIRED = [
    '精准率', '会心率', '会意率', '直接会心率', '直接会意率',
    '会心伤害加成', '会意伤害加成',
    '最小外功攻击', '最大外功攻击', '外功穿透', '外功伤害加成',
    '全武学增伤', '对首领单位增伤', '全奇术增伤', '技能定音',
    '最小无相攻击', '最大无相攻击',
    ...ATTRS.flatMap(([, l]) => [`最小${l}攻击`, `最大${l}攻击`, `${l}穿透`, `${l}加成`]),
  ];
  const missing = REQUIRED.filter((k) => typeof S[k] !== 'number');
  if (missing.length) {
    throw new Error(`面板缺少必需键: ${missing.join('、')}——请使用 computePanel 的完整输出，勿手拼面板对象`);
  }
  const extBaseMin = num(S['最小外功攻击']);
  const extBaseMax = num(S['最大外功攻击']);
  const extMin = (extBaseMin + panel.food.ext) * setMult;
  const extMax =
    Math.max(extBaseMin + panel.food.ext, extBaseMax + panel.food.elem) * setMult;

  const attrs = ATTRS.map(([key, label]) => {
    const isMain = label === mainLabel;
    const aMin = num(S[`最小${label}攻击`]);
    const aMax = num(S[`最大${label}攻击`]);
    return {
      key,
      label,
      min: (aMin + (isMain ? num(S['最小无相攻击']) : 0)) * setMult,
      max: (Math.max(aMin, aMax) + (isMain ? num(S['最大无相攻击']) : 0)) * setMult,
    };
  });

  // 通用增伤基数与各类型增伤：全部面板驱动
  //   genericBase = 对首领单位增伤 + 配置常数(提取时拆出的基础/团队假设部分)
  //   typeValue   = 类别增伤（stats 按 panel_key 取） (+ 全武学增伤，按提取时数据驱动的检测标志)
  const cfg = build.config || {};
  const genericBase = num(S['对首领单位增伤']) + num(cfg.generic_extra);
  const typeValues = {};
  for (const c of cfg.categories || []) {
    let v = num(S[c.panel_key]);
    if (c.includes_all_weapon === true) v += num(S['全武学增伤']);
    else if (c.includes_all_weapon !== false) v = num(c.value); // 无法判定时回退缓存
    typeValues[c.label] = v;
  }
  // 单体奇术/群体奇术类技能同用全奇术增伤乘区（奇术类别合并后的别名）
  if (typeValues['奇术'] !== undefined) {
    if (typeValues['单体奇术'] === undefined) typeValues['单体奇术'] = typeValues['奇术'];
    if (typeValues['群体奇术'] === undefined) typeValues['群体奇术'] = typeValues['奇术'];
  }
  // 前两个武器类别（Excel F4/F5）：这两类的固伤享受固伤加成
  const flatCats = (cfg.categories || []).slice(0, 2).map((c) => c.label);

  const monster = {
    defense: num(build.monster.defense && build.monster.defense.value),
    extResist: num(build.monster.ext_resist && build.monster.ext_resist.value),
    elemResist: num(build.monster.elem_resist && build.monster.elem_resist.value),
    dungeonTalent: num(build.monster.dungeon_talent && build.monster.dungeon_talent.value),
  };

  // —— 单事件标准公式（Excel L 列模板）——
  let lastInter = null;
  const ATTR_LABELS = {
    mingjin: { small: '即时小鸣', big: '即时大鸣', pen: '鸣金穿透', dmg: '鸣金加成' },
    lieshi: { small: '即时小裂', big: '即时大裂', pen: '裂石穿透', dmg: '裂石加成' },
    qiansi: { small: '即时小牵', big: '即时大牵', pen: '牵丝穿透', dmg: '牵丝加成' },
    pozhu: { small: '即时小破', big: '即时大破', pen: '破竹穿透', dmg: '破竹加成' },
  };

  const calcStandard = (ev) => {
    const skill = skills[ev.skill] || ZERO_SKILL;
    const agg = aggregateEffects(ev.effects, effects);
    const count = num(ev.count);
    if (count === 0) return 0;
    const type = skill.type || null;

    // 通用增伤 AR：基数 + 类型增伤 + 技能自带 + 增益
    let AR = genericBase;
    if (type != null && typeValues[type] != null) AR += typeValues[type];
    AR += num(skill.generic_dmg) + agg.generic_dmg;

    // 外功：加成%、即时小/大外（扣防御）、穿透分段、外伤加成
    const AS = num(skill.ext_dmg) + agg.ext_dmg;
    const AT = extMin * (1 + AS) + num(skill.min_ext) + agg.min_ext - monster.defense;
    const AU = extMax * (1 + AS) + num(skill.max_ext) + agg.max_ext - monster.defense;
    const penExtRaw = num(S['外功穿透']) + num(skill.ext_pen) + agg.ext_pen - monster.extResist;
    const AV = penExtRaw > 0 ? penExtRaw / 200 : penExtRaw / 100;
    const AW = num(S['外功伤害加成']) + num(skill.ext_skill_dmg) + agg.ext_skill_dmg;
    const AX = num(skill.elem_skill_dmg) + agg.elem_skill_dmg;

    // 倍率/固伤：固伤仅前两个武器类别享受固伤加成
    const flatCond = flatCats.includes(type) ? 1 + panel.flatBonus : 1;
    const AN = num(skill.ext_mult);
    const AO = num(skill.ext_flat) * flatCond;
    const AP = num(skill.elem_mult);
    const AQ = num(skill.elem_flat) * flatCond;

    // 四系属性攻击项
    const inter = {
      类型: type,
      外功倍率: AN, 外攻固伤: AO, 属性倍率: AP, 属性固伤: AQ,
      通用增伤: AR, 外攻加成: AS,
      即时小外: AT, 即时大外: AU, 外穿加成: AV, 外伤加成: AW, 属攻加成: AX,
    };
    const attrTerms = attrs.map((a) => {
      const penRaw =
        num(S[`${a.label}穿透`]) + num(skill[a.key + '_pen']) + agg[a.key + '_pen'] - monster.elemResist;
      const isMain = a.label === mainLabel;
      const lbl = ATTR_LABELS[a.key];
      const term = {
        small: a.min * (1 + AX),
        big: a.max * (1 + AX),
        pen: penRaw > 0 ? penRaw / 200 : penRaw / 100,
        dmg: num(S[`${a.label}加成`]) + num(skill[a.key + '_dmg']) + agg[a.key + '_dmg'],
        mult: isMain ? AP : AN,          // 主属性用属性倍率，其余用外功倍率
        flat: isMain ? AQ * 1.5 : 0,     // 属性固伤仅主属性生效，且×1.5
      };
      inter[lbl.small] = term.small;
      inter[lbl.big] = term.big;
      inter[lbl.pen] = term.pen;
      inter[lbl.dmg] = term.dmg;
      return term;
    });

    // 会心/会意伤害倍率
    const BQ = 1 + num(S['会心伤害加成']) + num(skill.crit_dmg) + agg.crit_dmg;
    const BS = 1 + num(S['会意伤害加成']) + num(skill.insight_dmg) + agg.insight_dmg;
    const BW = agg.spec_dmg + monster.dungeonTalent;
    const BX = num(skill.spec_bonus) + agg.spec_bonus;

    // 强制标记与会意转化（Excel BO/BP/BR 列）
    const forceCrit = num(skill.force_crit) === 1;
    const forceInsight = num(skill.force_insight) === 1;
    const forcePrecise = num(skill.force_precision) === 1;
    const insightConvert = num(skill.insight_convert) === 1;

    const BO = Math.min(forceCrit ? 1 : num(S['精准率']), 1);
    const brNormal =
      forceInsight
        ? 1
        : Math.min(0.4, num(S['会意率']) + num(skill.insight_rate) + agg.insight_rate) +
          num(S['直接会意率']) +
          agg.direct_insight_rate;
    const BP =
      (forceCrit
        ? 1
        : Math.min(0.8, num(S['会心率']) + num(skill.crit_rate) + agg.crit_rate) +
          num(S['直接会心率']) +
          agg.direct_crit_rate) *
        (forceInsight ? 0 : 1) +
      (insightConvert ? Math.min(brNormal, 0.12) : 0); // 会意转化：会意生效值并入会心，至多 12%
    const BR = Math.max(
      brNormal * (forceCrit ? 0 : 1) - (insightConvert ? 0.12 : 0),
      0
    );
    const BT = Math.min((1 - BR) * BO, BO * BP); // 会心占比
    const BV = forcePrecise ? 0 : (1 - BO) * (1 - BR); // 擦伤占比
    const BU = 1 - BR - BT - BV; // 普攻占比

    // 定音加成：技能定音类型 → 面板对应定音值
    let dy = 1;
    if (skill.dingyin_type != null) {
      // 定音词条由流派唯一决定：stats['技能定音'] 就是本流派定音值，标记为真即生效
      dy = 1 + num(S['技能定音']);
    }

    // 伤害主体：外功项 + 四系属性项（会心=均值，会意=大攻，擦伤=小攻）
    const baseTerms = (mode) => {
      const pick = (lo, hi) =>
        mode === 'big' ? hi : mode === 'small' ? lo : (lo + hi) / 2;
      let t = (pick(AT, AU) * AN + AO) * (1 + AV) * (1 + AW);
      for (const a of attrTerms) {
        t += (pick(a.small, a.big) * a.mult + a.flat) * (1 + a.pen) * (1 + a.dmg);
      }
      return t;
    };

    const M = baseTerms('avg') * (1 + AR) * BQ * count * dy * (1 + BW) * (1 + BX);
    // 注意：最新版 Excel 的会意期望同样乘 (1+BX) 特定增伤（3.1 旧版没有，勿"优化"掉）
    const N = baseTerms('big') * (1 + AR) * BS * count * dy * (1 + BW) * (1 + BX);
    const O = baseTerms('avg') * (1 + AR) * count * dy * (1 + BW) * (1 + BX);
    const P = baseTerms('small') * (1 + AR) * count * dy * (1 + BW) * (1 + BX);
    const L = M * BT + N * BR + O * BU + P * BV;

    if (debug) {
      Object.assign(inter, {
        次数: count,
        生效精准: BO, 生效会心: BP, 生效会心伤害: BQ, 生效会意: BR, 生效会意伤害: BS,
        会心占比: BT, 普攻占比: BU, 擦伤占比: BV, 特殊增伤: BW, 特定增伤: BX,
        结算增伤: agg.final_dmg,
        会心期望: M, 会意期望: N, 普通期望: O, 擦伤期望: P, 期望: L,
      });
      lastInter = inter;
    }
    return L;
  };

  // —— 两遍计算：先标准行，再覆盖行（覆盖行可能前向引用）——
  const LbyRow = {};
  const perEvent = debug ? [] : null;
  let totalDamage = 0;

  for (const ev of build.timeline) {
    if (ev.l_override) continue;
    const L = calcStandard(ev);
    LbyRow[ev.row] = L;
    totalDamage += L;
    if (debug) perEvent.push({ row: ev.row, skill: ev.skill, L, excel_L: ev.excel_L, inter: lastInter });
  }
  for (const ev of build.timeline) {
    if (!ev.l_override) continue;
    const agg = aggregateEffects(ev.effects, effects);
    let sum = 0;
    for (const ref of ev.l_override.refs) sum += LbyRow[ref] || 0;
    const bonus =
      ev.l_override.bonus === 'final_dmg' ? 1 + agg.final_dmg
      : ev.l_override.bonus === 'spec_bonus' ? 1 + agg.spec_bonus
      : 1;
    const L = sum * ev.l_override.factor * bonus;
    LbyRow[ev.row] = L;
    totalDamage += L;
    if (debug) perEvent.push({ row: ev.row, skill: ev.skill, L, excel_L: ev.excel_L, inter: null });
  }

  const duration = num(build.monster.duration && build.monster.duration.value);
  const dps = duration > 0 ? totalDamage / duration : 0;
  // 毕业基准：调用方可传方案配额物化生成的基准（议题B），缺省回退 build 包 Excel I16
  const graduateDps = num(options.graduateDps) || num(build.graduate_dps) || null;
  const result = {
    buildId: build.id || null,
    totalDamage,
    duration,
    dps,
    graduateDps,
    graduationRate: graduateDps ? dps / graduateDps : null,
  };
  if (debug) result.perEvent = perEvent;
  return result;
}

export { calcDPS, makePanel, aggregateEffects, EFFECT_FIELDS };
