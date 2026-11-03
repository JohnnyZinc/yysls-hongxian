'use strict';

/**
 * panel.js — 装备 + 可选层 → 最终面板
 *
 * 输出即 dps.js 的输入（统一 schema，不再有第二层转换）。
 *
 * 输入（computePanel 的参数对象）：
 *   version     版本数据包（JSON，data/version/；提取器已从仓库删除（需要时查 git 历史））
 *   affixes     词条数据包（tools/convert_affix_md.py 产出）
 *   build       { 流派: '破竹风' }
 *   gear        8件装备实例：{ slot, 承音, 初始:{属性,数值}, 调律:[{属性,数值}×4], 定音:{属性,数值} }
 *   selections  { 弓玦, 装备套装, 心法:[×4], 武库 }
 *
 * 输出：
 *   { stats, 五维达标率, 主属性达标率, warnings }
 *   stats 键全部使用游戏内全称（项目约定：内部一律全称，不用简称）：
 *   - 指定武学增伤按武器类型直接进 stats（`${类型}武学增伤`，为 0 不出键）；
 *   - 技能定音为单一数值（护甲定音词条的数值无条件计入，名字不参与判断——
 *     定音对流派是定死的、可随意重掷，数值才是事实，随掷出结果变化，
 *     是 ΔDPS 的真实变量之一）；
 *   - 最终生效会心率/最终生效会意率/最终生效会心会意率：不含技能级标记的面板基准值，
 *     技能级标记的逐技能修正在 dps.js。公式见 知识库/燕云十六声的四种伤害与三率.md。
 *
 * 转换规则（数值行为与面板计算器 v0.1 W 列逐条对齐，仅键名全称化）：
 *   精准率 = 65%基线 + (raw − 65%)/(1+判定抗性)
 *   会心率 = (raw + 敏×0.076%)/(1+判定抗性)；会意率同（势×0.038%）
 *   最小外功攻击 = raw + 劲×0.22 + 敏×0.9；最大外功攻击 = raw + 劲×1.36 + 势×0.9
 *   外功穿透 = 固定层 + 装备词条(含定音)/(1+增益抗性) + 可选层   ← 只有外功穿透这样拆
 *   全武学增伤/对首领单位增伤/全奇术增伤/`${武器}武学增伤`/技能定音 = 全额/(1+增益抗性)
 *   其余属性纯求和
 *   武学天赋：会心/会意/外功天赋 ×MIN(五维达标率,1)；
 *             主属性攻击天赋不缩放；主属性穿透/加成天赋 ×MIN(主属性达标率,1)
 */

const num = (v) => (typeof v === 'number' ? v : 0);

import { weaponTypesOf } from './quota.js';

/** 名字归一：游戏内拼写变体/旧版提取短名 → 唯一全称（面板 schema 层归一，非社区叫法别名——
 *  社区叫法→真名的数据在 affixes.别名，由 quota.js canonicalAffix 处理） */
const NAME_CANON = {
  最小外功: '最小外功攻击', 最大外功: '最大外功攻击',
  最小鸣金: '最小鸣金攻击', 最大鸣金: '最大鸣金攻击',
  最小裂石: '最小裂石攻击', 最大裂石: '最大裂石攻击',
  最小牵丝: '最小牵丝攻击', 最大牵丝: '最大牵丝攻击',
  最小破竹: '最小破竹攻击', 最大破竹: '最大破竹攻击',
  最小无相: '最小无相攻击', 最大无相: '最大无相攻击',
  全武增: '全武学增伤',
  首领增: '对首领单位增伤', 首领单位增伤: '对首领单位增伤',
  奇术增: '全奇术增伤', 奇术增伤: '全奇术增伤',
  对玩家单位增伤: '对玩家单位增效', 玩家增效: '对玩家单位增效',
  会心伤害: '会心伤害加成', 会意伤害: '会意伤害加成',
  直议会心率: '直接会心率', 直议会意率: '直接会意率',
};

// 三率上限的兼容缺省（权威值在 version.json constants；仅当版本包缺键时兜底，盘点 §2.2 #1）
const DEFAULT_CAPS = { 精准率上限: 1, 黄字会心率上限: 0.8, 黄字会意率上限: 0.4 };

