/**
 * Moteur de matching.
 *
 * Trois règles, appliquées ici et nulle part ailleurs :
 *
 * 1. Une dimension dont l'information est absente ou non sourcée vaut `unknown`
 *    et sort du dénominateur. Un score de 95 calculé sur trois dimensions n'est
 *    pas un score, c'est une supposition — la `coverage` le rend visible.
 * 2. Chaque dimension explique son propre résultat en une phrase, reprise telle
 *    quelle dans le rapport.
 * 3. Les points faibles sont retournés au même titre que les points forts.
 *    Aucun chemin de code ne permet de les taire.
 */
import { normalize } from './dedup.ts'
import type {
  DimensionName,
  DimensionResult,
  MatchResult,
  Opportunity,
  Profile,
} from './types.ts'

export interface ScoringConfig {
  weights: Record<DimensionName, number>
  thresholds: {
    high: number
    medium: number
    minCoverageForHigh: number
    minCoverageForMedium: number
  }
  rules: {
    maxOnsiteDaysDefault: number
    technologyWeakBelow: number
    duplicateSimilarityThreshold: number
  }
}

export interface Place {
  key: string
  labels: string[]
  market: string
  priority: number
  travelMinutes: number
  maxOnsiteDays: number
  /** Présentiel accepté par Nicolas : sous `maxOnsiteDays`, il n'est pas un point faible. */
  onsiteAccepted?: boolean
  /** Région ou pays : ne l'emporte jamais sur une ville citée dans le même lieu. */
  broad?: boolean
  note?: string
}

export interface LocationsConfig {
  home: { city: string; postalCode: string; country: string }
  places: Place[]
  remoteLabels: string[]
  hybridLabels: string[]
  onsiteLabels: string[]
}

export interface KeywordsConfig {
  roles: { primary: string[]; secondary: string[] }
  technologies: { core: string[]; strong: string[]; familiar: string[]; absent: string[] }
  sectors: { proven: string[]; wanted: string[]; avoid: string[] }
}

export interface ScoringContext {
  profile: Profile
  scoring: ScoringConfig
  locations: LocationsConfig
  keywords: KeywordsConfig
}

const unknown = (name: DimensionName, weight: number, reason: string): DimensionResult => ({
  name,
  status: 'unknown',
  weight,
  reason,
})

const scored = (
  name: DimensionName,
  weight: number,
  score: number,
  reason: string,
  weak = false,
): DimensionResult => ({ name, status: 'scored', weight, score: Number(score.toFixed(3)), reason, weak })

/** Un intitulé correspond si tous les mots significatifs du rôle y figurent. */
function titleMatches(title: string, role: string): boolean {
  const haystack = normalize(title)
  const needles = normalize(role).split(' ').filter((w) => w.length > 2)
  return needles.length > 0 && needles.every((w) => haystack.includes(w))
}

/**
 * Rapprochement de deux noms de technologie.
 *
 * La comparaison est faite mot à mot, jamais par sous-chaîne : « Java » ne doit
 * pas se reconnaître dans « JavaScript », sans quoi une stack Spring passerait
 * pour une stack maîtrisée.
 */
function techMatches(keyword: string, tech: string): boolean {
  if (keyword === tech) return true
  const a = keyword.split(' ').filter(Boolean)
  const b = tech.split(' ').filter(Boolean)
  if (!a.length || !b.length) return false
  const contains = (haystack: string[], needles: string[]) => needles.every((n) => haystack.includes(n))
  return contains(b, a) || contains(a, b)
}

function has(list: string[], tech: string): boolean {
  return list.some((keyword) => techMatches(normalize(keyword), tech))
}

function matchPlace(locations: LocationsConfig, location: string): Place | undefined {
  const needle = ' ' + normalize(location) + ' '
  const hits: { place: Place; start: number; end: number }[] = []
  for (const place of locations.places) {
    for (const label of place.labels) {
      const word = ' ' + normalize(label) + ' '
      for (let at = needle.indexOf(word); at !== -1; at = needle.indexOf(word, at + 1)) {
        hits.push({ place, start: at, end: at + word.length })
      }
    }
  }
  // Un libellé contenu dans un plus long ne compte pas : « france » dans « Île-de-France ».
  const kept = hits.filter(
    (hit) => !hits.some((other) => other.start <= hit.start && other.end >= hit.end && other.end - other.start > hit.end - hit.start),
  )
  // Le lieu le plus précis gagne : Lille prime sur Hauts-de-France, Paris sur France.
  const precise = kept.filter((hit) => !hit.place.broad)
  const candidates = precise.length > 0 ? precise : kept
  let best: Place | undefined
  for (const { place } of candidates) {
    if (!best || place.travelMinutes < best.travelMinutes) best = place
  }
  return best
}

