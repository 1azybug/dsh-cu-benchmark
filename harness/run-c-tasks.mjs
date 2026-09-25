/**
 * run-c-tasks.mjs —— 在实时 GUI benchmark（a/b/c/d 四类任务）上测 `dsh + dsh-real-time-computer-use`。
 *
 * 设计（每一项都是为了让结果可复现、可审计）：
 *
 * - **每个任务一个全新会话**：任务之间没有任何上下文延续，靠 `dsh --profile headless`
 *   每次起一个独立进程实现。
 * - **硬防作弊**：会话经 `--patch` 挂 `plugin-eval-guard.mjs`，把工具面裁到只剩 16 个 CU 工具
 *   （没有 shell、没有文件、没有网络），并注入固定的系统提示词。
 * - **判据来自环境**：每个任务结束后用 CDP 读页面 URL 的 hash
 *   （`status` / `passed` / `attempts*` / `pass_at_*`），不采信模型自述。
 * - **独立审计**：另起一个会话，只看（不含图的）文本轨迹，按固定规则判
 *   NOT_CHEAT / CHEAT / CHEAT_ATTEMPT / UNCERTAIN。
 *
 * 用法：
 *   node run-c-tasks.mjs                      # 跑全部 C 类任务（默认类别 c）
 *   node run-c-tasks.mjs --groups a,b,c,d     # 跑全 benchmark（69 个任务）
 *   node run-c-tasks.mjs --tasks C1,C26       # 只跑指定任务（前缀匹配）
 *   node run-c-tasks.mjs --skip-done          # 跳过 results/ 里已有结果的任务（断点续跑）
 *   node run-c-tasks.mjs --limit 5            # 只跑前 5 个（分批跑）
 *   node run-c-tasks.mjs --dry-run            # 只打印计划，不跑任何任务
 *   node run-c-tasks.mjs --timeout 300        # 每任务超时（秒）；默认 0 = 不设上限
 *   node run-c-tasks.mjs --repair-only        # 只做链路体检（CDP+站点）并自愈，不跑任务
 *   node run-c-tasks.mjs --no-audit           # 跳过独立审计
 *   node run-c-tasks.mjs --keep-open          # 跑完不关 Chrome/服务
 *
 * 失败兜底（详见 README「失败兜底」节）：窗口必须在前台且铺满（否则中止该题）；Chrome 掉线或
 * 静态服务挂掉会自动重起并**重试该题**（每题最多 3 次）；单题异常不中断整轮；审计失败标 UNCERTAIN。
 *
 * 全 benchmark 的封装：`bash run-all.sh`（起服务与 Chrome → 按类别串行跑 → 出汇总）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 环境常量 ──────────────────────────────────────────────────────────────────

/** 评测用的独立 DSH_HOME（与被测机器上日常使用的 `~/.dsh` 完全隔离）。 */
const DSH_HOME = process.env.EVAL_DSH_HOME ?? '/home/administrator/dsh-lab'
const DSH_BIN = join(DSH_HOME, 'toolchain/node_modules/.bin/dsh')
const PATCH = '/home/administrator/dsh-cu-eval/eval.patch.yml'
const AUDITOR_PROMPT = '/home/administrator/dsh-cu-eval/prompt-auditor.md'

/**
 * 评测会话的进程环境：**把评测 DSH 与本机 DSH 彻底隔离**，并只挂插件自带的技能。
 *
 * - `DSH_HOME`：会话数据、配置、插件都落在评测 home，与本机 `~/.dsh` 无关；
 * - `DSH_AGENTS_HOME`：skill 的第二个默认根（`$DSH_AGENTS_HOME/skills`）默认指向本机
 *   `~/.agents` —— 不覆盖就会把**本机的 lark- 系列、overleaf 等技能泄漏进评测会话**（2026-09-25 实测踩到）；
 * - `DSH_BUNDLED_SKILL_DIR`：把插件自带的 `skills/`（与 GitHub 同步的那份）作为技能根，
 *   于评测而言"技能由插件提供"，不依赖本机任何文件。
 */
const EVAL_ENV = {
  ...process.env,
  DSH_HOME,
  DSH_AGENTS_HOME: join(DSH_HOME, '.agents'),
  DSH_BUNDLED_SKILL_DIR: join(DSH_HOME, 'plugins/dsh-real-time-computer-use/skills'),
}

