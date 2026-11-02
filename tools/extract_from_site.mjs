// tools/extract_from_site.mjs
// 从「燕小叽」(yysls-assistant.cn) 前端包提取技能轴数据 → 项目 build 包三件套
//
// 背景：站点是 Vite SPA，技能/增益/时间轴/IR 字节码全部打包在前端 chunk 里（无 API）。
//   本工具把 chunk 里的数据数组提取出来，移植其 IR 虚拟机求值，
//   再映射成项目 build 包 schema（与 extract_calculator.py 的 Excel 路线同构）。
//
// 用法:
//   node tools/extract_from_site.mjs <轴名> <输出前缀> [选项]
// 例:
//   node tools/extract_from_site.mjs "裂石钧纯唐115竞速表 by@Violetta" \
//     data/schools/lieshijun/lieshijun.chuntang.115.3.0 --panel-from lieshijun.shuangqie.115.3.0
//
// 输出前缀即 buildId，命名约定：
//   单分支流派  <流派>.<游戏阶数>.<计算器版本>      例 pozhufeng.115.3.2
//   多分支流派  <流派>.<分支>.<游戏阶数>.<计算器版本>  例 lieshijun.chuntang.115.3.0
//   （build 包与分支一一对应，故多分支流派必须带分支段；load-build.js 用 split('.')[0] 取目录名，仍成立）
//
// 选项:
//   --chunk <path|url>   轴数据 chunk（默认自动解析官方站点当前 chunk 并缓存）
//   --main  <path|url>   主包 index-*.js（心法属性/定音字典；默认自动解析）
//   --panel-from <id>    从已有 build 包继承面板默认值（含心法置换调整），默认 lieshijun.shuangqie.115.3.0
//   --calc-version <v>   计算器版本号（仅元数据；buildId 来自输出前缀），默认 3.0
//   --name <中文名>      build 包 name 覆盖（默认取流派中文名，勿改——引擎据此查武学天赋）
//   --branch <id>        分支 id（仅写入 _meta 备注），默认 chuntang
//   --no-download        不访问网络，只用 --chunk/--main 指定的本地文件
//
// 依赖：Node 18+（全局 fetch）。离线时先手动下载两个 js 再用 --no-download。

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    if (key === 'no-download') opts[key] = true;
    else opts[key] = argv[++i];
  } else positional.push(argv[i]);
}
const [axisName, outPrefix] = positional;
if (!axisName || !outPrefix) {
  console.error('用法: node tools/extract_from_site.mjs <轴名> <输出前缀> [选项]');
  process.exit(1);
}
const CACHE_DIR = resolve('.cache/site');
const cachePath = (name) => resolve(CACHE_DIR, name);

