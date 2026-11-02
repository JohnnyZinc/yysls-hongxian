'use strict';

/**
 * dispose.js — 处置四分类（评价系统设计.md §11，纯函数、无 IO）
 *
 * 输出**只针对当前这一件装备**：穿上 / 转律后穿上 / 放背包 / 分解。
 * （另有退化态「无法判断」= 拒绝回答，不是第五类处置。）
 *
 * 规则链（§11.3，有序，先命中先返回）：
 *   0. 部位空着                              → 穿上
 *   1. Δ转后 超死区 且 Δ转后 > Δ现状          → 转律后穿上
 *   2. 当前档 > 已穿档                        → 穿上
 *   3. 当前档 = 已穿档 且 Δ现状 超死区         → 穿上
 *   4. 当前档 或 转后档 ∈ {天, 地}             → 放背包
 *   5. 其余                                  → 分解
 *
 * 两条外部输入：
 *   - `deadZone`：Δ 死区（默认 0.005），吸收 DPS 引擎误差；
 *   - `crossFlow`：跨方案扫描结果（`surveyFlows` 的 { 天档, 可转天 }）。规则 5 之前若它在别的
 *     方案里能用 → 改判「放背包」。不传则只按当前方案判（调用方负责补这条）。
 *
 * 措辞纪律（§11.1）：只说「穿上后本套变成什么」，绝不说「比另一件好/差」。
 */

import { gradeItem, stateOf, noNewRequiredGap, noRowWorse } from './advisor.js';
import { verifyGearFits, demandAffixesOf } from './quota.js';
import { quotaCensus } from './monitor.js';
import { evaluateSwap, sameEquipKey } from './swap.js';
import { transformedItem, toGradeShape } from './transform.js';

const RANK = { 天: 3, 地: 2, 玄: 1, 黄: 0 };
const rankOf = (t) => (t && RANK[t] != null ? RANK[t] : -1);

// `reason` 是一句**完整给玩家看的话**（2026-11-01 改口语化）：
// 称呼 + 品相 + 对比 + 建议，伤害数字作为佐证。动作标签仍由 UI 单独显示（方便扫读），
// 但句子里已经包含"建议穿 / 先收着 / 拆了吧"，两者不重复。
const P = (x) => `${Math.abs(x * 100).toFixed(2)}%`;
/** 伤害增减的口语化说法；落在死区内说"基本持平" */
const dmgWord = (x, deadZone) => {
  if (x == null) return null;
  if (Math.abs(x) <= deadZone) return '伤害基本持平';
  return x > 0 ? `伤害能高 ${P(x)}` : `伤害会低 ${P(x)}`;
};

/**
 * 一句话分四段（2026-11-01 玩家定稿）：
 *   老大，这件{词条}，{品相}，{对比}，{建议}。
 * `词条` 段由 UI 渲染成可点开的样子（点开看缺哪些必备 / 哪些无效 / 初始位不能转律）。
 */
/**
 * 四段式（2026-11-01 玩家定稿）：
 *   ① 词条 + 品相   —— 每件都有
 *   ② 正在被谁用     —— 视情况（被别的配法穿着时才有；**必须排在转律建议之前**，
 *                        因为转律会改到那套，玩家得先知道这件已经有主）
 *   ③ 转律建议       —— 视情况（含"能升到几阶"）
 *   ④ 综合结论       —— 必有（动作 + 还能用在哪些方案）
 *
 * 2026-11-02 玩家定稿：从两段拆成四段。理由是"这件装备"在第三段出现时指代不明 ——
 * 前一段刚说过身上那件，读者分不清"这件"是指新的还是身上的。拆开之后每段只有一个主语。
 */
