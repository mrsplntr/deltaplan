import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLAN_PATH = 'C:/plans/plan.md'

// The comment bar's props, as the terminal hands them.
const BAR = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const plan = (...lines: string[]) => [...lines, ''].join('\n')

// Claude Code's plan-mode note, which tells the mod where the plan file is.
function enterPlanMode($: Engine) {
  return $.prompt.attachment({
    type: 'plan_mode',
    text: '',
    origin: { kind: 'engine' },
    detail: { reminder: 'full', planFilePath: PLAN_PATH, hasPlan: false },
  })
}

// The world beneath the mod: one screen, the plan file, a wait the test
// controls, and ExitPlanMode answered by a stand-in for the engine's dialog.
function world(on: On, options: { waitFails?: boolean } = {}) {
  const seen = { text: '', approvals: 0, toasts: [] as string[] }
  mock.env(on, {})
  on('prompt.attachment', async ($, e) => ({ text: e.text }))
  on('classic.UserPromptSubmit', async () => ({}))
  on('session.surfaces', async () => ({ value: ['terminal'] as const }))
  on('fs.read', async () => ({ value: seen.text }))
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'ExitPlanMode' }, async () => {
    seen.approvals++
    return { result: { plan: seen.text }, text: 'approved' }
  })

  // Each wait holds until the test releases it, so the hold loop never spins;
  // `held()` resolves when the next wait starts, that is, when a plan is held.
  let release = () => {}
  let waiting: (() => void)[] = []
  on('process.run', async () => {
    if (options.waitFails) return { deny: 'no sleep here' }
    for (const resolve of waiting.splice(0)) resolve()
    await new Promise<void>(resolve => (release = resolve))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const held = () => new Promise<void>(resolve => waiting.push(resolve))
  return { seen, held, release: () => release() }
}

// Claude submits `text` as its plan; resolves once the mod holds it, with
// the comment bar drawn and the call still running.
async function submitPlan($: Engine, w: ReturnType<typeof world>, text: string) {
  w.seen.text = text
  const isHeld = w.held()
  const call = $.tool.call({ tool: 'ExitPlanMode' })
  await isHeld
  const bar = await $.ui.mount({ plugin: 'deltaplan', surface: 'terminal', ...BAR })
  return { call, bar }
}

// The bar's text as shown: every string in the drawn tree, joined.
async function barText(bar: Awaited<ReturnType<typeof submitPlan>>['bar']) {
  const shown = (node: unknown): string =>
    typeof node === 'string'
      ? node
      : Array.isArray(node)
        ? node.map(shown).join('')
        : typeof node === 'object' && node !== null && 'children' in node
          ? shown(node.children)
          : ''
  return shown(await bar.drawn())
}

test('a plan is held until Continue, then goes on to the engine', async ($, on) => {
  const w = world(on)
  await enterPlanMode($)
  const { call, bar } = await submitPlan($, w, plan('# Plan', 'Step one'))
  expect(w.seen.approvals).toBe(0)

  await bar.press({ key: 'continue' })
  w.release()
  const result = await call
  expect(w.seen.approvals).toBe(1)
  expect(result.deny).toBeUndefined()
  await bar.unmount()
})

test('Send feedback refuses the plan with the comments, quoting each line', async ($, on) => {
  const w = world(on)
  await enterPlanMode($)
  const { call, bar } = await submitPlan($, w, plan('# Plan', 'Use Redis'))

  await bar.press({ key: 'down' })
  await bar.press({ key: 'down' })
  await bar.redraw()
  await bar.input({ key: 'comment', text: 'Why not Postgres?' })
  await bar.redraw()
  await bar.press({ key: 'feedback' })
  w.release()

  const result = await call
  expect(w.seen.approvals).toBe(0)
  expect(result.deny).toBe(
    [
      'The user reviewed the plan in DeltaPlan. Revise the plan and submit it again.',
      'Line 2 "Use Redis": comment — Why not Postgres?',
    ].join('\n'),
  )
  await bar.unmount()
})

test('versions count up inside plan mode and start over after it ends', async ($, on) => {
  const w = world(on)
  await enterPlanMode($)

  // Version 1, refused with a comment.
  let { call, bar } = await submitPlan($, w, plan('# Plan', 'Use Redis'))
  expect(await barText(bar)).toContain('version 1')
  await bar.press({ key: 'down' })
  await bar.redraw()
  await bar.input({ key: 'comment', text: 'Why?' })
  await bar.redraw()
  await bar.press({ key: 'feedback' })
  w.release()
  await call
  await bar.unmount()

  // The revision is version 2, colored against version 1; approved.
  ;({ call, bar } = await submitPlan($, w, plan('# Plan', 'Use Postgres')))
  expect(await barText(bar)).toContain('version 2')
  expect(await barText(bar)).toContain('1 changed')
  await bar.press({ key: 'continue' })
  w.release()
  await call
  await bar.unmount()

  // Approval ended plan mode: the next plan starts again at version 1.
  // Refused this time, so only the message below can end plan mode.
  await enterPlanMode($)
  ;({ call, bar } = await submitPlan($, w, plan('# Other plan')))
  expect(await barText(bar)).toContain('version 1')
  await bar.press({ key: 'down' })
  await bar.redraw()
  await bar.input({ key: 'comment', text: 'Shorter?' })
  await bar.redraw()
  await bar.press({ key: 'feedback' })
  w.release()
  await call
  await bar.unmount()

  // A message sent outside plan mode ends it too.
  await $.classic.UserPromptSubmit({ prompt: 'hello', permission_mode: 'default' })
  await enterPlanMode($)
  ;({ call, bar } = await submitPlan($, w, plan('# Third plan')))
  expect(await barText(bar)).toContain('version 1')
  await bar.press({ key: 'continue' })
  w.release()
  await call
  await bar.unmount()
})

test('a failed wait says so and falls back to the normal dialog', async ($, on) => {
  const w = world(on, { waitFails: true })
  await enterPlanMode($)
  w.seen.text = plan('# Plan')
  await $.tool.call({ tool: 'ExitPlanMode' })

  expect(w.seen.approvals).toBe(1)
  expect(w.seen.toasts).toHaveLength(1)
  expect(w.seen.toasts[0]).toContain('Error: the wait command failed (')
  expect(w.seen.toasts[0]).toContain('Showing the normal plan dialog instead.')
})