async function fetchText(url, cacheName, { noDownload = false } = {}) {
  const cached = cachePath(cacheName);
  if (existsSync(cached)) return readFileSync(cached, 'utf-8');
  if (noDownload) throw new Error(`离线模式且缓存缺失: ${cached}（请先下载并放入 .cache/site/）`);
  console.log(`下载 ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const text = await res.text();
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, text);
  return text;
}

async function loadInput(spec, cacheName, fallbackUrl) {
  if (spec && !/^https?:/.test(spec)) return readFileSync(spec, 'utf-8');
  const url = spec || fallbackUrl;
  return fetchText(url, cacheName, { noDownload: opts['no-download'] });
}

// ---------------- 1. 定位并加载 chunk ----------------
const SITE = 'https://yysls-assistant.cn';
let chunkSrc, mainSrc;
if (opts.chunk && opts.main) {
  chunkSrc = await loadInput(opts.chunk, 'axis-chunk.js', null);
  mainSrc = await loadInput(opts.main, 'main.js', null);
} else {
  const home = await fetchText(SITE + '/', 'home.html');
  const mainMatch = home.match(/<script type="module" crossorigin src="(\/assets\/index-[^"]+\.js)"/);
  if (!mainMatch) throw new Error('首页未找到主包入口');
  mainSrc = await fetchText(SITE + mainMatch[1], 'main.js');
  const axisMatch = mainSrc.match(/"(assets\/useTimelineAxisState-[^"]+\.js)"/);
  if (!axisMatch) throw new Error('主包未找到轴数据 chunk');
  chunkSrc = await fetchText(SITE + '/' + axisMatch[1], 'axis-chunk.js');
}

// ---------------- 2. 提取数据数组（花括号配对 + eval） ----------------
function extractArrayLiteral(src, varName) {
  const idx = src.indexOf(varName + '=[');
  if (idx < 0) throw new Error(`未找到数组 ${varName}`);
  const start = src.indexOf('[', idx);
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return eval(src.slice(start, i)); // 数据数组是纯字面量（数字/字符串/布尔），可安全 eval
}

const skills = extractArrayLiteral(chunkSrc, 'Ys');   // 技能元数据（base 倍率等）
const buffs = extractArrayLiteral(chunkSrc, 'cs');    // 增益元数据（名称/类别/运行时字段）
const skillIr = extractArrayLiteral(chunkSrc, 'Ks');  // 技能 IR 程序
const buffIr = extractArrayLiteral(chunkSrc, 'ns');   // 增益 IR 程序

// 槽位表 DF = {inputSlots, timelineSlots, outputSlots, flagSlots}
function extractSlots(src) {
  const idx = src.indexOf('const Es={inputSlots:{');
  if (idx < 0) throw new Error('未找到槽位表 Es');
  const start = src.indexOf('{', idx);
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return eval('(' + src.slice(start, i) + ')');
}
const DF = extractSlots(chunkSrc);
const OUT = Object.fromEntries(Object.entries(DF.outputSlots).map(([k, v]) => [v, k]));
const TL = Object.fromEntries(Object.entries(DF.timelineSlots).map(([k, v]) => [v, k]));
const INP = Object.fromEntries(Object.entries(DF.inputSlots).map(([k, v]) => [v, k]));
const FLAG_CATS = ['build', 'martial', 'mind', 'set', 'skillType']; // flags[] 的类别顺序（见 _J: e[4]=skillType）

// 轴配置对象：= {name:"..."} 形式
function extractAxes(src) {
  const out = [];
  const re = /(\w+)=\{name:"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[1].length + 1;
    let depth = 0, i = start;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    try { out.push(eval('(' + src.slice(start, i) + ')')); } catch { /* 跳过非数据对象 */ }
  }
  return out;
}
const axes = extractAxes(chunkSrc);
const axis = axes.find((a) => a.name === axisName);
if (!axis) {
  console.error(`未找到轴「${axisName}」。可用轴:\n` + axes.map((a) => '  ' + a.name).join('\n'));
  process.exit(1);
}

// 心法属性（主包，按 版本/build → 心法 → 属性表）
function extractMindAttrs(src) {
  const out = {};
  const re = /\{id:\d+,key:"(XF_[A-Z]+)",attr:\[(.*?)\],buildKey:"([A-Z_]+)",versionKey:"([A-Z0-9_]+)"\}/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = [...m[2].matchAll(/\{key:"([A-Z_]+)",value:([0-9.]+)\}/g)].map((x) => [x[1], Number(x[2])]);
    const group = `${m[4]}/${m[3]}`;
    (out[group] ??= {})[m[1]] = attrs;
  }
  return out;
}
const mindAttrs = extractMindAttrs(mainSrc);
const pitchLabel = (() => {
  const m = mainSrc.match(new RegExp(`${axis.ARMOR_DEFAULT_PITCH_KEY}:\\{key:"[A-Z0-9_]+",name:"([^"]+)"`));
  return m ? m[1] : axis.ARMOR_DEFAULT_PITCH_KEY;
})();

