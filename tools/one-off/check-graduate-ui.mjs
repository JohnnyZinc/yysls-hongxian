// 一次性核查：模拟 UI 用户路径，逐流派×逐流验证毕业基准来源（方案生成 vs Excel I16 回退）
import fs from 'node:fs';
import { loadBuild } from '../load-build.js';
import { loadVersionData } from '../load-version.js';
import { derivePrescription } from '../../engine/quota.js';
import { computeGraduateDps } from '../../engine/graduate.js';

const { version, affixes } = loadVersionData();
const manifest = JSON.parse(fs.readFileSync('data/version/manifest.json', 'utf-8'));
let fallback = 0, ok = 0;
for (const { id, name } of manifest['流派']) {
  // manifest 里的 id 是流派前缀；build 包文件名带版本段（如 pozhufeng.115.3.2.json）
  const buildDir = `data/schools/${id}`;
  const buildFile = (fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : []).find(
    (f) => f.endsWith('.json') && !f.endsWith('.skills.json') && !f.endsWith('.effects.json'),
  );
  if (!buildFile) { console.log(`✗ ${name}: 找不到 build 包 → 跳过`); fallback++; continue; }
  const buildCtx = loadBuild(buildFile.replace(/\.json$/, ''));
  const b = buildCtx.build;
  const weaponTypes = (b.weapon_categories || []).slice(1, 3).map((c) => c.label);
  const dir = `data/template/${id}`;
  const flowFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_meta.json');
  for (const f of flowFiles) {
    const flow = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    const flowLabel = [flow['分支'], flow['方案']].filter(Boolean).join('/') || f.replace(/\.json$/, '');
    const p = derivePrescription(affixes, flow, weaponTypes);
    if (!p || !p.feasible) { console.log(`✗ ${name}/${flowLabel}: 推导不可行 → 回退`); fallback++; continue; }
    const selections = {
      // 方案字段已更名（攻具套装 / 弓玦套装），但引擎口径键仍是 `装备套装` / `弓玦`（存档兼容）
      '装备套装': flow['攻具套装'] || b.selectors?.set || '',
      '武库': flow['武库'] || b.selectors?.weapon_attribute || '',
      '弓玦': flow['弓玦套装'] || '',
      '心法': [0, 1, 2, 3].map((i) => (Array.isArray(flow['心法']) ? flow['心法'][i] : '') || ''),
    };
    const g = computeGraduateDps({ buildCtx, version, affixes, selections, prescription: p, flow });
    if (g.ok) {
      const dev = g.deviation != null ? `（vs I16 ${(g.deviation * 100).toFixed(1)}%）` : '（无 I16 对照）';
      console.log(`✓ ${name}/${flowLabel}: 基准=${Math.round(g.dps)} 来自方案生成${dev}`);
      ok++;
    } else {
      console.log(`✗ ${name}/${flowLabel}: 生成失败 ${(g.errors || []).join('；')} → 回退`);
      fallback++;
    }
  }
}
console.log(`\n方案生成 ${ok} 个 · 回退 Excel I16 ${fallback} 个`);
