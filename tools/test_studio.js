'use strict';

/**
 * test_studio.js — 两栏工作台 UI 无头冒烟测试
 *
 * 用最小 DOM/fetch/localStorage 桩在 Node 里跑真实的 web/studio.js。
 *
 * ⚠ 2026-11-02 重建：上一版在改布局时被误删（约 1300 行），本文件按当时的断言清单重写，
 *   覆盖范围保持一致。重建时顺带把断言写得更"耐改"：**不写长正则、不拼整段 HTML**，
 *   只查关键结构与措辞 —— 改文案时不会一改就红一片。
 *
 * 覆盖：
 *   1. 布局骨架（两栏、右栏四行、组合总览位置）
 *   2. 旧档迁移（右武器→武器、多角色升级）
 *   3. 录入表单（部位/类型/承音、实时评价、按钮主次、入包）
 *   4. 装备详情（背包件 / 已穿戴件：两段说话体、档位标记、跨方案入口）
 *   5. 动作（穿上 / 脱下）
 *   6. 调律（去重、修改模式锁定、保存原地更新）
 *   7. 配置与跨流派命名
 *   8. 存档结构（角色 → pool + loadouts）
 */

import fs from 'node:fs';

// ---- DOM / 浏览器环境桩 ----
const els = new Map();
function makeEl(sel) {
  return {
    _sel: sel, _html: '', textContent: '', value: '', dataset: {},
    onchange: null, onclick: null, checked: false, disabled: false,
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    querySelector(s) { return document.querySelector(s); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}
globalThis.document = {
  querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
  querySelectorAll() { return []; },
  addEventListener() {},
};
globalThis.window = { addEventListener() {} };
globalThis.localStorage = {
  _m: {},
  getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); },
};
globalThis.location = { protocol: 'http:' };
globalThis.CSS = { escape: (s) => s };
globalThis.fetch = async (url) => {
  const p = String(url).replace(/^\//, '');
  if (p.startsWith('api/template/')) {
    const dir = 'data/template/' + p.replace('api/template/', '');
    try {
      const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      return { ok: true, json: async () => ({ prefix: dir.split('/').pop(), files }) };
    } catch {
      return { ok: false, status: 404, json: async () => ({ prefix: '', files: [] }) };
    }
  }
  const data = await fs.promises.readFile(p, 'utf-8');
  return { ok: true, json: async () => JSON.parse(data) };
};

// ---- 预置旧版存档（部位=右武器 + weaponType=绳镖），验证迁移与类型对比 ----
globalThis.localStorage._m['yysls-evaluator-v1'] = JSON.stringify({
  buildId: 'pozhufeng.115.3.2',
  flowId: 'dawai',
  selections: {},
  equipped: {
    右武器: {
      slot: '右武器', weaponType: '绳镖',
      初始: { 属性: '最大外功攻击', 数值: 139.6 },
      调律: [
        { 属性: '最大外功攻击', 数值: 139.6 },
        { 属性: '劲', 数值: 88.4 },
        { 属性: '绳镖武学增伤', 数值: 0.113 },
        { 属性: '会心率', 数值: 0.162 },
      ],
      定音: { 属性: '外功穿透', 数值: 19.4 },
    },
  },
  backpack: [],
});

// ---- 跑真实的 studio.js ----
const mod = await import('../web/studio.js');
await new Promise((r) => setTimeout(r, 400)); // 等 init 完成

let pass = 0;
const fails = [];
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fails.push(name); console.log(`✗ ${name}`); }
};

