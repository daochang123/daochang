#!/usr/bin/env python3
"""
频道视频抓取 → 关键帧 + 字幕（在 GitHub Actions runner 上运行）

产出结构（提交回仓库，供沙箱读取）：
  video_ingest/<video_id>/meta.json      # {id, title, url, frames, subs}
  video_ingest/<video_id>/frames/f_*.jpg # 每 frame_interval 秒一帧，缩放到 640 宽
  video_ingest/<video_id>/sub.*.vtt      # 自动/人工字幕（zh/en）

用法：python3 tools/ingest_videos.py <channel_url> <max_videos> <frame_interval> <max_frames>
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


def run(cmd, quiet=False, show_fail=True):
    if not quiet:
        print(">>", " ".join(cmd), flush=True)
    res = subprocess.run(cmd, capture_output=True, text=True)
    if show_fail and res.returncode != 0:
        print(f"   [rc={res.returncode}] stdout 尾部: {(res.stdout or '')[-1200:]}", flush=True)
        print(f"   [rc={res.returncode}] stderr 尾部: {(res.stderr or '')[-1500:]}", flush=True)
    return res


# ---------- 1. 拉取频道视频列表 ----------
print(f"[ingest] channel={channel} max_videos={max_videos} "
      f"interval={frame_interval}s max_frames={max_frames}", flush=True)
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
    run(["yt-dlp", *cookies, "--skip-download",
         "--write-auto-subs", "--write-subs", "--sub-langs", "zh.*,zh-Hans,en.*",
         "--convert-subs", "vtt", "-o", os.path.join(out, "sub"), url])

    # 2b. 视频（低清，减小体积）
    tmp = f"/tmp/{vid}.mp4"
    run(["yt-dlp", *cookies,
         "-f", "bv*[height<=480]/b[height<=480]/b",
         "--merge-output-format", "mp4", "-o", tmp, url])
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
    it["fetched_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(it, fh, ensure_ascii=False, indent=2)
    print(f"[ingest]   -> frames={it.get('frames')} subs={it['subs']}", flush=True)

# ---------- 3. 汇总索引 ----------
with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
    json.dump({"channel": channel, "count": len(items), "items": items},
              fh, ensure_ascii=False, indent=2)
print(f"\n[ingest] 完成，索引写入 {OUT}/index.json", flush=True)