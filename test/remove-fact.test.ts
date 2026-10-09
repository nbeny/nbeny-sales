import { after, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Opportunity } from '../src/lib/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = 'https://example.com/annonce'

describe('opportunity:remove-fact', () => {
  const root = mkdtempSync(join(tmpdir(), 'nbeny-sales-fact-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  const configDir = join(root, 'config')
  const dataDir = join(root, 'data')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(dataDir, 'history'), { recursive: true })
  for (const f of readdirSync(join(ROOT, 'config')).filter((f) => f.endsWith('.json'))) copyFileSync(join(ROOT, 'config', f), join(configDir, f))
  copyFileSync(join(ROOT, 'data', 'profile.json'), join(dataDir, 'profile.json'))
  const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NBENY_SALES_CONFIG_DIR: configDir, NBENY_SALES_DATA_DIR: dataDir },
  })
  const fact = (value: unknown) => ({ value, sourceUrl: SOURCE, observedAt: '2026-10-09T10:00:00Z' })
  const opp = () => (JSON.parse(readFileSync(join(dataDir, 'opportunities.json'), 'utf8')) as Opportunity[])[0]

  const added = run('opportunity:add', '--json', JSON.stringify({
    title: 'Développeur TypeScript', company: 'Exemple', sourceUrl: SOURCE, sourceName: 'Exemple',
    facts: { location: fact('Lille'), seniorityYears: fact(10), technologies: fact(['TypeScript']) },
  }))
  assert.equal(added.status, 0, added.stderr)
  const id = opp().id

  test('sans --reason, refuse et ne touche à rien', () => {
    const r = run('opportunity:remove-fact', id, 'seniorityYears')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--reason/)
    assert.equal(opp().facts.seniorityYears?.value, 10)
  })

  test('un champ absent est refusé', () => {
    const r = run('opportunity:remove-fact', id, 'salary', '--reason', 'jamais lu')
    assert.equal(r.status, 2)
    assert.match(r.stderr, /seniorityYears/)
  })

  test('retire le fait, re-score et journalise la valeur retirée avec la raison', () => {
    const r = run('opportunity:remove-fact', id, 'seniorityYears', '--reason', 'L\'annonce dit « expert », pas 10 ans.')
    assert.equal(r.status, 0, r.stderr)
    const after = opp()
    assert.equal('seniorityYears' in after.facts, false)
    assert.equal(after.facts.location?.value, 'Lille', 'les autres faits restent')
    assert.ok(after.match, 'le score est recalculé')
    const day = new Date().toISOString().slice(0, 10)
    const log = readFileSync(join(dataDir, 'history', day + '.jsonl'), 'utf8')
    assert.match(log, /"event":"opportunity:remove-fact".*"field":"seniorityYears".*"removed":\{"value":10/)
    assert.match(log, /pas 10 ans/)
  })
})
