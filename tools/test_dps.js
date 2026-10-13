'use strict';

/**
 * test_dps.js — DPS 引擎验证运行器
 *
 * 用六个流派的 Excel 缓存结果做基准：
 *   1. 总量对齐：引擎 DPS vs Excel ADPS（I12），目标误差 < 0.1%
 *   2. 逐事件对齐：失败时输出偏差最大的事件，便于定位公式翻译错误
 *
 * 运行： node tools/test_dps.js
 */

import { calcDPS } from '../engine/dps.js';
import { loadBuild } from './load-build.js';

const BUILDS = [
  ['pozhufeng.115.3.2', '破竹风'],
  ['qiansiyu.115.3.5', '牵丝玉'],
  ['pozhuchen.115.3.3', '破竹尘'],
  ['pozhuzun.115.3.6', '破竹樽'],
  ['lieshiwei.115.3.1', '裂石威'],
  ['qiansilin.115.3.1', '牵丝霖'],
];

const main = () => {
  const only = process.argv[2]; // 可选：只跑某个流派（拼音或序号）
  let pass = 0;
  const failures = [];

  BUILDS.forEach(([prefix, name], idx) => {
    if (only && only !== String(idx + 1) && !prefix.startsWith(only)) return;
    const ctx = loadBuild(prefix);
    const r = calcDPS(ctx, { debug: true });
    const excelAdps = ctx.build.validation ? ctx.build.validation.excel_adps : null;

    if (excelAdps == null) {
      console.log(`⚠ ${name}: 无 Excel 基准值，引擎DPS=${r.dps.toFixed(2)}`);
      return;
    }
    const deltaPct = (r.dps / excelAdps - 1) * 100;
    const ok = Math.abs(deltaPct) < 0.1;
    if (ok) pass++;
    else failures.push(prefix);

    console.log(
      `${ok ? '✓' : '✗'} ${name}: 引擎=${r.dps.toFixed(2)} Excel=${excelAdps.toFixed(2)} ` +
        `偏差=${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(4)}% ` +
        `毕业率=${(r.graduationRate * 100).toFixed(2)}%`
    );

    if (!ok) {
      // 逐事件对比，找出偏差最大的事件
      const diffs = r.perEvent
        .filter((e) => e.excel_L != null)
        .map((e) => ({
          row: e.row,
          skill: e.skill,
          rel: e.excel_L !== 0 ? (e.L - e.excel_L) / Math.abs(e.excel_L) : (e.L === 0 ? 0 : Infinity),
          L: e.L,
          excel_L: e.excel_L,
        }))
        .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));
      const worst = diffs.slice(0, 5);
      console.log('   偏差最大的事件:');
      for (const d of worst) {
        console.log(
          `     row${d.row} ${d.skill}: 引擎=${d.L.toFixed(2)} Excel=${d.excel_L.toFixed(2)} ` +
            `相对偏差=${(d.rel * 100).toFixed(2)}%`
        );
      }
    }
  });

  console.log(`\n通过 ${pass}/${BUILDS.length}`);
  if (failures.length) {
    console.log('未通过: ' + failures.join(', '));
    process.exitCode = 1;
  }
};

main();
