#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 GitHub Git Data API 推送本地提交（当 `git push` 走不通时的可靠兜底）。

为什么需要它
------------
本机到 `github.com:443` 的 git 通道时通时不通，实测过两种表现：
  · `fatal: unable to access ...: Empty reply from server`
  · 更隐蔽的「退出码 0、输出为空，但远端其实没更新」（`git ls-remote` 返回空）
而 `api.github.com` 一直是通的，所以改走 Git Data API：

    /git/blobs  →  /git/trees  →  /git/commits  →  PATCH /git/refs/heads/main

关键约束（都是踩过的坑）
------------------------
1. **blob 内容必须来自 `git cat-file blob <sha>`，绝不能读工作区文件。**
   工作区可能被 CRLF 转换过，字节与 git 对象库不一致，会导致推上去的 tree
   与本地对不上（那时只能逐文件算 sha1 才能定位）。
2. **删除文件要显式带 `"sha": null`**，否则 base_tree 会把它保留下来。
3. **`author.date` / `committer.date` 必须传 UTC 的 `...Z`**。
   传带偏移的 ISO（`+08:00`）会被静默忽略、改用服务器当前时间，
   于是算出的 commit SHA 与本地不一致。
4. **逐个提交推，不要压成一个**。早期版本拿 diff(base, head) 一次性建树，
   结果远端只剩一个 squash 提交、把中间那条详细的提交信息丢了。
   现在按 `git rev-list --reverse base..head` 依次建 tree/commit，
   并且每一步都校验 SHA 与本地相同 —— 全绿时远端历史与本地历史完全一致。
5. 每步都带**自校验**：blob sha / tree sha / commit sha 对不上就告警或中止。

用法
----
    export GH_TOKEN="<有 repo 写权限的 token>"
    python tools/push-via-api.py              # 推当前分支
    python tools/push-via-api.py --dry-run    # 只算不发
    python tools/push-via-api.py --align      # 只对齐：把远端提交对象在本地重建
