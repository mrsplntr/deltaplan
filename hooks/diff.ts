// A plain line-by-line diff of two plan versions (longest common
// subsequence). No model is involved.

export type DiffRow =
  | { kind: 'same'; line: number; text: string }
  | { kind: 'added'; line: number; text: string; isChange: boolean }
  // `line` is where the removed text stood in the new version: the number of
  // the new line that now follows it.
  | { kind: 'removed'; line: number; text: string; isChange: boolean }

export type DiffCounts = { changed: number; added: number; removed: number }

export type Diff = { rows: DiffRow[]; counts: DiffCounts }

// Past this many cells the table would be slow; the diff then treats every
// line as replaced, which is still correct, only coarser.
const MAX_CELLS = 4_000_000

export function diffLines(before: readonly string[], after: readonly string[]): Diff {
  const n = before.length
  const m = after.length
  const ops: { kind: 'same' | 'added' | 'removed'; text: string }[] = []

  if (n * m <= MAX_CELLS) {
    // lengths[i][j]: the common subsequence of before[i..] and after[j..].
    const lengths: Uint32Array[] = []
    for (let i = 0; i <= n; i++) lengths.push(new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      const row = lengths[i]!
      const below = lengths[i + 1]!
      for (let j = m - 1; j >= 0; j--) {
        row[j] = before[i] === after[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (before[i] === after[j]) {
        ops.push({ kind: 'same', text: after[j]! })
        i++
        j++
      } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
        ops.push({ kind: 'removed', text: before[i++]! })
      } else {
        ops.push({ kind: 'added', text: after[j++]! })
      }
    }
    while (i < n) ops.push({ kind: 'removed', text: before[i++]! })
    while (j < m) ops.push({ kind: 'added', text: after[j++]! })
  } else {
    for (const text of before) ops.push({ kind: 'removed', text })
    for (const text of after) ops.push({ kind: 'added', text })
  }

  // Number the rows by the new version, and pair each run of removed lines
  // with the added run that follows it, as git shows a changed line.
  const rows: DiffRow[] = []
  const counts: DiffCounts = { changed: 0, added: 0, removed: 0 }
  let next = 1
  let k = 0
  while (k < ops.length) {
    const op = ops[k]!
    if (op.kind === 'same') {
      rows.push({ kind: 'same', line: next++, text: op.text })
      k++
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    while (k < ops.length && ops[k]!.kind !== 'same') {
      const o = ops[k++]!
      if (o.kind === 'removed') removed.push(o.text)
      else added.push(o.text)
    }
    const pairs = Math.min(removed.length, added.length)
    counts.changed += pairs
    counts.removed += removed.length - pairs
    counts.added += added.length - pairs
    removed.forEach((text, r) => rows.push({ kind: 'removed', line: next + r, text, isChange: r < pairs }))
    added.forEach((text, a) => rows.push({ kind: 'added', line: next + a, text, isChange: a < pairs }))
    next += added.length
  }
  return { rows, counts }
}

export function describeCounts({ changed, added, removed }: DiffCounts): string {
  return `${changed} changed · ${added} added · ${removed} removed`
}

