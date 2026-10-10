'use strict';

/**
 * diff_event.js — 逐事件对比引擎中间量 vs Excel 缓存值
 * 用法: node tools/diff_event.js <build_prefix> <row> [row...]
 * 前置: 已用 dump_excel_rows.py 导出 data/debug/<prefix>/row{N}.json
 */

const fs = require('fs');
const { loadBuild, calcDPS } = require('../engine/dps.js');

const prefix = process.argv[2];
const rows = process.argv.slice(3).map(Number);

const ctx = loadBuild(`data/${prefix}`);
const r = calcDPS(ctx, { debug: true });

for (const row of rows) {
  const ev = r.perEvent.find((e) => e.row === row);
  const excel = JSON.parse(fs.readFileSync(`data/debug/${prefix}/row${row}.json`, 'utf-8'));
  console.log(`===== ${prefix} row${row} [${ev ? ev.skill : '?'}] =====`);
  if (!ev || !ev.inter) {
    console.log('  (无引擎中间量——覆盖事件或未开debug)');
    continue;
  }
  const keys = new Set([...Object.keys(ev.inter), ...Object.keys(excel)]);
  let hasDiff = false;
  for (const k of keys) {
    const mine = ev.inter[k];
    const theirs = excel[k];
    if (mine === undefined && theirs === undefined) continue;
    if (typeof mine === 'number' && typeof theirs === 'number') {
      const rel = theirs !== 0 ? (mine - theirs) / Math.abs(theirs) : (mine === 0 ? 0 : Infinity);
      if (Math.abs(rel) > 1e-9) {
        hasDiff = true;
        console.log(`  ✗ ${k}: 引擎=${mine} Excel=${theirs} 相对偏差=${(rel * 100).toFixed(4)}%`);
      }
    } else if (String(mine) !== String(theirs)) {
      hasDiff = true;
      console.log(`  ✗ ${k}: 引擎=${JSON.stringify(mine)} Excel=${JSON.stringify(theirs)}`);
    }
  }
  if (!hasDiff) console.log('  全部中间量一致');
}
