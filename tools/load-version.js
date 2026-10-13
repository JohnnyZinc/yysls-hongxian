'use strict';

/**
 * load-version.js — Node 侧的版本数据加载（浏览器不可用，浏览器用 fetch）
 * 目录约定：data/version/manifest.json 单点声明当前赛季；
 *           data/version/<赛季id>/version.json + affixes.json 为该赛季数据。
 * 旧赛季目录原地保留（即归档），永远只加载 manifest 指向的当前赛季。
 */
import fs from 'node:fs';

const MANIFEST_PATH = 'data/version/manifest.json';

export function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  if (!manifest['当前赛季']) {
    throw new Error(`${MANIFEST_PATH} 缺少 "当前赛季" 字段`);
  }
  return manifest;
}

export function loadVersionData() {
  const manifest = loadManifest();
  const seasonId = manifest['当前赛季'];
  const dir = `data/version/${seasonId}`;
  const read = (name) => JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf-8'));
  return {
    manifest,
    seasonId,
    version: read('version.json'),
    affixes: read('affixes.json'),
  };
}
