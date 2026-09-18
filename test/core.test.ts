import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { nextId } from '../src/lib/ids.ts'
import { fingerprint, findDuplicate, similarity, normalize } from '../src/lib/dedup.ts'
import { canTransition, transition, TransitionError } from '../src/lib/pipeline.ts'
import { validateOpportunityInput, validateOutreachInput, lintOutreachBody } from '../src/lib/validate.ts'
import type { HistoryEntry, StageName } from '../src/lib/types.ts'

describe('identifiants', () => {
  test('numérote à partir de 1 et reste sur quatre chiffres', () => {
    assert.equal(nextId('opportunity', [], 2026), 'OPP-2026-0001')
  })

  test('reprend après le plus grand existant, même si la liste a des trous', () => {
    const ids = ['OPP-2026-0001', 'OPP-2026-0007', 'OPP-2026-0003']
    assert.equal(nextId('opportunity', ids, 2026), 'OPP-2026-0008')
  })

  test('repart à 1 sur une nouvelle année sans collisionner avec la précédente', () => {
    assert.equal(nextId('opportunity', ['OPP-2026-0042'], 2027), 'OPP-2027-0001')
  })

  test('les familles d\'entités ne se marchent pas dessus', () => {
    const ids = ['OPP-2026-0005', 'LEAD-2026-0009']
    assert.equal(nextId('lead', ids, 2026), 'LEAD-2026-0010')
    assert.equal(nextId('opportunity', ids, 2026), 'OPP-2026-0006')
  })
})

describe('déduplication', () => {
  test('la même offre écrite différemment donne la même empreinte', () => {
    const a = fingerprint('Decathlon', 'Senior Full-Stack Developer (H/F)')
    const b = fingerprint('DECATHLON', 'Développeur Full Stack Senior H/F')
    assert.equal(a, b)
  })

  test('deux postes différents chez la même entreprise restent distincts', () => {
    const a = fingerprint('OVHcloud', 'Backend Developer Go')
    const b = fingerprint('OVHcloud', 'Frontend Developer React')
    assert.notEqual(a, b)
  })

  test('repère un doublon publié sur une autre plateforme', () => {
    const existing = [{
      id: 'OPP-2026-0001',
      company: 'Adeo',
      title: 'Développeur Full Stack TypeScript H/F',
      sourceUrl: 'https://www.welcometothejungle.com/fr/companies/adeo/jobs/x',
      fingerprint: fingerprint('Adeo', 'Développeur Full Stack TypeScript H/F'),
    }]
    const found = findDuplicate(
      { company: 'ADEO', title: 'Developpeur Full Stack TypeScript (H/F)', sourceUrl: 'https://fr.indeed.com/viewjob?jk=y' },
      existing,
    )
    assert.equal(found.duplicate, true)
    assert.equal(found.matchedId, 'OPP-2026-0001')
  })

  test('la même URL suffit à déclarer un doublon', () => {
    const url = 'https://example.com/jobs/1'
    const existing = [{ id: 'OPP-2026-0001', company: 'A', title: 'X', sourceUrl: url, fingerprint: 'zzz' }]
    assert.equal(findDuplicate({ company: 'B', title: 'Y', sourceUrl: url }, existing).duplicate, true)
  })

  test('deux missions distinctes chez la même entreprise ne fusionnent pas', () => {
    // Cas réel observé le 18/09/2026 : Naxo publie deux annonces le même mois,
    // identiques au mot près sauf la techno qui les distingue. Un seul jeton
    // d'écart ne doit pas les faire compter pour une.
    const existing = [{
      id: 'OPP-2026-0002',
      company: 'Naxo',
      title: 'Développeur Senior Fullstack Typescript React Nestjs',
      sourceUrl: 'https://www.hellowork.com/fr-fr/emplois/82680838.html',
      fingerprint: fingerprint('Naxo', 'Développeur Senior Fullstack Typescript React Nestjs'),
    }]
    const found = findDuplicate(
      { company: 'Naxo', title: 'Développeur Full Stack TypeScript React PostgreSQL', sourceUrl: 'https://www.hellowork.com/fr-fr/emplois/82755047.html' },
      existing,
      0.8,
    )
    assert.equal(found.duplicate, false)
  })

  test('une entreprise différente n\'est jamais un doublon', () => {
    const existing = [{
      id: 'OPP-2026-0001',
      company: 'Alpha',
      title: 'Node.js Developer',
      sourceUrl: 'https://a.example/1',
      fingerprint: fingerprint('Alpha', 'Node.js Developer'),
    }]
    assert.equal(findDuplicate({ company: 'Beta', title: 'Node.js Developer', sourceUrl: 'https://b.example/1' }, existing).duplicate, false)
  })

  test('les accents et la ponctuation ne changent pas la normalisation', () => {
    assert.equal(normalize('Développeur — Full/Stack'), 'developpeur full stack')
  })

  test('la similarité reste bornée entre 0 et 1', () => {
    assert.equal(similarity('React Developer', 'React Developer'), 1)
    assert.ok(similarity('React Developer', 'Comptable') === 0)
  })
})