"""
import argparse
import base64
import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.github.com"
MAX_BLOB_BYTES = 90 * 1024 * 1024   # GitHub 单 blob 上限 100MB，留余量


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def git(*args: str, check: bool = True, stdin: bytes = None) -> bytes:
    r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, input=stdin)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{r.stderr.decode('utf-8', 'replace')}")
    return r.stdout


def api(method: str, path: str, token: str, payload=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "mcpet-push-via-api/1.0",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"{method} {url} → HTTP {e.code}: {detail}") from None


def repo_slug() -> str:
    url = git("config", "--get", "remote.origin.url").decode().strip()
    slug = url.split("github.com/")[-1]
    return slug[:-4] if slug.endswith(".git") else slug


def changed_paths(base: str, head: str):
    """→ [(status, path)]，用 -z 防止中文/空格路径被转义破坏。"""
    parts = git("diff-tree", "-r", "--no-commit-id", "--name-status", "-z", base, head)\
        .decode("utf-8").split("\0")
    out, i = [], 0
    while i < len(parts):
        st = parts[i]
        if not st:
            break
        if st[0] in "RC":                      # 重命名/复制：旧路径 新路径
            out.append((st[0], parts[i + 2]))
            i += 3
        else:
            out.append((st[0], parts[i + 1]))
            i += 2
    return out


def entry_map(rev: str):
    """某个提交里全部条目的 {path: (mode, sha)}。"""
    m = {}
    for rec in git("ls-tree", "-r", "-z", rev).decode("utf-8").split("\0"):
        if not rec:
            continue
        meta, _, path = rec.partition("\t")
        mode, _typ, sha = meta.split()
        m[path] = (mode, sha)
    return m


def iso_to_utc_z(date: str) -> str:
    """2026-10-12T00:23:13+08:00 → '2026-10-11T16:23:13Z'（GitHub 只认这种）"""
    dt = datetime.datetime.fromisoformat(date.replace("Z", "+00:00"))
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def commit_meta(rev: str):
    raw = git("log", "-1", "--pretty=%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI%x00%B", rev)\
        .decode("utf-8")
    an, ae, cn, ce, aI, cI, msg = raw.split("\x00", 6)
    return {
        "author": {"name": an, "email": ae, "date": iso_to_utc_z(aI)},
        "committer": {"name": cn, "email": ce, "date": iso_to_utc_z(cI)},
        "message": msg,
    }


# --------------------------------------------------------------------------- #
# 推送
# --------------------------------------------------------------------------- #
def push_chain(token: str, slug: str, branch: str, base: str, head: str,
               dry_run: bool, force: bool = False) -> int:
    revs = git("rev-list", "--reverse", f"{base}..{head}").decode().split()
    if not revs:
        print(f"[=] 远端 {branch} 已是最新（{head[:8]}），无需推送")
        return 0
    print(f"  待推提交 {len(revs)} 个：" + " → ".join(r[:8] for r in revs))

    uploaded, remote_parent = set(), base
    for rev in revs:
        parent = git("rev-parse", f"{rev}^").decode().strip()
        parent_tree = git("rev-parse", f"{parent}^{{tree}}").decode().strip()
        local_tree = git("rev-parse", f"{rev}^{{tree}}").decode().strip()
        meta = commit_meta(rev)
        heads = entry_map(rev)

        # ① blob：只上传没传过的（同一内容只传一次）
        tree_entries = []
        for status, path in changed_paths(parent, rev):
            if status == "D":
                tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
                continue
            if path not in heads:
                print(f"  [!] {rev[:8]} 的 {path} 在 tree 里找不到，跳过", file=sys.stderr)
                continue
            mode, sha = heads[path]
            if sha not in uploaded:
                blob = git("cat-file", "blob", sha)      # 必须走对象库，不能读工作区
                if len(blob) > MAX_BLOB_BYTES:
                    print(f"  [x] {path} 超过单 blob 上限，请改用 git push", file=sys.stderr)
                    return 1
                if not dry_run:
                    res = api("POST", f"/repos/{slug}/git/blobs", token,
                              {"content": base64.b64encode(blob).decode("ascii"), "encoding": "base64"})
                    if res["sha"] != sha:
                        print(f"  [x] {path} blob sha 不一致", file=sys.stderr)
                        return 1
                uploaded.add(sha)
            tree_entries.append({"path": path, "mode": mode, "type": "blob", "sha": sha})

        subject = meta["message"].splitlines()[0][:52] if meta["message"] else "(空)"
        print(f"  {rev[:8]} · {len(tree_entries)} 项变更 · {subject}")

        if dry_run:
            continue

        # ② tree：base_tree 必须是父提交的 tree（且它在远端已存在）
        base_tree_remote = api("GET", f"/repos/{slug}/git/commits/{remote_parent}", token)["tree"]["sha"]
        if base_tree_remote != parent_tree:
            print(f"  [!] 父提交 tree 不一致（远端 {base_tree_remote[:8]} / 本地 {parent_tree[:8]}）",
                  file=sys.stderr)
        new_tree = api("POST", f"/repos/{slug}/git/trees", token,
                       {"base_tree": base_tree_remote, "tree": tree_entries})
        if new_tree["sha"] != local_tree:
            print(f"  [!] {rev[:8]} 的 tree 与本地不一致"
                  f"（远端 {new_tree['sha'][:8]} / 本地 {local_tree[:8]}）—— 内容相同但 SHA 会分叉",
                  file=sys.stderr)

        # ③ commit
        new_commit = api("POST", f"/repos/{slug}/git/commits", token, {
            "message": meta["message"].rstrip("\n"),
            "tree": new_tree["sha"],
            "parents": [remote_parent],
            "author": meta["author"],
            "committer": meta["committer"],
        })
        if new_commit["sha"] != rev:
            print(f"  [!] {rev[:8]} 生成的提交 SHA 与本地不一致（远端 {new_commit['sha'][:8]}）",
                  file=sys.stderr)
        remote_parent = new_commit["sha"]

    if dry_run:
        print("[dry-run] 未发送任何请求")
        return 0

    api("PATCH", f"/repos/{slug}/git/refs/heads/{branch}", token,
        {"sha": remote_parent, "force": bool(force)})
    print(f"[ok] 已推送 {branch}: {base[:8]} → {remote_parent[:8]}")
    if remote_parent == head:
        print("     远端历史与本地完全一致 ✓")
    else:
        print("     远端内容与本地相同、SHA 分叉；跑 --align 一步对齐")
    return 0


# --------------------------------------------------------------------------- #
# 对齐：用 API 把远端提交对象在本地精确重建
# --------------------------------------------------------------------------- #
def align(token: str, slug: str, branch: str) -> int:
    """本机 git→github.com 不通，`git fetch` 也用不了，于是用 API 重建远端对象。

    **重建是搜索 + 自校验的：算出的 SHA 必须等于远端 SHA 才写入本地对象库**，
    所以不存在写错的可能。要搜索是因为 `/git/commits` 返回的 date 是 UTC（`...Z`），
    原始时区偏移（例如 `+0800`）已经丢了，只能把几种偏移/结尾换行组合都试一遍。
    """
    remote = api("GET", f"/repos/{slug}/git/ref/heads/{branch}", token)["object"]["sha"]
    if git("cat-file", "-t", remote, check=False).strip() == b"commit":
        print(f"[=] 远端提交 {remote[:8]} 本地已存在，无需重建")
    else:
        c = api("GET", f"/repos/{slug}/git/commits/{remote}", token)
        ts = int(datetime.datetime.fromisoformat(
            c["author"]["date"].replace("Z", "+00:00")).timestamp())
        msg = c["message"].encode("utf-8")
        print(f"  远端提交 {remote[:8]} 本地没有，开始重建（message {len(msg)} 字节）")
        hit = None
        for tz in ("+0000", "+0800", "-0000"):
            for body in (msg, msg.rstrip(b"\n")):
                for tail in (b"", b"\n"):
                    cand = (
                        f"tree {c['tree']['sha']}\n"
                        + "".join(f"parent {p['sha']}\n" for p in c.get("parents", []))
                        + f"author {c['author']['name']} <{c['author']['email']}> {ts} {tz}\n"
                        + f"committer {c['committer']['name']} <{c['committer']['email']}> {ts} {tz}\n\n"
                    ).encode("utf-8") + body + tail
                    if git("hash-object", "-t", "commit", "--stdin", stdin=cand).decode().strip() == remote:
                        hit = cand
                        break
                if hit:
                    break
            if hit:
                break
        if not hit:
            print("[x] 重建失败：候选组合都没命中远端 SHA。", file=sys.stderr)
            print(f"    两侧内容仍然一致（tree 相同 = {c['tree']['sha'][:8]}）。", file=sys.stderr)
            print("    可选收敛方式：本地建一个 tree 相同的提交，再用 force 更新 ref。", file=sys.stderr)
            return 1
        git("hash-object", "-t", "commit", "-w", "--stdin", stdin=hit)
        print(f"[ok] 已重建远端提交对象 {remote[:8]}（自校验通过）")

    git("config", f"branch.{branch}.remote", "origin")
    git("config", f"branch.{branch}.merge", f"refs/heads/{branch}")
    git("update-ref", f"refs/remotes/origin/{branch}", remote)
    git("reset", "--hard", remote)
    print(f"[ok] 本地 {branch} 已对齐远端：{git('rev-parse', 'HEAD').decode().strip()[:8]}")
    return 0


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只算不发")
    ap.add_argument("--align", action="store_true", help="只做对齐（重建远端提交对象）")
    ap.add_argument("--force", action="store_true",
                    help="允许非快进推送（仅用于修掉自己刚推坏的历史，会丢弃远端独有的提交）")
    ap.add_argument("--branch", default=None, help="默认取当前分支")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        print("[x] 请先 export GH_TOKEN=<有 repo 写权限的 token>", file=sys.stderr)
        return 1

    branch = args.branch or git("rev-parse", "--abbrev-ref", "HEAD").decode().strip()
    slug = repo_slug()

    if args.align:
        return align(token, slug, branch)

    head = git("rev-parse", "HEAD").decode().strip()
    remote_sha = api("GET", f"/repos/{slug}/git/ref/heads/{branch}", token)["object"]["sha"]
    if remote_sha == head:
        print(f"[=] 远端 {branch} 已经是最新（{head[:8]}），无需推送")
        return 0

    # base 取 merge-base：既能正常快进推，也能在 --force 下把远端改回正确历史
    base = git("merge-base", remote_sha, head).decode().strip()
    ff = base == remote_sha
    if not ff and not args.force:
        behind = git("rev-list", "--count", f"{head}..{remote_sha}").decode().strip()
        print(f"[x] 非快进：远端 {branch} 上有 {behind} 个本地没有的提交（{remote_sha[:8]}）",
              file=sys.stderr)
        print("    确认这些提交可以丢弃时，加 --force 重跑（会同时丢弃远端独有的提交）",
              file=sys.stderr)
        return 1
    if not ff:
        print(f"[!] 非快进推送（--force）：远端 {remote_sha[:8]} 将被 {head[:8]} 取代"
              f"（分叉点 {base[:8]}）")

    print(f"仓库 {slug} · 分支 {branch}")
    print(f"  {base[:8]} → {head[:8]}" + ("" if ff else "  [force]"))
    return push_chain(token, slug, branch, base, head, args.dry_run, args.force)


if __name__ == "__main__":
    raise SystemExit(main())
