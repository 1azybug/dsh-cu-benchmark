/**
 * cu-eval-guard —— 评测会话的硬约束（host 层，经 `dsh --patch` 临时挂载，不落任何持久配置）。
 *
 * 只做两件事，都是「让防作弊从口头变成机制」：
 *
 * 1. 给每个 Agent 注入固定的系统提示词段（防作弊规则 + 任务纪律）。段内容从文件读，
 *    便于脚本改提示词而不用改代码。
 * 2. 用 `tools.restrict({ allow })` 把该 Agent 的工具面裁到只剩 CU 工具。这是硬约束：
 *    没有被允许的工具对模型根本不存在，`bash`/文件/网页那类「绕过 GUI」的路径是**工具
 *    不存在**，而不是「规则禁止」。
 *
 * 归属：每条注入都挂在对应 Agent 的作用域上（`agent.ctx.inject`），Agent 释放时随之清理。
 * 这里**故意不吞错**：`restrict` 对未知工具名会抛错（例如 CU 插件没装、工具名写错），
 * 那时应该大声失败——静默失效会让整个防作弊约束变成空话。
 */

import { readFileSync } from 'node:fs'

export const name = 'cu-eval-guard'

export const inject = ['agents']

/** 本部署允许评测会话使用的工具名（裁到只剩这些）。 */
const CU_TOOLS = [
  'screen_grid',
  'screen_frames',
  'screen_watch',
  'screen_windows',
  'cursor_state',
  'mouse_move_to',
  'mouse_move_by',
  'click',
  'mouse_button',
  'drag',
  'scroll',
  'type_text',
  'press_key',
  'key_state',
  'hotkey',
  'wait',
]

/**
 * @param ctx - 宿主上下文。
 * @param config - `promptFile`（提示词文件路径）、可选的 `order`、`allow`（工具白名单）与
 *   `skillFile`（技能正文；由**插件自带**的 `skills/computer-use/SKILL.md` 提供，见 eval.patch.yml）。
 */
export function apply(ctx, config) {
  const promptFile = config?.promptFile
  if (typeof promptFile !== 'string' || promptFile === '') {
    throw new Error('cu-eval-guard: 缺少 config.promptFile')
  }
  const rules = readFileSync(promptFile, 'utf8')
  const order = config?.order ?? 5
  const allow = config?.allow ?? CU_TOOLS
  // 技能正文：直接注入系统提示段。评测环境里 skill 的**目录式**发现没生效（2026-09-25 实测：
  // `$DSH_HOME/skills` 与 profile 的 customSkillDirs 都扫不到，会话的 available_skills 为空），
  // 而"把对外那份 SKILL.md 交给模型"才是评测要测的东西 ⇒ 这里改成显式注入，文件仍取自插件。
  const skillFile = config?.skillFile
  const skill = typeof skillFile === 'string' && skillFile !== '' ? readFileSync(skillFile, 'utf8') : null

  const fibers = new Map()

  const install = (agent) => {
    if (fibers.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
      scope.systemPrompt.section({ name: 'eval:rules', order, text: rules })
      if (skill !== null) scope.systemPrompt.section({ name: 'eval:skill', order: order + 1, text: skill })
      scope.tools.restrict({ allow })
    })
    fibers.set(agent, fiber)
  }

  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = fibers.get(agent)
    fibers.delete(agent)
    if (fiber !== undefined) void fiber.dispose().catch(() => {})
  })

  ctx.effect(() => async () => {
    const pending = [...fibers.values()]
    fibers.clear()
    await Promise.all(pending.map(fiber => fiber.dispose().catch(() => {})))
  }, 'cu-eval-guard: 提示词段与工具面限制')
}
