'use strict';

/**
 * test_conversion.js — 全局感知转律建议（engine/advisor.js adviseConversion）
 *
 * 覆盖用户定稿（2026-11-01 大修，见 评价系统设计.md §11.6）：
 *   1. 等阶由当前词条决定（局部），转律建议单独算、不并入等阶；
 *   2. 门槛 = **Δ转后 超死区**（旧门槛「转后必须到天阶」已废：实测会产出负收益建议）；
 *      无 dpsOf 时降级为「只给救废型（k 减少）」；
 *   3. 排序：DPS 主序、全局配额缺口为次；死区内并列列出；
 *   4. 结构型（档位升天）/ 优化型（已天档）分开标注；
 *   5. 已标记转律位时只能继续转那一条；
 *   6. 候选全枚举（至多 1 条转律 ⇒ ≈40~60 个），不做贪心近似。
 */

import fs from 'fs';
import { derivePrescription, solveAssignment } from '../engine/quota.js';
import { stateOf, adviseConversion, gradeItem, noNewRequiredGap, noRowWorse } from '../engine/advisor.js';

const affixes = JSON.parse(fs.readFileSync('data/version/nanlvxianghe-shang.115/affixes.json', 'utf8'));
const flow = JSON.parse(fs.readFileSync('data/template/mingjinhong/mingjinhong.dawai.json', 'utf8'));
const rx = derivePrescription(affixes, flow, ['剑', '枪']);

let pass = 0; const failures = [];
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('✓', name); } else { failures.push(name); console.log('✗', name); }
};

/** 用毕业分配造一套装备（8 件），再按 mutate 扰动剑 */
function buildGear(mutate) {
  const units = solveAssignment(rx._base.arrangementSpecs[0].spec, rx._base.lineOf);
  const bySlot = {};
  for (const u of units) (bySlot[u.slot] ||= []).push(u.affix);
  const gear = Object.entries(bySlot).map(([slot, list]) => ({
    slot,
    weaponType: rx.slotTypes?.[slot] || '',
    初始: { 属性: list[0] },
    调律: list.slice(1).map((a) => ({ 属性: a })),
  }));
  const sword = gear.find((g) => g.slot === '武器1');
  if (mutate) mutate(sword, gear);
  return { gear, sword };
}
const swordItem = (sword) => ({
  weaponType: sword.weaponType,
  initial: sword.初始.属性,
  tunings: sword.调律.map((t) => t.属性),
  converted: [false, false, false, false],
});
const OPTS = (gear) => ({ gear, flow });

console.log('— 场景A：天档但全局缺会意率（剑多带1条劲）—');
{
  const { gear, sword } = buildGear((s) => {
    const i = s.调律.findIndex((t) => t.属性 === '会意率');
    s.调律[i].属性 = '劲';
  });
  const item = swordItem(sword);
  const st = stateOf(rx, '武器', item);
  const plain = adviseConversion(rx, '武器', item, OPTS(gear));
  check('A0：当前档位仍是天（局部判定，不受全局影响）', st.ok && st.tier === '天');
  check('A1：无 DPS 依据 ⇒ 不给建议（k 未下降，结构没改善）', plain.ok && plain.suggestions.length === 0);
  check('A2：门槛说明指向"无 DPS 依据"', /无 DPS 依据/.test(plain.门槛 || ''));

  // 有 DPS 依据：会意率权重远高于劲 ⇒ 劲→会意率 真收益
  const dpsOf = (g) => {
    let d = 0;
    for (const p of g) for (const u of [p.初始?.属性, ...(p.调律 || []).map((t) => t.属性)]) {
      if (u === '会意率') d += 1000;
      else if (u === '劲') d += 50;
      else if (u === '势') d += 10;
    }
    return d;
  };
  const r = adviseConversion(rx, '武器', item, { ...OPTS(gear), dpsOf, deadZone: 0.005 });
  check('A3：有 DPS 依据且 Δ 超死区 ⇒ 给建议', r.ok && r.suggestions.length === 1);
  check('A4：转律为 劲→会意率', r.suggestions[0]?.from === '劲' && r.suggestions[0]?.to === '会意率');
  check('A5：标注为优化型（已是天档）', r.suggestions[0]?.kind === '优化型');
  check('A6：带出 deltaPct 且为正', typeof r.suggestions[0]?.deltaPct === 'number' && r.suggestions[0].deltaPct > 0);
}

