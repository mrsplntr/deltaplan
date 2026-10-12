import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review } from '../types'
import { buildFeedback, noteCount } from './feedback'

const planPath = atom({ plugin: 'plan-abc', key: 'planPath' } as const, null)
const history = atom({ plugin: 'plan-abc', key: 'history' } as const, [])
const revisionPending = atom({ plugin: 'plan-abc', key: 'revisionPending' } as const, false)
const review = atom({ plugin: 'plan-abc', key: 'review' } as const, null)

type Decision = { kind: 'continue' } | { kind: 'feedback'; text: string }

// Button presses, by tool_use_id. A module variable, not $.state: every
// $.state read inside one dispatch sees the same moment, so the held
// tool.call hook would never see a write made after it started.
const decisions = new Map<string, Decision>()

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

function saveNote($: EngineInterface, n: number, text: string): void {
  const comment = text.trim()
  update($, review, r => {
    if (r === null) return r
    const notes = { ...r.notes }
    if (comment === '') delete notes[String(n)]
    else notes[String(n)] = comment
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

function quoteShort(line: string): string {
  const text = line.trim()
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
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

    const current: Review = {
      toolUseId: e.tool_use_id,
      path,
      version: all.length,
      lines: text.split(/\r?\n/),
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
    return next(e)
  }).catch(($, e, next) => next(e))

  // The plan at full height in its own transcript row. Each line is a plain
  // button: a click selects it for a comment in the bar above the prompt.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'ExitPlanMode') return next(e)
    const current = await read($, review)
    if (current?.toolUseId !== e.props.tool_use_id) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = String(current.lines.length).length
    const count = noteCount(current)

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
        items.push(<Text key={`gap-${where}`}> </Text>)
        items.push(
          <Button key={`feedback-${where}`} onPress={() => sendFeedback($, current.toolUseId)}>
            Send feedback ({count})
          </Button>,
        )
      }
      return <Box flexDirection="row">{items}</Box>
    }

    return (
      <Box flexDirection="column">
        <Text bold>Plan ABC · version {current.version}</Text>
        {controls('top')}
        {current.lines.map((line, i) => {
          const n = i + 1
          const note = current.notes[String(n)]
          const rows = [
            <Button key={`line-${n}`} plain onPress={() => select($, n)}>
              <Text dimColor>{String(n).padStart(width)} </Text>
              <Text inverse={current.selected === n}>{line === '' ? ' ' : line}</Text>
            </Button>,
          ]
          if (note !== undefined) {
            rows.push(
              <Box key={`note-${n}`} paddingLeft={width + 5}>
                <Text color="gray">{note}</Text>
              </Box>,
            )
          }
          return (
            <Box key={`row-${n}`} flexDirection="column">
              {rows}
            </Box>
          )
        })}
        {controls('bottom')}
      </Box>
    )
  })

  // A short bar above the prompt that never scrolls: the controls stay in reach.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, review)
    if (current === null || e.props.hasSurvey) return next(e)
    // The band is raised on these two alone; both draw an Input.
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const count = noteCount(current)
    const n = current.selected

    const comment =
      n === null ? (
        <Text dimColor>Click a plan line to comment on it, or use ↑ ↓ here</Text>
      ) : (
        <Input
          key={`comment-${n}`}
          label={`Line ${n} "${quoteShort(current.lines[n - 1] ?? '')}": `}
          placeholder="type a comment (empty removes it)"
          value={current.notes[String(n)] ?? ''}
          submitLabel="save"
          autoFocus
          onSubmit={value => saveNote($, n, value)}
        />
      )

    const buttons = [
      <Button key="prev" hotkey="k" onPress={() => move($, -1)}>
        ↑ line
      </Button>,
      <Button key="next" hotkey="j" onPress={() => move($, 1)}>
        ↓ line
      </Button>,
    ]
    if (count > 0) {
      buttons.push(
        <Button key="feedback" hotkey="2" onPress={() => sendFeedback($, current.toolUseId)}>
          Send feedback ({count})
        </Button>,
      )
    }
    buttons.push(
      <Button
        key="continue"
        hotkey="1"
        variant="primary"
        autoFocus
        onPress={() => {
          decisions.set(current.toolUseId, { kind: 'continue' })
        }}
      >
        Continue to approval
      </Button>,
    )

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Plan ABC</Text> · version {current.version} · {count} comment{count === 1 ? '' : 's'} · plan
          shown above
        </Text>
        {comment}
        <Box flexDirection="row" gap={1}>
          {buttons}
        </Box>
      </Box>
    )
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