const compose = (p) => [
  // ① 这件是什么品相 + 身上那件是什么品相 + 谁更高
  `老大，这件${p.词条}，${p.tier}阶品相。`
    + `${p.已穿档 ? `而你现在穿的这件是${p.已穿档}阶品相。` : ''}`
    + `${p.穿在身上 ? '它正穿在你身上。' : ''}`
    + `${p.高下 || ''}`,
  // ② 还被别的方案用着（可选）
  `${p.使用中 ? `不过${p.使用中}。` : ''}`,
  // ③ 转律建议（可选）
  `${p.转律 ? `${p.转律}。` : ''}`,
  // ④ 结论：动作在前，"另外 N 套"用分号后置。
  //    前置试过（"另外 11 套里也是件好东西，这套帮不上忙，先留着吧"）—— 两个半句的主语在打架，
  //    读者要先在脑子里把它们接上；分号并列之后，一句说处置、一句补价值，各说各的。
  `${p.结论 ? `总之，${p.结论}${p.跨方案 ? `；${p.跨方案}` : ''}。` : ''}`,
].filter(Boolean).join('');

/**
 * 公共话术工厂：「正在被谁穿着」「另外 N 套方案」「say（拼 reason）」。
 * disposeItem（背包件）与 disposeWorn（已穿戴件）共用，避免两处各写一套文案。
 */
function narrator({ gNow, usedBy, crossFlow, 穿在身上 = false }) {
  // 「并非一无是处」只在**别处比这里更强**时加：当前档低于那个方案下的档，才叫"这边不行、那边行"。
  // 反过来（这边就不比那边差）还这么说，等于自己否定自己。
  // ⚠ 必须定义在「使用中」之前：那是个立即执行的 IIFE，写在后面会撞 TDZ。
  const 别处更值钱 = (() => {
    if (!Array.isArray(usedBy)) return false;
    return usedBy.some((u) => {
      const t = typeof u === 'string' ? null : u?.tier;
      return t && rankOf(t) > rankOf(gNow.tier);
    });
  })();

  // 「正在被谁穿着」：usedBy 可以是字符串数组，也可以是 { label, tier }（tier = 在那套下的品相）。
  // 一套：随句讲"那个方案下它是X阶"；多套：列前 3 套并各带品相，其余用"等 N 套"收尾。
  const 使用中 = (() => {
    if (!Array.isArray(usedBy) || !usedBy.length) return '';
    const 枚 = usedBy.map((u) => ({
      label: typeof u === 'string' ? u : u?.label,
      tier: typeof u === 'string' ? null : u?.tier,
    })).filter((x) => x.label);
    if (!枚.length) return '';
    const 带品相 = (x) => (x.tier ? `「${x.label}」（${x.tier}阶）` : `「${x.label}」`);
    if (枚.length === 1) {
      const x = 枚[0];
      if (!x.tier) return `这件装备目前正在被「${x.label}」方案使用`;
      // 这边黄阶、那边天阶 ⇒ "也不是一无是处"；否则老实陈述
      return 别处更值钱
        ? `这件装备也不是一无是处——它正被「${x.label}」方案用着，在那套里可是${x.tier}阶品相`
        : `这件装备目前正在被「${x.label}」方案使用，在那个方案下它是${x.tier}阶品相`;
    }
    const 头部 = 枚.slice(0, 3).map(带品相).join('、');
    const 尾巴 = 枚.length > 3 ? ` 等 ${枚.length} 套` : '';
    return `这件装备目前正被 ${枚.length} 套方案使用：${头部}${尾巴.replace(/^ 等/, '等')}`;
  })();

  const 跨方案数 = () => {
    if (!crossFlow) return 0;
    return (crossFlow.天档 || []).length + (crossFlow.可转天 || []).length;
  };
  const 跨方案话 = (() => {
    const n = 跨方案数();
    // 「N 套」这一截由 UI 变成可点（点开看具体是哪几套），这里只备纯文本
    return n > 0 ? `另外 ${n} 套里它也是件好东西` : '';
  })();

  /** 四段统一在这里拼：调用方只给"词条/对比/建议"，品相、使用中、跨方案由这里补 */
  const say = (p) => {
    // 「谁品相更高」只说现状，不下"该不该换"的结论 —— 那是第四段的事。
    // 分三档而不是两档：同档也得有个交代，否则第一段说完两个档位就断了。
    const 高下 = (() => {
      if (!p.已穿档) return '';
      const a = rankOf(gNow.tier);
      const b = rankOf(p.已穿档);
      if (a < b) return '还是你身上那件更好些。';
      if (a > b) return '这件比你身上那件强。';
      return '两件一个档。';
    })();
    const full = {
      ...p,
      tier: gNow.tier,
      已穿档: p.已穿档 || null,
      穿在身上,
      高下,
      使用中,
      // 某条分支可以显式传 跨方案:'' 来关掉第四段（它已经把这件事写进第三段了）
      跨方案: p.跨方案 === '' ? '' : 跨方案话,
      跨方案数: 跨方案数(),
    };
    return { parts: full, reason: compose(full) };
  };
  return { 使用中, 跨方案话, 跨方案数, say };
}

