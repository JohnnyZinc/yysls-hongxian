'use strict';

/**
 * load-build.js — Node 侧的流派数据加载（浏览器不可用，浏览器用 fetch）
 */
import fs from 'node:fs';

export function loadBuild(prefix) {
  const read = (suffix) => JSON.parse(fs.readFileSync(prefix + suffix, 'utf-8'));
  return {
    build: read('.json'),
    skills: read('.skills.json').skills,
    effects: read('.effects.json').effects,
  };
}
