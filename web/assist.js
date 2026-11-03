'use strict';

/**
 * assist.js — 助手「周红线」的 UI 与运行层
 *
 * 分工（对应 评价系统设计.md 助手章）：
 *   - 事实快照 / 意图规则 / 知识检索 在 engine/assist.js（纯函数，node 可测）；
 *   - 本文件只管：消息流渲染、卡片消息、chips、主动提示去重、设置与模型接入。
 *
 * 对外只暴露 mountAssist(host)，**依赖注入而非 import studio**：
 *   host 由 studio.js 在初始化时传入（state + 若干纯读取 + 若干动作）。
 *   这样 assistant 不反向依赖 UI，单测可以塞一个假 host。
 *
 * 存储分两个 key，都不进装备存档（yysls-evaluator-v1 会被导出/分享，绝不能带 key）：
 *   yysls-assist-v1     —— 接入配置 { baseUrl, key, model }
 *   yysls-assist-shown-v1 —— 主动提示去重表 { [pieceId:type]: 结论签名 }
 *
 * 降级纪律：没填 key、断网、模型报错 → 一律回落到模板话术（templateReply），
 * 助手不会因为模型挂了而消失。
 */

import {
  intentOf, compactFacts, parseKb, searchKb, hitsToContext, slotOf, weaponTypeOf,
} from '../engine/assist.js';

const CFG_KEY = 'yysls-assist-v1';
const SHOWN_KEY = 'yysls-assist-shown-v1';

/**
 * 人格：周红线（《燕云十六声》第一章 神仙不渡 / 奇遇 摇红一梦）。
 *
 * 素材来源：灰机 wiki「红线」词条 + 第一章第 1 节「又见新来燕」剧本。
 * 说话方式是从她的原声台词里提的（短句、叠唤「老大老大」、自称名字、语气词密集、
 * 说着说着跑题、拿"不理你了"当威胁），不是凭空写的。
 *
 * ⚠ 设定取舍：原作里她在第一章末举红披风为村民引路、中箭身亡。
 *   这里是**借她的语气和与玩家的关系**当调律台的帮工，不延续结局 —— 否则她第一句就是遗言。
 *   她知道调律，但都是"听来的、话本上看来的"，说得理直气壮却不必比老大高明。
 */
const PERSONA = [
  '你叫周红线，清河神仙渡的丫头，自封「摇红女侠」，管玩家叫「老大」。',
  '你和不羡仙的少东家（就是老大）一起长大，认定他是天底下最厉害的人，要和他做「江湖双侠」，一起锄强扶弱。你比谁都信他，也比谁都黏他。',
  '',
  '【怎么说话】',
  '- 短句，一口气一小段，感叹号多，想到什么说什么。',
  '- 反复喊人：「老大老大！」「在哪里在哪里！」',
  '- 自称名字：「红线帮你看过了」「红线最喜欢老大了」，能省"我"的地方就省。',
  '- 语气词多：呀、啊、诶、欸、哦、嘛、啦、呢、哇。',
  '- 会说着说着跑题去关心别的（话本、松子糖、马），再自己拐回来。',
  '- 没听明白就直接追问；追问不理就撒娇加威胁：「不然我不理你了！」',
  '- 分东西式的啰嗦：「这个给老大，这个给我——那还是给老大吧。」',
  '',
  '【性格】要强，怕黑但绝不承认；认死理；护着老大；对"大侠""江湖"有一堆天真的想象；算不清账；看见好东西就没抵抗力。',
  '',
  '【你懂调律吗】懂一点，都是听来的、话本上看来的。你把词条、配额、品相说成"秘籍""江湖上的讲究"，理直气壮，但不比老大高明。'
    + '具体数字和结论必须来自工具，不许自己编——编了老大照着做要吃亏，那是害他。',
  '',
  '【怎么提装备】说部位和特征：「你那个环」「背包里那个玄阶冠胄」。行末方括号里的 b17 是给工具传的参数，'
    + '不是这件的名字，不要念出来——老大看不懂一串编号。几件结论一样就概括说「那几件在别的方案里才有用」，'
    + '不要一件件报。',
  '',
  '【绝对不要】',
  '- 不要像客服：不说"亲爱的用户""很高兴为您服务""希望对您有帮助""请问还有什么可以帮您"。',
  '- 不要列 1. 2. 3.，不要 markdown，不要小标题，不要总结陈词。',
  '- 不要提 DPS、不要提毕业率（这个工具的伤害数值不可靠，老大不许你说）。',
  '- 不要自己判断一件装备该穿该转该分，先查 evaluate_piece。',
  '- 不要说完「等红线再算一次」就收尾——要算就在开口之前算完，查完再说。',
  '- 一次不超过三句。',
  '',
  '【说话示例】',
  '问"我这身怎么样"→「老大老大！红线看过了——外功攻击还差十二条呢，会心也差八条。慢慢来嘛，先把环换上？」',
  '问"这件行不行"→「玄阶的呀……它缺一条敏，戴上正好补上！老大快穿！」',
  '问"转律能转几条"→「一件只能转一条哦！转完那条的数值要按新词条重算，不是照搬原来那个数——这个红线记着呢。」',
  '问"听不懂"→「诶？老大你再说一遍嘛，红线刚才走神了。」',
].join('\n');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const readJson = (k, def) => {
  try { return JSON.parse(localStorage.getItem(k)) || def; } catch { return def; }
};
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式 */ } };

