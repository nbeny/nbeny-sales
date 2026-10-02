#!/usr/bin/env node
/**
 * Point d'écriture unique de la base.
 *
 * Les agents n'écrivent jamais dans `data/` directement : ils appellent cette
 * CLI, qui valide, attribue les identifiants, déduplique et journalise. Un agent
 * qui se trompe reçoit une erreur explicite au lieu de corrompre la base.
 *
 *   node src/cli.ts opportunity:add --file candidate.json
 *   node src/cli.ts match:all
 *   node src/cli.ts report:daily
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as pause } from 'node:timers/promises'
import {
  appendHistory,
  readHistory,
  readCollection,
  writeCollection,
  readConfig,
  readJson,
  writeJson,
  writeText,
  DATA_DIR,
  CONFIG_DIR,
  REPORTS_DIR,
  ROOT,
} from './lib/store.ts'
import { nextId } from './lib/ids.ts'
import { fingerprint, findDuplicate, type DedupRow } from './lib/dedup.ts'
import { transition, canTransition } from './lib/pipeline.ts'
import { computeMatch, type KeywordsConfig, type LocationsConfig, type ScoringConfig, type ScoringContext } from './lib/scoring.ts'
import { assertValidOpportunity, assertValidOutreach, lintOutreachBody, validateOpportunityInput, validateRecipient, escapeForDisplay, ValidationError } from './lib/validate.ts'
import { buildDailyReport } from './lib/report.ts'
import { filterOpportunities } from './lib/query.ts'
import { formatCompact, formatDetailed } from './lib/format.ts'
import { parseRuns, formatDuration, type RunStatus } from './lib/runs.ts'
import { approvalHash, approvalIssues, orphanSendings, sendIssues, sentCountOn, sentEvidence, type HistoryEvent } from './lib/outreach.ts'
import { buildMessage } from './lib/mime.ts'
import { sendMail, SmtpError } from './lib/smtp.ts'
import { withTunnel } from './lib/tunnel.ts'
import { readSmtpPassword, SECRET_PATH, sendSafetyIssues, type MailConfig } from './lib/mail-config.ts'
import type { Assumption, Followup, FollowupStatus, Opportunity, OutreachMessage, Profile, StageName } from './lib/types.ts'

const args = process.argv.slice(2)
// Sans argument, depuis un vrai terminal : l'application interactive. Un agent
// n'a pas de terminal et retombe sur l'aide.
const command = args[0] ?? (process.stdin.isTTY && process.stdout.isTTY ? 'shell' : 'help')

function flag(name: string): string | undefined {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}

function has(name: string): boolean {
  return args.includes('--' + name)
}

function positional(index: number): string | undefined {
  return args.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a))[index]
}

const FLAGS_WITH_VALUE = ['file', 'json', 'days', 'priority', 'stage', 'contract', 'note', 'floor', 'target', 'source', 'decision', 'currency', 'unit', 'limit', 'min-score', 'min-coverage', 'remote', 'location', 'email', 'name', 'sort', 'search']
function isFlagValue(token: string): boolean {
  const i = args.indexOf(token)
  return i > 0 && args[i - 1].startsWith('--') && FLAGS_WITH_VALUE.includes(args[i - 1].slice(2))
}

// Visible à chaque lancement : des dossiers de test restés actifs par erreur ne passent pas inaperçus.
if (process.env.NBENY_SALES_DATA_DIR || process.env.NBENY_SALES_CONFIG_DIR || process.env.NBENY_SALES_SMTP_ENV) {
  console.error('⚠ Variables de test actives : données = ' + resolvePath(DATA_DIR) + ', config = ' + resolvePath(CONFIG_DIR))
}

/** Charge la charge utile JSON : `--file`, `--json`, ou stdin. */
function payload(): Record<string, unknown> {
  const file = flag('file')
  if (file) return JSON.parse(readFileSync(file, 'utf8'))
  const inline = flag('json')
  if (inline) return JSON.parse(inline)
  const stdin = readFileSync(0, 'utf8').trim()
  if (!stdin) throw new Error('Aucune donnée. Utilise --file <chemin>, --json <json>, ou envoie le JSON sur stdin.')
  return JSON.parse(stdin)
}

function loadProfile(): Profile {
  const profile = readJson<Profile | null>(join(DATA_DIR, 'profile.json'), null)
  if (!profile) throw new Error('data/profile.json est absent. Lance PROFILE_AGENT avant toute autre chose.')
  return profile
}

function scoringContext(): ScoringContext {
  return {
    profile: loadProfile(),
    scoring: readConfig<ScoringConfig>('scoring'),
    locations: readConfig<LocationsConfig>('locations'),
    keywords: readConfig<KeywordsConfig>('keywords'),
  }
}

function dedupRows(rows: Opportunity[]): DedupRow[] {
  return rows.map((o) => ({ id: o.id, company: o.company, title: o.title, sourceUrl: o.sourceUrl, fingerprint: o.fingerprint }))
}

// --- Commandes -------------------------------------------------------------

function opportunityAdd(): void {
  const input = payload()
  assertValidOpportunity(input)

  const rows = readCollection<Opportunity>('opportunities')
  const candidate = {
    company: String(input.company),
    title: String(input.title),
    sourceUrl: String(input.sourceUrl),
  }
  const threshold = readConfig<ScoringConfig>('scoring').rules.duplicateSimilarityThreshold
  const dup = findDuplicate(candidate, dedupRows(rows), threshold)
  if (dup.duplicate && !has('force')) {
    console.error('Doublon de ' + dup.matchedId + ' (' + dup.kind + ', similarité ' + dup.similarity + '). Rien n\'a été écrit.')
    console.error('Si ce sont bien deux opportunités distinctes, relance avec --force.')
    process.exit(2)
  }

  const now = new Date().toISOString()
  const opp: Opportunity = {
    id: nextId('opportunity', rows.map((r) => r.id)),
    title: candidate.title,
    company: candidate.company,
    sourceUrl: candidate.sourceUrl,
    sourceName: String(input.sourceName),
    discoveredAt: now,
    stage: 'DISCOVERED',
    facts: (input.facts ?? {}) as Opportunity['facts'],
    assumptions: (input.assumptions ?? []) as Opportunity['assumptions'],
    fingerprint: fingerprint(candidate.company, candidate.title),
    history: [{ at: now, from: null, to: 'DISCOVERED' }],
    notes: typeof input.notes === 'string' ? input.notes : undefined,
  }

  opp.match = computeMatch(opp, scoringContext())
  opp.stage = 'MATCHED'
  opp.history.push({ at: now, from: 'DISCOVERED', to: 'MATCHED', note: 'Scoring automatique à la création.' })

  rows.push(opp)
  writeCollection('opportunities', rows)
  appendHistory({ event: 'opportunity:add', id: opp.id, company: opp.company, score: opp.match.score })

  console.log(opp.id + ' créée — ' + opp.match.score + '/100 (couverture ' + opp.match.coverage + '/8, ' + opp.match.priority + ')')
  for (const w of opp.match.weaknesses) console.log('  ⚠️  ' + w)
}