// 两栏（2026-11-02）：左 = 已穿戴槽位 + 背包；右 = 口径+毕业率 / 心法 / 配额 / 属性面板。
// 原「助手」占位列已删（只有一个 disabled 输入框，纯占版面；功能做出来时用抽屉/浮层进来）。
const LEFT = () => document.querySelector('#st-left').innerHTML;   // 左栏：已穿戴槽位
const BAG = () => document.querySelector('#st-center').innerHTML;  // 左栏：背包卡
const R = () => document.querySelector('#st-right').innerHTML;     // 右栏：口径 / 心法 / 配额 / 面板
const M = () => LEFT() + BAG() + R();                              // 全页主体
const C = () => document.querySelector('#st-modal').innerHTML;     // 弹窗
const TXT = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const { state, actions } = mod.__test;
const cssText = fs.readFileSync('web/studio.css', 'utf-8');
const htmlText = fs.readFileSync('web/studio.html', 'utf-8');

/** 读 C() 里某个调律位的下拉选项（去重断言用） */
function tuningOptions(i) {
  const html = C();
  const re = new RegExp(`data-ed-kind="调律" data-ed-idx="${i}" data-ed-field="属性">([\\s\\S]*?)</select>`);
  const m = html.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);
}

// ============ 1. 布局骨架 ============
console.log('\n— 1. 布局骨架 —');
check('两栏骨架：areas = leftcol/right，右侧 max(31vw, 380px)，没有助手列，body 横向 12px',
  cssText.includes('max(31vw, 380px)')
  && cssText.includes('grid-template-areas: "leftcol right"')
  && !cssText.includes('st-chat')
  && /body\s*\{[^}]*padding:\s*0 12px/.test(cssText));
check('助手占位列已删（HTML 里没有 #st-chat，也没有示例对白与标语）',
  !htmlText.includes('st-chat')
  && !M().includes('以上为界面示例') && !M().includes('对话式查询'));
check('左栏 = 装备槽（背包卡与之同住左列，不与右侧高卡拼行）',
  LEFT().includes('st-slots') && htmlText.includes('id="st-leftcol"')
  && htmlText.indexOf('id="st-left"') < htmlText.indexOf('id="st-center"'));
check('右栏四行顺序：口径+毕业率 → 心法 → 词条配额 → 属性面板',
  R().indexOf('st-kj-row') < R().indexOf('st-minds')
  && R().indexOf('st-minds') < R().indexOf('词条配额')
  && R().indexOf('词条配额') < R().indexOf('属性面板'));
check('组合总览已从右栏撤掉，改由背包标题的「组合」按钮打开（2026-11-02）',
  !R().includes('st-search-box') && BAG().includes('openComposition'));
check('页面上没有旧标语（潜力徽章 / 换装对比 / 判定徽章 / 界面示例）',
  !M().includes('当前潜力') && !M().includes('换装对比')
  && !M().includes('verdict-badge') && !M().includes('以上为界面示例'));
check('页面上没有多余说明段（「装备库为全局」「业务逻辑稍后接入」等）',
  !M().includes('装备库为全局') && !M().includes('业务逻辑稍后接入'));
check('顶栏只剩一行：没有「装备为器 · 词条为音」与「燕云十六声 · 装备评价工作台」',
  !htmlText.includes('装备为器') && !htmlText.includes('class="brand-sub"'));
check('词条配额与属性面板一体滚动（不再各自 overflow-y:auto）',
  cssText.includes('#st-right > #st-main-panel') && cssText.includes('overflow-y: auto;')
  && !/#st-main-panel > #st-quota-box \{ flex: 0 1 auto; min-height: 120px; overflow-y: auto; \}/.test(cssText)
  && cssText.includes('#st-main-panel > #st-stats-box { flex: 0 0 auto; min-height: 0; overflow: visible; }'));
check('移动端顶栏随滚动收起（data-bar=mini），且不显示流派两门武学',
  cssText.includes('body[data-bar="mini"] .app-bar') && cssText.includes('.st-kj-kongfu { display: none; }'));
check('三个心法槽渲染成卡（无「心法 点击槽位更换」这类说明文案）',
  R().includes('st-minds') && !R().includes('点击槽位更换'));

