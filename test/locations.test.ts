import { after, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { addPlace, describePlace, editPlace, LocationError, setHome } from '../src/lib/locations.ts'
import type { LocationsConfig } from '../src/lib/scoring.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function config(): LocationsConfig {
  return {
    home: { city: 'Wimereux', postalCode: '62930', country: 'FR' },
    places: [
      { key: 'lille', labels: ['lille', 'roubaix'], market: 'fr-hdf', priority: 4, travelMinutes: 105, maxOnsiteDays: 5, onsiteAccepted: true },
      { key: 'paris', labels: ['paris'], market: 'fr-paris', priority: 5, travelMinutes: 180, maxOnsiteDays: 2, note: 'Deux jours max.' },
    ],
    remoteLabels: [], hybridLabels: [], onsiteLabels: [],
  }
}

describe('lieux : modification', () => {
  test('modifie trajet, jours sur site et présentiel, et dit ce qui a changé', () => {
    const before = config()
    const { config: next, changes } = editPlace(before, 'paris', { travelMinutes: 150, maxOnsiteDays: 3, onsiteAccepted: true })
    const paris = next.places[1]
    assert.equal(paris.travelMinutes, 150)
    assert.equal(paris.maxOnsiteDays, 3)
    assert.equal(paris.onsiteAccepted, true)
    assert.deepEqual(changes, ['trajet 180 → 150 min', 'jours sur site max 2 → 3', 'présentiel accepté : oui'])
    assert.equal(before.places[1].travelMinutes, 180, 'la config d\'origine reste intacte')
  })

  test('retirer le présentiel accepté supprime le champ plutôt que d\'écrire false', () => {
    const { config: next } = editPlace(config(), 'lille', { onsiteAccepted: false })
    assert.equal('onsiteAccepted' in next.places[0], false)
  })

  test('une valeur identique n\'est pas comptée comme un changement', () => {
    assert.deepEqual(editPlace(config(), 'lille', { travelMinutes: 105, onsiteAccepted: true }).changes, [])
  })

  test('refuse les valeurs hors bornes au lieu d\'écrire une config incohérente', () => {
    assert.throws(() => editPlace(config(), 'lille', { maxOnsiteDays: 6 }), LocationError)
    assert.throws(() => editPlace(config(), 'lille', { travelMinutes: -5 }), LocationError)
    assert.throws(() => editPlace(config(), 'lille', { travelMinutes: Number('abc') }), LocationError)
  })

  test('un lieu inconnu est refusé en listant les lieux connus', () => {
    assert.throws(() => editPlace(config(), 'lens', { travelMinutes: 60 }), /Connus : lille, paris/)
  })

  test('ajoute et retire des libellés, normalisés en minuscules', () => {
    const { config: next } = editPlace(config(), 'lille', { addLabels: [' Tourcoing '], removeLabels: ['roubaix'] })
    assert.deepEqual(next.places[0].labels, ['lille', 'tourcoing'])
  })

  test('un libellé ne peut pas désigner deux lieux', () => {
    assert.throws(() => editPlace(config(), 'lille', { addLabels: ['Paris'] }), /désigne déjà le lieu paris/)
  })

  test('le dernier libellé d\'un lieu ne peut pas être retiré', () => {
    assert.throws(() => editPlace(config(), 'paris', { removeLabels: ['paris'] }), /dernier libellé/)
  })

  test('une note vide efface la note', () => {
    const { config: next, changes } = editPlace(config(), 'paris', { note: '' })
    assert.equal(next.places[1].note, undefined)
    assert.deepEqual(changes, ['note effacée'])
  })
})

describe('lieux : ajout et base', () => {
  test('ajoute un lieu sur un marché existant', () => {
    const next = addPlace(config(), { key: 'arras', labels: ['Arras'], market: 'fr-hdf', travelMinutes: 80, maxOnsiteDays: 5, onsiteAccepted: true })
    assert.deepEqual(next.places[2], { key: 'arras', labels: ['arras'], market: 'fr-hdf', priority: 5, travelMinutes: 80, maxOnsiteDays: 5, onsiteAccepted: true })
  })

  test('refuse un marché inconnu, une clé déjà prise ou mal formée', () => {
    const base = { labels: ['x'], travelMinutes: 10, maxOnsiteDays: 1 }
    assert.throws(() => addPlace(config(), { ...base, key: 'x', market: 'fr-xyz' }), /Marché inconnu/)
    assert.throws(() => addPlace(config(), { ...base, key: 'lille', market: 'fr-hdf' }), /existe déjà/)
    assert.throws(() => addPlace(config(), { ...base, key: 'Saint Omer', market: 'fr-hdf' }), /minuscules/)
  })

  test('change la base sans toucher aux trajets', () => {
    const next = setHome(config(), { city: 'Boulogne-sur-Mer', postalCode: '62200' })
    assert.deepEqual(next.home, { city: 'Boulogne-sur-Mer', postalCode: '62200', country: 'FR' })
    assert.equal(next.places[0].travelMinutes, 105)
  })

  test('décrit un lieu sur une ligne lisible', () => {
    assert.match(describePlace(config().places[0]), /^lille\s+1 h 45 min\s+5 j\/sem\. sur site max\s+présentiel accepté\s+2 libellés$/)
    assert.match(describePlace(config().places[1]), /3 h\s/)
  })
})

describe('lieux : CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'nbeny-sales-loc-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  const configDir = join(root, 'config')
  const dataDir = join(root, 'data')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(dataDir, 'history'), { recursive: true })
  copyFileSync(join(ROOT, 'config', 'locations.json'), join(configDir, 'locations.json'))
  const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NBENY_SALES_CONFIG_DIR: configDir, NBENY_SALES_DATA_DIR: dataDir },
  })
  const read = () => JSON.parse(readFileSync(join(configDir, 'locations.json'), 'utf8')) as LocationsConfig & { $comment: string }

  test('location:set écrit la config, garde le commentaire et journalise', () => {
    const r = run('location:set', 'paris', '--max-onsite', '3', '--add-label', 'nanterre,courbevoie')
    assert.equal(r.status, 0, r.stderr)
    const saved = read()
    const paris = saved.places.find((p) => p.key === 'paris')!
    assert.equal(paris.maxOnsiteDays, 3)
    assert.ok(paris.labels.includes('nanterre') && paris.labels.includes('courbevoie'))
    assert.ok(saved.$comment.length > 0)
    const day = new Date().toISOString().slice(0, 10)
    assert.match(readFileSync(join(dataDir, 'history', day + '.jsonl'), 'utf8'), /"event":"location:set"/)
  })

  test('une saisie invalide sort en erreur sans rien écrire', () => {
    const before = readFileSync(join(configDir, 'locations.json'), 'utf8')
    const r = run('location:set', 'lille', '--max-onsite', '9')
    assert.equal(r.status, 2)
    assert.match(r.stderr, /entre 0 et 5/)
    assert.equal(readFileSync(join(configDir, 'locations.json'), 'utf8'), before)
  })

  test('location:set refuse un --onsite-accepted ambigu', () => {
    const r = run('location:set', 'lille', '--onsite-accepted', 'peut-être')
    assert.equal(r.status, 2)
    assert.match(r.stderr, /oui ou non/)
  })
})