/**
 * Import en lot. Chaque entrée passe exactement par les mêmes contrôles qu'un
 * ajout unitaire : une entrée refusée n'interrompt pas les autres, et le
 * rapport de fin dit précisément ce qui est passé, ce qui a doublonné et ce qui
 * a été rejeté — sinon un import massif devient une boîte noire.
 */
function opportunityImport(): void {
  const rows = payload() as unknown
  if (!Array.isArray(rows)) throw new Error('Attendu : un tableau JSON d\'opportunités.')

  const added: string[] = []
  const duplicates: string[] = []
  const rejected: { label: string; issues: string[] }[] = []

  for (const input of rows as Record<string, unknown>[]) {
    const label = String(input.company ?? '?') + ' — ' + String(input.title ?? '?')
    const issues = validateOpportunityInput(input)
    if (issues.length) { rejected.push({ label, issues }); continue }

    const existing = readCollection<Opportunity>('opportunities')
    const candidate = { company: String(input.company), title: String(input.title), sourceUrl: String(input.sourceUrl) }
    const threshold = readConfig<ScoringConfig>('scoring').rules.duplicateSimilarityThreshold
    const dup = findDuplicate(candidate, dedupRows(existing), threshold)
    if (dup.duplicate) { duplicates.push(label + '  (= ' + dup.matchedId + ')'); continue }

    const now = new Date().toISOString()
    const opp: Opportunity = {
      id: nextId('opportunity', existing.map((r) => r.id)),
      title: candidate.title,
      company: candidate.company,
      sourceUrl: candidate.sourceUrl,
      sourceName: String(input.sourceName),
      discoveredAt: now,
      stage: 'MATCHED',
      facts: (input.facts ?? {}) as Opportunity['facts'],
      assumptions: (input.assumptions ?? []) as Opportunity['assumptions'],
      fingerprint: fingerprint(candidate.company, candidate.title),
      history: [
        { at: now, from: null, to: 'DISCOVERED' },
        { at: now, from: 'DISCOVERED', to: 'MATCHED', note: 'Import en lot avec scoring automatique.' },
      ],
      notes: typeof input.notes === 'string' ? input.notes : undefined,
    }
    opp.match = computeMatch(opp, scoringContext())
    existing.push(opp)
    writeCollection('opportunities', existing)
    added.push(opp.id + '  ' + opp.match.priority.padEnd(6) + ' ' + String(opp.match.score).padStart(3) + '/100 (' + opp.match.coverage + '/8)  ' + label)
  }

  appendHistory({ event: 'opportunity:import', added: added.length, duplicates: duplicates.length, rejected: rejected.length })

  for (const line of added) console.log(line)
  if (duplicates.length) {
    console.log('\nDoublons écartés (' + duplicates.length + ') :')
    for (const d of duplicates) console.log('  ' + d)
  }
  if (rejected.length) {
    console.log('\nRefusées (' + rejected.length + ') :')
    for (const r of rejected) {
      console.log('  ' + r.label)
      for (const i of r.issues) console.log('    - ' + i)
    }
  }
  console.log('\n' + added.length + ' ajoutée(s), ' + duplicates.length + ' doublon(s), ' + rejected.length + ' refusée(s).')
}

function opportunityList(): void {
  const rows = readCollection<Opportunity>('opportunities')
  const num = (name: string) => (flag(name) === undefined ? undefined : Number(flag(name)))

  const filtered = filterOpportunities(rows, {
    priority: flag('priority'),
    stage: flag('stage'),
    contract: flag('contract'),
    remote: flag('remote'),
    location: flag('location'),
    search: flag('search'),
    sort: flag('sort'),
    minScore: num('min-score'),
    minCoverage: num('min-coverage'),
    limit: num('limit') ?? 50,
  })

  if (!filtered.length) {
    console.log('Aucune opportunité ne correspond à ce filtre. (' + rows.length + ' en base)')
    return
  }

  const detailed = has('details') || has('v')
  console.log(filtered.map(detailed ? formatDetailed : formatCompact).join(detailed ? '\n\n' : '\n'))
  console.log('\n' + filtered.length + ' sur ' + rows.length + ' opportunité(s).')
}

function opportunityShow(): void {
  const id = positional(0)
  const opp = readCollection<Opportunity>('opportunities').find((o) => o.id === id)
  if (!opp) { console.error('Opportunité introuvable : ' + id); process.exit(1) }
  console.log(has('pretty') ? formatDetailed(opp) : JSON.stringify(opp, null, 2))
}

/**
 * Enrichissement d'une opportunité déjà en base.
 *
 * Le chemin normal pour faire monter la couverture : on retourne sur la page
 * source, on lit ce que le premier passage avait manqué, et on ajoute les faits
 * ici. `opportunity:add` créerait un doublon ; l'édition à la main de `data/`
 * est interdite. Cette commande est donc le seul chemin honnête.
 *
 * Un fait déjà présent n'est jamais remplacé en silence : il faut `--overwrite`.
 */
