/**
 * make-video.mjs —— 把一次任务的屏幕录像与模型的思考/动作合成一个可观看的视频。
 *
 * 版面（2560×1440 实测）：评测时游戏窗口只占屏幕中段（约 y 400–920），上下与左右大片是空的。
 * 所以这里**先用 ffmpeg 采样几帧探测出画面内容带**，再把空白区全部用来放文字：
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ 顶部：当前动作（大字、醒目）                            │
 *   │ 上带：思考正文（静止，占满画面以上的全部空白）           │
 *   ├───────────────┬────────────────────┬───────────────────┤
 *   │ 左栏：动作历史 │   画面（原样不遮）  │ 右栏：进度/统计   │
 *   ├───────────────┴────────────────────┴───────────────────┤
 *   │ 下带：思考续文（静止，占满画面以下的全部空白）           │
 *   └────────────────────────────────────────────────────────┘
 *
 * 为什么静止而不是滚动：滚动的文字无法暂停阅读，且短思考 3 秒就滚完（实测屏幕上中位只有 2 行字、
 * 29% 的时间一行都没有）。静止铺满后同一时刻可见约 26 行 ≈ 2600 字符，覆盖思考中位长度。
 *
 * 时间基准：帧来自「持续采集逐帧落盘」，用**文件写入时刻**当采集时刻；事件时间轴取会话日志的
 * `time`（Unix epoch 毫秒），与帧时刻同源，可直接相减。
 *
 * 用法：
 *   node make-video.mjs --capture <帧目录> --session <会话id> --out <mp4> [--fps 15] [--offset-y 0]
 *   不给 --session 时取最新修改的会话。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const DSH_HOME = process.env.EVAL_DSH_HOME ?? '/home/administrator/dsh-lab'
const OUT_DIR = '/home/administrator/dsh-cu-eval/videos'

/** 版面常量（像素）：字号决定每行能放多少字，行高决定一个带能放多少行。 */
const FS_THINK = 24
const FS_ACT = 30
const FS_SIDE = 19
const LH_THINK = 31
const LH_SIDE = 26

const parseArgs = (argv) => {
  const args = { capture: null, session: null, out: null, fps: 15, offsetY: 0, video: null }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--capture') args.capture = argv[++i]
    else if (key === '--session') args.session = argv[++i]
    else if (key === '--out') args.out = argv[++i]
    else if (key === '--fps') args.fps = Number(argv[++i])
    else if (key === '--offset-y') args.offsetY = Number(argv[++i])
    else if (key === '--video') args.video = argv[++i]
  }
  return args
}

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`${command} 失败：${stderr?.slice(-800) ?? error.message}`))
    resolve({ stdout, stderr })
  })
})

const ffmpegPath = async () => {
  const { stdout } = await new Promise((resolve, reject) => {
    execFile('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], (error, out) => {
      if (error) return reject(error)
      resolve({ stdout: out })
    })
  })
  return stdout.trim()
}

/** 读一帧的实际像素尺寸：ASS 的 PlayRes 必须等于它，否则坐标会被缩放。 */
const probeSize = async (ffmpeg, file) => {
  // `ffmpeg -i` 只探测不输出时会以非零码退出，信息在 stderr —— 所以这里不能走 run()。
  const { stderr } = await new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, err) => {
      resolve({ stdout: stdout ?? '', stderr: err ?? String(error?.message ?? '') })
    })
  })
  const match = /,\s*(\d{2,5})x(\d{2,5})[,\s]/.exec(stderr ?? '')
  if (match === null) return { width: 1920, height: 1080 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** 读一个视频文件的时长与尺寸（只探测不转码；探测时会以非零码退出，所以不能走 run）。 */
const probeVideo = async (ffmpeg, file) => {
  const { stderr } = await new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, err) => {
      resolve({ stdout: stdout ?? '', stderr: err ?? String(error?.message ?? '') })
    })
  })
  const text = stderr ?? ''
  const dur = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(text)
  const size = /,\s*(\d{2,5})x(\d{2,5})[,\s]/.exec(text)
  return {
    durationS: dur === null ? null : Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
    width: size === null ? null : Number(size[1]),
    height: size === null ? null : Number(size[2]),
  }
}

