#!/usr/bin/env node
/**
 * 无头浏览器校验：麦麦宠物 index.html
 *
 * 目的：静态检查全绿 ≠ 页面能跑、能点。本脚本真起浏览器，
 *       抓运行时异常、断言渲染产物、真点一遍交互、验证养成数据持久化、出截图。
 *
 * 用法：NODE_PATH=<node workspace>/node_modules node tools/browser-check.js
 *       TARGET_URL=https://... node tools/browser-check.js   # 校验线上部署
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
/* 设置 TARGET_URL 则直接校验线上地址（不起本地服务），用于验证 Pages 部署结果 */
const TARGET = process.env.TARGET_URL || '';
const SUFFIX = TARGET ? '-live' : '';
/* Edge 不读 HTTP_PROXY 环境变量，线上模式必须显式指定代理 */
const BROWSER_PROXY = TARGET ? (process.env.BROWSER_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '') : '';
const PORT = 8123;
const CDP_PORT = 9333;
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
};

const results = [];
const problems = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  if (!pass) problems.push(`${name} — ${detail}`);
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}

/* ---------------- 内置静态服务器（同进程保活，不依赖外部进程） ---------------- */
function serve() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); res.end('404'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise(r => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- CDP ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.exceptions = []; this.consoleErrors = []; this.logErrors = [];
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id); resolve(msg);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push((d.exception && d.exception.description) || d.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.logErrors.push(msg.params.entry.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    if (r.error) return { __err: r.error.message };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && /^http/.test(t.url || ''));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
        return new CDP(ws);
      }
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('连不上 CDP');
}