/** 词条段：只报数量，明细在点开之后。缺必备在前（那是硬伤），无效词条在后 */
function 词条话(g) {
  const a = [];
  if (g.m > 0) a.push(`缺 ${g.m} 条必备`);
  if (g.k > 0) a.push(`${a.length ? '另外有' : '有'} ${g.k} 条词条没什么用`);
  return a.length ? a.join('，') : '五条都对得上';
}

/**
 * @param {{
 *   buildCtx, version, affixes, selections,
 *   prescription,          // 当前方案的 derivePrescription 结果
 *   slot,                  // '武器' | '环' | '冠胄' | …
 *   item,                  // 待处置的件（装备件形状）
 *   currentGear,           // 当前整套（新件不在其中）
 *   deadZone?: number,
 *   graduateDps?: number,
 *   crossFlow?: {天档?:Array, 可转天?:Array}|null,
 * }} input
 */
export function disposeItem({
  buildCtx, version, affixes, selections,
  prescription, slot, item, currentGear,
  deadZone = 0.005, graduateDps, crossFlow = null, flow = null, usedBy = null,
}) {
  const errors = [];
  if (!prescription) errors.push('缺少 prescription（配额推导结果）');
  if (!slot) errors.push('缺少 slot（部位）');
  if (!Array.isArray(currentGear)) errors.push('currentGear 必须是装备数组');
  if (!buildCtx?.build?.name) errors.push('buildCtx 不完整（需 build.name）');
  if (!item) errors.push('缺少 item');
  if (errors.length) return { ok: false, action: '无法判断', errors };

  const gitem = toGradeShape(item);
  if ((gitem.tunings || []).length !== 4) {
    return {
      ok: true, action: '无法判断', slot, tier: null, tierAfter: null,
      deltaNow: null, deltaAfter: null, conversion: null, oldTier: null,
      reason: `老大，这件还有 ${4 - (gitem.tunings || []).length} 条调律没录，红线这会儿判断不了。`, crossFlow, errors: [],
    };
  }

  const gNow = gradeItem(prescription, slot, gitem);
  if (!gNow.ok) {
    return {
      ok: true, action: '无法判断', slot, tier: null, tierAfter: null,
      deltaNow: null, deltaAfter: null, conversion: null, oldTier: null,
      reason: `老大，这件我判断不了：${gNow.errors?.[0] || '词条组合对不上'}。`, crossFlow, errors: [],
    };
  }

  // 「而你现在穿的这件是X阶」要等 swapNow 算完才知道 —— 用闭包延后读。
  // 规则 0（部位空着）在赋值前就 return，那时仍是 null，句子自然不带这句。
  const { say: sayRaw } = narrator({ gNow, usedBy, crossFlow });
  let 已穿档 = null;
  const say = (p) => sayRaw({ 已穿档, ...p });

  const hasBase = (currentGear || []).some((g) => sameEquipKey(g, item));

  // —— 规则 0：部位空着 ——
  if (!hasBase) {
    // 防具空位 evaluateSwap 可算；武器桶为空时它按"无同类型基准"拒绝，故只取能算的那个
    const swap = evaluateSwap({
      buildCtx, version, affixes, selections, currentGear,
      newItem: item, prescription, deadZone, graduateDps,
    });
    return {
      ok: true, action: '穿上', slot,
      tier: gNow.tier, tierAfter: gNow.tierAfter,
      deltaNow: swap.ok ? swap.deltaPct : null, deltaAfter: null,
      conversion: null, oldTier: null,
      评级: gNow,
      ...say({ 词条: 词条话(gNow), 结论: '这个部位还空着，先穿上吧' }),
      crossFlow, errors: [],
      口径: '空位 ⇒ 直接穿上（§11.3 规则 0）',
    };
  }

  // —— Δ状况（现状）——
  const swapNow = evaluateSwap({
    buildCtx, version, affixes, selections, currentGear,
    newItem: item, prescription, deadZone, graduateDps,
  });
  if (!swapNow.ok) {
    return {
      ok: true, action: '无法判断', slot,
      tier: gNow.tier, tierAfter: gNow.tierAfter,
      deltaNow: null, deltaAfter: null, conversion: null, oldTier: null,
      reason: `老大，眼下没有能对照的件，判断不了（${swapNow.errors?.[0] || '缺少同类型已穿戴'}）。`, crossFlow, errors: [],
    };
  }
  const deltaNow = swapNow.deltaPct;
  const oldTier = swapNow.gradeOld?.tier ?? null;
  // 同档就不必说"你现在穿的也是X阶" —— 下面是规则 3 会说"和身上那件同为X阶"
  已穿档 = oldTier && oldTier !== gNow.tier ? oldTier : null;

  // —— 枚举转律候选（结构不可退化），逐条实算 ΔDPS，取最优 ——
  const bestConv = bestConversion({
    buildCtx, version, affixes, selections, prescription, slot, item, currentGear,
    deadZone, graduateDps, gNow, flow,
  });
  const deltaAfter = bestConv ? bestConv.delta : null;
  const 转后档 = bestConv?.tier ?? gNow.tierAfter ?? null;

  const base = {
    ok: true, slot,
    tier: gNow.tier, tierAfter: 转后档,
    deltaNow, deltaAfter,
    conversion: bestConv ? bestConv.conversion : null,
    oldTier, crossFlow, errors: [],
    评级: gNow, // 供 UI 展开词条明细（缺哪些必备 / 哪条无效 / 宫位说明）
  };

  // —— 规则 1：转律后穿上 ——
  // 2026-11-01 玩家定稿：先分「全局必需」与「可选」。
  //   全局必需（不转这条，某个配额行就凑不齐 / 整套配不满）→ 必须建议转，并说明是补哪一条；
  //   只是伤害更顺 → 不强制，改成句中附注：转不转取决于玩家。
  const 值得转 = !!bestConv && deltaAfter > deltaNow + deadZone && deltaAfter > deadZone;
  // 没传 flow 就做不了行级缺口对比 ⇒ 退化回旧口径（只要 ΔDPS 值得就转），
  // 免得调用方少传一个参数就把所有转律建议静默降级成"可选"。
  const 全局必需 = !!bestConv && (bestConv.必修
    || (bestConv.relief || []).length > 0
    || (flow == null && 值得转));
  const cv = bestConv ? bestConv.conversion : null;
  const 转后升档 = bestConv ? rankOf(bestConv.tier) > rankOf(gNow.tier) : false;
  // 规则 1 的**档位门槛**（2026-11-02 玩家实测补上）：
  //   身上穿天阶、包里这件玄阶、转律后只到地阶 —— 原逻辑照样建议"转律之后穿上"，因为
  //   "补配额"排在档位之前，等于为了补一条缺口去降两档。档位优先 = 配额优先（§11.4），
  //   而档位本身就是 (k,m) 字典序：降档就说明整体结构更差，补的那条缺口补不回降的档。
  //   转后同档是允许的（同档之争，配额说话），所以是 >= 不是 >。
  const 转后不降档 = rankOf(转后档) >= rankOf(oldTier);

  if (bestConv && 全局必需 && 转后不降档) {
    const 补的 = (bestConv.relief || []).join('/');
    return {
      ...base, action: '转律后穿上',
      ...say({
        词条: 词条话(gNow),
        // 第三段只讲转律本身：为什么值得转、转完能到几阶。
        // 这里是**配额**在决策，所以一个字都不提 DPS（玩家定稿：非必须不提伤害）。
        转律: `要穿它的话，${
          补的
            ? `直接穿这套就会少一条「${补的}」；把「${cv.from}」转成「${cv.to}」正好补上${转后升档 ? `，还能升到${bestConv.tier}阶` : ''}`
            : `把「${cv.from}」转律成「${cv.to}」正好补齐这套的缺口`
        }`,
        结论: '转律之后穿上吧',
      }),
      口径: bestConv.必修
        ? '转律后整套才配得满（结构必修，DPS 不是判据）'
        : `转律能补上配额缺口（${补的 || '缺口'}），全局必需（§11.6.1）`,
    };
  }

  // 可选转律：动作由档位/DPS 决定，转律单独成段（转不转取决于玩家）
  const 可选转律 = (bestConv && 值得转)
    ? `把这件的「${cv.from}」转律成「${cv.to}」，转后仍是${bestConv.tier}阶，${dmgWord(deltaAfter - deltaNow, deadZone)}；转不转取决于你，不转也无妨`
    : '';

  // —— 规则 2：当前档 > 已穿档（档位优先，DPS 可以为负）——
  if (rankOf(gNow.tier) > rankOf(oldTier)) {
    const down = deltaNow <= 0;
    return {
      ...base, action: '穿上',
      ...say({
        词条: 词条话(gNow),
        // "这件比身上那件强"已由第一段的「高下」说，这里不再重复。
        // 档位已经决定了穿不穿 ⇒ 不报 DPS；只有"会掉伤害"这种反直觉后果要提一句（定性，不给数字）
        转律: 可选转律,
        结论: down
          ? `换上去伤害会略降，但${gNow.tier}阶可遇不可求，往后靠承音、靠别的部位都补得回来，先穿上吧`
          : '换上吧',
      }),
      口径: `档位优先 = 配额优先（§11.4）：${gNow.tier} > ${oldTier ?? '空'}`,
    };
  }

  // —— 规则 3：同档且 Δ 超死区 ——
  if (gNow.tier === oldTier && deltaNow > deadZone) {
    return {
      ...base, action: '穿上',
      ...say({
        词条: 词条话(gNow),
        // 同档之争，DPS 是唯一判据 —— 这里是允许报伤害数字的场合之一
        转律: 可选转律,
        结论: `${dmgWord(deltaNow, deadZone)}，换它吧`,
      }),
      口径: '同档用 DPS 决胜（§11.5 第二层）',
    };
  }

  // —— 规则 4：天/地 → 放背包 ——
  const bestTier = rankOf(转后档) >= rankOf(gNow.tier) ? 转后档 : gNow.tier;
  if (rankOf(bestTier) >= RANK.地) {
    const 可升 = bestConv && rankOf(bestConv.tier) > rankOf(gNow.tier);
    return {
      ...base, action: '放背包',
      ...say({
        词条: 词条话(gNow),
        转律: 可升
          ? `把这件的「${bestConv.conversion.from}」转律成「${bestConv.conversion.to}」能升到${bestConv.tier}阶，只是眼下换上去不划算`
          : '',
        // 用 bestTier 而不是当前档：这件可能现在玄、转律后能到地，说"玄阶难得"就低估了它
        结论: `${bestTier}阶难得，先收着，等这套配齐`,
      }),
      口径: '天/地一律留（§11.3 规则 4）；放背包大概率是**同档**候补',
    };
  }

  // —— 跨方案兜底：别的方案能用 → 放背包 ——
  const crossHit = !!(crossFlow && ((crossFlow.天档 || []).length || (crossFlow.可转天 || []).length));
  if (crossHit) {
    // 这一支天然是"当前方案用不上、别的方案能用"，跨方案那句由第四段统一拼（narrator 的 跨方案话），
    // 这里不再自己写一遍，否则同一件事说两遍。
    const n = (crossFlow.天档 || []).length + (crossFlow.可转天 || []).length;
    return {
      ...base, action: '放背包',
      ...say({
        词条: 词条话(gNow),
        结论: '这套里帮不上忙，先留着吧',
      }),
      口径: '跨方案可用 ⇒ 留（§11.7）',
    };
  }

  // —— 规则 5：分解 ——
  return {
    ...base, action: '分解',
    ...say({
      词条: 词条话(gNow),
      结论: '这套用不上它，换到别的配法也没它的位置，拆了吧',
      跨方案: '',
    }),
    口径: '玄/黄且无正收益转律、跨方案也无位置（§11.3 规则 5）',
  };
}

