'use strict';

/**
 * migrate-unify-data.js — 一次性数据迁移：统一命名/形状（用户拍板）
 *
 * 变更内容：
 *   1. 六个 build JSON：
 *      a. config.categories：单体奇术+群体奇术 → 单个「奇术」类（panel_key=全奇术增伤，
 *         游戏已把两词条合并为全奇术增伤，拆分是旧赛季遗留）；武器类别补
 *         panel_key = `${label}武学增伤`。
 *      b. panel_input：删除单体/群体奇术增行；定音行收敛为单行（key=dingyin，
 *         label=技能定音）。破竹风删除「轻击定音」——该词条真实可掷但无人使用
 *         （掷出即重掷），项目不为没人用的分支建模。
 *   2. 六个 skills JSON：type 单体奇术/群体奇术 → 奇术；
 *      破竹风删除 dingyin_type:'轻击' 标记（对应事件不再吃定音加成）。
 *
 * 幂等：重复运行无副作用。运行一次后本脚本归档。
 */

import fs from 'node:fs';

const SCHOOLS = ['pozhufeng', 'qiansiyu', 'pozhuchen', 'pozhuzun', 'lieshiwei', 'qiansilin'];
// 多条定音行时保留哪条（破竹风：轻击=死数据，老鼠=本流派词条）
const DINGYIN_KEEP_LABEL = { pozhufeng: '老鼠定音' };

const report = [];

for (const school of SCHOOLS) {
  const dir = `data/schools/${school}`;
  const files = fs.readdirSync(dir);
  const buildFile = files.find((f) => f.endsWith('.json') && !f.endsWith('.skills.json') && !f.endsWith('.effects.json'));
  const skillsFile = files.find((f) => f.endsWith('.skills.json'));
  const info = { school, qishuMerged: false, dingyinRows: [], qishuInputRemoved: [], typeRenamed: 0, dingFlagRemoved: 0 };

  // ---------- build JSON ----------
  const buildPath = `${dir}/${buildFile}`;
  const build = JSON.parse(fs.readFileSync(buildPath, 'utf-8'));

  // a. config.categories：合并奇术类 + 补 panel_key
  //    合并类继承被替换条目的 panel_keys（作者基准缓存行不删——牵丝玉/牵丝霖的
  //    奇术增缓存 0.2677 非零，是 Excel 基准的一部分）与 includes_all_weapon
  const cats = build.config?.categories || [];
  const qishuEntries = cats.filter((c) => c.label === '单体奇术' || c.label === '群体奇术');
  if (qishuEntries.length) {
    const kept = cats
      .filter((c) => c.label !== '单体奇术' && c.label !== '群体奇术')
      .map((c) => ({ ...c, panel_key: `${c.label}武学增伤` }));
    const panelKeys = [...new Set(qishuEntries.flatMap((c) => c.panel_keys || []))];
    const includesAll = qishuEntries.some((c) => c.includes_all_weapon === true);
    kept.push({ label: '奇术', value: 0, panel_key: '全奇术增伤', panel_keys: panelKeys, includes_all_weapon: includesAll });
    build.config.categories = kept;
    info.qishuMerged = true;
  } else {
    for (const c of cats) {
      if (!c.panel_key && c.label !== '奇术') c.panel_key = `${c.label}武学增伤`;
    }
  }

  // b1. panel_input：单体/群体奇术增行保留（作者基准缓存，经合并类的 panel_keys 汇总，
  //     makePanel 消费；删除会丢掉牵丝玉/牵丝霖的非零奇术增基准）

  // b2. panel_input：定音行收敛为单行
  const pi = build.panel_input || {};
  const dingRows = Object.entries(pi).filter(([k, r]) => r && /定音$/.test(r.label || '') && !(k === 'dingyin' && r.label === '技能定音'));
  if (dingRows.length > 0) {
    let keep = dingRows[0];
    if (dingRows.length > 1) {
      const pref = dingRows.find(([, r]) => r.label === DINGYIN_KEEP_LABEL[school]);
      keep = pref || dingRows.find(([, r]) => r.default > 0) || dingRows[0];
    }
    for (const [k] of dingRows) delete pi[k];
    pi.dingyin = { label: '技能定音', default: keep[1].default };
    info.dingyinRows = dingRows.map(([k, r]) => `${k}(${r.label}=${r.default})`);
  }

  fs.writeFileSync(buildPath, JSON.stringify(build, null, 2) + '\n', 'utf-8');

  // ---------- skills JSON ----------
  const skillsPath = `${dir}/${skillsFile}`;
  const skillsDoc = JSON.parse(fs.readFileSync(skillsPath, 'utf-8'));
  for (const sk of Object.values(skillsDoc.skills || {})) {
    if (sk && (sk.type === '单体奇术' || sk.type === '群体奇术')) {
      sk.type = '奇术';
      info.typeRenamed += 1;
    }
    if (school === 'pozhufeng' && sk && sk.dingyin_type === '轻击') {
      delete sk.dingyin_type;
      info.dingFlagRemoved += 1;
    }
  }
  fs.writeFileSync(skillsPath, JSON.stringify(skillsDoc, null, 2) + '\n', 'utf-8');

  report.push(info);
}

for (const r of report) {
  console.log(
    `${r.school}: 奇术合并=${r.qishuMerged ? '✓' : '(已迁移)'} 定音行[${r.dingyinRows.join(',') || '无'}] ` +
    `技能type改名=${r.typeRenamed} 轻击标记删除=${r.dingFlagRemoved}`
  );
}
console.log('\n迁移完成。请运行 npm test 全量回归（黄金基准 ΔDPS 数值会有预期内变化：无定音装备不再继承作者默认定音）。');
