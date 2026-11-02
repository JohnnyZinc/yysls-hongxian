'use strict';

/**
 * test_panel.js — panel.js 验证
 *
 * 场景：复现面板计算器 v0.1 自带的鸣金虹算例
 *   （心法 凝神章/无名心法/威猛歌/千山法 + 弓玦饮羽 + 套装玉斗 + 武库鸣金，
 *     装备词条区为空）
 * 验证：panel.js 的 stats 与 Excel W 列缓存值逐项对齐（相对误差 < 1e-9）。
 * 已知差异：会心伤害/会意伤害——版本数据包按用户假设注入了
 *   等级+35%/+20%，Excel v0.1 没有这两项，故对比时对这两项加回。
 */

import fs from 'node:fs';
import { computePanel } from '../engine/panel.js';
import { loadVersionData } from './load-version.js';

const { version, affixes } = loadVersionData();
const expected = JSON.parse(fs.readFileSync('data/debug/panel-v01-expected.json', 'utf-8'));

const result = computePanel({
  version,
  affixes,
  build: { 流派: '鸣金虹' },
  gear: [],
  selections: {
    弓玦: '饮羽',
    装备套装: '玉斗',
    心法: ['凝神章', '无名心法', '威猛歌', '千山法'],
    武库: '鸣金',
  },
});

// Excel 主表行名 → panel.js 统计名
const KEYMAP = {
  体: '体', 劲: '劲', 御: '御', 敏: '敏', 势: '势',
  精准率: '精准率', 会心率: '会心率', 会意率: '会意率',
  最小外功: '最小外功攻击', 最大外功: '最大外功攻击',
  最小鸣金: '最小鸣金攻击', 最大鸣金: '最大鸣金攻击',
  最小牵丝: '最小牵丝攻击', 最大牵丝: '最大牵丝攻击',
  最小裂石: '最小裂石攻击', 最大裂石: '最大裂石攻击',
  最小破竹: '最小破竹攻击', 最大破竹: '最大破竹攻击',
  最小无相: '最小无相攻击', 最大无相: '最大无相攻击',
  外功穿透: '外功穿透', 技能定音: '技能定音',
  全武增: '全武学增伤', 首领增: '对首领单位增伤', 奇术增: '全奇术增伤',
  // Excel 标量行「武器增」已废弃：指定武学增伤现在按武器类型进 stats（`${类型}武学增伤`）
  会心伤害: '会心伤害加成', 会意伤害: '会意伤害加成',
  直接会心率: '直接会心率', 直接会意率: '直接会意率',
  鸣金穿透: '鸣金穿透', 鸣金加成: '鸣金加成',
  裂石穿透: '裂石穿透', 裂石加成: '裂石加成',
  牵丝穿透: '牵丝穿透', 牵丝加成: '牵丝加成',
  破竹穿透: '破竹穿透', 破竹加成: '破竹加成',
  无相穿透: '无相穿透', 外功伤害加成: '外功伤害加成',
  外功治疗加成: '外功治疗加成', 外功抗性: '外功抗性',
  外功防御: '外功防御', 外功伤害减免: '外功伤害减免',
  气血最大值: '气血最大值', 鸣金伤害加成: '鸣金伤害加成',
};
// 用户假设注入的等级会心/会意伤害（Excel v0.1 没有）
const HYPOTHESIS = { 会心伤害加成: 0.35, 会意伤害加成: 0.20 };

let pass = 0;
const fails = [];
for (const [label, exp] of Object.entries(expected)) {
  const key = KEYMAP[label];
  if (!key) continue;
  const got = result.stats[key];
  const adj = HYPOTHESIS[key] || 0;
  const rel = exp !== 0 ? (got - (exp + adj)) / Math.abs(exp + adj) : (got === 0 ? 0 : Infinity);
  if (Math.abs(rel) < 1e-9) pass++;
  else fails.push({ label, key, exp: exp + adj, got, rel });
}

console.log(`W列对比: 通过 ${pass}/${pass + fails.length}`);
for (const f of fails) {
  console.log(`  ✗ ${f.label}: 引擎=${f.got} Excel=${f.exp} 相对偏差=${(f.rel * 100).toFixed(6)}%`);
}
if (result.warnings.length) {
  console.log('warnings:', result.warnings);
}
console.log('五维达标率:', result.五维达标率.toFixed(6), ' 主属性达标率:', result.主属性达标率.toFixed(6));
if (fails.length) process.exitCode = 1;
