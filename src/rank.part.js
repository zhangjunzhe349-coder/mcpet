/* =========================================================
   实时排行榜
   进入页面自动拉一次，也可以手点「刷新」。
   数据源按顺序尝试（都不需要 Token，且都开了 CORS）：
     ① raw.githubusercontent.com → RANKING.md 原文
     ② cdn.jsdelivr.net          → 同一文件的镜像
     ③ api.github.com            → contents 接口（返回 base64）
   先显缓存再后台刷新；三条路都失败时退回「构建时内置的快照」，
   所以离线状态下这个面板依然有内容，不会开天窗。
   ========================================================= */
const RANK_CACHE_KEY = 'mcpet.rank.v1';
const RANK_TTL = 30 * 60 * 1000;
const RANK_TOP_N = 30;
const RANK_TIMEOUT = 5000;   // 单个数据源的超时上限，避免网络挂住时面板一直空转
let RANK_FETCHING = false;
let RANK_SHOW_ALL = false;

const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function decodeB64Utf8(b64){
  const bin = atob(String(b64).replace(/\s+/g,''));
  const buf = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) buf[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(buf);
}

/* 解析 RANKING.md 的表格 —— 不依赖网络，所以可以单独断言 */
function parseRanking(md){
  const rows = [];
  String(md || '').split('\n').forEach(line => {
    if(line.indexOf('|') < 0) return;
    const c = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(x => x.trim());
    if(c.length < 4) return;
    if(!/^\d+$/.test(c[0]) || !/^\d+$/.test(c[3])) return;
    rows.push({ rank:+c[0], name:c[1], stars:+c[3] });
  });
  const upd = (String(md || '').match(/更新时间：\s*(.+)/) || [])[1] || '';
  return { rows, updated: upd.trim() };
}
function repoOf(name){
  return RANK_INDEX.repos[String(name || '').toLowerCase()] || '';
}
function readRankCache(){
  try {
    const o = JSON.parse(localStorage.getItem(RANK_CACHE_KEY) || 'null');
    if(o && o.rows && o.rows.length && (Date.now() - (o.at || 0)) < RANK_TTL) return o;
  } catch(e){}
  return null;
}
function writeRankCache(d){
  try { localStorage.setItem(RANK_CACHE_KEY, JSON.stringify({ rows:d.rows, updated:d.updated, at:Date.now() })); } catch(e){}
}

/* 每个源都带超时：网络被墙/挂起时不能让面板无限转圈 */
async function fetchWithTimeout(url, opts, ms){
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms || RANK_TIMEOUT) : null;
  try {
    return await fetch(url, Object.assign({ cache:'no-store' }, opts || {}, ctl ? { signal:ctl.signal } : {}));
  } finally {
    if(timer) clearTimeout(timer);
  }
}

async function fetchRanking(){
  const urls = [
    RANK_INDEX.sourceUrl,
    'https://cdn.jsdelivr.net/gh/M-China/mcd-developer-innovation-challenge@main/RANKING.md'
  ];
  for(const u of urls){
    if(!u) continue;
    try {
      const r = await fetchWithTimeout(u + (u.indexOf('?') < 0 ? '?t=' + Date.now() : ''));
      if(!r.ok) continue;
      const p = parseRanking(await r.text());
      if(p.rows.length) return Object.assign(p, { via:(u.indexOf('jsdelivr') > 0 ? 'jsdelivr' : 'raw') });
    } catch(e){}
  }
  try {
    const r = await fetchWithTimeout(RANK_INDEX.repoIndexUrl + '?t=' + Date.now(),
      { headers:{ 'Accept':'application/vnd.github+json' } });
    if(r.ok){
      const j = await r.json();
      const p = parseRanking(decodeB64Utf8(j.content || ''));
      if(p.rows.length) return Object.assign(p, { via:'api.github.com' });
    }
  } catch(e){}
  return null;
}

function rankDot(cls, state, meta){
  $('rkDot').className = 'rkdot' + (cls ? ' ' + cls : '');
  if(state != null) $('rkState').textContent = state;
  if(meta != null) $('rkMeta').textContent = meta;
}

function renderRankMine(rows){
  const mine = String(RANK_INDEX.myRepo || '').toLowerCase();
  const my = rows.filter(r => repoOf(r.name).toLowerCase() === mine)[0];
  const gate = rows.length ? rows[rows.length - 1].stars : 0;
  const box = (a,b,c,d) => `<div class="statgrid">
      <div><span>当前名次</span><b>${a}</b></div>
      <div><span>星数</span><b id="rkMyStars">${b}</b></div>
      <div><span>进榜门槛</span><b>${c} ★</b></div>
      <div><span>${d[0]}</span><b id="rkGap">${d[1]}</b></div>
    </div>`;
  const foot = `<div class="rklinks">`
    + `<a href="https://github.com/${esc(RANK_INDEX.myRepo)}" target="_blank" rel="noopener">`
    + `我的仓库 <code>${esc(RANK_INDEX.myRepo)}</code> ↗</a>`
    + `<span>官方规则：按 Star 数排名，0 ★ 不进榜</span></div>`;
  $('rkMine').innerHTML = (my
    ? box('第 ' + my.rank + ' 名', my.stars + ' ★', gate, ['状态', '已进榜'])
    : box('<span style="color:#B32216">未进榜</span>', '…', gate, ['还差', '…'])) + foot;
  if(!my) loadMyStars(gate);
}