/**
 * 已穿戴件的处置（2026-11-01 玩家定稿）：它已经在身上，问题不是「穿不穿」，而是「留不留 / 要不要转」。
 *
 * 动作集合：`留着` / `转律后继续用` / `可以分解`（外加退化态 `无法判断`）。
 * 语句结构与背包件完全一致（四段：品相 / 别处价值 / 转律 / 结论），只是第一段末尾交代
 * 「它正穿在你身上」，并且**不出现**「比你现在穿的那件」这种和自身比较的说法。
 */
export function disposeWorn({
  buildCtx, version, affixes, selections,
  prescription, slot, item, currentGear,
  deadZone = 0.005, graduateDps, crossFlow = null, flow = null, usedBy = null,
}) {
  const errors = [];
  if (!prescription) errors.push('缺少 prescription（配额推导结果）');
  if (!slot) errors.push('缺少 slot（部位）');
  if (!Array.isArray(currentGear)) errors.push('currentGear 必须是装备数组');
  if (!buildCtx?.build?.name) errors.push('buildCtx 不完整（需 build.name）');
  if (!item) errors.push('缺少 item');
  if (errors.length) return { ok: false, action: '无法判断', errors };

  const gitem = toGradeShape(item);
  if ((gitem.tunings || []).length !== 4) {
    return {
      ok: true, action: '无法判断', slot, tier: null, tierAfter: null,
      deltaNow: null, deltaAfter: null, conversion: null, oldTier: null,
      reason: `老大，这件还有 ${4 - (gitem.tunings || []).length} 条调律没录，红线这会儿判断不了。`, crossFlow, errors: [],
    };
  }
  const gNow = gradeItem(prescription, slot, gitem);
  if (!gNow.ok) {
    return {
      ok: true, action: '无法判断', slot, tier: null, tierAfter: null,
      deltaNow: null, deltaAfter: null, conversion: null, oldTier: null,
      reason: `老大，这件我判断不了：${gNow.errors?.[0] || '词条组合对不上'}。`, crossFlow, errors: [],
    };
  }
  const { say } = narrator({ gNow, usedBy, crossFlow, 穿在身上: true });

  const bestConv = bestConversion({
    buildCtx, version, affixes, selections, prescription, slot, item, currentGear,
    deadZone, graduateDps, gNow, flow,
  });
  const deltaAfter = bestConv ? bestConv.delta : null;
  const 转后档 = bestConv?.tier ?? gNow.tierAfter ?? null;
  const 值得转 = !!bestConv && deltaAfter != null && deltaAfter > deadZone;
  // 没传 flow 就做不了行级缺口对比 ⇒ 退化回旧口径（与 disposeItem 同一条兜底）
  const 全局必需 = !!bestConv && (bestConv.必修
    || (bestConv.relief || []).length > 0
    || (flow == null && 值得转));
  const cv = bestConv ? bestConv.conversion : null;
  const 转后升档 = bestConv ? rankOf(bestConv.tier) > rankOf(gNow.tier) : false;

  // 已穿戴 ⇒ 第一段末尾交代"它正穿在你身上"（它已经在用，不需要"要穿它的话"这种前提）
  const base = {
    ok: true, slot, // 已穿戴 ⇒ Δ现状 恒为 0，不用 evaluateSwap 跟自己比
    tier: gNow.tier, tierAfter: 转后档,
    deltaNow: 0, deltaAfter,
    conversion: cv, oldTier: gNow.tier, crossFlow, errors: [],
    评级: gNow, 穿在身上: true,
  };

  // —— 转律能补配额 ⇒ 转完继续用 ——
  if (bestConv && 全局必需) {
    const 补的 = (bestConv.relief || []).join('/');
    return {
      ...base, action: '转律后继续用',
      ...say({
        词条: 词条话(gNow),
        转律: 补的
          ? `这套的「${补的}」还差一条，把「${cv.from}」转成「${cv.to}」正好补上${转后升档 ? `，还能升到${bestConv.tier}阶` : ''}`
          : `把「${cv.from}」转律成「${cv.to}」更合这套的配额`,
        结论: '转律之后接着用吧',
      }),
      口径: '转律补配额（§11.6.1）⇒ 转完继续用',
    };
  }

  // —— 天/地（含转后能到的）⇒ 留着 ——
  const 留 = rankOf(转后档) >= RANK.地 || rankOf(gNow.tier) >= RANK.地;
  if (留) {
    const 可选转律 = 值得转
      ? `把这件的「${cv.from}」转律成「${cv.to}」，${dmgWord(deltaAfter, deadZone)}；转不转取决于你，不转也无妨`
      : '';
    return {
      ...base, action: '留着',
      ...say({
        词条: 词条话(gNow),
        转律: 转后升档 ? `把这件的「${cv.from}」转律成「${cv.to}」还能升到${bestConv.tier}阶` : 可选转律,
        结论: '留着吧，别拆',
      }),
      口径: '天/地可遇不可求 ⇒ 留着（§11.3 规则 4）',
    };
  }

  // —— 跨方案能用 ⇒ 留着 ——
  const n = crossFlow ? (crossFlow.天档 || []).length + (crossFlow.可转天 || []).length : 0;
  if (n > 0) {
    return {
      ...base, action: '留着',
      ...say({
        词条: 词条话(gNow),
        结论: '这套里只是暂时顶着，先留着',
      }),
      口径: '跨方案可用 ⇒ 留（§11.7）',
    };
  }

  // —— 其余 ⇒ 可以分解 ——
  return {
    ...base, action: '可以分解',
    ...say({
      词条: 词条话(gNow),
      结论: '这套里只是暂时顶着，往后换到更好的再拆',
      跨方案: '',
    }),
    口径: '玄/黄且无转律价值、跨方案也没位置 ⇒ 换下来即可分解',
  };
}