/** 把一帧缩到 gw×gh 的灰度原始像素（探测内容带用；不做解码库依赖）。 */
const rawGray = (ffmpeg, file, gw, gh) => new Promise((resolve) => {
  execFile(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${gw}:${gh}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
    (error, stdout) => {
      if (stdout === undefined || stdout.length < gw * gh) return resolve(null)
      resolve(stdout.subarray(0, gw * gh))
    },
  )
})

/**
 * 采样若干帧、取亮度并集，找出**画面内容带**的像素边界。
 * 目的：所有文字都摆在内容之外，既不遮画面，也不浪费空白。
 * 帧既可以是逐帧落盘的 jpg（帧模式），也可以是从录像 mp4 里抽出来的（录像模式）——这里只认路径。
 */
const probeBands = async (ffmpeg, framePaths, width, height) => {
  const GW = 64
  const GH = 36
  const stride = Math.max(1, Math.floor(framePaths.length / 12))
  let acc = null
  for (let i = 0; i < framePaths.length; i += stride) {
    const buf = await rawGray(ffmpeg, framePaths[i], GW, GH)
    if (buf === null) continue
    if (acc === null) acc = new Uint8Array(buf.length)
    for (let k = 0; k < buf.length; k += 1) if (buf[k] > acc[k]) acc[k] = buf[k]
  }
  const fallback = {
    contentTop: Math.round(height * 0.3),
    contentBottom: Math.round(height * 0.62),
    contentLeft: Math.round(width * 0.36),
    contentRight: Math.round(width * 0.66),
    bottomLimit: height - 52,
    detected: false,
  }
  if (acc === null) return fallback

  const rowOn = []
  for (let y = 0; y < GH; y += 1) {
    let n = 0
    for (let x = 0; x < GW; x += 1) if (acc[y * GW + x] > 40) n += 1
    rowOn.push(n / GW)
  }
  // 取**最长的一段连续内容行**——底部的任务栏、顶部的零星图标都是孤立短段，不会被选中。
  let best = null
  let cur = null
  for (let y = 0; y < GH; y += 1) {
    if (rowOn[y] >= 0.12) {
      if (cur === null) cur = { a: y, b: y }
      else cur.b = y
    } else if (cur !== null) {
      if (best === null || cur.b - cur.a > best.b - best.a) best = cur
      cur = null
    }
  }
  if (cur !== null && (best === null || cur.b - cur.a > best.b - best.a)) best = cur
  if (best === null || best.b - best.a < 2) return fallback

  const colOn = []
  for (let x = 0; x < GW; x += 1) {
    let n = 0
    for (let y = best.a; y <= best.b; y += 1) if (acc[y * GW + x] > 40) n += 1
    colOn.push(n / (best.b - best.a + 1))
  }
  let cBest = null
  let cCur = null
  for (let x = 0; x < GW; x += 1) {
    if (colOn[x] >= 0.2) {
      if (cCur === null) cCur = { a: x, b: x }
      else cCur.b = x
    } else if (cCur !== null) {
      if (cBest === null || cCur.b - cCur.a > cBest.b - cBest.a) cBest = cCur
      cCur = null
    }
  }
  if (cCur !== null && (cBest === null || cCur.b - cCur.a > cBest.b - cBest.a)) cBest = cCur

  const cellH = height / GH
  const cellW = width / GW
  return {
    contentTop: Math.round(best.a * cellH),
    contentBottom: Math.round((best.b + 1) * cellH),
    contentLeft: cBest === null ? fallback.contentLeft : Math.round(cBest.a * cellW),
    contentRight: cBest === null ? fallback.contentRight : Math.round((cBest.b + 1) * cellW),
    bottomLimit: height - 52,
    detected: true,
  }
}

const sessionDirs = () => {
  const roots = readdirSync(join(DSH_HOME, 'sessions'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(DSH_HOME, 'sessions', entry.name))
  const dirs = []
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('session-')) dirs.push({ id: entry.name, path: join(root, entry.name) })
    }
  }
  return dirs
}