function opportunityEnrich(): void {
  const id = positional(0)
  if (!id) { console.error('Usage : opportunity:enrich <id> --file <json>'); process.exit(1) }

  const rows = readCollection<Opportunity>('opportunities')
  const opp = rows.find((o) => o.id === id)
  if (!opp) { console.error('Opportunité introuvable : ' + id); process.exit(1) }

  const input = payload()
  const incomingFacts = (input.facts ?? {}) as Record<string, unknown>
  const incomingAssumptions = (input.assumptions ?? []) as Assumption[]

  const clashes = Object.keys(incomingFacts).filter((k) => k in opp.facts)
  if (clashes.length && !has('overwrite')) {
    console.error('Faits déjà renseignés : ' + clashes.join(', ') + '. Rien n\'a été écrit.')
    console.error('Si la nouvelle lecture corrige l\'ancienne, relance avec --overwrite.')
    process.exit(2)
  }

  const mergedFacts = { ...opp.facts, ...incomingFacts }
  const mergedAssumptions = [
    ...opp.assumptions.filter((a) => !incomingAssumptions.some((b) => b.field === a.field)),
    ...incomingAssumptions,
  ].filter((a) => !(a.field in mergedFacts))

  // Le candidat repasse par exactement la même validation qu'à la création :
  // pas de fait sans URL source, pas de fait aussi déclaré en hypothèse.
  assertValidOpportunity({
    title: opp.title,
    company: opp.company,
    sourceUrl: opp.sourceUrl,
    sourceName: opp.sourceName,
    facts: mergedFacts,
    assumptions: mergedAssumptions,
  })

  const before = { score: opp.match?.score ?? 0, coverage: opp.match?.coverage ?? 0, priority: opp.match?.priority ?? 'LOW' }
  opp.facts = mergedFacts as Opportunity['facts']
  opp.assumptions = mergedAssumptions
  if (typeof input.notes === 'string' && input.notes.trim()) opp.notes = input.notes
  opp.match = computeMatch(opp, scoringContext())

  writeCollection('opportunities', rows)
  const added = Object.keys(incomingFacts)
  appendHistory({ event: 'opportunity:enrich', id, facts: added, from: before, to: { score: opp.match.score, coverage: opp.match.coverage, priority: opp.match.priority } })

  console.log(
    id + ' enrichie (' + (added.join(', ') || 'aucun fait') + ') — ' +
    before.score + '/100 (' + before.coverage + '/8, ' + before.priority + ')' +
    '  ->  ' + opp.match.score + '/100 (' + opp.match.coverage + '/8, ' + opp.match.priority + ')',
  )
  for (const w of opp.match.weaknesses) console.log('  ⚠️  ' + w)
}

function opportunityStage(): void {
  const id = positional(0)
  const to = positional(1)?.toUpperCase() as StageName | undefined
  if (!id || !to) { console.error('Usage : opportunity:stage <id> <STAGE> [--note "..."]'); process.exit(1) }

  const rows = readCollection<Opportunity>('opportunities')
  const opp = rows.find((o) => o.id === id)
  if (!opp) { console.error('Opportunité introuvable : ' + id); process.exit(1) }
  if (!canTransition(opp.stage, to)) {
    console.error('Transition interdite : ' + opp.stage + ' -> ' + to)
    process.exit(2)
  }
  transition(opp, to, flag('note'))
  writeCollection('opportunities', rows)
  appendHistory({ event: 'opportunity:stage', id, to })
  console.log(id + ' : ' + to)
}

function matchAll(): void {
  const ctx = scoringContext()
  const rows = readCollection<Opportunity>('opportunities')
  const only = positional(0)
  let count = 0
  for (const opp of rows) {
    if (only && opp.id !== only) continue
    opp.match = computeMatch(opp, ctx)
    count += 1
    console.log(opp.id + '  ' + opp.match.priority.padEnd(6) + '  ' + opp.match.score + '/100 (' + opp.match.coverage + '/8)  ' + opp.company)
  }
  writeCollection('opportunities', rows)
  appendHistory({ event: 'match:all', count })
  console.log(count + ' opportunité(s) re-scorée(s).')
}

/** Les fins de ligne Windows ne sont pas des caractères cachés : on les ramène à \n avant de valider. */
function normalizeNewlines(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value
}

function outreachAdd(): void {
  const input = payload()
  input.subject = normalizeNewlines(input.subject)
  input.body = normalizeNewlines(input.body)
  assertValidOutreach(input)
  const lint = lintOutreachBody(String(input.body))
  if (lint.length && !has('force')) {
    console.error('Message refusé :')
    for (const l of lint) console.error('  - ' + l)
    process.exit(2)
  }

  const rows = readCollection<OutreachMessage>('outreach')
  const message: OutreachMessage = {
    id: nextId('outreach', rows.map((r) => r.id)),
    opportunityId: input.opportunityId as string | undefined,
    companyName: String(input.companyName),
    channel: (input.channel as OutreachMessage['channel']) ?? 'email',
    audience: (input.audience as OutreachMessage['audience']) ?? 'recruiter',
    subject: String(input.subject),
    body: String(input.body),
    reason: String(input.reason),
    sourceUrl: String(input.sourceUrl),
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
    language: (input.language as 'fr' | 'en') ?? 'fr',
  }
  rows.push(message)
  writeCollection('outreach', rows)
  appendHistory({ event: 'outreach:add', id: message.id, company: message.companyName })
  console.log(message.id + ' créé en DRAFT. Rien n\'a été envoyé.')
  console.log('Relis-le : node src/cli.ts outreach:show ' + message.id)
}

function outreachShow(): void {
  const id = positional(0)
  const m = readCollection<OutreachMessage>('outreach').find((r) => r.id === id)
  if (!m) { console.error('Message introuvable : ' + id); process.exit(1) }
  // Tout passe par escapeForDisplay, comme à l'approbation : rien d'affiché ne pilote le terminal.
  const show = (text: string) => escapeForDisplay(text)
  const to = m.to
  console.log('# ' + m.id + ' — ' + show(m.companyName) + ' (' + m.channel + ' / ' + m.audience + ') — ' + m.status)
  console.log('Destinataire : ' + (to ? show(to.name ? to.name + ' <' + to.email + '>' : to.email) : 'aucun (outreach:set-recipient ' + m.id + ')'))
  if (to) console.log('Adresse lue sur : ' + show(to.sourceUrl) + ' (le ' + to.readAt.slice(0, 10) + ')')
  if (m.approvedAt) console.log('Approuvé le : ' + m.approvedAt)
  if (m.sentAt) console.log('Envoyé le : ' + m.sentAt)
  if (m.messageId) console.log('Message-ID : ' + show(m.messageId))
  console.log('Source : ' + show(m.sourceUrl))
  console.log('Pourquoi : ' + show(m.reason))
  console.log('\nObjet : ' + show(m.subject) + '\n')
  console.log(escapeForDisplay(m.body, true))
}