/* 等待应用就绪（轮询判据，不睡固定秒数） */
async function waitReady(cdp, timeoutLoops = 60) {
  for (let i = 0; i < timeoutLoops; i++) {
    const boot = await cdp.ev(`(() => ({
      ready: document.readyState,
      items: document.querySelectorAll('#grid .item').length,
      cats: document.querySelectorAll('#cats .cat').length,
      budget: document.querySelectorAll('#budRows .budrow').length,
      ach: document.querySelectorAll('#achGrid .achitem').length,
      hasData: typeof NUTRITION !== 'undefined' && NUTRITION.count > 0,
      count: (typeof NUTRITION !== 'undefined' && NUTRITION.count) || 0
    }))()`);
    if (boot && !boot.__err && boot.items > 0 && boot.cats > 0 && boot.budget > 0 && boot.ach > 0) return boot;
    await sleep(250);
  }
  return null;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  if (!EDGE) { console.error('找不到 Edge/Chrome 可执行文件'); process.exit(1); }

  let srv = null;
  if (!TARGET) {
    srv = await serve();
    console.log(`[静态服务] http://127.0.0.1:${PORT}/ 已就绪`);
  } else {
    console.log(`[线上模式] 目标地址：${TARGET}`);
  }
  const OPEN_URL = TARGET || `http://127.0.0.1:${PORT}/index.html`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpet-cdp-'));
  const args = [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--window-size=1200,1000', '--force-device-scale-factor=1',
  ];
  if (BROWSER_PROXY) args.push(`--proxy-server=${BROWSER_PROXY}`);
  args.push(OPEN_URL);
  const browser = spawn(EDGE, args, { stdio: 'ignore' });

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    const boot = await waitReady(cdp);
    if (!boot) console.error('就绪探测未通过（超时）');

    /* 每次校验从干净存档开始，保证断言可预期 */
    await cdp.ev(`(() => { try{ localStorage.removeItem('mcpet.v2'); }catch(e){} return 1; })()`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(600);
    const boot2 = await waitReady(cdp);

    console.log('\n【1】静态结构与数据装载');
    check('应用启动完成（readyState）', !!(boot2 && boot2.ready === 'complete'), boot2 && boot2.ready);
    check('MCP 营养数据已内联并解析', !!(boot2 && boot2.hasData), boot2 && ('count=' + boot2.count));
    check('营养数据为 158 条全量表', !!(boot2 && boot2.count === 158), boot2 && ('count=' + boot2.count));

    console.log('\n【2】运行时异常');
    check('无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | '));
    check('无 console.error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | '));
    const realLogErr = cdp.logErrors.filter(t => !/favicon/i.test(t));
    check('无资源加载失败', realLogErr.length === 0, realLogErr.slice(0, 3).join(' | '));

    console.log('\n【3】渲染产物');
    const render = await cdp.ev(`(() => {
      const c = document.getElementById('pet');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0,0,c.width,c.height).data;
      let ink = 0, yellow = 0, minX = 999, maxX = -1;
      for (let y=0;y<c.height;y++) for (let x=0;x<c.width;x++){
        const i = (y*c.width+x)*4;
        if (d[i+3] <= 20) continue;
        ink++;
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (d[i]>200 && d[i+1]>150 && d[i+1]<230 && d[i+2]<120) yellow++;
      }
      return {
        ink, yellow, petWidth: maxX-minX+1,
        grid: document.querySelectorAll('#grid .item').length,
        cats: document.querySelectorAll('#cats .cat').length,
        tabs: document.querySelectorAll('.tab').length,
        mcpCards: document.querySelectorAll('#mcpCards .mcpcard').length,
        budget: document.querySelectorAll('#budRows .budrow').length,
        ach: document.querySelectorAll('#achGrid .achitem').length,
        petBox: (()=>{const r=c.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];})()
      };
    })()`);
    check('宠物 canvas 已绘制（非透明像素 > 3000）', render && render.ink > 3000, render && ('ink=' + render.ink));
    check('宠物主色（麦当劳黄）已上色', render && render.yellow > 1500, render && ('yellow=' + render.yellow));
    check('宠物画布尺寸 > 0', render && render.petBox[0] > 0 && render.petBox[1] > 0, render && render.petBox.join('x'));
    check('宠物为参数化体型（横向占比合理）', render && render.petWidth >= 90 && render.petWidth <= 200, render && ('w=' + render.petWidth + 'px'));
    check('餐品网格首屏 12 项', render && render.grid === 12, render && ('grid=' + render.grid));
    check('分类 chips 6 个', render && render.cats === 6, render && ('cats=' + render.cats));
    check('底部 Tab 5 个', render && render.tabs === 5, render && ('tabs=' + render.tabs));
    check('MCP 功能卡 4 张', render && render.mcpCards === 4, render && ('cards=' + render.mcpCards));
    check('每日预算 6 项', render && render.budget === 6, render && ('budget=' + render.budget));
    check('成就墙 12 项', render && render.ach === 12, render && ('ach=' + render.ach));

    console.log('\n【4】交互：把餐品加进「这一餐」');
    const before = await cdp.ev(`document.getElementById('topNum').textContent`);
    await cdp.ev(`document.querySelector('#grid .item').click()`);
    await sleep(250);
    const basket1 = await cdp.ev(`(() => ({
      count: document.getElementById('basketCount').textContent,
      chips: document.querySelectorAll('#basket .bchip').length,
      picked: document.querySelectorAll('#grid .item.picked').length,
      disabled: document.getElementById('feedBtn').disabled,
      bigNum: document.getElementById('bigNum').textContent,
      kv: document.querySelectorAll('#kv div').length,
      advisor: document.getElementById('advisor').textContent.slice(0,30)
    }))()`);
    check('点餐品进入「这一餐」', basket1.count === '1 项' && basket1.chips === 1, `count=${basket1.count} chips=${basket1.chips}`);
    check('已选餐品在网格中高亮', basket1.picked >= 1, 'picked=' + basket1.picked);
    check('「喂给麦麦」按钮已可用', basket1.disabled === false, 'disabled=' + basket1.disabled);
    check('选中即出营养分析（不等喂食）', /^\d+$/.test(basket1.bigNum) && basket1.kv === 6, `bigNum=${basket1.bigNum} kv=${basket1.kv}`);
    check('搭配顾问已给出建议', basket1.advisor.length > 4, basket1.advisor);

    console.log('\n【5】交互：再加一项 → 喂给麦麦');
    await cdp.ev(`(() => { const it = document.querySelectorAll('#grid .item')[3]; it.click(); })()`);
    await sleep(250);
    const basket2 = await cdp.ev(`document.querySelectorAll('#basket .bchip').length`);
    check('第二项成功加入', basket2 === 2, 'chips=' + basket2);

    await cdp.ev(`document.getElementById('feedBtn').click()`);
    await sleep(950);
    const after = await cdp.ev(`(() => ({
      topNum: document.getElementById('topNum').textContent,
      dot: document.getElementById('topDot').className,
      petState: document.getElementById('petState').textContent,
      bubble: document.getElementById('bubble').textContent,
      chips: document.querySelectorAll('#basket .bchip').length,
      prows: document.querySelectorAll('#parts .prow').length,
      ringOffset: document.getElementById('ringArc').getAttribute('stroke-dashoffset'),
      tags: document.querySelectorAll('#petTags .tag').length,
      advice: document.getElementById('advice').textContent.slice(0, 40),
      radarPolys: document.querySelectorAll('#radar svg polygon').length,
      radarDots: document.querySelectorAll('#radar svg circle').length,
      brows: document.querySelectorAll('#bars .brow').length,
      mini: document.querySelectorAll('#miniChips .mchip').length,
      gotAch: document.querySelectorAll('#achGrid .achitem.got').length,
      todayMeals: document.getElementById('todayMeals').textContent,
      todayKcal: document.getElementById('todayKcal').textContent,
      petStats: document.querySelectorAll('#petStats div').length,
      lvlNum: document.getElementById('lvlNum').textContent,
      stored: (()=>{ try{ return JSON.parse(localStorage.getItem('mcpet.v2')||'{}').meals?.length ?? -1; }catch(e){ return -2; } })()
    }))()`);
    check('喂食后健康分更新为数字', /^\d+$/.test(after.topNum), `${before} → ${after.topNum}`);
    check('宠物状态标签已更新', after.petState && after.petState !== '待喂食', after.petState);
    check('台词气泡已更新', after.bubble && !after.bubble.includes('想喂我吃点什么'), after.bubble);
    check('喂食后篮子已清空', after.chips === 0, 'chips=' + after.chips);
    check('喂食后仍展示这一餐的分析', after.prows === 5 && /^\d+$/.test(after.topNum), 'prows=' + after.prows);
    check('分数环有进度（dashoffset 已改变）', parseFloat(after.ringOffset) < 282.7, 'offset=' + after.ringOffset);
    check('营养标签已渲染', after.tags >= 1, 'tags=' + after.tags);
    check('麦麦建议已生成', after.advice.includes('麦麦建议'), after.advice);
    check('雷达图已绘制（≥6 多边形 + ≥6 数据点）', after.radarPolys >= 6 && after.radarDots >= 6, `polygons=${after.radarPolys} dots=${after.radarDots}`);
    check('逐项对照 6 行', after.brows === 6, 'brows=' + after.brows);
    check('顶部状态条 3 枚', after.mini === 3, 'mini=' + after.mini);

    console.log('\n【6】养成系统：账本 / 预算 / 成就');
    check('今日餐数已记录为 2', after.todayMeals === '2', 'todayMeals=' + after.todayMeals);
    check('今日热量 > 0', Number(after.todayKcal) > 0, 'todayKcal=' + after.todayKcal);
    check('成长统计 6 项', after.petStats === 6, 'petStats=' + after.petStats);
    check('等级从 Lv.1 起步', after.lvlNum === '1', 'lvl=' + after.lvlNum);
    check('喂食即解锁首个成就', after.gotAch >= 1, 'got=' + after.gotAch);
    check('养成数据已写入 localStorage', after.stored === 2, 'meals=' + after.stored);

    console.log('\n【7】重新加载 → 养成数据持久化');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(700);
    await waitReady(cdp);
    const persisted = await cdp.ev(`(() => ({
      stored: (()=>{ try{ return JSON.parse(localStorage.getItem('mcpet.v2')||'{}').meals?.length ?? -1; }catch(e){ return -2; } })(),
      todayKcal: document.getElementById('todayKcal').textContent,
      stat1: document.querySelector('#petStats div b').textContent,
      mini: document.querySelectorAll('#miniChips .mchip').length
    }))()`);
    check('刷新后养成账本仍在（2 餐）', persisted.stored === 2, 'meals=' + persisted.stored);
    check('刷新后今日热量已恢复', Number(persisted.todayKcal) > 0, 'todayKcal=' + persisted.todayKcal);
    check('刷新后成长面板显示累计喂食', /^2/.test(persisted.stat1), 'stat=' + persisted.stat1);
    check('刷新后顶部状态条已恢复', persisted.mini === 3, 'mini=' + persisted.mini);

    console.log('\n【8】累计养成：体态随饮食变化（连喂 6 顿高热量）');
    const petWBefore = await cdp.ev(`(() => {
      const c = document.getElementById('pet'), d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let minX=999,maxX=-1;
      for (let y=0;y<c.height;y++) for (let x=0;x<c.width;x++){
        if (d[(y*c.width+x)*4+3] <= 20) continue;
        if (x<minX) minX=x; if (x>maxX) maxX=x;
      }
      return maxX-minX+1;
    })()`);
    await cdp.ev(`(() => {
      const top = NUTRITION.items.filter(i=>i.energyKcal>0).sort((a,b)=>b.energyKcal-a.energyKcal).slice(0,6);
      const zero = NUTRITION.items.find(i=>i.energyKcal===0);
      const lowNa = NUTRITION.items.find(i=>i.productName==='小薯条');
      BASKET = top.concat([zero, lowNa].filter(Boolean));
      renderBasket(); renderGrid(); renderAnalysis();
      document.getElementById('feedBtn').click();
    })()`);
    await sleep(1000);
    const petWAfter = await cdp.ev(`(() => {
      const c = document.getElementById('pet'), d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let minX=999,maxX=-1;
      for (let y=0;y<c.height;y++) for (let x=0;x<c.width;x++){
        if (d[(y*c.width+x)*4+3] <= 20) continue;
        if (x<minX) minX=x; if (x>maxX) maxX=x;
      }
      return { w: maxX-minX+1, meals: S.meals.length, girth: Number(anim.target.toFixed(2)),
        achGot: S.ach.length, wallGot: document.querySelectorAll('#achGrid .achitem.got').length,
        lvl: document.getElementById('lvlNum').textContent,
        form: (document.querySelectorAll('#petStats div b')[5]||{}).textContent||'' };
    })()`);
    check('连喂高热量后宠物明显变宽（累计体态生效）', petWAfter.w >= petWBefore + 8,
      `${petWBefore}px → ${petWAfter.w}px (girth=${petWAfter.girth})`);
    check('累计餐数已累加到 10', petWAfter.meals === 10, 'meals=' + petWAfter.meals);
    check('体态被判定为圆润/微胖', /圆润|微胖/.test(petWAfter.form), 'form=' + petWAfter.form);
    check('多成就已解锁（首喂/老饕/聪明替换/控钠）', petWAfter.achGot >= 4, 'ach=' + petWAfter.achGot);
    check('成就墙与账本一致', petWAfter.wallGot === petWAfter.achGot, `wall=${petWAfter.wallGot} book=${petWAfter.achGot}`);

    console.log('\n【9】交互：搜索 / 分类');
    await cdp.ev(`(() => { const s = document.getElementById('search');
      s.value = '巨无霸'; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sleep(220);
    const searched = await cdp.ev(`(() => ({
      n: document.querySelectorAll('#grid .item').length,
      first: (document.querySelector('#grid .item .nm')||{}).textContent || ''
    }))()`);
    check('搜索「巨无霸」命中', searched.n >= 1 && searched.first.includes('巨无霸'), `${searched.n} 项 / ${searched.first}`);

    const catBefore = await cdp.ev(`(document.querySelector('#grid .item .nm')||{}).textContent||''`);
    await cdp.ev(`(() => { const s = document.getElementById('search');
      s.value = ''; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sleep(220);
    await cdp.ev(`document.querySelectorAll('#cats .cat')[4].click()`);
    await sleep(260);
    const catAfter = await cdp.ev(`(() => ({
      n: document.querySelectorAll('#grid .item').length,
      first: (document.querySelector('#grid .item .nm')||{}).textContent||'',
      onCat: (document.querySelector('#cats .cat.on')||{}).textContent||''
    }))()`);
    check('切到「甜品」分类生效（高亮 + 列表换血）',
      catAfter.onCat === '甜品' && !!catAfter.first && catAfter.first !== catBefore,
      `on=${catAfter.onCat} 首项「${catBefore}」→「${catAfter.first}」 n=${catAfter.n}`);
    await cdp.ev(`document.querySelectorAll('#cats .cat')[0].click()`);
    await sleep(150);

    console.log('\n【10】交互：Tab 切换（今日 / 营养 / 成长）');
    for (const [idx, pid] of [[1,'today'],[2,'nutrition'],[3,'pet']]) {
      await cdp.ev(`document.querySelectorAll('.tab')[${idx}].click()`);
      await sleep(220);
      const vis = await cdp.ev(`(() => {
        const p = document.getElementById('panel-${pid}');
        return { on: p.classList.contains('on'), h: Math.round(p.getBoundingClientRect().height) };
      })()`);
      check(`Tab→${pid} 面板可见`, vis.on && vis.h > 0, `h=${vis.h}`);
    }
    const petPanel = await cdp.ev(`(() => ({
      stats: document.querySelectorAll('#petStats div').length,
      ach: document.querySelectorAll('#achGrid .achitem.got').length,
      card: document.querySelectorAll('#cardStat div').length,
      name: document.getElementById('nameInput').value
    }))()`);
    check('成长面板：统计/成就/养成卡预览齐备',
      petPanel.stats === 6 && petPanel.card === 6 && petPanel.name === '麦麦',
      `stats=${petPanel.stats} card=${petPanel.card} name=${petPanel.name}`);

    console.log('\n【11】交互：改名生效');
    await cdp.ev(`(() => { const i = document.getElementById('nameInput');
      i.value = '小薯条'; document.getElementById('renameBtn').click(); })()`);
    await sleep(250);
    const renamed = await cdp.ev(`document.getElementById('petNameLbl').textContent`);
    check('改名同步到宠物名', renamed === '小薯条', 'name=' + renamed);

    console.log('\n【12】交互：饮食报告解析');
    const orderJson = JSON.stringify({
      data: { orders: [{ orderId: 'TEST', products: [{ productName: '巨无霸' }, { productName: '中薯条' }, { productName: '可口可乐中杯' }] }] }
    });
    await cdp.ev(`document.querySelectorAll('.tab')[4].click()`);
    await sleep(200);
    await cdp.ev(`(() => { const t = document.getElementById('orderIn');
      t.value = ${JSON.stringify(orderJson)}; document.getElementById('analyzeBtn').click(); })()`);
    await sleep(420);
    const rep = await cdp.ev(`(() => ({
      shown: document.getElementById('report').style.display,
      items: document.querySelectorAll('#report .ritem').length,
      text: document.getElementById('report').textContent.replace(/\\s+/g,' ').slice(0, 110)
    }))()`);
    check('饮食报告已生成', rep.shown === 'block' && rep.items >= 1, `items=${rep.items}`);
    check('报告含平均健康分', /平均健康分/.test(rep.text), rep.text.slice(0, 70));

    console.log('\n【13】手机端适配（390×844）');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(450);
    await cdp.ev(`document.querySelectorAll('.tab')[0].click()`);
    await sleep(220);
    const m = await cdp.ev(`(() => {
      const de = document.documentElement;
      const tabs = document.querySelector('.tabs');
      const tab = document.querySelector('.tab');
      const kb = document.querySelector('#grid .item');
      return {
        overflowX: de.scrollWidth - de.clientWidth,
        tabsFixed: getComputedStyle(tabs).position === 'fixed',
        tabH: Math.round(tab.getBoundingClientRect().height),
        itemH: Math.round(kb.getBoundingClientRect().height),
        appBottomGap: Math.round(de.clientHeight - document.querySelector('.tabs').getBoundingClientRect().top),
        searchFont: parseFloat(getComputedStyle(document.getElementById('search')).fontSize),
        feedBtnH: Math.round(document.getElementById('feedBtn').getBoundingClientRect().height)
      };
    })()`);
    check('无横向溢出', m.overflowX <= 1, 'overflowX=' + m.overflowX);
    check('底部 Tab 为 fixed', m.tabsFixed === true, String(m.tabsFixed));
    check('底部 Tab 贴在视口底边', m.appBottomGap >= 44 && m.appBottomGap <= 90, 'gap=' + m.appBottomGap);
    check('触摸目标 ≥44px', m.tabH >= 44 && m.itemH >= 44, `tab=${m.tabH} item=${m.itemH}`);
    check('喂食主按钮 ≥44px', m.feedBtnH >= 44, 'h=' + m.feedBtnH);
    check('搜索框字号 ≥16px（防 iOS 缩放）', m.searchFont >= 16, m.searchFont + 'px');

    /* =========================================================
       【14】桌面端适配（≥1024px 双栏工作台）
       手机端布局与这里无关，各自独立断言，互不牵连。
       ========================================================= */
    console.log('\n【14】桌面端适配（1280×900 / 1440×900）');
    for (const [vw, vh] of [[1280, 900], [1440, 900]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      await cdp.ev(`window.scrollTo(0,0)`);
      await cdp.ev(`document.querySelectorAll('.tab')[0].click()`);
      await sleep(250);

      const d = await cdp.ev(`(() => {
        const R = el => { const b = el.getBoundingClientRect(); return {l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom),w:Math.round(b.width),h:Math.round(b.height)}; };
        const app = document.querySelector('.app');
        const tabs = document.querySelector('.tabs');
        const stage = document.querySelector('.stage');
        const main = document.querySelector('main');
        const pet = document.getElementById('pet');
        const de = document.documentElement;
        return {
          app: R(app), tabs: R(tabs), stage: R(stage), main: R(main),
          tabPos: getComputedStyle(tabs).position,
          overflowX: de.scrollWidth - de.clientWidth,
          petW: Math.round(pet.getBoundingClientRect().width),
          petShown: pet.getBoundingClientRect().width > 40 && pet.getBoundingClientRect().height > 40,
          gridCols: getComputedStyle(document.getElementById('grid')).gridTemplateColumns.trim().split(/\\s+/).length,
          feedCards: [...document.querySelectorAll('#panel-feed .card')].map(R)
        };
      })()`);
      const tag = vw + 'px';
      check(`[${tag}] 容器已铺开（不再是 480 窄条）`, d.app.w >= 1100, 'app=' + d.app.w + 'px');
      check(`[${tag}] 导航从底部移到了顶部`, d.tabPos !== 'fixed' && d.tabs.t <= 6, `pos=${d.tabPos} top=${d.tabs.t}`);
      check(`[${tag}] 导航与容器等宽对齐`, Math.abs(d.tabs.w - d.app.w) <= 2, `${d.tabs.w} vs ${d.app.w}`);
      check(`[${tag}] 双栏并排：左栏宠物 / 右栏数据`, d.stage.r <= d.main.l + 2 && Math.abs(d.stage.t - d.main.t) < 60,
        `stage右${d.stage.r} main左${d.main.l}`);
      check(`[${tag}] 左栏宽度符合设计（400px）`, d.stage.w >= 360 && d.stage.w <= 440, 'w=' + d.stage.w);
      check(`[${tag}] 挑餐品网格升到 3 列`, d.gridCols === 3, d.gridCols + ' 列');
      check(`[${tag}] 喂麦麦面板两张卡占满整行`, d.feedCards.length === 2 && d.feedCards[0].w > 600, 'card0=' + (d.feedCards[0] || {}).w);
      check(`[${tag}] 宠物舞台可见且尺寸正常`, d.petShown && d.petW >= 170, 'petW=' + d.petW);
      check(`[${tag}] 无横向溢出`, d.overflowX <= 1, 'overflowX=' + d.overflowX);
      check(`[${tag}] 全程无异常`, cdp.exceptions.length === 0 && cdp.consoleErrors.length === 0, '');
    }

    /* 双栏的核心价值：滚右栏数据时，左栏宠物一直在 */
    await cdp.ev(`window.scrollTo(0, 620)`);
    await sleep(350);
    const sticky = await cdp.ev(`Math.round(document.querySelector('.stage').getBoundingClientRect().top)`);
    check('左栏宠物滚动时常驻（sticky 生效）', sticky >= 50 && sticky <= 130, 'stage.top=' + sticky);

    /* 面板内卡片确实铺成两列（营养面板是最典型的双列内容） */
    await cdp.ev(`window.scrollTo(0,0); document.querySelectorAll('.tab')[2].click()`);
    await sleep(350);
    const twoCol = await cdp.ev(`(() => {
      const cards = [...document.querySelectorAll('#panel-nutrition .card')].map(c => {
        const b = c.getBoundingClientRect();
        return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width) };
      });
      const rowMap = {};
      cards.forEach(c => { const k = Math.round(c.t / 10); (rowMap[k] = rowMap[k] || []).push(c.l); });
      const rows = Object.values(rowMap).filter(a => a.length >= 2);
      return { n: cards.length, pairs: rows.length, firstRowLefts: rows[0] || [], cardW: cards[0] ? cards[0].w : 0,
               overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    check('营养面板卡片自动铺成两列', twoCol.pairs >= 1 && twoCol.cardW > 300 && twoCol.cardW < 620,
      `${twoCol.n} 张卡 · ${twoCol.pairs} 行并排 · 卡宽 ${twoCol.cardW}`);
    check('桌面端营养面板无横向溢出', twoCol.overflowX <= 1, 'overflowX=' + twoCol.overflowX);

    /* 桌面端交互可用性：点餐品 → 进篮子 → 喂食 */
    await cdp.ev(`document.querySelectorAll('.tab')[0].click()`);
    await sleep(250);
    const deskFeed = await cdp.ev(`(() => {
      const it = document.querySelector('#grid .item');
      it.click();
      return { picked: document.getElementById('basketCount').textContent,
               btnH: Math.round(document.getElementById('feedBtn').getBoundingClientRect().height) };
    })()`);
    check('桌面端点选餐品可加入篮子', /\d/.test(deskFeed.picked) && !/^0/.test(deskFeed.picked), deskFeed.picked);
    check('桌面端喂食按钮尺寸正常', deskFeed.btnH >= 40, 'h=' + deskFeed.btnH);

    /* 桌面专属：键盘快捷键 1~5 切面板 */
    await cdp.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))`);
    await sleep(350);
    const keyNav = await cdp.ev(`(() => ({
      tab: [...document.querySelectorAll('.tab')].findIndex(t => t.classList.contains('on')),
      panel: [...document.querySelectorAll('.panel')].findIndex(p => p.classList.contains('on')),
      badge: getComputedStyle(document.querySelectorAll('.tab')[2], '::after').content
    }))()`);
    check('桌面快捷键切面板（按 3 → 营养）', keyNav.tab === 2 && keyNav.panel === 2, `tab=${keyNav.tab} panel=${keyNav.panel}`);
    check('导航按钮带快捷键角标', /3/.test(keyNav.badge), keyNav.badge);

    /* 打字时不能抢键 */
    await cdp.ev(`(() => {
      document.querySelectorAll('.tab')[0].click();
      const s = document.getElementById('search'); if (s) s.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
    })()`);
    await sleep(300);
    const guard = await cdp.ev(`[...document.querySelectorAll('.tab')].findIndex(t => t.classList.contains('on'))`);
    check('在输入框打字时不误切面板', guard === 0, 'tab=' + guard);

    /* 恢复手机视口，交给后面的截图章节 */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(300);
    await cdp.ev(`document.querySelectorAll('.tab')[0].click(); window.scrollTo(0,0)`);
    await sleep(250);

    console.log('\n【15】截图');
    await cdp.ev(`window.scrollTo(0,0)`);
    await sleep(350);
    const shotMobile = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
    });
    const outDir = path.join(ROOT, 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `screenshot-mobile${SUFFIX}.png`), Buffer.from(shotMobile.result.data, 'base64'));
    check('手机全页截图已保存', true, `assets/screenshot-mobile${SUFFIX}.png`);

    /* 成长面板单独来一张（展示养成卡区） */
    await cdp.ev(`document.querySelectorAll('.tab')[3].click()`);
    await sleep(350);
    const shotGrow = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(outDir, `screenshot-growth${SUFFIX}.png`), Buffer.from(shotGrow.result.data, 'base64'));
    check('成长面板截图已保存', true, `assets/screenshot-growth${SUFFIX}.png`);

    /* 今日营养面板 */
    await cdp.ev(`document.querySelectorAll('.tab')[1].click()`);
    await sleep(350);
    const shotToday = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(outDir, `screenshot-today${SUFFIX}.png`), Buffer.from(shotToday.result.data, 'base64'));
    check('今日营养面板截图已保存', true, `assets/screenshot-today${SUFFIX}.png`);

    /* 桌面端：默认「喂麦麦」双栏工作台（全页截，方便直接当 README 配图） */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(450);
    await cdp.ev(`window.scrollTo(0,0); document.querySelectorAll('.tab')[0].click()`);
    await sleep(300);
    await cdp.ev(`(() => { const it = document.querySelector('#grid .item'); if (it) it.click(); document.getElementById('feedBtn').click(); })()`);
    await sleep(1000);
    await cdp.ev(`window.scrollTo(0,0)`);
    await sleep(300);
    const shotDesk = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `screenshot-desktop${SUFFIX}.png`), Buffer.from(shotDesk.result.data, 'base64'));
    check('桌面截图已保存', true, `assets/screenshot-desktop${SUFFIX}.png`);

    /* 桌面端：营养面板（双列排布最能体现桌面版的信息架构） */
    await cdp.ev(`window.scrollTo(0,0); document.querySelectorAll('.tab')[2].click()`);
    await sleep(400);
    const shotDeskNu = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(outDir, `screenshot-desktop-nutrition${SUFFIX}.png`), Buffer.from(shotDeskNu.result.data, 'base64'));
    check('桌面营养面板截图已保存', true, `assets/screenshot-desktop-nutrition${SUFFIX}.png`);

    /* 桌面端：成长面板 */
    await cdp.ev(`window.scrollTo(0,0); document.querySelectorAll('.tab')[3].click()`);
    await sleep(400);
    const shotDeskPet = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(outDir, `screenshot-desktop-growth${SUFFIX}.png`), Buffer.from(shotDeskPet.result.data, 'base64'));
    check('桌面成长面板截图已保存', true, `assets/screenshot-desktop-growth${SUFFIX}.png`);

    await cdp.send('Emulation.clearDeviceMetricsOverride');

    console.log('\n【16】交互后异常复查');
    check('交互全过程无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | '));
    check('交互全过程无 console.error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | '));

  } catch (e) {
    console.error('\n[fatal]', e && e.stack || e);
    problems.push('脚本致命错误: ' + (e && e.message));
  } finally {
    try { browser.kill(); } catch {}
    try { if (srv) srv.close(); } catch {}
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\n${'='.repeat(58)}`);
  console.log(`结果：${passed}/${results.length} 项通过`);
  if (problems.length) {
    console.log('\n未通过项：');
    problems.forEach(p => console.log('  ✗ ' + p));
  } else {
    console.log('全部通过 ✓');
  }
  console.log('='.repeat(58));
  process.exit(problems.length ? 1 : 0);
})();
