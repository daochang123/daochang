#!/usr/bin/env python3
"""
频道视频抓取 → 关键帧 + 字幕（在 GitHub Actions runner 上运行）

产出结构（提交回仓库，供沙箱读取）：
  video_ingest/<video_id>/meta.json      # {id, title, url, frames, subs, strategy}
  video_ingest/<video_id>/frames/f_*.jpg # 每 frame_interval 秒一帧，缩放到 640 宽
  video_ingest/<video_id>/sub.*.vtt      # 自动/人工字幕（zh/en）

用法：python3 tools/ingest_videos.py <channel_url> <max_videos> <frame_interval> <max_frames>

说明：GitHub 机房 IP 会触发 YouTube「Sign in to confirm you're not a bot」风控，
     脚本按策略链依次尝试播放器客户端；若全部失败，需配置 YT_COOKIES 密钥。
"""
import glob
import json
import os
import subprocess
import sys
import time

channel = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/@ETH88K/videos"
max_videos = int(sys.argv[2]) if len(sys.argv) > 2 else 6
frame_interval = int(sys.argv[3]) if len(sys.argv) > 3 else 20
max_frames = int(sys.argv[4]) if len(sys.argv) > 4 else 80

cookies = ["--cookies", "cookies.txt"] if os.path.exists("cookies.txt") else []
OUT = "video_ingest"
os.makedirs(OUT, exist_ok=True)


def run(cmd, quiet=False):
    if not quiet:
        print(">>", " ".join(cmd), flush=True)
    return subprocess.run(cmd, capture_output=True, text=True)


# YouTube 反爬规避策略链：默认 → tv → web_embedded → ios
STRATEGIES = [
    [],
    ["--extractor-args", "youtube:player_client=tv"],
    ["--extractor-args", "youtube:player_client=web_embedded"],
    ["--extractor-args", "youtube:player_client=ios"],
]
_working = None


def yt(args, url):
    """按策略链尝试 yt-dlp；命中后记住可用策略，后续复用。"""
    global _working
    tries = [_working] if _working is not None else STRATEGIES
    last = None
    for st in tries:
        last = run(["yt-dlp", *cookies, *st, *args, url])
        if last.returncode == 0:
            if _working is None:
                _working = st
                print(f"[ingest]   命中可用策略: {st or '默认'}", flush=True)
            return last
        tail = (last.stderr or "").strip().splitlines()
        print(f"   [rc={last.returncode}] 策略 {st or '默认'} 失败: {tail[-1] if tail else ''}",
              flush=True)
    return last


# ---------- 1. 拉取频道视频列表 ----------
print(f"[ingest] channel={channel} max_videos={max_videos} "
      f"interval={frame_interval}s max_frames={max_frames} "
      f"cookies={'有' if cookies else '无'}", flush=True)
r = run(["yt-dlp", "--flat-playlist", "--no-warnings", "--ignore-errors",
         "--print", "%(id)s\t%(title)s", *cookies, channel])
lines = [l for l in r.stdout.splitlines() if l.strip()]
if not lines:
    print("[ingest] 列表抓取失败，stderr 尾部：", flush=True)
    print(r.stderr[-3000:], flush=True)
    sys.exit(1)

items = []
for l in lines[:max_videos]:
    parts = l.split("\t", 1)
    items.append({"id": parts[0].strip(),
                  "title": (parts[1].strip() if len(parts) > 1 else parts[0].strip())})
print(f"[ingest] 待处理 {len(items)} 个视频", flush=True)

# ---------- 2. 逐个下载 + 抽帧 + 字幕 ----------
for idx, it in enumerate(items, 1):
    vid = it["id"]
    out = os.path.join(OUT, vid)
    fdir = os.path.join(out, "frames")
    os.makedirs(fdir, exist_ok=True)
    url = f"https://www.youtube.com/watch?v={vid}"
    it["url"] = url
    print(f"\n[ingest] ({idx}/{len(items)}) {vid} {it['title'][:40]}", flush=True)

    # 2a. 字幕（自动 + 人工，vtt）
    yt(["--skip-download", "--write-auto-subs", "--write-subs",
        "--sub-langs", "zh.*,zh-Hans,en.*", "--convert-subs", "vtt",
        "-o", os.path.join(out, "sub")], url)

    # 2b. 视频（低清，减小体积）
    tmp = f"/tmp/{vid}.mp4"
    yt(["-f", "bv*[height<=480]/b[height<=480]/b", "--merge-output-format", "mp4",
        "-o", tmp], url)
    src = tmp if os.path.exists(tmp) else (glob.glob(f"/tmp/{vid}.*") or [None])[0]

    # 2c. 抽帧
    if src and os.path.exists(src):
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", src,
             "-vf", f"fps=1/{frame_interval},scale=640:-2", "-q:v", "6",
             os.path.join(fdir, "f_%04d.jpg")])
        frames = sorted(glob.glob(os.path.join(fdir, "*.jpg")))
        for f in frames[max_frames:]:
            os.remove(f)
        it["frames"] = len(glob.glob(os.path.join(fdir, "*.jpg")))
        try:
            os.remove(src)
        except OSError:
            pass
    else:
        it["frames"] = 0
        print("[ingest] 视频下载失败（诊断见上方 yt-dlp 输出）", flush=True)

    it["subs"] = [os.path.basename(p) for p in glob.glob(os.path.join(out, "sub*.vtt"))]
    it["strategy"] = _working or []
    it["fetched_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(it, fh, ensure_ascii=False, indent=2)
    print(f"[ingest]   -> frames={it.get('frames')} subs={it['subs']}", flush=True)

# ---------- 3. 汇总索引 ----------
with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
    json.dump({"channel": channel, "count": len(items), "items": items},
              fh, ensure_ascii=False, indent=2)
print(f"\n[ingest] 完成，索引写入 {OUT}/index.json", flush=True)