/**
 * Tests d'intégration de `outreach:send` : la vraie CLI, lancée dans un
 * processus séparé, contre un faux serveur SMTP local et une base temporaire.
 * La vraie base (data/) n'est jamais touchée : NBENY_SALES_DATA_DIR la remplace.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalHash } from '../src/lib/outreach.ts'
import type { Opportunity, OutreachMessage } from '../src/lib/types.ts'
import { fakeServer, type FakeServer } from './helpers/fake-smtp.ts'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')
const FROM = 'nicolas@urbanlink.fr'

interface Env {
  dataDir: string
  configDir: string
  secret: string
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function setup(port: number, over: Record<string, unknown> = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'nbeny-sales-send-'))
  const dataDir = join(root, 'data')
  const configDir = join(root, 'config')
  mkdirSync(join(dataDir, 'history'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const config = {
    from: { email: FROM, name: 'Nicolas BENY' },
    bccSelf: true,
    smtp: { host: '127.0.0.1', port, servername: 'localhost', tls: false },
    dailyCap: 10,
    minDelaySeconds: 1,
    recipientCooldownDays: 30,
    ...over,
  }
  writeFileSync(join(configDir, 'mail.json'), JSON.stringify(config, null, 2))
  const secret = join(root, 'smtp.env')
  writeFileSync(secret, 'SMTP_PASSWORD=secret-de-test\n')
  const opportunities = [{ id: 'OPP-2026-0001', stage: 'OUTREACH_READY' }] as unknown as Opportunity[]
  writeFileSync(join(dataDir, 'opportunities.json'), JSON.stringify(opportunities, null, 2))
  return { dataDir, configDir, secret }
}

function approved(id: string, email: string): OutreachMessage {
  const m: OutreachMessage = {
    id,
    opportunityId: 'OPP-2026-0001',
    companyName: 'Acme',
    channel: 'email',
    audience: 'hr',
    subject: 'Votre annonce Node.js',
    body: 'Bonjour, un message assez long pour passer toutes les validations du brouillon.',
    reason: 'Annonce du 20/09.',
    sourceUrl: 'https://acme.example/job',
    status: 'APPROVED',
    createdAt: '2026-09-20T00:00:00Z',
    language: 'fr',
    to: { email, sourceUrl: 'https://acme.example/contact', readAt: '2026-09-25T00:00:00Z' },
    approvedAt: '2026-09-25T12:00:00Z',
  }
  m.approvedHash = approvalHash(m)
  return m
}

function writeOutreach(env: Env, rows: OutreachMessage[]): void {
  writeFileSync(join(env.dataDir, 'outreach.json'), JSON.stringify(rows, null, 2))
}

function readOutreach(env: Env): OutreachMessage[] {
  return JSON.parse(readFileSync(join(env.dataDir, 'outreach.json'), 'utf8'))
}

function writeHistory(env: Env, events: Record<string, unknown>[]): void {
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(join(env.dataDir, 'history', day + '.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function readEvents(env: Env): Record<string, unknown>[] {
  const day = new Date().toISOString().slice(0, 10)
  const path = join(env.dataDir, 'history', day + '.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** Lancement asynchrone : le faux serveur tourne dans ce processus, il ne faut pas bloquer sa boucle. */
function cli(env: Env, ...args: string[]): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        NBENY_SALES_DATA_DIR: env.dataDir,
        NBENY_SALES_CONFIG_DIR: env.configDir,
        NBENY_SALES_SMTP_ENV: env.secret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

const dataCommands = (fake: FakeServer) => fake.received.filter((l) => l === 'DATA').length

