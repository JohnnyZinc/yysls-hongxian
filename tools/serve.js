'use strict';

/**
 * serve.js — 零依赖静态文件服务器（服务工作区根目录，供本地网页验证台使用）
 * 用法: node tools/serve.js [端口，默认4173]
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
  '.xlsx': 'application/octet-stream',
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // 根路径重定向到 /web/studio.html：保证相对资源路径（./style.css 等）解析正确
    if (pathname === '/' || pathname === '/web/' || pathname === '/web') {
      res.writeHead(302, { Location: '/web/studio.html' });
      res.end();
      return;
    }
    // 分支模板发现端点：浏览器无法列目录，由本服务器代劳（无需 index.json）
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
    console.error(`端口 ${port} 已被占用：可能已有工作台在运行，直接访问 http://127.0.0.1:${port}/web/studio.html 即可`);
  } else {
    console.error(`服务器错误: ${err.message}`);
  }
  process.exit(1);
}).listen(port, '127.0.0.1', () => {
  console.log(`装备评价工作台: http://127.0.0.1:${port}/web/studio.html  (根目录: ${root})`);
});