function outreachList(): void {
  const rows = readCollection<OutreachMessage>('outreach')
  if (!rows.length) { console.log('Aucun message.'); return }
  for (const m of rows) {
    const to = m.to ? escapeForDisplay(m.to.email) : '—'
    console.log([m.id, m.status.padEnd(8), m.channel.padEnd(9), to, escapeForDisplay(m.companyName), '—', escapeForDisplay(m.subject)].join('  '))
  }
}

function outreachMarkSent(): void {
  const id = positional(0)
  const rows = readCollection<OutreachMessage>('outreach')
  const m = rows.find((r) => r.id === id)
  if (!m) { console.error('Message introuvable : ' + id); process.exit(1) }
  if (m.status === 'SENT') { console.log(id + ' était déjà marqué comme envoyé le ' + m.sentAt); return }
  m.status = 'SENT'
  m.sentAt = new Date().toISOString()
  writeCollection('outreach', rows)
  appendHistory({ event: 'outreach:mark-sent', id })
  console.log(id + ' marqué comme envoyé. (envoi fait hors de la CLI : enregistré seulement)')
}

function findOutreach(rows: OutreachMessage[], id: string | undefined): OutreachMessage {
  const m = rows.find((r) => r.id === id)
  if (!m) { console.error('Message introuvable : ' + id); process.exit(1) }
  return m
}

/** Remet un message en brouillon : toute modification annule l'approbation. */
function resetApproval(m: OutreachMessage): boolean {
  const wasApproved = m.status === 'APPROVED'
  m.status = 'DRAFT'
  delete m.approvedAt
  delete m.approvedHash
  return wasApproved
}

/**
 * Barrière contre un agent qui appelle la CLI normalement : il n'a pas de
 * terminal interactif, donc pas de confirmation. Ce n'est pas une barrière
 * contre quelqu'un capable d'exécuter du code arbitraire : les règles de
 * permission de .claude/settings.json sont l'autre barrière.
 */
async function confirmByTyping(expected: string, prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Cette commande demande une confirmation au clavier : elle se lance depuis un terminal, par Nicolas, jamais par un agent.')
    return false
  }
  if (process.execArgv.length > 0 || process.env.NODE_OPTIONS) {
    console.error('Confirmation refusée : Node a été lancé avec des options (--import, NODE_OPTIONS…).')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(prompt)).trim() === expected
  } finally {
    rl.close()
  }
}

function outreachSetRecipient(): void {
  const id = positional(0)
  const email = flag('email')?.trim()
  const sourceUrl = flag('source')
  const name = flag('name')?.trim() || undefined
  // Lecture, vérification et écriture d'un seul tenant, sans attente entre les deux.
  const rows = readCollection<OutreachMessage>('outreach')
  const m = findOutreach(rows, id)
  if (m.status === 'SENT') { console.error(m.id + ' est déjà envoyé : son destinataire ne change plus.'); process.exit(2) }
  const issues = validateRecipient({ email, sourceUrl, name })
  if (issues.length) throw new ValidationError(issues)
  m.to = { email: email!, ...(name ? { name } : {}), sourceUrl: sourceUrl!, readAt: new Date().toISOString() }
  const wasApproved = resetApproval(m)
  writeCollection('outreach', rows)
  appendHistory({ event: 'outreach:set-recipient', id: m.id, to: m.to.email, source: sourceUrl })
  console.log(m.id + ' → ' + m.to.email + ' (lu sur ' + sourceUrl + ').' + (wasApproved ? ' L\'approbation précédente est annulée.' : ''))
}

function outreachEdit(): void {
  const id = positional(0)
  const input = payload()
  // Lecture, vérification et écriture d'un seul tenant, sans attente entre les deux.
  const rows = readCollection<OutreachMessage>('outreach')
  const m = findOutreach(rows, id)
  if (m.status === 'SENT') { console.error(m.id + ' est déjà envoyé : il ne se modifie plus.'); process.exit(2) }
  const subject = input.subject === undefined ? m.subject : String(normalizeNewlines(String(input.subject)))
  const body = input.body === undefined ? m.body : String(normalizeNewlines(String(input.body)))
  assertValidOutreach({ companyName: m.companyName, subject, body, reason: m.reason, sourceUrl: m.sourceUrl, channel: m.channel })
  const lint = lintOutreachBody(body)
  // Comme outreach:add : les formules génériques sont un avertissement, --force passe outre.
  if (lint.length && !has('force')) {
    console.error('Message refusé :')
    for (const l of lint) console.error('  - ' + l)
    process.exit(2)
  }
  m.subject = subject
  m.body = body
  const wasApproved = resetApproval(m)
  writeCollection('outreach', rows)
  appendHistory({ event: 'outreach:edit', id: m.id })
  console.log(m.id + ' modifié, en DRAFT.' + (wasApproved ? ' L\'approbation précédente est annulée.' : '') + ' Relis-le : node src/cli.ts outreach:show ' + m.id)
}

