# dsh-cu-eval —— 在实时 GUI benchmark 上测 `dsh + computer-use-plugin`

一套可复现的评测脚本：**每个任务一个全新会话**，只给 CU 工具，结果从环境读、并由独立 Agent 审计。
覆盖 69 个任务（`a/` 22 + `b/` 12 + `c/` 17 + `d/` 18）。

## 目录

| 路径 | 作用 |
|---|---|
| `run-all.sh` | **全 benchmark 一键跑**：起服务与 Chrome → 串行跑 → 出汇总（断点续跑） |
| `run-one.sh` | 跑单个任务并出复盘视频（含起服务/Chrome） |
| `run-c-tasks.mjs` | 主脚本：逐任务跑、取判据、抽轨迹、调审计、出汇总 |
| `eval.patch.yml` | 送进 `dsh --patch` 的覆盖层（**只在这次进程内生效**，不写任何持久配置） |
| `plugin-eval-guard.mjs` | 硬约束插件：注入固定系统提示词 + 把工具面裁到只剩 CU 工具 |
| `prompt-system.md` | 系统提示词（防作弊规则 + 任务纪律，由上面那个插件读入注入） |
| `prompt-auditor.md` | 独立审计 Agent 的判断规则 |
| `results/` | 每个任务一份 JSON（含 `group` / `recordFile`）+ `summary.json` |
| `trajectories/` | 每个任务的文本轨迹（审计的输入；**不含图像内容**，只留图像元数据） |
| `videos/` | 复盘视频（`make-video.mjs` 产出） |

## 跑法（推荐：一条命令）

```sh
cd /home/administrator/dsh-cu-eval

bash run-all.sh --dry-run     # 先看计划（不跑任何任务、不起任何东西）
bash run-all.sh               # 全 benchmark；跳过已有结果（断点续跑）
bash run-all.sh --groups c    # 只跑 C 类
bash run-all.sh --limit 3     # 每类前 3 个（试跑）
bash run-all.sh --rerun       # 重跑全部（不跳过已有结果）
bash run-all.sh --no-audit    # 跳过独立审计
bash run-all.sh --videos      # 跑完再为本次每个任务出复盘视频
bash run-one.sh C39           # 单个任务 + 复盘视频
```

`run-all.sh` 自己会：探测/启动静态服务（8765–8785 自动选端口）→ 起专用 Chrome → 串行跑 →
写 `results/summary.json` 并打印表格。**中断后重跑同一条命令即可继续**（已有 `results/<任务>.json` 的会跳过）。

底层主脚本的开关：

```sh
node run-c-tasks.mjs --groups a,b,c,d    # 类别（默认 c）
node run-c-tasks.mjs --tasks C1,C26      # 只跑指定任务（**前缀**匹配，C1 不会带出 C12）
node run-c-tasks.mjs --skip-done         # 跳过已有结果（断点续跑）
node run-c-tasks.mjs --limit 5           # 只跑前 5 个
node run-c-tasks.mjs --dry-run           # 只打印计划
node run-c-tasks.mjs --timeout 300       # 每任务超时（秒）；默认 0 = 不设上限
node run-c-tasks.mjs --no-audit          # 跳过独立审计
node run-c-tasks.mjs --keep-open         # 跑完不关 Chrome/服务
```

## 规模与时间预估

| 类别 | 任务数 | 说明 |
|---|---|---|
| `a` | 22 | 认知/记忆类 |
| `b` | 12 | 节奏/时机类 |
| `c` | 17 | 动作时序类（最初只跑这一类） |
| `d` | 18 | 随机/对抗类 |
| **合计** | **69** | |

实测单任务（C 类、不设超时、含审计）**9–11 分钟**（C28 520.9 s、C39 596.1 s）
⇒ 全量约 **10–13 小时**；`--no-audit` 可省约四分之一。磁盘：录像约 2–5 GB（C 盘现有 90 G 足够）。

## 判据（读页面 URL hash，不采信模型自述）

任务页把状态写进 hash，但**字段名有三种形态**（主脚本已归一化）：