function dimTech(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.TECH
  const { primary, secondary } = ctx.keywords.roles
  const hitPrimary = primary.find((role) => titleMatches(opp.title, role))
  if (hitPrimary) return scored('TECH', weight, 1, 'Intitulé sur le cœur de cible : ' + hitPrimary + '.')
  const hitSecondary = secondary.find((role) => titleMatches(opp.title, role))
  if (hitSecondary) {
    return scored('TECH', weight, 0.75, 'Intitulé adjacent au profil : ' + hitSecondary + '.')
  }
  const generic = ['developer', 'developpeur', 'engineer', 'ingenieur', 'software']
  const title = normalize(opp.title)
  if (generic.some((g) => title.includes(g))) {
    return scored('TECH', weight, 0.5, 'Intitulé de développement générique, hors cible explicite : ' + opp.title + '.', true)
  }
  return scored('TECH', weight, 0.2, 'Intitulé hors du périmètre habituel : ' + opp.title + '.', true)
}

function dimTechnology(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.TECHNOLOGY
  const evidence = opp.facts.technologies
  if (!evidence || !evidence.value.length) {
    return unknown('TECHNOLOGY', weight, "Stack non précisée dans l'annonce.")
  }
  const { core, strong, familiar, absent } = ctx.keywords.technologies

  let total = 0
  const matched: string[] = []
  const missing: string[] = []
  for (const raw of evidence.value) {
    const tech = normalize(raw)
    // `absent` est testé en premier : une technologie non pratiquée ne doit
    // jamais pouvoir être rattrapée par une correspondance approximative.
    if (has(absent, tech)) { missing.push(raw); continue }
    if (has(core, tech)) { total += 1; matched.push(raw); continue }
    if (has(strong, tech)) { total += 0.85; matched.push(raw); continue }
    if (has(familiar, tech)) { total += 0.5; matched.push(raw); continue }
    total += 0.3
    missing.push(raw)
  }
  const ratio = total / evidence.value.length
  const weak = ratio < ctx.scoring.rules.technologyWeakBelow || missing.length > 0
  const parts: string[] = []
  if (matched.length) parts.push('couvert : ' + matched.join(', '))
  if (missing.length) parts.push('non démontré : ' + missing.join(', '))
  return scored('TECHNOLOGY', weight, ratio, parts.join(' — ') + '.', weak)
}

function dimLocation(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.LOCATION
  const remote = opp.facts.remote?.value
  const location = opp.facts.location?.value

  if (!location) {
    if (remote === 'full') {
      return scored('LOCATION', weight, 1, 'Remote complet : la localisation ne contraint pas.')
    }
    return unknown('LOCATION', weight, "Localisation absente de l'annonce.")
  }

  const place = matchPlace(ctx.locations, location)
  if (!place) {
    if (remote === 'full') {
      return scored('LOCATION', weight, 1, 'Remote complet : la localisation ne contraint pas.')
    }
    return scored('LOCATION', weight, 0.3, 'Localisation « ' + location + ' » hors des zones ciblées.', true)
  }

  const base = Math.max(0.3, 1 - (place.priority - 1) * 0.07)
  const onsite = opp.facts.onsiteDaysPerWeek?.value
  const cap = place.maxOnsiteDays ?? ctx.scoring.rules.maxOnsiteDaysDefault

  if (remote === 'full') {
    return scored('LOCATION', weight, 1, place.key + ' en remote complet : aucun trajet.')
  }
  if (typeof onsite === 'number' && onsite > cap) {
    const hours = Math.round((place.travelMinutes / 60) * 10) / 10
    return scored(
      'LOCATION',
      weight,
      base * 0.35,
      onsite + ' jours sur site à ' + place.key + ' pour un maximum tenable de ' + cap + ' (' + hours + ' h de trajet aller depuis ' + ctx.locations.home.city + ').',
      true,
    )
  }
  const detail = typeof onsite === 'number' ? onsite + ' j/semaine sur site, sous le plafond de ' + cap : 'rythme sur site non précisé'
  return scored('LOCATION', weight, base, place.key + ' — ' + detail + '.', place.priority >= 6)
}

