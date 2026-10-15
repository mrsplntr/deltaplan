// The plan row's drawing: the plan at full height, formatted from its
// Markdown and colored against the previous version. Each file line is one
// row (line number | diff gutter | text) and a plain button: a click selects
// it for a comment in the bar above the prompt. A diagram or table is one unit.
//
// Pure: it takes the surface's elements and what the buttons do, and never
// sees $, which may not cross into an imported file.

import type { BoxProps, ButtonProps, ElementConstructor, RenderChildren, RenderElement, TextProps } from 'claude-code'

import type { Review } from '../types'
import { describeCounts, diffLines } from './diff'
import { noteCount } from './feedback'
import type { DisplayLine, Span } from './markdown'
import { layoutMarkdown, spansWidth, unitRange } from './markdown'

export type Elements = {
  Box: ElementConstructor<BoxProps>
  Button: ElementConstructor<ButtonProps>
  Text: ElementConstructor<TextProps>
}

// What the buttons do, for the plan under review.
export type Actions = {
  onContinue: () => void
  onFeedback: () => void
  onSelect: (n: number) => void
}

// Git-like colors from the person's theme.
const ADDED = 'success'
const REMOVED = 'error'
const COMMENT = 'inactive'
// Inline `code` and link text. Code blocks use the normal text color, as in
// the approval dialog.
const CODE = 'permission'
const LINK = 'suggestion'

// The diff gutter's width in columns: the symbol with a space either side.
const GUTTER = 3

// Continue and Send feedback, written once for every place that draws them:
// the plan row (above and below the plan), the bar, and the drawing-error
// line. `where` keeps two sets in one tree apart; the bar's alone (no
// `where`) carry the hotkeys 1 and 2 and the plain keys its focus order names.
export function decisionButtons(
  Button: ElementConstructor<ButtonProps>,
  count: number,
  actions: Actions,
  where?: string,
): RenderElement[] {
  const isBar = where === undefined
  const buttons = [
    <Button
      key={isBar ? 'continue' : `continue-${where}`}
      {...(isBar ? { hotkey: '1' } : {})}
      variant="primary"
      onPress={actions.onContinue}
    >
      Continue to approval
    </Button>,
  ]
  if (count > 0) {
    buttons.push(
      <Button key={isBar ? 'feedback' : `feedback-${where}`} {...(isBar ? { hotkey: '2' } : {})} onPress={actions.onFeedback}>
        Send feedback ({count})
      </Button>,
    )
  }
  return buttons
}

export function drawPlan(elements: Elements, current: Review, actions: Actions): RenderElement {
  const { Box, Button, Text } = elements
  // Wide enough for the old numbers too, which removed lines show.
  const width = String(Math.max(current.lines.length, current.previous?.length ?? 0)).length
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
          const pad = w - spansWidth(cell)
          return [
            ...(c > 0 ? [plain(' │ ', { dim: true })] : []),
            ...spans(cell, tint, inverse, line.isHeader),
            ...(pad > 0 ? [plain(' '.repeat(pad))] : []),
          ]
        })
    }
  }

  const controls = (where: string) => (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {decisionButtons(Button, count, actions, where)}
    </Box>
  )

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
          <Button key={`line-${n}`} plain onPress={() => actions.onSelect(n)}>
            {body(line, current.lines[n - 1] ?? '', isAdded ? ADDED : undefined, isSelected, widths)}
          </Button>,
        )}
        {note !== undefined && columns(`note-${n}`, null, '', undefined, <Text color={COMMENT}>{note}</Text>)}
      </Box>
    )
  }

  // A removed line is no longer in the plan: nothing to click. It shows its
  // number in the previous version and is
  // formatted as the previous version laid it out.
  const removedRow = (key: string, from: number, text: string, widths?: number[]) =>
    columns(key, from, '-', REMOVED, <Text>{body(oldLayout[from - 1], text, REMOVED, false, widths)}</Text>)

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
        DeltaPlan · version {current.version}
        {diff ? ` · ${describeCounts(diff.counts)}` : ''}
      </Text>
      {controls('top')}
      <Box flexDirection="column" marginTop={1}>
        {plan}
      </Box>
      {controls('bottom')}
    </Box>
  )
}
