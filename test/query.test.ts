import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { filterOpportunities } from '../src/lib/query.ts'
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
