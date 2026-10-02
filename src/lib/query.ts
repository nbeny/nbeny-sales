/**
 * Filtrage et tri des opportunités.
 *
 * Séparé de la CLI parce que c'est de la logique, pas de l'affichage : un filtre
 * qui se trompe fait disparaître des opportunités sans rien dire, ce qui est la
 * panne la plus silencieuse possible dans cet outil.
 */
import type { Opportunity, RemotePolicy } from './types.ts'

export const SORT_KEYS = ['score', 'remote', 'date', 'company', 'location'] as const
export type SortKey = (typeof SORT_KEYS)[number]

export interface ListCriteria {
  priority?: string
  stage?: string
  contract?: string
  /** Score minimum sur 100. Une opportunité non scorée ne passe jamais ce filtre. */
  minScore?: number
  /** Couverture minimum sur 8, pour écarter les scores flatteurs mais mal documentés. */
  minCoverage?: number
  /** Une ou plusieurs politiques séparées par des virgules : `full`, `hybrid,onsite`, `unspecified`. */
  remote?: string
  location?: string
  /** Texte libre cherché dans l'entreprise, l'intitulé, le lieu et la stack. */
  search?: string
  /** `score` par défaut. */
  sort?: string
  limit?: number
}

/** Politique de télétravail ; une annonce muette compte comme `unspecified`, jamais comme remote. */
export function remotePolicy(o: Opportunity): RemotePolicy {
  return o.facts.remote?.value ?? 'unspecified'
}

/**
 * Rang pour le tri « remote d'abord » : full, puis hybride du plus léger au plus
 * lourd, puis présentiel, puis non précisé. Un hybride sans nombre de jours se
 * range après les hybrides chiffrés : on ne lui prête pas un rythme léger.
 */
export function remoteRank(o: Opportunity): number {
  const policy = remotePolicy(o)
  if (policy === 'full') return 0
  if (policy === 'hybrid') {
    const days = o.facts.onsiteDaysPerWeek?.value
    return typeof days === 'number' ? 1 + days / 10 : 1.9
  }
  if (policy === 'onsite') return 3
  return 4
}

const byScore = (a: Opportunity, b: Opportunity) => (b.match?.score ?? -1) - (a.match?.score ?? -1)

const COMPARATORS: Record<SortKey, (a: Opportunity, b: Opportunity) => number> = {
  score: byScore,
  remote: (a, b) => remoteRank(a) - remoteRank(b) || byScore(a, b),
  date: (a, b) => b.discoveredAt.localeCompare(a.discoveredAt) || byScore(a, b),
  company: (a, b) => a.company.localeCompare(b.company, 'fr') || byScore(a, b),
  location: (a, b) => (a.facts.location?.value ?? '￿').localeCompare(b.facts.location?.value ?? '￿', 'fr') || byScore(a, b),
}

export function filterOpportunities(rows: Opportunity[], criteria: ListCriteria): Opportunity[] {
  const { priority, stage, contract, minScore, minCoverage, remote, location, search, limit } = criteria
  const sort = (criteria.sort ?? 'score').toLowerCase()
  if (!(SORT_KEYS as readonly string[]).includes(sort)) {
    throw new Error('Tri inconnu : ' + criteria.sort + '. Valeurs possibles : ' + SORT_KEYS.join(', ') + '.')
  }
  const policies = remote ? remote.toLowerCase().split(',').map((p) => p.trim()).filter(Boolean) : []
  const needle = search?.trim().toLowerCase()

  return rows
    .filter((o) => !priority || o.match?.priority === priority.toUpperCase())
    .filter((o) => !stage || o.stage === stage.toUpperCase())
    .filter((o) => !contract || ['both', contract.toLowerCase()].includes(o.facts.contract?.value ?? ''))
    .filter((o) => !policies.length || policies.includes(remotePolicy(o)))
    .filter((o) => !location || (o.facts.location?.value ?? '').toLowerCase().includes(location.toLowerCase()))
    .filter((o) => !needle || [o.company, o.title, o.facts.location?.value ?? '', ...(o.facts.technologies?.value ?? [])].join(' ').toLowerCase().includes(needle))
    // Sans score calculé, une opportunité ne peut pas prouver qu'elle atteint le
    // seuil : elle est écartée plutôt que supposée au niveau.
    .filter((o) => minScore === undefined || (o.match?.score ?? -1) >= minScore)
    .filter((o) => minCoverage === undefined || (o.match?.coverage ?? -1) >= minCoverage)
    .sort(COMPARATORS[sort as SortKey])
    .slice(0, limit ?? rows.length)
}
