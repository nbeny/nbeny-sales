/**
 * Validation en écriture.
 *
 * C'est le seul endroit qui empêche un agent de faire passer une supposition
 * pour un fait. Un champ de `facts` sans URL source est rejeté — pas signalé,
 * pas corrigé en silence : rejeté, avec le message qui dit quoi faire.
 */
import type { Assumption, Opportunity, OutreachMessage } from './types.ts'
import { STAGES, TERMINAL_STAGES } from './types.ts'

export class ValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super('Enregistrement refusé :\n  - ' + issues.join('\n  - '))
    this.name = 'ValidationError'
    this.issues = issues
  }
}

const FACT_FIELDS = [
  'location', 'remote', 'onsiteDaysPerWeek', 'technologies', 'contract', 'tjm',
  'salary', 'seniorityYears', 'sector', 'durationMonths', 'startDate', 'companySize',
] as const

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/**
 * Valide une opportunité candidate. `id`, `fingerprint`, `stage` et `history`
 * sont posés par la CLI, pas par l'agent : ils ne sont donc pas exigés ici.
 */
export function validateOpportunityInput(input: Record<string, unknown>): string[] {
  const issues: string[] = []

  for (const field of ['title', 'company', 'sourceUrl', 'sourceName']) {
    const value = input[field]
    if (typeof value !== 'string' || !value.trim()) {
      issues.push('`' + field + '` est obligatoire et doit être une chaîne non vide.')
    }
  }
  if (input.sourceUrl !== undefined && !isHttpUrl(input.sourceUrl)) {
    issues.push('`sourceUrl` doit être une URL http(s) publique — c\'est la preuve que l\'offre existe.')
  }

  const facts = (input.facts ?? {}) as Record<string, unknown>
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) {
    issues.push('`facts` doit être un objet.')
    return issues
  }

  for (const [key, raw] of Object.entries(facts)) {
    if (!(FACT_FIELDS as readonly string[]).includes(key)) {
      issues.push('Champ de fait inconnu : `' + key + '`. Champs acceptés : ' + FACT_FIELDS.join(', ') + '.')
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push('`facts.' + key + '` doit être un objet { value, sourceUrl, observedAt }.')
      continue
    }
    const evidence = raw as Record<string, unknown>
    if (evidence.value === undefined || evidence.value === null) {
      issues.push('`facts.' + key + '.value` est manquant.')
    }
    if (!isHttpUrl(evidence.sourceUrl)) {
      issues.push(
        '`facts.' + key + '` n\'a pas d\'URL source valide. Sans source, ce n\'est pas un fait : ' +
        'déplace-le dans `assumptions` avec une justification, ou va chercher la page qui le prouve.',
      )
    }
    if (!isIsoDate(evidence.observedAt)) {
      issues.push('`facts.' + key + '.observedAt` doit être une date ISO (date de lecture de la source).')
    }
  }

  const assumptions = (input.assumptions ?? []) as Assumption[]
  if (!Array.isArray(assumptions)) {
    issues.push('`assumptions` doit être un tableau.')
  } else {
    assumptions.forEach((a, i) => {
      if (!a || typeof a.field !== 'string' || !a.field.trim()) {
        issues.push('`assumptions[' + i + '].field` est obligatoire.')
      }
      if (!a || typeof a.rationale !== 'string' || a.rationale.trim().length < 10) {
        issues.push('`assumptions[' + i + '].rationale` doit expliquer sur quoi repose l\'hypothèse et ce qui manque pour la vérifier.')
      }
      if (a && typeof a.field === 'string' && a.field in facts) {
        issues.push('`' + a.field + '` est déclaré à la fois comme fait et comme hypothèse. Choisis.')
      }
    })
  }

  if (input.stage !== undefined) {
    const valid = [...STAGES, ...TERMINAL_STAGES] as readonly string[]
    if (!valid.includes(input.stage as string)) {
      issues.push('`stage` invalide : ' + String(input.stage) + '. Valeurs : ' + valid.join(', ') + '.')
    }
  }

  return issues
}

export function assertValidOpportunity(input: Record<string, unknown>): void {
  const issues = validateOpportunityInput(input)
  if (issues.length) throw new ValidationError(issues)
}

export function validateOutreachInput(input: Record<string, unknown>): string[] {
  const issues: string[] = []
  for (const field of ['companyName', 'subject', 'body', 'reason', 'sourceUrl']) {
    const value = input[field]
    if (typeof value !== 'string' || !value.trim()) {
      issues.push('`' + field + '` est obligatoire.')
    }
  }
  if (input.sourceUrl !== undefined && !isHttpUrl(input.sourceUrl)) {
    issues.push('`sourceUrl` doit être l\'URL publique qui justifie ce contact.')
  }
  if (typeof input.body === 'string' && input.body.trim().length < 40) {
    issues.push('`body` est trop court pour être un vrai message.')
  }
  if (input.status !== undefined && input.status !== 'DRAFT') {
    issues.push('Un message est toujours créé en `DRAFT`. Seul `outreach:mark-sent`, lancé par un humain, peut le faire passer à `SENT`.')
  }
  const channels = ['email', 'linkedin', 'form', 'other']
  if (input.channel !== undefined && !channels.includes(input.channel as string)) {
    issues.push('`channel` invalide. Valeurs : ' + channels.join(', ') + '.')
  }
  return issues
}

export function assertValidOutreach(input: Record<string, unknown>): void {
  const issues = validateOutreachInput(input)
  if (issues.length) throw new ValidationError(issues)
}

/** Formules interdites : elles rendent un message générique et donc inutile. */
const BANNED_PHRASES = [
  'je suis passionné',
  'passionate about',
  'je me permets de vous contacter',
  'votre entreprise est leader',
  'dans le cadre de ma recherche',
  'n\'hésitez pas à me contacter',
  'je reste à votre entière disposition',
]

export function lintOutreachBody(body: string): string[] {
  const lower = body.toLowerCase()
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase)).map(
    (phrase) => 'Formule générique détectée : « ' + phrase + ' ». Remplace-la par un fait précis sur l\'entreprise.',
  )
}

export function outreachRecordFrom(input: Record<string, unknown>): Partial<OutreachMessage> {
  return { ...input, status: 'DRAFT' } as Partial<OutreachMessage>
}

export type { Opportunity }