// 组合总览：从右栏常驻卡改成「背包·组合」按钮 + 模态框（2026-11-02）
actions.openComposition();
check('组合模态框：点按钮能打开', C().includes('组合总览'));
actions.closeModal();
check('组合模态框：关闭后清空（不会粘住）', !C().includes('组合总览'));

// ============ 2. 旧档迁移 ============
console.log('\n— 2. 旧档迁移 —');
check('迁移：右武器 → 存储键 武器2，部位归一为 武器（weaponType 保留）',
  !state.equipped['右武器'] && state.equipped['武器2']?.slot === '武器'
  && state.equipped['武器2']?.weaponType === '绳镖');
check('多角色：旧档就地升级为单角色「默认角色」，装备原地保留',
  mod.__test.charList().length === 1 && state.roster[state.charId]?.name === '默认角色');
check('槽位卡：已穿戴武器按类型取图（绳镖），卡面不挂「武器 · 类型」文字',
  M().includes('alt="绳镖"') && !M().includes('>绳镖<') && !M().includes('武器 · 绳镖'));
check('空槽位显示部位名与「＋」', LEFT().includes('st-slot-empty-name') || LEFT().includes('＋'));

// ============ 3. 录入表单 ============
console.log('\n— 3. 录入表单 —');
actions.openEditor('冠胄');
check('打开表单并预选部位', state.editing === true && state.draft.slot === '冠胄');
check('弹窗结构：遮罩 + 关闭按钮', C().includes('st-modal-backdrop') && C().includes('data-act="closeModal"'));
check('未录词条时不显示实时评价', !C().includes('实时评价'));
check('表单里没有长说明段（底部那句「选词条自动填区间最大值；…」已删）',
  !C().includes('勾选承音自动改为承音值'));

actions.setDraftSlot('武器');
check('部位=武器时类型跟随流派（双刀）', state.draft.slot === '武器' && state.draft.weaponType === '双刀');
check('部位下拉只有「武器」，既没有 武器1/武器2，也没有「不分左右」括注',
  !C().includes('>武器1<') && !C().includes('>武器2<') && !C().includes('不分左右'));
check('调律行带「转律」复选框', C().includes('data-ed-field="转律"'));
check('录入表单没有定音行（定音按槽位自动取值，玩家不录）',
  !C().includes('data-ed-kind="定音"'));

actions.setDraftWeaponType('双刀');
actions.setDraftAffix('初始', null, '最大外功攻击');
check('录第 1 条即给一句潜力话（还差 4 条 + 已录 1/5）',
  C().includes('实时评价') && C().includes('还差 4 条词条没录') && C().includes('已录 1/5'));
check('选词条自动填区间值', state.draft.初始.数值 > 0);

actions.setDraftAffix('调律', 0, '最大外功攻击');
actions.setDraftAffix('调律', 1, '劲');
actions.setDraftAffix('调律', 2, '双刀武学增伤');
actions.setDraftAffix('调律', 3, '会心率');
check('结构录满（5/5）', C().includes('已录 5/5'));
check('录满后给处置结论（两段说话体，不是「更好/更差」徽章）',
  C().includes('老大，这件') && !C().includes('verdict-badge'));
check('空武器位 ⇒ 先穿上', C().includes('这个部位还空着') && C().includes('先穿上吧'));

const uidA = actions.addDraft();
check('添加进背包并自动选中', !!uidA && state.backpack.length === 1
  && state.selected?.kind === 'backpack' && state.editing === false);

// ============ 4. 详情：背包件 ============
console.log('\n— 4. 详情（背包件） —');
check('背包件词条表不显示定音（它还没有定音，显示了会误导成"只能那个方案用"）',
  !C().includes('<td class="pos">定音</td>') && C().includes('<td class="pos">宫</td>'));
check('标题：背包 · 武器 · 双刀（武器按类型，不写左右）',
  C().includes('背包 · 武器 · 双刀') && !C().includes('左武器') && !C().includes('右武器'));
