#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
拉取麦当劳中国官方「菜单白底图」，与 data/nutrition.json 的 158 条餐品对齐，
下载 → 压缩成 96×96 WebP → 落到 assets/food/，并生成 data/food-photos.json。

图片源：麦当劳中国官方点餐菜单接口（MCP 工具 `query-meals` 的 image 字段，
        CDN 域名 menu-img.mcd.cn），与点餐 App 上看到的是同一套图。

用法：
    python tools/fetch-food-photos.py            # 只抓当前可用的
    python tools/fetch-food-photos.py --keep-png # 不转 WebP（无 Pillow 时）

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
IMG_SIZE = 96
WEBP_Q = 82

# 优先尝试的门店（24 小时营业的门店最稳），失败则自动搜索营业中的门店
CANDIDATE_STORES = [
    "1420576",  # 麦当劳深圳湾一店餐厅（00:00-23:59）
    "3330545",  # 宁波海曙丽园南路
    "3330095",  # 宁波站站内
]
DISCOVER_CITIES = ["深圳市", "广州市", "北京市", "上海市", "杭州市", "宁波市"]

# 营养表名 → 菜单名（人工校验过的等价映射；大小/块数变体交给前端做尺寸差异化）
ALIAS = {
    "麦辣鸡翅-2块": "麦辣鸡翅",
    "大杯鲜萃咖啡": "鲜萃咖啡",
    "小杯鲜萃咖啡": "鲜萃咖啡",
    "浓缩咖啡": "鲜萃咖啡",
    "100%苹果汁": "100% 苹果汁(盒装)",
    "纯牛奶（盒装）": "纯牛奶(盒装)",
    "那么大鸡排": "那么大鸡排（椒盐风味）",
    "麦麦脆汁鸡-琵琶腿": "麦麦脆汁鸡1块",
    "麦麦脆汁鸡-带骨里脊": "麦麦脆汁鸡1块",
    "蜜汁BBQ风味薄皮脆汁鸡-琵琶腿": "麦麦脆汁鸡1块",
    "蜜汁BBQ风味薄皮脆汁鸡-带骨里脊": "麦麦脆汁鸡1块",
    "蒜了吧黄油风味薄皮脆汁鸡-琵琶腿": "麦麦脆汁鸡1块",
    "蒜了吧黄油风味薄皮脆汁鸡-带骨里脊": "麦麦脆汁鸡1块",
    "薄皮焦香V翅": "薄皮焦香V翅",
    "绝代双翅": "麦辣鸡翅",
    "柠萌风味薄皮焦香V翅": "薄皮焦香V翅",
    "中杯怡泉+C": "怡泉+C",
    "大杯怡泉+C": "怡泉+C",
    "麦旋酷阳光橙": "【美汁源】“黄金橙橙”",
    "【美汁源】“黄金橙橙”": "【美汁源】“黄金橙橙”",
    "汉堡包": "汉堡开心乐园餐",
    "儿童鱼排堡": "鱼排堡开心乐园餐",
    "奥利奥麦旋风": "经典麦旋风",
    "草莓麦旋风": "经典麦旋风",
    "朱古力新地": "新地",
    "草莓新地": "新地",
    "迷你朱古力新地": "新地",
    "迷你草莓新地": "新地",
    "香芋派": "派",
    "菠萝派": "派",
    "脆脆薯条": "薯条",
    "雪菜脆笋鸡肉粥": "皮蛋鸡肉粥",
}

# 尺寸/块数等「横向变体」token，匹配时剥离（前端会用尺寸差异化渲染）
SIZE_TOKENS = [
    "迷你", "小杯", "中杯", "大杯", "小", "中", "大",
    "-2块", "-4块", "4块", "5块", "8块", "1块", "2块",
]


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
    """返回 (storeCode, storeName, source)。"""
    for code in CANDIDATE_STORES:
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


def fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://zhangjunzhe349-coder.github.io/"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def to_asset(raw: bytes, keep_png: bool) -> tuple:
    """原图字节 → (落盘字节, 扩展名, MIME 友好度)。全程在内存里转码，不产生临时文件。

    沙箱环境对 unlink/rename 有安全拦截，所以这里刻意只做「一次写入」。
    """
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
    ap.add_argument("--store", help="指定门店编码，跳过自动搜索")
    args = ap.parse_args()

    print("① 连接麦当劳官方 MCP，找一家营业中的门店…")
    if args.store:
        store, sname, src = args.store, args.store, "手动指定"
    else:
        store, sname, src = find_open_store()
    print(f"   → {sname} ({store}) · {src}")

    print("② 拉取门店菜单（含官方白底图）…")
    menu = mcp_call("query-meals", {"storeCode": store, "orderType": 1, "beType": 1})
    meals = (menu.get("data") or {}).get("meals") or {}
    if not meals:
        raise SystemExit("菜单为空")
    by_norm, by_norm_stripped = {}, {}
    for code, m in meals.items():
        nm, img = m.get("name"), m.get("image")
        if not nm or not img:
            continue
        by_norm.setdefault(norm(nm), (nm, img))
        by_norm_stripped.setdefault(norm(strip_size(nm)), (nm, img))
    print(f"   → 菜单 {len(meals)} 项，可用图 {len(by_norm)} 张")

    print("③ 与营养表 158 条对齐…")
    items = json.loads(NUTRITION.read_text(encoding="utf-8"))["items"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    photos, stats = {}, {"exact": 0, "alias": 0, "stripped": 0, "miss": 0}
    seen = {}          # 图片内容 sha1 → 已落盘相对路径（同一张图只存一份）
    miss_list = []
    for it in items:
        name = it["productName"]
        hit, how = None, None
        if norm(name) in by_norm:
            hit, how = by_norm[norm(name)], "exact"
        elif name in ALIAS and norm(ALIAS[name]) in by_norm:
            hit, how = by_norm[norm(ALIAS[name])], "alias"
        else:
            s = norm(strip_size(name))
            if s and s in by_norm_stripped:
                hit, how = by_norm_stripped[s], "stripped"
        if not hit:
            stats["miss"] += 1
            miss_list.append(name)
            continue
        menu_name, url = hit
        try:
            raw = fetch(url)
        except Exception as e:
            print(f"    ! 下载失败 {url} -> {e}")
            stats["miss"] += 1
            miss_list.append(name)
            continue
        if len(raw) < 800:
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
        photos[name] = {"src": rel, "from": menu_name, "how": how}
        stats[how] += 1

    payload = {
        "source": "麦当劳中国官方点餐菜单（MCP query-meals / menu-img.mcd.cn）",
        "store": store,
        "storeName": sname,
        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(photos),
        "total_items": len(items),
        "photos": photos,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    total_kb = sum(f.stat().st_size for f in OUT_DIR.glob("*") if f.is_file()) / 1024
    print(f"④ 完成：{len(photos)}/{len(items)} 条有官方图"
          f"（精确 {stats['exact']} · 别名 {stats['alias']} · 去尺寸词 {stats['stripped']} · 去重后 {len(seen)} 个文件），"
          f"{len(miss_list)} 条走手绘图标，共 {total_kb:.0f} KB")
    if miss_list:
        print("   无官方图（用手绘图标兜底）：" + "、".join(miss_list[:30])
              + ("…" if len(miss_list) > 30 else ""))


if __name__ == "__main__":
    main()
