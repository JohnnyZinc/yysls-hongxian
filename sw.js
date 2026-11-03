/*
 * sw.js — 调律台 Service Worker（2026-11-03）
 *
 * 为什么需要它：GitHub Pages 对静态文件只返回 `Cache-Control: max-age=600`，
 * 且不允许自定义响应头；超过 10 分钟缓存就过期，浏览器得为几十个资源逐个发
 * 条件请求，跨境链路下依然很慢。Service Worker 自己在本地存一份，就能做到
 * 「第一次之后（哪怕是隔几天再打开）基本 0 网络」。
 *
 * 策略：
 *   - 页面导航：network-first（先拿最新 HTML，4s 超时后用缓存）——保证发版后
 *     index.html 里的 ?v= 版本号能立刻生效。
 *   - assets/**、web/**、engine/**：stale-while-revalidate（先用缓存秒开，
 *     后台再更新），所以发版后第二次刷新就是新版。
 *   - data/**、知识库/**：network-first（1.5s 超时回落缓存），数据保持新鲜。
 *   - request.cache === 'no-store' 的请求直接放行（例如立绘 manifest）。
 *
 * 兼容两种部署：域名根（自定义域名）与项目级子路径（/<repo>/）。
 * 版本：改了资源/策略后把 CACHE_VERSION 加一，旧缓存会在 activate 时清掉。
 */
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `yysls-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `yysls-asset-${CACHE_VERSION}`;
const DATA_CACHE = `yysls-data-${CACHE_VERSION}`;
const CACHES = [SHELL_CACHE, ASSET_CACHE, DATA_CACHE];

// 站点根（自定义域名是 "/"，项目级 Pages 是 "/<repo>/"）
const BASE = new URL(self.registration.scope).pathname;
const NAV_KEY = new URL('index.html', self.registration.scope).href;

// 预缓存：页面骨架 + 字体 + 两个 manifest（都很小，且首屏必用）
const SHELL = [
  'index.html',
  'assets/fonts/kai/kai.css',
  'assets/fonts/kai/gkai00mp.woff2',
  'assets/img/char/manifest.json',
  'data/version/manifest.json',
];

const NAV_TIMEOUT = 4000;
// 数据（模板 _meta、版本 manifest 等）网络优先，但只等 1.5s：跨境 RTT 差的时候
// 宁可先给上次的缓存（发版后第二次打开一定是新的），也不要卡着白屏等数据。
const DATA_TIMEOUT = 1500;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 用 allSettled：个别资源 404 不能把安装整个搞挂
    await Promise.allSettled(SHELL.map(async (url) => {
      const req = new Request(url, { cache: 'reload' });
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res);
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !CACHES.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function withTimeout(req, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function networkFirst(req, cacheName, cacheKey) {
  const cache = await caches.open(cacheName);
  const key = cacheKey || req;
  try {
    const res = await withTimeout(req, req.mode === 'navigate' ? NAV_TIMEOUT : DATA_TIMEOUT);
    if (res && res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req).then(async (res) => {
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) {
    network.catch(() => {}); // 后台更新，不阻塞返回
    return hit;
  }
  const res = await network;
  if (res) return res;
  throw new Error('offline and not cached: ' + req.url);
}

// 把 URL 归一化成「站点内路径」（去掉项目级前缀），再分类
function classify(pathname) {
  let p = pathname;
  if (BASE !== '/' && p.startsWith(BASE)) p = '/' + p.slice(BASE.length);
  let decoded = p;
  try { decoded = decodeURIComponent(p); } catch { /* 保留原样 */ }
  if (p.startsWith('/data/') || decoded.startsWith('/知识库/')) return 'data';
  if (p.includes('/assets/') || p.includes('/web/') || p.includes('/engine/')) return 'asset';
  return 'other';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.cache === 'no-store') return; // 明确要求绕过缓存

  const kind = classify(url.pathname);
  if (kind === 'data') {
    event.respondWith(networkFirst(req, DATA_CACHE));
  } else if (kind === 'asset') {
    event.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
  } else if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, NAV_KEY));
  }
});