async function outreachApprove(): Promise<void> {
  const id = positional(0)
  const config = readConfig<MailConfig>('mail')
  const displayed = findOutreach(readCollection<OutreachMessage>('outreach'), id)
  const issuesFor = (m: OutreachMessage) =>
    approvalIssues(m, readCollection<Opportunity>('opportunities').find((o) => o.id === m.opportunityId))
  const issues = issuesFor(displayed)
  if (issues.length) {
    console.error('Approbation refusée :')
    for (const i of issues) console.error('  - ' + i)
    process.exit(2)
  }
  const to = displayed.to!
  console.log([
    // Deuxième barrière après approvalIssues : rien d'affiché ne peut piloter le terminal.
    'De     : ' + escapeForDisplay(config.from.name + ' <' + config.from.email + '>'),
    'À      : ' + escapeForDisplay(to.name ? to.name + ' <' + to.email + '>' : to.email),
    'Adresse lue sur : ' + escapeForDisplay(to.sourceUrl),
    'Objet  : ' + escapeForDisplay(displayed.subject),
    '',
    escapeForDisplay(displayed.body, true),
    '',
  ].join('\n'))
  const shownHash = approvalHash(displayed)
  if (!(await confirmByTyping(displayed.id, 'Tape ' + displayed.id + ' pour approuver ce message tel quel : '))) {
    console.log('Non approuvé.')
    process.exit(2)
  }
  // La confirmation a pu prendre du temps : on relit la base et on n'approuve que ce qui a été affiché.
  const rows = readCollection<OutreachMessage>('outreach')
  const m = rows.find((r) => r.id === displayed.id)
  if (!m || m.status === 'SENT' || approvalHash(m) !== shownHash) {
    console.error('Le message a changé pendant la confirmation : rien n\'est approuvé.')
    process.exit(2)
  }
  const freshIssues = issuesFor(m)
  if (freshIssues.length) {
    console.error('Approbation refusée :')
    for (const i of freshIssues) console.error('  - ' + i)
    process.exit(2)
  }
  m.status = 'APPROVED'
  m.approvedAt = new Date().toISOString()
  m.approvedHash = approvalHash(m)
  writeCollection('outreach', rows)
  appendHistory({ event: 'outreach:approve', id: m.id, hash: m.approvedHash })
  console.log(m.id + ' approuvé. Pour l\'envoyer : node src/cli.ts outreach:send ' + m.id + ' (--dry-run pour voir d\'abord)')
}

async function outreachClearSending(): Promise<void> {
  const id = positional(0)
  const m = findOutreach(readCollection<OutreachMessage>('outreach'), id)
  const isOrphan = () => orphanSendings(readHistory() as HistoryEvent[]).includes(m.id)
  if (!isOrphan()) {
    console.log('Aucun envoi interrompu pour ' + m.id + '.')
    return
  }
  console.log('À ne confirmer qu\'après avoir vérifié ' + sentEvidence(readConfig<MailConfig>('mail')) + ' : ' + m.id + ' n\'est PAS parti.')
  if (!(await confirmByTyping(m.id, 'Tape ' + m.id + ' pour confirmer : '))) {
    console.log('Rien n\'a changé.')
    process.exit(2)
  }
  // Relu après la confirmation : un mark-sent a pu être enregistré entre-temps.
  if (!isOrphan()) {
    console.log('L\'envoi interrompu de ' + m.id + ' a été réglé pendant la confirmation : rien n\'a changé.')
    return
  }
  appendHistory({ event: 'outreach:clear-sending', id: m.id })
  console.log(m.id + ' peut de nouveau être envoyé.')
}

/**
 * Verrou exclusif pour toute la durée d'un envoi : deux `outreach:send`
 * simultanés liraient le même état et pourraient envoyer deux fois.
 * `.json` pour que `data/*.json` l'ignore dans git.
 */
function acquireSendLock(config: MailConfig): () => void {
  const path = join(DATA_DIR, 'send.lock.json')
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    let content = ''
    try { content = readFileSync(path, 'utf8').trim() } catch { /* supprimé entre-temps */ }
    let pid: number | undefined
    try { pid = Number(JSON.parse(content).pid) || undefined } catch { /* verrou illisible */ }
    let gone = false
    if (pid) {
      try { process.kill(pid, 0) } catch (e) { gone = (e as { code?: string }).code === 'ESRCH' }
    }
    // Refus dans les deux cas : un processus disparu a pu être coupé en plein envoi.
    console.error(gone
      ? 'Verrou d\'envoi présent (' + path + ', ' + content + ') mais le processus ' + pid + ' n\'existe plus. Vérifie ' + sentEvidence(config) + ', puis supprime ce fichier.'
      : 'Un envoi est déjà en cours (verrou ' + path + ', ' + content + '). S\'il n\'y en a pas, supprime ce fichier.')
    process.exit(2)
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n')
  } finally {
    closeSync(fd)
  }
  return () => {
    try { unlinkSync(path) } catch { /* déjà supprimé */ }
  }
}

