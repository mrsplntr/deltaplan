import { expect, test } from 'claude-code/testing'

import { buildFeedback, countFeedbackLines, noteCount } from '../hooks/feedback'
import type { Review } from '../types'

const review: Review = {
  toolUseId: 'toolu_1',
  version: 1,
  lines: ['# Plan', '', '1. Set up', '4. Use Redis for the cache', 'x'.repeat(200)],
  previous: null,
  notes: { '5': 'Too long?', '4': 'Why Redis and not Postgres?' },
  selected: null,
}

test('feedback lists notes in line order, quoting each line', () => {
  expect(noteCount(review)).toBe(2)
  expect(buildFeedback(review)).toBe(
    [
      'The user reviewed the plan in DeltaPlan. Revise the plan and submit it again.',
      'Line 4 "4. Use Redis for the cache": comment — Why Redis and not Postgres?',
      `Line 5 "${'x'.repeat(119)}…": comment — Too long?`,
    ].join('\n'),
  )
  expect(countFeedbackLines(buildFeedback(review))).toBe(2)
})

test('feedback quotes the Markdown as written, and a diagram or table by its range', () => {
  const plan: Review = {
    ...review,
    lines: ['## Use **Redis**', '```mermaid', 'graph TD', '  A --> B', '```', '| A | B |', '|---|---|', '| 1 | 2 |'],
    notes: { '1': 'Why bold?', '2': 'Add a cache box', '6': 'Add a column' },
  }
  expect(buildFeedback(plan)).toBe(
    [
      'The user reviewed the plan in DeltaPlan. Revise the plan and submit it again.',
      'Line 1 "## Use **Redis**": comment — Why bold?',
      'Lines 2-5 (diagram) "```mermaid": comment — Add a cache box',
      'Lines 6-8 (table) "| A | B |": comment — Add a column',
    ].join('\n'),
  )
  expect(countFeedbackLines(buildFeedback(plan))).toBe(3)
})
