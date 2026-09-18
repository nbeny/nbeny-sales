/**
 * Pipeline commercial. Les transitions sont vérifiées par le code : un agent ne
 * peut pas faire passer une opportunité de DISCOVERED à INTERVIEW par
 * distraction, ni ressusciter une opportunité déjà perdue.
 */
import { STAGES, TERMINAL_STAGES, type StageName, type HistoryEntry } from './types.ts'

const ORDER: readonly StageName[] = STAGES
const DEAD_ENDS: readonly StageName[] = ['WON', 'LOST']

export function stageIndex(stage: StageName): number {
  return ORDER.indexOf(stage as (typeof STAGES)[number])
}

export function canTransition(from: StageName, to: StageName): boolean {
  if (from === to) return false
  if (DEAD_ENDS.includes(from)) return false
  // LOST et NO_RESPONSE sont atteignables depuis n'importe quel état actif.
  if ((TERMINAL_STAGES as readonly string[]).includes(to)) return true
  // Une opportunité sans réponse peut être relancée et repartir dans le flux.
  if (from === 'NO_RESPONSE') return stageIndex(to) >= stageIndex('CONTACTED')
  const fromIdx = stageIndex(from)
  const toIdx = stageIndex(to)
  if (fromIdx < 0 || toIdx < 0) return false
  return toIdx > fromIdx
}

export class TransitionError extends Error {
  constructor(from: StageName, to: StageName) {
    super('Transition interdite : ' + from + ' -> ' + to)
    this.name = 'TransitionError'
  }
}

export function transition<T extends { stage: StageName; history: HistoryEntry[] }>(
  row: T,
  to: StageName,
  note?: string,
): T {
  if (!canTransition(row.stage, to)) throw new TransitionError(row.stage, to)
  row.history.push({ at: new Date().toISOString(), from: row.stage, to, note })
  row.stage = to
  return row
}
