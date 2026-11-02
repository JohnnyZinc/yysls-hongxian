'use strict';

/**
 * check_templates.js — 方案数据（data/template/**\/*.json）静态校验（运维防线）
 *
 * 定位（用户定稿）：方案由运维（而非玩家）编写，配错了应当在**构建/测试期**炸掉，
 * 而不是运行时在玩家界面弹警告。故本脚本是防出错机制的主体；
 * monitor.js 的 evaluateThresholds 仍保留 unknown 指标 warning 作为运行时兜底，
 * 但那是"万一漏网"的保险，正常流程不该走到，UI 也不展示它。
 *
 * 领域三层（用户定稿 2026-10-22）：流派 ⊃ 分支（=技能轴/build 包）⊃ 方案（词条分配口径）
 *
 * 校验项：
 *   1. 三层骨架：流派 = 目录名；分支/方案 字段齐备；不得残留 name/buildId/小外流 等废弃字段
 *   2. 文件名 = <流派>[.<分支>].<方案>.json，与字段一致
 *   3. 方案必须在 version.方案类型 枚举内（"小外反超"等语义由枚举表派生，不再手写布尔）
 *   4. 分支必须在 _meta.json 的分支表内（中文名唯一来源）；无分支时 分支 必须是 null
 *   5. 配额行：any_of 非空、count 为正整数、每条词条能在版本包查到数值区间
 *   6. 配额总数 = 8 部位 × 5 词条 = 40（物化毕业装备时恰好填满）
 *   7. 达标线：指标必须在 PANEL_METRICS 白名单内（面板算得出的才允许写阈值），值 ∈ (0,1]
 *   8. 口径默认值：心法×4 / 武库 / 攻具套装 / 防具套装 / 弓玦套装 必须在版本包表里存在
 *   9. 定音名（防具定音/攻具定音）能查到数值区间
 *  10. 死区（若配置）为 0~1 的数
 *  11. manifest ↔ template：流派清单 / build 包归属 / 分支表 三方对齐
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadVersionData } from './load-version.js';
import { PANEL_METRICS } from '../engine/monitor.js';
import { lookupAffixRange, canonicalAffix, aliasMapOf } from '../engine/quota.js';

const { version, affixes } = loadVersionData();
const ALIAS = aliasMapOf(affixes);
const TEMPLATE_DIR = 'data/template';
const TOTAL_AFFIXES = 8 * 5; // 8 部位 × 5 词条

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; }
  else { fails.push(name); console.log(`✗ ${name}`); }
}

const files = [];
const metas = {}; // 流派 → _meta.json（分支中文名的唯一来源）
for (const school of fs.readdirSync(TEMPLATE_DIR).sort()) {
  const dir = path.join(TEMPLATE_DIR, school);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('_')).sort()) {
    files.push({ school, stem: f.replace(/\.json$/, ''), file: path.join(dir, f) });
  }
  const mp = path.join(dir, '_meta.json');
  if (fs.existsSync(mp)) {
    try { metas[school] = JSON.parse(fs.readFileSync(mp, 'utf-8')); } catch { metas[school] = null; }
  }
}
check(`方案文件数量 > 0（${TEMPLATE_DIR}）`, files.length > 0);

// —— 流派元数据：分支中文名的唯一来源 ——
for (const [school, meta] of Object.entries(metas)) {
  const errs = [];
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) errs.push('缺少 name（流派中文名）');
  const bs = meta?.分支 || {};
  for (const [bid, b] of Object.entries(bs)) {
    if (!b || typeof b.name !== 'string' || !b.name.trim()) errs.push(`分支「${bid}」缺 name（中文名）`);
  }
  check(`${school}/_meta：流派元数据合法`, errs.length === 0);
  if (errs.length) console.log(`   └ ${errs.join('；')}`);
}

const PLAN_TYPES = Object.keys(version.方案类型 || {});

for (const { school, stem, file } of files) {
  const errs = [];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    errs.push(`JSON 解析失败：${e.message}`);
    check(`${stem}：方案数据合法`, false);
    console.log(`   └ ${errs.join('；')}`);
    continue;
  }

  // 1. 三层骨架
  if (doc.流派 !== school) errs.push(`流派「${doc.流派}」与目录名「${school}」不一致`);
  const branch = doc.分支 ?? null;
  const plan = doc.方案 ?? null;
  if (branch != null && (typeof branch !== 'string' || !branch)) errs.push('分支 应为非空字符串或 null');
  if (typeof plan !== 'string' || !plan) errs.push('缺少 方案');
  for (const legacy of ['name', 'buildId', '小外流']) {
    if (doc[legacy] !== undefined) errs.push(`废弃字段「${legacy}」仍存在（已由 流派/分支/方案 取代）`);
  }
  const lines = doc.quota?.lines;
  if (!Array.isArray(lines) || !lines.length) errs.push('quota.lines 缺失或为空');

  // 2. 文件名与字段一致
  const expectStem = branch ? `${school}.${branch}.${plan}` : `${school}.${plan}`;
  if (stem !== expectStem) errs.push(`文件名「${stem}」与字段不一致（应为「${expectStem}」）`);

  // 3. 方案必须在枚举内（"小外反超"等语义由枚举表派生）
  if (plan && !version.方案类型?.[plan]) {
    errs.push(`未知方案「${plan}」（version.方案类型 可选：${PLAN_TYPES.join('/') || '（枚举缺失）'}）`);
  }

  // 4. 分支必须在 _meta 分支表内
  const meta = metas[school];
  if (branch != null) {
    if (!meta?.分支?.[branch]) errs.push(`分支「${branch}」不在 _meta.json 的分支表内（缺中文名）`);
  } else if (meta?.分支 && Object.keys(meta.分支).length) {
    errs.push('本文件无分支，但 _meta.json 声明了分支表');
  }

  // 5 + 6. 配额行与总数
  let total = 0;
  for (const [i, L] of (lines || []).entries()) {
    if (!Array.isArray(L.any_of) || !L.any_of.length) { errs.push(`配额行#${i + 1} any_of 为空`); continue; }
    if (!Number.isInteger(L.count) || L.count <= 0) errs.push(`配额行#${i + 1} count 非正整数：${L.count}`);
    total += L.count || 0;
    for (const raw of L.any_of) {
      const name = canonicalAffix(raw, ALIAS);
      if (!lookupAffixRange(affixes, name)) errs.push(`配额行#${i + 1} 未知词条「${raw}」（版本包查不到数值区间）`);
    }
  }
  if (lines?.length && total !== TOTAL_AFFIXES) errs.push(`配额总数 ${total} ≠ ${TOTAL_AFFIXES}（8 部位 × 5 词条）`);

  // 7. 达标线白名单
  for (const [metric, th] of Object.entries(doc.thresholds || {})) {
    if (!PANEL_METRICS[metric]) {
      errs.push(`达标线指标「${metric}」不在面板级白名单（可选：${Object.keys(PANEL_METRICS).join('/')}）`);
    }
    if (typeof th !== 'number' || th <= 0 || th > 1) errs.push(`达标线「${metric}」阈值 ${th} 不在 (0,1]`);
  }

  // 8. 口径默认值必须在版本包存在（方案字段 2026-10-30 更名：攻具套装 / 弓玦套装，另加 防具套装）
  const xinfa = doc.心法 || [];
  if (!Array.isArray(xinfa) || xinfa.length !== 4) errs.push(`心法应为 4 个，实际 ${Array.isArray(xinfa) ? xinfa.length : '缺失'}`);
  for (const x of xinfa) if (!version.心法?.[x]) errs.push(`未知心法「${x}」`);
  if (doc.武库 && !version.武库?.[doc.武库]) errs.push(`未知武库「${doc.武库}」`);
  // 攻具套装的属性表在版本包里仍叫 `装备套装`（引擎 optSource 按老键取值），只换了方案字段名
  if (doc.攻具套装 && !version.装备套装?.[doc.攻具套装]) errs.push(`未知攻具套装「${doc.攻具套装}」`);
  if (doc.弓玦套装 && !version.弓玦?.[doc.弓玦套装]) errs.push(`未知弓玦套装「${doc.弓玦套装}」`);
  if (!doc.防具套装) errs.push('缺 防具套装（每个方案都要写：如 燕归→江凝 的「江凝」）');
  else if (!version.防具套装?.[doc.防具套装]) errs.push(`未知防具套装「${doc.防具套装}」（版本包 防具套装 表暂为空效果，但表必须存在）`);

  // 9. 定音名
  for (const key of ['防具定音', '攻具定音']) {
    if (doc[key] && !lookupAffixRange(affixes, doc[key])) errs.push(`${key}「${doc[key]}」查不到数值区间`);
  }

  // 10. 死区
  if (doc.死区 != null && (typeof doc.死区 !== 'number' || doc.死区 <= 0 || doc.死区 >= 1)) {
    errs.push(`死区 ${doc.死区} 不在 (0,1)`);
  }

  check(`${stem}：方案数据合法`, errs.length === 0);
  if (errs.length) console.log(`   └ ${errs.join('；')}`);
}

// —— 11. manifest ↔ template 三方对齐 ——
const manifest = JSON.parse(fs.readFileSync('data/version/manifest.json', 'utf-8'));
const schoolIds = new Set((manifest['流派'] || []).map((s) => s.id));
const packs = manifest['build包'] || [];
const errsM = [];
for (const p of packs) {
  if (!schoolIds.has(p.流派)) errsM.push(`build 包「${p.id}」的流派「${p.流派}」不在流派清单内`);
  if (p.分支 != null && !metas[p.流派]?.分支?.[p.分支]) {
    errsM.push(`build 包「${p.id}」的分支「${p.分支}」不在 _meta.json 的分支表内`);
  }
}
for (const s of Object.keys(metas)) {
  if (!schoolIds.has(s)) errsM.push(`template 目录「${s}」不在 manifest.流派 清单内（UI 选不到这个流派）`);
}
if (!packs.length) errsM.push('manifest.json 缺少 build 包清单（"build包"字段）');
check('manifest ↔ template：流派 / build 包 / 分支 三方对齐', errsM.length === 0);
if (errsM.length) console.log(`   └ ${errsM.join('；')}`);

console.log(`\n方案校验 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.error('失败项：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
