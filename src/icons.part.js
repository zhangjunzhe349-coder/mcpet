/* =========================================================
   食物视觉系统（v2）
   1. 名称驱动：先把名字解析成「品类 / 规格（小中大迷你）/ 块数 / 口味」，
      再按规格作图 —— 小/中/大薯条盒的高度与条数不同，4块/5块鸡块数量不同，
      中杯/大杯杯身高度不同，香芋派/菠萝派内馅颜色不同。
   2. 官方实拍优先：能对上官方菜单白底图的餐品直接用实拍图（PHOTOS），
      对不上的用手绘图标兜底；图片加载失败会自动回落，绝不会出现破图。
   3. 立体感来自 body 顶部集中定义的渐变（gBun / gFry / gBox …），
      图标里不再各自 <defs>，避免重复 id 互相覆盖。
   ========================================================= */
const ART_SIZE = { '迷你':{ k:'xs', s:0.58 }, '小':{ k:'s', s:0.76 }, '中':{ k:'m', s:0.94 }, '大':{ k:'l', s:1.14 } };

function sizeTok(n){
  if(/迷你/.test(n)) return '迷你';
  let m = n.match(/(小|中|大)薯条/); if(m) return m[1];
  m = n.match(/(小|中|大)杯/); if(m) return m[1];
  return '';
}
function countTok(n){
  const m = n.match(/(\d+)\s*块/);
  if(m) return Math.min(+m[1], 12);
  if(/绝代双翅/.test(n)) return 2;
  return 0;
}
function kindTok(n){
  if(/纯悦/.test(n)) return 'bottle';
  if(/纯牛奶/.test(n)) return 'milkbox';
  if(/苹果汁|橙橙|多汁柠柠/.test(n)) return 'juicebox';
  if(/粥/.test(n)) return 'congee';
  if(/苹果片/.test(n)) return 'apple';
  if(/油条/.test(n)) return 'youtiao';
  if(/薯饼/.test(n)) return 'hashbrown';
  if(/玉米杯/.test(n)) return 'corncup';
  if(/雪冰/.test(n)) return 'snowice';
  if(/奶冻|爆珠|拉明顿/.test(n)) return 'cake';
  if(/阿芙佳朵/.test(n)) return 'affogato';
  if(/圆筒/.test(n)) return 'cone';
  if(/新地|麦旋风/.test(n)) return 'sundae';
  if(/派/.test(n)) return 'pie';
  if(/薯条|扭扭薯/.test(n)) return 'fries';
  if(/鸡块|趣鸡球|鸡球|乐鸡\s*\d/.test(n)) return 'nuggets';
  if(/鸡翅|V翅|双翅/.test(n)) return 'wings';
  if(/鸡排/.test(n)) return 'chickenfilet';
  if(/脆汁鸡|琵琶腿|里脊/.test(n)) return 'drumstick';
  if(/营养卷|多笋卷|叠叠卷/.test(n)) return 'wrap';
  if(/香肠/.test(n)) return 'sausage';
  if(/锡兰红茶|伯爵红茶|川宁/.test(n)) return 'teacup';
  if(/可乐|雪碧|怡泉|柠檬红茶|黄金橙橙|橙/.test(n)) return 'coldcup';
  if(/奶铁|美式|玛奇朵|卡布奇诺|浓缩|鲜萃咖啡/.test(n)) return 'coffeecup';
  if(/燕麦奶|抹茶牛奶|黑巧|豆浆|热牛奶|冰牛奶|热朱古力/.test(n)) return 'milkdrink';
  if(/麦满分|炒双蛋堡/.test(n)) return 'muffin';
  return 'burger';
}
function specOf(name){
  const n = String(name || '');
  const t = sizeTok(n);
  return {
    name: n,
    kind: kindTok(n),
    size: t ? ART_SIZE[t].k : 'm',
    scale: t ? ART_SIZE[t].s : 1,
    count: countTok(n)
  };
}

