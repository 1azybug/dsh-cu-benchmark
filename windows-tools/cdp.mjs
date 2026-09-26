/**
 * cdp.mjs —— 评测脚本的 CDP 助手（**在 Windows 侧运行**）。
 *
 * 为什么需要它：Chrome 的调试端口只监听 Windows 的 loopback，WSL 连不上；而评测主脚本
 * 跑在 WSL 里。于是主脚本 spawn 本文件，用 stdin/stdout 各传一行 JSON。
 *
 * 操作：
 *   {"op":"status"}                       读当前页面 URL 与 hash 里的评测状态
 *   {"op":"navigate","url":"http://…"}     导航到指定 URL 并等页面加载完成
 *   {"op":"targets"}                      列出所有 page target
 *   {"op":"evaluate","expression":"…"}     在页面里求值（**仅评测方使用，被测 Agent 无此能力**）
 *
 * 环境变量：CDP_PORT（默认 9333）。
 */

import { execFileSync } from 'node:child_process'

const PORT = Number(process.env.CDP_PORT ?? 9333)
const FOREGROUND_PS1 = 'C:\\Users\\Administrator\\dsh-cu-eval-tools\\foreground.ps1'

/** 读/改 Windows 前台窗口标题（走 PowerShell helper，不经过 CDP）。 */
const foregroundTitle = (match, activate = false, maximize = false) => {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOREGROUND_PS1]
  if (match !== undefined) args.push('-Match', match)
  if (activate) args.push('-Activate')
  if (maximize) args.push('-Maximize')
  return execFileSync('powershell.exe', args, { encoding: 'utf8', timeout: 25000 }).trim()
}
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