async function loadMyStars(gate){
  const set = (s, gap) => {
    const a = $('rkMyStars'), b = $('rkGap');
    if(a) a.textContent = s;
    if(b) b.textContent = gap;
  };
  try {
    const r = await fetchWithTimeout('https://api.github.com/repos/' + RANK_INDEX.myRepo,
      { headers:{ 'Accept':'application/vnd.github+json' } });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const s = (await r.json()).stargazers_count | 0;
    set(s + ' ★', s >= gate ? '已达标' : '还差 ' + (gate - s) + ' ★');
  } catch(e){
    set('—', '以仓库为准');
  }
}

function renderRankRows(rows){
  const cut = RANK_SHOW_ALL ? rows.length : Math.min(RANK_TOP_N, rows.length);
  const mine = String(RANK_INDEX.myRepo || '').toLowerCase();
  $('rkList').innerHTML = rows.slice(0, cut).map(r => {
    const full = repoOf(r.name);
    const me = full && full.toLowerCase() === mine;
    const inner = `<span class="n">${r.rank}</span>`
      + `<span class="nm">${esc(r.name)}${me ? '<i>我</i>' : ''}</span>`
      + `<span class="st">${r.stars}<em>★</em></span>`;
    return full
      ? `<a class="rkrow${me ? ' me' : ''}" href="https://github.com/${full}" target="_blank" rel="noopener" title="打开 ${full}">${inner}</a>`
      : `<div class="rkrow nolink" title="这一项没匹配到仓库地址">${inner}</div>`;
  }).join('');

  const more = rows.length > cut
    ? `<button class="rkmore" id="rkMore">展开全部（还有 ${rows.length - cut} 项）</button>`
    : (RANK_SHOW_ALL && rows.length > RANK_TOP_N ? `<button class="rkmore" id="rkMore">收起</button>` : '');
  $('rkList').insertAdjacentHTML('beforeend', more);
  const btn = $('rkMore');
  if(btn) btn.onclick = () => { RANK_SHOW_ALL = !RANK_SHOW_ALL; renderRankRows(rows); };
  renderRankMine(rows);
}

function showRank(data, kind, suffix){
  RANK_SHOW_ALL = false;
  renderRankRows(data.rows);
  const live = kind === 'live';
  rankDot(live ? 'live' : 'cache', live ? '实时' : '缓存',
    `更新于 ${data.updated || '—'} · ${data.rows.length} 个在榜项目${suffix ? ' ' + suffix : ''}`);
}

async function refreshRank(force){
  if(RANK_FETCHING) return;
  RANK_FETCHING = true;
  const cached = readRankCache();
  const snap = (RANK_INDEX.snapshot && RANK_INDEX.snapshot.length)
    ? { rows:RANK_INDEX.snapshot, updated:RANK_INDEX.updated } : null;

  /* 先给内容、再后台刷新 —— 无论网络多慢，面板都不会开天窗 */
  if(cached && !force) showRank(cached, 'cache', '（先显示缓存，正在更新）');
  else if(snap) showRank(snap, 'cache', '（先显示内置快照，正在更新）');
  else rankDot('', '正在获取…', '排行榜加载中…');

  const live = await fetchRanking();
  RANK_FETCHING = false;

  if(live){
    writeRankCache(live);
    showRank(live, 'live');
    return;
  }
  if(cached){ showRank(cached, 'cache', '（离线，显示上次缓存）'); return; }
  if(snap){ showRank(snap, 'cache', '（离线，显示内置快照）'); return; }
  rankDot('dead', '取不到数据', '网络不可用 —— 稍后点「刷新」重试');
  $('rkList').innerHTML = '<div class="empty">暂时取不到榜单数据，点右上角「刷新」重试。</div>';
}

function initRank(){
  $('rkRefresh').onclick = () => { toast('正在刷新榜单…'); refreshRank(true); };
  $('rkSrc').href = RANK_INDEX.sourceUrl && RANK_INDEX.sourceUrl.indexOf('githubusercontent') > 0
    ? 'https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/RANKING.md'
    : $('rkSrc').href;
  $('disc3').innerHTML = '<b>数据出处：</b>榜单实时读取比赛仓库的 <code>RANKING.md</code>'
    + `（每小时更新一次，官方维护），点任一行跳到对应 GitHub 仓库。`
    + `仓库地址来自比赛报名的 Issue 清单，共 ${Object.keys(RANK_INDEX.repos).length} 个映射；`
    + '没匹配到的项目只显示名称、不给链接（不猜、不编造）。'
    + `<br><b>离线兜底：</b>取不到网络时展示构建时内置的快照（${RANK_INDEX.updated || '—'}）。`
    + '本项目仓库：<code>' + RANK_INDEX.myRepo + '</code>';
  refreshRank(false);
}
