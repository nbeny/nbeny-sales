import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { filterOpportunities, remoteRank } from '../src/lib/query.ts'
import { formatCompact, remoteCell } from '../src/lib/format.ts'
import type { Opportunity } from '../src/lib/types.ts'

const SRC = 'https://exemple.fr/jobs/1'

function opp(id: string, score: number | null, coverage = 8, extra: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    title: 'Développeur Full Stack',
    company: 'Exemple ' + id,
    sourceUrl: SRC + id,
    sourceName: 'test',
    discoveredAt: '2026-09-18T09:00:00Z',
    stage: 'MATCHED',
    facts: {},
    assumptions: [],
    fingerprint: id,
    history: [],
    match: score === null ? undefined : {
      score, coverage, priority: score >= 78 ? 'HIGH' : score >= 58 ? 'MEDIUM' : 'LOW',
      dimensions: [], strengths: [], weaknesses: [], computedAt: '2026-09-18T09:00:00Z',
    },
    ...extra,
  }
}

const evidence = <T>(value: T) => ({ value, sourceUrl: SRC, observedAt: '2026-09-18T09:00:00Z' })

describe('filtrage du listing', () => {
  const rows = [
    opp('A', 95, 4),
    opp('B', 82, 8),
    opp('C', 60, 6),
    opp('D', null),
  ]

  test('sans critère, tout sort, trié par score décroissant', () => {
    const out = filterOpportunities(rows, {})
    assert.deepEqual(out.map((o) => o.id), ['A', 'B', 'C', 'D'])
  })

  test('--min-score ne garde que ce qui atteint le seuil', () => {
    assert.deepEqual(filterOpportunities(rows, { minScore: 80 }).map((o) => o.id), ['A', 'B'])
  })

  test('une opportunité non scorée ne passe jamais un seuil de score', () => {
    // Elle ne peut pas prouver qu'elle atteint le seuil : l'écarter est plus sûr
    // que la supposer au niveau.
    assert.equal(filterOpportunities(rows, { minScore: 0 }).some((o) => o.id === 'D'), false)
  })

  test('--min-coverage écarte les scores flatteurs mais mal documentés', () => {
    // A vaut 95 sur 4 dimensions seulement : au-dessus du seuil de score, mais
    // sous celui de couverture.
    const out = filterOpportunities(rows, { minScore: 80, minCoverage: 6 })
    assert.deepEqual(out.map((o) => o.id), ['B'])
  })

  test('les deux seuils se combinent sans s\'annuler', () => {
    assert.deepEqual(filterOpportunities(rows, { minCoverage: 6 }).map((o) => o.id), ['B', 'C'])
  })

  test('le filtre de contrat accepte les offres ouvertes aux deux', () => {
    const list = [
      opp('F', 90, 8, { facts: { contract: evidence('freelance' as const) } }),
      opp('C1', 88, 8, { facts: { contract: evidence('cdi' as const) } }),
      opp('B1', 86, 8, { facts: { contract: evidence('both' as const) } }),
    ]
    assert.deepEqual(filterOpportunities(list, { contract: 'freelance' }).map((o) => o.id), ['F', 'B1'])
    assert.deepEqual(filterOpportunities(list, { contract: 'CDI' }).map((o) => o.id), ['C1', 'B1'])
  })

  test('le filtre de lieu est insensible à la casse et partiel', () => {
    const list = [
      opp('L', 90, 8, { facts: { location: evidence('Lille (bureaux à Villeneuve-d\'Ascq)') } }),
      opp('P', 92, 8, { facts: { location: evidence('Paris') } }),
    ]
    assert.deepEqual(filterOpportunities(list, { location: 'LILLE' }).map((o) => o.id), ['L'])
  })

  test('le filtre remote distingue les trois politiques', () => {
    const list = [
      opp('R', 90, 8, { facts: { remote: evidence('full' as const) } }),
      opp('H', 92, 8, { facts: { remote: evidence('hybrid' as const) } }),
    ]
    assert.deepEqual(filterOpportunities(list, { remote: 'full' }).map((o) => o.id), ['R'])
  })

  test('--limit tronque après le tri, pas avant', () => {
    const out = filterOpportunities(rows, { limit: 2 })
    assert.deepEqual(out.map((o) => o.id), ['A', 'B'])
  })
})

describe('télétravail : filtre multiple et tri', () => {
  const list = [
    opp('ONSITE', 99, 8, { facts: { remote: evidence('onsite' as const) } }),
    opp('H3', 95, 8, { facts: { remote: evidence('hybrid' as const), onsiteDaysPerWeek: evidence(3) } }),
    opp('H1', 70, 8, { facts: { remote: evidence('hybrid' as const), onsiteDaysPerWeek: evidence(1) } }),
    opp('H?', 90, 8, { facts: { remote: evidence('hybrid' as const) } }),
    opp('FULL-LOW', 60, 8, { facts: { remote: evidence('full' as const) } }),
    opp('FULL-HIGH', 85, 8, { facts: { remote: evidence('full' as const) } }),
    opp('MUET', 98, 8),
  ]

  test("--sort remote : full d'abord, puis hybride du plus léger au plus lourd, présentiel, non précisé", () => {
    assert.deepEqual(filterOpportunities(list, { sort: 'remote' }).map((o) => o.id), ['FULL-HIGH', 'FULL-LOW', 'H1', 'H3', 'H?', 'ONSITE', 'MUET'])
  })

  test('un hybride sans nombre de jours ne passe pas devant un hybride chiffré', () => {
    assert.ok(remoteRank(list[3]) > remoteRank(list[1]))
  })

  test("une annonce muette n'est jamais comptée comme full remote", () => {
    assert.deepEqual(filterOpportunities(list, { remote: 'full' }).map((o) => o.id), ['FULL-HIGH', 'FULL-LOW'])
    assert.deepEqual(filterOpportunities(list, { remote: 'unspecified' }).map((o) => o.id), ['MUET'])
  })

  test("--remote hybrid,onsite garde tout ce qui n'est pas full remote et précisé", () => {
    assert.deepEqual(filterOpportunities(list, { remote: 'hybrid,onsite' }).map((o) => o.id).sort(), ['H1', 'H3', 'H?', 'ONSITE'])
  })

  test('un tri inconnu est refusé au lieu de retomber en silence sur le score', () => {
    assert.throws(() => filterOpportunities(list, { sort: 'salaire' }), /Tri inconnu/)
  })

  test("--search cherche dans l'entreprise, l'intitulé, le lieu et la stack", () => {
    const rows = [
      opp('S1', 80, 8, { facts: { technologies: evidence(['TypeScript', 'NestJS']) } }),
      opp('S2', 80, 8, { facts: { location: evidence('Arras') } }),
    ]
    assert.deepEqual(filterOpportunities(rows, { search: 'nestjs' }).map((o) => o.id), ['S1'])
    assert.deepEqual(filterOpportunities(rows, { search: 'ARRAS' }).map((o) => o.id), ['S2'])
  })

  test('la ligne compacte montre le mode de travail et le lieu', () => {
    assert.match(remoteCell(list[4]), /Full remote/)
    assert.match(remoteCell(list[1]), /Hybride 3j/)
    assert.match(remoteCell(list[3]), /Hybride \?j/)
    assert.match(remoteCell(list[6]), /Non précisé/)
    const line = formatCompact(opp('L', 80, 8, { facts: { remote: evidence('onsite' as const), location: evidence('Saint-Omer') } }))
    assert.match(line, /Présentiel/)
    assert.match(line, /Saint-Omer/)
  })
})