describe('pipeline', () => {
  const row = (stage: StageName) => ({ stage, history: [] as HistoryEntry[] })

  test('avance dans le sens du pipeline', () => {
    assert.ok(canTransition('DISCOVERED', 'QUALIFIED'))
    assert.ok(canTransition('MATCHED', 'OUTREACH_READY'))
  })

  test('refuse de revenir en arrière', () => {
    assert.equal(canTransition('INTERVIEW', 'CONTACTED'), false)
  })

  test('refuse de rester au même endroit', () => {
    assert.equal(canTransition('CONTACTED', 'CONTACTED'), false)
  })

  test('LOST est atteignable depuis n\'importe quel état actif', () => {
    assert.ok(canTransition('DISCOVERED', 'LOST'))
    assert.ok(canTransition('NEGOTIATION', 'LOST'))
  })

  test('une opportunité gagnée ou perdue ne bouge plus', () => {
    assert.equal(canTransition('WON', 'NEGOTIATION'), false)
    assert.equal(canTransition('LOST', 'CONTACTED'), false)
  })

  test('une opportunité sans réponse peut être relancée', () => {
    assert.ok(canTransition('NO_RESPONSE', 'REPLIED'))
    assert.equal(canTransition('NO_RESPONSE', 'QUALIFIED'), false)
  })

  test('la transition horodate et journalise', () => {
    const r = row('DISCOVERED')
    transition(r, 'QUALIFIED', 'critères remplis')
    assert.equal(r.stage, 'QUALIFIED')
    assert.equal(r.history.length, 1)
    assert.equal(r.history[0].from, 'DISCOVERED')
    assert.equal(r.history[0].note, 'critères remplis')
  })

  test('une transition interdite lève au lieu de corriger en silence', () => {
    assert.throws(() => transition(row('WON'), 'LOST'), TransitionError)
  })
})

describe('validation — un fait sans source n\'est pas un fait', () => {
  const base = {
    title: 'Développeur Full Stack TypeScript',
    company: 'Exemple SAS',
    sourceUrl: 'https://exemple.fr/jobs/1',
    sourceName: 'site carrière',
  }

  test('accepte une opportunité minimale correctement sourcée', () => {
    assert.deepEqual(validateOpportunityInput(base), [])
  })

  test('rejette un fait dépourvu d\'URL source', () => {
    const issues = validateOpportunityInput({
      ...base,
      facts: { tjm: { value: { min: 500, currency: 'EUR' }, observedAt: '2026-09-18T10:00:00Z' } },
    })
    assert.ok(issues.some((i) => i.includes('facts.tjm') && i.includes('source')))
  })

  test('rejette une URL source qui n\'est pas une vraie URL', () => {
    const issues = validateOpportunityInput({ ...base, sourceUrl: 'offre vue sur LinkedIn' })
    assert.ok(issues.some((i) => i.includes('sourceUrl')))
  })

  test('rejette un champ de fait inventé', () => {
    const issues = validateOpportunityInput({
      ...base,
      facts: { ambianceEquipe: { value: 'top', sourceUrl: 'https://exemple.fr', observedAt: '2026-09-18T10:00:00Z' } },
    })
    assert.ok(issues.some((i) => i.includes('inconnu')))
  })

  test('refuse qu\'un même champ soit à la fois fait et hypothèse', () => {
    const issues = validateOpportunityInput({
      ...base,
      facts: { remote: { value: 'full', sourceUrl: 'https://exemple.fr/jobs/1', observedAt: '2026-09-18T10:00:00Z' } },
      assumptions: [{ field: 'remote', value: 'hybrid', rationale: 'le recruteur laisse entendre un jour sur site' }],
    })
    assert.ok(issues.some((i) => i.includes('à la fois')))
  })

  test('exige une justification argumentée pour une hypothèse', () => {
    const issues = validateOpportunityInput({ ...base, assumptions: [{ field: 'tjm', value: 500, rationale: 'bof' }] })
    assert.ok(issues.some((i) => i.includes('rationale')))
  })
})

describe('validation — messages de prospection', () => {
  const base = {
    companyName: 'Exemple SAS',
    subject: 'Votre migration NestJS',
    body: 'Bonjour, j\'ai vu votre annonce pour reprendre la plateforme de commande en NestJS. J\'ai fait exactement ça chez PocketResult.',
    reason: 'Offre publiée mentionnant une migration NestJS',
    sourceUrl: 'https://exemple.fr/jobs/1',
  }

  test('accepte un message complet', () => {
    assert.deepEqual(validateOutreachInput(base), [])
  })

  test('interdit de créer un message directement au statut envoyé', () => {
    const issues = validateOutreachInput({ ...base, status: 'SENT' })
    assert.ok(issues.some((i) => i.includes('DRAFT')))
  })

  test('exige la source qui justifie le contact', () => {
    const issues = validateOutreachInput({ ...base, sourceUrl: 'trouvé sur Google' })
    assert.ok(issues.some((i) => i.includes('sourceUrl')))
  })

  test('signale les formules génériques', () => {
    const problems = lintOutreachBody('Bonjour, je suis passionné par votre entreprise et je me permets de vous contacter.')
    assert.equal(problems.length, 2)
  })

  test('laisse passer un message concret', () => {
    assert.deepEqual(lintOutreachBody(base.body), [])
  })
})
