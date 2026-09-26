#!/usr/bin/env bash
# 跑全 benchmark（a/b/c/d 共 69 个任务）并出汇总。
#
#   bash run-all.sh                     # 全部类别；跳过已有结果（断点续跑）
#   bash run-all.sh --groups a,b        # 只跑 A/B 类
#   bash run-all.sh --limit 3           # 每类只跑前 3 个（试跑）
#   bash run-all.sh --rerun             # 不跳过已有结果（重跑全部）
#   bash run-all.sh --no-audit          # 跳过独立审计（省约一半时间）
#   bash run-all.sh --videos            # 跑完后为每个任务出复盘视频（很花时间/磁盘）
#   bash run-all.sh --dry-run           # 只打印计划，不跑任何任务
#
# 前置条件：**屏幕独占**（Agent 会真动键鼠）；跑之前关掉别的占屏或抢 CPU 的活。
# 断点续跑：中断后直接重跑同一条命令即可 —— 有 results/<任务>.json 的会被跳过。
set -uo pipefail

EVAL_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE_WSL='/mnt/c/Users/Administrator/Desktop/RealtimeGUIBench_人类评测_志愿者包/RealtimeGUIBench-人类评测'
REC_DIR='/mnt/c/Users/Administrator/dsh-cu-recordings'
VID_DIR="$EVAL_DIR/videos"
NODE_WIN='/mnt/c/Program Files/nodejs/node.exe'
CDP_WIN='C:\Users\Administrator\dsh-cu-eval-tools\cdp.mjs'
PROFILE_WIN='C:\Users\Administrator\dsh-cu-eval-profile'
CHROME='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'

# 注意：变量名不能用 GROUPS —— 它是 bash 的特殊只读变量（当前用户的组 ID 列表），赋值会被静默忽略。
GROUP_LIST='a,b,c,d'; LIMIT=''; SKIP_DONE=1; AUDIT=1; VIDEOS=0; DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --groups) GROUP_LIST="${2:-}"; shift ;;
    --limit) LIMIT="${2:-}"; shift ;;
    --rerun) SKIP_DONE=0 ;;
    --no-audit) AUDIT=0 ;;
    --videos) VIDEOS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
  shift
done

NODE_ARGS=(--groups "$GROUP_LIST" --timeout 0 --keep-open)
[ "$SKIP_DONE" = "1" ] && NODE_ARGS+=(--skip-done)
[ "$AUDIT" = "0" ] && NODE_ARGS+=(--no-audit)
[ -n "$LIMIT" ] && NODE_ARGS+=(--limit "$LIMIT")

if [ "$DRY_RUN" = "1" ]; then
  node "$EVAL_DIR/run-c-tasks.mjs" "${NODE_ARGS[@]}" --dry-run
  exit 0
fi

cdp() { echo "$1" | timeout 30 "$NODE_WIN" "$CDP_WIN" 2>&1; }

# ── 1) 静态服务（Windows 侧；8765 可能被别的程序占用，故从 8765 探到 8785） ─────
probe_server() {
  powershell.exe -NoProfile -Command "foreach (\$p in 8765..8785) { try { \$r = Invoke-WebRequest -Uri ('http://localhost:' + \$p + '/c/C1_Double_Jump/index.html') -TimeoutSec 2 -UseBasicParsing; Write-Output \$p } catch { } }" 2>/dev/null | tr -d '\r' | head -1
}
PORT="$(probe_server)"
if [ -z "$PORT" ]; then
  echo "没有静态服务，在 8765-8785 起一个…"
  ( cd "$SITE_WSL" && setsid nohup powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\_serve.ps1' -NoBrowser > /tmp/serve-eval.log 2>&1 & )
  sleep 6
  PORT="$(grep -o 'localhost:[0-9]*' /tmp/serve-eval.log | head -1 | cut -d: -f2)"
  [ -z "$PORT" ] && { echo "起服务失败："; cat /tmp/serve-eval.log; exit 1; }
fi
echo "静态服务：http://localhost:$PORT/"

# ── 1.5) Computer Use 插件（随本仓库分发） ────────────────────────────────
# 插件完整代码内嵌在本仓库 plugin/ 目录（插件名 computer-use-plugin），与 harness 同版本分发，
# 无需独立同步。复现时把它 link 安装进评测 DSH_HOME（见 README「复现」节）。
PLUGIN_DIR="$EVAL_DIR/../plugin"

# ── 2) 专用 Chrome（无地址栏） ─────────────────────────────────────────────
if cdp '{"op":"status"}' | grep -q '"ok":true'; then
  echo "评测 Chrome 已在跑"
else
  echo "启动评测 Chrome…"
  ( setsid nohup "$CHROME" --remote-debugging-port=9333 --user-data-dir="$PROFILE_WIN" \
      --app="http://localhost:$PORT/c/A1_Concentration/index.html" --start-maximized > /tmp/eval-chrome.log 2>&1 & )
  for _ in $(seq 1 20); do sleep 2; cdp '{"op":"status"}' | grep -q '"ok":true' && break; done
fi
cdp '{"op":"status"}' | grep -q '"ok":true' || { echo "Chrome/CDP 不可用，放弃"; exit 1; }

# 前台 + 全屏：两条都成立才开跑（只查「在前台」会漏掉「窗口只占半屏」——2026-09-25 实测）。
ACT="$(cdp '{"op":"activate"}')"
echo "窗口：$ACT"
echo "$ACT" | grep -q '"match":true'      || { echo "中止：游戏窗口不在前台 → $ACT"; exit 1; }
echo "$ACT" | grep -q '"fullscreen":true' || { echo "中止：游戏窗口没铺满屏幕 → $ACT"; exit 1; }

# ── 3) 跑任务（任务级参数透传给主脚本；每个任务异常不中断整轮） ──────────────
RUN_START="$(date +%s)"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$EVAL_DIR/run-all-$STAMP.log"
echo "开始：类别 $GROUP_LIST；日志 $LOG"
node "$EVAL_DIR/run-c-tasks.mjs" "${NODE_ARGS[@]}" 2>&1 | tee "$LOG"

# ── 4) 可选：为本次新增的结果出复盘视频 ─────────────────────────────────────
if [ "$VIDEOS" = "1" ]; then
  mkdir -p "$VID_DIR"
  LIST="$(mktemp)"
  # 本次运行新写出的结果 JSON（按 mtime 判定），取任务名、录像文件、会话 id。
  find "$EVAL_DIR/results" -name '*.json' -newermt "@$RUN_START" ! -name 'summary.json' -print0 \
    | xargs -0 -I{} python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
if d.get('recordFile'): print(d['task'], d['recordFile'], d.get('sessionId') or '')
" {} > "$LIST" 2>/dev/null
  COUNT="$(wc -l < "$LIST")"
  echo "出复盘视频：$COUNT 个"
  while read -r TASK REC SID; do
    [ -z "${TASK:-}" ] && continue
    OUT="$VID_DIR/${TASK}.mp4"
    echo "--- $TASK（$REC）"
    node "$EVAL_DIR/make-video.mjs" --video "$REC_DIR/$REC" ${SID:+--session "$SID"} --out "$OUT" 2>&1 | tail -2
  done < "$LIST"
  rm -f "$LIST"
fi

echo "全部结束（日志 $LOG）"
