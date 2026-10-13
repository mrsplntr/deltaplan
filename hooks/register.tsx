import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Review } from '../types'
import { describeCounts, diffLines } from './diff'
import { buildFeedback, countFeedbackLines, FEEDBACK_HEADER, noteCount } from './feedback'
import type { DisplayLine, Span } from './markdown'
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

// Git-like colors from the person's theme.
const ADDED = 'success'
const REMOVED = 'error'
const COMMENT = 'inactive'
const ERROR = 'error'
// The spinner while a plan waits: the theme's warning color, readable on
// light and dark backgrounds alike.
const WAITING = 'warning'
// Inline `code` and link text. Code blocks use the normal text color, as in
// the approval dialog.
const CODE = 'permission'
const LINK = 'suggestion'

// The diff gutter's width in columns: the symbol with a space either side.
const GUTTER = 3

// A wait run as a host process: unlike $.clock.sleep it does not spend the
// hook's 10 s budget. macOS and Linux always have `sleep`. Windows has it only
// with Git installed, so there a `sleep` that fails to start switches to a
// local ping (about one second). Windows always sets OS to Windows_NT.
const SLEEP = ['sleep', '0.4']
const PING = ['ping', '-n', '2', '127.0.0.1']
let waitCommand: readonly string[] = SLEEP
let isWindows: boolean | undefined

