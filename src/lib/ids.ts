/**
 * Attribution des identifiants. Toujours faite par le code : un agent qui
 * invente un identifiant crée des doublons silencieux.
 */

const PREFIXES = {
  opportunity: 'OPP',
  company: 'CMP',
  lead: 'LEAD',
  contact: 'CT',
  outreach: 'MSG',
  followup: 'FUP',
  market: 'MKT',
} as const

export type EntityKind = keyof typeof PREFIXES

/**
 * Renvoie l'identifiant suivant pour l'année en cours, sous la forme
 * `OPP-2026-0001`. La numérotation repart à 1 à chaque nouvelle année.
 */
export function nextId(kind: EntityKind, existingIds: string[], year = new Date().getFullYear()): string {
  const head = PREFIXES[kind] + '-' + year + '-'
  const used = existingIds
    .filter((id) => id.startsWith(head))
    .map((id) => Number.parseInt(id.slice(head.length), 10))
    .filter((n) => Number.isFinite(n))
  const next = used.length ? Math.max(...used) + 1 : 1
  return head + String(next).padStart(4, '0')
}