async function outreachSend(): Promise<void> {
  const config = readConfig<MailConfig>('mail')
  const forceRecipient = has('force-recipient')
  const initial = readCollection<OutreachMessage>('outreach')
  const ids = has('all-approved')
    ? initial.filter((r) => r.status === 'APPROVED').map((r) => r.id)
    : [positional(0)].filter((id): id is string => !!id)
  if (!ids.length) {
    console.log(has('all-approved') ? 'Aucun message APPROVED en attente.' : 'Usage : outreach:send <id> | --all-approved [--dry-run] [--force-recipient]')
    return
  }

  if (!has('dry-run')) {
    // Avant le verrou et avant toute lecture de mot de passe.
    const unsafe = sendSafetyIssues(config)
    if (unsafe.length) {
      for (const u of unsafe) console.error(u)
      process.exit(2)
    }
  }
  const release = has('dry-run') ? () => undefined : acquireSendLock(config)
  try {
    // Premier tri, sous le verrou. Chaque message est revérifié juste avant son envoi.
    const rows = readCollection<OutreachMessage>('outreach')
    const opportunities = readCollection<Opportunity>('opportunities')
    const now = new Date()
    const events = readHistory() as HistoryEvent[]
    const ready: OutreachMessage[] = []
    // Le délai entre deux messages à la même adresse vaut aussi à l'intérieur d'un lot.
    const batchRecipients = new Set<string>()
    for (const id of ids) {
      const m = rows.find((r) => r.id === id)
      if (!m) { console.error('Message introuvable : ' + id); process.exitCode = 1; continue }
      const opportunity = opportunities.find((o) => o.id === m.opportunityId)
      const issues = sendIssues(m, { opportunity, events, outreach: rows, now, config, forceRecipient })
      const recipientKey = m.to?.email.trim().toLowerCase()
      if (recipientKey && batchRecipients.has(recipientKey) && !forceRecipient) {
        issues.push(m.to!.email + ' reçoit déjà un autre message de ce lot. --force-recipient pour passer outre.')
      }
      if (issues.length) {
        console.error(m.id + ' ne part pas :')
        for (const i of issues) console.error('  - ' + i)
        process.exitCode = 2
        continue
      }
      if (recipientKey) batchRecipients.add(recipientKey)
      ready.push(m)
    }

    const capMessage = (waiting: OutreachMessage[]) =>
      'Plafond de ' + config.dailyCap + ' envois par jour : ' + waiting.map((m) => m.id).join(', ') + ' attendront demain (toujours APPROVED).'
    const remaining = Math.max(0, config.dailyCap - sentCountOn(events, now.toISOString().slice(0, 10)))
    if (ready.length > remaining) {
      console.log(capMessage(ready.slice(remaining)))
      ready.splice(remaining)
    }
    if (!ready.length) return

    const build = (m: OutreachMessage) => buildMessage({ from: config.from, to: m.to!, subject: m.subject, body: m.body, date: new Date() })
    const recipients = (m: OutreachMessage) => [m.to!.email, ...(config.bccSelf ? [config.from.email] : [])]

    if (has('dry-run')) {
      for (const m of ready) {
        console.log('=== ' + m.id + ' — enveloppe : ' + recipients(m).join(', ') + ' — rien n\'est envoyé (--dry-run)')
        console.log(build(m).raw)
      }
      return
    }

    // Le chemin du fichier secret peut être remplacé (tests) ; le mot de passe, lui, n'est jamais dans l'environnement.
    // Variable vide = absente, comme dans sendSafetyIssues.
    const pass = readSmtpPassword(process.env.NBENY_SALES_SMTP_ENV || SECRET_PATH)
    const tls = config.smtp.tls ?? true
    const attempted = new Set<string>()

    const sendAll = async (host: string, port: number): Promise<void> => {
      for (const [index, planned] of ready.entries()) {
        attempted.add(planned.id)
        if (index > 0) {
          console.log('Pause de ' + config.minDelaySeconds + ' s avant le suivant…')
          await pause(config.minDelaySeconds * 1000)
        }
        // Tout est relu : un outreach:edit, un mark-sent ou le message précédent a pu changer la base pendant la pause.
        const freshRows = readCollection<OutreachMessage>('outreach')
        const freshEvents = readHistory() as HistoryEvent[]
        const freshNow = new Date()
        if (sentCountOn(freshEvents, freshNow.toISOString().slice(0, 10)) >= config.dailyCap) {
          console.log(capMessage(ready.slice(index)))
          break
        }
        const m = freshRows.find((r) => r.id === planned.id)
        if (!m) { console.error('Message introuvable : ' + planned.id); process.exitCode = 1; continue }
        const opportunity = readCollection<Opportunity>('opportunities').find((o) => o.id === m.opportunityId)
        const issues = sendIssues(m, { opportunity, events: freshEvents, outreach: freshRows, now: freshNow, config, forceRecipient })
        if (issues.length) {
          console.error(m.id + ' ne part pas :')
          for (const i of issues) console.error('  - ' + i)
          process.exitCode = 2
          continue
        }
        const to = m.to!
        let dataStarted = false
        try {
          // Dans le try : une erreur de construction est notée send-failed pour ce message.
          const mail = build(m)
          await sendMail({
            host,
            port,
            servername: config.smtp.servername,
            tls,
            user: config.from.email,
            pass,
            from: config.from.email,
            rcpt: recipients(m),
            raw: mail.raw,
            onBeforeData: () => {
              dataStarted = true
              appendHistory({ event: 'outreach:sending', id: m.id, to: to.email, messageId: mail.messageId })
            },
          })
          const saved = readCollection<OutreachMessage>('outreach')
          const row = saved.find((r) => r.id === m.id)!
          row.status = 'SENT'
          row.sentAt = new Date().toISOString()
          row.messageId = mail.messageId
          writeCollection('outreach', saved)
          appendHistory({ event: 'outreach:sent', id: m.id, to: to.email, messageId: mail.messageId })
          console.log('✅ ' + m.id + ' envoyé à ' + to.email + ' ' + mail.messageId)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          // Refus explicite du serveur, ou échec avant DATA : on sait que rien n'est parti.
          const certain = !dataStarted || (error instanceof SmtpError && error.code >= 400)
          appendHistory({ event: certain ? 'outreach:send-failed' : 'outreach:send-uncertain', id: m.id, error: reason })
          console.error('❌ ' + m.id + ' : ' + reason)
          if (!certain) console.error('   Coupure pendant la transmission : ' + m.id + ' reste bloqué jusqu\'à vérification de ' + sentEvidence(config) + '.')
          process.exitCode = 1
          // Seul le refus explicite de CE destinataire laisse la connexion au serveur saine pour les suivants.
          const recipientRefused = error instanceof SmtpError && error.code >= 400 && error.command === 'RCPT TO:<' + to.email + '>'
          if (!recipientRefused) {
            console.error('Lot arrêté.')
            break
          }
        }
      }
    }

    try {
      if (config.tunnel) {
        await withTunnel({ jumpHost: config.tunnel.jumpHost, target: config.smtp.host, targetPort: config.smtp.port }, (localPort) =>
          sendAll('127.0.0.1', localPort),
        )
      } else {
        await sendAll(config.smtp.host, config.smtp.port)
      }
    } catch (error) {
      // Tunnel qui ne s'ouvre pas (ou erreur hors d'un envoi) : les messages jamais tentés sont notés comme non partis.
      const reason = error instanceof Error ? error.message : String(error)
      for (const m of ready) {
        if (!attempted.has(m.id)) appendHistory({ event: 'outreach:send-failed', id: m.id, error: reason })
      }
      throw error
    }
  } finally {
    release()
  }
}

function followupAdd(): void {
  const input = payload()
  const rows = readCollection<Followup>('followups')
  const now = new Date().toISOString()
  const f: Followup = {
    id: nextId('followup', rows.map((r) => r.id)),
    opportunityId: input.opportunityId as string | undefined,
    outreachId: input.outreachId as string | undefined,
    company: String(input.company),
    contactLabel: String(input.contactLabel ?? 'contact non identifié'),
    status: (input.status as FollowupStatus) ?? 'NEW',
    lastTouchAt: (input.lastTouchAt as string) ?? now,
    nextActionAt: input.nextActionAt as string | undefined,
    recommendation: input.recommendation as string | undefined,
    history: [{ at: now, status: (input.status as FollowupStatus) ?? 'NEW' }],
  }
  rows.push(f)
  writeCollection('followups', rows)
  console.log(f.id + ' créé (' + f.status + ').')
}