const findSession = (explicit) => {
  const dirs = sessionDirs()
  if (explicit !== null) {
    const hit = dirs.find(d => d.id.includes(explicit))
    if (hit === undefined) throw new Error(`找不到会话 ${explicit}`)
    return hit
  }
  return dirs.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)[0]
}

const readEvents = async (sessionPath) => {
  const file = join(sessionPath, 'session.v4.jsonl.zstd')
  const { stdout } = await run('zstd', ['-dc', file])
  const events = []
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      events.push(JSON.parse(text))
    } catch { /* 截断行忽略 */ }
  }
  return events
}

/** 把事件流压成「时间 → 字幕」时间线：思考、正文、动作。 */
const buildTimeline = (events) => {
  const timeline = []
  for (const event of events) {
    const time = Number(event.time ?? 0)
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
          timeline.push({ t: time, kind: 'thinking', text: block.text.trim() })
        }
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          timeline.push({ t: time, kind: 'says', text: block.text.trim() })
        }
      }
      continue
    }
    if (event.type === 'tool/call') {
      const name = event.data?.name ?? '?'
      let args = String(event.data?.arguments ?? '')
      try {
        args = JSON.stringify(JSON.parse(args)) // 压成一行
      } catch { /* 保持原样 */ }
      timeline.push({ t: time, kind: 'action', text: `${name} ${args}`.trim() })
      continue
    }
    if (event.type === 'tool/result') {
      // 屏幕录制不含系统光标，所以把 click 回执里的**真实落点**画到画面上。
      const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join(' ')
      const x = /"x_landed":\s*(-?\d+)/.exec(text)
      const y = /"y_landed":\s*(-?\d+)/.exec(text)
      if (x !== null && y !== null) timeline.push({ t: time, kind: 'mark', x: Number(x[1]), y: Number(y[1]) })
    }
  }
  return timeline.sort((a, b) => a.t - b.t)
}

const escapeAss = (text) => text
  .replaceAll('\\', '＼')
  .replaceAll('{', '（')
  .replaceAll('}', '）')
  .replaceAll('\r', '')

/** 一个字符占几个「全角单位」——英文/数字窄，ASS 按字符数折行会让英文行短掉一半。 */
const unitWidth = (ch) => /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 1 : 0.5

/** 按显示宽度折行；段落内的换行保留。 */
const wrapUnits = (text, maxUnits) => {
  const out = []
  for (const para of text.split('\n')) {
    if (para.trim() === '') continue
    let line = ''
    let used = 0
    for (const ch of para) {
      const cw = unitWidth(ch)
      if (used + cw > maxUnits && line !== '') {
        out.push(line)
        line = ''
        used = 0
      }
      line += ch
      used += cw
    }
    if (line !== '') out.push(line)
  }
  return out.length === 0 ? [''] : out
}

const truncate = (text, maxUnits) => {
  const chars = [...text]
  let used = 0
  let cut = 0
  for (const ch of chars) {
    const cw = unitWidth(ch)
    if (used + cw > maxUnits) break
    used += cw
    cut += 1
  }
  return cut >= chars.length ? text : `${chars.slice(0, Math.max(0, cut - 1)).join('')}…`
}

