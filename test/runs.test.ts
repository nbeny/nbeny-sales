import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseRuns, formatDuration } from '../src/lib/runs.ts'

const NOW = new Date('2026-09-28T12:00:00')

describe('parseRuns', () => {
  test('associe START et END, exit 0 = OK', () => {
    const runs = parseRuns(
      '2026-09-28T08:30:01  START  /sales\n' +
      '2026-09-28T08:52:10  END    /sales  exit=0  log=sales-2026-09-28_08-30.log\n',
      NOW,
    )
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'OK')
    assert.equal(runs[0].command, '/sales')
    assert.equal(runs[0].log, 'sales-2026-09-28_08-30.log')
  })

  test('exit non nul = FAILED', () => {
    const runs = parseRuns('2026-09-28T08:30:01  START  /sales\n2026-09-28T08:31:00  END    /sales  exit=1  log=x.log', NOW)
    assert.equal(runs[0].status, 'FAILED')
    assert.equal(runs[0].exitCode, 1)
  })

  test('START sans END ancien = INTERRUPTED, récent = RUNNING', () => {
    const runs = parseRuns(
      '2026-09-25T08:30:00  START  /sales\n' +
      '2026-09-28T11:30:00  START  /sales\n',
      NOW,
    )
    assert.deepEqual(runs.map((r) => r.status), ['INTERRUPTED', 'RUNNING'])
  })

  test('commande avec espaces, BOM et lignes illisibles tolérés', () => {
    const runs = parseRuns(
      '﻿2026-09-28T08:30:00  START  Exécute la commande stats\n' +
      'ligne corrompue\n' +
      '2026-09-28T08:30:10  END    Exécute la commande stats  exit=0  log=a.log\r\n',
      NOW,
    )
    assert.equal(runs.length, 1)
    assert.equal(runs[0].command, 'Exécute la commande stats')
  })

  test('journal vide', () => {
    assert.deepEqual(parseRuns('', NOW), [])
  })
})

test('formatDuration', () => {
  assert.equal(formatDuration(13_000), '13 s')
  assert.equal(formatDuration(22 * 60_000 + 9_000), '22 min 09')
  assert.equal(formatDuration(125 * 60_000), '2 h 05')
})
