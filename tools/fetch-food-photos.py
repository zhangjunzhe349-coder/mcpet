#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
拉取麦当劳中国官方「菜单白底图」，与 data/nutrition.json 的 158 条餐品对齐，
下载 → 压缩成 96×96 WebP → 落到 assets/food/，并生成 data/food-photos.json。

图片源：麦当劳中国官方点餐菜单接口（MCP 工具 `query-meals` 的 image 字段，
        CDN 域名 menu-img.mcd.cn），与点餐 App 上看到的是同一套图。

匹配分四级（依次放宽，宁缺毋滥 —— 匹配不上就交给前端手绘图兜底）：
    1. exact    营养表名 == 菜单名（归一化后）
    2. alias    人工校验过的等价映射（ALIAS）
    3. stripped 剥掉尺寸/块数词后相等（小/中/大薯条、4块/5块鸡块共用一张图）
    4. core     去掉品牌前缀/浓淡修饰/冰热前后缀后的「核心词」互为子串
                （冰奶铁/热奶铁 → 麦咖啡™奶铁；冰美式 → 麦咖啡™美式；
                 浓浓黑巧（冰/热）→ 冰浓浓黑巧中杯）

⚠️ 早餐品（麦满分 / 粥 / 油条 / 营养卷 / 图林根香肠 / 豆浆）只在北京时间
   早餐时段（约 05:00–10:30）出现在门店菜单里 —— 本时段跑只能拿到正餐品。
   故脚本默认 **合并模式**：新结果与已有 data/food-photos.json 合并，
   早餐时段再跑一次即可自动补齐早餐品，不会把已有图冲掉。

用法：
    python tools/fetch-food-photos.py              # 合并模式（推荐，可反复跑）
    python tools/fetch-food-photos.py --fresh      # 丢弃旧结果，全量重抓
    python tools/fetch-food-photos.py --pool _menu_pool.json   # 用离线菜单池（不再打 MCP）
    python tools/fetch-food-photos.py --store 3330545          # 只抓指定门店
    python tools/fetch-food-photos.py --keep-png               # 不转 WebP（无 Pillow 时）

前置：本机 WorkBuddy 已注册 mcd-mcp；脚本经 workbuddy-mcp-direct 技能直连本机
      连接器代理调用 MCP（凭据从日志读取，不落盘）。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
MCP_CALL = Path.home() / ".workbuddy/skills/workbuddy-mcp-direct/scripts/mcp-call.py"
NUTRITION = ROOT / "data/nutrition.json"
OUT_JSON = ROOT / "data/food-photos.json"
OUT_DIR = ROOT / "assets/food"
POOL_CACHE = ROOT / "_menu_pool.json"
IMG_SIZE = 96
WEBP_Q = 82

# 聚合多个门店：不同城市 / 业态的门店菜单品类覆盖不同，合起来图库最全
POOL_STORES = [
    "1420576",  # 麦当劳深圳湾一店餐厅（00:00-23:59）
    "3330545",  # 宁波海曙丽园南路
    "3330626",  # 宁波佰奕得来速
    "3330454",  # 宁波龙湖海曙天街
    "3330095",  # 宁波站站内
    "3330287",  # 宁波南站里
]
# 单店兜底：候选门店都失败时，按城市搜索营业中的门店
DISCOVER_CITIES = ["深圳市", "广州市", "北京市", "上海市", "杭州市", "宁波市"]

