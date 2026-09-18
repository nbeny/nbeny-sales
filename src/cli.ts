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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendHistory,
  readCollection,
  writeCollection,
  readConfig,
  readJson,
  writeJson,
  writeText,
  DATA_DIR,
  REPORTS_DIR,
} from './lib/store.ts'
import { nextId } from './lib/ids.ts'
import { fingerprint, findDuplicate, type DedupRow } from './lib/dedup.ts'
import { transition, canTransition } from './lib/pipeline.ts'
import { computeMatch, type KeywordsConfig, type LocationsConfig, type ScoringConfig, type ScoringContext } from './lib/scoring.ts'
import { assertValidOpportunity, assertValidOutreach, lintOutreachBody, validateOpportunityInput, ValidationError } from './lib/validate.ts'
import { buildDailyReport } from './lib/report.ts'
import type { Followup, FollowupStatus, Opportunity, OutreachMessage, Profile, StageName } from './lib/types.ts'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'

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

const FLAGS_WITH_VALUE = ['file', 'json', 'days', 'priority', 'stage', 'contract', 'note', 'floor', 'target', 'source', 'currency', 'unit', 'limit']
function isFlagValue(token: string): boolean {
  const i = args.indexOf(token)
  return i > 0 && args[i - 1].startsWith('--') && FLAGS_WITH_VALUE.includes(args[i - 1].slice(2))
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
  const priority = flag('priority')
  const stage = flag('stage')
  const contract = flag('contract')
  const limit = Number(flag('limit') ?? 50)

  const filtered = rows
    .filter((o) => !priority || o.match?.priority === priority.toUpperCase())
    .filter((o) => !stage || o.stage === stage.toUpperCase())
    .filter((o) => !contract || ['both', contract].includes(o.facts.contract?.value ?? ''))
    .sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1))
    .slice(0, limit)

  if (!filtered.length) {
    console.log('Aucune opportunité ne correspond à ce filtre.')
    return
  }
  for (const o of filtered) {
    const m = o.match
    console.log(
      [o.id, m ? m.priority.padEnd(6) : 'NONE  ', m ? String(m.score).padStart(3) + '/100 (' + m.coverage + '/8)' : '  -', o.stage.padEnd(14), o.company + ' — ' + o.title].join('  '),
    )
  }
}

function opportunityShow(): void {
  const id = positional(0)
  const opp = readCollection<Opportunity>('opportunities').find((o) => o.id === id)
  if (!opp) { console.error('Opportunité introuvable : ' + id); process.exit(1) }
  console.log(JSON.stringify(opp, null, 2))
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

function outreachAdd(): void {
  const input = payload()
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
  console.log('# ' + m.id + ' — ' + m.companyName + ' (' + m.channel + ' / ' + m.audience + ') — ' + m.status)
  console.log('Source : ' + m.sourceUrl)
  console.log('Pourquoi : ' + m.reason)
  console.log('\nObjet : ' + m.subject + '\n')
  console.log(m.body)
}

function outreachList(): void {
  const rows = readCollection<OutreachMessage>('outreach')
  if (!rows.length) { console.log('Aucun message.'); return }
  for (const m of rows) console.log([m.id, m.status.padEnd(8), m.channel.padEnd(9), m.companyName, '—', m.subject].join('  '))
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
  console.log(id + ' marqué comme envoyé. (Cette commande ne fait qu\'enregistrer : l\'envoi reste manuel.)')
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
  console.log('Messages     : ' + readCollection<OutreachMessage>('outreach').filter((m) => m.status === 'DRAFT').length + ' en brouillon')
  console.log('Suivis       : ' + readCollection('followups').length)
}

function help(): void {
  console.log(`nbeny-sales — base de la prospection

Opportunités
  opportunity:add --file <json>       Ajoute après validation + déduplication + scoring
  opportunity:import --file <json>    Import en lot (tableau JSON), une entrée refusée n'arrête pas les autres
  opportunity:list [--priority HIGH] [--stage X] [--contract freelance] [--limit N]
  opportunity:show <id>
  opportunity:stage <id> <STAGE> [--note "..."]
  match:all [<id>]                    Re-score tout (ou une seule opportunité)

Prospection
  company:add --file <json>
  lead:add --file <json>
  market:add --file <json>

Messages (jamais envoyés automatiquement)
  outreach:add --file <json>          Crée un brouillon
  outreach:list
  outreach:show <id>
  outreach:mark-sent <id>             Enregistre un envoi fait à la main

Suivi
  followup:add --file <json>
  followup:list
  followup:set <id> <STATUS> [--note "..."]

Profil et rapports
  profile:set-market <marché> --floor <n> --target <n> --source <url>
  report:daily [--days N]
  stats

Le JSON peut aussi arriver sur stdin, ou via --json '<...>'.`)
}

const COMMANDS: Record<string, () => void> = {
  'opportunity:add': opportunityAdd,
  'opportunity:import': opportunityImport,
  'opportunity:list': opportunityList,
  'opportunity:show': opportunityShow,
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
  'followup:add': followupAdd,
  'followup:list': followupList,
  'followup:set': followupSet,
  'profile:set-market': profileSetMarket,
  'report:daily': reportDaily,
  stats,
  help,
}

try {
  const run = COMMANDS[command]
  if (!run) {
    console.error('Commande inconnue : ' + command + '\n')
    help()
    process.exit(1)
  }
  run()
} catch (error) {
  if (error instanceof ValidationError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
