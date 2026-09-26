/**
 * Lecture du journal des lancements planifiés (`logs/cron-runs.log`).
 *
 * `scripts/sales-cron.ps1` écrit une ligne START avant de lancer Claude et une
 * ligne END après. Un START sans END, c'est un lancement coupé (PC éteint, mise
 * en veille, limite de 2 h du Planificateur) : on le montre, on ne le cache pas.
 */

export type RunStatus = 'OK' | 'FAILED' | 'RUNNING' | 'INTERRUPTED'

export interface Run {
  start: Date
  end?: Date
  command: string
  exitCode?: number
  log?: string
  status: RunStatus
}

/** Au-delà, un START sans END ne peut plus être en cours : la tâche est limitée à 2 h. */
const MAX_RUN_MS = 2 * 60 * 60 * 1000

const LINE = /^(\S+)\s+(START|END)\s+(.*?)(?:\s+exit=(-?\d+))?(?:\s+log=(\S+))?\s*$/

export function parseRuns(text: string, now: Date = new Date()): Run[] {
  const runs: Run[] = []
  let open: Run | undefined

  const close = (run: Run) => {
    if (!run.end) run.status = now.getTime() - run.start.getTime() < MAX_RUN_MS ? 'RUNNING' : 'INTERRUPTED'
    runs.push(run)
  }

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.trim().match(LINE)
    if (!m) continue
    const [, at, kind, command, exit, log] = m
    const date = new Date(at)
    if (Number.isNaN(date.getTime())) continue

    if (kind === 'START') {
      if (open) close(open)
      open = { start: date, command, status: 'RUNNING' }
    } else if (open) {
      open.end = date
      open.exitCode = exit === undefined ? undefined : Number(exit)
      open.log = log
      open.status = open.exitCode === 0 ? 'OK' : 'FAILED'
      runs.push(open)
      open = undefined
    }
  }
  if (open) close(open)
  return runs
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + ' s'
  const m = Math.floor(s / 60)
  return m < 60 ? m + ' min ' + String(s % 60).padStart(2, '0') : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0')
}