const renderAss = ({ timeline, t0, durationMs, width, height, bands, offsetY = 0 }) => {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Think,Noto Sans CJK SC,${FS_THINK},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1
Style: Act,Noto Sans CJK SC,${FS_ACT},&H0000E5FF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,3,2,1,7,0,0,0,1
Style: Side,Noto Sans CJK SC,${FS_SIDE},&H00D0D0D0,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1
Style: Dim,Noto Sans CJK SC,${FS_SIDE},&H00A0A0A0,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1
Style: Flash,Noto Sans CJK SC,${FS_THINK},&H0000FFA0,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1
Style: Mark,Noto Sans CJK SC,20,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const toAss = (ms) => {
    const total = Math.max(0, ms)
    const cs = Math.floor((total % 1000) / 10)
    const s = Math.floor(total / 1000) % 60
    const m = Math.floor(total / 60000) % 60
    const h = Math.floor(total / 3600000)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
  }

  // ---- 版面：思考固定在**右侧一栏**（作者 2026-09-24：「文字固定在右边」）----
  // 栏位只由画面内容带决定，不随思考条数变化 —— 视线不用在屏幕上找文字。
  const M = 24
  const actY = 10
  const lineUnits = Math.max(20, Math.floor((width - 2 * M) / FS_THINK))
  // 右栏栏位：优先贴「画面内容带」右侧的空白区；但内容带可能被判成整屏（画面铺满的游戏），
  // 那时 contentRight + 12 会落到画面之外——实测 2026-09-25 C1：59 条思考全在 x=2572、
  // 画面宽 2560，一条也看不见（作者：「怎么没有思考」）。所以栏位必须**夹进画面**。
  const rightW = Math.max(420, Math.round(width * 0.36))
  const rightX = Math.min(Math.max(M, bands.contentRight + 12), Math.max(M, width - M - rightW))
  const rightUnits = Math.max(12, Math.floor((width - M - rightX) / FS_THINK))
  const rightTop = actY + FS_ACT + 16
  const rightRows = Math.max(4, Math.floor((bands.bottomLimit - 14 - rightTop) / LH_THINK))

  const lines = []
  const actions = timeline.filter(entry => entry.kind === 'action')
  const thoughts = timeline.filter(entry => entry.kind === 'thinking' || entry.kind === 'says')
  const marks = timeline.filter(entry => entry.kind === 'mark')
  const push = (layer, start, end, style, x, y, text) => {
    if (text === '') return
    lines.push(`Dialogue: ${layer},${toAss(start)},${toAss(end)},${style},,0,0,0,,{\\an7\\pos(${Math.round(x)},${Math.round(y)})}${text}`)
  }

  // 右栏底色（半透明黑）：夹取后栏位可能压在画面上，加一层底才保证文字可读。
  lines.push(`Dialogue: 0,${toAss(0)},${toAss(durationMs)},Side,,0,0,0,,`
    + `{\\an7\\pos(${Math.round(rightX - 8)},${Math.round(rightTop - 8)})\\p1\\bord0\\shad0\\1c&H000000&\\1a&H50&}`
    + `m 0 0 l ${Math.round(width - M - rightX + 16)} 0 l ${Math.round(width - M - rightX + 16)} `
    + `${rightRows * LH_THINK + 12} l 0 ${rightRows * LH_THINK + 12}`)

  // 落点：画一个 70x70 的高亮方框（\p1 矢量绘制），持续 1 秒。
  for (const mark of marks) {
    const start = mark.t - t0
    if (start < 0 || start > durationMs) continue
    const end = Math.min(start + 1000, durationMs)
    lines.push(`Dialogue: 3,${toAss(start)},${toAss(end)},Mark,,0,0,0,,{\\pos(${mark.x},${mark.y - offsetY})\\p1\\bord4\\1c&H0000FF&\\1a&H40&}m -35 -35 l 35 -35 l 35 35 l -35 35`)
  }

  // 顶部：当前动作（大字）+ 进度，显示到下一条动作。
  actions.forEach((entry, index) => {
    const start = entry.t - t0
    if (start < 0 || start > durationMs) return
    const next = actions[index + 1]?.t ?? (t0 + durationMs)
    const end = Math.min(Math.max(next - t0, start + 1200), Math.min(start + 20000, durationMs))
    push(0, start, end, 'Act', M, actY, truncate(escapeAss(`▶ ${entry.text}　·　动作 ${index + 1}/${actions.length}`), lineUnits))
  })

  // 思考：固定在右栏，**窗口 = 它被生成的那段时间**（上一条思考完成 → 本条完成）。
  // 旧写法是「本条完成 → 下一条完成」，它把每条思考整体**滞后一位**：屏幕上是"上一步在想什么"，
  // 而且内容与时长错配——实测本会话 61 字符的思考占 8.7 秒、而 6982 字符的思考只有 9.8 秒，
  // 于是看起来"长段一闪而过、短句占着屏幕"（作者 2026-09-24 一眼看出「思考一下子就没」）。
  thoughts.forEach((entry, index) => {
    const startMs = (index === 0 ? t0 : thoughts[index - 1].t) - t0
    const endMs = Math.min(entry.t - t0, durationMs)
    if (endMs - startMs <= 200) return
    const prefix = entry.kind === 'says' ? '[模型输出] ' : '[思考] '
    const rows = wrapUnits(escapeAss(`${prefix}${entry.text}`), rightUnits)
    // 一屏放不下就在**同一栏内分屏**（位置不动、只换内容）。屏数受窗口时长约束，每屏至少约 3 秒，
    // 免得翻得比读得快；没显示完的在末屏标注还剩多少行。
    const windowS = (endMs - startMs) / 1000
    const screens = Math.max(1, Math.ceil(rows.length / rightRows))
    const shown = Math.max(1, Math.min(screens, Math.floor(windowS / 3)))
    const style = entry.kind === 'says' ? 'Flash' : 'Think'
    for (let s = 0; s < shown; s += 1) {
      const seg = rows.slice(s * rightRows, (s + 1) * rightRows)
      if (seg.length === 0) break
      if (s === shown - 1 && shown < screens) {
        const rest = rows.length - (s + 1) * rightRows
        seg[seg.length - 1] = truncate(seg[seg.length - 1], Math.max(8, rightUnits - 14)) + ` …（余 ${rest} 行）`
      }
      push(1, startMs + (endMs - startMs) * s / shown, startMs + (endMs - startMs) * (s + 1) / shown,
        style, rightX, rightTop, seg.join('\\N'))
    }
  })

  return head + lines.join('\n') + '\n'
}

