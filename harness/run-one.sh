#!/usr/bin/env bash
# 一条命令跑一个 C 类任务并出复盘视频。
#
#   bash run-one.sh C39                       # 前缀或完整目录名都行
#   bash run-one.sh C39_Trick_Landing --no-video
#   bash run-one.sh C1 --port 8768            # 指定端口（默认自动探测）
#   bash run-one.sh C39 --check-only          # 只确保服务与 Chrome，不跑任务
#
# 自动做四件事：
#   1) 确认 Windows 侧有静态服务在服务评测页（没有就在 8765-8785 起一个）
#   2) 用专用 profile 打开该任务页（--app 无地址栏）
#   3) 跑 run-c-tasks.mjs（**不设超时**），结果落 results/<目录名>.json
#   4) 用本次录像 mp4（recordDir 里新增的那个）出复盘视频，落 videos/
#
# 前提：屏幕独占（Agent 会真动键鼠）；评测期间别同时跑重 CPU 任务。
set -uo pipefail

EVAL_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE_WSL='/mnt/c/Users/Administrator/Desktop/RealtimeGUIBench_人类评测_志愿者包/RealtimeGUIBench-人类评测'
REC_DIR='/mnt/c/Users/Administrator/dsh-cu-recordings'
NODE_WIN='/mnt/c/Program Files/nodejs/node.exe'
CDP_WIN='C:\Users\Administrator\dsh-cu-eval-tools\cdp.mjs'
PROFILE_WIN='C:\Users\Administrator\dsh-cu-eval-profile'
CHROME='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'

TASK="${1:-}"
[ -z "$TASK" ] && { sed -n '2,12p' "$0"; exit 2; }
shift
DO_VIDEO=1; CHECK_ONLY=0; PORT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --no-video) DO_VIDEO=0 ;;
    --check-only) CHECK_ONLY=1 ;;
    --port) PORT="${2:-}"; shift ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
  shift
done

cdp() { echo "$1" | timeout 30 "$NODE_WIN" "$CDP_WIN" 2>&1; }