/* ---------- 画零件用的小工具 ---------- */
const V = 40;                                          // 统一 40×40 画布
const svgWrap = inner => `<svg viewBox="0 0 ${V} ${V}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
const ell = (cx,cy,rx,ry,fill,extra='') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${extra}/>`;
const rr  = (x,y,w,h,r,fill,extra='') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${extra}/>`;
/* 上宽下窄的杯子/盒子轮廓 */
const cupPath = (x0,x1,yt,yb,inset=2.4) =>
  `M${x0} ${yt} L${x1} ${yt} L${x1-inset} ${yb} Q${x1-inset-.4} ${yb+1.4} ${x1-inset-1.6} ${yb+1.4} `+
  `L${x0+inset+1.6} ${yb+1.4} Q${x0+inset+.4} ${yb+1.4} ${x0+inset} ${yb} Z`;

/* ---------- 各品类的画法 ---------- */
const ART = {};

/* 薯条：盒子高度与薯条根数随规格变化（迷你 4 · 小 5 · 中 6 · 大 7） */
ART.fries = v => {
  const conf = { xs:[22.5,4], s:[20.5,5], m:[18.5,6], l:[15.5,7] }[v.size] || [18.5,6];
  const [ty, cnt] = conf, bx = 8.6, bw = 22.8, by = 35.6;
  let out = '';
  for(let i=0;i<cnt;i++){
    const x = bx + 2.6 + i * (bw - 5.2) / Math.max(1, cnt - 1) - 1.5;
    const h = ty - 3.4 + (i % 2 ? 1.6 : 0);
    out += rr(x, Math.max(4.2, ty - h), 3, h + 4.2, 1.5, 'url(#gFry)', ' stroke="#D9971A" stroke-width=".7"');
  }
  out += `<path d="${cupPath(bx,bx+bw,ty,by)}" fill="url(#gBox)" stroke="#8E1106" stroke-width="1" stroke-linejoin="round"/>`;
  out += `<path d="M${bx+1.2} ${ty+4.6} h${bw-2.4}" stroke="#FFE9A8" stroke-width="1.9" fill="none"/>`;
  if(/脆脆|扭扭/.test(v.name)) out += `<circle cx="13" cy="${ty-6}" r="1.1" fill="#FFF3D2"/><circle cx="27" cy="${ty-4}" r="1.1" fill="#FFF3D2"/>`;
  return svgWrap(out);
};

/* 冷饮杯：杯身高度随规格变化，液体颜色随口味变化 */
ART.coldcup = v => {
  const yt = { xs:20.5, s:18.6, m:17, l:14.6 }[v.size] || 17;
  const x0 = 10.4, x1 = 29.6, by = 32.4;
  const zero = /无糖|零度/.test(v.name);
  const liquid = zero ? '#2B2B2B' : /雪碧/.test(v.name) ? '#8FD3E8'
    : /橙|柠|怡泉/.test(v.name) ? 'url(#gTea)' : 'url(#gCola)';
  let out = `<path d="${cupPath(x0,x1,yt,by)}" fill="url(#gCup)" stroke="#CFC3B0" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="${cupPath(x0+1.3,x1-1.3,yt+3.2,by-1.2,.9)}" fill="${liquid}" opacity=".92"/>`;
  if(zero) out += rr(x0+4.4, yt+6.6, 11.4, 7.4, 1.6, '#F2F2F2', ' stroke="#C9C9C9" stroke-width=".7"');
  out += rr(9.6, yt-5.2, 20.8, 5.4, 2.3, 'url(#gLid)');
  out += rr(22.2, 2.6, 3.1, 11.2, 1.5, '#DA291C', ' transform="rotate(13 23.7 8)"');
  if(/柠檬|柠萌/.test(v.name)) out += `<circle cx="31" cy="${yt+7}" r="3.4" fill="#F7E27A" stroke="#DCBE3E" stroke-width="1"/><path d="M31 ${yt+3.9} v6.2" stroke="#DCBE3E" stroke-width=".9"/>`;
  return svgWrap(out);
};

/* 咖啡杯：热的→白杯+深盖+杯套；冰的→透明杯+冰块 */
ART.coffeecup = v => {
  const hot = /^热|热美式|热奶铁|热焦糖|热浓缩/.test(v.name) || !/冰/.test(v.name);
  const yt = { xs:20, s:18, m:16.4, l:14.2 }[v.size] || 16.4;
  const x0 = 11, x1 = 29, by = 32;
  let out = '';
  if(hot){
    out += `<path d="${cupPath(x0,x1,yt,by)}" fill="url(#gCup)" stroke="#CFC3B0" stroke-width="1.1" stroke-linejoin="round"/>`;
    out += rr(x0+.4, yt+4.4, x1-x0-.8, 8.6, 1.4, 'url(#gTea)');
    out += rr(x0-1, yt-5.6, x1-x0+2, 5.8, 2.4, '#4B3222');
    out += rr(x0-1.6, yt-9, x1-x0+3.2, 3.8, 1.6, '#6B4A2F');
  } else {
    out += `<path d="${cupPath(x0+1,x1-1,yt,by)}" fill="#EAF3F9" stroke="#B9CDD9" stroke-width="1.1" stroke-linejoin="round" opacity=".95"/>`;
    out += `<path d="${cupPath(x0+2.2,x1-2.2,yt+4.6,by-1.6,.9)}" fill="url(#gTea)" opacity=".9"/>`;
    out += `<path d="M${x0-.6} ${yt} c0-4.6 3.6-7.6 8.6-7.6 h${x1-x0-16} c5 0 8.6 3 8.6 7.6 z" fill="#F2FAFE" stroke="#B9CDD9" stroke-width="1.1" stroke-linejoin="round"/>`;
    out += rr(17.8, yt+5.4, 3.4, 3.4, .8, '#FFFFFF', ' opacity=".8"') + rr(22.4, yt+8.4, 3, 3, .7, '#FFFFFF', ' opacity=".7"');
  }
  return svgWrap(out);
};

/* 牛奶类：豆浆 / 燕麦奶 / 抹茶牛奶 / 黑巧 —— 靠杯中色带区分口味 */
ART.milkdrink = v => {
  const liquid = /抹茶/.test(v.name) ? 'url(#gMatcha)' : /黑巧|朱古力/.test(v.name) ? 'url(#gChoco)'
    : /燕麦/.test(v.name) ? 'url(#gOat)' : '#F6EEDC';
  const yt = { xs:20, s:18, m:16.4, l:14.2 }[v.size] || 16.4;
  const x0 = 11, x1 = 29, by = 31.8;
  let out = `<path d="${cupPath(x0,x1,yt,by)}" fill="url(#gCup)" stroke="#CFC3B0" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="${cupPath(x0+1.4,x1-1.4,yt+3,by-1.1,.9)}" fill="${liquid}" opacity=".95"/>`;
  out += rr(x0-.6, yt-5, x1-x0+1.2, 5.2, 2.2, '#8A7B6B');
  if(/冰/.test(v.name)) out += rr(17.4, yt+5.2, 3.6, 3.6, .8, '#FFFFFF', ' opacity=".75"') + rr(22.6, yt+8, 3.2, 3.2, .7, '#FFFFFF', ' opacity=".6"');
  if(/抹茶/.test(v.name)) out += `<path d="M${x0+5.6} ${yt+7.4} q3.4 -2.6 6.8 0" stroke="#3F6B1F" stroke-width="1" fill="none" opacity=".5"/>`;
  return svgWrap(out);
};

/* 雪冰：带半球盖、分层色 */
ART.snowice = v => {
  const liquid = /黑巧/.test(v.name) ? 'url(#gChoco)' : /抹茶/.test(v.name) ? 'url(#gMatcha)' : 'url(#gOat)';
  const yt = { xs:20, s:18, m:16.4, l:14.2 }[v.size] || 16.4;
  const x0 = 10.6, x1 = 29.4, by = 32.6;
  let out = `<path d="${cupPath(x0,x1,yt,by)}" fill="url(#gCup)" stroke="#CFC3B0" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="${cupPath(x0+1.3,x1-1.3,yt+4.4,by-1.2,.9)}" fill="${liquid}" opacity=".93"/>`;
  out += `<path d="M${x0-.8} ${yt} c0-4.4 4.4-7.4 10.2-7.4 s10.2 3 10.2 7.4 z" fill="#F4FAFE" stroke="#C3D5E0" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += rr(19.4, 3.6, 2.6, 4.4, 1.3, '#7FC3E8');
  return svgWrap(out);
};