function dimRemote(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.REMOTE
  const remote = opp.facts.remote?.value
  if (!remote || remote === 'unspecified') {
    return unknown('REMOTE', weight, "Politique de télétravail non précisée dans l'annonce.")
  }
  if (remote === 'full') return scored('REMOTE', weight, 1, 'Remote complet.')

  const onsite = opp.facts.onsiteDaysPerWeek?.value
  const place = opp.facts.location ? matchPlace(ctx.locations, opp.facts.location.value) : undefined
  // Présentiel accepté à cet endroit : le plafond de jours est jugé par LOCATION, pas ici.
  const accepted = place?.onsiteAccepted === true && (typeof onsite !== 'number' || onsite <= place.maxOnsiteDays)
  const acceptedReason = 'présentiel accepté à ' + place?.key + ' (' + place?.travelMinutes + ' min de trajet aller)'

  if (remote === 'hybrid') {
    if (typeof onsite !== 'number') {
      if (accepted) return scored('REMOTE', weight, 0.65, 'Hybride, jours sur site non précisés, ' + acceptedReason + '.')
      return scored('REMOTE', weight, 0.65, 'Hybride, nombre de jours sur site non précisé.', true)
    }
    if (onsite <= 2) return scored('REMOTE', weight, 0.9, 'Hybride léger : ' + onsite + ' j/semaine sur site.')
    if (onsite === 3) return scored('REMOTE', weight, 0.7, 'Hybride : 3 j/semaine sur site, à la limite du tenable.')
    if (accepted) return scored('REMOTE', weight, 0.6, 'Hybride : ' + onsite + ' j/semaine sur site, ' + acceptedReason + '.')
    return scored('REMOTE', weight, 0.3, 'Hybride lourd : ' + onsite + ' j/semaine sur site.', true)
  }

  if (accepted) return scored('REMOTE', weight, 0.6, 'Présentiel, ' + acceptedReason + '.')
  if (place && place.travelMinutes <= 45) {
    return scored('REMOTE', weight, 0.6, 'Présentiel, mais à ' + place.travelMinutes + ' min du domicile.', true)
  }
  return scored('REMOTE', weight, 0.15, 'Présentiel complet, incompatible avec la préférence remote.', true)
}

function dimContract(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.CONTRACT
  const contract = opp.facts.contract?.value
  if (!contract || contract === 'unknown') {
    return unknown('CONTRACT', weight, "Type de contrat non précisé dans l'annonce.")
  }
  const accepted = (ctx.profile.preferences.acceptedContracts as string[]) ?? ['freelance', 'cdi']
  if (contract === 'both') return scored('CONTRACT', weight, 1, 'Freelance ou CDI au choix.')
  if (accepted.includes(contract)) {
    return scored('CONTRACT', weight, 1, contract === 'cdi' ? 'CDI, recherché au même titre que le freelance.' : 'Mission freelance, recherchée au même titre que le CDI.')
  }
  return scored('CONTRACT', weight, 0.2, 'Type de contrat non recherché : ' + contract + '.', true)
}

function dimSalary(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.SALARY_OR_TJM
  const tjm = opp.facts.tjm?.value
  const salary = opp.facts.salary?.value
  if (!tjm && !salary) {
    return unknown('SALARY_OR_TJM', weight, "Rémunération non publiée dans l'annonce.")
  }

  const location = opp.facts.location?.value
  const place = location ? matchPlace(ctx.locations, location) : undefined
  const marketKey = place?.market ?? 'fr-other'
  const market = ctx.profile.compensation.markets[marketKey]

  if (!market || market.status === 'unknown' || market.floor === null) {
    return unknown(
      'SALARY_OR_TJM',
      weight,
      "Aucune référence de marché renseignée pour « " + marketKey + " » : le montant affiché n'est comparé à rien. À remplir par POSITIONING_AGENT à partir d'annonces réelles.",
    )
  }

  const offered = tjm ? (tjm.max ?? tjm.min) : (salary?.max ?? salary?.min)
  const unit = tjm ? '€/j' : '€/an'
  if (typeof offered !== 'number') {
    return unknown('SALARY_OR_TJM', weight, 'Rémunération mentionnée sans montant exploitable.')
  }

  const floor = market.floor
  const target = market.target ?? market.floor
  if (offered >= target) {
    return scored('SALARY_OR_TJM', weight, 1, offered + ' ' + unit + ' — au niveau ou au-dessus de la cible (' + target + ').')
  }
  if (offered >= floor) {
    const span = Math.max(1, target - floor)
    return scored('SALARY_OR_TJM', weight, 0.6 + (0.4 * (offered - floor)) / span, offered + ' ' + unit + ' — entre le plancher (' + floor + ') et la cible (' + target + ').')
  }
  return scored('SALARY_OR_TJM', weight, Math.max(0, (0.5 * offered) / floor), offered + ' ' + unit + ' — sous le plancher de ' + floor + ' pour le marché ' + marketKey + '.', true)
}

