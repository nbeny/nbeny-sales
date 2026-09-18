import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { computeMatch, type ScoringContext } from '../src/lib/scoring.ts'
import { readConfig, readJson } from '../src/lib/store.ts'
import { fingerprint } from '../src/lib/dedup.ts'
import { join } from 'node:path'
import { DATA_DIR } from '../src/lib/store.ts'
import type { Evidence, Opportunity, Profile } from '../src/lib/types.ts'

const SRC = 'https://exemple.fr/jobs/1'
const evidence = <T>(value: T): Evidence<T> => ({ value, sourceUrl: SRC, observedAt: '2026-09-18T09:00:00Z' })

/**
 * Le contexte de test repart toujours de marchés à `unknown`, quel que soit
 * l'état réel de `data/profile.json` : un test qui dépend de la base vivante
 * casse dès que Nicolas renseigne un plancher, et ne teste plus rien.
 */
function context(overrides: Partial<Profile> = {}): ScoringContext {
  const stored = readJson<Profile>(join(DATA_DIR, 'profile.json'), {} as Profile)
  const markets = Object.fromEntries(
    Object.entries(stored.compensation.markets).map(([key, market]) => [
      key,
      { ...market, floor: null, target: null, status: 'unknown' as const, sources: [] },
    ]),
  )
  const profile = { ...stored, compensation: { ...stored.compensation, markets } }
  return {
    profile: { ...profile, ...overrides },
    scoring: readConfig('scoring'),
    locations: readConfig('locations'),
    keywords: readConfig('keywords'),
  }
}

function opportunity(title: string, facts: Opportunity['facts']): Opportunity {
  return {
    id: 'OPP-2026-0001',
    title,
    company: 'Exemple SAS',
    sourceUrl: SRC,
    sourceName: 'site carrière',
    discoveredAt: '2026-09-18T09:00:00Z',
    stage: 'DISCOVERED',
    facts,
    assumptions: [],
    fingerprint: fingerprint('Exemple SAS', title),
    history: [],
  }
}

const dim = (m: ReturnType<typeof computeMatch>, name: string) => m.dimensions.find((d) => d.name === name)!

describe('couverture — une inconnue n\'est jamais comptée comme un point', () => {
  test('une annonce vide ne score que sur l\'intitulé', () => {
    const match = computeMatch(opportunity('Développeur Full Stack', {}), context())
    assert.equal(match.coverage, 1)
    assert.equal(match.priority, 'LOW', 'une seule dimension connue ne peut pas donner une priorité haute')
  })

  test('les dimensions inconnues sortent du dénominateur au lieu de valoir zéro', () => {
    const match = computeMatch(opportunity('Développeur Full Stack', {}), context())
    assert.equal(dim(match, 'REMOTE').status, 'unknown')
    assert.equal(dim(match, 'REMOTE').score, undefined)
    // L'intitulé est parfait : le score reste à 100 même si sept dimensions manquent…
    assert.equal(match.score, 100)
    // …mais la couverture le dit, et la priorité en tient compte.
    assert.equal(match.coverage, 1)
  })

  test('chaque dimension inconnue apparaît dans les points faibles', () => {
    const match = computeMatch(opportunity('Développeur Full Stack', {}), context())
    assert.equal(match.weaknesses.filter((w) => w.includes('inconnu')).length, 7)
  })

  test('une opportunité bien documentée peut atteindre HIGH', () => {
    const match = computeMatch(
      opportunity('Développeur Full Stack', {
        location: evidence('Lille'),
        remote: evidence('hybrid' as const),
        onsiteDaysPerWeek: evidence(2),
        technologies: evidence(['TypeScript', 'NestJS', 'React', 'PostgreSQL']),
        contract: evidence('freelance' as const),
        seniorityYears: evidence(5),
        sector: evidence('SaaS'),
      }),
      context(),
    )
    assert.equal(match.coverage, 7)
    assert.equal(match.priority, 'HIGH')
    assert.ok(match.score >= 78)
  })
})

describe('rémunération — pas de référence, pas de score', () => {
  const withTjm = opportunity('Développeur Full Stack', {
    location: evidence('Lille'),
    tjm: evidence({ min: 400, max: 450, currency: 'EUR' }),
  })

  test('un TJM affiché ne score pas tant que le marché n\'a pas de référence', () => {
    const match = computeMatch(withTjm, context())
    const salary = dim(match, 'SALARY_OR_TJM')
    assert.equal(salary.status, 'unknown')
    assert.ok(salary.reason.includes('fr-hdf'), 'le marché concerné doit être nommé')
    assert.ok(salary.reason.includes('POSITIONING_AGENT'), 'la raison doit dire qui remplit cette case')
  })

  test('une fois la référence posée, le montant est comparé', () => {
    const ctx = context()
    ctx.profile.compensation.markets['fr-hdf'] = {
      floor: 400, target: 500, currency: 'EUR', unit: 'day', status: 'known', sources: ['https://exemple.fr/annonce'],
    }
    const match = computeMatch(withTjm, ctx)
    const salary = dim(match, 'SALARY_OR_TJM')
    assert.equal(salary.status, 'scored')
    assert.ok(salary.score! > 0.6 && salary.score! < 1, 'entre plancher et cible')
  })

  test('un montant sous le plancher est un point faible explicite', () => {
    const ctx = context()
    ctx.profile.compensation.markets['fr-hdf'] = {
      floor: 500, target: 600, currency: 'EUR', unit: 'day', status: 'known', sources: ['https://exemple.fr/annonce'],
    }
    const match = computeMatch(withTjm, ctx)
    const salary = dim(match, 'SALARY_OR_TJM')
    assert.equal(salary.weak, true)
    assert.ok(match.weaknesses.some((w) => w.includes('sous le plancher')))
  })
})