// ---------------- 3. IR 虚拟机（移植自站点 Zs 解释器） ----------------
function runIr(rule, { input = {}, timeline = {}, flags = {} }) {
  const stack = new Float64Array(Math.max(rule.maxStackSize || 1, 1));
  const output = new Float64Array(Object.keys(DF.outputSlots).length);
  const code = rule.code, consts = rule.constants;
  let sp = 0;
  for (let i = 0; i < code.length;) {
    const op = code[i++];
    if (op === 1) stack[sp++] = consts[code[i++]];
    else if (op === 2) stack[sp++] = input[code[i++]] ?? 0;
    else if (op === 3) stack[sp++] = timeline[code[i++]] ?? 0;
    else if (op === 4) stack[sp++] = (flags[code[i++]] ?? [])[code[i++]] ?? 0;
    else if (op === 30) output[code[i++]] += stack[--sp];
    else if (op === 31) output[code[i++]] = stack[--sp];
    else if (op === 20) { const s = stack[--sp], u = stack[--sp]; stack[sp - 1] = stack[sp - 1] !== 0 ? u : s; }
    else if (op === 21) { const s = stack[--sp], u = stack[--sp]; stack[sp - 1] = Math.min(Math.max(stack[sp - 1], u), s); }
    else {
      const s = stack[--sp], u = sp - 1, v = stack[u];
      if (op === 10) stack[u] = v + s;
      else if (op === 11) stack[u] = v - s;
      else if (op === 12) stack[u] = v * s;
      else if (op === 13) stack[u] = s === 0 ? 0 : v / s;
      else if (op === 14) stack[u] = Math.min(v, s);
      else if (op === 15) stack[u] = Math.max(v, s);
      else if (op === 16) stack[u] = v === s ? 1 : 0;
      else if (op === 17) stack[u] = v > s ? 1 : 0;
      else if (op === 18) stack[u] = v >= s ? 1 : 0;
      else throw new Error(`未知 opcode ${op} @${i}`);
    }
  }
  const out = {};
  rule.writtenOutputSlots.forEach((s) => { if (output[s] !== 0) out[OUT[s]] = output[s]; });
  return out;
}

// 站点旗标：flags[类别][位]。类别顺序 build/martial/mind/set/skillType
function makeFlags(axis_, skillTypes = []) {
  const flags = [[], [], [], [], []];
  const buildIdx = DF.flagSlots.build[axis_ && axis_.buildKey] ?? DF.flagSlots.build.LIESHI_JUN;
  flags[0][buildIdx] = 1;
  for (const mind of axis_.minds || []) {
    const bit = DF.flagSlots.mind[mind];
    if (bit !== undefined) flags[2][bit] = 1;
  }
  for (const t of skillTypes) {
    const bit = DF.flagSlots.skillType[t];
    if (bit !== undefined) flags[4][bit] = 1;
  }
  return flags;
}

// 站点时间轴槽：命名字段 → 槽位索引的 Float64Array（buff 存在性旗标 + 运行时层数；
// distance 缺省 20，其余缺省 0 —— 与站点 zS 编译逻辑一致）
function makeTimeline(ev) {
  const tl = new Float64Array(Object.keys(DF.timelineSlots).length);
  for (const [name, idx] of Object.entries(DF.timelineSlots)) {
    if (name.startsWith('buff:')) {
      tl[idx] = (ev.buffKeyList || []).includes(name.slice(5)) ? 1 : 0;
    } else {
      tl[idx] = Number(ev[name] ?? (name === 'distance' ? 20 : 0));
    }
  }
  return tl;
}