| 形态 | 任务数 | 字段 |
|---|---|---|
| A | 53 | `task` / `attempts_completed` / `passed` / `status` / `pass_at_1` / `pass_at_3` |
| B | 9 | 同上，但用 `attempts`（C12/C26/C27/C28/C29/C30…） |
| C | 7 | `task` / `attempts` / `passed` / `status`（C33–C39，无 `pass_at_*`） |

成功判据 = `passed=1` ⇒ 落到 `results/<任务>.json` 的 `success`；`status` 另有 `ready` / `running` / `passed` / `failed`。

## 提示词现状（跑 C 类以外的类别前请先确认）

`prompt-system.md` 目前是**按 C 类实时动作游戏**写的：防作弊规则、工具清单、坐标口径对全类通用，
但其中一节专门讲 C 类的重试对话框（"Attempt N / 3 — Next"）与"世界在持续推进"这类实时约束。
⇒ 跑 `a`/`b`/`d` 类前需要确认是否另写一版提示词；换提示词只需改 `eval.patch.yml` 里的 `promptFile`。

## 三个关键设计（都可以被独立复核）

1. **硬防作弊，不是口头约束**：会话经 `--patch` 挂 `plugin-eval-guard.mjs`，它用
   `ctx.tools.restrict({ allow: [...16 个 CU 工具] })` 把工具面裁掉——`bash`、文件、网页这些
   「绕过 GUI」的路径对模型**根本不存在**。技能正文（`skills/computer-use/SKILL.md`，取自插件）
   由同一个 guard 作为系统提示段注入，模型无需、也没有 `skill` 工具。
2. **判据来自环境**：脚本用 CDP 读页面 URL 的 hash。**不采信模型自述**，也不需要看 DOM。
   浏览器跑在 `--app` 模式——地址栏不可见，模型无法从画面里直接读到判据。
3. **独立审计**：每任务结束后另起一个会话，只喂**文本轨迹**（工具调用 + 结果摘要，图只留尺寸/字节），
   按 `prompt-auditor.md` 判 `NOT_CHEAT` / `CHEAT` / `CHEAT_ATTEMPT` / `UNCERTAIN`。

## 环境

- 素材：`C:\Users\Administrator\Desktop\RealtimeGUIBench_人类评测_志愿者包\RealtimeGUIBench-人类评测`（`a`/`b`/`c`/`d`）
- 静态服务：该目录里的 `_serve.ps1 -NoBrowser`（Windows 侧，8765–8785 自动选；⚠️ **8765 可能被别的程序占用**，
  脚本会从 Windows 侧探测真正在服务的端口）
- 浏览器：**专用 Chrome 实例**（独立 profile `C:\Users\Administrator\dsh-cu-eval-profile`，
  `--app` 模式 = 无地址栏，`--start-maximized`）
- CDP 助手：`C:\Users\Administrator\dsh-cu-eval-tools\cdp.mjs`（在 **Windows 侧**跑，stdin 一行 JSON 进、stdout 一行 JSON 出）
- 评测 home：独立 `DSH_HOME=~/dsh-lab`（与日常 `~/.dsh` **完全隔离**）。进程环境另钉两项（`run-c-tasks.mjs` 的 `EVAL_ENV`）：
  `DSH_AGENTS_HOME=~/dsh-lab/.agents`（隔离本机 `~/.agents/skills`）、
  `DSH_BUNDLED_SKILL_DIR=<仓库根>/plugin/skills`（插件随本仓库分发，见下节）。
- **技能正文**：由 guard 注入插件自带的 `skills/computer-use/SKILL.md`（与 GitHub 同步那份）。
  评测环境里 skill 的**目录式发现实测不生效**（`$DSH_HOME/skills`、profile 的 `customSkillDirs` 都扫不到，
  会话的 `available_skills` 为空），所以改成显式注入，而不是依赖 `skill` 工具。

## 与虚拟机版提示词的差异（原版是给 VM 写的）

| 原版（VM） | 这里 |
|---|---|
| `get_frames` | `screen_frames`（细看某一帧用 `screen_grid({atSeconds})`） |
| `computer_wait` | `wait`（单次上限 5 秒，需要更久就多次调用） |
| `computer_done {}` | 本 harness 没有该工具 ⇒ 改成结束时输出一行 `DONE: SUCCESS` / `DONE: FAILURE` |
| 1920×1080 坐标 | **2560×1440**（本机屏幕），动作参数一律用屏幕像素 |
| 「动作后自动给你截图」 | 这个 harness **不会自动附图**：要看结果必须主动调 `screen_grid`（`click` 可带 `verify:true`） |
| 「同一 response 内动作串行、时序精确」 | 一致，保留 |