function dimExperience(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.EXPERIENCE
  const required = opp.facts.seniorityYears?.value
  if (typeof required !== 'number') {
    return unknown('EXPERIENCE', weight, "Niveau d'expérience attendu non précisé.")
  }
  const years = ctx.profile.experienceYears
  if (required <= years) return scored('EXPERIENCE', weight, 1, required + ' ans demandés pour ' + years + ' ans démontrés.')
  if (required <= years + 2) {
    return scored('EXPERIENCE', weight, 0.7, required + ' ans demandés pour ' + years + ' ans démontrés : écart faible.', true)
  }
  return scored('EXPERIENCE', weight, 0.3, required + ' ans demandés pour ' + years + ' ans démontrés : écart réel.', true)
}

function dimSector(opp: Opportunity, ctx: ScoringContext): DimensionResult {
  const weight = ctx.scoring.weights.SECTOR
  const sector = opp.facts.sector?.value
  if (!sector) return unknown('SECTOR', weight, 'Secteur non identifié.')
  const needle = normalize(sector)
  const inList = (list: string[]) => list.some((s) => needle.includes(normalize(s)))
  if (inList(ctx.keywords.sectors.avoid)) return scored('SECTOR', weight, 0, 'Secteur écarté : ' + sector + '.', true)
  if (inList(ctx.keywords.sectors.proven)) return scored('SECTOR', weight, 1, 'Secteur déjà pratiqué : ' + sector + '.')
  if (inList(ctx.keywords.sectors.wanted)) return scored('SECTOR', weight, 0.85, 'Secteur visé : ' + sector + '.')
  return scored('SECTOR', weight, 0.5, 'Secteur neutre : ' + sector + '.')
}

export function computeMatch(opp: Opportunity, ctx: ScoringContext): MatchResult {
  const dimensions = [
    dimTech(opp, ctx),
    dimTechnology(opp, ctx),
    dimLocation(opp, ctx),
    dimRemote(opp, ctx),
    dimContract(opp, ctx),
    dimSalary(opp, ctx),
    dimExperience(opp, ctx),
    dimSector(opp, ctx),
  ]

  const usable = dimensions.filter((d) => d.status === 'scored')
  const weightTotal = usable.reduce((sum, d) => sum + d.weight, 0)
  const weighted = usable.reduce((sum, d) => sum + (d.score ?? 0) * d.weight, 0)
  const score = weightTotal > 0 ? Math.round((weighted / weightTotal) * 100) : 0
  const coverage = usable.length

  const t = ctx.scoring.thresholds
  let priority: MatchResult['priority'] = 'LOW'
  if (score >= t.high && coverage >= t.minCoverageForHigh) priority = 'HIGH'
  else if (score >= t.medium && coverage >= t.minCoverageForMedium) priority = 'MEDIUM'

  const strengths = usable
    .filter((d) => (d.score ?? 0) >= 0.8 && !d.weak)
    .map((d) => d.name + ' — ' + d.reason)

  const weaknesses = [
    ...dimensions.filter((d) => d.status === 'scored' && d.weak).map((d) => d.name + ' — ' + d.reason),
    ...dimensions.filter((d) => d.status === 'unknown').map((d) => d.name + ' — inconnu : ' + d.reason),
  ]

  return { score, coverage, priority, dimensions, strengths, weaknesses, computedAt: new Date().toISOString() }
}
