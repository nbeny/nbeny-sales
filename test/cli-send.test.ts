/**
 * Tests d'intégration de `outreach:send` : la vraie CLI, lancée dans un
 * processus séparé, contre un faux serveur SMTP local et une base temporaire.
 * La vraie base (data/) n'est jamais touchée : NBENY_SALES_DATA_DIR la remplace.
 */
import { after, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalHash } from '../src/lib/outreach.ts'
import { SECRET_PATH } from '../src/lib/mail-config.ts'
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

/** Dossiers temporaires créés par les tests, supprimés à la fin du fichier. */
const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function setup(port: number, over: Record<string, unknown> = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'nbeny-sales-send-'))
  roots.push(root)
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
  return cliWith(env, {}, ...args)
}

/** `extra` remplace des variables ; une valeur `undefined` retire la variable. */
function cliWith(env: Env, extra: Record<string, string | undefined>, ...args: string[]): Promise<Run> {
  const vars: Record<string, string | undefined> = {
    ...process.env,
    NODE_OPTIONS: '',
    NBENY_SALES_DATA_DIR: env.dataDir,
    NBENY_SALES_CONFIG_DIR: env.configDir,
    NBENY_SALES_SMTP_ENV: env.secret,
    ...extra,
  }
  for (const key of Object.keys(vars)) if (vars[key] === undefined) delete vars[key]
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: vars,
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

  test('verrou d\'un processus vivant : refusé, rien ne part, le verrou d\'autrui reste en place', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      const lock = join(env.dataDir, 'send.lock.json')
      // Le processus de test lui-même : il existe forcément.
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: '2026-09-26T10:00:00Z' }))
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

  test('verrou d\'un processus disparu : toujours refusé, le message le dit', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      const lock = join(env.dataDir, 'send.lock.json')
      writeFileSync(lock, JSON.stringify({ pid: 999999, at: '2026-09-26T10:00:00Z' }))
      const run = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.equal(run.code, 2)
      assert.match(run.stderr, /le processus 999999 n'existe plus/)
      assert.match(run.stderr, /copie cachée dans la boîte de réception/)
      assert.equal(fake.received.length, 0)
      assert.equal(existsSync(lock), true)
    } finally {
      await fake.close()
    }
  })

  test('dossiers de test sans NBENY_SALES_SMTP_ENV : refusé avant tout, aucune connexion', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      const run = await cliWith(env, { NBENY_SALES_SMTP_ENV: undefined }, 'outreach:send', 'MSG-2026-0001')
      assert.equal(run.code, 2)
      assert.match(run.stderr, /le vrai mot de passe SMTP n'est jamais utilisé/)
      assert.equal(fake.received.length, 0)
      assert.equal(readEvents(env).length, 0)
      assert.equal(existsSync(join(env.dataDir, 'send.lock.json')), false)
    } finally {
      await fake.close()
    }
  })

  test('NBENY_SALES_SMTP_ENV pointant vers le vrai secret : refusé avant toute lecture', async () => {
    const fake = await fakeServer()
    try {
      const env = setup(fake.port)
      writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
      // Seul le chemin est transmis : le vrai fichier n'est ni créé ni lu par ce test.
      const run = await cliWith(env, { NBENY_SALES_SMTP_ENV: SECRET_PATH }, 'outreach:send', 'MSG-2026-0001')
      assert.equal(run.code, 2)
      assert.match(run.stderr, /le vrai mot de passe SMTP n'est jamais utilisé/)
      assert.equal(fake.received.length, 0)
      assert.equal(readEvents(env).length, 0)
    } finally {
      await fake.close()
    }
  })

  test('TLS coupé vers un hôte non local : refusé, aucune tentative de connexion', async () => {
    const env = setup(2525, { smtp: { host: '10.9.9.9', port: 2525, servername: 'localhost', tls: false } })
    writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
    const started = Date.now()
    const run = await cli(env, 'outreach:send', 'MSG-2026-0001')
    assert.equal(run.code, 2)
    assert.match(run.stderr, /TLS et tunnel sont obligatoires/)
    assert.equal(readEvents(env).length, 0)
    // Une tentative vers 10.9.9.9 attendrait le délai de connexion ; le refus est immédiat.
    assert.ok(Date.now() - started < 10_000)
  })

  test('les variables de test sont signalées à chaque lancement', async () => {
    const env = setup(2525)
    writeOutreach(env, [])
    const run = await cli(env, 'outreach:list')
    assert.equal(run.code, 0)
    assert.match(run.stderr, /Variables de test actives : données = .+, config = /)
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
      assert.ok(first.stderr.includes('copie cachée dans la boîte de réception de nicolas@urbanlink.fr (ou le journal Postfix)'), first.stderr)
      assert.equal(readOutreach(env)[0].status, 'APPROVED')

      const second = await cli(env, 'outreach:send', 'MSG-2026-0001')
      assert.equal(second.code, 2)
      assert.match(second.stderr, /interrompu/)
      assert.ok(second.stderr.includes('copie cachée dans la boîte de réception de nicolas@urbanlink.fr'), second.stderr)
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

describe('outreach:show, outreach:list, stats (intégration, lecture seule)', () => {
  const ESC = String.fromCharCode(0x1b)

  test('show : destinataire, statut, dates, Message-ID, et objet échappé', async () => {
    const env = setup(2525)
    const m = approved('MSG-2026-0001', 'rh@acme.example')
    m.to = { ...m.to!, name: 'Élodie Martin' }
    m.status = 'SENT'
    m.sentAt = '2026-09-27T10:00:00Z'
    m.messageId = '<abc@urbanlink.fr>'
    m.subject = 'Sujet' + ESC + '[2J piégé'
    writeOutreach(env, [m])
    const run = await cli(env, 'outreach:show', 'MSG-2026-0001')
    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stdout, /SENT/)
    assert.match(run.stdout, /Élodie Martin <rh@acme\.example>/)
    assert.match(run.stdout, /https:\/\/acme\.example\/contact/)
    assert.match(run.stdout, /2026-09-25T12:00:00Z/)
    assert.match(run.stdout, /2026-09-27T10:00:00Z/)
    assert.match(run.stdout, /<abc@urbanlink\.fr>/)
    assert.ok(run.stdout.includes('Sujet\\u{001B}[2J'))
    assert.ok(!run.stdout.includes(ESC))
  })

  test('show sans destinataire : le dit', async () => {
    const env = setup(2525)
    const m = approved('MSG-2026-0001', 'rh@acme.example')
    delete m.to
    m.status = 'DRAFT'
    writeOutreach(env, [m])
    const run = await cli(env, 'outreach:show', 'MSG-2026-0001')
    assert.match(run.stdout, /Destinataire : aucun/)
  })

  test('list : colonne destinataire, tiret quand il n\'y en a pas', async () => {
    const env = setup(2525)
    const without = approved('MSG-2026-0002', 'x@y.example')
    delete without.to
    without.status = 'DRAFT'
    writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example'), without])
    const run = await cli(env, 'outreach:list')
    const lines = run.stdout.trim().split('\n')
    assert.match(lines.find((l) => l.startsWith('MSG-2026-0001'))!, /rh@acme\.example/)
    assert.match(lines.find((l) => l.startsWith('MSG-2026-0002'))!, / — /)
  })

  test('stats : comptes par statut, sans destinataire, interrompus', async () => {
    const env = setup(2525)
    const draft = approved('MSG-2026-0001', 'a@b.example')
    draft.status = 'DRAFT'
    delete draft.to
    const sent = approved('MSG-2026-0003', 'c@d.example')
    sent.status = 'SENT'
    writeOutreach(env, [draft, approved('MSG-2026-0002', 'rh@acme.example'), sent])
    writeHistory(env, [{ at: new Date().toISOString(), event: 'outreach:sending', id: 'MSG-2026-0002' }])
    const run = await cli(env, 'stats')
    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stdout, /DRAFT 1 · APPROVED 1 · SENT 1/)
    assert.match(run.stdout, /1 sans destinataire/)
    assert.match(run.stdout, /1 envoi interrompu/)
  })
})

describe('report:daily (intégration, base temporaire)', () => {
  const interruptedEnv = () => {
    const env = setup(2525)
    // L'opportunité factice de setup() n'a pas de faits : le rapport, lui, les lit.
    writeFileSync(join(env.dataDir, 'opportunities.json'), '[]')
    writeOutreach(env, [approved('MSG-2026-0001', 'rh@acme.example')])
    writeHistory(env, [{ at: new Date().toISOString(), event: 'outreach:sending', id: 'MSG-2026-0001' }])
    return env
  }

  test('envoi interrompu : la preuve cite l\'expéditeur de config/mail.json', async () => {
    const env = interruptedEnv()
    const run = await cli(env, 'report:daily')
    assert.equal(run.code, 0, run.stderr + run.stdout)
    const md = readFileSync(join(env.dataDir, 'reports', 'daily-report.md'), 'utf8')
    assert.ok(md.includes('la copie cachée dans la boîte de réception de ' + FROM + ' (ou le journal Postfix)'))
  })

  test('sans config/mail.json : le rapport sort quand même, avec le texte générique', async () => {
    const env = interruptedEnv()
    rmSync(join(env.configDir, 'mail.json'))
    const run = await cli(env, 'report:daily')
    assert.equal(run.code, 0, run.stderr + run.stdout)
    const md = readFileSync(join(env.dataDir, 'reports', 'daily-report.md'), 'utf8')
    assert.ok(md.includes('la copie cachée de l\'expéditeur'))
  })
})