describe('outreach:send (intégration)', () => {
  test('succès : SENT avec sentAt et messageId, journal sending puis sent, destinataire et copie cachée, verrou libéré', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      const run = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.equal(run.code, 0, run.stderr)

      const [m] = readOutreach(env)
      assert.equal(m.status, 'SENT')
      assert.ok(m.sentAt)
      assert.match(m.messageId ?? '', /^<.+@urbanlink\.fr>$/)

      const events = readEvents(env).filter((e) => e.id === 'MSG-2026-0001').map((e) => e.event)
      assert.deepEqual(events, ['outreach:sending', 'outreach:sent'])

      assert.ok(fake.received.includes('RCPT TO:<rh@acme.example>'))
      assert.ok(fake.received.includes('RCPT TO:<' + FROM + '>'))
      assert.equal(dataCommands(fake), 1)
      assert.equal(existsSync(join(env.dataDir, 'send.lock.json')), false)
    } finally {
      await fake.close()
    }
  })

  test('message modifié pendant le lot : le second, repassé en DRAFT, ne part pas', async () => {
    let env: Env | undefined
    const fake = await fakeServer({}, {
      onMessageEnd: (count) => {
        if (count !== 1 || !env) return
        // Simule un outreach:edit lancé pendant l'envoi du premier message.
        const rows = readOutreach(env)
        const second = rows.find((r) => r.id === 'MSG-2026-0002')!
        second.status = 'DRAFT'
        second.body = second.body + ' Corrigé.'
        delete second.approvedAt
        delete second.approvedHash
        writeOutreach(env, rows)
      },
    })
    try {
      env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example'), approved('MSG-2026-0002', 'cto@other.example')])
      const run = await cli(env, 'outreach:send', '--all-approved')
      assert.equal(run.code, 2, run.stderr)
      assert.equal(dataCommands(fake), 1)
      assert.ok(!fake.received.includes('RCPT TO:<cto@other.example>'))

      const rows = readOutreach(env)
      assert.equal(rows.find((r) => r.id === 'MSG-2026-0001')!.status, 'SENT')
      assert.equal(rows.find((r) => r.id === 'MSG-2026-0002')!.status, 'DRAFT')
      assert.match(run.stderr, /MSG-2026-0002 ne part pas/)
    } finally {
      await fake.close()
    }
  })

  test('déjà envoyé selon le journal : refusé, rien ne part', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      writeHistory(env, [{ at: new Date().toISOString(), event: 'outreach:sent', id: 'MSG-2026-0001' }])
      const run = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.equal(run.code, 2)
      assert.match(run.stderr, /a déjà été envoyé \(journal\)/)
      assert.equal(fake.received.length, 0)
      assert.equal(readOutreach(env)[0].status, 'APPROVED')
    } finally {
      await fake.close()
    }
  })

  test('verrou présent : refusé, rien ne part, le verrou d\'autrui reste en place', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      const lock = join(env.dataDir, 'send.lock.json')
      writeFileSync(lock, JSON.stringify({ pid: 999999, at: '2026-09-26T10:00:00Z' }))
      const run = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.equal(run.code, 2)
      assert.match(run.stderr, /Un envoi est déjà en cours/)
      assert.equal(fake.received.length, 0)
      assert.equal(existsSync(lock), true)
      assert.equal(readOutreach(env)[0].status, 'APPROVED')
    } finally {
      await fake.close()
    }
  })

  test('coupure après le corps : send-uncertain, reste APPROVED, et un second lancement le refuse', async () => {
    const fake = await fakeServer({ '.': 'CLOSE' })
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      const first = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.equal(first.code, 1)
      const events = readEvents(env).map((e) => e.event)
      assert.deepEqual(events, ['outreach:sending', 'outreach:send-uncertain'])
      assert.equal(readOutreach(env)[0].status, 'APPROVED')

      const second = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.equal(second.code, 2)
      assert.match(second.stderr, /interrompu/)
      assert.equal(dataCommands(fake), 1)
    } finally {
      await fake.close()
    }
  })

  test('plafond du jour atteint : rien ne part', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port, { dailyCap: 1 })
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      writeHistory(env, [{ at: new Date().toISOString(), event: 'outreach:sent', id: 'MSG-2026-0099' }])
      const run = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.match(run.stdout, /attendront demain/)
      assert.equal(fake.received.length, 0)
      assert.equal(readOutreach(env)[0].status, 'APPROVED')
    } finally {
      await fake.close()
    }
  })
})