/* 茶杯（红茶）：杯 + 碟 + 热气 */
ART.teacup = v => {
  let out = ell(20, 33.4, 12.6, 3.1, '#EADFCC');
  out += `<path d="M10.4 16.6 h19.2 l-2.4 11.8 a6 6 0 0 1-5.9 4.8 h-2.6 a6 6 0 0 1-5.9-4.8 z" fill="url(#gCup)" stroke="#CFBEA3" stroke-width="1.2" stroke-linejoin="round"/>`;
  out += `<path d="M29.6 19.4 c4.2 0 5.6 4.6.8 6.6" fill="none" stroke="#CFBEA3" stroke-width="1.3"/>`;
  out += ell(20, 16.6, 9.6, 2.5, 'url(#gTea)');
  out += `<path d="M17.6 11.4c1.4-2.2-1.2-3.4.2-5.6M22.4 11.4c1.4-2.2-1.2-3.4.2-5.6" fill="none" stroke="#D8CBB6" stroke-width="1.2" stroke-linecap="round"/>`;
  return svgWrap(out);
};

/* 圆筒冰淇淋 */
ART.cone = v => {
  let out = `<path d="M13.4 17.4 h13.2 l-5.9 16.6 a1 1 0 0 1-1.4 0 z" fill="url(#gCone)" stroke="#C39A5C" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="M14.6 21.2 h10.8M16.2 25.6 h7.6M17.8 30 h4.4" stroke="#C9A467" stroke-width=".9" fill="none"/>`;
  out += `<path d="M12.4 17.4 c0-3.4 2-5 4.4-5 0-2.8 1.4-4.4 3.2-4.4 s3.2 1.6 3.2 4.4 c2.4 0 4.4 1.6 4.4 5 z" fill="url(#gCream)" stroke="#E0D2B8" stroke-width="1.1" stroke-linejoin="round"/>`;
  if(/灰焰/.test(v.name)) out += `<path d="M14.6 14.6 q5.4-3.4 10.8 0" stroke="#8E8E8E" stroke-width="1.4" fill="none"/>`;
  return svgWrap(out);
};