/** 枚举单条转律候选（结构不可退化），逐条实算 ΔDPS，返回最优的一条 */
function bestConversion({
  buildCtx, version, affixes, selections, prescription, slot, item, currentGear,
  deadZone, graduateDps, gNow, flow = null,
}) {
  const st = stateOf(prescription, slot, toGradeShape(item));
  if (!st.ok) return null;

  // 配额缺口的行级对比（转律前后）——用来回答"这条转律是不是全局必需"：
  //   不转就凑不齐的某一行，转了正好补上 ⇒ 必修；两条都在需求内、只是数值更顺 ⇒ 可选。
  const aliasMap = prescription._aliasMap || null;
  const gapRows = (gearList) => {
    if (!flow) return null;
    try { return quotaCensus(gearList, flow, aliasMap).rows; } catch { return null; }
  };
  /** 转律后缺口**减少**的行（按词条名返回），空数组=没改善 */
  const gapRelief = (before, after) => {
    if (!before || !after) return [];
    const out = [];
    for (let i = 0; i < before.length && i < after.length; i++) {
      if ((after[i].缺口 ?? 0) < (before[i].缺口 ?? 0)) {
        const names = Array.isArray(before[i].词条) ? before[i].词条 : [before[i].词条];
        out.push(names.filter(Boolean).join('/'));
      }
    }
    return out;
  };
  const gitem = toGradeShape(item);
  const tunings = gitem.tunings;
  const markedIdx = (gitem.converted || []).indexOf(true);
  const pool = st.conversionPool || [];

  // 本件在整套里的下标（uid 优先，双枪时按类型会找错）
  let idx = item?.uid != null ? currentGear.findIndex((g) => g?.uid != null && g.uid === item.uid) : -1;
  if (idx < 0) idx = currentGear.findIndex((g) => sameEquipKey(g, item));
  if (idx < 0) return null;

  // 「本件按现状穿上」这套配不配得满 —— 必修判定的基准（不是拿旧件当基准）
  const asIsGear = currentGear.map((g, i) => (i === idx ? item : g));
  const 需求集 = demandAffixesOf(prescription); // 转律目标必须在配额需求内，否则不改善装配
  // 还有废词条时只能转废的那条（先把 k 降下来），否则会把有效词条转掉、废词条留着
  const 无效调律 = new Set((st.invalid || []).filter((u) => u.position === 'tuning').map((u) => u.affix));
  const 当前可行 = verifyGearFits(prescription, asIsGear);
  const 有空槽 = asIsGear.length < 8;

  const beforeRows = gapRows(asIsGear);
  // 排序：必修（不转就配不满） > 能减少配额缺口（全局更顺） > 其余，同档再看 DPS
  const rank = (c) => {
    if (c.fitRank !== 0) return c.fitRank;
    if (c.必修) return -2;
    if (c.relief.length) return -1;
    return 0;
  };
  let best = null;
  for (let j = 0; j < tunings.length; j++) {
    if (markedIdx >= 0 && j !== markedIdx) continue; // 已标记转律位 ⇒ 只能继续转那一条
    const from = tunings[j];
    if (gNow.k > 0 && !无效调律.has(from)) continue; // 有废词条 ⇒ 只转废的那条
    for (const to of pool) {
      if (to === from) continue;
      if (需求集.size && !需求集.has(to)) continue; // 不在配额需求内 ⇒ 转了也不改善装配
      if (tunings.some((t, k) => k !== j && t === to)) continue; // 调律互不重复
      const conversion = { from, to, index: j };
      const trial = transformedItem(item, conversion, affixes);
      const gt = gradeItem(prescription, slot, toGradeShape(trial));
      if (!gt.ok) continue;
      if (gt.k > gNow.k || gt.m > gNow.m) continue; // 结构不可退化（档位优先）
      // 转律后到不了天/地 ⇒ 不建议（玩家定稿 2026-11-01）：
      // 花材料把一件玄换成另一件玄，收益只在数值上，不值得烧转律次数与三天 CD。
      if (rankOf(gt.tier) < RANK.地) continue;
      // 不得「用一个必备换另一个必备」（m 总数不变、洞挪了位置 ⇒ 等于没解决）
      if (!noNewRequiredGap(gNow.missing, gt.missing)) continue;
      const sw = evaluateSwap({
        buildCtx, version, affixes, selections, currentGear,
        newItem: trial, prescription, deadZone, graduateDps,
      });
      if (!sw.ok) continue;

      // 转后整套是否配得满：钉住已穿件 + 本件转后形态
      const gearWithTrial = currentGear.map((g, i) => (i === idx ? trial : g));
      const gfit = verifyGearFits(prescription, gearWithTrial);
      const fitRank = gfit === true ? 0 : gfit === null ? 1 : 2;
      const 必修 = 有空槽 && gfit === true && 当前可行 === false;

      // 转律让哪些配额行的缺口变小了（空数组 = 全局上没有变化，只是数值更顺）
      const afterRows = gapRows(gearWithTrial);
      // 不能把洞挪到别的行：只要有一行变差就否决（总数看起来没变，玩家转了等于白发材料）
      if (!noRowWorse(beforeRows, afterRows)) continue;
      const relief = gapRelief(beforeRows, afterRows);
      const cand = { conversion, tier: gt.tier, k: gt.k, m: gt.m, delta: sw.deltaPct, gfit, fitRank, 必修, relief };
      if (!best) { best = cand; continue; }
      // 排序：可行性 → 必修 → DPS（与 adviseConversion 同口径）
      const rb = rank(cand);
      const rbest = rank(best);
      const better = rb < rbest
        || (rb === rbest && cand.必修 && !best.必修)
        || (rb === rbest && cand.必修 === best.必修 && cand.delta > best.delta);
      if (better) best = cand;
    }
  }
  return best;
}