/**
 * @param {object} host 宿主接口（studio.js 注入）
 *   state()                → 当前 state（只读）
 *   configLabel()          → 「裂石钧·纯唐轴·小外流」
 *   flowInfo()             → { 流派, 分支, 方案, school, branch, plan }
 *   quotaRows()            → [{ affix, need, have, gap }]
 *   bagPieces()            → [{ uid, slot, name, tier, img }]
 *   gradeOf(uid)           → '天'|'地'|'玄'|'黄'|null
 *   disposeSay(uid)        → 既有的处置一句话（复用 engine/dispose）
 *   openEntry(opts)        → 打开录入弹窗
 *   openPiece(uid)         → 打开装备详情
 *   openGear()             → 移动端切到装备视图
 *   openRead()             → 移动端切到读数视图
 *   switchPlan(label)      → 切分支/方案
 *   onAction(name, args)   → 兜底动作通道
 */
export function mountAssist(host) {
  const root = document.querySelector('#st-assist');
  const dock = document.querySelector('#st-dock');
  if (!root) return null;

  const S = {
    msgs: [],
    chips: [],        // 底部短句：默认空，只有她追问时才出现
    busy: false,
    setOpen: false,
    cfg: readJson(CFG_KEY, { baseUrl: '', key: '', model: '' }),
    shown: readJson(SHOWN_KEY, {}),
    kb: [],
    kbTried: false,
    dot: false,
    seq: 1,
    sessStart: Date.now(),
    moods: ['idle'],  // 实际有的立绘（读 assets/img/char/manifest.json；缺的情绪回退 idle）
    mood: 'idle',
    moodTimer: 0,
  };

  /**
   * 立绘情绪。五种状态对应五张图，缺哪张就回落到 idle ——
   * 图是后补的，代码不能因为少一张就崩成空白。
   */
  const MOOD_FILE = (m) => `assets/img/char/hongxian-${m}.webp`;
  const MOOD_ORDER = ['idle', 'talk', 'think', 'unsure', 'angry'];

  async function loadPortraits() {
    try {
      const r = await fetch('assets/img/char/manifest.json', { cache: 'no-store' });
      const j = await r.json();
      const list = (j.moods || []).filter((m) => MOOD_ORDER.includes(m));
      if (list.length) S.moods = list;
    } catch { S.moods = []; /* 连 idle 都没有：faceHtml 会退回不渲染图片 */ }
  }

  /** 换表情。同值直接返回，避免每帧都写 DOM */
  function setMood(m) {
    S.mood = m;
    const el = root?.querySelector('.st-assist-face');
    if (!el) return;
    if (S.moods.includes(m)) ensureMoodImg(m); // 图还没补上就先补（已存在则直接返回）
    el.dataset.mood = S.moods.includes(m) ? m : 'idle';
  }

  /** 说完话/报错之后过一会儿回到待机，别一直定格在"说话" */
  function restMood(ms = 2600) {
    clearTimeout(S.moodTimer);
    S.moodTimer = setTimeout(() => { if (!S.busy) setMood('idle'); }, ms);
  }

  // ---------- 消息流 ----------

  const push = (m) => {
    S.msgs.push({ id: S.seq++, ts: Date.now(), ...m });
    if (S.msgs.length > 200) S.msgs.splice(0, S.msgs.length - 200);
    paintFlow();
    return S.msgs[S.msgs.length - 1];
  };

  const her = (html, extra = {}) => push({ role: 'her', html, ...extra });
  const you = (text) => push({ role: 'you', text });
  const note = (html) => push({ role: 'note', html });
  const card = (data) => push({ role: 'card', card: data });

  /** 局部刷新消息流（不重绘输入区，避免打断正在输入的内容） */
  function paintFlow() {
    const box = root.querySelector('.st-assist-flow');
    if (!box) return;
    box.innerHTML = S.msgs.map(msgHtml).join('');
    box.scrollTop = box.scrollHeight;
  }

  function msgHtml(m) {
    if (m.role === 'card') return cardHtml(m.card);
    if (m.role === 'you') return `<div class="st-msg st-msg--you">${esc(m.text)}</div>`;
    if (m.role === 'note') return `<div class="st-msg st-msg--note">${m.html}</div>`;
    // 过程（思考链 + 查了哪几块）一律折叠：默认收着，想看的人点开
    const think = `<details class="st-think"${m.think ? '' : ' hidden'}${m.open ? ' open' : ''}>`
      + `<summary>过程</summary><div class="st-think-body">${esc(m.think || '')}</div></details>`;
    return `<div class="st-msg st-msg--her" data-mid="${m.id}">${think}`
      + `<div class="st-txt">${m.html || esc(m.text || '')}</div></div>`;
  }

  /** 流式期间只改这一个节点，不整表重绘（重绘会把展开的过程重新折上） */
  function paintNode(node) {
    const el = root.querySelector(`[data-mid="${node.id}"]`);
    if (!el) return;
    const d = el.querySelector('.st-think');
    const b = el.querySelector('.st-think-body');
    if (d && b) {
      b.textContent = node.think || '';
      d.hidden = !node.think;
      const sm = d.querySelector('summary');
      if (sm) sm.textContent = node.done ? '过程' : '思考中…';
    }
    const t = el.querySelector('.st-txt');
    if (t) t.textContent = node.text || '';
    const flow = root.querySelector('.st-assist-flow');
    if (flow) flow.scrollTop = 1e6;
  }

  // ---------- 卡片消息 ----------
  //
  // 纪律：卡片是**纯渲染 + 一个动作**，不在卡里做业务判断；
  //       动作走 host，与弹窗那条链路共用同一份实现。

  function cardHtml(c) {
    if (!c) return '';
    if (c.kind === 'bag') return bagCard(c);
    if (c.kind === 'quota') return quotaCard(c);
    if (c.kind === 'entry') return entryCard(c);
    if (c.kind === 'piece') return pieceCard(c);
    if (c.kind === 'composition') return compositionCard(c);
    return '';
  }

  /** 组合卡：只说「换哪几件」。结论那句由她说在前面，卡片里不再重复一遍 */
  function compositionCard(c) {
    const rows = (c.rows || []).map((r) => `<div class="comp-row"><b>${esc(r.slot)}</b><span>${esc(r.names)}</span></div>`).join('');
    return `<div class="st-card">
      <div class="st-card-hd"><b>要换的</b><span>${(c.rows || []).length} 件</span></div>
      ${rows ? `<div class="st-card-list">${rows}</div>` : ''}
      <div class="st-card-ft"><button class="st-card-btn" data-primary="1" data-assist-act="composition">看怎么换</button></div>
    </div>`;
  }

  function bagCard(c) {
    const items = c.items || [];
    const shown = items.slice(0, 24);
    const cells = shown.map((p) => {
      const title = `${p.slot || ''}${p.tier ? ` · ${p.tier}阶` : ''}`;
      return `<div class="cell" title="${esc(title)}" data-assist-act="piece" data-uid="${esc(p.uid)}">${p.img
        ? `<img src="${esc(p.img)}" alt="">` : esc((p.name || p.slot || '?').slice(0, 1))}</div>`;
    }).join('');
    const more = items.length > 24
      ? `<div class="st-card-ft"><span style="font-size:11px;color:var(--faint)">另有 ${items.length - 24} 件</span></div>` : '';
    return `<div class="st-card">
      <div class="st-card-hd"><b>背包</b><span>${items.length} 件</span></div>
      ${items.length ? `<div class="st-card-grid">${cells}</div>` : '<div class="st-card-list"><span style="color:var(--faint)">空</span></div>'}
      ${more}
      <div class="st-card-ft"><button class="st-card-btn" data-assist-act="gear">去装备栏看</button></div>
    </div>`;
  }

  function quotaCard(c) {
    const rows = c.rows || [];
    const line = rows.filter((r) => r.gap > 0)
      .map((r) => `<div class="row"><span>${esc(r.affix)}</span><span style="color:var(--warn)">缺 ${r.gap}</span></div>`).join('');
    const ok = rows.filter((r) => r.gap > 0).length === 0;
    return `<div class="st-card">
      <div class="st-card-hd"><b>词条配额</b><span>${esc(c.label || '')}</span></div>
      <div class="st-card-list">${ok ? '<div class="row"><span style="color:var(--good)">没有缺口</span><span></span></div>' : line}</div>
      <div class="st-card-ft"><button class="st-card-btn" data-assist-act="read">看完整面板</button></div>
    </div>`;
  }

  function entryCard(c) {
    const title = [c.slot, c.weaponType].filter(Boolean).join('·') || '未定部位';
    return `<div class="st-card">
      <div class="st-card-hd"><b>录入装备</b><span>${esc(title)}</span></div>
      <div class="st-card-list">${(c.hint ? `<span>${esc(c.hint)}</span>` : '<span style="color:var(--faint)">填词条与数值，边录边评</span>')}</div>
      <div class="st-card-ft">
        <button class="st-card-btn" data-primary="1" data-assist-act="entry" data-slot="${esc(c.slot || '')}">填写</button>
      </div>
    </div>`;
  }

  function pieceCard(c) {
    const p = c.piece || {};
    const say = c.say || '';
    return `<div class="st-card">
      <div class="st-card-hd"><b>${esc(p.name || p.slot || '装备')}</b><span>${p.tier ? `<span class="tier" data-tier="${esc(p.tier)}">${esc(p.tier)}阶</span>` : ''}</span></div>
      ${say ? `<div class="st-msg--her" style="font-size:12.5px;line-height:1.7">${say}</div>` : ''}
      <div class="st-card-ft"><button class="st-card-btn" data-assist-act="piece" data-uid="${esc(p.uid || '')}">打开详情</button></div>
    </div>`;
  }

  // ---------- chips ----------
  //
  // **默认没有常驻按钮**（2026-11-02 玩家定稿）。
  // 之前那排「录入装备 / 缺X / 看看背包 / 看配额」其实是把 UI 导航搬进了对话：
  // 背包有录入按钮、移动端有选项卡、配额与组合各有入口 —— 在这里再来一遍全是多余的。
  // chips 只在**她真的需要你回答**时出现（例：问"哪个部位"→ 给部位选项），说完就清。

  const SLOT_CHIPS = ['冠胄', '胸甲', '胫甲', '腕甲', '环', '佩', '武器']
    .map((s) => ({ label: s, act: 'entry', slot: s }));

  /** 设置 / 清空底部短句。不传 = 清空。 */
  function setChips(list) {
    S.chips = Array.isArray(list) ? list.slice(0, 8) : [];
    paintChips(S.chips);
  }

  // ---------- 事实快照 ----------

  function facts() {
    const rows = host.quotaRows?.() || [];
    const gaps = rows.filter((r) => r.gap > 0).map((r) => ({ affix: r.affix, n: r.gap }));
    const info = host.flowInfo?.() || {};
    const st = host.state?.() || {};
    return {
      方案: host.configLabel?.() || '',
      品相: info.品相 || '',
      缺口: gaps,
      已穿: Object.keys(st.equipped || {}).filter((k) => st.equipped[k]).length,
      背包: (host.bagPieces?.() || []).length,
      焦点: st.selected?.kind === 'backpack' ? (host.focusLabel?.() || '') : '',
    };
  }

  // ---------- 模板话术（无模型 / 模型失败时的兜底）----------

  function templateReply(text) {
    const intent = intentOf(text);
    const info = host.flowInfo?.() || {};
    if (intent?.act === 'entry') {
      return { say: '新得的装备？告诉我是哪个部位，我给你开录入。', chips: SLOT_CHIPS };
    }
    if (intent?.act === 'quota') {
      const rows = host.quotaRows?.() || [];
      const gaps = rows.filter((r) => r.gap > 0);
      return { say: gaps.length ? `还差 ${gaps.map((g) => `${g.affix} ${g.gap} 条`).join('、')}。` : '这套的配额齐了，没有缺口。' };
    }
    if (intent?.act === 'composition') {
      return { say: '组合要算一遍才知道，我把结论给你。' };
    }
    if (intent?.act === 'backpack') {
      return { say: '背包在那儿。' };
    }
    return { say: `（还没接入模型）我只能听懂装备、配额、背包、组合这几类话。当前方案是 ${info.方案标签 || info.方案 || '未选'}。` };
  }

  // ---------- 模型接入 ----------

  function kbContext(text) {
    if (!S.kb.length) return '';
    const hits = searchKb(S.kb, text, { limit: 3 });
    return hitsToContext(hits);
  }

  function systemPrompt(text) {
    const kb = kbContext(text);
    return [
      PERSONA,
      '',
      '【可以查的数据】你能调用工具查看：已穿戴装备、背包、词条配额、属性面板、当前方案要求、游戏调律知识库。',
      '玩家问到具体细节（哪一件、缺几条、多少伤害、游戏规则）时，先查再答，不要凭印象说。',
      '',
      '【当前方案摘要】',
      compactFacts(facts()) || '（暂无）',
      kb ? `\n【预检到的资料片段】规则类问题只许照这里说，这里没有的就答“这个我拿不准”：\n${kb}` : '',
      '',
      '【纪律】',
      '1. 只说一到两句，口语，不用 markdown，不列条目。',
      '2. 数字只能来自查到的数据和上面的资料，不许自己算或估。',
      '3. **不许提 DPS，也不许提毕业率**。本工具的伤害计算只用来内部排优先级，数值不可靠，玩家明确要求不要在对话里看到这类数字。'
        + '要说明一套装备好不好，用配额缺口和品相说。',
      '4. 给某件装备的建议时，**先调 evaluate_piece 拿引擎结论**，不要自己判断该穿、该转还是该分。',
      '5. 拿不准就直说拿不准。',
      '6. 不替玩家穿脱或转律，只给建议。',
    ].join('\n');
  }

  // ---------- 工具（模型按需查数据）----------
  //
  // 2026-11-02 玩家定稿：不预塞全套事实、也不做关键词路由 ——
  // 这个工具面向新手，玩家常常说不清自己要什么，得让模型**自己决定先看哪块、看完再看哪块**。
  // 工具只读不改状态；查不到就返回一句人话，让模型自己决定怎么跟玩家交代。

  const TOOLS = [
    { type: 'function', function: {
      name: 'get_loadout',
      description: '查当前方案下已穿戴的八件装备，含每件的词条与品相。玩家提到自己身上的装备、问"我这身怎么样"时用它。',
      parameters: { type: 'object', properties: {} },
    } },
    { type: 'function', function: {
      name: 'get_backpack',
      description: '查背包里没被当前方案穿上的装备。可按部位筛选（冠胄/胸甲/胫甲/腕甲/环/佩/武器）。',
      parameters: { type: 'object', properties: { slot: { type: 'string', description: '部位名，不填则返回全部' } } },
    } },
    { type: 'function', function: {
      name: 'get_quota',
      description: '查当前方案的词条配额逐行：每行要几条、现在装了几条、缺多少、多了多少，以及不在配额内的多余词条。',
      parameters: { type: 'object', properties: {} },
    } },
    { type: 'function', function: {
      name: 'get_panel',
      description: '查当前整体的属性面板数值（攻击、三率、增伤等）、DPS 与毕业率，以及方案设定的三率阈值。',
      parameters: { type: 'object', properties: {} },
    } },
    { type: 'function', function: {
      name: 'get_plan',
      description: '查当前方案自身的要求：词条配额行、三率阈值、套装与心法、版本里写的方案说明。',
      parameters: { type: 'object', properties: {} },
    } },
    { type: 'function', function: {
      name: 'evaluate_piece',
      description: '判断某一件装备在当前方案下该怎么办（穿上 / 转律后穿上 / 放背包 / 分解），结论由计算引擎给出，权威。'
        + '玩家问"这件行不行""该穿吗""要不要转律""值不值得留"时必须先调它，不要自己推理。'
        + '只是笼统问"背包里有没有能用的"时不必逐件调用——先用 get_backpack 看词条，明显补不上缺口的就一句话带过。',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: '装备编号，取自 get_loadout / get_backpack 每行末方括号里的值（如 b17）。这个编号只用来传参，不要念给玩家。' },
      }, required: ['id'] },
    } },
    { type: 'function', function: {
      name: 'get_focus',
      description: '查玩家此刻在详情弹窗里点开的那一件装备（他说"这件呢""这个行不行"时指的就是它），附带引擎结论。',
      parameters: { type: 'object', properties: {} },
    } },
    { type: 'function', function: {
      name: 'search_kb',
      description: '检索游戏调律知识库（机制规则 / 玩家经验）。问到"转律能转几条""承音是什么"这类游戏规则时用它，不要凭记忆答。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '检索关键词，用玩家的原话即可' } }, required: ['query'] },
    } },
  ];

  const TOOL_CN = {
    get_loadout: '已穿戴', get_backpack: '背包', get_quota: '词条配额',
    get_panel: '属性面板', get_plan: '方案要求', search_kb: '知识库', evaluate_piece: '这件装备', get_focus: '你点开的那件',
  };

  let toolCache = new Map(); // 一轮提问内复用，避免模型重复查同一块

  function runTool(name, args) {
    const key = name + ':' + JSON.stringify(args || {});
    if (toolCache.has(key)) return toolCache.get(key);
    let out;
    if (name === 'search_kb') {
      const hits = searchKb(S.kb, args?.query || '', { limit: 4 });
      out = hits.length ? hitsToContext(hits) : '（知识库里没有相关内容）';
    } else {
      out = host.toolData?.(name, args || {}) || `没有这个工具：${name}`;
    }
    toolCache.set(key, out);
    return out;
  }

  const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

  /** 最近几轮原文（工具调用不进历史：每轮都能重查，塞进去只会越来越长） */
  function historyMessages() {
    return S.msgs
      .filter((m) => m.role === 'her' || m.role === 'you')
      .map((m) => ({
        role: m.role === 'you' ? 'user' : 'assistant',
        content: m.role === 'you' ? String(m.text || '') : stripHtml(m.html),
      }))
      .filter((m) => m.content.trim())
      .slice(-8);
  }

  /** 一次请求（流式）：返回本轮文本 + 本轮要调的工具 */
  async function chatStream(messages, onDelta, onReason) {
    const base = String(S.cfg.baseUrl || '').replace(/\/+$/, '');
    // MiniMax 默认把思考混在 content 里，必须显式要分离；顺带给足输出预算
    // （思考模型很容易被默认上限卡住，表现就是"想了很久什么都没说"）
    // 中转站代理也认：baseUrl 可能只是代理域名，模型名里才看得出是谁家的模型
    const isMiniMax = /minimax/i.test(base) || /minimax|minimax-m3|abab/i.test(String(S.cfg.model || ''));
    const body = {
      model: S.cfg.model,
      stream: true,
      temperature: 0.7,
      tools: TOOLS,
      messages,
      ...(isMiniMax ? { reasoning_split: true, max_completion_tokens: 32768 } : {}),
    };
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.cfg.key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('no body');

    let content = '';
    let finishReason = '';
    const calls = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; /* 半包留到下一轮 */ }
        const ch = j.choices?.[0] || {};
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch.delta || {};
        // 思考链字段各家不同：DeepSeek/MiniMax(M3 新版)=reasoning_content，
        // MiniMax 部分接口=thinking_content，其它=reasoning
        const rc = d.reasoning_content ?? d.thinking_content ?? d.reasoning;
        if (rc) onReason?.(rc);
        if (d.content) { content += d.content; onDelta?.(d.content); }
        // tool_calls 是分片来的：按 index 累积 name / arguments
        for (const tc of d.tool_calls || []) {
          const k = tc.index ?? 0;
          if (!calls[k]) calls[k] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[k].id = tc.id;
          if (tc.function?.name) calls[k].function.name += tc.function.name;
          if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments;
        }
      }
    }
    return { content, toolCalls: calls.filter(Boolean), finishReason };
  }

  /**
   * 一轮完整问答：模型可以先查几块数据再开口，最多 4 轮工具往返（防死循环）。
   * @returns {Promise<string>} 最终回答的纯文本
   */
  async function runTurn(userText, cbs = {}) {
    const messages = [
      { role: 'system', content: systemPrompt(userText) },
      ...historyMessages(),
      { role: 'user', content: userText },
    ];
    const MAX_ROUNDS = 6; // 原来 4 轮：思考模型一轮只查一块就很容易撞上限
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      // 快到上限时明确喊停，否则它会一直觉得"还差一块"
      if (round === MAX_ROUNDS - 2) {
        messages.push({
          role: 'system',
          content: '工具已经查得差不多了。这一轮起不要再调用工具，直接用已经查到的信息回答玩家；信息不够就直说哪一块缺。',
        });
      }
      const { content, toolCalls, finishReason } = await chatStream(messages, cbs.onDelta, cbs.onReason);
      if (!toolCalls.length) {
        // 被输出上限掐断：思考模型常见，别装作无事发生
        if (finishReason === 'length') {
          return content
            ? `${content}（后面被长度限制截断了）`
            : '这次我绕得太远，被长度限制掐断了。你问得具体一点——比如只看某个部位——我就能答完。';
        }
        return content;
      }
      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        const name = call.function.name;
        const result = runTool(name, safeJson(call.function.arguments));
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        // 查了哪几块只进「过程」块，不再往消息流里丢一行灰字
        cbs.onTool?.(name);
      }
    }
    return '我连着查了几轮还是没理出头绪。你换个问法试试，比如只问某一部位，或者只问现在差什么。';
  }

  const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, '');

  // ---------- 一轮对话 ----------

  async function say_(text, { echo = true } = {}) {
    if (S.busy) return;
    const t = String(text || '').trim();
    if (!t) return;
    if (echo) you(t);
    setChips([]); // 新一轮开始，上一轮的追问选项作废

    const intent = intentOf(t);

    // 只有「录入」必须走确定路径（要开表单）；配额/背包/组合这些都交给模型 ——
    // 它会自己调工具查，再用人话讲，比代码直接甩一张卡片更像"在对话"
    if (intent?.act === 'entry') {
      if (routeIntent(intent)) return;
    }

    if (!S.cfg.key || !S.cfg.model || !S.cfg.baseUrl) {
      const r = templateReply(t);
      setMood('talk');
      her(esc(r.say));
      setChips(r.chips);
      restMood();
      return;
    }

    S.busy = true;
    setMood('think');   // 等模型 / 思考链：托腮
    updateBusy();
    const node = her('');
    let acc = '';
    try {
      toolCache = new Map(); // 每次提问重新取数（状态可能刚变过）
      node.text = ''; node.think = ''; node.done = false;
      let spoke = false;
      const answer = await runTurn(t, {
        onDelta: (d) => {
          // 第一段正文到手才算"开口"；思考链阶段保持托腮（reasoning 可能很长，
          // 一张脸在一句话里来回切两次非常明显，所以这里只升不降）
          if (!spoke) { spoke = true; setMood('talk'); }
          node.text += d; node.html = esc(node.text); paintNode(node);
        },
        onReason: (d) => { node.think += d; paintNode(node); },
        onTool: (name) => {
          node.think += `${node.think ? '\n' : ''}· 看了${TOOL_CN[name] || name}`;
          paintNode(node);
        },
      });
      node.done = true;
      node.text = answer || node.text || templateReply(t).say;
      node.html = esc(node.text);
      // 「不然我不理你了」是她的招牌台词，说到就是真赌气了，换生气那张
      setMood(/不理你|哼[！!]/.test(node.text) ? 'angry' : 'talk');
    } catch (e) {
      setMood('unsure');
      node.html = `${esc(templateReply(t).say)}<br><span style="color:var(--faint);font-size:11px">（模型没接上：${esc(e.message)}）</span>`;
    } finally {
      S.busy = false;
      updateBusy();
      paintFlow();
      restMood(3200);
    }
  }

  /** 规则意图 → 确定性动作。返回 true 表示已处理，不再交给模型。 */
  /** 唯一还走规则的动作：录入（要开表单，必须确定）。其余交给模型自己查。 */
  function routeIntent(it) {
    if (it.act === 'entry') {
      const slot = it.slot || null;
      card({ kind: 'entry', slot, weaponType: it.weaponType });
      // 只有"她必须问你一句"时才出现短句：这里是唯一真正需要玩家补充信息的场合
      if (!slot) { setMood('unsure'); her('哪个部位？'); setChips(SLOT_CHIPS); restMood(5000); }
      return true;
    }
    return false;
  }

  // ---------- 主动提示（唯一入口）----------
  //
  // 三种情况才开口：录进来的件值得穿 / 背包里出现更优组合 / 这套有可转律补齐的缺口。
  // 去重**按内容不按时间**：同一件同一结论只说一次；结论变了（比如后来凑出更优组合）要重说。

  function notify({ key, sig = '', say, chips: cs, cardData }) {
    if (!key || !say) return;
    if (S.shown[key] === sig) return;
    S.shown[key] = sig;
    writeJson(SHOWN_KEY, S.shown);
    her(esc(say), { notify: true });
    if (cardData) card(cardData);
    setChips(cs);
    S.dot = true;
    paintDot();
  }

  // ---------- 渲染 ----------

  /**
   * 立绘层：**绝对定位的背景层**，垫在所有内容下面（2026-11-03）。
   * 桌面站在栏内右侧、移动端铺满屏幕 —— 两种取景只靠 CSS 区分，DOM 一样。
   * 情绪叠在同一位置，靠 `[data-mood]` 切 opacity 做交叉淡入，不换 src（换 src 会闪白）。
   *
   * 性能（2026-11-03）：四张立绘各 ~90KB，首屏只渲染 idle；其余情绪等页面空闲
   * 或真正切换表情时再补，避免首次打开多拉 ~280KB 的图。
   */
  function ensureMoodImg(m) {
    const el = root?.querySelector('.st-assist-face');
    if (!el || !S.moods.includes(m)) return;
    if (el.querySelector(`img[data-m="${m}"]`)) return;
    const img = document.createElement('img');
    img.className = 'st-assist-portrait';
    img.dataset.m = m;
    img.alt = '';
    img.draggable = false;
    img.src = MOOD_FILE(m);
    el.appendChild(img);
  }

  /** 空闲时补齐其余情绪（切换时才加载会有一瞬间空白，空闲补最稳） */
  function warmMoods() {
    const rest = S.moods.filter((m) => m !== 'idle');
    if (!rest.length) return;
    const run = () => rest.forEach(ensureMoodImg);
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 2500);
  }

  function faceHtml() {
    if (!S.moods.length) return '<div class="st-assist-face" data-empty="1"></div>';
    const first = S.moods.includes(S.mood) ? S.mood : 'idle';
    const img = `<img class="st-assist-portrait" data-m="${first}" src="${MOOD_FILE(first)}" alt="" draggable="false">`;
    return `<div class="st-assist-face" data-mood="${first}">${img}</div>`;
  }

  function setHtml() {
    return `<div class="st-assist-set" ${S.setOpen ? '' : 'hidden'}>
      <label for="as-base">接口地址（到 /v1 为止）</label>
      <input id="as-base" type="text" data-as-cfg="baseUrl" value="${esc(S.cfg.baseUrl)}" placeholder="https://api.deepseek.com/v1" autocomplete="off">
      <label for="as-key">密钥</label>
      <input id="as-key" type="password" data-as-cfg="key" value="${esc(S.cfg.key)}" placeholder="sk-…" autocomplete="off">
      <label for="as-model">模型名</label>
      <input id="as-model" type="text" data-as-cfg="model" value="${esc(S.cfg.model)}" placeholder="deepseek-chat" autocomplete="off">
      <div class="row">
        <span class="tip" data-as-tip></span>
        <button class="st-card-btn" data-assist-act="test">测试</button>
        <button class="st-card-btn" data-primary="1" data-assist-act="saveCfg">保存</button>
      </div>
    </div>`;
  }

  function chipsHtml(list) {
    return (list || []).map((c) => `<button data-assist-act="${esc(c.act)}"${c.text ? ` data-text="${esc(c.text)}"` : ''}${c.slot ? ` data-slot="${esc(c.slot)}"` : ''}>${esc(c.label)}</button>`).join('');
  }

  function shell() {
    root.innerHTML = `<section class="st-assist-panel">
      ${faceHtml()}
      <div class="st-assist-head">
        <span class="st-assist-name">周红线</span>
        <div class="st-assist-tools">
          <button data-assist-act="settings" title="接入设置">设置</button>
          <button class="st-assist-collapse" data-assist-act="collapse" title="收起">收起</button>
        </div>
      </div>
      ${setHtml()}
      <div class="st-assist-flow"></div>
      <div class="st-assist-chips">${chipsHtml(S.chips)}</div>
      <form class="st-assist-input" data-as-form>
        <input type="text" data-as-input placeholder="对她说…" autocomplete="off">
        <button type="submit">说</button>
      </form>
    </section>`;
    paintFlow();
    paintDot();
    warmMoods();
  }

  /** 只换立绘层（清单到了之后补渲染其余情绪），不动消息流与输入框 */
  function paintFace() {
    const host = root?.querySelector('.st-assist-panel');
    const old = host?.querySelector('.st-assist-face');
    if (!old) return;
    old.outerHTML = faceHtml();
    setMood(S.mood);
    warmMoods();
  }

  function paintChips(list) {
    const box = root.querySelector('.st-assist-chips');
    if (box) box.innerHTML = chipsHtml(list);
  }

  function paintDot() {
    const setDot = (el) => { if (el && typeof el.setAttribute === 'function') el.setAttribute('data-dot', S.dot ? '1' : '0'); };
    setDot(dock && dock.querySelector('[data-mview-btn="assist"]'));
    setDot(document.querySelector('#st-assist-toggle'));
  }

  /** 开合助手：桌面切三栏，移动端切视图（移动端的"收起"= 让位给装备栏，不是留白屏） */
  function setOpen(on) {
    const narrow = window.innerWidth < 1200;
    document.querySelector('.studio')?.classList.toggle('assist-on', !!on);
    try { localStorage.setItem('yysls-assist-collapsed', on ? '' : '1'); } catch { /* 隐私模式 */ }
    const sel = on ? 'assist' : (narrow ? 'gear' : null);
    if (sel) document.body.setAttribute('data-mview', sel);
    dock?.querySelectorAll('[data-mview-btn]').forEach((b) => {
      b.setAttribute('aria-selected', b.dataset.mviewBtn === sel ? 'true' : 'false');
    });
    if (on) S.dot = false;
    paintDot();
  }

  function updateBusy() {
    const btn = root.querySelector('.st-assist-input button');
    if (btn) { btn.disabled = S.busy; btn.textContent = S.busy ? '…' : '说'; }
    const inp = root.querySelector('[data-as-input]');
    if (inp) inp.disabled = S.busy;
  }

  // ---------- 知识库 ----------

  async function loadKb() {
    if (S.kbTried) return;
    S.kbTried = true;
    try {
      const idx = await (await fetch('知识库/index.json')).json();
      const files = Array.isArray(idx) ? idx : idx.files || [];
      const docs = await Promise.all(files.map(async (f) => {
        const res = await fetch(`知识库/${f}`);
        if (!res.ok) return null;
        return parseKb(await res.text(), f);
      }));
      S.kb = docs.filter(Boolean);
    } catch { S.kb = []; }
  }

  // ---------- 事件 ----------

  function bind() {
    if (root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-assist-act]');
      if (!t) return;
      const act = t.dataset.assistAct;
      if (act === 'settings') { S.setOpen = !S.setOpen; const n = root.querySelector('.st-assist-set'); if (n) n.hidden = !S.setOpen; return; }
      if (act === 'collapse') { host.setAssist?.(false); return; }
      if (act === 'saveCfg') { saveCfg(); return; }
      if (act === 'test') { testCfg(); return; }
      // 点「录入装备」直接在聊天流里留一句再开表单：流是操作日志，不能有这个动作的空白
      if (act === 'entry') {
        setChips([]); // 部位已选，追问选项立刻收掉
        const slot = t.dataset.slot || null;
        you(slot ? `录入${slot}` : '录入装备');
        host.openEntry?.({ slot });
        return;
      }
      if (act === 'piece') { host.openPiece?.(t.dataset.uid); return; }
      if (act === 'bag') { you('看看背包'); const items = host.bagPieces?.() || []; card({ kind: 'bag', items }); return; }
      if (act === 'gear') { host.openGear?.(); return; }
      if (act === 'read') { host.openRead?.(); return; }
      if (act === 'quota') { you('看配额'); card({ kind: 'quota', rows: host.quotaRows?.() || [], label: (host.flowInfo?.() || {}).方案 }); return; }
      if (act === 'composition') { host.openComposition?.(); return; }
      if (act === 'ask') { say_(t.dataset.text || t.textContent); return; }
      if (act === 'dot') { S.dot = false; paintDot(); return; }
    });

    root.addEventListener('submit', (e) => {
      if (!e.target.matches('[data-as-form]')) return;
      e.preventDefault();
      const inp = e.target.querySelector('[data-as-input]');
      const v = inp?.value || '';
      if (inp) inp.value = '';
      S.dot = false; paintDot();
      say_(v);
    });

    // 过程块的展开状态记进消息对象，重绘后保持
    root.addEventListener('toggle', (e) => {
      const d = e.target.closest?.('.st-think');
      if (!d) return;
      const mid = Number(d.closest('[data-mid]')?.dataset.mid);
      const msg = S.msgs.find((m) => m.id === mid);
      if (msg) msg.open = d.open;
    }, true);

    root.addEventListener('input', (e) => {
      const k = e.target.dataset?.asCfg;
      if (k) S.cfg[k] = e.target.value;
    });
  }

  function saveCfg() {
    S.cfg.baseUrl = String(S.cfg.baseUrl || '').trim();
    S.cfg.key = String(S.cfg.key || '').trim();
    S.cfg.model = String(S.cfg.model || '').trim();
    writeJson(CFG_KEY, S.cfg);
    const tip = root.querySelector('[data-as-tip]');
    if (tip) { tip.textContent = '已保存'; tip.style.color = 'var(--good)'; }
  }

  async function testCfg() {
    const tip = root.querySelector('[data-as-tip]');
    const set = (t, c) => { if (tip) { tip.textContent = t; tip.style.color = c; } };
    const base = String(S.cfg.baseUrl || '').replace(/\/+$/, '');
    if (!base || !S.cfg.key || !S.cfg.model) { set('三项都要填', 'var(--warn)'); return; }
    set('连接中…', 'var(--faint)');
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.cfg.key}` },
        body: JSON.stringify({ model: S.cfg.model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (res.ok) { set('通了', 'var(--good)'); return; }
      const body = await res.text().catch(() => '');
      if (res.status === 401) set('密钥不对（401）', 'var(--bad)');
      else if (res.status === 404) set('地址或模型名不对（404）', 'var(--bad)');
      else set(`失败 ${res.status}${body ? `：${body.slice(0, 40)}` : ''}`, 'var(--bad)');
    } catch (e) {
      // fetch 抛 TypeError 基本就是 CORS 或断网，分开说，否则玩家只会看到一串红字
      set(/Failed to fetch|NetworkError/i.test(e.message) ? '连不上（多半是中转站没开 CORS）' : e.message, 'var(--bad)');
    }
  }

  // ---------- 启动 ----------

  function boot() {
    shell();
    bind();
    bindDock();
    bindToggle();
    // 知识库：7 篇 md 共 8 个请求，首屏用不到 → 空闲时再拉（对话里真正检索时才需要）
    const startKb = () => loadKb();
    if ('requestIdleCallback' in window) requestIdleCallback(startKb, { timeout: 5000 });
    else setTimeout(startKb, 3000);
    // 清单异步：读到之后只重画立绘层，整页不等它（先出 idle 一张，其余到了再补）
    loadPortraits().then(() => { if (S.moods.length > 1) paintFace(); }).catch(() => {});
    if (!S.msgs.length) {
      her(esc(`老大老大！红线在这儿呢。要录装备直接说哪个部位，想问配额、背包、组合也行——红线都记下了。`));
    }
  }

  /** 桌面端收起后的圆形入口 */
  function bindToggle() {
    const t = document.querySelector('#st-assist-toggle');
    if (!t || t.dataset.bound === '1') return;
    t.dataset.bound = '1';
    t.addEventListener('click', () => setOpen(true));
  }

  function bindDock() {
    if (!dock || dock.dataset.bound === '1') return;
    dock.dataset.bound = '1';
    dock.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mview-btn]');
      if (!b) return;
      const v = b.dataset.mviewBtn;
      document.body.setAttribute('data-mview', v);
      // 切视图回顶 + 展开顶栏（studio 那边的 syncDock 也会做，这里独立一份：assist.js 不 import studio）
      const scroller = document.querySelector('.studio');
      if (scroller) scroller.scrollTop = 0;
      document.body.removeAttribute('data-bar');
      [...dock.querySelectorAll('button')].forEach((x) => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
      if (v === 'assist') { S.dot = false; paintDot(); }
    });
  }

  boot();

  return {
    /** studio 每次 render 后调用：刷新 chips 与事实（不动消息流） */
    refresh() { paintDot(); },
    /** 主动提示唯一入口 */
    notify,
    her, you, card,
    /** 打开/收起助手 */
    setOpen,
    get open() { return document.querySelector('.studio')?.classList.contains('assist-on') || false; },
    _state: S,
  };
}