// ---------------- 4. 站点槽位 → 项目效果字段映射 ----------------
// 站点数值多为百分数（8 = 8%），项目用小数（0.08）；攻击/穿透为原值。
const PCT_SLOTS = new Set([
  'COMMON_DAMAGE', 'EXTERNAL_DAMAGE', 'MINGJIN_DAMAGE', 'LIESHI_DAMAGE',
  'QIANSI_DAMAGE', 'POZHU_DAMAGE', 'CRITICAL_DAMAGE', 'INSIGHT_DAMAGE',
  'RAID_DAMAGE', 'SPECIAL_DAMAGE', 'CRITICAL_RATE', 'INSIGHT_RATE',
  'DIRECT_CRITICAL_RATE', 'DIRECT_INSIGHT_RATE',
]);
const FLAT_SLOT_TO_FIELD = {
  COMMON_DAMAGE: 'generic_dmg',
  EXTERNAL_DAMAGE: 'ext_skill_dmg',
  MINGJIN_DAMAGE: 'mingjin_dmg', LIESHI_DAMAGE: 'lieshi_dmg',
  QIANSI_DAMAGE: 'qiansi_dmg', POZHU_DAMAGE: 'pozhu_dmg',
  EXTERNAL_PENETRATION: 'ext_pen', MINGJIN_PENETRATION: 'mingjin_pen',
  LIESHI_PENETRATION: 'lieshi_pen', QIANSI_PENETRATION: 'qiansi_pen',
  POZHU_PENETRATION: 'pozhu_pen',
  CRITICAL_DAMAGE: 'crit_dmg', INSIGHT_DAMAGE: 'insight_dmg',
  RAID_DAMAGE: 'spec_dmg', SPECIAL_DAMAGE: 'spec_bonus',
  CRITICAL_RATE: 'crit_rate', INSIGHT_RATE: 'insight_rate',
  DIRECT_CRITICAL_RATE: 'direct_crit_rate', DIRECT_INSIGHT_RATE: 'direct_insight_rate',
  MIN_EXTERNAL_ATTACK: 'min_ext', MAX_EXTERNAL_ATTACK: 'max_ext',
};
// 技能倍率槽（÷100 转小数倍率）
const SKILL_RATE_SLOTS = {
  SKILL_EXTERNAL_RATE: 'ext_mult', SKILL_EXTERNAL_FIXED: 'ext_flat',
  SKILL_ELEMENT_RATE: 'elem_mult', SKILL_ELEMENT_FIXED: 'elem_flat',
};
// 主属性标记槽（不进数值，仅决定主属性）
const MARKER_SLOTS = new Set(['MINGJIN', 'LIESHI', 'QIANSI', 'POZHU']);
const PITCH_SLOT = 'PITCH_DAMAGE';

function slotValuesToFields(values, { isSkill = false } = {}) {
  const fields = {};
  for (const [slot, raw] of Object.entries(values)) {
    if (MARKER_SLOTS.has(slot)) continue;
    if (isSkill && SKILL_RATE_SLOTS[slot]) {
      const v = slot.endsWith('_RATE') ? raw / 100 : raw;
      if (v !== 0) fields[SKILL_RATE_SLOTS[slot]] = Math.round(v * 1e6) / 1e6;
      continue;
    }
    const f = FLAT_SLOT_TO_FIELD[slot];
    if (!f) continue;
    const v = PCT_SLOTS.has(slot) ? raw / 100 : raw;
    if (v !== 0) fields[f] = Math.round(v * 1e6) / 1e6;
  }
  return fields;
}