/**
 * 录像模式：画面已经是一个成品 mp4（helper 用 `recordDir` **直接编码写出**的录像），
 * 所以不需要帧序列、也不需要重采样 —— 只要叠加同一套字幕。
 *
 * 时间轴起点怎么定：`t0 = 视频文件 mtime − 视频时长`。mp4 的 mtime 是 Finalize 写入文件尾的时刻，
 * 也就等于最后一段帧的时刻，所以这个减法能把视频时间轴对回 Unix 时间（误差 = 末帧到 Finalize 的几十毫秒）。
 */
const renderFromVideo = async (args) => {
  const video = resolve(args.video)
  const session = findSession(args.session)
  const timeline = buildTimeline(await readEvents(session.path))
  console.log(`会话 ${session.id}；时间线事件 ${timeline.length} 条（动作 ${timeline.filter(e => e.kind === 'action').length}，思考 ${timeline.filter(e => e.kind !== 'action').length}）`)
  mkdirSync(OUT_DIR, { recursive: true })
  const workDir = join(OUT_DIR, `.work-${session.id.slice(0, 12)}`)
  mkdirSync(workDir, { recursive: true })
  const ffmpeg = await ffmpegPath()
  const info = await probeVideo(ffmpeg, video)
  if (info.durationS === null || info.width === null) throw new Error(`读不出视频信息：${video}`)
  const durationMs = info.durationS * 1000
  const t0 = statSync(video).mtimeMs - durationMs
  console.log(`录像 ${video}：${info.width}x${info.height}，${info.durationS.toFixed(1)}s`)
  const probes = []
  for (let i = 0; i < 8; i += 1) {
    const tmp = join(workDir, `probe-${i}.png`)
    const ss = ((info.durationS * (i + 0.5)) / 8).toFixed(2)
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', ss, '-i', video, '-frames:v', '1', tmp])
    probes.push(tmp)
  }
  const bands = await probeBands(ffmpeg, probes, info.width, info.height)
  console.log(`画面内容带：y ${bands.contentTop}–${bands.contentBottom}，x ${bands.contentLeft}–${bands.contentRight}（探测${bands.detected ? '成功' : '失败，用默认值'}）`)
  const assPath = join(workDir, 'overlay.ass')
  writeFileSync(assPath, renderAss({ timeline, t0, durationMs, width: info.width, height: info.height, bands, offsetY: args.offsetY }))
  const out = args.out ?? join(OUT_DIR, `${session.id.slice(0, 20)}.mp4`)
  mkdirSync(dirname(out), { recursive: true })
  console.log(`合成中 → ${out}`)
  await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', video,
    '-vf', `ass=${assPath}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    out,
  ])
  console.log(`完成：${out}（${(statSync(out).size / 1024 / 1024).toFixed(1)} MB）`)
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.capture === null && args.video === null) throw new Error('需要 --capture <帧目录> 或 --video <录像mp4>')
  if (args.video !== null) return await renderFromVideo(args)
  const capture = resolve(args.capture)
  const manifestPath = join(capture, 'manifest.jsonl')
  // 两种素材都支持：有 manifest（CDP 录屏）就用它；没有（CU 助手逐帧落盘的 live-*.jpg）就按文件写入时刻建。
  const frames = existsSync(manifestPath)
    ? readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : readdirSync(capture)
        // 只取**持续采集**的整屏帧：同一目录里还有 screen_grid 落下的分块/缩略图（尺寸不同，混进来会毁掉时间轴）。
        .filter(file => /^live-\d+\.jpg$/i.test(file))
        .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
        .map((file, index) => ({ seq: index + 1, file, t: statSync(join(capture, file)).mtimeMs }))
  if (frames.length < 2) throw new Error(`帧太少（${frames.length}）：录屏可能没跑起来`)
  const t0 = frames[0].t
  const tEnd = frames[frames.length - 1].t
  const durationMs = tEnd - t0

  const session = findSession(args.session)
  console.log(`会话 ${session.id}；帧 ${frames.length} 张，跨度 ${(durationMs / 1000).toFixed(1)}s`)
  const timeline = buildTimeline(await readEvents(session.path))
  console.log(`时间线事件 ${timeline.length} 条（动作 ${timeline.filter(e => e.kind === 'action').length}，思考 ${timeline.filter(e => e.kind !== 'action').length}）`)

  mkdirSync(OUT_DIR, { recursive: true })
  const workDir = join(OUT_DIR, `.work-${session.id.slice(0, 12)}`)
  mkdirSync(workDir, { recursive: true })

  // 帧序列：按固定 fps 重采样（帧只在重绘时产生，间隔不均匀）。
  const dt = 1000 / args.fps
  const concatLines = []
  let cursor = 0
  for (let k = 0; ; k += 1) {
    const target = t0 + k * dt
    if (target > tEnd) break
    while (cursor + 1 < frames.length && frames[cursor + 1].t <= target) cursor += 1
    concatLines.push(`file '${join(capture, frames[cursor].file).replaceAll("'", "'\\''")}'`, `duration ${(dt / 1000).toFixed(4)}`)
  }
  concatLines.push(`file '${join(capture, frames[frames.length - 1].file)}'`)
  const concatPath = join(workDir, 'frames.txt')
  writeFileSync(concatPath, `${concatLines.join('\n')}\n`)

  const ffmpeg = await ffmpegPath()
  const { width, height } = await probeSize(ffmpeg, join(capture, frames[0].file))
  console.log(`画面尺寸 ${width}x${height}（ASS 的 PlayRes 按它设，落点才不会错位）`)

  const bands = await probeBands(ffmpeg, frames.map(f => join(capture, f.file)), width, height)
  console.log(`画面内容带：y ${bands.contentTop}–${bands.contentBottom}，x ${bands.contentLeft}–${bands.contentRight}（探测${bands.detected ? '成功' : '失败，用默认值'}）`)

  const assPath = join(workDir, 'overlay.ass')
  writeFileSync(assPath, renderAss({ timeline, t0, durationMs, width, height, bands, offsetY: args.offsetY }))
  const out = args.out ?? join(OUT_DIR, `${session.id.slice(0, 20)}.mp4`)
  mkdirSync(dirname(out), { recursive: true })
  console.log(`合成中 → ${out}`)
  await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-vf', `ass=${assPath}`,
    '-r', String(args.fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    out,
  ])
  console.log(`完成：${out}（${(statSync(out).size / 1024 / 1024).toFixed(1)} MB）`)
}

await main()