/** 评测素材（Windows 侧人类包）与它启动的静态服务。 */
const SITE_WIN = 'C:\\Users\\Administrator\\Desktop\\RealtimeGUIBench_人类评测_志愿者包\\RealtimeGUIBench-人类评测'
const SITE_WSL = '/mnt/c/Users/Administrator/Desktop/RealtimeGUIBench_人类评测_志愿者包/RealtimeGUIBench-人类评测'
const SERVE_PS1 = `${SITE_WIN}\\_serve.ps1`

/** Windows 侧 Chrome 与 CDP 助手（调试端口只监听 Windows loopback，故助手在 Windows 侧跑）。 */
const CHROME = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
const WIN_NODE = '/mnt/c/Program Files/nodejs/node.exe'
const CDP_HELPER_WSL = '/mnt/c/Users/Administrator/dsh-cu-eval-tools/cdp.mjs'
const CDP_HELPER_WIN = 'C:/Users/Administrator/dsh-cu-eval-tools/cdp.mjs'
const CHROME_PROFILE_WIN = 'C:\\Users\\Administrator\\dsh-cu-eval-profile'
const CDP_PORT = 9333

/** 产物目录。 */
const OUT_DIR = '/home/administrator/dsh-cu-eval/results'
const TRAJ_DIR = '/home/administrator/dsh-cu-eval/trajectories'

/** 录像目录（评测 home 的插件配置 `recordDir` 指到这里；Agent 每次采集写一个 `cu-*.mp4`）。 */
const REC_DIR = '/mnt/c/Users/Administrator/dsh-cu-recordings'

/** 交给模型的开始指令：不透露任务名，只指向页面上写着的规则。 */
const TASK_MESSAGE = [
  'The game page is open in the browser window, which is in the foreground.',
  'Complete the task described on the page, using only the registered GUI tools.',
  'When the task is over, end with the single completion line described in your instructions.',
].join(' ')

// ── 小工具 ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const run = (command, args, options = {}) => new Promise((resolve) => {
  const { input, ...spawnOptions } = options
  const stdio = spawnOptions.stdio ?? (input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'])
  const child = spawn(command, args, { ...spawnOptions, stdio })
  if (input !== undefined) child.stdin.end(input)
  let out = ''
  let err = ''
  child.stdout?.on('data', (chunk) => { out += chunk })
  child.stderr?.on('data', (chunk) => { err += chunk })
  child.on('close', (code, signal) => resolve({ code, signal, out, err }))
  child.on('error', (error) => resolve({ code: -1, signal: null, out, err: String(error.message) }))
})

/** 调用 Windows 侧的 CDP 助手（stdin 一行 JSON 进、stdout 一行 JSON 出）。 */
const cdp = async (command) => {
  const result = await run(WIN_NODE, [CDP_HELPER_WIN], { input: JSON.stringify(command) })
  const line = result.out.trim().split('\n').filter(Boolean).pop() ?? ''
  if (line === '') return { ok: false, error: `CDP 助手无输出：${result.err.slice(0, 300)}` }
  try {
    return JSON.parse(line)
  } catch {
    return { ok: false, error: `CDP 助手输出非 JSON：${line.slice(0, 300)}` }
  }
}

// ── 会话日志：抽轨迹 ──────────────────────────────────────────────────────────

/**
 * 把页面 hash 里的状态归一化。
 *
 * 各任务页面的字段名并不统一（实测：C12/C26 用 `attempts`，其余用 `attempts_completed`；
 * C33–C39 没有 `pass_at_*`），所以这里按缺省逐项兜底，避免某几个任务读成 0 或空。
 * @param env - URL hash 解析出的键值对。
 * @returns 归一化后的状态。
 */
const normalizeState = (env) => ({
  ...env,
  attemptsCompleted: Number(env.attempts_completed ?? env.attempts ?? 0),
  passed: env.passed === '1' || env.passed === 'true',
  passAt1: env.pass_at_1 ?? '',
  passAt3: env.pass_at_3 ?? '',
})

const sessionsRoot = () => {
  const dirs = readdirSync(join(DSH_HOME, 'sessions'), { withFileTypes: true }).filter(d => d.isDirectory())
  return dirs.map(d => join(DSH_HOME, 'sessions', d.name))
}