/* 新地 / 麦旋风：杯装 + 顶部浇头随口味变化 */
ART.sundae = v => {
  const top = /草莓/.test(v.name) ? 'url(#gBerry)' : /奥利奥|蓝莓/.test(v.name) ? 'url(#gChoco)' : 'url(#gChoco)';
  const small = v.size === 'xs';
  const yt = small ? 20.4 : 17.6, by = 34.4;
  const x0 = small ? 12.6 : 10.6, x1 = small ? 27.4 : 29.4;
  let out = `<path d="${cupPath(x0,x1,yt,by,2)}" fill="url(#gCream)" stroke="#D6C9B4" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += ell(20, yt, (x1-x0)/2, small?3:3.6, top);
  out += `<circle cx="${small?17:15.4}" cy="${yt-3.4}" r="${small?2.8:3.8}" fill="${top}"/><circle cx="${small?23:24.6}" cy="${yt-3}" r="${small?3:4.2}" fill="${top}"/>`;
  out += `<circle cx="20" cy="${yt-(small?5.6:7.2)}" r="${small?2.4:3.4}" fill="${top}"/>`;
  if(/奥利奥|蓝莓|爆珠/.test(v.name)) out += `<circle cx="17" cy="${yt-6.4}" r="1.1" fill="#FFFFFF"/><circle cx="23.4" cy="${yt-4.6}" r="1" fill="#FFFFFF"/><circle cx="20.6" cy="${yt-9}" r=".9" fill="#FFFFFF"/>`;
  return svgWrap(out);
};

/* 阿芙佳朵：玻璃杯 + 冰淇淋球 + 淋咖啡 */
ART.affogato = v => {
  const liquid = /抹茶/.test(v.name) ? 'url(#gMatcha)' : 'url(#gChoco)';
  let out = `<path d="M11.6 15.4 h16.8 l-2.2 17.6 a2.4 2.4 0 0 1-2.4 2.1 h-7.6 a2.4 2.4 0 0 1-2.4-2.1 z" fill="#F1F7FB" stroke="#C3D5E0" stroke-width="1.1" stroke-linejoin="round" opacity=".95"/>`;
  out += `<circle cx="16.6" cy="16.6" r="4.6" fill="url(#gCream)"/><circle cx="23.4" cy="15.8" r="5.2" fill="#FBF6EE"/>`;
  out += `<path d="M13.4 17 c2 2 4.6 3 6.8 3.2 2.4.2 4.8-.8 6.4-2.6 l-.5 3.4 c-2 1.6-4.6 2.4-6.8 2.2 -2.2-.2-4.4-1.2-6-2.8 z" fill="${liquid}"/>`;
  out += rr(17.6, 4.6, 3, 5.4, 1.5, '#CFC3B0');
  return svgWrap(out);
};

/* 派：香芋紫 / 菠萝黄，边缘压花 */
ART.pie = v => {
  const fill = /香芋/.test(v.name) ? 'url(#gPurple)' : 'url(#gPie)';
  let out = `<path d="M20 9 32.6 29.6 c.8 1.3-.2 3-1.7 3 H9.1 c-1.5 0-2.5-1.7-1.7-3 Z" fill="${fill}" stroke="#C8952F" stroke-width="1.2" stroke-linejoin="round"/>`;
  out += `<path d="M11.4 28.6 h17.2" stroke="#D8A94A" stroke-width="1.4" stroke-linecap="round" fill="none"/>`;
  out += `<path d="M20 9 26.4 19.6 H13.6 Z" fill="#FFFFFF" opacity=".22"/>`;
  out += `<circle cx="20" cy="10.6" r="1.1" fill="#FFFFFF" opacity=".55"/>`;
  if(/菠萝/.test(v.name)) out += `<path d="M15.6 24.4 h3.4M21 24.4 h3.4" stroke="#C8952F" stroke-width="1.1" stroke-linecap="round" fill="none"/>`;
  else out += `<circle cx="16.6" cy="24.4" r="1.2" fill="#F7EBD4"/><circle cx="23.4" cy="24.4" r="1.2" fill="#F7EBD4"/>`;
  return svgWrap(out);
};

/* 鸡块：块数决定盒里露出几块（4块 / 5块 / 8块） */
ART.nuggets = v => {
  const cnt = v.count || 5;
  const shown = cnt <= 4 ? 2 : cnt <= 5 ? 3 : cnt <= 6 ? 3 : 4;
  let out = '';
  for(let i=0;i<shown;i++){
    const x = 20 + (i - (shown-1)/2) * 7.4;
    const y = 15.6 - (i % 2 ? 1.4 : 0);
    out += `<ellipse cx="${x}" cy="${y}" rx="4.2" ry="3.4" fill="url(#gMeat)" stroke="#BE7A1E" stroke-width="1"/>`;
    out += `<circle cx="${x-1}" cy="${y-.6}" r=".9" fill="#F6D79A" opacity=".8"/>`;
  }
  if(shown >= 4) out += `<ellipse cx="20" cy="10.6" rx="4" ry="3.2" fill="url(#gMeat)" stroke="#BE7A1E" stroke-width="1"/>`;
  out += `<path d="${cupPath(7.8,32.2,17.6,34.6,2.6)}" fill="url(#gBox)" stroke="#8E1106" stroke-width="1" stroke-linejoin="round"/>`;
  out += `<path d="M9.2 21.6 h21.6" stroke="#FFE9A8" stroke-width="1.9" fill="none"/>`;
  return svgWrap(out);
};

/* 鸡翅 / V翅：形状与口味区分 —— 麦辣带辣椒粒，V翅是 V 形，柠萌配柠檬 */
ART.wings = v => {
  let out = '';
  if(/V翅/.test(v.name)){
    const one = (dx, rot) =>
      `<g transform="translate(${dx} 0) rotate(${rot} 20 21)">
        <path d="M13 14.6 L27 23.6 L16.6 26.8 Z" fill="url(#gMeat)" stroke="#BE7A1E" stroke-width="1.1" stroke-linejoin="round"/>
        <path d="M24.4 22.2 L28.6 18.6" stroke="#F2E2C4" stroke-width="2.6" stroke-linecap="round" fill="none"/>
      </g>`;
    out = one(0,-4) + `<g opacity=".92">${one(3,10)}</g>`;
  } else {
    const one = dx => `<g transform="translate(${dx} 0)">
      <ellipse cx="14.4" cy="21.4" rx="6.6" ry="5.4" fill="url(#gMeat)" stroke="#BE7A1E" stroke-width="1.1"/>
      <path d="M19.4 25.4 q5.4 3.4 8.2 6" stroke="#F2E2C4" stroke-width="3" stroke-linecap="round" fill="none"/>
      <circle cx="24.6" cy="30.2" r="2.4" fill="#F7E7C8" stroke="#DCC9A6" stroke-width=".9"/>
    </g>`;
    out = one(0) + `<g opacity=".95">${one(6.4)}</g>`;
  }
  if(/麦辣|绝代/.test(v.name)) out += `<circle cx="12.4" cy="19" r="1" fill="#DA291C"/><circle cx="16.6" cy="23.6" r=".9" fill="#DA291C"/><circle cx="23" cy="19.4" r=".9" fill="#DA291C"/>`;
  if(/柠萌|柠檬/.test(v.name)) out += `<circle cx="31" cy="13.6" r="4" fill="#F7E27A" stroke="#DCBE3E" stroke-width="1"/><path d="M31 9.6 v8M27 13.6 h8" stroke="#DCBE3E" stroke-width=".9"/>`;
  if(/蜜汁|BBQ/.test(v.name)) out += `<path d="M8.6 15.4 q11.4 -3.4 22.8 0" stroke="#8A4A18" stroke-width="1.5" fill="none" opacity=".55"/>`;
  return svgWrap(out);
};

/* 鸡腿 / 带骨里脊：形状不同，口味影响表面 */
ART.drumstick = v => {
  const strip = /里脊/.test(v.name);
  let out = '';
  if(strip){
    out += `<ellipse cx="19" cy="21" rx="11" ry="6.6" fill="url(#gMeat)" stroke="#BE7A1E" stroke-width="1.1"/>`;
    out += `<path d="M30 21 h4.6" stroke="#F7E7C8" stroke-width="3" stroke-linecap="round"/><circle cx="35" cy="21" r="2.2" fill="#F7E7C8" stroke="#DCC9A6" stroke-width=".8"/>`;
    out += `<path d="M10 17.6 q9 -2.4 18 0" stroke="#F6D79A" stroke-width="1.2" fill="none" opacity=".7"/>`;
  } else {
    out += `<ellipse cx="16.4" cy="16.6" rx="9.4" ry="8.6" fill="url(#gMeat)" stroke="#BE7A1E" stroke-width="1.1"/>`;
    out += `<path d="M23 22.6 l5.6 7.6" stroke="#F7E7C8" stroke-width="4.2" stroke-linecap="round" fill="none"/>`;
    out += `<circle cx="30.6" cy="32" r="4.4" fill="#F7E7C8" stroke="#DCC9A6" stroke-width="1"/>`;
    out += `<ellipse cx="13.6" cy="13.8" rx="3.6" ry="2.6" fill="#F6D79A" opacity=".65"/>`;
  }
  if(/蜜汁|BBQ/.test(v.name)) out += `<path d="M8.2 12.6 q10 -3 19.6 0" stroke="#8A4A18" stroke-width="1.6" fill="none" opacity=".5"/>`;
  if(/蒜/.test(v.name)) out += `<circle cx="13" cy="20" r="1" fill="#F4EEDC"/><circle cx="19" cy="11.6" r="1" fill="#F4EEDC"/><circle cx="24" cy="18" r=".9" fill="#F4EEDC"/>`;
  if(/椒盐/.test(v.name)) out += `<circle cx="12" cy="14" r=".9" fill="#3A2A16" opacity=".35"/><circle cx="20" cy="22" r=".8" fill="#3A2A16" opacity=".3"/>`;
  return svgWrap(out);
};

/* 鸡排：扁平大块 */
ART.chickenfilet = v => {
  let out = `<path d="M6.6 25.6 c-1.4-5.6 2.6-11 9.4-12.4 7.6-1.6 15 .8 17.4 5.6 2 4-.6 8.4-6 9.8 -6 1.6-13 1.2-17.4-.6 -1.8-.8-3-1.6-3.4-2.4Z" fill="url(#gMeat)" stroke="#BE7A1E" stroke-width="1.1"/>`;
  out += `<circle cx="15" cy="20.4" r="1" fill="#F6D79A" opacity=".7"/><circle cx="24" cy="18.4" r="1" fill="#F6D79A" opacity=".6"/><circle cx="20" cy="25" r="1" fill="#F6D79A" opacity=".55"/>`;
  if(/椒盐/.test(v.name)) out += `<circle cx="12.6" cy="17" r=".9" fill="#3A2A16" opacity=".35"/><circle cx="27" cy="22.6" r=".8" fill="#3A2A16" opacity=".3"/>`;
  return svgWrap(out);
};

/* 汉堡：面包形态 + 层数 + 有没有芝士/生菜，按名字决定 */
ART.burger = v => {
  const n = v.name;
  const long  = /麦辣鸡腿|麦香鸡/.test(n);
  const flat  = /板烧/.test(n);
  const fish  = /麦香鱼|鳕鱼|鱼排/.test(n);
  const layers = /巨无霸|双层|双牛|不素之霸|鳕鱼/.test(n) ? 2 : 1;
  const cheese = /吉士|芝士|安格斯|巨无霸|牛堡|儿童|汉堡包/.test(n) && !fish;
  let out = '';
  if(long || flat){
    const top = flat ? 'url(#gBunFlat)' : 'url(#gBun)';
    out += `<path d="M6.4 ${flat?17.6:16.6} h27.2 v${flat?4.6:4.2} H6.4 Z" fill="${top}" stroke="#D08A2E" stroke-width="1.1" stroke-linejoin="round" rx="1"/>`;
    if(flat) out += `<path d="M9 19.4 h6M17 19.4 h6M25 19.4 h5.6" stroke="#C08A4A" stroke-width="1.1" stroke-linecap="round" fill="none"/>`;
    out += rr(5.6, flat?22.2:20.8, 28.8, 3.6, 1.8, 'url(#gGreen)');
    out += rr(6.2, flat?25.4:24.2, 27.6, 5.4, 2.6, 'url(#gPatty)');
    if(cheese) out += `<path d="M7 30.2 h26 l-3 3.4 h-20 Z" fill="url(#gCheese)"/>`;
    out += `<path d="M7.4 33.4 h25.2 a2.4 2.4 0 0 1-2.4 2.4 H9.8 a2.4 2.4 0 0 1-2.4-2.4 Z" fill="${top}" stroke="#D08A2E" stroke-width="1"/>`;
    return svgWrap(out);
  }
  if(fish){
    out += `<path d="M7.4 17.6 c0-6 5.6-9.4 12.6-9.4 s12.6 3.4 12.6 9.4 z" fill="url(#gBunFlat)" stroke="#C9A467" stroke-width="1.1" stroke-linejoin="round"/>`;
    out += rr(6.4, 17, 27.2, 5, 2.4, 'url(#gMeat)');
    out += `<path d="M7 22.2 h26 l-2.6 3.4 h-20.8 Z" fill="url(#gCheese)" opacity=".85"/>`;
    out += `<path d="M7.4 25.6 h25.2 c0 5.6-5.6 8.6-12.6 8.6 s-12.6-3-12.6-8.6 Z" fill="url(#gBunFlat)" stroke="#C9A467" stroke-width="1.1"/>`;
    return svgWrap(out);
  }
  /* 圆面包 */
  out += `<path d="M6.6 18.6 c0-7.4 5.8-11.6 13.4-11.6 s13.4 4.2 13.4 11.6 z" fill="url(#gBun)" stroke="#D08A2E" stroke-width="1.2" stroke-linejoin="round"/>`;
  out += `<circle cx="14" cy="12.4" r="1.05" fill="#FFF3D2"/><circle cx="20" cy="10.6" r="1.05" fill="#FFF3D2"/><circle cx="26" cy="12.4" r="1.05" fill="#FFF3D2"/>`;
  out += rr(5.6, 18, 28.8, 3.8, 1.9, 'url(#gGreen)');
  if(cheese) out += rr(6, 21.2, 28, 4.2, 2, 'url(#gCheese)');
  else out += rr(6, 21.2, 28, 3.4, 1.7, 'url(#gGreen)');
  out += rr(6.4, cheese ? 25 : 24.4, 27.2, 5.6, 2.8, 'url(#gPatty)');
  if(layers >= 2){
    out += rr(6.8, 30, 26.4, 2.6, 1.3, 'url(#gCheese)');
    out += rr(7, 32.2, 26, 3.6, 1.8, 'url(#gPatty)');
  }
  out += `<path d="M7.2 ${layers>=2?35.6:29.8} h25.6 c0 2.6-2 4.4-4.6 4.4 H11.8 c-2.6 0-4.6-1.8-4.6-4.4 Z" fill="url(#gBun)" stroke="#D08A2E" stroke-width="1.1"/>`;
  return svgWrap(out);
};

/* 麦满分：英式玛芬 + 煎蛋 + 肉层，双层/有没有蛋按名字决定 */
ART.muffin = v => {
  const n = v.name;
  const egg  = /蛋/.test(n);
  const dbl  = /双层/.test(n);
  const meat = /烟肉/.test(n) ? '#C4552A' : /火腿/.test(n) ? '#E38A8A' : /鸡扒/.test(n) ? 'url(#gMeat)' : 'url(#gPatty)';
  let out = rr(6.6, 9.4, 26.8, 7.6, 3.8, 'url(#gBunFlat)', ' stroke="#C0A26E" stroke-width="1.1"');
  out += `<circle cx="13" cy="13" r=".7" fill="#E4D3B2"/><circle cx="20" cy="11.6" r=".7" fill="#E4D3B2"/><circle cx="27" cy="13" r=".7" fill="#E4D3B2"/>`;
  let y = 17;
  if(egg){ out += `<path d="M7.4 ${y} h25.2 v4.4 a2.2 2.2 0 0 1-2.2 2.2 H9.6 a2.2 2.2 0 0 1-2.2-2.2 Z" fill="#FFF3D2" stroke="#F0DCA8" stroke-width=".9"/><circle cx="20" cy="${y+3.2}" r="2.6" fill="#FFD34D"/>`; y += 6.8; }
  if(dbl){ out += rr(6.8, y, 26.4, 3.4, 1.7, meat); y += 3.6; }
  out += rr(6.8, y, 26.4, 4.8, 2.4, meat);
  if(/芝士|吉士/.test(n)) out += rr(6.4, y+4.4, 27.2, 3.2, 1.6, 'url(#gCheese)');
  out += rr(6.6, 27.4, 26.8, 5.4, 2.7, 'url(#gBunFlat)', ' stroke="#C0A26E" stroke-width="1.1"');
  return svgWrap(out);
};

/* 卷类 */
ART.wrap = v => {
  const green = /鲜蔬|多笋|沙拉|叠叠/.test(v.name);
  let out = rr(5.6, 15.4, 24, 12.4, 6.2, 'url(#gBunFlat)', ' stroke="#CBA874" stroke-width="1.1"');
  out += `<ellipse cx="30.4" cy="21.6" rx="4.4" ry="6.6" fill="#E7C98F" stroke="#CBA874" stroke-width="1.1"/>`;
  out += `<ellipse cx="30.4" cy="21.6" rx="2.6" ry="4.6" fill="${green ? 'url(#gGreen)' : 'url(#gMeat)'}"/>`;
  if(green) out += `<ellipse cx="29.6" cy="21.6" rx="1.2" ry="2.4" fill="#FFFFFF" opacity=".8"/>`;
  out += `<path d="M10.6 18.6 h8M10.6 22 h6M10.6 25.4 h8" stroke="#DCBB84" stroke-width="1.1" stroke-linecap="round" fill="none"/>`;
  return svgWrap(out);
};

/* 香肠 */
ART.sausage = v => {
  let out = `<g transform="rotate(-9 20 20)">
    <rect x="6.6" y="15" width="27" height="10.6" rx="5.3" fill="#B4552B" stroke="#8A3F1E" stroke-width="1.1"/>
    <path d="M13 16.2 l3 8M19 15.4 l3 8M25 14.6 l3 8" stroke="#8A3F1E" stroke-width="1.2" stroke-linecap="round" fill="none"/>
    <path d="M10 18.4 q10 -2.4 20 -0.4" stroke="#E08A55" stroke-width="1.2" fill="none" opacity=".75"/></g>`;
  return svgWrap(out);
};

/* 玉米杯 */
ART.corncup = v => {
  const wide = v.size === 'l';
  const x0 = wide ? 10 : 12, x1 = wide ? 30 : 28, yt = wide ? 17.6 : 19.6, by = 35.4;
  let out = `<path d="${cupPath(x0,x1,yt,by,2.2)}" fill="url(#gCup)" stroke="#D6C9B4" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += ell(20, yt, (x1-x0)/2, 3.4, '#E8B23A');
  out += `<circle cx="15.4" cy="${yt-3.2}" r="2.6" fill="#FFD84D"/><circle cx="20" cy="${yt-5.4}" r="2.8" fill="#FFC72C"/><circle cx="24.6" cy="${yt-3.2}" r="2.6" fill="#FFD84D"/>`;
  out += `<circle cx="17.7" cy="${yt-7.2}" r="2.2" fill="#FFC72C"/><circle cx="22.3" cy="${yt-7.2}" r="2.2" fill="#FFD84D"/>`;
  return svgWrap(out);
};