describe('localisation et présentiel depuis Wimereux', () => {
  test('Lille à 4 jours sur site est dégradé et justifié par le trajet', () => {
    const match = computeMatch(
      opportunity('Développeur Full Stack', {
        location: evidence('Lille'),
        remote: evidence('hybrid' as const),
        onsiteDaysPerWeek: evidence(4),
      }),
      context(),
    )
    const location = dim(match, 'LOCATION')
    assert.equal(location.weak, true)
    assert.ok(location.reason.includes('Wimereux'))
    assert.ok(location.reason.includes('1.8 h') || location.reason.includes('h de trajet'))
  })

  test('Lille à 2 jours sur site reste confortable', () => {
    const match = computeMatch(
      opportunity('Développeur Full Stack', {
        location: evidence('Lille'),
        remote: evidence('hybrid' as const),
        onsiteDaysPerWeek: evidence(2),
      }),
      context(),
    )
    assert.equal(dim(match, 'LOCATION').weak, false)
    assert.ok(dim(match, 'REMOTE').score! >= 0.9)
  })

  test('Paris en remote complet ne coûte rien', () => {
    const match = computeMatch(
      opportunity('Développeur Full Stack', { location: evidence('Paris'), remote: evidence('full' as const) }),
      context(),
    )
    assert.equal(dim(match, 'LOCATION').score, 1)
    assert.equal(dim(match, 'REMOTE').score, 1)
  })

  test('Paris à 5 jours sur site est dégradé, pas écarté en silence', () => {
    const match = computeMatch(
      opportunity('Développeur Full Stack', {
        location: evidence('Paris'),
        remote: evidence('onsite' as const),
        onsiteDaysPerWeek: evidence(5),
      }),
      context(),
    )
    assert.equal(dim(match, 'LOCATION').weak, true)
    assert.ok(match.score > 0, 'elle reste dans la base avec un score bas et une raison lisible')
    assert.ok(match.weaknesses.some((w) => w.includes('5 jours sur site')))
  })

  test('une ville hors zone est signalée comme telle', () => {
    const match = computeMatch(
      opportunity('Développeur Full Stack', { location: evidence('Bucarest'), remote: evidence('onsite' as const) }),
      context(),
    )
    assert.ok(dim(match, 'LOCATION').reason.includes('hors des zones ciblées'))
  })
})

describe('stack — les technologies non démontrées ne sont pas maquillées', () => {
  test('une stack maîtrisée score haut', () => {
    const match = computeMatch(
      opportunity('Développeur Backend', { technologies: evidence(['TypeScript', 'NestJS', 'PostgreSQL', 'Docker']) }),
      context(),
    )
    assert.equal(dim(match, 'TECHNOLOGY').score, 1)
  })

  test('une techno absente du parcours est nommée dans les points faibles', () => {
    const match = computeMatch(
      opportunity('Développeur Backend', { technologies: evidence(['Java', 'Spring Boot', 'PostgreSQL']) }),
      context(),
    )
    const tech = dim(match, 'TECHNOLOGY')
    assert.equal(tech.weak, true)
    assert.ok(tech.reason.includes('non démontré'))
    assert.ok(tech.reason.includes('Java'))
    assert.ok(tech.score! < 0.5)
  })

  test('Kubernetes compte comme familier, pas comme maîtrisé', () => {
    const only = computeMatch(opportunity('Platform Engineer', { technologies: evidence(['Kubernetes']) }), context())
    assert.equal(dim(only, 'TECHNOLOGY').score, 0.5)
  })
})

describe('intitulé et contrat', () => {
  test('un intitulé hors cible est marqué faible sans être écarté', () => {
    const match = computeMatch(opportunity('Chef de projet MOA', {}), context())
    assert.equal(dim(match, 'TECH').weak, true)
    assert.ok(dim(match, 'TECH').score! <= 0.2)
  })

  test('Founding Engineer est reconnu comme adjacent, pas rejeté', () => {
    const match = computeMatch(opportunity('Founding Engineer', {}), context())
    assert.equal(dim(match, 'TECH').score, 0.75)
  })

  test('freelance et CDI valent exactement pareil', () => {
    const f = computeMatch(opportunity('Développeur Full Stack', { contract: evidence('freelance' as const) }), context())
    const c = computeMatch(opportunity('Développeur Full Stack', { contract: evidence('cdi' as const) }), context())
    assert.equal(dim(f, 'CONTRACT').score, dim(c, 'CONTRACT').score)
  })

  test('un stage ou une alternance n\'est pas dans le périmètre', () => {
    const match = computeMatch(opportunity('Développeur Full Stack', { contract: evidence('stage' as never) }), context())
    assert.equal(dim(match, 'CONTRACT').weak, true)
  })
})

describe('expérience', () => {
  test('un niveau supérieur au parcours est signalé, pas masqué', () => {
    const match = computeMatch(opportunity('Développeur Full Stack', { seniorityYears: evidence(10) }), context())
    const exp = dim(match, 'EXPERIENCE')
    assert.equal(exp.weak, true)
    assert.ok(exp.reason.includes('10 ans demandés'))
    assert.ok(exp.reason.includes('5 ans démontrés'))
  })
})
