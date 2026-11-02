'use strict';

/**
 * test_dispose.js — 处置四分类（engine/dispose.js，评价系统设计.md §11）
 *
 * 基准：真实破竹风·大外流 build + 承音值词条；当前 8 件中「胫甲」是历史遗留的玄档（带气血）。
 * 用例覆盖 §11.3 六条规则链 + 跨方案兜底 + 退化态。
 *
 * 期望来源（实测，见 .workbuddy/memory/2026-11-01.md）：
 *   玄档旧胫甲时全配 DPS = 100,197；天档会心件 +3.16%；玄档外防件 0.00%（转律后 +1.29%）；
 *   地档缺劲件 +3.28%（转律后反而降到 +1.29%，故不得建议转律）。
 */

import fs from 'node:fs';
import { loadBuild } from './load-build.js';
import { derivePrescription } from '../engine/quota.js';
import { loadVersionData } from './load-version.js';
import { disposeItem, disposeWorn } from '../engine/dispose.js';

const { version, affixes } = loadVersionData();
const flow = { ...JSON.parse(fs.readFileSync('data/template/pozhufeng/pozhufeng.dawai.json', 'utf-8')), flowId: 'dawai' };
const rx = derivePrescription(affixes, flow, ['双刀', '绳镖']);
const buildCtx = loadBuild('pozhufeng.115.3.2');
const selections = {
  装备套装: buildCtx.build.selectors.set,
  武库: buildCtx.build.selectors.weapon_attribute,
};

let pass = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('✓', name); } else { failures.push(name); console.log('✗', name); }
};

const FALLBACK = { 双刀武学增伤: 0.1, 绳镖武学增伤: 0.1, 全武学增伤: 0.05, 对首领单位增伤: 0.055 };
const V = (n) => {
  const r = affixes.词条区间[n];
  return r ? (r.承音 ?? r.max) : (FALLBACK[n] ?? 0);
};
const mk = (slot, initial, tunings, uid) => ({
  slot, uid: uid || `u_${slot}_${initial}`,
  初始: { 属性: initial, 数值: V(initial) },
  调律: tunings.map((a) => ({ 属性: a, 数值: V(a) })),
});

// 当前 8 件：胫甲为玄档（带气血）
const oldShin = mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '气血最大值'], 'old_shin');
const base = [
  mk('武器1', '最大外功攻击', ['最大外功攻击', '劲', '双刀武学增伤', '会心率'], 'w1'),
  mk('武器2', '最大外功攻击', ['最大外功攻击', '劲', '绳镖武学增伤', '会心率'], 'w2'),
  mk('环', '最大外功攻击', ['最大外功攻击', '全武学增伤', '劲', '会心率'], 'ring'),
  mk('佩', '最大外功攻击', ['最大外功攻击', '全武学增伤', '劲', '精准率'], 'pend'),
  mk('冠胄', '精准率', ['最大外功攻击', '劲', '会心率', '势'], 'helm'),
  mk('胸甲', '会心率', ['最大外功攻击', '劲', '会心率', '势'], 'chest'),
  oldShin,
  mk('腕甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率'], 'bracer'),
];

const D = (newItem, extra = {}) => disposeItem({
  buildCtx, version, affixes, selections,
  prescription: rx, slot: '胫甲', item: newItem, currentGear: base,
  deadZone: 0.005, ...extra,
});

