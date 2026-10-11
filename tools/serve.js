'use strict';

/**
 * serve.js — 零依赖静态文件服务器（服务工作区根目录，供本地网页验证台使用）
 * 用法: node tools/serve.js [端口，默认4173]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
    if (pathname === '/') pathname = '/web/index.html';
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
}).listen(port, '127.0.0.1', () => {
  console.log(`验证台: http://127.0.0.1:${port}/  (根目录: ${root})`);
});