// ---------------- 5. 增益：按轴内实际运行时配置求值 → 逐层效果条目 ----------------
// 命名沿用项目既有 Excel 提取包的惯例（易水歌N层/沧海帖N层/穿喉N/穿喉N(普)），数值一律 VM 求值。
const BUFF_NAMING = {
  BUFF_XF_YSG: { name: '易水歌', unit: '层', stackField: 'YSGStack' },
  BUFF_TIE_CHT: { name: '沧海帖', unit: '层', stackField: 'tieStack' },
  BUFF_XF_CHJ: { name: '穿喉', stackField: 'CHJStack', statusField: 'CHJStatus', statusLabels: { 3: '', 2: '(普)' } },
  BUFF_ZXDF_DH: { name: '胆寒' },
  BUFF_ZXDF_JR: { name: '惧刃' },
  BUFF_QS_XYQL: { name: '箫吟千浪', distanceSuffix: true },
  BUFF_XF_ZRG: { name: '征人归' },
  BUFF_OTHER_WJ: { name: '无惧' },
  BUFF_SFPZ_TY: { name: '铁衣' },
  BUFF_DSSJ_LL: { name: '离猎', suffix: '(拐)' },
  BUFF_OTHER_QJ: { name: '气竭' },
  BUFF_WMJF_ZQSH: { name: '真气失衡' },
  BUFF_SET_DY: { name: '断岳' },
  BUFF_SFPZ_KS: { name: '开山' },
  BUFF_XF_DSZG: { name: '断石之构' },
};
const buffIrByKey = Object.fromEntries(buffIr.map((r) => [r.key, r]));
const skillIrByKey = Object.fromEntries(skillIr.map((r) => [r.key, r]));
const buffMetaByKey = Object.fromEntries(buffs.map((b) => [b.key, b]));

function buffEntryName(key, ev) {
  const naming = BUFF_NAMING[key];
  if (!naming) throw new Error(`未配置增益命名: ${key}（请在 BUFF_NAMING 中补充）`);
  let name = naming.name;
  if (naming.stackField) {
    const n = ev[naming.stackField];
    if (n == null) throw new Error(`${key} 缺少运行时字段 ${naming.stackField}（事件 id=${ev.id}）`);
    name += n;
    if (naming.statusField) {
      const st = ev[naming.statusField];
      name += naming.statusLabels[st] ?? `(状态${st})`;
    } else if (naming.unit) name += naming.unit;
  }
  if (naming.distanceSuffix) name += `(${ev.distance ?? 20})`; // 站点距离档位：缺省 20
  if (naming.suffix) name += naming.suffix;
  return name;
}

// 逐事件展开：buffKey + 运行时字段 → 效果名；同时收集所有出现过的配置
const effectDefs = new Map(); // name -> fields
const skippedBuffs = new Set();
function eventEffectNames(ev) {
  const names = [];
  const flags = makeFlags(axis);
  const timeline = makeTimeline(ev);
  for (const key of ev.buffKeyList || []) {
    const rule = buffIrByKey[key];
    if (!rule) throw new Error(`增益未编译: ${key}`);
    const values = runIr(rule, { timeline, flags });
    if (Object.keys(values).length === 0) { skippedBuffs.add(key); continue; } // 旗标门禁关闭（如未装备断石之构）
    const name = buffEntryName(key, ev);
    const fields = slotValuesToFields(values);
    const prev = effectDefs.get(name);
    if (prev && JSON.stringify(prev) !== JSON.stringify(fields)) {
      throw new Error(`效果「${name}」在不同事件数值不一致: ${JSON.stringify(prev)} vs ${JSON.stringify(fields)}`);
    }
    effectDefs.set(name, fields);
    names.push(name);
  }
  return names;
}

