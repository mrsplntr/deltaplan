import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review } from '../types'
import { describeCounts, diffLines } from './diff'
import { buildFeedback, countFeedbackLines, FEEDBACK_HEADER, noteCount } from './feedback'

const planPath = atom({ plugin: 'plan-abc', key: 'planPath' } as const, null)
const history = atom({ plugin: 'plan-abc', key: 'history' } as const, [])
const revisionPending = atom({ plugin: 'plan-abc', key: 'revisionPending' } as const, false)
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

// Git-like colors from the person's theme.
const ADDED = 'success'
const REMOVED = 'error'
const COMMENT = 'inactive'

// A wait run as a host process: unlike $.clock.sleep it does not spend the
// hook's 10 s budget. `sleep` is missing on Windows, so fall back to a local
// ping (about one second) once it fails to start.
let isWindows = false

async function tick($: EngineInterface): Promise<void> {
  if (!isWindows) {
    try {
      await $.process.run(['sleep', '0.4'], { timeoutMs: 5000 })
      return
    } catch {
      isWindows = true
    }
  }
  await $.process.run(['ping', '-n', '2', '127.0.0.1'], { timeoutMs: 5000 })
}

// What the buttons do. Each runs from a press, so its reads are current.
function select($: EngineInterface, n: number): void {
  update($, review, r => (r === null ? r : { ...r, selected: n }))
}

async function move($: EngineInterface, delta: number): Promise<void> {
  const r = await read($, review)
  if (r === null) return
  const last = r.lines.length
  const from = r.selected ?? (delta > 0 ? 0 : last + 1)
  const n = Math.min(last, Math.max(1, from + delta))
  await update($, review, cur => (cur === null ? cur : { ...cur, selected: n }))
  // Bring the line into view in the transcript; harmless when refused.
  $.ui.scroll({ to: { key: `line-${n}` }, block: 'center' }).catch(() => {})
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
    const detail = (e as { detail?: { planFilePath?: string } }).detail
    const isPlanRow = e.type === 'plan_mode' || e.type === 'plan_mode_reentry'
    if (isPlanRow && e.agentId === undefined && detail?.planFilePath) {
      const path = detail.planFilePath
      if ((await read($, planPath)) !== path) await update($, planPath, () => path)
    }
    return next(e)
  })

  // Hold the plan until the person decides. Send feedback answers with a deny
  // (Claude revises); Continue hands the call to the engine's own approval
  // dialog, since a plugin's allow for ExitPlanMode is not honored.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const path = await read($, planPath)
    if (e.agentId !== undefined || path === null) return next(e)

    const text = await $.fs.read(path)
    const isRevision = await read($, revisionPending)
    const seen = await read($, history)
    const all = isRevision ? (seen.at(-1) === text ? seen : [...seen, text]) : [text]
    await update($, history, () => all)
    if (isRevision) await update($, revisionPending, () => false)

    const before = all.length > 1 ? all[all.length - 2] : undefined
    const current: Review = {
      toolUseId: e.tool_use_id,
      path,
      version: all.length,
      lines: text.split(/\r?\n/),
      previous: before === undefined ? null : before.split(/\r?\n/),
      notes: {},
      selected: null,
    }
    await update($, review, () => current)

    let decision: Decision | undefined
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

    if (decision?.kind === 'feedback') {
      await update($, revisionPending, () => true)
      return { deny: decision.text }
    }

    const result = await next(e)
    // Refused in the engine's dialog ("Tell Claude what to change", "keep
    // planning"): the plan that comes back next is a revision of this one.
    if (!next.signal.aborted && (result.deny !== undefined || result.isError === true)) {
      await update($, revisionPending, () => true)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The plan at full height in its own transcript row, colored against the
  // previous version. Each current line is a plain button: a click selects it
  // for a comment in the bar above the prompt.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'ExitPlanMode') return next(e)
    const current = await read($, review)
    if (current?.toolUseId !== e.props.tool_use_id) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = String(current.lines.length).length
    const count = noteCount(current)
    const diff = current.previous === null ? null : diffLines(current.previous, current.lines)
    const num = (n: number) => String(n).padStart(width)

    const controls = (where: string) => {
      const items = [
        <Button
          key={`continue-${where}`}
          variant="primary"
          onPress={() => {
            decisions.set(current.toolUseId, { kind: 'continue' })
          }}
        >
          Continue to approval
        </Button>,
      ]
      if (count > 0) {
        items.push(
          <Button key={`feedback-${where}`} onPress={() => sendFeedback($, current.toolUseId)}>
            Send feedback ({count})
          </Button>,
        )
      }
      return (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {items}
        </Box>
      )
    }

    const lineRow = (n: number, text: string, color?: string) => {
      const note = current.notes[String(n)]
      return (
        <Box key={`row-${n}`} flexDirection="column">
          <Button key={`line-${n}`} plain onPress={() => select($, n)}>
            <Text dimColor>{num(n)} </Text>
            <Text color={color} inverse={current.selected === n}>
              {text === '' ? ' ' : text}
            </Text>
          </Button>
          {note !== undefined && (
            <Box paddingLeft={width + 1}>
              <Text color={COMMENT}>{note}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const removedRow = (key: string, n: number, text: string) => (
      <Box key={key} flexDirection="row">
        <Text dimColor>{num(n)} </Text>
        <Text color={REMOVED} strikethrough>
          {text === '' ? ' ' : text}
        </Text>
      </Box>
    )

    const plan = diff
      ? diff.rows.map((row, i) =>
          row.kind === 'removed'
            ? removedRow(`removed-${i}`, row.line, row.text)
            : lineRow(row.line, row.text, row.kind === 'added' ? ADDED : undefined),
        )
      : current.lines.map((line, i) => lineRow(i + 1, line))

    return (
      <Box flexDirection="column">
        <Text bold>
          Plan ABC · version {current.version}
          {diff ? ` · ${describeCounts(diff.counts)}` : ''}
        </Text>
        {controls('top')}
        <Box flexDirection="column" marginTop={1}>
          {plan}
        </Box>
        {controls('bottom')}
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

    const actions = [
      <Button
        key="continue"
        hotkey="1"
        variant="primary"
        onPress={() => {
          decisions.set(current.toolUseId, { kind: 'continue' })
        }}
      >
        Continue to approval
      </Button>,
    ]
    if (count > 0) {
      actions.push(
        <Button key="feedback" hotkey="2" onPress={() => sendFeedback($, current.toolUseId)}>
          Send feedback ({count})
        </Button>,
      )
    }

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
            placeholder={n === null ? 'Pick a line' : `Comment on line ${n}`}
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
    return <Text color="yellow">◆ Plan ABC · waiting for your review</Text>
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const current = await read($, review)
    if (current === null) return next(e)
    const tail = noteCount(current) > 0 ? ' · Plan ABC: 1 continue · 2 send feedback' : ' · Plan ABC: 1 continue'
    return next({ ...e, props: { ...e.props, tail } })
  })
}
