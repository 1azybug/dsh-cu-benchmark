# dsh-cu-benchmark — real-time GUI benchmark for DeepSeek Harness + `dsh-real-time-computer-use`

A reproducible harness that measures how well an LLM agent drives a **real Windows desktop**
(mouse + keyboard + screen reading) on a suite of 69 real-time, browser-based GUI tasks.
It was built to evaluate [`dsh-real-time-computer-use`](https://github.com/1azybug/dsh-real-time-computer-use),
a Computer-Use plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Snapshot of the reported run: 2026-09-25** (results, trajectories and logs for that run are included).

---

## 1. What this repository contains

| Path | Contents |
|---|---|
| `harness/` | The evaluation harness itself (Node.js + bash): task runner, hard tool-surface guard, system prompt given to the model, audit prompt, video tool, and a Chinese run-book (`harness/README.zh.md`) |
| `harness/results/` | One JSON per task (`<task>.json`) plus `summary.json` for the documented run |
| `harness/RESULTS-20260925.md` | Human-readable result report (group tables, failure list, per-task table) |
| `harness/trajectories/` | Text-only trajectories (one `.txt` per task) — the exact input the independent auditor sees |
| `windows-tools/` | Windows-side helpers the harness drives over stdio: Chrome DevTools-Protocol client, foreground-window helper, window-state probe |
| `plugin-config/` | The *deployment* configuration used for the evaluation (plugin config + profile patch layer). Paths inside are machine-specific — see §9.2 |

Task *pages* are not redistributed here (see §4).

---

## 2. System under test

| Component | Value |
|---|---|
| Harness | `@deepseek-ai/dsh` **0.1.7-rc.1** (installed from the public npm registry) |
| Plugin | `dsh-real-time-computer-use` **0.1.0**, commit **`93feea1`** (helper build **mf29**) |
| Model | `deepseek-official` / **`deepseek-flash`**, `reasoningEffort: high`, `maxTokens: 256000` |
| Agent profile | `headless` (one fresh process, hence one fresh session, per task) |
| Capture | `frameIntervalMs: 16` ⇒ target **62.5 fps**, `codec: h264` (in-memory segments), `backend: dxgi`, JPEG quality 70 |
| Recording | every `screen_watch start` also writes one continuous mp4 (timestamps taken at the real capture instants) |

The evaluation home is a **separate `DSH_HOME`** (`~/dsh-lab` in our setup), fully isolated from the
everyday `~/.dsh`: its own sessions, plugins, settings and agent skills. Two extra environment
variables are pinned for the sessions so that nothing leaks in from the host machine
(`DSH_AGENTS_HOME=<eval-home>/.agents`, `DSH_BUNDLED_SKILL_DIR=<eval-home>/plugins/dsh-real-time-computer-use/skills`).

---

## 3. Hardware and software (the machine used for the reported run)

| Item | Value |
|---|---|
| OS | Microsoft Windows 11 Pro, build 10.0.26200 |
| CPU | 13th Gen Intel Core i7-13700K |
| GPU | NVIDIA GeForce RTX 4090 (plus an inactive Todesk virtual display adapter) |
| RAM | 31.8 GB |
| Display | single 2560×1440 panel, Windows scaling 100 % (usable area 2560×1392) |
| Browser | Google Chrome **153.0.8010.53**, dedicated profile, `--app` mode (no address bar), `--start-maximized`, CDP on `127.0.0.1:9333` |
| DSH host | WSL2 (Ubuntu), Node.js **v22.19.0**; Windows-side helper scripts run on Node **v24.16.0** |
| Python (video tooling) | 3.13 (uses a static ffmpeg build with libass + Noto Sans CJK for burned-in subtitles) |

The machine is **exclusively** used by the run: the agent really moves the mouse and types, and the
browser window must be foreground and maximized (see §5.4).

---

## 4. Task suite

The task pages are **included in this repository** under `tasks/` (69 self-contained pages,
1.8 MB total: `tasks/a`, `tasks/b`, `tasks/c`, `tasks/d`, plus an `index.html` landing page, a
`_serve.ps1` static server and a short player guide). They were designed for this benchmark by the authors
and are included here so that the reported run can be replayed exactly.

The suite is organised in four groups, 69 tasks in total:

| Group | Tasks | Character |
|---|---|---|
| `a` | 22 | cognitive / memory |
| `b` | 12 | rhythm / timing |
| `c` | 17 | action timing (the group the plugin was originally built for) |
| `d` | 18 | random / adversarial |

Each task is a single HTML page that exposes its own state in the URL hash
(`task`, `passed`, `status`, `attempts*`, `pass_at_*`). Those fields are the **ground-truth
criterion** — see §5.3. The pages themselves tell the agent the rules, so the prompt does not name
the task.

---

## 5. Protocol

### 5.1 One fresh session per task
Each task runs as a separate `dsh --profile headless --patch <overlay> "<start message>"` process,
so no context, memory or session state carries over between tasks.

### 5.2 Hard, mechanical anti-cheat
The sessions are started with a process-level overlay (`harness/eval.patch.yml`) that mounts
`harness/plugin-eval-guard.mjs`. That plugin (a) injects a fixed system-prompt section
(`harness/prompt-system.md`) and (b) calls `ctx.tools.restrict({ allow: [...16 Computer-Use tools] })`.
The tool surface therefore contains **only** screen-reading and input-injection tools: `bash`, file
access and web access do not exist for the model — they are not "forbidden", they are absent.
The skill text that ships with the plugin (`skills/computer-use/SKILL.md`) is injected as a second
system-prompt section, so the model always sees it without needing a tool call.

### 5.3 Criterion taken from the environment, never from the model
After each task the harness reads the page URL hash over CDP and normalises the three field
spellings that occur in the suite (`attempts_completed` / `attempts` / neither). Success is
`passed=1`. The model's own closing line (`DONE: SUCCESS|FAILURE`) is recorded but **not** used as
the outcome.

### 5.4 Screen exclusivity is asserted, not assumed
Before a task starts, the harness activates the evaluation Chrome window and asserts **two**
things: the foreground window title equals the page title, and the window geometry equals the
usable screen area (tolerance 24 px). If either fails it tries to repair the window state
(CDP `setWindowBounds`, plus a Win32 `SW_MAXIMIZE` fallback) and re-checks; if it still fails, the
task is **aborted** rather than run on a screen the agent cannot actually see.

### 5.5 Independent audit
After a task finishes, a **separate** session (default tool surface, no images — text trajectory
only) is asked to judge whether the agent solved the task legitimately, using
`harness/prompt-auditor.md`. It returns one of `NOT_CHEAT`, `CHEAT`, `CHEAT_ATTEMPT`, `UNCERTAIN`
with a confidence and evidence. The auditor never sees the live screen.

### 5.6 No per-task timeout
Tasks run until the agent finishes on its own (`--timeout 0`). Real-time games end themselves when
the attempts are exhausted.

---

## 6. Recording and capture verification

The plugin records the *whole screen* (not the page) straight to mp4 while the agent works — one
continuous encoder, frame timestamps taken from the real capture instants. This gives two things:

* **Review videos** (`harness/make-video.mjs`) that overlay the model's reasoning and its actions
  on the recording, for failure analysis.
* **A capture-timing criterion**: the harness parses the mp4 `stts` box and checks the requirement
  used for this work — **every inter-frame interval ≤ 33.333 ms** (not "30 fps on average"). For
  the three tasks spot-checked in the documented run the figures were 100.00 % (13 410/13 410),
  99.99 % (7 917/7 918) and 100.00 % (25 127/25 128) compliant, with zero intervals above 35 ms.

Screen reading in the *live* loop uses the plugin's own capture buffer; the recording is a second
encoder, so verification does not disturb it.

---

## 7. Reliability and failure handling

A 61-task run takes hours, so the harness treats infrastructure failure as a first-class case:

| Failure | Behaviour |
|---|---|
| Task raises / crashes | logged, result written, **the run continues** |
| Window not foreground / not filling the screen | repair, re-check, else abort that task |
| Evaluation Chrome dies mid-run | detect, relaunch Chrome (dedicated profile), **retry the task** (max 3) |
| Static file server unreachable | probe ports from the Windows side, restart the server, continue on the new port |
| Page state unreadable after a task | treated as an infrastructure failure (not a task failure) ⇒ repair + retry, so no fake "failed" data is produced |
| Auditor fails / times out | recorded as `UNCERTAIN`, the run continues |
| Run interrupted | every task writes its result immediately; re-running the same command skips finished tasks (resume) |

In the documented run: **0 tasks were lost to infrastructure** (no `error` fields).

---

## 8. Results — run of 2026-09-25

61 of the 69 tasks were executed in this run; the other 8 already had results from earlier runs on
the same day and were skipped (resume mode). Aggregated over all 69 tasks:

| Group | Passed | Rate |
|---|---|---|
| `a` | 21 / 22 | 95 % |
| `b` | 11 / 12 | 92 % |
| `c` | 9 / 14 | 64 % |
| `d` | 2 / 18 | 11 % |
| **total** | **44 / 69** | **63.8 %** |

* Independent audit: **NOT_CHEAT 68, UNCERTAIN 1, CHEAT 0** — i.e. no task was solved by bypassing
  the GUI or by reading the page's own state.
* Wall-clock for the 61 tasks executed in this run: **4.5 hours** (mean ≈ 4.4 min/task).
* Infrastructure errors: **0**.

Per-task details (status, attempts, duration, tool calls, audit label, recording file) are in
`harness/RESULTS-20260925.md` and `harness/results/summary.json`.

---

## 9. Reproducing

### 9.1 Prerequisites
* Windows 10/11 desktop with a single display, Node.js on the Windows side (the CDP client must run
  there: Chrome's debugging port listens on Windows loopback only), and a POSIX shell (we used WSL2).
* Python 3 + a static ffmpeg build (only for the review videos).
* A DeepSeek API key for the harness (`DEEPSEEK_API_KEY`).
* The task pages: they are included here in `tasks/`; serve that directory over HTTP with any static server.

### 9.2 Paths you must adapt
The scripts are written for our machine and contain absolute paths; adapt these before running:

| File | Constant / occurrence | Meaning |
|---|---|---|
| `harness/run-c-tasks.mjs` | `DSH_HOME` (top of file) | evaluation `DSH_HOME` (keep it separate from your everyday `~/.dsh`) |
| `harness/run-c-tasks.mjs` | `SITE_WIN`, `SITE_WSL` | the task-page directory (`tasks/` in this repository; Windows path and its WSL equivalent) |
| `harness/run-c-tasks.mjs` | `CHROME`, `WIN_NODE`, `CDP_HELPER_*`, `CHROME_PROFILE_WIN`, `CDP_PORT` | Windows Chrome, Windows Node, CDP client, dedicated profile, port |
| `harness/run-all.sh`, `harness/run-one.sh` | `SITE_WSL`, `REC_DIR`, `NODE_WIN`, `CDP_WIN`, `PROFILE_WIN`, `CHROME` | same values, shell side |
| `harness/eval.patch.yml` | `promptFile`, `skillFile` | prompts + bundled skill file handed to the model |
| `harness/run-c-tasks.mjs` | `EVAL_ENV` | pins `DSH_AGENTS_HOME` / `DSH_BUNDLED_SKILL_DIR` so host-machine skills do not leak into the evaluation |
| `plugin-config/*.yml` | `recordDir`, capture paths | deployment choices (recording directory etc.) |

### 9.3 Run
```sh
# dry run: print the plan only (touches nothing)
bash harness/run-all.sh --dry-run

# full suite (a,b,c,d), resuming: tasks that already have results are skipped
bash harness/run-all.sh

# one task, with a review video at the end
bash harness/run-one.sh C30
```

Outputs: `results/<task>.json` (+ `summary.json`), `trajectories/<task>.txt`,
one mp4 recording per task in the configured recording directory.

---

## 10. Limitations (please cite these along with the numbers)

1. **Single machine, single display, single run.** The numbers are one run of one model snapshot;
   no variance study over repeated runs is included.
2. **The task pages are part of this benchmark** and are included in full, so the exact pages used in
   the reported run are pinned by this repository.
3. **Observation affects the observed system.** Capture runs at ~62.5 fps on one CPU core while the
   agent acts on the same machine; the harness measures its own timing compliance (§6) but the
   measurement itself is part of the environment.
4. **The audit is a model judgement**, not a formal proof. It sees only the text trajectory
   (tool calls + results), never the screen.
5. **Task count**: 69 tasks, 4 groups; the `d` group (random/adversarial) is where the agent fails
   most. Any claim about "real-time GUI performance" should be read per group.
6. **Videos** (325 MB for this run) are not stored in the repository.

---

## 11. Citation

If you use this harness or these results, please cite the repository (see `CITATION.cff`) and the
plugin it evaluates:

```
dsh-cu-benchmark: real-time GUI benchmark for DeepSeek Harness + dsh-real-time-computer-use,
snapshot 2026-09-25. https://github.com/1azybug/dsh-cu-benchmark
```

## 12. License

MIT (see `LICENSE`), covering the harness, the task pages under `tasks/`, and the recorded results.