function followupSet(): void {
  const id = positional(0)
  const status = positional(1)?.toUpperCase() as FollowupStatus | undefined
  const rows = readCollection<Followup>('followups')
  const f = rows.find((r) => r.id === id)
  if (!f || !status) { console.error('Usage : followup:set <id> <STATUS> [--note "..."]'); process.exit(1); return }
  f.status = status
  f.lastTouchAt = new Date().toISOString()
  f.history.push({ at: f.lastTouchAt, status, note: flag('note') })
  writeCollection('followups', rows)
  console.log(f.id + ' : ' + status)
}

function followupList(): void {
  const rows = readCollection<Followup>('followups')
  if (!rows.length) { console.log('Aucun suivi.'); return }
  for (const f of rows) console.log([f.id, f.status.padEnd(12), f.company, '—', f.contactLabel, f.nextActionAt ? '· relance ' + f.nextActionAt.slice(0, 10) : ''].join('  '))
}

function genericAdd(collection: string, kind: Parameters<typeof nextId>[0], label: string): void {
  const input = payload()
  const rows = readCollection<Record<string, unknown>>(collection)
  const row = { id: nextId(kind, rows.map((r) => String(r.id))), createdAt: new Date().toISOString(), ...input }
  rows.push(row)
  writeCollection(collection, rows)
  console.log(row.id + ' ajouté à ' + collection + '.json (' + label + ')')
}

/** Le rapport ne doit pas tomber faute de config/mail.json : le texte générique de report.ts prend alors le relais. */
function reportEvidence(): string | undefined {
  try {
    return sentEvidence(readConfig<MailConfig>('mail'))
  } catch {
    return undefined
  }
}

function reportDaily(): void {
  const date = new Date().toISOString()
  const markdown = buildDailyReport({
    date,
    opportunities: readCollection('opportunities'),
    outreach: readCollection('outreach'),
    followups: readCollection('followups'),
    companies: readCollection('companies'),
    market: readCollection('market'),
    windowDays: Number(flag('days') ?? 1),
    interruptedSends: orphanSendings(readHistory() as HistoryEvent[]),
    sentEvidence: reportEvidence(),
  })
  const day = date.slice(0, 10)
  writeText(join(REPORTS_DIR, day + '.md'), markdown)
  writeText(join(REPORTS_DIR, 'daily-report.md'), markdown)
  appendHistory({ event: 'report:daily', day })
  console.log('Rapport écrit : data/reports/daily-report.md et data/reports/' + day + '.md')
}

function profileSetMarket(): void {
  const key = positional(0)
  if (!key) { console.error('Usage : profile:set-market <marché> --floor <n> --target <n> --source <url>'); process.exit(1); return }
  const path = join(DATA_DIR, 'profile.json')
  const profile = loadProfile()
  const source = flag('source')
  const decision = flag('decision')
  if (!source && !decision) {
    console.error('Il faut dire d\'où vient le chiffre :')
    console.error('  --decision "<texte>"  pour un plancher, qui est un arbitrage de Nicolas')
    console.error('  --source <url>        pour une cible, qui doit venir d\'une annonce réelle')
    process.exit(2)
  }
  if (flag('target') && !source) {
    console.error('`--target` exige `--source <url>` : une cible sans annonce à l\'appui est une estimation, pas un fait.')
    process.exit(2)
  }
  const market = profile.compensation.markets[key]
  if (!market) { console.error('Marché inconnu : ' + key + '. Connus : ' + Object.keys(profile.compensation.markets).join(', ')); process.exit(1); return }
  if (flag('floor')) {
    market.floor = Number(flag('floor'))
    market.floorOrigin = decision ?? 'source : ' + source
  }
  if (flag('target')) market.target = Number(flag('target'))
  if (flag('currency')) market.currency = String(flag('currency'))
  if (flag('unit')) market.unit = flag('unit') as 'day' | 'year'
  market.status = market.floor !== null ? 'known' : 'unknown'
  if (source) market.sources = [...new Set([...market.sources, source])]
  writeJson(path, profile)
  console.log(key + ' : plancher ' + market.floor + ', cible ' + (market.target ?? 'non renseignée') + ' ' + market.currency + '/' + market.unit)
  if (market.target === null) {
    console.log('Sans cible, toute offre au-dessus du plancher scorera pareil. La cible se pose à partir d\'annonces réelles.')
  }
  console.log('Relance `node src/cli.ts match:all` pour rescorer avec cette référence.')
}

function stats(): void {
  const opps = readCollection<Opportunity>('opportunities')
  const by = (p: string) => opps.filter((o) => o.match?.priority === p).length
  console.log('Opportunités : ' + opps.length + '  (HIGH ' + by('HIGH') + ' · MEDIUM ' + by('MEDIUM') + ' · LOW ' + by('LOW') + ')')
  console.log('Entreprises  : ' + readCollection('companies').length)
  console.log('Leads        : ' + readCollection('leads').length)
  const messages = readCollection<OutreachMessage>('outreach')
  const count = (status: OutreachMessage['status']) => messages.filter((m) => m.status === status).length
  const noRecipient = messages.filter((m) => m.status === 'DRAFT' && !m.to).length
  const interrupted = orphanSendings(readHistory() as HistoryEvent[]).length
  console.log('Messages     : DRAFT ' + count('DRAFT') + ' · APPROVED ' + count('APPROVED') + ' · SENT ' + count('SENT') +
    '  (' + noRecipient + ' sans destinataire, ' + interrupted + ' envoi' + (interrupted > 1 ? 's' : '') + ' interrompu' + (interrupted > 1 ? 's' : '') + ')')
  console.log('Suivis       : ' + readCollection('followups').length)
}

const RUN_BADGE: Record<RunStatus, string> = { OK: '✅ OK         ', FAILED: '❌ ÉCHEC      ', RUNNING: '⏳ EN COURS   ', INTERRUPTED: '⚠️  INTERROMPU' }
const SCHEDULED_TASK = 'nbeny-sales-daily'

