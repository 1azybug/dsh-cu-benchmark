/**
 * screencast.mjs —— 录制评测浏览器页面（**在 Windows 侧运行**）。
 *
 * 走 CDP 的 `Page.startScreencast`：页面每次重绘就送一帧 JPEG 过来。它不改页面内容、
 * 不抢占 CU 插件的 DXGI 采集，纯粹是评测方视角的录屏。
 *
 * 输入（环境变量）：
 *   CDP_PORT   调试端口（默认 9333）
 *   OUT_DIR    帧输出目录（Windows 路径，默认 C:\Users\Administrator\dsh-cu-eval-capture）
 *   QUALITY    JPEG 质量（默认 60）
 *   EVERY_NTH  每 N 帧取一帧（默认 1）
 *
 * 停止：在 OUT_DIR 里出现 `stop.flag` 时退出（主脚本负责创建它——比信号可靠，
 * 因为本进程由 WSL 侧启动，信号传递跨系统不保证）。
 *
 * 产物：`frame-<seq>.jpg` 与 `manifest.jsonl`（每行 `{seq, file, t}`，t 为毫秒墙钟）。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9333)
const OUT_DIR = process.env.OUT_DIR ?? 'C:\\Users\\Administrator\\dsh-cu-eval-capture'
const QUALITY = Number(process.env.QUALITY ?? 60)
const EVERY_NTH = Number(process.env.EVERY_NTH ?? 1)

mkdirSync(OUT_DIR, { recursive: true })
const manifestPath = join(OUT_DIR, 'manifest.jsonl')
writeFileSync(manifestPath, '')
const stopFlag = join(OUT_DIR, 'stop.flag')

const startedAt = Date.now()
writeFileSync(join(OUT_DIR, 'started.json'), JSON.stringify({ startedAt, port: PORT, quality: QUALITY }))
console.error(`screencast: 输出到 ${OUT_DIR}，t0=${startedAt}`)

const pages = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`)
  const all = await res.json()
  return all.filter(t => t.type === 'page' && /localhost:87\d\d\/[a-d]\//.test(t.url))
}

const list = await pages()
if (list.length === 0) {
  console.error('screencast: 找不到评测页面，退出')
  process.exit(1)
}
const target = list[0]

const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
let pending = null

const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }))

ws.onopen = () => {
  send(1, 'Page.enable', {})
  send(2, 'Page.startScreencast', {
    format: 'jpeg',
    quality: QUALITY,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: EVERY_NTH,
  })
  console.error('screencast: 已开始')
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Page.screencastFrame') {
    const { data, metadata, sessionId } = msg.params
    seq += 1
    const file = `frame-${String(seq).padStart(6, '0')}.jpg`
    try {
      writeFileSync(join(OUT_DIR, file), Buffer.from(data, 'base64'))
      appendFileSync(manifestPath, `${JSON.stringify({ seq, file, t: Date.now() })}\n`)
    } catch (error) {
      console.error(`screencast: 写帧失败 ${error.message}`)
    }
    send(3, 'Page.screencastFrameAck', { sessionId })
    if (seq % 200 === 0) console.error(`screencast: ${seq} 帧`)
    return
  }
  if (msg.id === 2 && msg.error !== undefined) {
    console.error(`screencast: startScreencast 失败 ${JSON.stringify(msg.error)}`)
    process.exit(1)
  }
}

// 停止条件：主脚本放下 stop.flag（或连续 30 秒没有任何帧，视为页面已不再变化且没人管）。
pending = setInterval(() => {
  if (existsSync(stopFlag)) {
    console.error(`screencast: 收到停止信号，共 ${seq} 帧`)
    try { send(4, 'Page.stopScreencast', {}) } catch { /* 正在退出，忽略 */ }
    clearInterval(pending)
    setTimeout(() => process.exit(0), 300)
  }
}, 500)

ws.onerror = (error) => {
  console.error(`screencast: WebSocket 错误 ${String(error?.message ?? error)}`)
  process.exit(1)
}