// —— 规则 2：天档、DPS 更高 → 穿上 ——
console.log('— 规则 2：天档会心件（档位更高）—');
{
  const r = D(mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率'], 't2'));
  check('2.1 档位 = 天', r.tier === '天');
  check('2.2 处置 = 穿上', r.action === '穿上');
  check('2.3 Δ 为正', r.deltaNow > 0);
  check('2.4 未采纳转律（转律后不会更好）', !(r.deltaAfter > r.deltaNow + 0.005));
  check('2.5 段①末尾接「而你现在穿的这件是X阶品相」（2026-11-02 并句）',
    /^老大，这件.+品相。而你现在穿的这件是[天地玄黄]阶品相。/.test(r.reason));
  check('2.6 parts.已穿档 = 已穿那件的档位', r.parts.已穿档 === r.oldTier);
}

// —— 规则 1：玄档、现状持平、转律后明显更好 → 转律后穿上 ——
console.log('\n— 规则 1：玄档外防件（转律后才值得穿）—');
{
  const r = D(mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '外功防御'], 'x1'));
  check('1.1 当前档 = 玄', r.tier === '玄');
  check('1.2 处置 = 转律后穿上', r.action === '转律后穿上');
  check('1.3 转掉的是「外功防御」', r.conversion?.from === '外功防御');
  check('1.3b 转后升为天档', r.tierAfter === '天');
  check('1.4 Δ转后 高于 Δ现状', r.deltaAfter > r.deltaNow);
  check('1.5 Δ转后 为正', r.deltaAfter > 0);
  // 规则 1 的档位门槛（2026-11-02 玩家实测补上）：转后档位不得低于已穿档。
  // 破竹风这套里转律总能回到天阶，构造不出"降档"用例，所以从代码层锁住这条门槛。
  check('1.6 规则 1 带档位门槛（降档时不许「转律后穿上」）',
    /转后不降档 = rankOf\(转后档\) >= rankOf\(oldTier\)/.test(
      fs.readFileSync('engine/dispose.js', 'utf-8')));
}

// —— 规则 2 前置：地档但有天档潜力，转律反而变差 → 直接穿上，不得建议转律 ——
console.log('\n— 反例：地档缺劲件（转律到天但净损 2pp）—');
{
  const r = D(mk('胫甲', '劲', ['最大外功攻击', '会心率', '对首领单位增伤', '势'], 'd1'));
  check('D.1 当前档 = 地', r.tier === '地');
  check('D.2 处置 = 直接穿上（不是转律后穿上）', r.action === '穿上');
  check('D.3 Δ现状 为正且大于 Δ转后', r.deltaNow > 0 && r.deltaAfter != null && r.deltaAfter < r.deltaNow);
  check('D.4 conversion 未被采纳为处置（action 不是转律后穿上）', r.action !== '转律后穿上');
}

// —— 规则 3：同档、DPS 明显更高 → 穿上 ——
console.log('\n— 规则 3：同档（玄 vs 玄）DPS 更高 —');
{
  // 初始会意（不在 freeSet）⇒ k=1 ⇒ 玄；其余词条与旧件相同 ⇒ 同档
  const r = D(mk('胫甲', '会意率', ['最大外功攻击', '劲', '对首领单位增伤', '会心率'], 'same'));
  check('3.1 当前档 = 玄（与已穿同档）', r.tier === '玄' && r.oldTier === '玄');
  check('3.2 处置落在穿上或转律后穿上', r.action === '穿上' || r.action === '转律后穿上');
  check('3.3 有明确理由（一行）', typeof r.reason === 'string' && r.reason.length > 0);
}

// —— 规则 5：黄档废件 → 分解 ——
// 初始气血（不可转）+ 三条无效调律 ⇒ k=4；任一转律只能降到 k=3，仍是黄档且 DPS 远低于当前
const junkItem = (uid) => mk('胫甲', '气血最大值', ['体', '御', '外功防御', '会心率'], uid);
console.log('\n— 规则 5：黄档废件 → 分解 —');
{
  const r = D(junkItem('junk'));
  check('5.1 档位 = 黄', r.tier === '黄');
  check('5.2 处置 = 分解', r.action === '分解');
  check('5.3 Δ现状 不为正', !(r.deltaNow > 0.005));
  // 文案：这一支本来就"哪儿都用不上"，不能再带「如果你想要在当前方案使用…」这个前提
  check('5.4 句子不带「如果你想要在当前方案使用这件装备」',
    !/如果你想要在当前方案使用这件装备/.test(r.reason));
  check('5.5 说清两件事：这套用不上 + 别的配法也没位置',
    /这套用不上它/.test(r.reason) && /别的配法也没它的位置/.test(r.reason));
}

// —— 跨方案兜底：当前方案判分解，但别的方案能用 → 放背包 ——
console.log('\n— 跨方案兜底：他方案可用 ⇒ 放背包 —');
{
  const r = D(junkItem('junk2'), { crossFlow: { 天档: [{ key: 'x', label: '破竹樽·大外流' }], 可转天: [] } });
  check('X.1 处置 = 放背包（不是分解）', r.action === '放背包');
  check('X.2 理由不点名某个方案，只说"另外 N 套"',
    /另外 \d+ 套/.test(r.reason) && !/破竹樽/.test(r.reason));
}