// ---------------- 6. 技能表 ----------------
const WEAPON_TYPE_MAP = { BLADE: '横刀', BIGBLADE: '陌刀', AOEQS: '群体奇术', SINGLEQS: '单体奇术', MIND: '心法' };
// 定音相关输入槽（按 dingyin_type 标记处理，不进数值）
const PITCH_INPUT_PREFIX = /^__TIMELINE_OTHER_CONFIG_ARMOR_PITCH|^PITCH_|_XLJZS$|_QZJPSJZS$|^SFPZ_|^ZXDF_/;
const skillsOut = {};
const skillNameByKey = {};
const contextDependent = [];
for (const ev of axis.skillList) {
  const key = ev.skillKey;
  if (skillsOut[key]) continue;
  const meta = skills.find((s) => s.key === key);
  if (!meta) throw new Error(`技能元数据缺失: ${key}`);
  const rule = skillIrByKey[key];
  if (!rule) throw new Error(`技能未编译: ${key}`);
  // 安全校验：技能 IR 只允许读 energy 时间轴槽与定音输入槽；
  // 若读其他输入槽（装备相关）或 buff 存在性槽（逐事件条件），静态技能表无法表达，需人工处理
  for (let i = 0; i < rule.code.length;) {
    const op = rule.code[i++];
    if (op === 1 || op === 30 || op === 31) i += 1;
    else if (op === 2) { const slot = INP[rule.code[i++]]; if (slot && !PITCH_INPUT_PREFIX.test(slot)) contextDependent.push(`${key} 读输入槽 ${slot}`); }
    else if (op === 3) { const slot = TL[rule.code[i++]]; if (slot && slot.startsWith('buff:')) contextDependent.push(`${key} 读 buff 存在性 ${slot}`); }
    else if (op === 4) i += 2;
  }
  const flags = makeFlags(axis, meta.skill.skillTypes);
  const values = runIr(rule, { timeline: makeTimeline({ energy: 2 }), flags });
  const hasPitch = rule.writtenOutputSlots.some((s) => OUT[s] === PITCH_SLOT);
  const fields = slotValuesToFields(values, { isSkill: true });
  if (hasPitch) fields.dingyin_type = pitchLabel.replace(/^.*·/, '').replace(/增伤$/, ''); // 斩雪刀法·轻重击派生技增伤 → 轻重击派生技
  fields.type = WEAPON_TYPE_MAP[meta.skill.weaponType] || meta.skill.weaponType;
  const name = meta.name;
  skillsOut[name] = fields;
  skillNameByKey[key] = name;
}
if (contextDependent.length) {
  console.warn('警告: 以下技能含逐事件/装备条件贡献，静态技能表无法完整表达（数值按 energy=2、无装备输入求值）:\n  ' + [...new Set(contextDependent)].join('\n  '));
}

// ---------------- 7. 面板默认值（继承自既有包 + 心法置换调整） ----------------
const panelFromId = opts['panel-from'] || 'lieshijun.shuangqie.115.3.0';
const panelFrom = JSON.parse(readFileSync(resolve(`data/schools/${panelFromId.split('.')[0]}/${panelFromId}.json`), 'utf-8'));
const panelInput = JSON.parse(JSON.stringify(panelFrom.panel_input));

// 心法置换：仅当轴的心法与继承面板的心法不同才调整。
// 双切(XF_GZBC 会心+13.5%/会伤+4%) → 纯唐(XF_ZRG 仅buff无面板属性)：
const lieshiMinds = mindAttrs['115_NLXH_UP/LIESHI_JUN'] || {};
const axisMinds = axis.minds || [];
const needSwap = axisMinds.includes('XF_ZRG') && !axisMinds.includes('XF_GZBC');
const swapOut = needSwap ? Object.fromEntries(lieshiMinds.XF_GZBC || []) : {};
// 三率类走「除判定抗性前」的分子（stats.X = total(X)/jk），故扣减时要 /jk；
// 会伤/攻击/穿透/增伤类是纯求和，直接扣。
const JK = 2.8; // 1 + 判定抗性（version.constants.判定抗性 = 1.8）
const RATE_MINDS = ['CRITICAL_RATE', 'INSIGHT_RATE', 'ACCURACY_RATE', 'DIRECT_CRITICAL_RATE', 'DIRECT_INSIGHT_RATE'];
for (const [slotKey, attrKey] of [['CRITICAL_RATE', 'crit_rate'], ['INSIGHT_RATE', 'insight_rate'], ['DIRECT_CRITICAL_RATE', 'direct_crit_rate'], ['DIRECT_INSIGHT_RATE', 'direct_insight_rate']]) {
  if (swapOut[slotKey] == null || !panelInput[attrKey]) continue;
  panelInput[attrKey].default = panelInput[attrKey].default - swapOut[slotKey] / 100 / JK;
}
if (swapOut.CRITICAL_DAMAGE) panelInput.crit_dmg_bonus.default = panelInput.crit_dmg_bonus.default - swapOut.CRITICAL_DAMAGE / 100;
// 轴配额含横刀武学增伤（BEST_MAX: BLADE_DAMAGE）时，按陌刀增单条承音值类比给默认值
if ((axis.BEST_MAX || []).some((l) => l.key === 'BLADE_DAMAGE')) {
  panelInput.hengdao_dmg.default = panelInput.modao_dmg.default;
}