async function tick($: EngineInterface): Promise<void> {
  isWindows ??= (await $.env.get('OS')) === 'Windows_NT'
  try {
    await $.process.run(waitCommand, { timeoutMs: 5000 })
  } catch (error) {
    if (!isWindows || waitCommand === PING) throw error
    waitCommand = PING
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

  // The plan at full height in its own transcript row, formatted from its
  // Markdown and colored against the previous version. Each file line is one
  // row (line number | diff gutter | text) and a plain button: a click selects
  // it for a comment in the bar above the prompt. A diagram or table is one unit.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'ExitPlanMode') return next(e)
    const current = await read($, review)
    if (current?.toolUseId !== e.props.tool_use_id) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = String(current.lines.length).length
    const count = noteCount(current)
    const diff = current.previous === null ? null : diffLines(current.previous, current.lines)
    const layout = layoutMarkdown(current.lines)
    const oldLayout = current.previous === null ? [] : layoutMarkdown(current.previous)
    const selected = current.selected === null ? null : unitRange(layout, current.selected)

    // One row of the plan as columns, like a CSS grid: the line number, a
    // fixed 3-wide gutter for the diff symbol, then the text, which wraps
    // inside its own column so continuation lines stay under the text.
    const columns = (key: string, n: number | null, symbol: string, symbolColor: string | undefined, body: RenderChildren) => (
      <Box key={key} flexDirection="row">
        <Box width={width} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{n === null ? '' : String(n)}</Text>
        </Box>
        <Box width={GUTTER} flexShrink={0} justifyContent="center">
          <Text color={symbolColor}>{symbol}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {body}
        </Box>
      </Box>
    )

    // Styled pieces of one display line, as a Button's children (strings and
    // Text only). `tint` is the diff color, over every other color.
    const spans = (list: readonly Span[], tint: string | undefined, inverse: boolean, bold = false) =>
      list.map(s => (
        <Text
          color={tint ?? (s.code ? CODE : s.link ? LINK : undefined)}
          bold={bold || s.bold === true}
          italic={s.italic === true}
          underline={s.link === true}
          strikethrough={s.strike === true}
          inverse={inverse}
        >
          {s.text}
        </Text>
      ))

    // `widths` overrides a table row's own column widths (see tableWidths).
    const body = (line: DisplayLine | undefined, raw: string, tint: string | undefined, inverse: boolean, widths?: number[]) => {
      const plain = (text: string, extra: { dim?: boolean; color?: string; truncate?: boolean } = {}) => (
        <Text
          color={tint ?? extra.color}
          dimColor={tint === undefined && extra.dim === true}
          inverse={inverse}
          wrap={extra.truncate ? 'truncate-end' : undefined}
        >
          {text === '' ? ' ' : text}
        </Text>
      )
      switch (line?.kind) {
        case undefined:
          return [plain(raw)]
        case 'blank':
          return [plain(' ')]
        case 'heading':
          return spans(line.spans, tint, inverse, true)
        case 'text':
          return line.spans.length === 0 ? [plain(' ')] : spans(line.spans, tint, inverse)
        case 'item':
          return [plain(line.indent + line.marker, { dim: line.isQuote }), ...spans(line.spans, tint, inverse)]
        case 'rule':
          return [plain('─'.repeat(24), { dim: true })]
        case 'fence':
          return [plain(line.text, { dim: true })]
        case 'code':
          return [plain(line.text)]
        case 'diagram':
          return [plain(line.text, { truncate: true })]
        case 'tableRule':
          return [plain((widths ?? line.widths).map(w => '─'.repeat(w)).join('─┼─'), { dim: true })]
        case 'table':
          return (widths ?? line.widths).flatMap((w, c) => {
            const cell = line.cells[c] ?? []
            const pad = w - cell.reduce((sum, s) => sum + s.text.length, 0)
            return [
              ...(c > 0 ? [plain(' │ ', { dim: true })] : []),
              ...spans(cell, tint, inverse, line.isHeader),
              ...(pad > 0 ? [plain(' '.repeat(pad))] : []),
            ]
          })
      }
    }

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

    // A line of the current version, always with its own number. A diagram or
    // table is selected as one unit; a comment shows under its last line.
    const lineRow = (n: number, isAdded: boolean, widths?: number[]) => {
      const line = layout[n - 1]
      const unit = unitRange(layout, n)
      const isSelected = selected !== null && selected.start === unit.start
      const note = n === unit.end ? current.notes[String(unit.start)] : undefined
      return (
        <Box key={`row-${n}`} flexDirection="column">
          {columns(
            `text-${n}`,
            n,
            isAdded ? '+' : '',
            ADDED,
            <Button key={`line-${n}`} plain onPress={() => select($, n)}>
              {body(line, current.lines[n - 1] ?? '', isAdded ? ADDED : undefined, isSelected, widths)}
            </Button>,
          )}
          {note !== undefined && columns(`note-${n}`, null, '', undefined, <Text color={COMMENT}>{note}</Text>)}
        </Box>
      )
    }

    // A removed line is no longer in the plan: no number, nothing to click.
    // It is formatted as the previous version laid it out.
    const removedRow = (key: string, from: number, text: string, widths?: number[]) =>
      columns(key, null, '-', REMOVED, <Text>{body(oldLayout[from - 1], text, REMOVED, false, widths)}</Text>)

    // Each run of table rows shown together (old and new versions mixed)
    // shares one set of column widths, the widest of them all, so the "│"
    // columns line up across the removed and added rows. By diff row index.
    const tableWidths = new Map<number, number[]>()
    if (diff) {
      const shownAs = (row: (typeof diff.rows)[number]) =>
        row.kind === 'removed' ? oldLayout[row.from - 1] : layout[row.line - 1]
      let run: number[] = []
      const closeRun = () => {
        const widths: number[] = []
        for (const i of run) {
          const line = shownAs(diff.rows[i]!)
          if (line?.kind !== 'table' && line?.kind !== 'tableRule') continue
          line.widths.forEach((w, c) => (widths[c] = Math.max(widths[c] ?? 0, w)))
        }
        for (const i of run) tableWidths.set(i, widths)
        run = []
      }
      diff.rows.forEach((row, i) => {
        const kind = shownAs(row)?.kind
        if (kind === 'table' || kind === 'tableRule') run.push(i)
        else closeRun()
      })
      closeRun()
    }

    const plan = diff
      ? diff.rows.map((row, i) =>
          row.kind === 'removed'
            ? removedRow(`removed-${i}`, row.from, row.text, tableWidths.get(i))
            : lineRow(row.line, row.kind === 'added', tableWidths.get(i)),
        )
      : current.lines.map((_, i) => lineRow(i + 1, false))

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
  }).catch(($, e, next) => {
    // Drawing failed: say so in red where the plan would be, and keep
    // Continue, which ends the hold and opens the engine's dialog.
    if (e.props.tool !== 'ExitPlanMode' || next.error.kind === 're-entry') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const id = e.props.tool_use_id
    const reason = next.error.message ? ` (${next.error.message})` : ''
    return (
      <Box flexDirection="column">
        <Text color={ERROR}>Error: Plan ABC couldn't draw the plan{reason}. Continue still works.</Text>
        <Button
          variant="primary"
          onPress={() => {
            decisions.set(id, { kind: 'continue' })
          }}
        >
          Continue to approval
        </Button>
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