function norm(name) {
  name = String(name).trim();
  return NAME_CANON[name] || name;
}

/** 三桶结构：fixed(固定层) / optional(弓玦+套装+心法+武库+天赋) / affix(装备词条) */
function makeBuckets() {
  return { fixed: {}, optional: {}, affix: {} };
}

function computePanel(input) {
  const { version, build, gear = [], selections = {} } = input;
  const warnings = [];
  const C = version.constants;
  const buckets = makeBuckets();
  let dingyinSum = 0;

  // 武器类型清单：派生自版本包"指定武学增伤包括"（单一来源，盘点 §2.2 #4）
  const weaponTypes = weaponTypesOf(input.affixes);
  // 属性攻击/无相求和清单：派生自词条区间键（最[小大]<系>攻击 模式，盘点 §2.2 #6）
  const attrAtkKeys = Object.keys((input.affixes && input.affixes.词条区间) || {})
    .filter((k) => /^最[小大](鸣金|裂石|牵丝|破竹|无相)攻击$/.test(k));

  const add = (bucket, stat, v) => {
    buckets[bucket][stat] = num(buckets[bucket][stat]) + v;
  };

  // ---- 1. 固定层：六表求和 ----
  for (const table of Object.values(version.fixed)) {
    for (const [k, v] of Object.entries(table)) add('fixed', norm(k), num(v));
  }

  // ---- 2. 可选层选择 ----
  const optSource = (table, name, label) => {
    if (!name) return;
    const rec = table[name];
    if (!rec) { warnings.push(`未知的${label}: ${name}`); return; }
    for (const [k, v] of Object.entries(rec)) add('optional', norm(k), num(v));
  };
  optSource(version.弓玦, selections.弓玦, '弓玦');
  optSource(version.装备套装, selections.装备套装, '装备套装');
  for (const x of selections.心法 || []) optSource(version.心法, x, '心法');
  optSource(version.武库, selections.武库, '武库');

  // ---- 3. 装备词条 ----
  const affixRanges = (input.affixes && input.affixes.词条区间) || {};
  for (const piece of gear) {
    if (!piece) continue;
    const slot = piece.slot || '';
    // 武器不分左右（用户定稿）：部位=武器 与 武器1/武器2 两个槽位同属攻具
    const isArmorDing = !['武器1', '武器2', '武器', '环', '佩'].includes(slot);
    const list = [
      ['初始', piece.初始],
      ['调律1', piece.调律 ? piece.调律[0] : null],
      ['调律2', piece.调律 ? piece.调律[1] : null],
      ['调律3', piece.调律 ? piece.调律[2] : null],
      ['调律4', piece.调律 ? piece.调律[3] : null],
      ['定音', piece.定音],
    ];
    for (const [kind, aff] of list) {
      if (!aff || !aff.属性 || typeof aff.数值 !== 'number') continue;
      const raw = norm(aff.属性);
      const v = aff.数值;
      // 承音上限校验（定音无承音惩罚）
      if (piece.承音 && kind !== '定音') {
        const range = affixRanges[raw] || affixRanges[aff.属性];
        if (range && range.承音 != null && v > range.承音 + 1e-9) {
          warnings.push(`承音装备词条超上限: ${slot} ${aff.属性}=${v} > 承音值${range.承音}`);
        }
      }
      // 护甲定音：对流派是定死的、可随意重掷——名字不参与判断，数值无条件计入技能定音
      if (kind === '定音' && isArmorDing
          && !['外功穿透', '无相穿透', '外功抗性'].includes(raw)) {
        dingyinSum += v;
        continue;
      }
      add('affix', raw, v);
    }
  }

  // ---- 4. 武学天赋 ----
  const talent = (version.武学天赋 && version.武学天赋[build.流派]) || null;
  if (!talent) warnings.push(`武学天赋表缺少流派: ${build.流派}（按无天赋处理）`);

  // 4a. 五维 final（纯求和）
  const WUXU = ['体', '劲', '御', '敏', '势'];
  const wuxuFinal = {};
  for (const s of WUXU) {
    wuxuFinal[s] = num(buckets.fixed[s]) + num(buckets.optional[s]) + num(buckets.affix[s]);
  }

  // 4b. 不缩放天赋：主属性攻击（最小/最大）
  const talentScaled5 = [];   // 需要五维达标率缩放的天赋
  let attrReqStat = null;
  if (talent) {
    for (const [k, v] of Object.entries(talent)) {
      if (['五维要求', '五维要求数值', '属性要求', '属性要求数值'].includes(k)) continue;
      const nk = norm(k);
      const isMainAtk = /^最小(鸣金|裂石|牵丝|破竹)攻击$/.test(nk);
      const isWuxuScaled = ['会心率', '会意率', '最小外功攻击', '最大外功攻击'].includes(nk);
      if (isMainAtk) {
        add('optional', nk, num(v)); // 不缩放
      } else if (isWuxuScaled) {
        talentScaled5.push([nk, num(v)]);
      } else if (/穿透$|加成$/.test(nk)) {
        // 主属性穿透/加成天赋 → 延后按主属性达标率缩放
      } else {
        add('optional', nk, num(v)); // 兜底：不缩放
      }
    }
    attrReqStat = norm(talent['属性要求'] || '');
  }

  // 4c. 五维达标率
  let ratio5 = 1;
  if (talent && talent['五维要求']) {
    const req = num(talent['五维要求数值']);
    if (req > 0) ratio5 = Math.min(wuxuFinal[talent['五维要求']] / req, 1);
  }
  for (const [k, v] of talentScaled5) add('optional', k, v * ratio5);

  // 4d. 主属性达标率（用含不缩放天赋的预最终值；缩放天赋不进攻击行，无循环）
  let ratioMain = 1;
  if (talent && attrReqStat) {
    const pre = num(buckets.fixed[attrReqStat]) + num(buckets.optional[attrReqStat]) + num(buckets.affix[attrReqStat]);
    const req = num(talent['属性要求数值']);
    if (req > 0) ratioMain = Math.min(pre / req, 1);
    const elem = attrReqStat.replace(/^最[小大](鸣金|裂石|牵丝|破竹)攻击$/, '$1');
    if (elem !== attrReqStat) {
      if (talent[elem + '穿透'] != null) add('optional', elem + '穿透', num(talent[elem + '穿透']) * ratioMain);
      if (talent[elem + '加成'] != null) add('optional', elem + '加成', num(talent[elem + '加成']) * ratioMain);
    }
  }

  // ---- 5. 最终转换 ----
  const total = (stat) => num(buckets.fixed[stat]) + num(buckets.optional[stat]) + num(buckets.affix[stat]);
  const stats = {};
  for (const s of WUXU) stats[s] = wuxuFinal[s];

  // 精准率/会心率/会意率（判定抗性）
  const jk = 1 + C['判定抗性'];
  const precisionRaw = total('精准率');
  stats['精准率'] = C['精准率基线'] + (precisionRaw - C['精准率基线']) / jk;
  const critContrib = num(version['五维贡献']['会心率']['敏']);
  const insightContrib = num(version['五维贡献']['会意率']['势']);
  stats['会心率'] = (total('会心率') + wuxuFinal['敏'] * critContrib) / jk;
  stats['会意率'] = (total('会意率') + wuxuFinal['势'] * insightContrib) / jk;

  // 攻击（五维贡献）
  stats['最小外功攻击'] = total('最小外功攻击') + wuxuFinal['劲'] * num(version['五维贡献']['最小外功']['劲'])
    + wuxuFinal['敏'] * num(version['五维贡献']['最小外功']['敏']);
  stats['最大外功攻击'] = total('最大外功攻击') + wuxuFinal['劲'] * num(version['五维贡献']['最大外功']['劲'])
    + wuxuFinal['势'] * num(version['五维贡献']['最大外功']['势']);

  // 属性攻击/无相：纯求和（清单由词条区间键派生）
  for (const s of attrAtkKeys) {
    stats[s] = total(s);
  }

  // 外功穿透（词条部分除增益抗性，其余不除）
  stats['外功穿透'] = num(buckets.fixed['外功穿透'])
    + num(buckets.affix['外功穿透']) / (1 + C['增益抗性'])
    + num(buckets.optional['外功穿透']);

  // 增益类：全额除增益抗性
  for (const s of ['全武学增伤', '对首领单位增伤', '全奇术增伤']) {
    stats[s] = total(s) / (1 + C['增益抗性']);
  }
  // 指定武学增伤按武器类型：与对首领单位增伤同级、无条件出键（为 0 也出键，
  // 保证覆盖语义下不残留作者基准值；零值过滤是 UI 的事）
  for (const t of weaponTypes) {
    const k = `${t}武学增伤`;
    stats[k] = total(k) / (1 + C['增益抗性']);
  }
  // 技能定音：单一数值
  stats['技能定音'] = dingyinSum / (1 + C['增益抗性']);

  // 其余纯求和
  for (const s of ['会心伤害加成', '会意伤害加成', '直接会心率', '直接会意率',
    '鸣金穿透', '鸣金加成', '裂石穿透', '裂石加成', '牵丝穿透', '牵丝加成',
    '破竹穿透', '破竹加成', '无相穿透', '外功伤害加成', '外功治疗加成',
    '外功抗性', '外功防御', '外功伤害减免', '气血最大值', '鸣金伤害加成',
    '对玩家单位增效']) {
    stats[s] = total(s);
  }

  // 最终生效三率（不含技能级标记的面板基准；公式见 知识库/燕云十六声的四种伤害与三率.md）
  //   bo = 黄字精准率（cap 精准率上限）；bp = 黄字会心率（cap 黄字会心率上限）+ 直接会心率（不受 cap）；
  //   br = 黄字会意率（cap 黄字会意率上限）+ 直接会意率（不受 cap）
  //   最终生效会心率 = bo × min(bp, 1−br)   ← 会意+会心 > 100% 时会心被挤占
  //   最终生效会意率 = br                    ← 会意不受精准命中影响
  //   最终生效会心会意率 = 两者之和（用户定义）
  //   上限值来自 version.constants（与判定抗性同族；缺键时按 DEFAULT_CAPS 兜底并警告）
  const capOf = (k) => {
    const v = C[k];
    if (typeof v !== 'number') {
      warnings.push(`版本包 constants 缺少「${k}」，按默认 ${DEFAULT_CAPS[k]} 处理（请补数据）`);
      return DEFAULT_CAPS[k];
    }
    return v;
  };
  const bo = Math.min(capOf('精准率上限'), stats['精准率']);
  const bp = Math.min(capOf('黄字会心率上限'), stats['会心率']) + stats['直接会心率'];
  const br = Math.min(capOf('黄字会意率上限'), stats['会意率']) + stats['直接会意率'];
  stats['最终生效会心率'] = bo * Math.min(bp, 1 - br);
  stats['最终生效会意率'] = br;
  stats['最终生效会心会意率'] = bo * Math.min(bp, 1 - br) + br;

  // 守卫：未识别的装备词条 → 警告（静默丢弃会变成"看不见的数值黑洞"）
  // 已知词条全集 = 五维/三率/攻击/增益类 + 派生清单（attrAtkKeys/weaponTypes）
  const KNOWN = new Set([
    ...WUXU, '精准率', '会心率', '会意率',
    '最小外功攻击', '最大外功攻击',
    ...attrAtkKeys,
    '外功穿透', '全武学增伤', '对首领单位增伤', '全奇术增伤',
    ...weaponTypes.map((t) => `${t}武学增伤`),
    '会心伤害加成', '会意伤害加成', '直接会心率', '直接会意率',
    '鸣金穿透', '鸣金加成', '裂石穿透', '裂石加成', '牵丝穿透', '牵丝加成',
    '破竹穿透', '破竹加成', '无相穿透', '外功伤害加成', '外功治疗加成',
    '外功抗性', '外功防御', '外功伤害减免', '气血最大值', '鸣金伤害加成',
    '对玩家单位增效',
  ]);
  for (const k of Object.keys(buckets.affix)) {
    if (!KNOWN.has(k)) warnings.push(`未识别的装备词条（未计入面板，请核对词条名或更新数据）: ${k}`);
  }

  return {
    stats,
    五维达标率: ratio5,
    主属性达标率: ratioMain,
    warnings,
  };
}

export { computePanel };
