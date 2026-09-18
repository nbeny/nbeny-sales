/**
 * Filtrage et tri des opportunités.
 *
 * Séparé de la CLI parce que c'est de la logique, pas de l'affichage : un filtre
 * qui se trompe fait disparaître des opportunités sans rien dire, ce qui est la
 * panne la plus silencieuse possible dans cet outil.
 */
import type { Opportunity } from './types.ts'

export interface ListCriteria {
  priority?: string
  stage?: string
  contract?: string
  /** Score minimum sur 100. Une opportunité non scorée ne passe jamais ce filtre. */
  minScore?: number
  /** Couverture minimum sur 8, pour écarter les scores flatteurs mais mal documentés. */
  minCoverage?: number
  remote?: string
  location?: string
  limit?: number
}

export function filterOpportunities(rows: Opportunity[], criteria: ListCriteria): Opportunity[] {
  const { priority, stage, contract, minScore, minCoverage, remote, location, limit } = criteria

  return rows
    .filter((o) => !priority || o.match?.priority === priority.toUpperCase())
    .filter((o) => !stage || o.stage === stage.toUpperCase())
    .filter((o) => !contract || ['both', contract.toLowerCase()].includes(o.facts.contract?.value ?? ''))
    .filter((o) => !remote || o.facts.remote?.value === remote.toLowerCase())
    .filter((o) => !location || (o.facts.location?.value ?? '').toLowerCase().includes(location.toLowerCase()))
    // Sans score calculé, une opportunité ne peut pas prouver qu'elle atteint le
    // seuil : elle est écartée plutôt que supposée au niveau.
    .filter((o) => minScore === undefined || (o.match?.score ?? -1) >= minScore)
    .filter((o) => minCoverage === undefined || (o.match?.coverage ?? -1) >= minCoverage)
    .sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1))
    .slice(0, limit ?? rows.length)
}
