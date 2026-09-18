/**
 * Déduplication.
 *
 * Une même annonce republiée sur deux plateformes doit compter pour une seule
 * opportunité. L'empreinte normalise entreprise + intitulé ; l'URL ne suffit
 * pas, puisque c'est justement elle qui diffère d'une plateforme à l'autre.
 */
import { createHash } from 'node:crypto'

/** Mots qui font varier un intitulé sans en changer le sens. */
const NOISE = new Set([
  'h', 'f', 'hf', 'fh', 'hfx', 'the', 'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du',
  'and', 'et', 'or', 'ou', 'a', 'an', 'to', 'for', 'pour', 'chez', 'in', 'at', 'with', 'avec',
  'cdi', 'cdd', 'freelance', 'mission', 'poste', 'job', 'offre', 'recrute', 'recrutement',
  'senior', 'confirme', 'experimente', 'junior', 'lead',
])

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Les offres sont publiées en français comme en anglais, souvent pour le même
 * poste. Sans cette table, « Senior Full-Stack Developer » et « Développeur
 * Full Stack Senior » comptent pour deux opportunités distinctes.
 */
const SYNONYMS: Record<string, string> = {
  developpeur: 'developer',
  developpeuse: 'developer',
  dev: 'developer',
  ingenieur: 'engineer',
  ingenieure: 'engineer',
  logiciel: 'software',
  applicatif: 'software',
  back: 'backend',
  front: 'frontend',
  fullstack: 'full',
}

/** Découpages qui varient d'une annonce à l'autre sans changer le poste. */
const PHRASES: [RegExp, string][] = [
  [/\bfull stack\b/g, 'fullstack'],
  [/\bback end\b/g, 'backend'],
  [/\bfront end\b/g, 'frontend'],
]

export function significantTokens(text: string): string[] {
  let base = normalize(text)
  for (const [pattern, replacement] of PHRASES) base = base.replace(pattern, replacement)
  const tokens = base
    .split(' ')
    .filter((t) => t.length > 1 && !NOISE.has(t))
    .map((t) => SYNONYMS[t] ?? t)
  // `fullstack` devient `full` via la table : on rétablit le second jeton pour
  // que « Full Stack » et « Fullstack » produisent exactement le même jeu.
  return [...new Set(tokens.flatMap((t) => (t === 'full' ? ['full', 'stack'] : [t])))]
}

/**
 * Empreinte stable d'une opportunité. « Senior Full-Stack Developer (H/F) » et
 * « Développeur Full Stack Senior H/F » chez la même entreprise donnent la même
 * empreinte.
 */
export function fingerprint(company: string, title: string): string {
  const key = normalize(company) + '|' + significantTokens(title).sort().join(' ')
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/** Indice de Jaccard entre deux intitulés, pour les quasi-doublons. */
export function similarity(a: string, b: string): number {
  const ta = new Set(significantTokens(a))
  const tb = new Set(significantTokens(b))
  if (!ta.size || !tb.size) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared += 1
  return shared / (ta.size + tb.size - shared)
}

export interface DuplicateCheck {
  duplicate: boolean
  matchedId?: string
  /** `exact` : même empreinte ou même URL. `similar` : même entreprise, intitulé proche. */
  kind?: 'exact' | 'similar'
  similarity?: number
}

export interface DedupRow {
  id: string
  company: string
  title: string
  sourceUrl: string
  fingerprint: string
}

export function findDuplicate(
  candidate: { company: string; title: string; sourceUrl: string },
  existing: DedupRow[],
  similarityThreshold = 0.7,
): DuplicateCheck {
  const fp = fingerprint(candidate.company, candidate.title)
  const exact = existing.find((row) => row.fingerprint === fp || row.sourceUrl === candidate.sourceUrl)
  if (exact) return { duplicate: true, matchedId: exact.id, kind: 'exact', similarity: 1 }

  const company = normalize(candidate.company)
  for (const row of existing) {
    if (normalize(row.company) !== company) continue
    const sim = similarity(row.title, candidate.title)
    if (sim >= similarityThreshold) {
      return { duplicate: true, matchedId: row.id, kind: 'similar', similarity: Number(sim.toFixed(2)) }
    }
  }
  return { duplicate: false }
}