/* 薯饼 */
ART.hashbrown = v => {
  let out = ell(20, 21, 13.4, 10, 'url(#gPotato)', ' stroke="#C4822A" stroke-width="1.2"');
  out += ell(20, 21, 10, 7.2, '#F0BC5E');
  out += `<circle cx="15" cy="18.4" r="1.1" fill="#C4822A" opacity=".7"/><circle cx="24.6" cy="20" r="1" fill="#C4822A" opacity=".7"/><circle cx="19.4" cy="24.4" r="1" fill="#C4822A" opacity=".7"/><circle cx="26" cy="25" r=".9" fill="#C4822A" opacity=".6"/>`;
  if(/心形/.test(v.name)) out += `<path d="M20 24.6c-3.4-2.4-5.6-4.2-5.6-6.4 0-1.7 1.3-2.8 2.8-2.8 1.1 0 2.1.6 2.8 1.6.7-1 1.7-1.6 2.8-1.6 1.5 0 2.8 1.1 2.8 2.8 0 2.2-2.2 4-5.6 6.4z" fill="#FFFFFF" opacity=".55"/>`;
  return svgWrap(out);
};

/* 油条 */
ART.youtiao = v => {
  let out = `<rect x="4.4" y="15" width="31.2" height="10.6" rx="5.3" fill="url(#gPotato)" stroke="#C4822A" stroke-width="1.1"/>`;
  out += `<path d="M9.4 18 h21.2" stroke="#F7D08A" stroke-width="2" stroke-linecap="round" fill="none"/>`;
  out += `<path d="M9.4 22.8 h21.2" stroke="#C4822A" stroke-width="1.1" stroke-linecap="round" fill="none"/>`;
  return svgWrap(out);
};