const baseStats = JSON.parse(JSON.stringify(panelFrom.base_stats));
const penDmg = JSON.parse(JSON.stringify(panelFrom.pen_dmg));
// 纯唐与双切同样装备霜天白夜/穿喉决，其面板贡献已含在继承值中；征人归/易水歌无面板属性。

// ---------------- 8. 组装 build 主文件 ----------------
const gk = axis.GLOBAL_KEY;
const monster = {
  defense: { label: '防御', value: gk.DEFENCE },
  ext_resist: { label: '外抗', value: gk.EXTERNAL_RESISTANCE },
  elem_resist: { label: '属抗', value: gk.ELEMENT_RESISTANCE },
  dungeon_talent: { label: '副本天赋', value: (gk.RAID_DAMAGE || 0) / 100 },
  duration: { label: '战斗时间', value: axis.battleTime },
};
const calcVersion = opts['calc-version'] || '3.0';
const buildId = `${outPrefix.split('/').pop()}`;
const schoolPrefix = buildId.split('.')[0];
// build.name 必须是流派中文名（computePanel 用它查 version.武学天赋）
const SCHOOL_CN = {
  lieshijun: '裂石钧', lieshiwei: '裂石威', mingjinhong: '鸣金虹', mingjinying: '鸣金影',
  pozhuchen: '破竹尘', pozhufeng: '破竹风', pozhuyuan: '破竹鸢', pozhuzun: '破竹樽',
  qiansilin: '牵丝霖', qiansiyi: '牵丝翊', qiansiyu: '牵丝玉',
};
const timeline = axis.skillList.map((ev, idx) => ({
  row: idx + 2,
  skill: skillNameByKey[ev.skillKey],
  count: ev.times ?? 1,
  effects: eventEffectNames(ev),
  ...(ev.distance != null ? { site_distance: ev.distance } : {}),
  site_event: { id: ev.id, skillKey: ev.skillKey, runtime: Object.fromEntries(Object.entries(ev).filter(([k]) => !['id', 'skillKey', 'buffKeyList', 'times'].includes(k))) },
}));