// —— 规则 0：部位空着 → 穿上 ——
console.log('\n— 规则 0：空位 → 穿上 —');
{
  const noShin = base.filter((g) => g.slot !== '胫甲');
  const r = disposeItem({
    buildCtx, version, affixes, selections,
    prescription: rx, slot: '胫甲',
    item: mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '气血最大值'], 'empty_slot'),
    currentGear: noShin, deadZone: 0.005,
  });
  check('0.1 处置 = 穿上', r.action === '穿上');
  check('0.2 理由说明补空位', /空/.test(r.reason));
  check('0.2b 空槽不带「如果你想要在当前方案使用…」前提（部位空着跟想不想用无关）',
    !/如果你想要在当前方案使用这件装备/.test(r.reason));
}

// —— 退化态：信息不足 ——
console.log('\n— 退化态：信息不足 → 无法判断 —');
{
  const bad = mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤'], 'short');
  const r = D(bad);
  check('N.1 处置 = 无法判断', r.action === '无法判断');
  check('N.2 说明缺什么', /条调律没录|调律词条不足/.test(r.reason));

  const wrongType = { ...mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '势'], 'wt'), weaponType: '陌刀' };
  const r2 = disposeItem({
    buildCtx, version, affixes, selections,
    prescription: rx, slot: '武器', item: wrongType, currentGear: base,
  });
  check('N.3 武器类型与流派不符 ⇒ 拒绝', r2.action === '无法判断');
  check('N.4 ok 仍为 true（拒绝回答不是错误）', r2.ok === true);
}

// —— 全局必需 vs 可选转律（2026-11-01 玩家定稿）——
// 玩家原话：天档要不要转律看全局——不转就凑不齐某条 ⇒ 必须建议转并说明理由；
//           全局没必要 ⇒ 只说"可以转、伤害更高，转不转取决于你"。
// 判据 = 转律前后**按行**对比配额缺口（bestConversion 的 relief）。
console.log('\n— 全局必需 vs 可选转律 —');
{
  // ① 全局必需：新件带一条「势」，直接穿会把「会心率」挤掉一条，转成会心率正好补回
  const shinWithShi = mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '势'], 'shi1');
  const r1 = D(shinWithShi, { flow });
  check('Y1 判定为转律后穿上（全局必需）', r1.action === '转律后穿上');
  check('Y2 说清"直接穿会少一条"（点名被挤掉的词条行）',
    /直接穿/.test(r1.reason) && /少一条/.test(r1.reason));
  check('Y3 给出具体转律方向', /转成「会心率」/.test(r1.reason));

  // ② 全局必需但伤害反而降 —— 必须明说"用伤害换配额"，不许只讲好处
  const shinNeedJin = mk('胫甲', '劲', ['最大外功攻击', '会心率', '对首领单位增伤', '势'], 'shi2');
  const r2 = D(shinNeedJin, { flow });
  check('Y4 判定仍为转律后穿上（补缺口优先于 DPS）', r2.action === '转律后穿上');
  // 玩家定稿（2026-11-01）：配额已经能决定的事，**一个字都不许提 DPS**
  check('Y5 全局必需时句子里不出现任何伤害数字（决策依据是配额）',
    !/伤害会|伤害能|用伤害换/.test(r2.reason) && !/\d+\.\d+%/.test(r2.reason));
  check('Y5b 句尾直接落到「转律之后穿上吧」', /转律之后穿上吧。$/.test(r2.reason));

  // ③ 不传 flow ⇒ 做不了缺口对比，退化回旧口径（不能把全部转律建议静默降级成"可选"）
  const r3 = D(shinWithShi);
  check('Y6 无 flow 时退化：仍给出转律后穿上', r3.action === '转律后穿上');
  check('Y7 无 flow 时不写"直接穿会少一条"（没有行级数据就不编）',
    !/直接穿的话/.test(r3.reason));
}

