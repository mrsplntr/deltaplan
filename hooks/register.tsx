import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review } from '../types'
import { describeCounts, diffLines } from './diff'
import { buildFeedback, countFeedbackLines, FEEDBACK_HEADER, noteCount } from './feedback'
import type { Actions } from './draw'
import { decisionButtons, drawPlan } from './draw'
import { layoutMarkdown, splitLines, stepUnit, unitRange, unitStart } from './markdown'

const planPath = atom({ plugin: 'plan-abc', key: 'planPath' } as const, null)
const history = atom({ plugin: 'plan-abc', key: 'history' } as const, [])
const sessionEnded = atom({ plugin: 'plan-abc', key: 'sessionEnded' } as const, true)
const review = atom({ plugin: 'plan-abc', key: 'review' } as const, null)

type Decision = { kind: 'continue' } | { kind: 'feedback'; text: string }

// Button presses, by tool_use_id. A module variable, not $.state: every
// $.state read inside one dispatch sees the same moment, so the held
// tool.call hook would never see a write made after it started.
const decisions = new Map<string, Decision>()

// The element the band's focus ring is on, as the last ui.focus left it.
let ringOn: string | undefined

// The bar's focusable elements in the order it draws them.
const BAR_ORDER = ['up', 'down', 'comment', 'continue', 'feedback']

const ERROR = 'error'
// The spinner while a plan waits: the theme's warning color, readable on
// light and dark backgrounds alike.
const WAITING = 'warning'

// A wait run as a host process: unlike $.clock.sleep it does not spend the
// hook's 10 s budget, and no $ call waits for a press without one. macOS and
// Linux always have `sleep`, found on PATH and never in the current folder.
// Windows may look in the current folder first, so a project could hold its
// own sleep.exe: there both waits run by full path, Git's sleep where Git
// installs it, else the system's ping (about one second). Windows always sets
// OS to Windows_NT.
let waitCommand: readonly string[] | undefined
let pingCommand: readonly string[] | undefined

async function tick($: EngineInterface): Promise<void> {
  if (waitCommand === undefined) {
    if ((await $.env.get('OS')) === 'Windows_NT') {
      const windows = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
      const programs = (await $.env.get('ProgramFiles')) ?? 'C:\\Program Files'
      pingCommand = [`${windows}\\System32\\PING.EXE`, '-n', '2', '127.0.0.1']
      waitCommand = [`${programs}\\Git\\usr\\bin\\sleep.exe`, '0.4']
    } else {
      waitCommand = ['sleep', '0.4']
    }
  }
  try {
    await $.process.run(waitCommand, { timeoutMs: 5000 })
  } catch (error) {
    if (pingCommand === undefined || waitCommand === pingCommand) throw error
    waitCommand = pingCommand
  }
}

// What the buttons do. Each runs from a press, so its reads are current.
// A line inside a diagram selects the whole diagram, by its first line.
function select($: EngineInterface, n: number): void {
  update($, review, r => (r === null ? r : { ...r, selected: unitStart(layoutMarkdown(r.lines), n) }))
}

async function move($: EngineInterface, delta: number): Promise<void> {
  const r = await read($, review)
  if (r === null) return
  const n = stepUnit(layoutMarkdown(r.lines), r.selected, delta)
  await update($, review, cur => (cur === null ? cur : { ...cur, selected: n }))
}

function saveNote($: EngineInterface, text: string): void {
  const comment = text.trim()
  update($, review, r => {
    if (r === null || r.selected === null) return r
    const notes = { ...r.notes }
    if (comment === '') delete notes[String(r.selected)]
    else notes[String(r.selected)] = comment
    return { ...r, notes }
  })
}

// Versions count per plan-mode session: the first plan after entering plan
// mode is version 1, and every later plan in the same plan mode is the next
// version. Three signals say plan mode ended; each calls this.
async function endSession($: EngineInterface): Promise<void> {
  if (!(await read($, sessionEnded))) await update($, sessionEnded, () => true)
}