# 营养表名 → 菜单名（人工校验过的等价映射）
ALIAS = {
    # —— 站点/规格变体 ——
    "麦辣鸡翅-2块": "麦辣鸡翅",
    "大杯鲜萃咖啡": "鲜萃咖啡",
    "小杯鲜萃咖啡": "鲜萃咖啡",
    "浓缩咖啡": "鲜萃咖啡",
    "100%苹果汁": "100% 苹果汁(盒装)",
    "纯牛奶（盒装）": "纯牛奶(盒装)",
    "那么大鸡排": "那么大鸡排（椒盐风味）",
    # —— 脆汁鸡系列：菜单只有一个「麦麦脆汁鸡1块」白底图 ——
    "麦麦脆汁鸡-琵琶腿": "麦麦脆汁鸡1块",
    "麦麦脆汁鸡-带骨里脊": "麦麦脆汁鸡1块",
    "蜜汁BBQ风味薄皮脆汁鸡-琵琶腿": "麦麦脆汁鸡1块",
    "蜜汁BBQ风味薄皮脆汁鸡-带骨里脊": "麦麦脆汁鸡1块",
    "蒜了吧黄油风味薄皮脆汁鸡-琵琶腿": "麦麦脆汁鸡1块",
    "蒜了吧黄油风味薄皮脆汁鸡-带骨里脊": "麦麦脆汁鸡1块",
    # —— V 翅 ——
    "薄皮焦香V翅": "薄皮焦香V翅",
    "绝代双翅": "麦辣鸡翅",
    "柠萌风味薄皮焦香V翅": "薄皮焦香V翅",
    # —— 饮品 ——
    "中杯怡泉+C": "怡泉+C",
    "大杯怡泉+C": "怡泉+C",
    "麦旋酷阳光橙": "阳光橙麦炫酷",
    "【美汁源】“黄金橙橙”": "【美汁源】“黄金橙橙”",
    "无糖可口可乐中杯": "可乐",
    "无糖可口可乐大杯": "可乐",
    "无糖可口可乐小杯": "可乐",
    "川宁伯爵红茶": "锡兰红茶",   # 同为红茶，杯型一致
    # —— 汉堡 / 乐园餐（基础汉堡共用一张产品图）——
    "汉堡包": "汉堡开心乐园餐",
    "吉士汉堡包": "汉堡开心乐园餐",
    "儿童鱼排堡": "鱼排堡开心乐园餐",
    # —— 安格斯「双层」——菜单只有单层白底图 ——
    "芝士双层安格斯厚牛堡": "芝士安格斯厚牛堡",
    "培根双层安格斯厚牛堡": "培根安格斯厚牛堡",
    # —— 甜品 ——
    "奥利奥麦旋风": "经典麦旋风",
    "草莓麦旋风": "经典麦旋风",
    "朱古力新地": "新地",
    "草莓新地": "新地",
    "迷你朱古力新地": "新地",
    "迷你草莓新地": "新地",
    "香芋派": "派",
    "菠萝派": "派",
    # —— 雪冰：同款杯型，菜单只有个别口味 ——
    "浓浓抹茶雪冰中杯": "茉莉奶绿雪冰",
    "浓浓抹茶雪冰大杯": "茉莉奶绿雪冰",
    "特浓奶香雪冰中杯": "奶铁雪冰",
    "特浓奶香雪冰大杯": "奶铁雪冰",
    # —— 小食 / 早餐（本时段可得的部分）——
    "脆薯饼": "心形薯饼5块",
    "脆脆薯条": "薯条",
    "麦乐鸡4块": "麦乐鸡",
    "麦乐鸡5块": "麦乐鸡",
    # —— 套餐类（营养表里本身就是组合，用官方套餐图）——
    "牛气满满": "牛气满满套餐",
    "“苹板”支撑Pro": "苹板支撑便民套餐",
}

# 尺寸 / 块数等「横向变体」token，匹配时剥离（前端会用尺寸差异化渲染）
SIZE_TOKENS = [
    "迷你", "小杯", "中杯", "大杯", "小", "中", "大",
    "-2块", "-4块", "4块", "5块", "8块", "1块", "2块",
]
# 品牌前缀 / 浓淡修饰 —— 只用于第 4 级「核心匹配」，不影响前三级
BRAND_TOKENS = ["麦咖啡™", "麦咖啡", "McCafe", "麦当劳", "™"]
DEGREE_TOKENS = ["浓浓", "特浓", "浓香", "经典"]
# 组合装/套餐类菜单名不适合当单品图标（图里会有薯条饮料），第 4 级匹配跳过它们
COMBO_RE = re.compile(r"套餐|件套|随心|精选|分享|组合|双人|盒|袋|八件|四件|三件|拼")