// —— 已穿戴件（disposeWorn，2026-11-01）：问题从「穿不穿」变成「留不留 / 要不要转」 ——
// —— 「正在被别的方案用着」：只有别处更值钱才说"并非一无是处" ——
console.log('\n— 使用中：别处是否更值钱 —');
{
  const junk = mk('胫甲', '气血最大值', ['体', '御', '外功防御', '会心率'], 'used_huang');
  const rHigh = D(junk, { usedBy: [{ label: '牵丝玉·走地玉·大外流', tier: '天' }] });
  check('U1 别处天阶、这里黄阶 ⇒ 说「也不是一无是处」', /也不是一无是处/.test(rHigh.reason));
  check('U2 点名方案与那套的品相',
    /「牵丝玉·走地玉·大外流」/.test(rHigh.reason) && /天阶品相/.test(rHigh.reason));

  const rLow = D(junk, { usedBy: [{ label: '某套方案', tier: '黄' }] });
  check('U3 别处不比这里高 ⇒ 只陈述，不贬低自己',
    !/一无是处/.test(rLow.reason) && /正在被「某套方案」方案使用/.test(rLow.reason));
}

console.log('\n— 已穿戴件：留着 / 转律后继续用 / 可以分解 —');
{
  const W = (item, extra = {}) => disposeWorn({
    buildCtx, version, affixes, selections,
    prescription: rx, slot: '胫甲', item,
    currentGear: base.map((g) => (g.slot === '胫甲' ? item : g)),
    deadZone: 0.005, flow, ...extra, // UI 总是传 flow（行级缺口对比）
  });

  // ① 天档：留着（或转律后继续用）——但绝不能说「比你现在穿的那件」
  const w1 = W(mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '势'], 'worn_t'));
  check('Z1 天档已穿 ⇒ 留着 / 转律后继续用',
    ['留着', '转律后继续用'].includes(w1.action));
  check('Z2 第一段末尾交代「它正穿在你身上」', /它正穿在你身上/.test(w1.reason));
  check('Z3 不跟自己比较（没有「比你现在穿的那件」）', !/比你现在穿的那件/.test(w1.reason));
  check('Z4 无 crossFlow 时不编「另外 N 套方案」', !/另外 \d+ 套方案/.test(w1.reason));

  // ② 玄档、转律能补缺口且升天 ⇒ 转律后继续用
  const w2 = W(mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '外功防御'], 'worn_x'));
  check('Z5 玄档+转律可升天补缺口 ⇒ 转律后继续用', w2.action === '转律后继续用');
  check('Z6 说明补的是哪一条缺口', /还差一条/.test(w2.reason) && /转成「会心率」/.test(w2.reason));

  // ③ 黄档、转完仍到不了天/地、别的方案也用不上 ⇒ 可以分解
  const w3 = W(mk('胫甲', '气血最大值', ['体', '御', '外功防御', '气血最大值'], 'worn_j'));
  check('Z7 黄档废件 ⇒ 可以分解', w3.action === '可以分解');
  check('Z8 给出「换到更好的再拆」的时机（不是无条件丢弃）', /往后换到更好的/.test(w3.reason));

  // ④ 信息不足 ⇒ 无法判断（拒绝回答，不给错建议）
  const w4 = W(mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤'], 'worn_short'));
  check('Z9 调律没录满 ⇒ 无法判断', w4.action === '无法判断' && !/建议/.test(w4.reason || ''));
}

// —— 措辞纪律（2026-11-01 改口语化后重定）——
// 旧纪律"不得出现比…好/差"已作废：玩家原文要求"相比当前穿戴的那件更好"这种说法。
// 新纪律：① 每条理由都是一句对玩家说的话（带称呼）；② 负面比较必须给绝对值（伤害会低 x%），
// 不许用"更强/更弱"这类无法验证的含糊词。
console.log('\n— 措辞纪律 —');
{
  const items = [
    mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '会心率'], 'c1'),
    mk('胫甲', '劲', ['最大外功攻击', '劲', '对首领单位增伤', '外功防御'], 'c2'),
    mk('胫甲', '气血最大值', ['最大外功攻击', '劲', '对首领单位增伤', '体'], 'c3'),
  ];
  const rs = items.map((it) => D(it));
  check('W.1 每条理由都是以「老大」开头的完整句子',
    rs.every((r) => /^老大，/.test(r.reason || '') && /[。！]$/.test(r.reason || '')));
  check('W.2 不用"更强/更弱"这类含糊说法',
    rs.every((r) => !/(更强|更弱)/.test(r.reason || '')));
  check('W.3 理由里不出现无解释的裸数字（伤害必须带"伤害"二字）',
    rs.every((r) => !/\d+\.\d+%/.test(r.reason || '') || /伤害/.test(r.reason || '')));
}

const total = pass + failures.length;
console.log(`\n通过 ${pass}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗', f);
  process.exitCode = 1;
}
