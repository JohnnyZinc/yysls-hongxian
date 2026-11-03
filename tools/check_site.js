'use strict';

/**
 * check_site.js — 静态站点体检（本地预览 / GitHub Pages 部署前自检）
 *
 * 站点是**纯静态**的：入口 = 仓库根目录 index.html，所有资源都是相对路径。
 * 一旦有人（包括未来的我）手滑写回 /data/... 、/web/... 这类以斜杠开头的路径，
 * 在 GitHub Pages 的「项目级站点」（https://<user>.github.io/<repo>/）上就会 404 白屏，
 * 而本地 serve.js 可能还看不出问题 —— 所以用这个脚本把这类错误挡在提交前。
 *
 * 检查项：
 *   1. index.html 里每个 href/src 指向的文件真的存在
 *   2. web/*.js、web/*.css、index.html 里没有以斜杠开头的站内绝对路径
 *   3. web/*.js 的模块 import（相对路径）都能解析
 *   4. 所有 CSS 的 url() 目标存在（含 assets/fonts 里的字体分片）
 *   5. 运行时数据齐备：模板静态索引 / 版本 manifest / 流派 build 包 / 知识库 / 立绘清单
 *   6. Pages 需要的 .nojekyll 在（CNAME 只在自定义域名时才有，仅提示）
 *
 * 用法: node tools/check_site.js        （npm run check:site）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (p) => join(ROOT, p);
const rel = (p) => p.replace(/\\/g, '/');

let pass = 0;
const fails = [];
const notes = [];
const ok = (name) => { pass += 1; };
const bad = (name) => { fails.push(name); console.log(`✗ ${name}`); };

const readJson = (p) => JSON.parse(readFileSync(abs(p), 'utf-8'));
const isFile = (p) => { try { return statSync(abs(p)).isFile(); } catch { return false; } };

function walk(dir, out = []) {
  for (const e of readdirSync(abs(dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const run = (title, fn) => {
  console.log(`\n— ${title} —`);
  try { fn(); } catch (err) { bad(`${title} 检查本身抛错：${err.message}`); }
};

// ============ 1. index.html 的 href/src ============
run('1. 页面资源引用', () => {
  const html = readFileSync(abs('index.html'), 'utf-8');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((u) => !/^(data:|https?:|#|mailto:)/.test(u));
  if (!local.length) return bad('index.html 里一个本地资源都没引用，可能路径写丢了');
  for (const u of local) {
    const clean = u.split('?')[0].split('#')[0];
    if (isFile(clean)) ok(u);
    else bad(`index.html 引用的文件不存在：${u}`);
  }
  console.log(`共 ${local.length} 个本地引用`);
});

// ============ 2. 站内绝对路径 ============
run('2. 绝对路径（项目级 Pages 杀手）', () => {
  const files = ['index.html', ...readdirSync(abs('web')).filter((f) => /\.(js|css)$/.test(f)).map((f) => `web/${f}`)];
  // 只认「字符串字面量里以 / 开头」的情况；注释里提到 /data/ 不算
  const re = /(['"`])\/(?:data|web|assets|api)\//g;
  let found = 0;
  for (const f of files) {
    const text = readFileSync(abs(f), 'utf-8');
    text.split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) {
        found += 1;
        bad(`${f}:${i + 1} 用了站内绝对路径 → ${line.trim().slice(0, 90)}`);
      }
    });
  }
  if (!found) { ok('no-absolute'); console.log('✓ 没有以 / 开头的站内路径（相对路径才能挂在 /<repo>/ 下）'); }
});

// ============ 3. ES module import 可解析 ============
run('3. 模块导入', () => {
  const jsFiles = readdirSync(abs('web')).filter((f) => f.endsWith('.js')).map((f) => `web/${f}`);
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let n = 0;
  for (const f of jsFiles) {
    for (const m of readFileSync(abs(f), 'utf-8').matchAll(re)) {
      const target = resolve(dirname(abs(f)), m[1]);
      n += 1;
      if (existsSync(target)) ok(target);
      else bad(`${f} 导入的文件不存在：${m[1]}`);
    }
  }
  console.log(`共 ${n} 条相对 import`);
});

// ============ 4. CSS url() ============
run('4. CSS 资源', () => {
  const cssFiles = [...walk('web').filter((f) => f.endsWith('.css')), ...walk('assets/fonts').filter((f) => f.endsWith('.css'))];
  const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  let n = 0;
  for (const f of cssFiles) {
    for (const m of readFileSync(abs(f), 'utf-8').matchAll(re)) {
      const u = m[1].trim();
      if (/^(data:|https?:)/.test(u) || u.includes('var(')) continue;
      const target = resolve(dirname(abs(f)), u.split('?')[0]);
      n += 1;
      if (existsSync(target)) ok(target);
      else bad(`${f} 的 url() 目标不存在：${u}`);
    }
  }
  console.log(`共 ${n} 条 url() 引用`);
});

// ============ 5. 运行时数据 ============
run('5. 运行时数据', () => {
  // 5a 模板静态索引（静态托管拿不到目录列表，只能靠它）
  if (!isFile('data/template/index.json')) {
    bad('缺 data/template/index.json（分支下拉会空）→ 跑 npm run build:index');
  } else {
    const idx = readJson('data/template/index.json');
    const dirs = readdirSync(abs('data/template'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    let missingDir = 0;
    for (const d of dirs) if (!idx.prefix?.[d]) { missingDir += 1; bad(`模板索引漏了流派 ${d} → 跑 npm run build:index`); }
    for (const [prefix, files] of Object.entries(idx.prefix || {})) {
      for (const f of files) {
        if (isFile(`data/template/${prefix}/${f}`)) ok(f);
        else bad(`模板索引指向的文件不存在：data/template/${prefix}/${f} → 跑 npm run build:index`);
      }
    }
    if (!missingDir) console.log(`✓ 模板索引覆盖 ${dirs.length} 个流派 / ${Object.values(idx.prefix || {}).flat().length} 个方案`);
  }

  // 5b 版本 manifest + build 包
  if (!isFile('data/version/manifest.json')) bad('缺 data/version/manifest.json');
  else {
    const mf = readJson('data/version/manifest.json');
    const season = mf.当前赛季;
    for (const f of ['version.json', 'affixes.json']) {
      if (isFile(`data/version/${season}/${f}`)) ok(f);
      else bad(`缺 data/version/${season}/${f}`);
    }
    for (const p of mf.build包 || []) {
      const base = `data/schools/${p.流派}/${p.id}`;
      if (isFile(`${base}.json`) && isFile(`${base}.skills.json`) && isFile(`${base}.effects.json`)) ok(p.id);
      else bad(`build 包数据不全：${base}.{json,skills.json,effects.json}`);
    }
    console.log(`✓ 当前赛季 ${season}，build 包 ${(mf.build包 || []).length} 个`);
  }

  // 5c 知识库
  if (!isFile('知识库/index.json')) bad('缺 data/kb/index.json（助手知识库）');
  else {
    const kb = readJson('知识库/index.json');
    for (const f of kb.files || []) {
      if (isFile(`知识库/${f}`)) ok(f);
      else bad(`知识库文件不存在：data/kb/${f}`);
    }
    console.log(`✓ 知识库 ${(kb.files || []).length} 篇`);
  }

  // 5d 立绘清单
  if (!isFile('assets/img/char/manifest.json')) bad('缺 assets/img/char/manifest.json（立绘清单）');
  else {
    const cm = readJson('assets/img/char/manifest.json');
    for (const mood of cm.moods || []) {
      if (isFile(`assets/img/char/hongxian-${mood}.webp`)) ok(mood);
      else bad(`立绘缺图：assets/img/char/hongxian-${mood}.webp（该情绪会回落 idle）`);
    }
    console.log(`✓ 立绘 ${(cm.moods || []).length} 张`);
  }
});

// ============ 6. Pages 部署文件 ============
run('6. Pages 部署文件', () => {
  if (isFile('.nojekyll')) { ok('.nojekyll'); console.log('✓ .nojekyll 在（否则 _meta.json 这类下划线文件会被 Jekyll 吞掉）'); }
  else bad('缺 .nojekyll → 新建一个空文件放在根目录');
  if (isFile('CNAME')) {
    const host = readFileSync(abs('CNAME'), 'utf-8').trim();
    console.log(`ℹ CNAME = ${host}（自定义域名已启用）`);
  } else {
    notes.push('没有 CNAME：现在只能走 https://<user>.github.io/<repo>/ 项目级地址；绑二级域名时在仓库根加 CNAME 文件（只写域名一行，不带协议、不带路径）');
  }
});

// ============ 汇总 ============
console.log('');
for (const n of notes) console.log(`ℹ ${n}`);
if (fails.length) {
  console.log(`\n✗ 站点体检失败：${fails.length} 项`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过（${pass} 项）✓  站点可以直接静态托管`);
