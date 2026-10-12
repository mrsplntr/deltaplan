import { expect, test } from 'claude-code/testing'

import { buildFeedback, noteCount } from '../hooks/feedback'
import type { Review } from '../types'

const review: Review = {
  toolUseId: 'toolu_1',
  path: 'plan.md',
  version: 1,
  lines: ['# Plan', '', '1. Set up', '4. Use Redis for the cache', 'x'.repeat(200)],
  notes: { '5': 'Too long?', '4': 'Why Redis and not Postgres?' },
  selected: null,
}

test('feedback lists notes in line order, quoting each line', () => {
  expect(noteCount(review)).toBe(2)
  expect(buildFeedback(review)).toBe(
    [
      'The user reviewed the plan in Plan ABC. Revise the plan and submit it again.',
      'Line 4 "4. Use Redis for the cache": comment — Why Redis and not Postgres?',
      `Line 5 "${'x'.repeat(119)}…": comment — Too long?`,
    ].join('\n'),
  )
})