def norm(s: str) -> str:
    """归一化：全角→半角，去掉所有非字母数字汉字。"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]", "", s).lower()


def strip_size(s: str) -> str:
    out = s
    for t in SIZE_TOKENS:
        out = out.replace(t, "")
    return out


def core(s: str) -> str:
    """核心词：去品牌前缀 / 浓淡修饰 / 冰热前后缀 / 尺寸词，用于第 4 级匹配。"""
    s = norm(s)
    for t in BRAND_TOKENS:
        s = s.replace(norm(t), "")
    for t in DEGREE_TOKENS:
        s = s.replace(norm(t), "")
    s = s.replace("冰热", "").replace("热冰", "")
    s = s.replace("风味", "").replace("款", "")
    s = strip_size(s)
    for p in ("冰", "热"):
        if s.startswith(p):
            s = s[1:]
    return s


def is_combo(name: str) -> bool:
    return bool(COMBO_RE.search(name or ""))


def mcp_call(tool: str, args: dict) -> dict:
    """经 workbuddy-mcp-direct 直连本机连接器代理调用 MCP 工具。"""
    if not MCP_CALL.exists():
        raise SystemExit(f"找不到直连脚本：{MCP_CALL}")
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    p = subprocess.run(
        [PY, str(MCP_CALL), "--service", "mcd-mcp", tool, json.dumps(args, ensure_ascii=False)],
        capture_output=True, timeout=180, env=env,
    )
    text = p.stdout.decode("utf-8", "ignore")
    i = text.find('{"success"')
    if i < 0:
        raise RuntimeError(f"{tool} 没有返回 JSON：{text[:200]}")
    obj, _ = json.JSONDecoder().raw_decode(text[i:])
    return obj


def find_open_store() -> tuple:
    """兜底：返回 (storeCode, storeName, source)。"""
    for code in POOL_STORES:
        try:
            r = mcp_call("query-meals", {"storeCode": code, "orderType": 1, "beType": 1})
            if r.get("success"):
                return code, code, "候选门店"
        except Exception:
            pass
    for city in DISCOVER_CITIES:
        try:
            r = mcp_call("query-nearby-stores", {"beType": 1, "searchType": 2, "city": city, "keyword": "麦当劳"})
        except Exception:
            continue
        for st in (r.get("data") or []):
            if not st.get("businessStatus"):
                continue
            code = st.get("storeCode")
            try:
                m = mcp_call("query-meals", {"storeCode": code, "orderType": 1, "beType": 1})
            except Exception:
                continue
            if m.get("success"):
                return code, st.get("storeName", code), f"自动搜索（{city}）"
    raise SystemExit("没有找到营业中的门店 —— 麦当劳门店普遍 07:00~23:00，请在营业时段重跑。")


def collect_menu_pool(store: str, pool_file: str) -> tuple:
    """聚合多门店菜单成 name→image 池。返回 (pool, 来源说明, 门店清单)。"""
    if pool_file and Path(pool_file).exists():
        pool = json.loads(Path(pool_file).read_text(encoding="utf-8"))
        return pool, f"离线池 {pool_file}", ["(离线)"]
    stores = [store] if store else POOL_STORES
    pool, ok_stores = {}, []
    for code in stores:
        try:
            r = mcp_call("query-meals", {"storeCode": code, "orderType": 1, "beType": 1})
        except Exception as e:
            print(f"    ! 门店 {code} 菜单取失败：{e}")
            continue
        meals = (r.get("data") or {}).get("meals") or {}
        if not meals:
            continue
        for m in meals.values():
            nm, img = m.get("name"), m.get("image")
            if nm and img:
                pool.setdefault(nm, img)
        ok_stores.append(code)
    if not pool:
        s, sn, src = find_open_store()
        r = mcp_call("query-meals", {"storeCode": s, "orderType": 1, "beType": 1})
        for m in ((r.get("data") or {}).get("meals") or {}).values():
            if m.get("name") and m.get("image"):
                pool[m["name"]] = m["image"]
        ok_stores = [s]
    POOL_CACHE.write_text(json.dumps(pool, ensure_ascii=False, indent=1), encoding="utf-8")
    return pool, f"{len(ok_stores)} 家门店聚合", ok_stores


def build_index(pool: dict) -> tuple:
    """菜单池 → (exact, stripped, cores) 三个索引，键为归一化名。"""
    exact = {}
    stripped = {}
    cores = {}
    for name, url in pool.items():
        exact.setdefault(norm(name), (name, url))
        stripped.setdefault(norm(strip_size(name)), (name, url))
        c = core(name)
        if c and not is_combo(name):
            cores.setdefault(c, (name, url))
    return exact, stripped, cores


def match(name: str, exact: dict, stripped: dict, cores: dict):
    """四级匹配，返回 ((菜单名, url), how) 或 (None, None)。"""
    if norm(name) in exact:
        return exact[norm(name)], "exact"
    if name in ALIAS and norm(ALIAS[name]) in exact:
        return exact[norm(ALIAS[name])], "alias"
    s = norm(strip_size(name))
    if s and s in stripped:
        return stripped[s], "stripped"
    c = core(name)
    if c and len(c) >= 2:
        if c in cores:
            return cores[c], "core"
        cands = [(mc, mv) for mc, mv in cores.items()
                 if len(mc) >= 2 and (c in mc or mc in c)]
        if cands:
            # 越接近越优先：完全相等 > 长度差最小
            cands.sort(key=lambda x: (0 if x[0] == c else 1, abs(len(x[0]) - len(c))))
            return cands[0][1], "core"
    return None, None


def fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://zhangjunzhe349-coder.github.io/"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def to_asset(raw: bytes, keep_png: bool) -> tuple:
    """原图字节 → (落盘字节, 扩展名)。全程内存转码，不产生临时文件。"""
    try:
        from PIL import Image
    except ImportError:
        return raw, ".png"
    import io
    with Image.open(io.BytesIO(raw)) as im:
        im = im.convert("RGBA")
        im.thumbnail((IMG_SIZE, IMG_SIZE), Image.LANCZOS)
        canvas = Image.new("RGBA", (IMG_SIZE, IMG_SIZE), (255, 255, 255, 0))
        canvas.paste(im, ((IMG_SIZE - im.width) // 2, (IMG_SIZE - im.height) // 2), im)
        buf = io.BytesIO()
        if not keep_png:
            try:
                canvas.save(buf, "WEBP", quality=WEBP_Q, method=6)
                return buf.getvalue(), ".webp"
            except Exception:
                buf = io.BytesIO()
        canvas.save(buf, "PNG", optimize=True)
        return buf.getvalue(), ".png"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-png", action="store_true", help="不转 WebP")
    ap.add_argument("--store", help="指定门店编码，跳过聚合")
    ap.add_argument("--pool", help="离线菜单池 JSON（存在则不打 MCP）")
    ap.add_argument("--fresh", action="store_true", help="丢弃旧结果，全量重抓")
    args = ap.parse_args()

    old = {}
    if not args.fresh and OUT_JSON.exists():
        try:
            old = json.loads(OUT_JSON.read_text(encoding="utf-8")).get("photos") or {}
        except Exception:
            old = {}

    print("① 收集官方菜单图池…")
    pool, src, stores = collect_menu_pool(args.store, args.pool)
    exact, stripped, cores = build_index(pool)
    print(f"   → {src}（{'/'.join(stores)}）：{len(pool)} 个品名可用图")

    print("② 与营养表 158 条对齐（四级匹配）…")
    items = json.loads(NUTRITION.read_text(encoding="utf-8"))["items"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    photos, stats, miss_list = {}, {"exact": 0, "alias": 0, "stripped": 0, "core": 0,
                                    "kept": 0, "miss": 0}, []
    seen = {}   # 图片内容 sha1 → 已落盘相对路径（同一张图只存一份）

    for it in items:
        name = it["productName"]
        hit, how = match(name, exact, stripped, cores)
        if not hit or len(hit) != 2:
            if name in old:
                photos[name] = old[name]
                stats["kept"] += 1
                seen.setdefault(old[name].get("sha1") or "", old[name]["src"])
            else:
                stats["miss"] += 1
                miss_list.append(name)
            continue
        menu_name, url = hit
        try:
            raw = fetch(url)
        except Exception as e:
            print(f"    ! 下载失败 {menu_name} -> {e}")
            if name in old:
                photos[name] = old[name]
                stats["kept"] += 1
            else:
                stats["miss"] += 1
                miss_list.append(name)
            continue
        if len(raw) < 800:
            if name in old:
                photos[name] = old[name]
                stats["kept"] += 1
            else:
                stats["miss"] += 1
                miss_list.append(name)
            continue
        digest = hashlib.sha1(raw).hexdigest()
        if digest in seen:
            rel = seen[digest]
        else:
            blob, ext = to_asset(raw, args.keep_png)
            dest = OUT_DIR / f"{norm(name)[:28] or 'x'}{ext}"
            dest.write_bytes(blob)
            rel = str(dest.relative_to(ROOT)).replace("\\", "/")
            seen[digest] = rel
        photos[name] = {"src": rel, "from": menu_name, "how": how, "sha1": digest}
        stats[how] += 1

    # 清掉不再被引用的孤儿文件（下载文件名会随匹配结果变化）
    used_files = {p["src"] for p in photos.values()}
    removed = 0
    for f in OUT_DIR.glob("*"):
        if f.is_file():
            rel = str(f.relative_to(ROOT)).replace("\\", "/")
            if rel not in used_files:
                try:
                    f.unlink()
                    removed += 1
                except Exception:
                    pass

    payload = {
        "source": "麦当劳中国官方点餐菜单（MCP query-meals / menu-img.mcd.cn）",
        "stores": stores,
        "storeName": "/".join(stores),
        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(photos),
        "total_items": len(items),
        "photos": photos,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    total_kb = sum(f.stat().st_size for f in OUT_DIR.glob("*") if f.is_file()) / 1024
    print(f"③ 完成：{len(photos)}/{len(items)} 条有官方图"
          f"（精确 {stats['exact']} · 别名 {stats['alias']} · 去尺寸词 {stats['stripped']} · 核心 {stats['core']} · 沿用旧图 {stats['kept']}），"
          f"去重后 {len(seen)} 个文件，共 {total_kb:.0f} KB"
          + (f"，清理孤儿文件 {removed} 个" if removed else ""))
    if miss_list:
        print(f"   无官方图（手绘兜底）{len(miss_list)} 条：" + "、".join(miss_list))


if __name__ == "__main__":
    main()