console.log('\n— 场景B：拆东墙补西墙 → 不给建议（即使能转）—');
{
  // 缺口落在「对首领单位增伤」（胫甲/腕甲专属，剑的转律池里没有）⇒ 剑无论怎么转都减少不了缺口
  const { gear, sword } = buildGear((s, g) => {
    const t = g.find((x) => x.slot === '胫甲');
    const i = t.调律.findIndex((x) => x.属性 === '对首领单位增伤');
    t.调律[i].属性 = '最大鸣金攻击';
  });
  const r = adviseConversion(rx, '武器', swordItem(sword), OPTS(gear));
  check('B：本件是天档', r.ok && r.tier === '天');
  check('B：全局确有缺口', r.gapBefore >= 1);
  check('B：不给出任何转律建议（无 DPS 依据 + k 不变）', r.ok && r.suggestions.length === 0);
  check('B：门槛说明指向"无 DPS 依据"', /无 DPS 依据/.test(r.门槛 || ''));
}

console.log('\n— 场景C：玄档 + 废词条 → 结构型建议 —');
{
  const { gear, sword } = buildGear((s) => {
    const i = s.调律.findIndex((t) => t.属性 === '会意率');
    s.调律[i].属性 = '敏'; // 敏不在武器有效集 ⇒ k=1 ⇒ 玄
  });
  const item = swordItem(sword);
  const st = stateOf(rx, '武器', item);
  const r = adviseConversion(rx, '武器', item, OPTS(gear));
  check('C：当前档位是玄（废词条「敏」）', st.ok && st.tier === '玄' && st.k === 1);
  check('C：给出转律建议', r.ok && r.suggestions.length >= 1);
  check('C：转掉的是「敏」', r.suggestions.every((s) => s.from === '敏'));
  check('C：标注为结构型（档位升到天）',
    r.suggestions[0]?.kind === '结构型' && r.suggestions[0]?.tierAfter === '天');
}

// 剑 = 大外/大外/剑增/劲/敏：全局缺会意率1、缺势1、劲溢出1（总缺口 2），且「敏」是废词条
function doubleGapGear() {
  return buildGear((s) => {
    s.调律[s.调律.findIndex((t) => t.属性 === '会意率')].属性 = '劲';
    s.调律[s.调律.findIndex((t) => t.属性 === '势')].属性 = '敏';
  });
}

console.log('\n— 场景D：并列时用 DPS 决胜 —');
{
  const { gear, sword } = doubleGapGear();
  const item = swordItem(sword);
  // 先确认确实有多个并列候选（转任一条都能把缺口 2→1）
  const plain = adviseConversion(rx, '武器', item, OPTS(gear));
  check('D0：无 DPS 依据时给出多条候选（救废型）',
    plain.ok && plain.suggestions.length > 1);
  check('D0：候选全部是消灭「敏」这条无效词条（救废型）',
    plain.suggestions.every((s) => s.from === '敏' && s.救废 === true && s.kAfter === 0));
  check('D0：转后全部升为天档、标结构型',
    plain.suggestions.every((s) => s.tierAfter === '天' && s.kind === '结构型'));

  const dpsOf = (g) => {
    let d = 0;
    for (const p of g) for (const u of [p.初始?.属性, ...(p.调律 || []).map((t) => t.属性)]) {
      if (u === '会意率') d += 1000;
      else if (u === '劲') d += 50;
      else if (u === '势') d += 10;
    }
    return d;
  };
  const r = adviseConversion(rx, '武器', item, { ...OPTS(gear), dpsOf, deadZone: 0.005 });
  check('D：并列已被 DPS 收敛为 1 条', r.ok && r.suggestions.length === 1);
  check('D：DPS 更高的「会意率」胜出', r.suggestions[0]?.to === '会意率');
  check('D：带出 dpsBefore / dpsGain', typeof r.dpsBefore === 'number' && typeof r.suggestions[0]?.dpsGain === 'number');
}

