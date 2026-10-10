#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建 index.html —— 把 src/index.template.html 与 data/nutrition.json 合成单文件页面。

为什么要合成单文件：
  比赛要求「零门槛体验入口：打开网页就能玩，不需要配置 Token」。
  内联数据后，index.html 双击即可运行，也能直接丢到 GitHub Pages / 网盘 / 微信里打开，
  不存在跨域、不存在额外请求、不存在数据缺失。

用法：
    python tools/build.py
"""
import json
import pathlib
import datetime
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "src" / "index.template.html"
DATA = ROOT / "data" / "nutrition.json"
OUT = ROOT / "index.html"
PLACEHOLDER = "__NUTRITION_JSON__"


def main() -> int:
    if not TEMPLATE.exists():
        print(f"[x] 找不到模板：{TEMPLATE}", file=sys.stderr)
        return 1
    if not DATA.exists():
        print(f"[x] 找不到数据：{DATA}（先跑一次抓取脚本）", file=sys.stderr)
        return 1

    tpl = TEMPLATE.read_text(encoding="utf-8")
    if PLACEHOLDER not in tpl:
        print(f"[x] 模板里没有占位符 {PLACEHOLDER}", file=sys.stderr)
        return 1

    payload = json.loads(DATA.read_text(encoding="utf-8"))
    payload["built_at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")

    # 紧凑序列化，并切断可能出现的 </script> 序列，避免提前闭合脚本块
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    blob = blob.replace("</", "<\\/")

    html = tpl.replace(PLACEHOLDER, blob)
    OUT.write_text(html, encoding="utf-8", newline="\n")

    kb = OUT.stat().st_size / 1024
    print(f"[ok] 已生成 {OUT}")
    print(f"     餐品数 {payload['count']} 条 | 文件大小 {kb:.1f} KB | 单文件、零依赖、可离线打开")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
