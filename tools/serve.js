'use strict';

/**
 * serve.js — 零依赖静态文件服务器（服务工作区根目录，本地预览 index.html）
 * 用法: node tools/serve.js [端口，默认4173]
 *
 * 站点形态刻意做成和 GitHub Pages 完全一致：根路径直接就是 index.html，资源全部相对路径。
 * 所以本地看到的效果 = 托管后的效果，包括「部署在 /<repo>/ 子路径」这种项目级 Pages 的情况。
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const root = process.cwd();
const port = Number(process.argv[2]) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/octet-stream',
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // 根路径直接出首页（不再 302 到 /web/studio.html：页面已上移到仓库根）
    if (pathname === '/' || pathname === '/index.html') pathname = '/index.html';
    // 目录结尾补 index.html：顺便支持「把本仓库当子目录挂」的预览，
    // 例如从上一级目录启动、访问 http://127.0.0.1:4174/<repo>/ —— 等价于 GitHub Pages 项目级站点。
    if (pathname.endsWith('/')) pathname += 'index.html';
    // 分支模板发现端点：本地开发时免去 build:index。
    // 纯静态托管没有服务端，浏览器会 404 后回退 data/template/index.json。
    const tplMatch = pathname.match(/^\/api\/template\/([\w-]+)$/);
    if (tplMatch) {
      const dir = join(root, 'data', 'template', tplMatch[1]);
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ prefix: tplMatch[1], files }));
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ prefix: tplMatch[1], files: [] }));
      }
      return;
    }
    const safe = normalize(pathname).split(sep).filter((p) => p !== '..').join(sep);
    const file = join(root, safe);
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用：可能已有工作台在运行，直接访问 http://127.0.0.1:${port}/ 即可`);
  } else {
    console.error(`服务器错误: ${err.message}`);
  }
  process.exit(1);
}).listen(port, '127.0.0.1', () => {
  console.log(`调律台: http://127.0.0.1:${port}/  (根目录: ${root})`);
});
