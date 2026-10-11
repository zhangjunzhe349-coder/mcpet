#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建 index.html —— 把 src/index.template.html 与 data/ 下的数据合成单文件页面。

为什么要合成单文件：
  比赛要求「零门槛体验入口：打开网页就能玩，不需要配置 Token」。
  内联数据后，index.html 双击即可运行，也能直接丢到 GitHub Pages / 网盘 / 微信里打开，
  不存在跨域、不存在额外请求、不存在数据缺失。

内联的三份数据：
  __NUTRITION_JSON__   158 条餐品营养值（官方 MCP list-nutrition-foods）
  __FOOD_PHOTOS_JSON__  官方白底图索引（官方 MCP query-meals，本地 assets/food/）
  __RANK_INDEX_JSON__   实时榜单的「仓库地址索引 + 离线快照」（比赛仓库 RANKING.md）

用法：
    python tools/build.py
"""
import json
import pathlib
import datetime
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "src" / "index.template.html"
OUT = ROOT / "index.html"

# 占位符 → (数据文件, 缺失时是否致命)
DATASETS = [
    ("__NUTRITION_JSON__", ROOT / "data" / "nutrition.json", True),
    ("__FOOD_PHOTOS_JSON__", ROOT / "data" / "food-photos.json", False),
    ("__RANK_INDEX_JSON__", ROOT / "data" / "rank-index.json", False),
]

# 局部源码（.part.js）已手工并入模板。这里做一次"防漂移"体检：
# 若两者出现不一致，说明有人只改了其中一个，必须修模板（模板才是构建源）。
PARTIALS = [
    ("src/icons.part.js", "食物视觉系统（v2）"),
    ("src/rank.part.js", "实时排行榜"),
]


def check_partials(tpl: str) -> list[str]:
    """返回告警列表。只提示，不阻断构建。"""
    warns: list[str] = []
    for rel, banner in PARTIALS:
        p = ROOT / rel
        if not p.exists():
            warns.append(f"{rel} 不存在（模板里已内联，跳过体检）")
            continue
        src = p.read_text(encoding="utf-8")
        if banner not in tpl or banner not in src:
            warns.append(f"{rel} 与模板的锚点「{banner}」对不上，请人工核对")
            continue
        if src.strip() and src.strip() not in tpl:
            warns.append(
                f"{rel} 与模板内容不一致 —— 改了 .part.js 就必须同步改 "
                f"src/index.template.html（模板才是构建源，否则改动不生效）"
            )
    return warns


def main() -> int:
    if not TEMPLATE.exists():
        print(f"[x] 找不到模板：{TEMPLATE}", file=sys.stderr)
        return 1

    tpl = TEMPLATE.read_text(encoding="utf-8")
    for w in check_partials(tpl):
        print(f"[!] {w}", file=sys.stderr)
    html = tpl
    report = []

    for placeholder, path, required in DATASETS:
        if placeholder not in tpl:
            print(f"[!] 模板里没有占位符 {placeholder}，跳过", file=sys.stderr)
            continue
        if not path.exists():
            if required:
                print(f"[x] 找不到数据：{path}（先跑对应的抓取脚本）", file=sys.stderr)
                return 1
            print(f"[!] 缺少可选数据 {path}，以空对象占位")
            payload = {}
        else:
            payload = json.loads(path.read_text(encoding="utf-8"))
        if placeholder == "__NUTRITION_JSON__":
            payload["built_at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
            report.append(f"餐品 {payload.get('count')} 条")
        elif placeholder == "__FOOD_PHOTOS_JSON__":
            report.append(f"官方图 {payload.get('count', 0)}/{payload.get('total_items', 0)} 条")
        elif placeholder == "__RANK_INDEX_JSON__":
            report.append(f"榜单快照 {len(payload.get('snapshot', []))} 条 / 仓库索引 {len(payload.get('repos', {}))} 个")
        # 紧凑序列化，并切断可能出现的 </script> 序列，避免提前闭合脚本块
        blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        blob = blob.replace("</", "<\\/")
        html = html.replace(placeholder, blob)

    OUT.write_text(html, encoding="utf-8", newline="\n")
    kb = OUT.stat().st_size / 1024
    print(f"[ok] 已生成 {OUT}")
    print("     " + " | ".join(report))
    print(f"     文件大小 {kb:.1f} KB | 单文件、零依赖、可离线打开")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
