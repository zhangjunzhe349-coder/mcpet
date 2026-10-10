#!/usr/bin/env node
/**
 * 无头浏览器校验：麦麦宠物 index.html
 *
 * 目的：静态检查全绿 ≠ 页面能跑、能点。本脚本真起浏览器，
 *       抓运行时异常、断言渲染产物、真点一遍交互、出截图。
 *
 * 用法：NODE_PATH=<node workspace>/node_modules node tools/browser-check.js
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

    /* --- 等待「应用真的就绪」：轮询判据（不是睡固定秒数） --- */
    let boot = null;
    for (let i = 0; i < 60; i++) {
      boot = await cdp.ev(`(() => ({
        ready: document.readyState,
        items: document.querySelectorAll('#grid .item').length,
        cats: document.querySelectorAll('#cats .cat').length,
        hasData: typeof NUTRITION !== 'undefined' && NUTRITION.count > 0,
        count: (typeof NUTRITION !== 'undefined' && NUTRITION.count) || 0
      }))()`);
      if (boot && !boot.__err && boot.items > 0 && boot.cats > 0) break;
      await sleep(250);
    }
    if (boot && boot.__err) console.error('就绪探测异常:', boot.__err);

    console.log('\n【1】静态结构与数据装载');
    check('应用启动完成（readyState）', boot && boot.ready === 'complete', boot && boot.ready);
    check('MCP 营养数据已内联并解析', !!(boot && boot.hasData), boot && ('count=' + boot.count));

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
      let ink = 0, yellow = 0;
      for (let i=0;i<d.length;i+=4){
        if (d[i+3] <= 20) continue;
        ink++;
        if (d[i]>200 && d[i+1]>150 && d[i+1]<230 && d[i+2]<120) yellow++;
      }
      return {
        ink, yellow,
        grid: document.querySelectorAll('#grid .item').length,
        cats: document.querySelectorAll('#cats .cat').length,
        scoreText: document.getElementById('topNum').textContent,
        mcpCards: document.querySelectorAll('#mcpCards .mcpcard').length,
        petBox: (()=>{const r=c.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];})()
      };
    })()`);
    check('宠物 canvas 已绘制（非透明像素 > 3000）', render && render.ink > 3000, render && ('ink=' + render.ink));
    check('宠物主色（麦当劳黄）已上色', render && render.yellow > 1500, render && ('yellow=' + render.yellow));
    check('宠物画布尺寸 > 0', render && render.petBox[0] > 0 && render.petBox[1] > 0, render && render.petBox.join('x'));
    check('餐品网格首屏 12 项', render && render.grid === 12, render && ('grid=' + render.grid));
    check('分类 chips 6 个', render && render.cats === 6, render && ('cats=' + render.cats));
    check('MCP 功能卡 4 张', render && render.mcpCards === 4, render && ('cards=' + render.mcpCards));

    console.log('\n【4】交互：点击一份餐品喂食');
    const before = await cdp.ev(`document.getElementById('topNum').textContent`);
    await cdp.ev(`document.querySelector('#grid .item').click()`);
    await sleep(900);
    const after = await cdp.ev(`(() => ({
      topNum: document.getElementById('topNum').textContent,
      dot: document.getElementById('topDot').className,
      petState: document.getElementById('petState').textContent,
      bubble: document.getElementById('bubble').textContent,
      kv: document.querySelectorAll('#kv div').length,
      brows: document.querySelectorAll('#bars .brow').length,
      radarPolys: document.querySelectorAll('#radar svg polygon').length,
      radarPaths: document.querySelectorAll('#radar svg circle').length,
      prows: document.querySelectorAll('#parts .prow').length,
      ringOffset: document.getElementById('ringArc').getAttribute('stroke-dashoffset'),
      tags: document.querySelectorAll('#petTags .tag').length,
      advice: document.getElementById('advice').textContent.slice(0, 40)
    }))()`);
    check('健康分从占位变为数字', before === '--' && /^\d+$/.test(after.topNum), `${before} → ${after.topNum}`);
    check('宠物状态标签已更新', after.petState && after.petState !== '待喂食', after.petState);
    check('台词气泡已更新', after.bubble && !after.bubble.includes('想喂我吃点什么'), after.bubble);
    check('营养卡 6 项数值', after.kv === 6, 'kv=' + after.kv);
    check('逐项对照 6 行', after.brows === 6, 'brows=' + after.brows);
    /* 4 层网格 + 1 条参考线多边形 + 1 个数据多边形 = 6 */
    check('雷达图已绘制（6 个多边形 + 6 个数据点）', after.radarPolys >= 6 && after.radarPaths >= 6,
      `polygons=${after.radarPolys} circles=${after.radarPaths}`);
    check('健康分分项 5 行', after.prows === 5, 'prows=' + after.prows);
    check('分数环有进度（dashoffset 已改变）', parseFloat(after.ringOffset) < 282.7, 'offset=' + after.ringOffset);
    check('营养标签已渲染', after.tags >= 1, 'tags=' + after.tags);
    check('建议文案已生成', after.advice.includes('麦麦建议'), after.advice);

    console.log('\n【5】交互：搜索 / 分类 / 换餐');
    await cdp.ev(`(() => { const s = document.getElementById('search');
      s.value = '巨无霸'; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sleep(200);
    const searched = await cdp.ev(`(() => ({
      n: document.querySelectorAll('#grid .item').length,
      first: (document.querySelector('#grid .item .nm')||{}).textContent || ''
    }))()`);
    check('搜索「巨无霸」命中', searched.n >= 1 && searched.first.includes('巨无霸'), `${searched.n} 项 / ${searched.first}`);

    const catBefore = await cdp.ev(`(document.querySelector('#grid .item .nm')||{}).textContent||''`);
    await cdp.ev(`(() => { const s = document.getElementById('search');
      s.value = ''; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sleep(200);
    await cdp.ev(`document.querySelectorAll('#cats .cat')[4].click()`);
    await sleep(250);
    const catAfter = await cdp.ev(`(() => ({
      n: document.querySelectorAll('#grid .item').length,
      first: (document.querySelector('#grid .item .nm')||{}).textContent||'',
      onCat: (document.querySelector('#cats .cat.on')||{}).textContent||''
    }))()`);
    check('切到「甜品」分类生效（高亮 + 列表换血）',
      catAfter.onCat === '甜品' && !!catAfter.first && catAfter.first !== catBefore,
      `on=${catAfter.onCat} 首项「${catBefore}」→「${catAfter.first}」 n=${catAfter.n}`);

    await cdp.ev(`(() => { document.querySelectorAll('#cats .cat')[0].click(); })()`);
    await sleep(150);
    const secondFeed = await cdp.ev(`(() => {
      const items = document.querySelectorAll('#grid .item');
      items[5].click(); return items[5].dataset.n; })()`);
    await sleep(900);
    const after2 = await cdp.ev(`document.getElementById('topNum').textContent`);
    check('换一份餐品后健康分重算', /^\d+$/.test(after2), `${secondFeed} → ${after2} 分`);

    console.log('\n【6】交互：Tab 切换');
    for (const [idx, pid] of [[1,'nutrition'],[2,'score'],[3,'more']]) {
      await cdp.ev(`document.querySelectorAll('.tab')[${idx}].click()`);
      await sleep(180);
      const vis = await cdp.ev(`(() => {
        const p = document.getElementById('panel-${pid}');
        return { on: p.classList.contains('on'), h: Math.round(p.getBoundingClientRect().height) };
      })()`);
      check(`Tab→${pid} 面板可见`, vis.on && vis.h > 0, `h=${vis.h}`);
    }

    console.log('\n【7】交互：饮食报告解析');
    const orderJson = JSON.stringify({
      data: { orders: [{ orderId: 'TEST', products: [{ productName: '巨无霸' }, { productName: '中薯条' }, { productName: '可口可乐中杯' }] }] }
    });
    await cdp.ev(`(() => { const t = document.getElementById('orderIn');
      t.value = ${JSON.stringify(orderJson)}; document.getElementById('analyzeBtn').click(); })()`);
    await sleep(400);
    const rep = await cdp.ev(`(() => ({
      shown: document.getElementById('report').style.display,
      items: document.querySelectorAll('#report .ritem').length,
      text: document.getElementById('report').textContent.replace(/\\s+/g,' ').slice(0, 110)
    }))()`);
    check('饮食报告已生成', rep.shown === 'block' && rep.items >= 1, `items=${rep.items}`);
    check('报告含平均健康分', /平均健康分/.test(rep.text), rep.text.slice(0, 70));

    console.log('\n【8】手机端适配（390×844）');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(400);
    await cdp.ev(`document.querySelectorAll('.tab')[0].click()`);
    await sleep(200);
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
        searchFont: parseFloat(getComputedStyle(document.getElementById('search')).fontSize)
      };
    })()`);
    check('无横向溢出', m.overflowX <= 1, 'overflowX=' + m.overflowX);
    check('底部 Tab 为 fixed', m.tabsFixed === true, String(m.tabsFixed));
    check('底部 Tab 贴在视口底边', m.appBottomGap >= 44 && m.appBottomGap <= 90, 'gap=' + m.appBottomGap);
    check('触摸目标 ≥44px', m.tabH >= 44 && m.itemH >= 44, `tab=${m.tabH} item=${m.itemH}`);
    check('搜索框字号 ≥16px（防 iOS 缩放）', m.searchFont >= 16, m.searchFont + 'px');

    console.log('\n【9】截图');
    await cdp.ev(`window.scrollTo(0,0)`);
    await sleep(300);
    const shotMobile = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
    });
    const outDir = path.join(ROOT, 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `screenshot-mobile${SUFFIX}.png`), Buffer.from(shotMobile.result.data, 'base64'));
    check('手机全页截图已保存', true, `assets/screenshot-mobile${SUFFIX}.png`);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const shotDesk = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `screenshot-desktop${SUFFIX}.png`), Buffer.from(shotDesk.result.data, 'base64'));
    check('桌面截图已保存', true, `assets/screenshot-desktop${SUFFIX}.png`);

    await cdp.send('Emulation.clearDeviceMetricsOverride');

    /* 收尾再抓一次异常：交互过程中可能才暴露 */
    console.log('\n【10】交互后异常复查');
    check('交互全过程无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | '));

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