/** 挑选评测页面：优先 URL 指向本地评测服务的那个。 */
const pickPage = (list, prefer) => {
  if (prefer !== undefined) {
    const hit = list.find(t => t.url.includes(prefer))
    if (hit !== undefined) return hit
  }
  const bench = list.find(t => /localhost:87\d\d\/[a-d]\//.test(t.url))
  return bench ?? list[0]
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

const evaluate = async (ws, expression) => {
  const result = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
    throw new Error(`求值异常：${detail}`)
  }
  return result.result?.value
}

const parseHash = (href) => {
  const at = href.indexOf('#')
  const out = {}
  if (at < 0) return out
  for (const pair of href.slice(at + 1).split('&')) {
    const [key, value = ''] = pair.split('=')
    if (key !== '') out[decodeURIComponent(key)] = decodeURIComponent(value)
  }
  return out
}

const readState = async (ws) => {
  const href = await evaluate(ws, 'location.href')
  const readyState = await evaluate(ws, 'document.readyState')
  return { url: href, readyState, state: parseHash(href) }
}

const main = async () => {
  const raw = (await readStdin()).trim()
  const cmd = JSON.parse(raw === '' ? '{}' : raw)
  if (cmd.op === 'close-browser') {
    // 关闭**这个调试实例**（不是用户日常的 Chrome）：连 browser 端点发 Browser.close。
    const version = await (await fetch(`${BASE}/json/version`)).json()
    const browser = await connect(version.webSocketDebuggerUrl)
    try {
      await send(browser, 'Browser.close', {})
    } catch { /* 关闭过程中连接会断，属正常 */ }
    return { ok: true, closed: true }
  }
  const list = await pages()
  if (cmd.op === 'targets') {
    return { ok: true, targets: list.map(t => ({ id: t.id, url: t.url, title: t.title })) }
  }
  if (cmd.op === 'foreground') {
    return { ok: true, foreground: foregroundTitle() }
  }
  if (list.length === 0) throw new Error('没有 page target')
  const target = pickPage(list, cmd.prefer)
  const ws = await connect(target.webSocketDebuggerUrl)
  try {
    if (cmd.op === 'status') return { ok: true, ...(await readState(ws)) }
    if (cmd.op === 'activate') {
      // 把评测窗口带到前台**并铺满屏幕**：设最大化 → bringToFront → 用 Win32 强拉，然后**校验两件事**：
      //   ① 前台窗口标题 == 页面标题 —— 否则 Agent 的动作会落到别的窗口上（2026-09-25 实际发生过）；
      //   ② 窗口几何 ≈ 屏幕可用尺寸 —— 否则画面只占半屏，而"在前台"仍然成立（同一天实测：窗口是
      //      `windowState: normal`、1265×1372，却通过了只看标题的检查，作者一眼看出没全屏）。
      // 设置窗口状态失败**不再静默**：错误经 stateError 回报给调用方。几何是权威判据（它决定
      // Agent 实际看到多大的画面），windowState 只作诊断。
      const title = String(target.title ?? '')
      const key = title.length > 20 ? title.slice(0, 20) : title
      const TOLERANCE = 24 // 最大化窗口的 outer 尺寸可能比 "可用" 尺寸小几个像素
      const readGeometry = async () => JSON.parse(await evaluate(ws,
        'JSON.stringify({outerWidth:outerWidth,outerHeight:outerHeight,screenX:screenX,screenY:screenY,availWidth:screen.availWidth,availHeight:screen.availHeight})'))
      const ensureMaximized = async (force = false) => {
        const win = await send(ws, 'Browser.getWindowForTarget', { targetId: target.id })
        let cur = await send(ws, 'Browser.getWindowBounds', { windowId: win.windowId })
        let state = cur?.bounds?.windowState
        // Chrome 的约束（2026-09-25 实测错误码 -32000）：「最小化/全屏」的窗口**不能直接**
        // 设为最大化，必须先恢复成 normal；否则请求被拒。旧实现把这条错误静默吞掉，结果只剩
        // "拉前台"、窗口留在半屏 —— 正是作者看到的"没全屏"。
        // `force`：几何判据不达标时（窗口可能"状态报 maximized、页面却报 outerWidth=0"，
        // 2026-09-25 实测），主动做一次 normal → maximized 的尺寸变化，逼 Chrome 重算视图尺寸。
        if (state === 'minimized' || state === 'fullscreen' || force) {
          await send(ws, 'Browser.setWindowBounds', {
            windowId: win.windowId, bounds: { windowState: 'normal' },
          })
          state = 'normal'
        }
        // 只在**不是最大化**时设 maximized。绝不能对已最大化的窗口设 normal：那会把评测窗口
        // 降回窗口化（2026-09-25 实测踩到——屏幕上窗口缩到了左边）。唯一的例外是上面的 force。
        if (state !== 'maximized') {
          await send(ws, 'Browser.setWindowBounds', {
            windowId: win.windowId, bounds: { windowState: 'maximized' },
          })
        }
        cur = await send(ws, 'Browser.getWindowBounds', { windowId: win.windowId })
        return cur?.bounds?.windowState
      }
      let stateError = null
      let windowState = null
      let geometry = await readGeometry()
      let foreground = foregroundTitle()
      let attempts = 0
      for (let i = 0; i < 3; i++) {
        attempts = i + 1
        try {
          windowState = await ensureMaximized(i > 0) // 第 2 轮起强制一次 normal→maximized，逼 Chrome 重算尺寸
        } catch (error) {
          stateError = String(error?.message ?? error) // 不静默：窗口状态/权限问题都会落到这里
          try { // 设置失败也要把**读到的**状态带回去，否则诊断信息缺失
            const win = await send(ws, 'Browser.getWindowForTarget', { targetId: target.id })
            const cur = await send(ws, 'Browser.getWindowBounds', { windowId: win.windowId })
            windowState = cur?.bounds?.windowState ?? windowState
          } catch { /* 读不到就保持原值 */ }
        }
        try { await send(ws, 'Page.bringToFront', {}) } catch { /* app 模式或旧版本可能不支持 */ }
        // Win32 兜底：SW_MAXIMIZE + 强拉前台。CDP 的 setWindowBounds 对**最小化**窗口
        // 可能抛错（旧实现静默吞掉，结果只剩"拉前台"、窗口仍是半屏——2026-09-25 实测）。
        foreground = foregroundTitle(key, true, true)
        await new Promise(resolve => setTimeout(resolve, 600))
        geometry = await readGeometry()
        foreground = foregroundTitle()
        const onTop = key === '' || foreground.includes(key)
        const filled = geometry.outerWidth >= geometry.availWidth - TOLERANCE
          && geometry.outerHeight >= geometry.availHeight - TOLERANCE
        if (onTop && filled) break
      }
      const filled = geometry.outerWidth >= geometry.availWidth - TOLERANCE
        && geometry.outerHeight >= geometry.availHeight - TOLERANCE
      return {
        ok: true,
        target: title,
        foreground,
        match: key === '' ? null : foreground.includes(key),
        geometry,
        windowState,
        fullscreen: filled,
        attempts,
        stateError,
      }
    }
    if (cmd.op === 'set-viewport') {
      // 把**布局视口**锁成给定尺寸：这样 screencast 的输出就是它，且页面不会因内容溢出而产生滚动条占位。
      await send(ws, 'Emulation.setDeviceMetricsOverride', {
        width: cmd.width, height: cmd.height, deviceScaleFactor: 1, mobile: false,
      })
      const iw = await evaluate(ws, 'innerWidth')
      const ih = await evaluate(ws, 'innerHeight')
      const sy = await evaluate(ws, 'screenY')
      const chromeH = await evaluate(ws, 'outerHeight - innerHeight')
      return { ok: true, viewport: { width: iw, height: ih }, windowTop: sy, titlebarHeight: chromeH }
    }
    if (cmd.op === 'evaluate') {
      return { ok: true, value: await evaluate(ws, cmd.expression), ...(await readState(ws)) }
    }
    if (cmd.op === 'navigate') {
      await send(ws, 'Page.enable')
      await send(ws, 'Page.navigate', { url: cmd.url })
      const deadline = Date.now() + 20000
      let ready = 'loading'
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250))
        try {
          ready = await evaluate(ws, 'document.readyState')
        } catch { continue }
        if (ready === 'complete') break
      }
      return { ok: true, ...(await readState(ws)) }
    }
    throw new Error(`未知操作 ${cmd.op}`)
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
