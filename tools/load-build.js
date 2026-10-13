'use strict';

/**
 * load-build.js — Node 侧的流派数据加载（浏览器不可用，浏览器用 fetch）
 * 目录约定：data/schools/<流派前缀>/<buildId>(.json|.skills.json|.effects.json)
 * 流派前缀 = buildId 首段（如 pozhufeng.115.3.2 → pozhufeng）
 */
import fs from 'node:fs';

export function loadBuild(buildId) {
  const dir = `data/schools/${buildId.split('.')[0]}`;
  const read = (suffix) => JSON.parse(fs.readFileSync(`${dir}/${buildId}${suffix}`, 'utf-8'));
  return {
    build: read('.json'),
    skills: read('.skills.json').skills,
    effects: read('.effects.json').effects,
  };
}