// A failure the person should hear about: what broke, Claude Code's own words
// for why, and what happens instead. Up long enough to read.
function reportError($: EngineInterface, what: string, why: string | undefined): void {
  const reason = why ? ` (${why})` : ''
  $.ui.toast(`Error: ${what}${reason}. Showing the normal plan dialog instead.`, { timeoutMs: 15000 })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// What the plan row's and the bar's buttons do for the plan under review.
function actionsFor($: EngineInterface, toolUseId: string): Actions {
  return {
    onContinue: () => {
      decisions.set(toolUseId, { kind: 'continue' })
    },
    onFeedback: () => sendFeedback($, toolUseId),
    onSelect: n => select($, n),
  }
}

async function sendFeedback($: EngineInterface, toolUseId: string): Promise<void> {
  const r = await read($, review)
  if (r === null || r.toolUseId !== toolUseId) return
  if (noteCount(r) === 0) {
    $.ui.toast('Plan ABC: add a comment first')
    return
  }
  decisions.set(toolUseId, { kind: 'feedback', text: buildFeedback(r) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload drops any hook that was holding a plan; clear its review.
    await update($, review, () => null)
    return next(e)
  })

  on('prompt.attachment', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Plan mode ended: Claude Code's one-time note on the next request.
      if (e.type === 'plan_mode_exit') await endSession($)
      const detail = (e as { detail?: { planFilePath?: string } }).detail
      const isPlanRow = e.type === 'plan_mode' || e.type === 'plan_mode_reentry'
      if (isPlanRow && detail?.planFilePath) {
        const path = detail.planFilePath
        if ((await read($, planPath)) !== path) await update($, planPath, () => path)
      }
    }
    return next(e)
  })

  // Plan mode ended: a message sent in any other mode.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.agent_id === undefined && e.permission_mode !== undefined && e.permission_mode !== 'plan') await endSession($)
    return next(e)
  })

  // Hold the plan until the person decides. Send feedback answers with a deny
  // and Claude revises; Continue hands the call to the engine's own approval
  // dialog, since a plugin's allow for ExitPlanMode is not honored.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const path = await read($, planPath)
    if (e.agentId !== undefined || path === null) return next(e)
    // Nobody to answer (no screen attached, as in an SDK host): don't hold
    // the plan for buttons nobody can see; Claude Code handles it as usual.
    if ((await $.session.surfaces()).length === 0) return next(e)

    // Each step names itself, so a failure says what broke.
    let step = `couldn't read the plan file ${path}`
    let decision: Decision | undefined
    try {
      const text = await $.fs.read(path)
      step = "couldn't save the review"
      const isNewSession = await read($, sessionEnded)
      const seen = await read($, history)
      const all = isNewSession ? [text] : seen.at(-1) === text ? seen : [...seen, text]
      await update($, history, () => all)
      if (isNewSession) await update($, sessionEnded, () => false)

      const before = all.length > 1 ? all[all.length - 2] : undefined
      const current: Review = {
        toolUseId: e.tool_use_id,
        version: all.length,
        lines: splitLines(text),
        previous: before === undefined ? null : splitLines(before),
        notes: {},
        selected: null,
      }
      await update($, review, () => current)

      step = 'the wait command failed'
      try {
        while ((decision = decisions.get(current.toolUseId)) === undefined && !next.signal.aborted) {
          await tick($)
        }
      } finally {
        decisions.delete(current.toolUseId)
        try {
          await update($, review, () => null)
        } catch {
          // The dispatch was abandoned (Esc); session.start clears it later.
        }
      }
    } catch (error) {
      if (!next.signal.aborted) reportError($, step, errorText(error))
      return next(e)
    }

    if (decision?.kind === 'feedback') return { deny: decision.text }

    const result = await next(e)
    // Plan mode ended: the plan was approved in the engine's dialog.
    if (!next.signal.aborted && result.deny === undefined && result.isError !== true) await endSession($)
    return result
  }).catch(($, e, next) => {
    // Anything else, the hook's time limit included. Not once the plan has
    // gone on to the engine's dialog, nor after Esc.
    if (next.error.kind !== 're-entry' && !next.called && !next.signal.aborted) {
      reportError($, 'Plan ABC failed', next.error.message)
    }
    return next(e)
  })

  // The plan at full height in its own transcript row; see drawPlan.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'ExitPlanMode') return next(e)
    const current = await read($, review)
    if (current?.toolUseId !== e.props.tool_use_id) return next(e)

    return drawPlan($.ui.resolve(e), current, actionsFor($, current.toolUseId))
  }).catch(($, e, next) => {
    // Drawing failed: say so in red where the plan would be, and keep
    // Continue, which ends the hold and opens the engine's dialog.
    if (e.props.tool !== 'ExitPlanMode' || next.error.kind === 're-entry') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const reason = next.error.message ? ` (${next.error.message})` : ''
    return (
      <Box flexDirection="column">
        <Text color={ERROR}>Error: Plan ABC couldn't draw the plan{reason}. Continue still works.</Text>
        {decisionButtons(Button, 0, actionsFor($, e.props.tool_use_id), 'error')}
      </Box>
    )
  })

  // Sent feedback is a refusal to the engine, which draws it as an error.
  // Draw it as what it is.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== 'ExitPlanMode' || !e.props.isErrored) return next(e)
    const output = typeof e.props.output === 'string' ? e.props.output : JSON.stringify(e.props.output ?? '')
    if (!output.includes(FEEDBACK_HEADER)) return next(e)
    const n = countFeedbackLines(output)
    const { Text } = $.ui.resolve(e)
    return (
      <Text color="suggestion">
        Plan ABC · feedback sent · {n} comment{n === 1 ? '' : 's'}
      </Text>
    )
  })

  // A short bar above the prompt that never scrolls: the controls stay in reach.
  // In focus order the ↑ ↓ buttons come before the comment field and the
  // actions after it, so the arrow keys step off the field onto one side or
  // the other (see the ui.focus hook below). BAR_ORDER lists that order.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, review)
    if (current === null || e.props.hasSurvey) return next(e)
    // The band is raised on these two alone; both draw an Input.
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const count = noteCount(current)
    const n = current.selected
    const diff = current.previous === null ? null : diffLines(current.previous, current.lines)
    const unit = n === null ? null : unitRange(layoutMarkdown(current.lines), n)
    const where =
      unit === null ? 'Pick a line' : unit.end > unit.start ? `Comment on lines ${unit.start}-${unit.end}` : `Comment on line ${unit.start}`

    const actions = decisionButtons(Button, count, actionsFor($, current.toolUseId))

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Plan ABC</Text> · version {current.version}
          {diff ? ` · ${describeCounts(diff.counts)}` : ''} · {count} comment{count === 1 ? '' : 's'}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="up" hotkey="k" onPress={() => move($, -1)}>
            ↑
          </Button>
          <Button key="down" hotkey="j" onPress={() => move($, 1)}>
            ↓
          </Button>
          <Input
            key="comment"
            placeholder={where}
            value={n === null ? '' : (current.notes[String(n)] ?? '')}
            submitLabel="save"
            autoFocus
            onSubmit={value => {
              if (n === null) $.ui.toast('Plan ABC: pick a line first (↑ ↓ or click it)')
              else saveNote($, value)
            }}
          />
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {actions}
        </Box>
      </Box>
    )
  })

  // ↑/↓ while the comment field has the keys: the ring would step off it,
  // backward onto ↓ or forward onto the first action. Move the selected line
  // that way instead and keep the ring in the field. (Tab steps the same way
  // and cannot be told apart, so it moves the line too.)
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const from = BAR_ORDER.indexOf('comment')
    const to = e.element === undefined ? -1 : BAR_ORDER.indexOf(e.element)
    const isStepOff = e.origin.kind === 'person' && ringOn === 'comment' && e.plugin === 'plan-abc' && to >= 0
    if (isStepOff && to !== from) {
      await move($, to < from ? -1 : 1)
      const kept = await next({ ...e, element: 'comment' })
      if (kept.deny === undefined) ringOn = 'comment'
      return kept
    }
    const moved = await next(e)
    if (moved.deny === undefined) ringOn = e.element
    return moved
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if ((await read($, review)) === null) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text color={WAITING}>◆ Plan ABC · waiting for your review</Text>
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const current = await read($, review)
    if (current === null) return next(e)
    const tail = noteCount(current) > 0 ? ' · Plan ABC: 1 continue · 2 send feedback' : ' · Plan ABC: 1 continue'
    return next({ ...e, props: { ...e.props, tail } })
  })
}