/* 苹果片 */
ART.apple = v => {
  let out = `<path d="M20 12.6c-2.4-2-6.4-2.2-9.2.6-3.6 3.6-3 10.6.6 15 2 2.4 4.6 4 7 3.2 1.2-.4 2-.9 2.6-.9s1.4.5 2.6.9c2.4.8 5-.8 7-3.2 3.6-4.4 4.2-11.4.6-15-2.8-2.8-6.8-2.6-9.2-.6z" fill="url(#gRed)" stroke="#A81E15" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="M20 12.6V8" stroke="#8A5A33" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;
  out += `<path d="M20 9.4c1.6-3 4.6-3.6 7-3-1 3-3.6 4.4-7 3z" fill="url(#gGreen)" stroke="#4E9A32" stroke-width="1" stroke-linejoin="round"/>`;
  out += `<ellipse cx="14.4" cy="18.6" rx="2" ry="3" fill="#FFFFFF" opacity=".35"/>`;
  return svgWrap(out);
};

/* 粥 */
ART.congee = v => {
  let out = ell(20, 32.6, 12.6, 2.8, '#EADFCC');
  out += `<path d="M8.6 18.6h22.8c0 8.6-5.2 14-11.4 14s-11.4-5.4-11.4-14z" fill="url(#gCup)" stroke="#D6C9B4" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += ell(20, 18.6, 11.4, 3.4, '#F2E6CE');
  out += `<path d="M15.4 18.2c1-1.8 3-1.8 4 0M21 20c.9-1.5 2.5-1.5 3.4 0" stroke="#DCCBA6" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
  if(/皮蛋/.test(v.name)) out += `<circle cx="16" cy="18" r="1.4" fill="#6E6A55"/><circle cx="23.6" cy="19" r="1.2" fill="#6E6A55"/>`;
  if(/雪菜|笋/.test(v.name)) out += `<path d="M17.6 17.2c1.4-1 3-1 4.4 0" stroke="#7FA94F" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;
  out += `<path d="M16.6 12c1.3-2-1-3-.3-4.6M23 12c1.3-2-1-3-.3-4.6" stroke="#D8CBB6" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;
  return svgWrap(out);
};

/* 甜品块：拉明顿（椰丝方块）/ 奶冻 / 爆珠 */
ART.cake = v => {
  const berry = /草莓/.test(v.name);
  const base = berry ? 'url(#gBerry)' : /柠檬/.test(v.name) ? '#F2D06A' : 'url(#gChoco)';
  let out = rr(8.4, 14.4, 23.2, 17.6, 3.4, base, ' stroke="#00000022" stroke-width="1"');
  out += `<path d="M8.4 17.8h23.2" stroke="#FFFFFF" stroke-width="1" opacity=".35"/>`;
  if(/奶冻|爆珠/.test(v.name)){
    out += rr(8.4, 20.4, 23.2, 5, .8, '#FFFFFF', ' opacity=".55"');
    out += `<circle cx="14" cy="27" r="2" fill="#F7B7CB"/><circle cx="20" cy="28.4" r="2" fill="#F7B7CB"/><circle cx="26" cy="26.6" r="2" fill="#F7B7CB"/>`;
  } else {
    for(const [x,y] of [[13,19],[20,22],[26.6,18.4],[16,26],[23,27.4]]){
      out += `<circle cx="${x}" cy="${y}" r="1.4" fill="#FDF7EC" opacity=".95"/>`;
    }
  }
  return svgWrap(out);
};

/* 水瓶 */
ART.bottle = v => {
  let out = rr(14.6, 6, 10.8, 4.6, 2, '#7FC3E8');
  out += `<path d="M15 10.8h10v21.2a3.4 3.4 0 0 1-3.4 3.4h-3.2A3.4 3.4 0 0 1 15 32z" fill="#E3F2FA" stroke="#9CC7DD" stroke-width="1.1"/>`;
  out += rr(16.4, 18.6, 7.2, 8, 1.4, '#BFE0F0');
  out += `<path d="M17.6 22.2h4.8M20 20.8v5" stroke="#FFFFFF" stroke-width="1.1" fill="none"/>`;
  return svgWrap(out);
};

/* 牛奶盒 */
ART.milkbox = v => {
  let out = `<path d="M13 13.6 20 8.6l7 5V33a1.6 1.6 0 0 1-1.6 1.6H14.6A1.6 1.6 0 0 1 13 33z" fill="url(#gCup)" stroke="#CFC3B0" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="M13 13.6h14M20 8.6v5" stroke="#CFC3B0" stroke-width="1.1" fill="none"/>`;
  out += rr(15.4, 19, 9.2, 9, 1.6, '#8FCBE8');
  out += `<path d="M17 23.5h6" stroke="#FFFFFF" stroke-width="1.2" fill="none"/>`;
  out += `<circle cx="20" cy="27.6" r="1.6" fill="#FFFFFF" opacity=".8"/>`;
  return svgWrap(out);
};

/* 果汁盒 */
ART.juicebox = v => {
  let out = `<path d="M12.6 14.6 20 9.6l7.4 5V33a1.6 1.6 0 0 1-1.6 1.6H14.2A1.6 1.6 0 0 1 12.6 33z" fill="url(#gCup)" stroke="#CFC3B0" stroke-width="1.1" stroke-linejoin="round"/>`;
  out += `<path d="M12.6 14.6h14.8M20 9.6v5" stroke="#CFC3B0" stroke-width="1.1" fill="none"/>`;
  out += rr(15, 19.4, 10, 9.4, 1.6, /柠|橙橙/.test(v.name) ? 'url(#gTea)' : '#F2B33A');
  out += rr(21, 10.6, 2.4, 8.4, 1.2, '#DA291C', ' transform="rotate(18 22 14)"');
  return svgWrap(out);
};

/* ---------- 出图：官方实拍优先，手绘兜底 ---------- */
function iconHTML(name, cls){
  const sp = specOf(name);
  const ph = PHOTOS[name];
  const art = (ART[sp.kind] || ART.burger)(sp);
  const img = ph
    ? `<img class="fp" src="${ph.src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('nop')">`
    : '';
  return `<span class="${cls}${ph ? '' : ' nop'}" style="--s:${sp.scale.toFixed(2)}">${img}<span class="fdr">${art}</span></span>`;
}
function foodIcon(name){ return (ART[specOf(name).kind] || ART.burger)(specOf(name)); }