check('两段说话体：① 品相段（必有）② 怎么办段（有建议动作）',
  TXT(C()).includes('老大，这件')
  && /先穿上吧|换上吧|转律之后穿上吧|先收着|先留着|拆了吧/.test(TXT(C())));
check('档位只给「X阶」上色（带 data-tier）',
  /<b class="tier" data-tier="[天地玄黄]">[天地玄黄]阶<\/b>/.test(C()));
// 档位徽章的 title 里也提到「转律建议」，先剥掉属性再判断
check('没有独立的「转律建议」块（已并入处置句）',
  !C().replace(/title="[^"]*"/g, '').includes('转律建议'));
check('没有面板变化表', !C().includes('面板变化'));
check('词条数量不可点（没有 toggleSay）', !C().includes('data-act="toggleSay"'));
check('没有折叠明细块', !C().includes('st-say-detail'));
check('跨方案入口是「N 套方案」或干脆没有，不是独立按钮',
  C().includes('data-act="toggleXflow"') || !C().includes('套方案'));
check('详情里没有「处置」标题', !C().includes('digest-title">处置'));
// 同部位对比（2026-11-02）：只在「看背包件 + 同部位有穿戴」时出现
check('同部位空着 ⇒ 不出对比、弹窗不加宽',
  !C().includes('st-cmp') && !C().includes('st-modal--wide'));

// ============ 5. 动作：穿上 / 脱下 ============
console.log('\n— 5. 动作 —');
actions.equip(uidA);
check('穿上：进第一个空武器位（武器1），部位=武器',
  state.equipped['武器1']?.slot === '武器' && state.equipped['武器1']?.weaponType === '双刀'
  && state.selected?.kind === 'equipped');
check('已穿戴详情标题按类型显示', C().includes('已穿戴 · 武器 · 双刀'));
check('已穿戴词条表有定音行，值取自方案（攻具=外功穿透 19.4）',
  C().includes('<td class="pos">定音</td>') && /外功穿透/.test(C()) && /19\.4/.test(C()));
check('已穿戴件：四段式，第一段末尾交代「它正穿在你身上」',
  TXT(C()).includes('老大，这件') && TXT(C()).includes('它正穿在你身上'));
check('已穿戴件：动作落在 留着 / 转律后继续用 / 拆 三者之一',
  /留着吧|转律之后接着用吧|往后换到更好的再拆/.test(TXT(C())));
check('已穿戴件：不跟自身比较（没有「比你现在穿的那件」）', !TXT(C()).includes('比你现在穿的那件'));
check('已穿戴件：不再单列匹配度明细', !C().includes('缺必备'));

// 同类型武器已穿 + 背包里再来一把同类 ⇒ 两张词条表并排
const _wornWeapon = state.equipped['武器1'];
actions.openEditor('武器');
actions.setDraftWeaponType('双刀');
actions.setDraftAffix('初始', null, '最大外功攻击');
actions.setDraftAffix('调律', 0, '势');
actions.setDraftAffix('调律', 1, '最大外功攻击');
actions.setDraftAffix('调律', 2, '劲');
actions.setDraftAffix('调律', 3, '会心率');
const uidCmp = actions.addDraft();
check('背包件 vs 同类型已穿戴：两张表并排、弹窗加宽',
  C().includes('st-cmp') && C().includes('st-modal--wide')
  && C().includes('现在穿的') && C().includes('这件'));
check('建议不再整句加粗（只有「N 套」那一截是金色链接）', !C().includes('class="hl"'));
check('对比区不出现 DPS', !/DPS/.test(TXT(C())));
actions.removeBackpack(uidCmp);
check('已穿戴件详情不出对比（自己跟自己没可比性）',
  !!_wornWeapon && !C().includes('st-cmp'));

const wornUid = state.equipped['武器1'].uid;
actions.unequip('武器1');
check('脱下：槽位清空、件回背包（uid 不变）',
  !state.equipped['武器1'] && state.backpack.some((p) => p.uid === wornUid));

// ============ 5b. 空槽点击只筛背包 ============
console.log('\n— 5b. 空槽 —');
{
  // 空槽的 DOM 断言走字符串（测试环境的 innerHTML 子元素取不到，只能读 innerHTML）
  check('空槽渲染成 focusSlot（不再是 openEditor 录入入口）',
    /class="st-slot[^"]*empty[^"]*"[^>]*data-act="focusSlot"/.test(LEFT())
    && !/empty[^"]*"[^>]*data-act="openEditor"/.test(LEFT()));
  const wornBefore = state.equipped['腕甲'];
  const hadBracer = !!wornBefore;
  if (hadBracer) actions.unequip('腕甲');
  actions.focusSlot('腕甲');
  check('点空槽：只筛背包、不开录入表单',
    state.bagFilter === '腕甲' && state.editing === false
    && !C().includes('st-modal-backdrop'));
  check('背包标题带部位（背包·腕甲）', BAG().includes('背包·腕甲'));
  actions.focusSlot('腕甲');
  check('再点一次空槽 = 取消筛选', state.bagFilter === null);
  if (hadBracer) actions.equip(wornBefore.uid); // 复原
}

// ============ 6. 调律编辑（背包件） ============
console.log('\n— 6. 调律编辑 —');
const beforeEdit = state.backpack.find((p) => p.uid === uidA);
actions.editPiece({ kind: 'backpack', uid: uidA });
check('打开修改表单并原样读回词条',
  state.editing === true && state.editTarget?.kind === 'backpack'
  && state.draft.slot === '武器'
  && state.draft.调律.every((a, i) => a.属性 === beforeEdit.调律[i].属性));
check('修改模式：只有「保存修改 / 取消」，没有 添加到背包/直接穿上/丢弃',
  C().includes('id="ed-save"') && C().includes('>保存修改</button>')
  && !C().includes('id="ed-add"') && !C().includes('id="ed-equip"') && !C().includes('id="ed-discard"'));
check('修改模式：部位下拉锁定（disabled）', C().includes('<select id="ed-slot" disabled'));
check('修改模式：标题带部位（修改 · 武器）', C().includes('修改 · 武器'));

check('调律去重：位 0 已选后，位 1/2/3 的候选里没有该词条',
  !tuningOptions(1).includes('最大外功攻击')
  && !tuningOptions(2).includes('最大外功攻击')
  && !tuningOptions(3).includes('最大外功攻击'));
check('调律去重：位 0 自身仍保留已选值', tuningOptions(0).includes('最大外功攻击'));

actions.setDraftAffix('调律', 3, '精准率');
actions.saveEdit();
const afterEdit = state.backpack.find((p) => p.uid === uidA);
check('保存：原地更新（uid 不变、件数不变），改动生效',
  !!afterEdit && state.backpack.length === 1 && afterEdit.uid === uidA
  && afterEdit.调律[3].属性 === '精准率' && beforeEdit.调律[3].属性 === '会心率');
check('保存后回到该件详情', state.editing === false && state.editTarget === null
  && state.selected?.kind === 'backpack');

// ============ 7. 配置与跨流派命名 ============
console.log('\n— 7. 配置 —');
check('当前配置键为三段（流派|分支|方案）',
  String(mod.__test.currentConfigKey()).split('|').length === 3);
await new Promise((r) => setTimeout(r, 30)); // 等后台 ensureAllMetas 预热 _meta.json
check('跨流派方案名用中文分支名（不是拼音 id）',
  mod.__test.configLabelOf('lieshijun|chuntang|dawai') === '裂石钧·纯唐轴·大外流');
check('当前流派的方案名同样正确',
  mod.__test.configLabelOf('qiansiyu|zoudiyu|dawai') === '牵丝玉·走地玉·大外流');
check('方案名不出现英文 id（chuntang / zoudiyu）',
  !/chuntang|zoudiyu/.test(mod.__test.configLabelOf('lieshijun|chuntang|dawai')
    + mod.__test.configLabelOf('qiansiyu|zoudiyu|dawai')));

// ============ 7b. 删除 / 已穿戴编辑 / 换流派 ============
console.log('\n— 7b. 删除与已穿戴编辑 —');
const uidDel = state.backpack[0].uid;
actions.equip(uidDel);
const uidWorn = state.equipped['武器1'].uid;
actions.editPiece({ kind: 'equipped', slot: '武器1' });
check('编辑已穿戴件：表单打开且部位锁定',
  state.editing === true && state.editTarget?.kind === 'equipped'
  && C().includes('<select id="ed-slot" disabled'));
check('编辑已穿戴件：只给「保存修改/取消」', C().includes('id="ed-save"') && !C().includes('id="ed-add"'));
actions.setDraftAffix('调律', 0, '最小外功攻击');
actions.saveEdit();
check('已穿戴件保存：原地更新且仍在原槽位（uid 不变）',
  state.equipped['武器1']?.uid === uidWorn && state.equipped['武器1']?.调律[0].属性 === '最小外功攻击');

actions.removeEquipped('武器1');
check('删除已穿戴件：槽位清空、件从装备库消失',
  !state.equipped['武器1'] && !state.backpack.some((p) => p.uid === uidWorn));

const uidC = actions.openEditor('环') || null;
actions.setDraftAffix('初始', null, '最大外功攻击');
actions.setDraftAffix('调律', 0, '最小外功攻击');
actions.setDraftAffix('调律', 1, '全武学增伤');
actions.setDraftAffix('调律', 2, '劲');
actions.setDraftAffix('调律', 3, '会心率');
const uidRing = actions.addDraft();
check('录入第二件（环）进背包', !!uidRing && state.backpack.some((p) => p.uid === uidRing));
actions.removeBackpack(uidRing);
check('删除背包件：从库中移除', !state.backpack.some((p) => p.uid === uidRing) && !state.equipped['环']);

console.log('\n— 7c. 换流派 —');
const poolSizeBefore = state.pool.length;
await mod.__test.switchSchool('qiansiyu');
check('切流派：不出现「技能轴尚未提供」这类技术提示',
  !M().includes('技能轴尚未提供') && !M().includes('st-build-notice'));
check('切流派：装备库是全局的（件数不变，只是换了评价口径）', state.pool.length === poolSizeBefore);
await mod.__test.switchSchool('pozhufeng');
check('切回破竹风：界面正常、配额头仍在', R().includes('st-kj-row') && R().includes('毕业率'));

// ============ 8. 存档结构 ============
console.log('\n— 8. 存档 —');
const saved = JSON.parse(globalThis.localStorage._m['yysls-evaluator-v1']);
check('存档键名恒为 yysls-evaluator-v1（改名 = 清空玩家装备库）',
  !!globalThis.localStorage._m['yysls-evaluator-v1']);
check('存档为多角色结构（角色 → pool + loadouts）',
  Object.values(saved.角色 || {}).every(
    (c) => Array.isArray(c.pool) && typeof c.loadouts === 'object',
  ));
check('存档里 uid 不重复', (() => {
  const uids = Object.values(saved.角色 || {}).flatMap((c) => (c.pool || []).map((p) => p.uid));
  return new Set(uids).size === uids.length;
})());
check('loadout 只存 uid 引用，且引用都能在 pool 里找到（件存一份）', (() => {
  const c = saved.角色?.[state.charId];
  if (!c) return false;
  const ids = new Set((c.pool || []).map((p) => p.uid));
  const refs = Object.values(c.loadouts || {}).flatMap((l) => Object.values(l || {}));
  return refs.every((r) => r == null || ids.has(r));
})());

// ============ 汇总 ============
console.log(`\n通过 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(' -', f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
