// 一次性核查：模拟 UI 用户路径，逐流派×逐流验证毕业基准来源（方案生成 vs Excel I16 回退）
import fs from 'node:fs';
import { loadBuild } from './load-build.js';
import { loadVersionData } from './load-version.js';
import { derivePrescription } from '../engine/quota.js';
import { computeGraduateDps } from '../engine/graduate.js';

const { version, affixes } = loadVersionData();
const manifest = JSON.parse(fs.readFileSync('data/version/manifest.json', 'utf-8'));
let fallback = 0, ok = 0;
for (const { id, name } of manifest['流派']) {
  const buildId = id.split('.')[0];
  const buildCtx = loadBuild(id);
  const b = buildCtx.build;
  const weaponTypes = (b.weapon_categories || []).slice(1, 3).map((c) => c.label);
  const dir = `data/template/${buildId}`;
  const flowFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of flowFiles) {
    const flow = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    const p = derivePrescription(affixes, flow, weaponTypes);
    if (!p || !p.feasible) { console.log(`✗ ${name}/${flow.name}: 推导不可行 → 回退`); fallback++; continue; }
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
      console.log(`✓ ${name}/${flow.name}: 基准=${Math.round(g.dps)} 来自方案生成${dev}`);
      ok++;
    } else {
      console.log(`✗ ${name}/${flow.name}: 生成失败 ${(g.errors || []).join('；')} → 回退`);
      fallback++;
    }
  }
}
console.log(`\n方案生成 ${ok} 个 · 回退 Excel I16 ${fallback} 个`);