## 插件（随本仓库分发）

Computer Use 插件的完整代码内嵌在本仓库的 `plugin/` 目录（插件名 `computer-use-plugin`），
与 harness 同版本分发，**无需独立 clone 或同步**。复现时把它 link 安装进评测 DSH_HOME：

```sh
pnpm dsh plugin --profile <评测 profile> add link:"<本仓库>/plugin"
```

评测部署用的 bundle patch 在 `plugin-config/cu-plugin.cordis.patch.yml`（把插件挂进 profile 的 HOST 层）；
技能正文由 `eval.patch.yml` 的 `cu-eval-guard`（`skillFile`）直接注入，文件取自 `plugin/skills/computer-use/SKILL.md`。

## 失败兜底（2026-09-25 加；跑全量前看这节）

| 故障 | 现在的行为 | 位置 |
|---|---|---|
| **窗口不在前台 / 没铺满** | `activate` 校验**标题 + 几何**两条（容差 24 px）；不满足 ⇒ 自愈（重起 Chrome）后**重试该题**，最多 3 次，仍不行才记 error——**绝不半屏开跑** | `cdp.mjs` / `run-c-tasks.mjs` |
| Chrome 启动即最小化 | 按 Chrome 的要求**先 `normal` 再 `maximized`**（直接设 maximized 会被拒：错误码 `-32000`），另有 Win32 `SW_MAXIMIZE` 兜底 | `cdp.mjs` + `foreground.ps1 -Maximize` |
| **评测 Chrome 中途消失** | 判定链路中断 ⇒ 自动**重起 Chrome** 并**重试该题**（每题最多 3 次） | `run-c-tasks.mjs` 的 `relaunchChrome` |
| **静态服务挂了** | 从 **Windows 侧**探测 8765–8785；都不通就用 `_serve.ps1` **重起**，并用新端口继续 | `ensureSite` |
| 任务跑完但读不到页面状态 | 视为链路中断（**不是**"任务失败"）⇒ 自愈 + 重试，不产生假失败数据 | `runOneTask` |
| 单题抛异常 | 记 error、写结果、**继续下一题** | 主循环 try/catch |
| 审计失败 / 超时 / 解析不出 | 标 `UNCERTAIN`，不中断 | `auditTask` |
| 整轮被中断 | 每题结束即落盘；`--skip-done`（`run-all.sh` 默认开）跳过已完成 ⇒ 重跑即续跑 | `selectTasks` |

**自检命令**：`node run-c-tasks.mjs --repair-only` —— 只做链路体检（CDP + 站点），不通就自愈，不跑任何任务。

## 已知边界

- 评测期间**屏幕是独占的**：Chrome 必须在前台且铺满（脚本每题都断言，不满足就中止该题）；Agent 会真动键鼠。
  跑全量（10–13 小时）期间**别在这台机器上操作**、别让程序弹窗抢前台——中途被抢走前台脚本不会主动抢回。
- ⚠️ 本机 `dsh web` 自己的 `CuHelper.exe` 可能与评测 helper **并存**，两者共享 `%TEMP%\dsh-cu` 与同名帧文件
  （已知未覆盖风险）。要彻底避免，跑之前先停掉本机那侧的采集。
- 磁盘：本题实测录像 **9.4 MB / 191 s**，全量约 1–2 GB（C 盘余量足够）。
- 默认**不设超时**（`--timeout 0`）：任务跑到模型自己收尾。要上限就传秒数，超时会被 `SIGKILL`、
  结果按当时的环境状态记录。
- 审计会话用默认工具面（它不被评测），只读文本轨迹，不看图。
- 录像由插件配置 `recordDir` 决定（`C:\Users\Administrator\dsh-cu-recordings`），每次采集一份 `cu-*.mp4`；
  结果 JSON 的 `recordFile` 记录该任务对应的录像，`run-all.sh --videos` 据此批量出复盘视频。