console.log('\n— 场景E：两个候选 DPS 提升相同 → 并列列出 —');
{
  const { gear, sword } = doubleGapGear();
  const item = swordItem(sword);
  // 会意率与势权重相同 ⇒ 敏→会意率 与 敏→势 提升完全相等，落在死区内
  const dpsOf = (g) => {
    let d = 0;
    for (const p of g) for (const u of [p.初始?.属性, ...(p.调律 || []).map((t) => t.属性)]) {
      if (u === '会意率' || u === '势') d += 1000;
    }
    return d;
  };
  const r = adviseConversion(rx, '武器', item, { ...OPTS(gear), dpsOf, deadZone: 0.005 });
  check('E：并列列出（不止 1 条）', r.ok && r.suggestions.length > 1);
  check('E：并列标记为真', r.并列 === true);
  check('E：并列项 DPS 完全相同', new Set(r.suggestions.map((s) => s.dpsAfter)).size === 1);
}

console.log('\n— 场景F：已标记转律位 → 只能继续转那一条 —');
{
  const { gear, sword } = doubleGapGear();
  // 剑调律 = [最大外功攻击, 剑武学增伤, 劲, 敏]；标记第 4 条（敏，废词条）⇒ 只能继续转它
  const item = { ...swordItem(sword), converted: [false, false, false, true] };
  const r = adviseConversion(rx, '武器', item, OPTS(gear));
  check('F：确有建议（标记位转后能到天档）', r.ok && r.suggestions.length > 0);
  check('F：建议只能来自被标记的那一条（调律4）', r.suggestions.every((s) => s.position === 3));
  check('F：被转掉的词条是「敏」', r.suggestions.every((s) => s.from === '敏'));
  check('F：建议全部是结构型（转后到天）', r.suggestions.every((s) => s.tierAfter === '天' && s.kind === '结构型'));

  // 对照1：标记「大外」那条时，转它会新增大外缺口（拆东墙）⇒ 不给建议
  const bad = { ...swordItem(sword), converted: [true, false, false, false] };
  const rb = adviseConversion(rx, '武器', bad, OPTS(gear));
  check('F对照1：标记位转了会拆东墙 ⇒ 不给建议', rb.ok && rb.suggestions.length === 0);

  // 对照2（2026-11-01 门槛）：标记「劲」那条 ⇒ 只能转劲，救不了「敏」⇒ 不给建议
  const imp = { ...swordItem(sword), converted: [false, false, true, false] };
  const ri = adviseConversion(rx, '武器', imp, OPTS(gear));
  check('F对照2：无效词条不在可转位 ⇒ 不给建议',
    ri.ok && ri.suggestions.length === 0 && /无法消除无效词条/.test(ri.门槛 || ''));
}

console.log('\n— 场景I：转后升天但 DPS 反而下降 ⇒ 不给建议（新门槛的反例）—');
{
  // 复刻实测反例：破竹风大外流·胫甲，地档缺劲件现状 +3.28%、转「会心率」→「劲」后掉到 +1.29%，
  // 即"转后到天但净损"。旧门槛（tierAfter==='天'）会给这条建议，新门槛拒绝。
  // 这里用权重模拟：劲的收益远高于会意率 ⇒ 把劲转成会意率是净损。
  const { gear, sword } = buildGear((s) => {
    const i = s.调律.findIndex((t) => t.属性 === '会意率');
    s.调律[i].属性 = '劲';
  });
  const item = swordItem(sword);
  const dpsOf = (g) => {
    let d = 0;
    for (const p of g) for (const u of [p.初始?.属性, ...(p.调律 || []).map((t) => t.属性)]) {
      if (u === '劲') d += 1000;
      else if (u === '会意率') d += 10;
    }
    return d;
  };
  const r = adviseConversion(rx, '武器', item, { ...OPTS(gear), dpsOf, deadZone: 0.005 });
  check('I：转后仍是天档，但 DPS 下降 ⇒ 不给建议', r.ok && r.suggestions.length === 0);
  check('I：门槛说明"未超过死区"', /未超过死区/.test(r.门槛 || ''));
  check('I：当前档位仍为天（等阶不受转律影响）', r.tier === '天');
}

