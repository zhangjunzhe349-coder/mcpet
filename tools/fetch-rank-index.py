#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 data/rank-index.json —— 实时榜单的「仓库地址索引 + 离线快照」。

背景
----
榜单 RANKING.md 只给三样东西：项目名称、打码后的 Owner 昵称、Star 数，
**不给仓库链接**。所以要让「点榜单行 → 跳对应 GitHub 仓库」成立，
就必须自己把「项目名称 → owner/repo」这层映射补出来。
映射来源：比赛报名 Issue 的正文（里面有「项目地址：https://github.com/...」）。

数据来源（都走 api.github.com，不需要 Token）：
  ① contents/RANKING.md          → 榜单快照（markdown 表格）
  ② issues?state=all&per_page=100 → 报名 Issue 清单（正文里抽项目地址）

缓存
----
仓库根目录下的 _rk.md（RANKING.md 原文）与 _issues_all.json（Issue 清单）
存在时直接复用 —— 所以断网也能重跑，也方便复现历史某一刻的榜单。

用法
----
    python tools/fetch-rank-index.py            # 有缓存用缓存
    python tools/fetch-rank-index.py --refresh   # 强制重新联网抓取
"""
import json
import os
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "rank-index.json"
CACHE_MD = ROOT / "_rk.md"
CACHE_ISSUES = ROOT / "_issues_all.json"

API = "https://api.github.com"
REPO = "M-China/mcd-developer-innovation-challenge"
SOURCE_URL = f"https://raw.githubusercontent.com/{REPO}/main/RANKING.md"
REPO_INDEX_URL = f"{API}/repos/{REPO}/contents/RANKING.md"
MY_REPO = "zhangjunzhe349-coder/mcpet"
# 本项目在榜单里可能出现的几种叫法（产品改过名），全部指回自己的仓库，
# 保证「我在哪」在任何命名口径下都能定位到本行。
MY_ALIASES = ["mcpet", "麦麦营养账本", "麦麦宠物", "麦麦宠物 (mcpet)", "麦麦营养账本 (mcpet)"]

# owner/repo 都只可能是 ASCII；用「非 ASCII 即停」的字符类，
# 天然能把「...mcd-tea-captain项目简介」这种粘连的尾巴切掉。
GH_URL = re.compile(r"https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)")
ADDR_LINE = re.compile(r"项目地址\s*[:：]\s*([^\s]+)")
NAME_LINE = re.compile(r"项目名称\s*[:：]\s*(.+?)(?=\s*(?:项目地址|项目简介|项目描述|仓库|$))", re.M)
PAREN = re.compile(r"[（(]([A-Za-z0-9_.\- ]{3,})[)）]")
# 键的合法性：不能是「解析翻车」的残渣（带冒号/URL/超长），也不能太泛
BAD_KEY = re.compile(r"[:：/\s]|https?|github|项目|【|】")


def fetch(url: str) -> str:
    """带代理的极简抓取（沙箱里 api.github.com 是通的）。"""
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "mcpet-rank-index/1.0",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def load_ranking_md(refresh: bool) -> str:
    if CACHE_MD.exists() and not refresh:
        return CACHE_MD.read_text(encoding="utf-8")
    import base64
    obj = json.loads(fetch(f"{API}/repos/{REPO}/contents/RANKING.md"))
    md = base64.b64decode(obj["content"]).decode("utf-8")
    CACHE_MD.write_text(md, encoding="utf-8", newline="\n")
    return md


def load_issues(refresh: bool) -> list:
    if CACHE_ISSUES.exists() and not refresh:
        return json.loads(CACHE_ISSUES.read_text(encoding="utf-8"))
    out, page = [], 1
    while True:
        txt = fetch(f"{API}/repos/{REPO}/issues?state=all&per_page=100&page={page}")
        batch = json.loads(txt)
        if not batch:
            break
        out.extend(batch)
        if len(batch) < 100 or page >= 10:
            break
        page += 1
    CACHE_ISSUES.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def parse_ranking(md: str):
    """解析 RANKING.md 的表格 → 快照 + 更新时间。"""
    rows, updated = [], ""
    for line in md.splitlines():
        if "|" not in line:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4:
            continue
        if not cells[0].isdigit() or not cells[3].isdigit():
            continue
        rows.append({"rank": int(cells[0]), "name": cells[1], "stars": int(cells[3])})
    m = re.search(r"更新时间\s*[:：]\s*(.+)", md)
    if m:
        updated = m.group(1).strip()
    return rows, updated


def norm_repo(url: str):
    """从一段文本里取第一个 github.com/owner/repo，归一化成 owner/repo。"""
    m = GH_URL.search(url or "")
    if not m:
        return ""
    owner, repo = m.group(1), m.group(2)
    repo = re.sub(r"\.git$", "", repo.rstrip(".-"))
    if not owner or not repo:
        return ""
    return f"{owner}/{repo}"


def parse_issues(issues: list):
    """→ {小写名称: owner/repo}。同时登记「项目名称」与「括号里的英文名」两种键。"""
    repos, owners = {}, {}
    for it in issues:
        body = it.get("body") or ""
        title = it.get("title") or ""

        # 优先取「项目地址」那一行的 URL；取不到再退到全文第一个 github 链接
        m = ADDR_LINE.search(body)
        full = norm_repo(m.group(1)) if m else ""
        if not full:
            full = norm_repo(body)
        if not full:
            continue

        keys = set()
        nm = NAME_LINE.search(body)
        if nm:
            label = nm.group(1).strip()
            keys.add(label.lower())
            for alt in PAREN.findall(label):          # 「麦麦校园搭子 (McCampusCombo)」
                keys.add(alt.strip().lower())
        # 榜单里的「项目名称」实际是仓库名风格，所以仓库名本身也是键
        keys.add(full.split("/")[-1].lower())
        if title:
            keys.add(re.sub(r"^【[^】]*】\s*", "", title).strip().lower())
            for alt in PAREN.findall(title):
                keys.add(alt.strip().lower())

        mine = full.lower() == MY_REPO.lower()
        for k in keys:
            k = k.strip()
            if len(k) < 3 or len(k) > 40 or BAD_KEY.search(k):
                continue
            # 本项目名称必须永远指向自己的仓库（避免被同名项目抢先占位）
            if mine:
                repos[k] = full
            else:
                repos.setdefault(k, full)
        owners.setdefault(full.split("/")[0].lower(), full)

    return repos, owners


def main() -> int:
    refresh = "--refresh" in sys.argv
    try:
        md = load_ranking_md(refresh)
        issues = load_issues(refresh)
    except Exception as e:
        print(f"[x] 取数据失败：{e}", file=sys.stderr)
        return 1

    snap, updated = parse_ranking(md)
    repos, _owners = parse_issues(issues)

    # 本项目别名强制回指自己的仓库
    for alias in MY_ALIASES:
        repos[alias.lower()] = MY_REPO

    # 自检：映射值必须是纯 ASCII 的 owner/repo（防止「…项目简介」粘尾）
    bad = {k: v for k, v in repos.items() if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", v)}
    if bad:
        print(f"[!] {len(bad)} 条映射格式可疑，已剔除：", file=sys.stderr)
        for k, v in list(bad.items())[:10]:
            print(f"    {k!r} -> {v!r}", file=sys.stderr)
        for k in bad:
            repos.pop(k, None)

    matched = sum(1 for r in snap if r["name"].lower() in repos)

    data = {
        "source": "麦当劳程序员创意开发大赛 · 官方实时排行榜（RANKING.md）",
        "sourceUrl": SOURCE_URL,
        "repoIndexUrl": REPO_INDEX_URL,
        "updated": updated,
        "repos": repos,
        "snapshot": snap,
        "myRepo": MY_REPO,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")

    print(f"[ok] 已生成 {OUT}")
    print(f"     榜单快照 {len(snap)} 条 | 仓库索引 {len(repos)} 个 | 快照命中仓库 {matched}/{len(snap)}")
    print(f"     更新时间 {updated or '—'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