const listSessions = () => {
  const found = []
  for (const root of sessionsRoot()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('session-')) found.push(entry.name)
    }
  }
  return found
}

/** 录像目录里的 `cu-*.mp4` 列表（按名字排序；用来判定"这个任务新产出了哪段录像"）。 */
const listRecordings = () => {
  try {
    return readdirSync(REC_DIR).filter(name => name.startsWith('cu-') && name.endsWith('.mp4')).sort()
  } catch {
    return []
  }
}

const readSessionLog = async (sessionId) => {
  for (const root of sessionsRoot()) {
    const file = join(root, sessionId, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const decompressed = await run('zstd', ['-dc', file])
    return decompressed.out
  }
  return ''
}

const parseEvents = (jsonl) => {
  const events = []
  for (const line of jsonl.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      events.push(JSON.parse(text))
    } catch { /* 截断行忽略 */ }
  }
  return events
}

/** 把事件流压成审计用的文本轨迹（不含图像内容，只留图像元数据）。 */
const renderTrajectory = (events) => {
  const lines = []
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      const text = (data.content ?? []).map(c => c.text ?? '').join('')
      if (text.trim() !== '') lines.push(`[user] ${text.slice(0, 2000)}`)
      continue
    }
    if (event.type === 'assistant/message') {
      const parts = (data.message?.content ?? []).map((c) => {
        if (c.type === 'text') return c.text
        if (c.type === 'reasoning') return `[思考] ${c.text ?? ''}`
        return `(${c.type})`
      })
      const text = parts.join('')
      if (text.trim() !== '') lines.push(`[assistant] ${text.slice(0, 3000)}`)
      continue
    }
    if (event.type === 'tool/call') {
      lines.push(`[tool-call] ${data.name}(${(data.arguments ?? '').slice(0, 600)})`)
      continue
    }
    if (event.type === 'tool/result') {
      const blocks = data.message?.content ?? []
      const summary = blocks.map((block) => {
        if (block.type === 'text') return (block.text ?? '').slice(0, 800)
        if (block.type === 'image') {
          const a = block.attachment ?? {}
          return `<image ${a.width ?? '?'}x${a.height ?? '?'} ${a.bytes ?? '?'}B>`
        }
        return `(${block.type})`
      }).join(' | ')
      lines.push(`[tool-result] ${summary.slice(0, 1200)}`)
    }
  }
  return lines.join('\n')
}

/** 供结果 JSON 用的工具调用明细。 */
const extractToolCalls = (events) => events
  .filter(event => event.type === 'tool/call')
  .map(event => ({ name: event.data?.name, arguments: event.data?.arguments ?? '' }))

const extractFinalText = (events) => {
  const assistants = events.filter(event => event.type === 'assistant/message')
  const last = assistants[assistants.length - 1]
  const blocks = last?.data?.message?.content ?? []
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim()
}

// ── 链路自愈（评测 Chrome 掉了就重起） ────────────────────────────────────────
// 2026-09-25 实测：评测 Chrome 会在跑的过程中消失（调试端口不再监听），之后每一题都
// `fetch failed`——全量跑会整晚白跑。这里把它做成机制：本题因链路中断失败时，重起评测
// Chrome 并**重试本题**（限次，避免死循环）。

/** 重起评测 Chrome 的最大次数（每题）。 */
const REPAIR_MAX = Number(process.env.EVAL_REPAIR_MAX ?? 3)