/**
 * Historique des lancements planifiés, du plus récent au plus ancien, suivi de
 * l'état de la tâche Windows. Un jour ouvré sans ligne ici = l'agent n'a pas tourné.
 */
function runs(): void {
  const file = join(ROOT, 'logs', 'cron-runs.log')
  const all = existsSync(file) ? parseRuns(readFileSync(file, 'utf8')) : []
  const limit = Number(flag('limit') ?? 20)

  if (!all.length) console.log('Aucun lancement enregistré (' + file + ').')
  for (const r of all.reverse().slice(0, limit)) {
    const when = r.start.toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    const took = r.end ? formatDuration(r.end.getTime() - r.start.getTime()) : '—'
    const exit = r.exitCode !== undefined && r.exitCode !== 0 ? '  exit=' + r.exitCode : ''
    console.log([when.padEnd(18), RUN_BADGE[r.status], took.padStart(9), '  ' + r.command + exit, r.log ? '  logs/' + r.log : ''].join('  '))
  }
  if (all.length > limit) console.log('… ' + (all.length - limit) + ' lancements plus anciens (--limit N)')

  if (process.platform !== 'win32') return
  try {
    const info = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      "$t = Get-ScheduledTask -TaskName '" + SCHEDULED_TASK + "' -ErrorAction Stop; $i = $t | Get-ScheduledTaskInfo; " +
      "'{0}|{1}|{2}' -f $t.State, $i.NextRunTime.ToString('ddd dd/MM HH:mm'), $i.LastTaskResult",
    ], { encoding: 'utf8' }).trim()
    const [state, next, last] = info.split('|')
    const lastLabel = last === '0' ? 'OK' : last === '267011' ? 'jamais lancée' : last === '267009' ? 'en cours' : 'code ' + last
    console.log('\nTâche Windows ' + SCHEDULED_TASK + ' : ' + state + ' · prochain lancement ' + next + ' · dernier résultat ' + lastLabel)
  } catch {
    console.log('\nTâche Windows ' + SCHEDULED_TASK + ' introuvable : aucun lancement automatique n\'est programmé.')
  }
}

function help(): void {
  console.log(`nbeny-sales — base de la prospection

Opportunités
  opportunity:add --file <json>       Ajoute après validation + déduplication + scoring
  opportunity:import --file <json>    Import en lot (tableau JSON), une entrée refusée n'arrête pas les autres
  opportunity:list [filtres] [--details]
      --min-score N      score minimum sur 100
      --min-coverage N   dimensions connues minimum sur 8
      --priority HIGH    HIGH | MEDIUM | LOW
      --contract X       freelance | cdi
      --remote X         full | hybrid | onsite | unspecified (plusieurs : hybrid,onsite)
      --sort X           score (défaut) | remote (full d'abord) | date | company | location
      --search X         texte cherché dans entreprise, intitulé, lieu, stack
      --location X       filtre sur le lieu, ex. lille
      --stage X          étape du pipeline
      --limit N          50 par défaut
      --details, --v     fiche complète au lieu d'une ligne
  opportunity:show <id> [--pretty]    JSON, ou fiche lisible avec --pretty
  opportunity:enrich <id> --file <json>   Ajoute des faits lus sur la source, re-score
                                      (--overwrite pour corriger un fait déjà posé)
  opportunity:stage <id> <STAGE> [--note "..."]
  match:all [<id>]                    Re-score tout (ou une seule opportunité)

Prospection
  company:add --file <json>
  lead:add --file <json>
  market:add --file <json>

Messages (rien ne part sans l'approbation de Nicolas)
  outreach:add --file <json>          Crée un brouillon
  outreach:edit <id> --file <json> [--force]
                                      Corrige subject/body (annule l'approbation)
  outreach:set-recipient <id> --email <adresse> --source <url> [--name "..."]
  outreach:list
  outreach:show <id>
  outreach:approve <id>               Nicolas seul, au clavier
  outreach:send <id> | --all-approved [--dry-run] [--force-recipient]
  outreach:clear-sending <id>         Débloque un envoi interrompu (au clavier)
  outreach:mark-sent <id>             Enregistre un envoi fait à la main

Suivi
  followup:add --file <json>
  followup:list
  followup:set <id> <STATUS> [--note "..."]

Profil et rapports
  profile:set-market <marché> --floor <n> --target <n> --source <url>
  report:daily [--days N]
  stats
  runs [--limit N]                    Quand l'agent planifié a tourné, et son prochain lancement

Application interactive
  shell                               Menus au clavier (aussi : node src/cli.ts sans argument, ou sales.cmd)

Le JSON peut aussi arriver sur stdin, ou via --json '<...>'.`)
}

const COMMANDS: Record<string, () => void | Promise<void>> = {
  'opportunity:add': opportunityAdd,
  'opportunity:import': opportunityImport,
  'opportunity:list': opportunityList,
  'opportunity:show': opportunityShow,
  'opportunity:enrich': opportunityEnrich,
  'opportunity:stage': opportunityStage,
  'match:all': matchAll,
  'match:one': matchAll,
  'company:add': () => genericAdd('companies', 'company', 'entreprise'),
  'lead:add': () => genericAdd('leads', 'lead', 'lead'),
  'contact:add': () => genericAdd('contacts', 'contact', 'contact'),
  'market:add': () => genericAdd('market', 'market', 'signal de marché'),
  'outreach:add': outreachAdd,
  'outreach:list': outreachList,
  'outreach:show': outreachShow,
  'outreach:mark-sent': outreachMarkSent,
  'outreach:edit': outreachEdit,
  'outreach:set-recipient': outreachSetRecipient,
  'outreach:approve': outreachApprove,
  'outreach:send': outreachSend,
  'outreach:clear-sending': outreachClearSending,
  'followup:add': followupAdd,
  'followup:list': followupList,
  'followup:set': followupSet,
  'profile:set-market': profileSetMarket,
  'report:daily': reportDaily,
  stats,
  runs,
  help,
  shell: async () => { await (await import('./shell.ts')).runShell() },
}

try {
  const run = COMMANDS[command]
  if (!run) {
    console.error('Commande inconnue : ' + command + '\n')
    help()
    process.exit(1)
  }
  await run()
} catch (error) {
  if (error instanceof ValidationError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
