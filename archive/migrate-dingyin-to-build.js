'use strict';

/**
 * migrate-dingyin-to-build.js — 一次性迁移：流派定音词条迁入 DPS 包（消除双写）
 *
 * 用户裁定：同一事实不许写两遍。dingyin-map.json（引擎层手写表）与分支模板
 * idealArmorDingyin（评价层）记录的是同一事实。单一来源定为 **DPS 包 build JSON**
 * 的顶层字段 `dingyin_affix`（引擎必需品必须住在引擎数据里，且不能依赖可选的
 * 评价层文件）；模板字段删除；本 map 文件删除。
 *
 * 本脚本：从 dingyin-map.json 逐字复制词条名，按 build.name 注入各 build JSON
 * （插在 selectors 之后）。跑完即归档，然后 git rm data/version/dingyin-map.json。
 */

import fs from 'node:fs';

const map = JSON.parse(fs.readFileSync('data/version/dingyin-map.json', 'utf-8'));

for (const dir of fs.readdirSync('data/schools')) {
  const files = fs.readdirSync(`data/schools/${dir}`);
  const buildFile = files.find((f) => f.endsWith('.json') && !f.endsWith('.skills.json') && !f.endsWith('.effects.json'));
  if (!buildFile) continue;
  const p = `data/schools/${dir}/${buildFile}`;
  const build = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const val = map[build.name];
  const out = {};
  for (const [k, v] of Object.entries(build)) {
    out[k] = v;
    if (k === 'selectors') out.dingyin_affix = val ?? null;
  }
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`${dir} (${build.name}): dingyin_affix = ${val ?? '(无，缺席)'}`);
}
console.log('\n注入完成。下一步：git rm data/version/dingyin-map.json，模板删 idealArmorDingyin。');
