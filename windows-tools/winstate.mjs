/**
 * winstate.mjs —— 读/设评测窗口的窗口状态与几何（**在 Windows 侧运行**）。
 *
 * 为什么需要它：cdp.mjs 的 activate 只校验「前台标题」，不校验几何——实测出现过
 * 「窗口在前台、但只有 1265×1372、没铺满屏幕」仍然通过断言的情况（2026-09-25）。
 * 本文件把 Browser.getWindowBounds 的原始值暴露出来，供诊断与显式修正。
 *
 * 输入（stdin 一行 JSON）：
 *   {}                      只读当前窗口状态与几何
 *   {"set":"maximized"}     先设成该状态，再读回（用于显式修正）
 *   {"set":"fullscreen"}    同上
 *
 * 环境变量：CDP_PORT（默认 9333）。
 */

const PORT = Number(process.env.CDP_PORT ?? 9333)
const BASE = `http://127.0.0.1:${PORT}`

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const pages = async () => {
  const res = await fetch(`${BASE}/json`)
  const all = await res.json()
  return all.filter(t => t.type === 'page')
}

const connect = (wsUrl) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl)
  const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10000)
  ws.onopen = () => { clearTimeout(timer); resolve(ws) }
  ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }
})

let seq = 0
const send = (ws, method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 15000)
  const onMessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== id) return
    clearTimeout(timer)
    ws.removeEventListener('message', onMessage)
    if (msg.error !== undefined) return reject(new Error(`${method}: ${JSON.stringify(msg.error)}`))
    resolve(msg.result)
  }
  ws.addEventListener('message', onMessage)
  ws.send(JSON.stringify({ id, method, params }))
})

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const main = async () => {
  const raw = (await readStdin()).trim()
  const cmd = raw === '' ? {} : JSON.parse(raw)
  const list = await pages()
  if (list.length === 0) throw new Error('没有 page target')
  const bench = list.find(t => /localhost:87\d\d\/[a-d]\//.test(t.url)) ?? list[0]
  const ws = await connect(bench.webSocketDebuggerUrl)
  try {
    const win = await send(ws, 'Browser.getWindowForTarget', { targetId: bench.id })
    const before = await send(ws, 'Browser.getWindowBounds', { windowId: win.windowId })
    let setResult = null
    let setError = null
    if (cmd.set !== undefined) {
      try {
        await send(ws, 'Browser.setWindowBounds', {
          windowId: win.windowId, bounds: { windowState: cmd.set },
        })
        setResult = 'ok'
      } catch (error) {
        setError = String(error?.message ?? error)
      }
      await sleep(900)
    }
    const after = await send(ws, 'Browser.getWindowBounds', { windowId: win.windowId })
    const geom = await send(ws, 'Runtime.evaluate', {
      expression: 'JSON.stringify({outerWidth:outerWidth,outerHeight:outerHeight,screenX:screenX,screenY:screenY,availW:screen.availWidth,availH:screen.availHeight})',
      returnByValue: true,
    })
    return {
      ok: true, title: bench.title, windowId: win.windowId,
      before: before.bounds, set: cmd.set ?? null, setResult, setError,
      after: after.bounds, geom: JSON.parse(geom.result.value),
    }
  } finally {
    try { ws.close() } catch { /* 关闭失败无所谓：进程即将退出 */ }
  }
}

try {
  process.stdout.write(JSON.stringify(await main()) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }) + '\n')
  process.exitCode = 1
}