const build = {
  _source: `yysls-assistant.cn「${axis.name}」（更新 ${axis.update}）`,
  _sheet: 'AxisSimulation',
  _extraction: 'tools/extract_from_site.mjs（IR 虚拟机求值，非 Excel 提取）',
  // 约定：build.name 恒为「流派中文名」——computePanel/computeGraduateDps 用它查 version.武学天赋，
  // 写成「裂石钧·纯唐轴」会静默丢掉整套天赋（裂石穿透/加成/攻击/会心率）。分支信息由文件名与 manifest 承载。
  id: buildId,
  name: SCHOOL_CN[schoolPrefix] || opts.name,
  game_version: '115',
  calc_version: calcVersion,
  selectors: { weapon_attribute: '裂石', set: '断岳' },
  weapon_categories: [
    { label: '横刀', value: panelInput.hengdao_dmg.default + panelInput.all_weapon_dmg.default, panel_keys: ['hengdao_dmg'], includes_all_weapon: true, panel_key: '横刀武学增伤' },
    { label: '陌刀', value: panelInput.modao_dmg.default + panelInput.all_weapon_dmg.default, panel_keys: ['modao_dmg'], includes_all_weapon: true, panel_key: '陌刀武学增伤' },
    { label: '奇术', value: panelInput.qishu_dmg.default, panel_keys: ['qishu_dmg'], includes_all_weapon: false, panel_key: '全奇术增伤' },
  ],
  panel_input: panelInput,
  base_stats: baseStats,
  pen_dmg: penDmg,
  monster,
  team_buffs: { _desc: axis.COMMON_DAMAGE_DESC, minds: axis.minds, pitch: pitchLabel },
  set_attack_multiplier: 1.0,
  config: {
    generic_extra: (gk.COMMON_DAMAGE || 0) / 100,
    categories: [
      { label: '横刀', value: panelInput.hengdao_dmg.default + panelInput.all_weapon_dmg.default, panel_keys: ['hengdao_dmg'], includes_all_weapon: true, panel_key: '横刀武学增伤' },
      { label: '陌刀', value: panelInput.modao_dmg.default + panelInput.all_weapon_dmg.default, panel_keys: ['modao_dmg'], includes_all_weapon: true, panel_key: '陌刀武学增伤' },
      { label: '奇术', value: panelInput.qishu_dmg.default, panel_keys: ['qishu_dmg'], includes_all_weapon: false, panel_key: '全奇术增伤' },
    ],
  },
  graduate_dps: Math.round((axis.hundredDamage / axis.battleTime) * 100) / 100,
  timeline,
  formula_templates: {},
  _site: {
    axis_name: axis.name,
    axis_update: axis.update,
    minds: axis.minds,
    armor_pitch: pitchLabel,
    goat_key: axis.GOAT_KEY,
    best_max: axis.BEST_MAX,
    best_plan_rate_threshold: axis.BEST_PLAN_RATE_THRESHOLD,
    global_key: gk,
    hundred_damage: axis.hundredDamage,
    battle_time: axis.battleTime,
  },
  validation: {
    site_total_damage: axis.hundredDamage,
    site_dps: Math.round((axis.hundredDamage / axis.battleTime) * 100) / 100,
  },
};

// ---------------- 9. 输出 ----------------
mkdirSync(dirname(resolve(outPrefix)), { recursive: true });
writeFileSync(resolve(outPrefix + '.json'), JSON.stringify(build, null, 1));
writeFileSync(resolve(outPrefix + '.skills.json'), JSON.stringify({
  _source: build._source, _sheet: '武学奇术(站点 IR)',
  _note: '技能数值由站点 IR 虚拟机求值（含气竭+21%会伤/热血+40%特定增伤等技能内条件）；名称用站点中文名。',
  skills: skillsOut,
}, null, 1));
writeFileSync(resolve(outPrefix + '.effects.json'), JSON.stringify({
  _source: build._source, _sheet: '增益(站点 IR)',
  _note: '增益数值由站点 IR 虚拟机按轴内实际层数配置求值；逐层条目命名沿用 Excel 提取包惯例。',
  effects: Object.fromEntries([...effectDefs.entries()].sort()),
}, null, 1));

// ---------------- 10. 摘要 ----------------
console.log(`轴: ${axis.name}（${axis.update}）`);
console.log(`事件: ${timeline.length} 条 | 技能: ${Object.keys(skillsOut).length} 个 | 效果条目: ${effectDefs.size} 条`);
if (skippedBuffs.size) console.log(`旗标关闭已跳过: ${[...skippedBuffs].join(', ')}（心法未装备，贡献为 0）`);
console.log(`定音: ${pitchLabel} → dingyin_type=${skillsOut[Object.values(skillsOut).find((s) => s.dingyin_type) ? Object.keys(skillsOut).find((k) => skillsOut[k].dingyin_type) : '']?.dingyin_type || '(无)'}`);
console.log(`站点基准: 总伤 ${axis.hundredDamage} / ${axis.battleTime}s = DPS ${(axis.hundredDamage / axis.battleTime).toFixed(2)}`);
console.log(`输出: ${outPrefix}.{json,skills.json,effects.json}`);