/** 精确杀掉带评测调试端口的 Chrome（按命令行匹配 9333，不会碰别人的普通 Chrome）。 */
const killDebugChrome = () => {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
    + "Where-Object { $_.CommandLine -like '*--remote-debugging-port=9333*' } | "
    + "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

/** 起一个评测 Chrome 实例（专用 profile + 无地址栏）并等 CDP 就绪；返回是否恢复。 */
const relaunchChrome = async (taskUrl) => {
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE_WIN}`,
    `--app=${taskUrl}`,
    '--start-maximized',
  ]
  const waitReady = async (budgetMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      await sleep(2000)
      const status = await cdp({ op: 'status' })
      if (status.ok === true) return true
    }
    return false
  }
  const first = spawn(CHROME, args, { detached: true, stdio: 'ignore' })
  first.unref()
  if (await waitReady(90_000)) return true
  // 起不来：多半是残留实例占着 profile —— 精确清掉带 9333 的实例后再试一次。
  killDebugChrome()
  const second = spawn(CHROME, args, { detached: true, stdio: 'ignore' })
  second.unref()
  return await waitReady(60_000)
}

/**
 * 从 Windows 侧探测静态服务端口（8765–8785 里哪个在服务评测页）；没有则 null。
 *
 * ⚠️ 必须在 **Windows 侧**探测：WSL 里的 `localhost` 打到的是 WSL 自己的网络栈，
 * 会把别的进程当成评测服务（2026-09-25 老坑）。
 */
const probeSitePort = () => {
  const script = 'foreach ($p in 8765..8785) { try { $r = Invoke-WebRequest -Uri '
    + "('http://localhost:' + $p + '/c/C1_Double_Jump/index.html') -TimeoutSec 2 -UseBasicParsing; "
    + 'Write-Output $p } catch { } }'
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 60_000 })
    const port = out.split(/\s+/).map(s => s.trim()).filter(s => /^\d+$/.test(s))[0]
    return port ?? null
  } catch {
    return null
  }
}

/** 起静态服务（人类评测包自带的 `_serve.ps1`，无浏览器）；返回端口或 null。 */
const startSite = async () => {
  const child = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SERVE_PS1, '-NoBrowser'],
    { cwd: SITE_WSL, detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 12; i += 1) {
    await sleep(2000)
    const port = probeSitePort()
    if (port !== null) return port
  }
  return null
}

/** 确保站点可达；不可达就重起服务。返回**可能已变化**的 baseUrl。 */
const ensureSite = async (baseUrl) => {
  const port = probeSitePort()
  if (port !== null) {
    const fresh = `http://localhost:${port}`
    if (fresh !== baseUrl) console.log(`  站点端口变了：${baseUrl} → ${fresh}`)
    return fresh
  }
  console.log('  站点不可达 → 重起静态服务…')
  const started = await startSite()
  console.log(started === null ? '  静态服务重起失败' : `  静态服务已起在 ${started}`)
  return started === null ? baseUrl : `http://localhost:${started}`
}

