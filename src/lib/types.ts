/**
 * Types du domaine.
 *
 * Règle centrale : tout champ qui participe au score est une `Evidence`, donc
 * porte l'URL publique où il a été lu. Ce qui n'a pas de source n'est pas un
 * fait — c'est une `Assumption`, et une hypothèse ne score jamais.
 */

export interface Evidence<T> {
  value: T
  /** URL publique où l'information a été lue. Obligatoire. */
  sourceUrl: string
  /** Date ISO de lecture. */
  observedAt: string
}

export interface Assumption {
  field: string
  value: unknown
  /** Pourquoi l'agent suppose cela, et ce qui manque pour en faire un fait. */
  rationale: string
}

export type RemotePolicy = 'full' | 'hybrid' | 'onsite' | 'unspecified'
export type ContractKind = 'freelance' | 'cdi' | 'both' | 'unknown'

export interface Money {
  min?: number
  max?: number
  currency: string
}

export interface Stage {
  name: StageName
  at: string
}

export const STAGES = [
  'DISCOVERED',
  'FILTERED',
  'QUALIFIED',
  'MATCHED',
  'PRIORITIZED',
  'OUTREACH_READY',
  'CONTACTED',
  'REPLIED',
  'INTERVIEW',
  'NEGOTIATION',
  'WON',
] as const

/** États terminaux atteignables depuis n'importe quel état actif. */
export const TERMINAL_STAGES = ['LOST', 'NO_RESPONSE'] as const

export type StageName = (typeof STAGES)[number] | (typeof TERMINAL_STAGES)[number]

export interface OpportunityFacts {
  location?: Evidence<string>
  remote?: Evidence<RemotePolicy>
  onsiteDaysPerWeek?: Evidence<number>
  technologies?: Evidence<string[]>
  contract?: Evidence<ContractKind>
  tjm?: Evidence<Money>
  salary?: Evidence<Money & { period: 'year' | 'month' }>
  seniorityYears?: Evidence<number>
  sector?: Evidence<string>
  durationMonths?: Evidence<number>
  startDate?: Evidence<string>
  companySize?: Evidence<string>
}

export interface Opportunity {
  id: string
  title: string
  company: string
  sourceUrl: string
  /** Nom lisible de la source : "Welcome to the Jungle", "site carrière", … */
  sourceName: string
  discoveredAt: string
  stage: StageName
  facts: OpportunityFacts
  assumptions: Assumption[]
  match?: MatchResult
  /** Empreinte de déduplication, calculée par le code, jamais par un agent. */
  fingerprint: string
  history: HistoryEntry[]
  notes?: string
}

export interface HistoryEntry {
  at: string
  from: StageName | null
  to: StageName
  note?: string
}

export type DimensionName =
  | 'TECH'
  | 'LOCATION'
  | 'REMOTE'
  | 'CONTRACT'
  | 'SALARY_OR_TJM'
  | 'TECHNOLOGY'
  | 'EXPERIENCE'
  | 'SECTOR'

export interface DimensionResult {
  name: DimensionName
  /** `unknown` = information absente ou non sourcée : exclue du dénominateur. */
  status: 'scored' | 'unknown'
  /** 0 à 1. Absent si `unknown`. */
  score?: number
  weight: number
  /** Explication en une phrase, affichée telle quelle dans le rapport. */
  reason: string
  /** Vrai si cette dimension doit apparaître dans les points faibles. */
  weak?: boolean
}

export interface MatchResult {
  /** 0 à 100, calculé sur les seules dimensions scorées. */
  score: number
  /** Nombre de dimensions scorées sur 8. */
  coverage: number
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  dimensions: DimensionResult[]
  strengths: string[]
  weaknesses: string[]
  computedAt: string
}

export interface CompensationMarket {
  /** En dessous, c'est non. Vient d'une décision de Nicolas, pas du marché. */
  floor: number | null
  /** Ce que le marché paie réellement à ce niveau. Vient d'annonces observées. */
  target: number | null
  currency: string
  unit: 'day' | 'year'
  status: 'known' | 'unknown'
  /**
   * D'où vient le plancher. Un plancher est un arbitrage personnel : il n'a pas
   * d'URL, et le confondre avec une observation de marché produirait un scoring
   * qui prétend mesurer le marché alors qu'il mesure une préférence.
   */
  floorOrigin?: string
  /** URLs des annonces d'où viennent les montants observés (`target`). */
  sources: string[]
}

export interface Profile {
  identity: Record<string, unknown>
  sources: string[]
  roles: string[]
  technologies: { core: string[]; strong: string[]; familiar: string[]; absent: string[] }
  sectors: string[]
  experienceYears: number
  locations: unknown
  compensation: { markets: Record<string, CompensationMarket>; note: string }
  preferences: Record<string, unknown>
  unknowns: string[]
}

export type OutreachStatus = 'DRAFT' | 'APPROVED' | 'SENT'

export interface OutreachMessage {
  id: string
  opportunityId?: string
  companyName: string
  channel: 'email' | 'linkedin' | 'form' | 'other'
  audience: 'recruiter' | 'cto' | 'hr' | 'founder' | 'esn' | 'client'
  subject: string
  body: string
  /** Pourquoi cette cible, avec la preuve qui le justifie. */
  reason: string
  sourceUrl: string
  status: OutreachStatus
  createdAt: string
  sentAt?: string
  language: 'fr' | 'en'
}

export type FollowupStatus =
  | 'NEW'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERVIEW'
  | 'NEGOTIATION'
  | 'WON'
  | 'LOST'
  | 'NO_RESPONSE'

export interface Followup {
  id: string
  opportunityId?: string
  outreachId?: string
  company: string
  contactLabel: string
  status: FollowupStatus
  lastTouchAt: string
  nextActionAt?: string
  recommendation?: string
  history: { at: string; status: FollowupStatus; note?: string }[]
}
