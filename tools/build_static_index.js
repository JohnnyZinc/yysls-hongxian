'use strict';

/**
 * build_static_index.js — 生成分支模板静态索引（静态托管用的最后一公里）
 *
 * 背景：浏览器无法列举目录，原方案由 tools/serve.js 的 /api/template/<流派> 端点代劳。
 *       GitHub Pages / 任意纯静态托管没有服务端，该端点不可用 → 分支下拉为空。
 * 方案：本脚本离线枚举 data/template/<流派>/ 写出 data/template/index.json；
 *       UI 优先读该静态索引，读不到再回退 /api/template/（本地 serve.js 仍可用）。
 * 注意：_meta.json（流派元数据/分支中文名）不是方案文件，须排除；UI 里以 _ 开头的文件同样跳过。
 *
 * 用法: node tools/build_static_index.js
 * 时机: 新增/删除/重命名方案文件后重跑（换季接流派时同样跑一次）。
 */

import { readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TPL_DIR = join(root, 'data', 'template');
const OUT = join(TPL_DIR, 'index.json');

const dirs = (await readdir(TPL_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const index = { generatedBy: 'tools/build_static_index.js', prefix: {} };
let total = 0;
for (const dir of dirs) {
  const files = (await readdir(join(TPL_DIR, dir)))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();
  index.prefix[dir] = files;
  total += files.length;
}

await writeFile(OUT, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
console.log(`✓ 已生成 data/template/index.json：${dirs.length} 个流派 / ${total} 个方案文件`);
for (const [dir, files] of Object.entries(index.prefix)) {
  console.log(`  ${dir}: ${files.join(', ')}`);
}