// ── 单个任务 ──────────────────────────────────────────────────────────────────
const runOneTask = async ({ group, taskDir, baseUrl, timeoutMs }) => {
  const url = `${baseUrl}/${group}/${taskDir}/index.html`
  const startedAt = Date.now()
  const before = new Set(listSessions())
  const recBefore = new Set(listRecordings())

  const nav = await cdp({ op: 'navigate', url })
  if (nav.ok !== true) {
    // 调试端口不通 = 链路中断（Chrome 掉了）。标 retryable 让主循环自愈后重试本题。
    return { task: taskDir, group, ok: false, retryable: true, error: `导航失败：${nav.error}` }
  }
  const initial = nav.state ?? {}

  // 页面加载完 ≠ 窗口在前台铺满：navigate 不会激活窗口，且复用 --keep-open 留下的 Chrome 时它可能
  // 已在别的窗口之后、或只是窗口化（2026-09-25 两次实测：一次 Agent 看不到游戏、反复 alt+tab 自救；
  // 一次窗口 normal 1265×1372 只占半屏）。这里激活并**校验前台归属 + 几何铺满**；不满足就中止本轮
  // ——宁可这题不算，也不在错误条件下产生成绩。
  const act = await cdp({ op: 'activate' })
  const geom = act.geometry ?? {}
  const onTop = act.ok === true && act.match !== false
  const filled = act.fullscreen === true
  if (!onTop || !filled) {
    const why = []
    if (!onTop) why.push(`不在前台（前台是「${act.foreground ?? '未知'}」，目标「${act.target ?? '未知'}」）`)
    if (!filled) {
      why.push(`窗口没铺满（${geom.outerWidth ?? '?'}×${geom.outerHeight ?? '?'}，可用 ${geom.availWidth ?? '?'}×${geom.availHeight ?? '?'}，windowState=${act.windowState ?? '未知'}）`)
    }
    if (act.stateError) why.push(`设置窗口状态出错：${act.stateError}`)
    // 也算**可自愈失败**：重起一个干净的 Chrome 实例后重试，通常就能拿到全屏前台。
    return { task: taskDir, group, ok: false, retryable: true, error: `${why.join('；')}——已中止` }
  }

  // 起一个全新会话跑这个任务；到点没结束就杀掉。
  const child = spawn(DSH_BIN, ['--profile', 'headless', '--patch', PATCH, TASK_MESSAGE], {
    cwd: DSH_HOME,
    env: EVAL_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let timedOut = false
  // timeoutMs = 0 表示**不设上限**：任务跑到模型自己收尾为止。
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs) : null
  const exit = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
  if (timer !== null) clearTimeout(timer)

  const endedAt = Date.now()
  await sleep(1500) // 让页面把最后一次状态写进 hash

  const after = await cdp({ op: 'status' })
  if (after.ok !== true) {
    // 结算时读不到页面状态 = 链路在任务中途断了。此时 success 必然是 false，但那是"没读到
    // 判据"而不是"任务失败"——带上 linkDown 让主循环重起后重试本题，不产生假失败数据。
    return { task: taskDir, group, ok: false, retryable: true, error: `结算时读不到页面状态（链路中断）：${after.error}` }
  }
  const env = normalizeState(after.state ?? {})

  const newSessions = listSessions().filter(id => !before.has(id))
  const sessionId = newSessions[0] ?? null
  // 本次任务新产出的录像（Agent 可能分多段采集，取最后一段当主录像）。
  const newRecordings = listRecordings().filter(name => !recBefore.has(name))
  const recordFile = newRecordings.length > 0 ? newRecordings[newRecordings.length - 1] : null
  let events = []
  let trajectory = ''
  if (sessionId !== null) {
    events = parseEvents(await readSessionLog(sessionId))
    trajectory = renderTrajectory(events)
    mkdirSync(TRAJ_DIR, { recursive: true })
    writeFileSync(join(TRAJ_DIR, `${taskDir}.txt`), trajectory)
  }

  const passed = env.passed === true
  return {
    task: taskDir,
    group,
    ok: true,
    url,
    sessionId,
    recordFile,
    recordings: newRecordings,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    exitCode: exit.code,
    timedOut,
    initialState: initial,
    finalState: env,
    success: passed,
    status: env.status ?? '',
    attemptsCompleted: env.attemptsCompleted ?? 0,
    passAt1: env.passAt1 ?? '',
    passAt3: env.passAt3 ?? '',
    toolCallCount: extractToolCalls(events).length,
    toolCalls: extractToolCalls(events),
    assistantFinal: extractFinalText(events).slice(0, 2000),
    stdoutTail: stdout.slice(-1500),
    stderrTail: stderr.slice(-1500),
    trajectoryChars: trajectory.length,
  }
}

// ── 独立审计 ──────────────────────────────────────────────────────────────────

const auditTask = async ({ result, timeoutMs }) => {
  const trajectoryFile = join(TRAJ_DIR, `${result.task}.txt`)
  if (!existsSync(trajectoryFile) || result.trajectoryChars === 0) {
    return { label: 'UNCERTAIN', confidence: 0, evidence: [], reasoning: '没有可审计的轨迹（会话日志为空）' }
  }
  const prompt = [
    readFileSync(AUDITOR_PROMPT, 'utf8'),
    '',
    '## Trajectory under audit',
    '',
    `The trajectory is in the file ${trajectoryFile} — read it with your read tool, then judge.`,
    '',
    `Environment metadata supplied by the benchmark: final page state = ${JSON.stringify(result.finalState)}.`,
    'Return only the JSON object described above.',
  ].join('\n')

  const child = spawn(DSH_BIN, ['--profile', 'headless', prompt], {
    cwd: DSH_HOME,
    env: EVAL_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  await new Promise(resolve => child.on('close', () => resolve()))
  clearTimeout(timer)

  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return { label: 'UNCERTAIN', confidence: 0, evidence: [], reasoning: `审计输出无法解析：${stdout.slice(-400)}` }
  }
  try {
    return JSON.parse(stdout.slice(start, end + 1))
  } catch (error) {
    return { label: 'UNCERTAIN', confidence: 0, evidence: [], reasoning: `审计输出非 JSON：${String(error.message)}` }
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
  const args = { tasks: null, groups: ['c'], timeout: 0, audit: true, keepOpen: false, skipDone: false, limit: null, dryRun: false, repairOnly: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--tasks') args.tasks = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (key === '--groups') args.groups = argv[++i].split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    else if (key === '--timeout') args.timeout = Number(argv[++i])
    else if (key === '--no-audit') args.audit = false
    else if (key === '--keep-open') args.keepOpen = true
    else if (key === '--skip-done') args.skipDone = true
    else if (key === '--limit') args.limit = Number(argv[++i])
    else if (key === '--dry-run') args.dryRun = true
    else if (key === '--repair-only') args.repairOnly = true
  }
  return args
}

/** 扫描选题库。`groups` 取 a/b/c/d（默认只扫 c，与改动前行为一致）。 */
const discoverTasks = (groups) => {
  const siteWsl = '/mnt/c/Users/Administrator/Desktop/RealtimeGUIBench_人类评测_志愿者包/RealtimeGUIBench-人类评测'
  const out = []
  for (const group of groups) {
    const dir = join(siteWsl, group)
    if (!existsSync(dir)) continue
    const names = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    for (const name of names) out.push({ group, name })
  }
  return out
}

/**
 * 选出本轮要跑的任务。
 *
 * `--tasks` 是**前缀**匹配（`C1` 只命中 `C1_*`，不会把 `C12_*` 带进来）；
 * `--skip-done` 跳过 `results/<任务>.json` 已存在的任务（断点续跑；成败都算已有结果）；
 * `--limit N` 只取前 N 个（便于分批跑）。
 */
const selectTasks = (args) => {
  const matched = discoverTasks(args.groups)
    .filter(t => args.tasks === null || args.tasks.some(p => t.name === p || t.name.startsWith(`${p}_`)))
  const skipped = []
  const fresh = []
  for (const task of matched) {
    if (args.skipDone && existsSync(join(OUT_DIR, `${task.name}.json`))) skipped.push(task)
    else fresh.push(task)
  }
  const planned = args.limit !== null && args.limit > 0 ? fresh.slice(0, args.limit) : fresh
  return { matched, planned, skipped }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(TRAJ_DIR, { recursive: true })

  const { planned, skipped } = selectTasks(args)
  if (args.dryRun) {
    console.log(`[dry-run] 类别 ${args.groups.join(',')}：将跑 ${planned.length} 个任务，跳过已有结果 ${skipped.length} 个`)
    planned.forEach((task, index) => console.log(`  ${index + 1}. ${task.group}/${task.name}`))
    if (skipped.length > 0) console.log(`  已有结果（跳过）：${skipped.map(t => t.name).join(', ')}`)
    return
  }
  if (args.repairOnly) {
    // 只做链路体检与自愈，不跑任何任务（跑全量前/后都可以用它确认链路）。
    const base = process.env.EVAL_BASE_URL ?? 'http://localhost:8766'
    const status0 = await cdp({ op: 'status' })
    console.log(`链路体检：CDP ${status0.ok === true ? '可用' : `不可用（${status0.error}）`}；站点 ${base}`)
    if (status0.ok === true) return
    const recovered = await relaunchChrome(`${base}/c/A1_Concentration/index.html`)
    console.log(recovered ? '已重起评测 Chrome，CDP 恢复' : '重起失败（检查 Chrome 路径与静态服务）')
    if (!recovered) process.exitCode = 1
    return
  }
  if (planned.length === 0) {
    console.log(`没有要跑的任务（类别 ${args.groups.join(',')}${args.skipDone ? '，--skip-done 已跳过全部' : ''}）。`)
    return
  }

  // 服务与 Chrome 通常由外部（或上一次运行）拉起；这里确认链路通，不通就先自愈一次再判断。
  let probe = await cdp({ op: 'status' })
  if (probe.ok !== true) {
    console.log(`链路未就绪（${probe.error}）→ 尝试自愈…`)
    const site = await ensureSite(process.env.EVAL_BASE_URL ?? 'http://localhost:8766')
    await relaunchChrome(`${site}/c/A1_Concentration/index.html`)
    probe = await cdp({ op: 'status' })
  }
  if (probe.ok !== true) throw new Error(`CDP 不可用（先起 Chrome 与静态服务）：${probe.error}`)
  const baseMatch = /^(http:\/\/[^/]+)\//.exec(probe.url ?? '')
  if (baseMatch === null) throw new Error(`无法从 ${probe.url} 解析站点地址`)
  let baseUrl = baseMatch[1]

  console.log(`站点 ${baseUrl}；类别 ${args.groups.join(',')}；待跑 ${planned.length} 个任务`)
  if (skipped.length > 0) console.log(`已有结果（跳过）：${skipped.map(t => t.name).join(', ')}`)

  const results = []
  // 每个任务独立兜底：单个任务异常（导航失败、会话崩溃、取帧出错）不该中断整轮。
  for (const [index, item] of planned.entries()) {
    console.log(`\n[${index + 1}/${planned.length}] ${item.group}/${item.name}`)
    let result
    let repairs = 0
    for (;;) {
      try {
        result = await runOneTask({ group: item.group, taskDir: item.name, baseUrl, timeoutMs: args.timeout * 1000 })
      } catch (error) {
        result = { task: item.name, group: item.group, ok: false, error: `未捕获异常：${String(error?.message ?? error)}` }
      }
      // 可自愈失败（Chrome 掉线 / 结算读不到状态 / 窗口条件不满足）⇒ 自愈后**重试本题**；限次避免死循环。
      if (result.ok !== true && result.retryable === true && repairs < REPAIR_MAX) {
        repairs += 1
        console.log(`  可自愈失败：${result.error} → 自愈后重试本题（第 ${repairs}/${REPAIR_MAX} 次）`)
        baseUrl = await ensureSite(baseUrl)
        const recovered = await relaunchChrome(`${baseUrl}/${item.group}/${item.name}/index.html`)
        if (recovered) continue
        console.log('  重起后 CDP 仍不可用，放弃本题（检查 Chrome 与静态服务）')
      }
      break
    }
    if (result.ok !== true) {
      console.log(`  失败：${result.error}`)
      writeFileSync(join(OUT_DIR, `${result.task}.json`), `${JSON.stringify(result, null, 2)}\n`)
      results.push(result)
      continue
    }
    console.log(`  ${result.success ? 'PASS' : 'fail'}  status=${result.status} attempts=${result.attemptsCompleted} `
      + `耗时 ${(result.durationMs / 1000).toFixed(1)}s 工具调用 ${result.toolCallCount}${result.timedOut ? '（超时被杀）' : ''}`)
    if (args.audit) {
      try {
        result.audit = await auditTask({ result, timeoutMs: 180_000 })
      } catch (error) {
        result.audit = { label: 'UNCERTAIN', confidence: 0, evidence: [], reasoning: `审计未捕获异常：${String(error?.message ?? error)}` }
      }
      console.log(`  审计：${result.audit.label}（置信 ${result.audit.confidence}）`)
    }
    writeFileSync(join(OUT_DIR, `${result.task}.json`), `${JSON.stringify(result, null, 2)}\n`)
    results.push(result)
  }

  const summary = {
    ranAt: new Date().toISOString(),
    dshHome: DSH_HOME,
    tasks: results.length,
    passed: results.filter(r => r.success === true).length,
    timedOut: results.filter(r => r.timedOut === true).length,
    audit: results.reduce((acc, r) => {
      const label = r.audit?.label
      if (label !== undefined) acc[label] = (acc[label] ?? 0) + 1
      return acc
    }, {}),
    perTask: results.map(r => ({
      task: r.task,
      group: r.group ?? '',
      success: r.success ?? false,
      status: r.status ?? '',
      attemptsCompleted: r.attemptsCompleted ?? null,
      durationS: r.durationMs === undefined ? null : Number((r.durationMs / 1000).toFixed(1)),
      toolCalls: r.toolCallCount ?? null,
      audit: r.audit?.label ?? null,
      error: r.error ?? null,
    })),
  }
  writeFileSync(join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  console.log('\n===== 汇总 =====')
  console.log(`${summary.passed}/${summary.tasks} 通过；超时 ${summary.timedOut}；审计 ${JSON.stringify(summary.audit)}`)
  console.table(summary.perTask)
  if (args.keepOpen !== true) console.log('\n（Chrome 与静态服务保持运行；要停就关掉那个 Chrome 窗口与 PowerShell 窗口）')
}

await main()