console.log('\n— 场景J：还有空槽时，「转后能配满」优先于 DPS（牵丝玉·走地玉·大外流）—');
{
  // 真实案例（用户报告）：6 件已穿 + 一把伞，只差胸甲。
  // 伞 = 初始大外 / 调律[伞增, 大外, 小外, 会心]，小外是废词条。
  // 转「小外→劲」和「小外→敏」都能升天、缺口都剩 5，但**只有转劲**能让剩下的胸甲补齐配额
  // （劲缺 2，而胸甲初始池不出劲、调律又不能重复 ⇒ 胸甲最多 1 条劲）。
  // 旧版按 DPS 排序会建议转敏（DPS 更高但整套配不满），本用例锁定修正后的结论。
  const qFlow = {
    ...JSON.parse(fs.readFileSync('data/template/qiansiyu/qiansiyu.zoudiyu.dawai.json', 'utf-8')),
    flowId: 'zoudiyu.dawai',
  };
  const rxQ = derivePrescription(affixes, qFlow, ['伞', '扇']);
  const FQ = { 伞武学增伤: 0.1, 扇武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
  const VQ = (n) => { const r = affixes.词条区间[n]; return r ? (r.承音 ?? r.max) : (FQ[n] ?? 0); };
  const mkQ = (slot, i, t, uid, wt) => ({
    slot, uid, weaponType: wt,
    初始: { 属性: i, 数值: VQ(i) },
    调律: t.map((a) => ({ 属性: a, 数值: VQ(a) })),
  });
  const gear6 = [
    mkQ('武器', '最大外功攻击', ['扇武学增伤', '最大外功攻击', '会心率', '劲'], 'fan', '扇'),
    mkQ('环', '最大外功攻击', ['最大外功攻击', '全武学增伤', '会心率', '劲'], 'ring'),
    mkQ('佩', '最大外功攻击', ['最大外功攻击', '全武学增伤', '会心率', '劲'], 'pend'),
    mkQ('冠胄', '精准率', ['最大外功攻击', '会心率', '劲', '敏'], 'helm'),
    mkQ('胫甲', '劲', ['最大外功攻击', '对首领单位增伤', '会心率', '劲'], 'shin'),
    mkQ('腕甲', '劲', ['最大外功攻击', '对首领单位增伤', '会心率', '敏'], 'bracer'),
  ];
  const umbrella = mkQ('武器', '最大外功攻击', ['伞武学增伤', '最大外功攻击', '最小外功攻击', '会心率'], 'umbrella', '伞');
  const gearWithU = [...gear6, umbrella];
  // 故意把「敏」的权重调到远高于「劲」，检验配额可行性优先于 DPS
  const dpsOf = (g) => {
    let d = 0;
    for (const p of g) for (const u of [p.初始?.属性, ...(p.调律 || []).map((t) => t.属性)]) {
      if (u === '敏') d += 1000;
      else if (u === '劲') d += 10;
    }
    return d;
  };
  const r = adviseConversion(rxQ, '武器', {
    weaponType: '伞', initial: umbrella.初始.属性, tunings: umbrella.调律.map((t) => t.属性),
    converted: [false, false, false, false],
  }, { gear: gearWithU, flow: qFlow, dpsOf, deadZone: 0.005, uid: 'umbrella' });

  check('J1：给出建议', r.ok && r.suggestions.length >= 1);
  check('J2：建议转「最小外功攻击」→「劲」（不是 DPS 更高的敏）',
    r.suggestions[0]?.from === '最小外功攻击' && r.suggestions[0]?.to === '劲');
  check('J3：标注为必修（现在配不满，转后能配满）', r.suggestions[0]?.必修 === true);
  check('J4：转后整套可行', r.suggestions[0]?.可行 === true);
  check('J5：敏不在建议里（转敏会导致劲无法补齐）',
    !r.suggestions.some((x) => x.to === '敏'));

  // —— K：转律目标必须是配额需求内的词条 ——
  // 用户报告的第二个案例：同位置的伞，词条换成「初大外 / [伞增, 外功防御, 大外, 会心]」。
  // 旧版会建议「外功防御 → 会意率」——而会意率根本不在本方案配额里，转了不减少任何缺口。
  // 注：这里只留**一条**废词条（外功防御），因为 2026-11-01 起「转后到不了天/地就不建议转」
  //     是硬门槛；两条废词的件转完仍是玄，按新规则不该给任何建议（场景 M 专门锁这条）。
  const umb2 = mkQ('武器', '最大外功攻击', ['伞武学增伤', '外功防御', '最大外功攻击', '会心率'], 'umb2', '伞');
  const gear2 = [...gear6, umb2];
  const r2 = adviseConversion(rxQ, '武器', {
    weaponType: '伞', initial: umb2.初始.属性, tunings: umb2.调律.map((t) => t.属性),
    converted: [false, false, false, false],
  }, { gear: gear2, flow: qFlow, dpsOf, deadZone: 0.005, uid: 'umb2' });
  const DEMAND = new Set(['最大外功攻击', '伞武学增伤', '扇武学增伤', '全武学增伤',
    '对首领单位增伤', '会心率', '精准率', '敏', '劲']);
  check('K1：给出建议', r2.ok && r2.suggestions.length >= 1);
  check('K2：所有转律目标都落在配额需求内', r2.suggestions.every((x) => DEMAND.has(x.to)));
  check('K3：不再出现「会意率」（配额里没有它）',
    !r2.suggestions.some((x) => x.to === '会意率'));
  check('K4：转掉的只能是那条废词条（外功防御），不会去动有效词条',
    r2.suggestions.every((x) => x.from === '外功防御'));
}

console.log('\n— 场景L：转律试算必须按**目标词条**重取数值（用户第三例）—');
{
  // 同 6 件 + 伞（初大外 / [伞增, 外功防御, 小外, 会心]）。
  // 小外参与面板（`最小外功攻击 = raw + 劲×0.22 + 敏×0.9`，且 `extMax = max(小外+elem, 大外+elem)`），
  // 外功防御完全不参与 ⇒ 保留小外、转掉外防 必然更优。
  // 旧实现只改词条名、**沿用被转掉那条的数值**：小外 131.2 被当成敏（虚高 58%）、
  // 外防 65.6 被当成敏（虚低 21%），于是把「小外→敏」算成 +2.04%、「外防→敏」算成 +1.71%，结论反了。
  const { loadBuild } = await import('./load-build.js');
  const { loadVersionData } = await import('./load-version.js');
  const { evalGearDps } = await import('../engine/swap.js');
  const { transformedItem, toGradeShape } = await import('../engine/transform.js');
  const { version, affixes: aff } = loadVersionData();
  const buildCtx = loadBuild('pozhufeng.115.3.2');
  const sel = {
    装备套装: buildCtx.build.selectors.set,
    武库: buildCtx.build.selectors.weapon_attribute,
  };
  const FB = { 伞武学增伤: 0.1, 扇武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
  const V = (n) => { const r2 = aff.词条区间[n]; return r2 ? (r2.承音 ?? r2.max) : (FB[n] ?? 0); };
  const mk3 = (slot, i, t, uid, wt) => ({
    slot, uid, weaponType: wt,
    初始: { 属性: i, 数值: V(i) },
    调律: t.map((a) => ({ 属性: a, 数值: V(a) })),
  });

  const qFlow2 = {
    ...JSON.parse(fs.readFileSync('data/template/qiansiyu/qiansiyu.zoudiyu.dawai.json', 'utf-8')),
    flowId: 'zoudiyu.dawai',
  };
  const rxQ2 = derivePrescription(aff, qFlow2, ['伞', '扇']);
  const six = [
    mk3('武器', '最大外功攻击', ['扇武学增伤', '最大外功攻击', '会心率', '劲'], 'fan', '扇'),
    mk3('环', '最大外功攻击', ['最大外功攻击', '全武学增伤', '会心率', '劲'], 'ring'),
    mk3('佩', '最大外功攻击', ['最大外功攻击', '全武学增伤', '会心率', '劲'], 'pend'),
    mk3('冠胄', '精准率', ['最大外功攻击', '会心率', '劲', '敏'], 'helm'),
    mk3('胫甲', '劲', ['最大外功攻击', '对首领单位增伤', '会心率', '劲'], 'shin'),
    mk3('腕甲', '劲', ['最大外功攻击', '对首领单位增伤', '会心率', '敏'], 'bracer'),
  ];
  // 单条废词条（小外）⇒ 转成「劲」后升天，正好落在新门槛（转后到天/地）之内。
  // 小外参与面板（`最小外功攻击 = raw + 劲×0.22 + 敏×0.9`，且 `extMax = max(小外+elem, 大外+elem)`）；
  // 旧实现只改词条名、**沿用被转掉那条的数值**，会把「劲」按小外的 131.2 计价（虚高），
  // 于是把这条转律算成 +0.69%（正确值 +0.008%）。改成按目标词条重取承音值。
  const u3 = mk3('武器', '最大外功攻击', ['伞武学增伤', '最小外功攻击', '最大外功攻击', '会心率'], 'u3', '伞');
  const gear3 = [...six, u3];
  const dps3 = (g) => evalGearDps({ buildCtx, version, affixes: aff, gear: g, selections: sel }).dps;
  const base3 = dps3(gear3);
  const pctOf = (g) => dps3(g) / base3 - 1;
  // 正确口径：按目标词条重取数值
  const correct = (idx, to) => gear3.map((g) => (g.uid === 'u3' ? transformedItem(g, { index: idx, to }, aff) : g));
  // 旧口径：只换名字、沿用原数值
  const legacy = (idx, to) => gear3.map((g) => (g.uid === 'u3'
    ? { ...g, 调律: g.调律.map((t, k) => (k === idx ? { ...t, 属性: to } : t)) }
    : g));

  const r3 = adviseConversion(rxQ2, '武器', toGradeShape(u3),
    { gear: gear3, flow: qFlow2, dpsOf: dps3, deadZone: 0.005, uid: 'u3' });
  const s3 = r3.suggestions[0];

  check('L1：首选「最小外功攻击」→「劲」，转后升天', s3?.from === '最小外功攻击' && s3?.to === '劲'
    && s3?.tierAfter === '天');
  check('L2：Δ 与「按目标词条重取数值」的实算一致（不是沿用原数值）',
    Math.abs((s3?.deltaPct ?? -9) - pctOf(correct(s3.position, s3.to))) < 0.001);
  check('L3：沿用旧口径会把它算得明显更高（证明该断言能抓到回归）',
    pctOf(legacy(s3.position, s3.to)) > pctOf(correct(s3.position, s3.to)) + 0.002);

  // —— M：转后到不了天/地 ⇒ 一条建议都不给（玩家定稿 2026-11-01）——
  // 两条废词条的伞：转掉任意一条仍停在玄阶 ⇒ 不值得烧材料与三天 CD。
  const u4 = mk3('武器', '最大外功攻击', ['伞武学增伤', '外功防御', '最小外功攻击', '会心率'], 'u4', '伞');
  const r4 = adviseConversion(rxQ2, '武器', toGradeShape(u4),
    { gear: [...six, u4], flow: qFlow2, dpsOf: dps3, deadZone: 0.005, uid: 'u4' });
  check('M1：档位是黄（两条废词条）', r4.ok && r4.tier === '黄');
  check('M2：转后最多只能到玄 ⇒ 不给任何转律建议', r4.suggestions.length === 0);
}

console.log('\n— 场景N：不许「用一个必备换另一个必备」（裂石钧·纯唐轴·小外流，玩家实测）—');
{
  // 玩家实测：8 件里只有胫甲缺敏（地档，m=1），其余四词条含本槽必备「最小外功攻击」。
  // 工具曾建议「把小外转成敏」——转完 m 仍是 1（洞从敏挪到小外），却因为能让「敏」这一行
  // 缺口变少而被判成"全局必需"。小外是必备，玩家不可能转它；正确做法是等一个更好的环。
  const { loadBuild } = await import('./load-build.js');
  const { loadVersionData } = await import('./load-version.js');
  const { evalGearDps } = await import('../engine/swap.js');
  const { version, affixes: aff } = loadVersionData();
  const nFlow = {
    ...JSON.parse(fs.readFileSync('data/template/lieshijun/lieshijun.chuntang.xiaowai.json', 'utf-8')),
    flowId: 'chuntang.xiaowai',
  };
  const rxN = derivePrescription(aff, nFlow, ['陌刀', '横刀']);
  const buildCtx = loadBuild('pozhufeng.115.3.2');
  const sel = { 装备套装: buildCtx.build.selectors.set, 武库: buildCtx.build.selectors.weapon_attribute };
  const FB = { 陌刀武学增伤: 0.1, 横刀武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
  const V = (n) => { const r = aff.词条区间[n]; return r ? (r.承音 ?? r.max) : (FB[n] ?? 0); };
  const mk = (slot, i, t, uid, wt) => ({
    slot, uid, weaponType: wt,
    初始: { 属性: i, 数值: V(i) },
    调律: t.map((a) => ({ 属性: a, 数值: V(a) })),
  });
  const units = solveAssignment(rxN._base.arrangementSpecs[0].spec, rxN._base.lineOf);
  const bySlot = {};
  for (const u of units) (bySlot[u.slot] ||= []).push(u.affix);
  const grad = Object.entries(bySlot).map(([key, list]) => ({
    slot: key.startsWith('武器') ? '武器' : key,
    slotKey: key,
    weaponType: rxN.slotTypes?.[key] || undefined,
    uid: `g_${key}`,
    初始: { 属性: list[0], 数值: V(list[0]) },
    调律: list.slice(1).map((a) => ({ 属性: a, 数值: V(a) })),
  }));
  const SHIN_T = ['会心率', '最小外功攻击', '对首领单位增伤', '精准率'];
  const ring = mk('环', '最小外功攻击', ['最小外功攻击', '全武学增伤', '最小牵丝攻击', '敏'], 'ring');
  const shin = mk('胫甲', '会心率', SHIN_T, 'shin');
  const gear = grad.map((g) => (g.slot === '环' ? ring : (g.slot === '胫甲' ? shin : g)));

  const gradeOf = (tunings) => gradeItem(rxN, '胫甲', {
    initial: '会心率', tunings, converted: [false, false, false, false],
  });
  const gBefore = gradeOf(SHIN_T);
  const gSwap = gradeOf(['会心率', '敏', '对首领单位增伤', '精准率']); // 小外 → 敏（换洞）
  const gSpare = gradeOf(['敏', '最小外功攻击', '对首领单位增伤', '精准率']); // 会心 → 敏（会心不是必备）

  const 必备 = new Set((rxN.arrangements[0].slots['胫甲'].required || []).map((x) => x.affix));
  check('N0 胫甲的本槽必备含「最小外功攻击」', 必备.has('最小外功攻击'));
  check('N1 换成敏之后 m 完全没变（总数看不出问题）', gBefore.m === gSwap.m && gBefore.m === 1);
  check('N2 noNewRequiredGap 否决这种「换洞」', noNewRequiredGap(gBefore.missing, gSwap.missing) === false);
  check('N3 转掉非必备的会心（本来就有两条）是允许的', noNewRequiredGap(gBefore.missing, gSpare.missing) === true);

  const dpsOf = (g) => evalGearDps({ buildCtx, version, affixes: aff, gear: g, selections: sel }).dps;
  const r = adviseConversion(rxN, '胫甲', {
    initial: '会心率', tunings: SHIN_T, converted: [false, false, false, false],
  }, { gear, flow: nFlow, dpsOf, deadZone: 0.005, uid: 'shin' });

  check('N4 仍有合法建议（不是一刀切不给，例：把多余的那条会心转成敏）',
    (r.suggestions || []).length >= 1);
  check('N4b 建议里不出现「转掉本槽必备」的候选',
    (r.suggestions || []).every((x) => !必备.has(x.from)));
  check('N5 首选不是「小外 → 敏」',
    !(r.suggestions?.[0]?.from === '最小外功攻击' && r.suggestions?.[0]?.to === '敏'));
}

console.log('\n— 场景G：参数缺失 / 非法输入 —');
{
  const { gear, sword } = buildGear();
  const item = swordItem(sword);
  check('G：缺 gear → 拒绝', adviseConversion(rx, '武器', item, { flow }).ok === false);
  check('G：缺 flow → 拒绝', adviseConversion(rx, '武器', item, { gear }).ok === false);
  check('G：调律不足4条 → 拒绝',
    adviseConversion(rx, '武器', { ...item, tunings: item.tunings.slice(0, 3) }, OPTS(gear)).ok === false);
  check('G：整套装备里找不到本件 → 拒绝',
    adviseConversion(rx, '武器', { ...item, weaponType: '陌刀' }, OPTS(gear)).ok === false);
}

console.log('\n— 场景H：stateOf 与 gradeItem 口径一致 —');
{
  const { gradeItem } = await import('../engine/advisor.js');
  const { gear, sword } = buildGear((s) => {
    s.调律[s.调律.findIndex((t) => t.属性 === '会意率')].属性 = '敏';
  });
  const item = swordItem(sword);
  const a = stateOf(rx, '武器', item);
  const b = gradeItem(rx, '武器', item);
  check('H：stateOf 与 gradeItem 档位一致', a.ok && b.ok && a.tier === b.tier && a.k === b.k && a.m === b.m);
}

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗', f);
  process.exitCode = 1;
}