# ── 1) 静态服务（从 Windows 侧探测：8765 可能被别的程序占了） ────────────────
probe_server() {
  powershell.exe -NoProfile -Command "foreach (\$p in 8765..8785) { try { \$r = Invoke-WebRequest -Uri ('http://localhost:' + \$p + '/c/C1_Double_Jump/index.html') -TimeoutSec 2 -UseBasicParsing; Write-Output \$p } catch { } }" 2>/dev/null | tr -d '\r' | head -1
}
if [ -z "$PORT" ]; then
  PORT="$(probe_server)"
  if [ -z "$PORT" ]; then
    echo "没有静态服务，在 8765-8785 起一个…"
    ( cd "$SITE_WSL" && setsid nohup powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\_serve.ps1' -NoBrowser > /tmp/serve-eval.log 2>&1 & )
    sleep 6
    PORT="$(grep -o 'localhost:[0-9]*' /tmp/serve-eval.log | head -1 | cut -d: -f2)"
    if [ -z "$PORT" ]; then echo "起服务失败："; cat /tmp/serve-eval.log; exit 1; fi
  fi
fi
echo "静态服务：http://localhost:$PORT/"

# ── 2) 解析任务目录名 ────────────────────────────────────────────────────────
TASK_DIR="$(ls "$SITE_WSL/c" | grep -E "^${TASK}(_|$)" | head -1)"
[ -z "$TASK_DIR" ] && { echo "找不到任务：$TASK（可选：$(ls "$SITE_WSL/c" | tr '\n' ' ')）"; exit 2; }
echo "任务：$TASK_DIR"

# ── 2.5) 试验区插件对齐 GitHub ────────────────────────────────────────────
# 规矩（主人 2026-09-25）：**插件开发在试验区** `~/dsh-lab/plugins/dsh-real-time-computer-use`，
# 改完提交并 push；**本机 `~/.dsh/plugins/dsh-computer-use` 不动**。
# 有未提交的开发改动就跳过同步（绝不清掉正在改的东西）；评测专属 cordis.patch.yml 由 skip-worktree 保护。
PLUGIN_DIR="$HOME/dsh-lab/plugins/dsh-real-time-computer-use"
if [ -d "$PLUGIN_DIR/.git" ]; then
  DIRTY="$(cd "$PLUGIN_DIR" && git status --porcelain | grep -v 'cordis.patch.yml' | head -1)"
  if [ -n "$DIRTY" ]; then
    echo "⚠️ 试验区插件有未提交改动，跳过自动同步（先提交或 stash）"
  elif ( cd "$PLUGIN_DIR" && https_proxy="${https_proxy:-http://172.22.48.1:7897}" git fetch -q origin \
        && git reset -q --hard origin/main ); then
    echo "试验区插件已对齐 GitHub：$(cd "$PLUGIN_DIR" && git log -1 --format='%h %s')"
  else
    echo "⚠️ 插件同步失败（网络？）——继续用当前版本"
  fi
fi

# ── 3) Chrome（没起就起，起了就导航） ───────────────────────────────────────
if cdp '{"op":"status"}' | grep -q '"ok":true'; then
  echo "评测 Chrome 已在跑 → 导航到任务页"
  cdp "{\"op\":\"navigate\",\"url\":\"http://localhost:$PORT/c/${TASK_DIR}/index.html\"}" >/dev/null
else
  echo "启动评测 Chrome…"
  ( setsid nohup "$CHROME" --remote-debugging-port=9333 --user-data-dir="$PROFILE_WIN" \
      --app="http://localhost:$PORT/c/${TASK_DIR}/index.html" --start-maximized > /tmp/eval-chrome.log 2>&1 & )
  for _ in $(seq 1 20); do sleep 2; cdp '{"op":"status"}' | grep -q '"ok":true' && break; done
fi
STATUS="$(cdp '{"op":"status"}')"
echo "$STATUS" | grep -q '"ok":true' || { echo "Chrome/CDP 不可用：$STATUS"; exit 1; }
echo "页面就绪：$(echo "$STATUS" | head -c 160)"

# ── 3.5) 前台 + 全屏：两条都成立才开跑 ──────────────────────────────────────
# 只查「在前台」会漏掉「窗口只占半屏」——2026-09-25 实测：窗口是 normal 1265×1372，
# 前台却是游戏页，于是半屏跑了一轮（主人一眼看出没全屏）。现在几何也算判据。
ACT="$(cdp '{"op":"activate"}')"
echo "窗口：$ACT"
echo "$ACT" | grep -q '"match":true'      || { echo "中止：游戏窗口不在前台 → $ACT"; exit 1; }
echo "$ACT" | grep -q '"fullscreen":true' || { echo "中止：游戏窗口没铺满屏幕 → $ACT"; exit 1; }
[ "$CHECK_ONLY" = "1" ] && { echo "（--check-only：到此为止）"; exit 0; }

# ── 4) 跑任务（不设超时） ───────────────────────────────────────────────────
ls "$REC_DIR"/cu-*.mp4 2>/dev/null | sort > /tmp/rec-before.txt
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$EVAL_DIR/run-${TASK_DIR}-${STAMP}.log"
echo "开始跑，日志：$LOG"
node "$EVAL_DIR/run-c-tasks.mjs" --tasks "$TASK_DIR" --timeout 0 2>&1 | tee "$LOG"

# ── 5) 出复盘视频 ───────────────────────────────────────────────────────────
if [ "$DO_VIDEO" = "1" ]; then
  RESULT="$EVAL_DIR/results/${TASK_DIR}.json"
  [ "$(wc -l < /tmp/rec-before.txt)" -ge 0 ] || true
  ls "$REC_DIR"/cu-*.mp4 2>/dev/null | sort > /tmp/rec-after.txt
  REC="$(comm -13 /tmp/rec-before.txt /tmp/rec-after.txt | tail -1)"
  SID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('sessionId') or '')" "$RESULT" 2>/dev/null)"
  if [ -n "$REC" ] && [ -n "$SID" ]; then
    OUT="$EVAL_DIR/videos/${TASK_DIR}_${STAMP}.mp4"
    echo "出复盘视频：$REC → $OUT"
    node "$EVAL_DIR/make-video.mjs" --video "$REC" --session "$SID" --out "$OUT"
  else
    echo "跳过视频：录像=$REC 会话=$SID（录像为空通常是 Agent 没开 screen_watch）"
  fi
fi
