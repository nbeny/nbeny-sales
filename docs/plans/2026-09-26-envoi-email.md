# Envoi des emails approuvés — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** permettre à Nicolas d'approuver un brouillon puis de l'envoyer depuis `nicolas@urbanlink.fr` par `node src/cli.ts outreach:send`, sans qu'aucun agent puisse approuver.

**Architecture:** les règles (approbation, garde-fous d'envoi) sont des fonctions pures dans `src/lib/outreach.ts`, testées sans réseau. La construction du message (`mime.ts`), le protocole (`smtp.ts`) et le tunnel SSH (`tunnel.ts`) sont trois modules isolés. `src/cli.ts` ne fait qu'assembler et écrire dans `data/`. Côté infra, le rôle `mailcow` gagne deux champs optionnels par boîte : `password_env` et `ratelimit`.

**Tech Stack:** Node 24 (TypeScript exécuté nativement, **type stripping** : pas d'`enum`, pas de propriétés de paramètre `constructor(public x)`), `node:test`, `node:tls`, `node:net`, `ssh` (OpenSSH Windows). Ansible + API REST Mailcow.

**Spec :** `docs/specs/2026-09-26-envoi-email-design.md`

**Deux dépôts :**
- `C:\Users\nbeny\Documents\GitHub\nbeny-sales` — tâches 1 à 8.
- `C:\Users\nbeny\Documents\GitHub\infra` — tâche 9.
- Tâche 10 : mise en service, faite par Nicolas.

**Attention, arbre de travail non propre :** `nbeny-sales` a des modifications en cours sans rapport (`.gitignore`, `CLAUDE.md`, `src/cli.ts`, `scripts/`, `src/lib/runs.ts`, `test/runs.test.ts`). Chaque commit de ce plan ne liste **que** ses fichiers (`git add <fichiers>` puis `git commit -- <fichiers>` quand un fichier modifié l'était déjà). Pour `src/cli.ts` et `CLAUDE.md`, déjà modifiés, utiliser `git add -p` et ne prendre que les hunks de la tâche.

---

## Carte des fichiers

| Fichier | Rôle |
|---|---|
| `src/lib/types.ts` (modifié) | `OutreachMessage` gagne `to`, `approvedAt`, `approvedHash`, `messageId` |
| `src/lib/validate.ts` (modifié) | `findPlaceholders`, `validateRecipient`, message de statut mis à jour |
| `src/lib/store.ts` (modifié) | `readHistory()` : relit `data/history/*.jsonl` |
| `src/lib/mail-config.ts` (nouveau) | type `MailConfig`, lecture du secret `smtp.env` |
| `src/lib/outreach.ts` (nouveau) | règles pures : empreinte, approbation, garde-fous d'envoi, envois orphelins, plafond |
| `src/lib/mime.ts` (nouveau) | construction du message RFC 5322 |
| `src/lib/smtp.ts` (nouveau) | client SMTP minimal |
| `src/lib/tunnel.ts` (nouveau) | tunnel `ssh -L` le temps d'un envoi |
| `config/mail.json` (nouveau) | paramètres d'envoi, sans secret |
| `src/cli.ts` (modifié) | commandes `set-recipient`, `edit`, `approve`, `clear-sending`, `send` |
| `test/outreach.test.ts`, `test/mime.test.ts`, `test/smtp.test.ts`, `test/mail-config.test.ts` (nouveaux) | tests |
| `.claude/settings.json`, `CLAUDE.md`, `.claude/agents/outreach-agent.md`, `.claude/agents/ceo-agent.md`, `.claude/commands/sales.md` | règles et documentation |
| `infra/ansible/roles/mailcow/defaults/main.yml`, `infra/ansible/roles/mailcow/tasks/accounts.yml` | boîte dédiée, mot de passe propre, limite d'envoi |

---

### Task 1 : modèle, validation et lecture de l'historique

**Files:**
- Modify: `src/lib/types.ts` (interface `OutreachMessage`, vers la ligne 165)
- Modify: `src/lib/validate.ts` (après `lintOutreachBody`, et message de statut dans `validateOutreachInput`)
- Modify: `src/lib/store.ts` (import `node:fs` et nouvelle fonction en fin de fichier)
- Test: `test/outreach.test.ts` (nouveau, premières suites)

- [ ] **Step 1 : écrire les tests qui échouent**

Créer `test/outreach.test.ts` :

```ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { findPlaceholders, validateRecipient } from '../src/lib/validate.ts'

describe('findPlaceholders', () => {
  test('trouve les marqueurs laissés par outreach-agent', () => {
    assert.deepEqual(
      findPlaceholders('Mon TJM : [TJM à confirmer par Nicolas].\nDispo [date].'),
      ['[TJM à confirmer par Nicolas]', '[date]'],
    )
  })

  test('texte sans crochets : rien', () => {
    assert.deepEqual(findPlaceholders('Bonjour,\n\nNicolas BENY\nhttps://nbeny.fr'), [])
  })
})

describe('validateRecipient', () => {
  test('adresse lue avec sa source : accepté', () => {
    assert.deepEqual(validateRecipient({ email: 'rh@acme.example', sourceUrl: 'https://acme.example/contact' }), [])
  })

  test('sans source : refusé', () => {
    const issues = validateRecipient({ email: 'rh@acme.example' })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /--source/)
  })

  test('adresse mal formée : refusé', () => {
    const issues = validateRecipient({ email: 'rh@acme', sourceUrl: 'https://acme.example/contact' })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /--email/)
  })
})
```

- [ ] **Step 2 : vérifier l'échec**

Run: `node --test test/outreach.test.ts`
Expected: FAIL — `findPlaceholders` / `validateRecipient` ne sont pas exportés (`SyntaxError: The requested module ... does not provide an export named 'findPlaceholders'`).

- [ ] **Step 3 : étendre le modèle**

Dans `src/lib/types.ts`, remplacer l'interface `OutreachMessage` par :

```ts
export interface OutreachMessage {
  id: string
  opportunityId?: string
  companyName: string
  channel: 'email' | 'linkedin' | 'form' | 'other'
  audience: 'recruiter' | 'cto' | 'hr' | 'founder' | 'esn' | 'client'
  subject: string
  body: string
  /** Pourquoi cette cible, avec la preuve qui le justifie. */
  reason: string
  sourceUrl: string
  status: OutreachStatus
  createdAt: string
  sentAt?: string
  language: 'fr' | 'en'
  /** Destinataire lu sur une page publique : jamais une adresse reconstituée. */
  to?: { email: string; name?: string; sourceUrl: string; readAt: string }
  approvedAt?: string
  /** Empreinte de to + subject + body au moment où Nicolas a approuvé. */
  approvedHash?: string
  /** Message-ID de l'email réellement envoyé par outreach:send. */
  messageId?: string
}
```

- [ ] **Step 4 : ajouter la validation**

Dans `src/lib/validate.ts`, juste après la fonction `lintOutreachBody`, ajouter :

```ts
/**
 * Marqueurs laissés dans un brouillon pour que Nicolas les complète
 * (`[TJM à confirmer par Nicolas]`). Un message qui en contient ne s'approuve pas.
 */
export function findPlaceholders(text: string): string[] {
  return text.match(/\[[^\]\n]{1,160}\]/g) ?? []
}

const EMAIL = /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i

export function validateRecipient(input: { email?: string; sourceUrl?: string }): string[] {
  const issues: string[] = []
  if (!input.email || !EMAIL.test(input.email.trim())) {
    issues.push('`--email` doit être une adresse email complète.')
  }
  if (!isHttpUrl(input.sourceUrl)) {
    issues.push('`--source` doit être l\'URL publique où cette adresse a été lue. Une adresse reconstituée (prenom.nom@…) n\'est pas une adresse lue.')
  }
  return issues
}
```

Dans `validateOutreachInput`, remplacer la ligne :

```ts
    issues.push('Un message est toujours créé en `DRAFT`. Seul `outreach:mark-sent`, lancé par un humain, peut le faire passer à `SENT`.')
```

par :

```ts
    issues.push('Un message est toujours créé en `DRAFT`. Seul Nicolas le fait avancer : `outreach:approve` puis `outreach:send`, ou `outreach:mark-sent` pour un envoi fait à la main.')
```

- [ ] **Step 5 : ajouter `readHistory`**

Dans `src/lib/store.ts`, remplacer la ligne d'import `node:fs` par :

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync, readdirSync } from 'node:fs'
```

et ajouter en fin de fichier :

```ts
/** Relit tout le journal, dans l'ordre chronologique. Une ligne illisible est ignorée. */
export function readHistory(): Record<string, unknown>[] {
  const dir = join(DATA_DIR, 'history')
  if (!existsSync(dir)) return []
  const events: Record<string, unknown>[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // Ligne tronquée par une interruption : elle ne doit pas bloquer la lecture du reste.
      }
    }
  }
  return events
}
```

- [ ] **Step 6 : vérifier**

Run: `node --test test/outreach.test.ts`
Expected: PASS, 5 tests.

Run: `node --test "test/*.test.ts"`
Expected: PASS, aucun test existant cassé.

- [ ] **Step 7 : commit**

```bash
git add src/lib/types.ts src/lib/validate.ts src/lib/store.ts test/outreach.test.ts
git commit -m "feat(outreach): destinataire sourcé, marqueurs à compléter et relecture du journal" -- src/lib/types.ts src/lib/validate.ts src/lib/store.ts test/outreach.test.ts
```

---

### Task 2 : configuration d'envoi et secret

**Files:**
- Create: `src/lib/mail-config.ts`
- Create: `config/mail.json`
- Test: `test/mail-config.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

Créer `test/mail-config.test.ts` :

```ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseEnv, readSmtpPassword } from '../src/lib/mail-config.ts'

describe('parseEnv', () => {
  test('ignore commentaires et lignes vides, garde les = dans la valeur, retire les guillemets', () => {
    assert.deepEqual(
      parseEnv('# secret\n\nSMTP_PASSWORD=abc=def\r\nAUTRE="x y"\n'),
      { SMTP_PASSWORD: 'abc=def', AUTRE: 'x y' },
    )
  })
})

describe('readSmtpPassword', () => {
  test('fichier absent : erreur qui dit quoi créer', () => {
    assert.throws(() => readSmtpPassword(join(tmpdir(), 'inexistant-nbeny', 'smtp.env')), /SMTP_PASSWORD=/)
  })

  test('lit SMTP_PASSWORD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbeny-sales-'))
    const path = join(dir, 'smtp.env')
    writeFileSync(path, 'SMTP_PASSWORD=s3cret\n')
    assert.equal(readSmtpPassword(path), 's3cret')
  })

  test('clé absente : erreur', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbeny-sales-'))
    const path = join(dir, 'smtp.env')
    writeFileSync(path, 'AUTRE=1\n')
    assert.throws(() => readSmtpPassword(path), /SMTP_PASSWORD manque/)
  })
})
```

- [ ] **Step 2 : vérifier l'échec**

Run: `node --test test/mail-config.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/mail-config.ts'`.

- [ ] **Step 3 : implémenter**

Créer `src/lib/mail-config.ts` :

```ts
/**
 * Paramètres d'envoi (versionnés, dans config/mail.json) et secret SMTP (hors
 * du dépôt). Le mot de passe n'est jamais une variable d'environnement : il
 * fuirait dans les journaux de la tâche planifiée.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface MailConfig {
  from: { email: string; name: string }
  /** Copie cachée à l'expéditeur : la trace de l'envoi dans Mailcow. */
  bccSelf: boolean
  smtp: { host: string; port: number; servername: string }
  tunnel: { jumpHost: string }
  dailyCap: number
  minDelaySeconds: number
  recipientCooldownDays: number
}

export const SECRET_PATH = join(homedir(), '.nbeny-sales', 'smtp.env')

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    values[line.slice(0, eq).trim()] = value
  }
  return values
}

export function readSmtpPassword(path: string = SECRET_PATH): string {
  if (!existsSync(path)) {
    throw new Error('Mot de passe SMTP absent. Crée ' + path + ' avec une ligne SMTP_PASSWORD=<mot de passe de la boîte d\'envoi>. Ce fichier reste hors du dépôt.')
  }
  const pass = parseEnv(readFileSync(path, 'utf8')).SMTP_PASSWORD
  if (!pass) throw new Error('SMTP_PASSWORD manque dans ' + path + '.')
  return pass
}
```

Créer `config/mail.json` :

```json
{
  "from": { "email": "nicolas@urbanlink.fr", "name": "Nicolas BENY" },
  "bccSelf": true,
  "smtp": { "host": "10.0.0.140", "port": 465, "servername": "mail.urbanlink.fr" },
  "tunnel": { "jumpHost": "pve" },
  "dailyCap": 10,
  "minDelaySeconds": 90,
  "recipientCooldownDays": 30
}
```

- [ ] **Step 4 : vérifier**

Run: `node --test test/mail-config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5 : commit**

```bash
git add src/lib/mail-config.ts config/mail.json test/mail-config.test.ts
git commit -m "feat(mail): configuration d'envoi et lecture du secret SMTP hors dépôt"
```

---

### Task 3 : règles d'approbation et d'envoi

**Files:**
- Create: `src/lib/outreach.ts`
- Test: `test/outreach.test.ts` (ajout de suites)

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter en tête de `test/outreach.test.ts`, sous les imports existants :

```ts
import { approvalHash, approvalIssues, sendIssues, orphanSendings, sentCountOn, type HistoryEvent, type SendContext } from '../src/lib/outreach.ts'
import type { MailConfig } from '../src/lib/mail-config.ts'
import type { Opportunity, OutreachMessage } from '../src/lib/types.ts'

const CONFIG: MailConfig = {
  from: { email: 'nicolas@urbanlink.fr', name: 'Nicolas BENY' },
  bccSelf: true,
  smtp: { host: '10.0.0.140', port: 465, servername: 'mail.urbanlink.fr' },
  tunnel: { jumpHost: 'pve' },
  dailyCap: 10,
  minDelaySeconds: 90,
  recipientCooldownDays: 30,
}
const NOW = new Date('2026-09-28T10:00:00Z')

function draft(over: Partial<OutreachMessage> = {}): OutreachMessage {
  return {
    id: 'MSG-2026-0001',
    opportunityId: 'OPP-2026-0001',
    companyName: 'Acme',
    channel: 'email',
    audience: 'hr',
    subject: 'Votre annonce Node.js',
    body: 'Bonjour, un message assez long pour passer la validation du brouillon.',
    reason: 'Annonce du 20/09.',
    sourceUrl: 'https://acme.example/job',
    status: 'DRAFT',
    createdAt: '2026-09-20T00:00:00Z',
    language: 'fr',
    to: { email: 'rh@acme.example', sourceUrl: 'https://acme.example/contact', readAt: '2026-09-27T00:00:00Z' },
    ...over,
  }
}

function approved(over: Partial<OutreachMessage> = {}): OutreachMessage {
  const m = draft({ status: 'APPROVED', approvedAt: '2026-09-27T12:00:00Z', ...over })
  m.approvedHash = approvalHash(m)
  return m
}

const opportunity = (stage: string) => ({ id: 'OPP-2026-0001', stage }) as unknown as Opportunity

function ctx(over: Partial<SendContext> = {}): SendContext {
  return { opportunity: opportunity('OUTREACH_READY'), events: [], outreach: [], now: NOW, config: CONFIG, forceRecipient: false, ...over }
}

const ev = (event: string, id = 'MSG-2026-0001', at = '2026-09-28T09:00:00Z'): HistoryEvent => ({ at, event, id })
```

Puis ajouter en fin de fichier :

```ts
describe('approvalIssues', () => {
  test('brouillon complet : approuvable', () => {
    assert.deepEqual(approvalIssues(draft(), opportunity('OUTREACH_READY')), [])
  })

  test('sans destinataire : refusé', () => {
    assert.ok(approvalIssues(draft({ to: undefined })).some((i) => i.includes('outreach:set-recipient')))
  })

  test('marqueur restant : refusé', () => {
    const issues = approvalIssues(draft({ body: 'Bonjour, mon TJM est de [TJM à confirmer par Nicolas] par jour, merci.' }))
    assert.ok(issues.some((i) => i.includes('[TJM à confirmer par Nicolas]')))
  })

  test('opportunité LOST : refusé', () => {
    assert.ok(approvalIssues(draft(), opportunity('LOST')).some((i) => i.includes('LOST')))
  })

  test('canal LinkedIn : refusé', () => {
    assert.ok(approvalIssues(draft({ channel: 'linkedin' })).some((i) => i.includes('linkedin')))
  })

  test('déjà envoyé : refusé', () => {
    assert.ok(approvalIssues(draft({ status: 'SENT' })).some((i) => i.includes('déjà envoyé')))
  })
})

describe('sendIssues', () => {
  test('approuvé et intact : part', () => {
    assert.deepEqual(sendIssues(approved(), ctx()), [])
  })

  test('DRAFT : refusé', () => {
    assert.ok(sendIssues(draft(), ctx()).some((i) => i.includes('seul un message APPROVED')))
  })

  test('SENT : refusé', () => {
    assert.ok(sendIssues(approved({ status: 'SENT' }), ctx()).some((i) => i.includes('seul un message APPROVED')))
  })

  test('corps modifié après approbation : refusé', () => {
    const m = approved()
    m.body = m.body + ' Ajout après coup.'
    assert.ok(sendIssues(m, ctx()).some((i) => i.includes('changé depuis son approbation')))
  })

  test('destinataire modifié après approbation : refusé', () => {
    const m = approved()
    m.to = { ...m.to!, email: 'autre@acme.example' }
    assert.ok(sendIssues(m, ctx()).some((i) => i.includes('changé depuis son approbation')))
  })

  test('opportunité LOST : refusé', () => {
    assert.ok(sendIssues(approved(), ctx({ opportunity: opportunity('LOST') })).some((i) => i.includes('LOST')))
  })

  test('envoi interrompu : bloqué', () => {
    assert.ok(sendIssues(approved(), ctx({ events: [ev('outreach:sending')] })).some((i) => i.includes('interrompu')))
  })

  test('même adresse contactée il y a 10 jours : refusé, sauf --force-recipient', () => {
    const previous = draft({ id: 'MSG-2026-0002', status: 'SENT', sentAt: '2026-09-18T10:00:00Z' })
    assert.ok(sendIssues(approved(), ctx({ outreach: [previous] })).some((i) => i.includes('a déjà reçu MSG-2026-0002')))
    assert.deepEqual(sendIssues(approved(), ctx({ outreach: [previous], forceRecipient: true })), [])
  })

  test('même adresse contactée il y a 40 jours : part', () => {
    const previous = draft({ id: 'MSG-2026-0002', status: 'SENT', sentAt: '2026-08-19T10:00:00Z' })
    assert.deepEqual(sendIssues(approved(), ctx({ outreach: [previous] })), [])
  })
})

describe('orphanSendings', () => {
  test('sending puis sent : rien', () => {
    assert.deepEqual(orphanSendings([ev('outreach:sending'), ev('outreach:sent')]), [])
  })

  test('sending seul : orphelin', () => {
    assert.deepEqual(orphanSendings([ev('outreach:sending')]), ['MSG-2026-0001'])
  })

  test('send-failed lève le blocage, send-uncertain non', () => {
    assert.deepEqual(orphanSendings([ev('outreach:sending'), ev('outreach:send-failed')]), [])
    assert.deepEqual(orphanSendings([ev('outreach:sending'), ev('outreach:send-uncertain')]), ['MSG-2026-0001'])
  })

  test('clear-sending et mark-sent lèvent le blocage', () => {
    assert.deepEqual(orphanSendings([ev('outreach:sending'), ev('outreach:clear-sending')]), [])
    assert.deepEqual(orphanSendings([ev('outreach:sending'), ev('outreach:mark-sent')]), [])
  })
})

describe('sentCountOn', () => {
  test('ne compte que les envois du jour', () => {
    const events = [
      ev('outreach:sent', 'MSG-1', '2026-09-27T23:59:00Z'),
      ev('outreach:sent', 'MSG-2', '2026-09-28T08:00:00Z'),
      ev('outreach:sending', 'MSG-3', '2026-09-28T08:05:00Z'),
      ev('outreach:sent', 'MSG-3', '2026-09-28T08:05:01Z'),
    ]
    assert.equal(sentCountOn(events, '2026-09-28'), 2)
  })
})
```

- [ ] **Step 2 : vérifier l'échec**

Run: `node --test test/outreach.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/outreach.ts'`.

- [ ] **Step 3 : implémenter**

Créer `src/lib/outreach.ts` :

```ts
/**
 * Règles d'approbation et d'envoi des messages. Pur : aucune I/O, pour que
 * chaque garde-fou soit testé sans réseau et sans toucher à `data/`.
 */
import { createHash } from 'node:crypto'
import { TERMINAL_STAGES, type Opportunity, type OutreachMessage } from './types.ts'
import { findPlaceholders } from './validate.ts'
import type { MailConfig } from './mail-config.ts'

export interface HistoryEvent {
  at: string
  event: string
  id?: string
  [key: string]: unknown
}

export interface SendContext {
  opportunity?: Opportunity
  events: HistoryEvent[]
  outreach: OutreachMessage[]
  now: Date
  config: MailConfig
  forceRecipient: boolean
}

/** Empreinte de ce que Nicolas a lu au moment d'approuver. */
export function approvalHash(m: Pick<OutreachMessage, 'to' | 'subject' | 'body'>): string {
  return createHash('sha256')
    .update(JSON.stringify([m.to?.email ?? '', m.to?.name ?? '', m.subject, m.body]))
    .digest('hex')
    .slice(0, 16)
}

function isClosed(opportunity: Opportunity | undefined): opportunity is Opportunity {
  return !!opportunity && (TERMINAL_STAGES as readonly string[]).includes(opportunity.stage)
}

function commonIssues(m: OutreachMessage, opportunity: Opportunity | undefined): string[] {
  const issues: string[] = []
  if (m.channel !== 'email') issues.push('Canal `' + m.channel + '` : seuls les emails partent par la CLI.')
  if (!m.to) issues.push('Aucun destinataire : lance d\'abord outreach:set-recipient ' + m.id + '.')
  if (isClosed(opportunity)) {
    issues.push('L\'opportunité ' + opportunity.id + ' est ' + opportunity.stage + ' : on n\'écrit pas pour une annonce close.')
  }
  return issues
}

export function approvalIssues(m: OutreachMessage, opportunity?: Opportunity): string[] {
  const issues: string[] = []
  if (m.status === 'SENT') issues.push(m.id + ' est déjà envoyé.')
  issues.push(...commonIssues(m, opportunity))
  const markers = findPlaceholders(m.subject + '\n' + m.body)
  if (markers.length) {
    issues.push('Marqueurs à compléter : ' + markers.join(', ') + '. Corrige avec outreach:edit ' + m.id + '.')
  }
  return issues
}

/** Événements qui ferment un `outreach:sending`. `send-uncertain` n'en fait pas partie. */
const CLOSING_EVENTS = new Set(['outreach:sent', 'outreach:send-failed', 'outreach:clear-sending', 'outreach:mark-sent'])

/** Messages dont l'envoi a commencé sans qu'on sache s'il a abouti. */
export function orphanSendings(events: HistoryEvent[]): string[] {
  const open = new Set<string>()
  for (const e of events) {
    if (!e.id) continue
    if (e.event === 'outreach:sending') open.add(e.id)
    else if (CLOSING_EVENTS.has(e.event)) open.delete(e.id)
  }
  return [...open]
}

/** Envois réussis un jour donné (`YYYY-MM-DD`, UTC comme le journal). */
export function sentCountOn(events: HistoryEvent[], day: string): number {
  return events.filter((e) => e.event === 'outreach:sent' && e.at.startsWith(day)).length
}

function lastSentTo(email: string, outreach: OutreachMessage[], now: Date, days: number): OutreachMessage | undefined {
  const since = now.getTime() - days * 86_400_000
  const target = email.toLowerCase()
  return outreach.find(
    (o) => o.status === 'SENT' && o.to?.email.toLowerCase() === target && !!o.sentAt && Date.parse(o.sentAt) >= since,
  )
}

export function sendIssues(m: OutreachMessage, ctx: SendContext): string[] {
  const issues: string[] = []
  if (m.status !== 'APPROVED') issues.push(m.id + ' est ' + m.status + ' : seul un message APPROVED part.')
  issues.push(...commonIssues(m, ctx.opportunity))
  if (m.status === 'APPROVED' && m.approvedHash !== approvalHash(m)) {
    issues.push('Le message a changé depuis son approbation : relis-le et réapprouve-le (outreach:approve ' + m.id + ').')
  }
  if (orphanSendings(ctx.events).includes(m.id)) {
    issues.push(
      'Un envoi de ' + m.id + ' a été interrompu : on ne sait pas s\'il est parti. Vérifie le dossier Envoyés, puis outreach:mark-sent ' +
        m.id + ' ou outreach:clear-sending ' + m.id + '.',
    )
  }
  if (m.to && !ctx.forceRecipient) {
    const others = ctx.outreach.filter((o) => o.id !== m.id)
    const previous = lastSentTo(m.to.email, others, ctx.now, ctx.config.recipientCooldownDays)
    if (previous) {
      issues.push(
        m.to.email + ' a déjà reçu ' + previous.id + ' le ' + previous.sentAt!.slice(0, 10) + ', il y a moins de ' +
          ctx.config.recipientCooldownDays + ' jours. --force-recipient pour passer outre.',
      )
    }
  }
  return issues
}
```

- [ ] **Step 4 : vérifier**

Run: `node --test test/outreach.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5 : commit**

```bash
git add src/lib/outreach.ts test/outreach.test.ts
git commit -m "feat(outreach): règles d'approbation et garde-fous d'envoi"
```

---

### Task 4 : construction du message (MIME)

**Files:**
- Create: `src/lib/mime.ts`
- Test: `test/mime.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

Créer `test/mime.test.ts` :

```ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildMessage, encodeHeaderWord, encodeQuotedPrintable, formatAddress } from '../src/lib/mime.ts'

const decodeWords = (encoded: string) =>
  encoded.split('\r\n ').map((w) => Buffer.from(w.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8')).join('')

describe('encodeHeaderWord', () => {
  test('ASCII : inchangé', () => {
    assert.equal(encodeHeaderWord('Mission Node.js'), 'Mission Node.js')
  })

  test('accents : RFC 2047, réversible', () => {
    const encoded = encodeHeaderWord('Développeur à Lille')
    assert.match(encoded, /^=\?UTF-8\?B\?/)
    assert.equal(decodeWords(encoded), 'Développeur à Lille')
  })

  test('objet long : chaque mot encodé tient en 75 caractères', () => {
    const subject = 'Refonte NestJS — un renfort qui l\'a déjà faite, à Lille ou à distance, dès octobre'
    const encoded = encodeHeaderWord(subject)
    for (const word of encoded.split('\r\n ')) assert.ok(word.length <= 75, word)
    assert.equal(decodeWords(encoded), subject)
  })
})

describe('encodeQuotedPrintable', () => {
  test('encode UTF-8, =, et l\'espace final', () => {
    assert.equal(encodeQuotedPrintable('é = x '), '=C3=A9 =3D x=20')
  })

  test('aucune ligne au-delà de 76 caractères', () => {
    const encoded = encodeQuotedPrintable('é'.repeat(100) + '\n' + 'a'.repeat(200))
    for (const line of encoded.split('\r\n')) assert.ok(line.length <= 76, line)
  })

  test('fins de ligne normalisées en CRLF', () => {
    assert.equal(encodeQuotedPrintable('a\nb\r\nc'), 'a\r\nb\r\nc')
  })
})

describe('buildMessage', () => {
  const mail = buildMessage({
    from: { email: 'nicolas@urbanlink.fr', name: 'Nicolas BENY' },
    to: { email: 'rh@acme.example' },
    subject: 'Votre annonce Node.js',
    body: 'Bonjour,\n\n.ligne qui commence par un point\n\nNicolas',
    date: new Date('2026-09-28T10:00:00Z'),
    messageId: '<fixe@urbanlink.fr>',
  })

  test('en-têtes attendus', () => {
    const head = mail.raw.split('\r\n\r\n')[0]
    assert.match(head, /^From: "Nicolas BENY" <nicolas@urbanlink\.fr>$/m)
    assert.match(head, /^To: rh@acme\.example$/m)
    assert.match(head, /^Subject: Votre annonce Node\.js$/m)
    assert.match(head, /^Date: Mon, 28 Sep 2026 10:00:00 \+0000$/m)
    assert.match(head, /^Message-ID: <fixe@urbanlink\.fr>$/m)
    assert.match(head, /^Content-Type: text\/plain; charset=utf-8$/m)
    assert.match(head, /^Content-Transfer-Encoding: quoted-printable$/m)
    assert.equal(mail.messageId, '<fixe@urbanlink.fr>')
  })

  test('jamais d\'en-tête Bcc', () => {
    assert.doesNotMatch(mail.raw, /^Bcc:/im)
  })

  test('uniquement des CRLF', () => {
    assert.doesNotMatch(mail.raw, /[^\r]\n/)
  })

  test('Message-ID généré sur le domaine de l\'expéditeur', () => {
    const generated = buildMessage({ from: { email: 'nicolas@urbanlink.fr', name: 'N' }, to: { email: 'a@b.example' }, subject: 's', body: 'b', date: new Date() })
    assert.match(generated.messageId, /^<[0-9a-f-]{36}@urbanlink\.fr>$/)
  })
})

describe('formatAddress', () => {
  test('nom accentué encodé', () => {
    assert.match(formatAddress({ email: 'a@b.example', name: 'Hélène' }), /^=\?UTF-8\?B\?.+\?= <a@b\.example>$/)
  })

  test('guillemets échappés', () => {
    assert.equal(formatAddress({ email: 'a@b.example', name: 'Le "Chef"' }), '"Le \\"Chef\\"" <a@b.example>')
  })
})
```

- [ ] **Step 2 : vérifier l'échec**

Run: `node --test test/mime.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/mime.ts'`.

- [ ] **Step 3 : implémenter**

Créer `src/lib/mime.ts` :

```ts
/**
 * Construction d'un email texte brut conforme (RFC 5322, 2047, 2045). Pur :
 * aucune I/O. La copie cachée n'apparaît jamais dans les en-têtes, elle ne
 * passe que par l'enveloppe SMTP.
 */
import { randomUUID } from 'node:crypto'

export interface Address {
  email: string
  name?: string
}

export interface MailInput {
  from: Address
  to: Address
  subject: string
  body: string
  date: Date
  messageId?: string
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/** Mot encodé RFC 2047 si nécessaire, découpé pour que chaque mot tienne en 75 caractères. */
export function encodeHeaderWord(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value
  const chunks: string[] = []
  let chunk = ''
  for (const char of value) {
    // 45 octets donnent 60 caractères base64, plus 12 d'enveloppe : 72.
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  if (chunk) chunks.push(chunk)
  return chunks.map((c) => '=?UTF-8?B?' + Buffer.from(c, 'utf8').toString('base64') + '?=').join('\r\n ')
}

export function formatAddress(address: Address): string {
  if (!address.name) return address.email
  const display = PRINTABLE_ASCII.test(address.name)
    ? '"' + address.name.replace(/["\\]/g, '\\$&') + '"'
    : encodeHeaderWord(address.name)
  return display + ' <' + address.email + '>'
}

function encodeQpLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  const out: string[] = []
  let current = ''
  bytes.forEach((byte, index) => {
    const isLast = index === bytes.length - 1
    let token: string
    if ((byte === 0x20 || byte === 0x09) && !isLast) token = String.fromCharCode(byte)
    else if (byte >= 33 && byte <= 126 && byte !== 61) token = String.fromCharCode(byte)
    else token = '=' + byte.toString(16).toUpperCase().padStart(2, '0')
    if (current.length + token.length > 75) {
      out.push(current + '=')
      current = ''
    }
    current += token
  })
  out.push(current)
  return out.join('\r\n')
}

export function encodeQuotedPrintable(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map(encodeQpLine).join('\r\n')
}

export function buildMessage(input: MailInput): { messageId: string; raw: string } {
  const domain = input.from.email.split('@')[1]
  const messageId = input.messageId ?? '<' + randomUUID() + '@' + domain + '>'
  const headers = [
    'From: ' + formatAddress(input.from),
    'To: ' + formatAddress(input.to),
    'Subject: ' + encodeHeaderWord(input.subject),
    'Date: ' + input.date.toUTCString().replace('GMT', '+0000'),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
  ]
  return { messageId, raw: headers.join('\r\n') + '\r\n\r\n' + encodeQuotedPrintable(input.body) + '\r\n' }
}
```

- [ ] **Step 4 : vérifier**

Run: `node --test test/mime.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5 : commit**

```bash
git add src/lib/mime.ts test/mime.test.ts
git commit -m "feat(mail): construction du message texte brut (RFC 5322, 2047, quoted-printable)"
```

---

### Task 5 : client SMTP

**Files:**
- Create: `src/lib/smtp.ts`
- Test: `test/smtp.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

Créer `test/smtp.test.ts` :

```ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'

import { sendMail, dotStuff, SmtpError, type SmtpOptions } from '../src/lib/smtp.ts'

interface FakeServer {
  port: number
  received: string[]
  data: () => string
  close: () => Promise<void>
}

/**
 * Faux serveur SMTP en clair. `replies` remplace la réponse par défaut d'un
 * verbe (`AUTH`) ou d'une ligne exacte (`RCPT TO:<x>`) ; `SILENCE` ne répond pas.
 */
async function fakeServer(replies: Record<string, string> = {}): Promise<FakeServer> {
  const received: string[] = []
  let data = ''
  const server = createServer((socket) => {
    let buffer = ''
    let inData = false
    socket.write('220 fake ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write((replies['.'] ?? '250 2.0.0 Ok: queued as ABC123') + '\r\n')
          } else {
            data += line + '\r\n'
          }
          continue
        }
        received.push(line)
        const verb = line.split(/[ :]/)[0].toUpperCase()
        const custom = replies[line] ?? replies[verb]
        if (custom === 'SILENCE') continue
        if (custom) socket.write(custom + '\r\n')
        else if (verb === 'EHLO') socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
        else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n')
        else if (verb === 'DATA') {
          inData = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (verb === 'QUIT') socket.end('221 2.0.0 Bye\r\n')
        else socket.write('250 2.1.0 Ok\r\n')
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    received,
    data: () => data,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function options(port: number, over: Partial<SmtpOptions> = {}): SmtpOptions {
  return {
    host: '127.0.0.1',
    port,
    tls: false,
    user: 'nicolas@urbanlink.fr',
    pass: 'secret',
    from: 'nicolas@urbanlink.fr',
    rcpt: ['rh@acme.example', 'nicolas@urbanlink.fr'],
    raw: 'Subject: test\r\n\r\nligne\r\n.commence par un point\r\n',
    ehloName: 'test.local',
    timeoutMs: 2000,
    ...over,
  }
}

describe('dotStuff', () => {
  test('double le point en tête de ligne, seulement là', () => {
    assert.equal(dotStuff('a\r\n.b\r\nc.d\r\n'), 'a\r\n..b\r\nc.d\r\n')
  })
})

describe('sendMail', () => {
  test('parcours complet : AUTH PLAIN, enveloppe, corps doublé', async () => {
    const fake = await fakeServer()
    try {
      const result = await sendMail(options(fake.port))
      assert.match(result.reply, /queued as ABC123/)
      const auth = 'AUTH PLAIN ' + Buffer.from('\0nicolas@urbanlink.fr\0secret').toString('base64')
      assert.deepEqual(fake.received, [
        'EHLO test.local',
        auth,
        'MAIL FROM:<nicolas@urbanlink.fr>',
        'RCPT TO:<rh@acme.example>',
        'RCPT TO:<nicolas@urbanlink.fr>',
        'DATA',
        'QUIT',
      ])
      assert.ok(fake.data().includes('\r\n..commence par un point\r\n'))
    } finally {
      await fake.close()
    }
  })

  test('onBeforeData est appelé après les RCPT et avant DATA', async () => {
    const fake = await fakeServer()
    try {
      let seen: string[] = []
      await sendMail(options(fake.port, { onBeforeData: () => { seen = [...fake.received] } }))
      assert.ok(seen.includes('RCPT TO:<nicolas@urbanlink.fr>'))
      assert.ok(!seen.includes('DATA'))
    } finally {
      await fake.close()
    }
  })

  test('authentification refusée : SmtpError 535 sur AUTH', async () => {
    const fake = await fakeServer({ AUTH: '535 5.7.8 Error: authentication failed' })
    try {
      await assert.rejects(sendMail(options(fake.port)), (error: unknown) =>
        error instanceof SmtpError && error.code === 535 && error.command === 'AUTH' && /authentication failed/.test(error.reply))
    } finally {
      await fake.close()
    }
  })

  test('destinataire refusé : SmtpError 550 sur RCPT TO', async () => {
    const fake = await fakeServer({ 'RCPT TO:<rh@acme.example>': '550 5.1.1 User unknown' })
    try {
      await assert.rejects(sendMail(options(fake.port)), (error: unknown) =>
        error instanceof SmtpError && error.code === 550 && error.command.startsWith('RCPT TO'))
      assert.ok(!fake.received.includes('DATA'))
    } finally {
      await fake.close()
    }
  })

  test('serveur muet : SmtpError sans code, délai dépassé', async () => {
    const fake = await fakeServer({ EHLO: 'SILENCE' })
    try {
      await assert.rejects(sendMail(options(fake.port, { timeoutMs: 200 })), (error: unknown) =>
        error instanceof SmtpError && error.code === 0 && /délai/.test(error.reply))
    } finally {
      await fake.close()
    }
  })
})
```

- [ ] **Step 2 : vérifier l'échec**

Run: `node --test test/smtp.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/smtp.ts'`.

- [ ] **Step 3 : implémenter**

Créer `src/lib/smtp.ts` :

```ts
/**
 * Client SMTP minimal, sans dépendance : juste ce qu'il faut pour remettre un
 * message à Mailcow en SMTPS avec AUTH PLAIN. Chaque réponse inattendue lève
 * une SmtpError qui porte la commande et le texte exact du serveur.
 */
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { hostname } from 'node:os'

export class SmtpError extends Error {
  readonly command: string
  /** 0 quand le serveur n'a pas répondu (délai, coupure, TLS). */
  readonly code: number
  readonly reply: string
  constructor(command: string, code: number, reply: string) {
    super('SMTP ' + command + ' → ' + (code || 'sans réponse') + ' ' + reply)
    this.name = 'SmtpError'
    this.command = command
    this.code = code
    this.reply = reply
  }
}

export interface SmtpOptions {
  host: string
  port: number
  /** Nom vérifié dans le certificat : indispensable quand on passe par un tunnel. */
  servername?: string
  tls: boolean
  user: string
  pass: string
  from: string
  rcpt: string[]
  raw: string
  ehloName?: string
  timeoutMs?: number
  /** Appelé juste avant la commande DATA : à partir d'ici, le message peut être parti. */
  onBeforeData?: () => void
}

interface Reply {
  code: number
  text: string
}

interface Pending {
  command: string
  resolve: (reply: Reply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function dotStuff(raw: string): string {
  return raw.split('\r\n').map((line) => (line.startsWith('.') ? '.' + line : line)).join('\r\n')
}

function replyReader(socket: Socket, timeoutMs: number): (command: string) => Promise<Reply> {
  let buffer = ''
  let failure: Error | null = null
  let pending: Pending | null = null

  const settle = () => {
    if (!pending) return
    const lines = buffer.split('\r\n')
    for (let i = 0; i < lines.length - 1; i++) {
      if (!/^\d{3}(?: |$)/.test(lines[i])) continue
      const current = pending
      pending = null
      clearTimeout(current.timer)
      buffer = lines.slice(i + 1).join('\r\n')
      current.resolve({ code: Number(lines[i].slice(0, 3)), text: lines.slice(0, i + 1).map((l) => l.slice(4)).join('\n') })
      return
    }
  }

  const fail = (error: Error) => {
    failure ??= error
    if (!pending) return
    const current = pending
    pending = null
    clearTimeout(current.timer)
    current.reject(new SmtpError(current.command, 0, error.message))
  }

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    settle()
  })
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('connexion fermée par le serveur')))

  return (command) =>
    new Promise<Reply>((resolve, reject) => {
      if (failure) {
        reject(new SmtpError(command, 0, failure.message))
        return
      }
      const timer = setTimeout(() => {
        pending = null
        reject(new SmtpError(command, 0, 'délai dépassé (' + timeoutMs + ' ms)'))
        socket.destroy()
      }, timeoutMs)
      pending = { command, resolve, reject, timer }
      settle()
    })
}

export async function sendMail(options: SmtpOptions): Promise<{ reply: string }> {
  const socket = options.tls
    ? tlsConnect({ host: options.host, port: options.port, servername: options.servername ?? options.host })
    : netConnect({ host: options.host, port: options.port })
  const read = replyReader(socket, options.timeoutMs ?? 30_000)
  const send = (line: string) => socket.write(line + '\r\n')
  const expect = async (command: string, accepted: number[]): Promise<Reply> => {
    const reply = await read(command)
    if (!accepted.includes(reply.code)) throw new SmtpError(command, reply.code, reply.text)
    return reply
  }

  try {
    await expect('CONNEXION', [220])
    send('EHLO ' + (options.ehloName ?? hostname()))
    await expect('EHLO', [250])
    send('AUTH PLAIN ' + Buffer.from('\0' + options.user + '\0' + options.pass, 'utf8').toString('base64'))
    await expect('AUTH', [235])
    send('MAIL FROM:<' + options.from + '>')
    await expect('MAIL FROM', [250])
    for (const rcpt of options.rcpt) {
      send('RCPT TO:<' + rcpt + '>')
      await expect('RCPT TO:<' + rcpt + '>', [250, 251])
    }
    options.onBeforeData?.()
    send('DATA')
    await expect('DATA', [354])
    const raw = options.raw.endsWith('\r\n') ? options.raw : options.raw + '\r\n'
    socket.write(dotStuff(raw) + '.\r\n')
    const accepted = await expect('fin de DATA', [250])
    send('QUIT')
    await read('QUIT').catch(() => undefined)
    return { reply: accepted.text }
  } finally {
    socket.destroy()
  }
}
```

- [ ] **Step 4 : vérifier**

Run: `node --test test/smtp.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5 : commit**

```bash
git add src/lib/smtp.ts test/smtp.test.ts
git commit -m "feat(mail): client SMTP minimal sans dépendance"
```

---

### Task 6 : tunnel SSH

**Files:**
- Create: `src/lib/tunnel.ts`

Pas de test unitaire (spec) : le module lance un vrai `ssh`. Il est vérifié à la tâche 10.

- [ ] **Step 1 : implémenter**

Créer `src/lib/tunnel.ts` :

```ts
/**
 * Tunnel SSH le temps d'un envoi. Le port de soumission de Mailcow n'est
 * ouvert que sur le LAN du cluster : on passe par le noeud `pve`, comme pour
 * toute machine 10.0.0.x, et on referme dès que l'envoi est fini.
 */
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'

export interface TunnelOptions {
  jumpHost: string
  target: string
  targetPort: number
  readyTimeoutMs?: number
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export async function withTunnel<T>(options: TunnelOptions, fn: (localPort: number) => Promise<T>): Promise<T> {
  const port = await freePort()
  const timeoutMs = options.readyTimeoutMs ?? 15_000
  const ssh = spawn(
    'ssh',
    ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:' + port + ':' + options.target + ':' + options.targetPort, options.jumpHost],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  )
  const state = { stderr: '', failure: '' }
  ssh.stderr.on('data', (chunk) => { state.stderr += chunk })
  ssh.on('error', (error) => { state.failure ||= 'ssh introuvable ou non lançable : ' + error.message })
  ssh.on('exit', (code) => { state.failure ||= 'ssh s\'est arrêté (code ' + code + ') : ' + (state.stderr.trim() || 'aucun message') })

  try {
    const deadline = Date.now() + timeoutMs
    while (!(await portAccepts(port))) {
      if (state.failure) {
        throw new Error('Tunnel vers ' + options.target + ':' + options.targetPort + ' via ' + options.jumpHost + ' impossible. ' + state.failure)
      }
      if (Date.now() > deadline) throw new Error('Tunnel SSH non prêt après ' + timeoutMs / 1000 + ' s. ' + state.stderr.trim())
      await pause(250)
    }
    return await fn(port)
  } finally {
    if (ssh.exitCode === null && ssh.signalCode === null) ssh.kill()
  }
}
```

- [ ] **Step 2 : vérifier que le module se charge**

Run: `node -e "import('./src/lib/tunnel.ts').then(m => console.log(typeof m.withTunnel))"`
Expected: `function`

- [ ] **Step 3 : vérifier le message d'erreur sur un hôte inconnu**

Run: `node -e "import('./src/lib/tunnel.ts').then(m => m.withTunnel({ jumpHost: 'hote-inexistant-nbeny', target: '10.0.0.140', targetPort: 465 }, async () => 'ok')).then(console.log, e => console.log(e.message))"`
Expected: une ligne commençant par `Tunnel vers 10.0.0.140:465 via hote-inexistant-nbeny impossible. ssh s'est arrêté (code 255)` suivie du message de résolution de nom de ssh.

- [ ] **Step 4 : commit**

```bash
git add src/lib/tunnel.ts
git commit -m "feat(mail): tunnel SSH ouvert le temps d'un envoi"
```

---

### Task 7 : commandes de la CLI

**Files:**
- Modify: `src/cli.ts` (imports en tête, `FLAGS_WITH_VALUE`, nouvelles fonctions après `outreachMarkSent`, `help`, `COMMANDS`, bloc d'exécution final)

`src/cli.ts` a déjà des modifications non commitées : au commit, `git add -p src/cli.ts` et ne prendre que les hunks de cette tâche.

- [ ] **Step 1 : imports**

En tête de `src/cli.ts`, après `import { join } from 'node:path'`, ajouter :

```ts
import { createInterface } from 'node:readline/promises'
import { setTimeout as pause } from 'node:timers/promises'
```

Dans l'import depuis `./lib/store.ts`, ajouter `readHistory,` à la liste.

Remplacer la ligne d'import de `./lib/validate.ts` par :

```ts
import { assertValidOpportunity, assertValidOutreach, lintOutreachBody, validateOpportunityInput, validateRecipient, ValidationError } from './lib/validate.ts'
```

Après la ligne d'import de `./lib/runs.ts`, ajouter :

```ts
import { approvalHash, approvalIssues, orphanSendings, sendIssues, sentCountOn, type HistoryEvent } from './lib/outreach.ts'
import { buildMessage } from './lib/mime.ts'
import { sendMail, SmtpError } from './lib/smtp.ts'
import { withTunnel } from './lib/tunnel.ts'
import { readSmtpPassword, type MailConfig } from './lib/mail-config.ts'
```

- [ ] **Step 2 : flags avec valeur**

Dans `FLAGS_WITH_VALUE`, ajouter `'email', 'name'` à la fin du tableau.

- [ ] **Step 3 : nouvelles commandes**

Juste après la fonction `outreachMarkSent`, ajouter :

```ts
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
 * Verrou dur : seules les commandes lancées depuis un terminal par Nicolas
 * passent. Un agent n'a pas de TTY, quelles que soient ses permissions.
 */
async function confirmByTyping(expected: string, prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('Cette commande demande une confirmation au clavier : elle se lance depuis un terminal, par Nicolas, jamais par un agent.')
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
  const rows = readCollection<OutreachMessage>('outreach')
  const m = findOutreach(rows, id)
  if (m.status === 'SENT') { console.error(m.id + ' est déjà envoyé : son destinataire ne change plus.'); process.exit(2) }
  const email = flag('email')?.trim()
  const sourceUrl = flag('source')
  const issues = validateRecipient({ email, sourceUrl })
  if (issues.length) throw new ValidationError(issues)
  const name = flag('name')
  m.to = { email: email!, ...(name ? { name } : {}), sourceUrl: sourceUrl!, readAt: new Date().toISOString() }
  const wasApproved = resetApproval(m)
  writeCollection('outreach', rows)
  appendHistory({ event: 'outreach:set-recipient', id: m.id, to: m.to.email, source: sourceUrl })
  console.log(m.id + ' → ' + m.to.email + ' (lu sur ' + sourceUrl + ').' + (wasApproved ? ' L\'approbation précédente est annulée.' : ''))
}

function outreachEdit(): void {
  const id = positional(0)
  const input = payload()
  const rows = readCollection<OutreachMessage>('outreach')
  const m = findOutreach(rows, id)
  if (m.status === 'SENT') { console.error(m.id + ' est déjà envoyé : il ne se modifie plus.'); process.exit(2) }
  const subject = input.subject === undefined ? m.subject : String(input.subject)
  const body = input.body === undefined ? m.body : String(input.body)
  assertValidOutreach({ companyName: m.companyName, subject, body, reason: m.reason, sourceUrl: m.sourceUrl, channel: m.channel })
  const lint = lintOutreachBody(body)
  if (lint.length) {
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
  const rows = readCollection<OutreachMessage>('outreach')
  const m = findOutreach(rows, id)
  const opportunity = readCollection<Opportunity>('opportunities').find((o) => o.id === m.opportunityId)
  const issues = approvalIssues(m, opportunity)
  if (issues.length) {
    console.error('Approbation refusée :')
    for (const i of issues) console.error('  - ' + i)
    process.exit(2)
  }
  const to = m.to!
  console.log([
    'De     : ' + config.from.name + ' <' + config.from.email + '>',
    'À      : ' + (to.name ? to.name + ' <' + to.email + '>' : to.email),
    'Adresse lue sur : ' + to.sourceUrl,
    'Objet  : ' + m.subject,
    '',
    m.body,
    '',
  ].join('\n'))
  if (!(await confirmByTyping(m.id, 'Tape ' + m.id + ' pour approuver ce message tel quel : '))) {
    console.log('Non approuvé.')
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
  if (!orphanSendings(readHistory() as HistoryEvent[]).includes(m.id)) {
    console.log('Aucun envoi interrompu pour ' + m.id + '.')
    return
  }
  console.log('À ne confirmer qu\'après avoir vérifié le dossier Envoyés et la copie cachée : ' + m.id + ' n\'est PAS parti.')
  if (!(await confirmByTyping(m.id, 'Tape ' + m.id + ' pour confirmer : '))) {
    console.log('Rien n\'a changé.')
    process.exit(2)
  }
  appendHistory({ event: 'outreach:clear-sending', id: m.id })
  console.log(m.id + ' peut de nouveau être envoyé.')
}

async function outreachSend(): Promise<void> {
  const config = readConfig<MailConfig>('mail')
  const rows = readCollection<OutreachMessage>('outreach')
  const opportunities = readCollection<Opportunity>('opportunities')
  const ids = has('all-approved')
    ? rows.filter((r) => r.status === 'APPROVED').map((r) => r.id)
    : [positional(0)].filter((id): id is string => !!id)
  if (!ids.length) {
    console.log(has('all-approved') ? 'Aucun message APPROVED en attente.' : 'Usage : outreach:send <id> | --all-approved [--dry-run] [--force-recipient]')
    return
  }

  const now = new Date()
  const events = readHistory() as HistoryEvent[]
  const ready: OutreachMessage[] = []
  // Le délai entre deux messages à la même adresse vaut aussi à l'intérieur d'un lot.
  const batchRecipients = new Set<string>()
  for (const id of ids) {
    const m = rows.find((r) => r.id === id)
    if (!m) { console.error('Message introuvable : ' + id); process.exitCode = 1; continue }
    const opportunity = opportunities.find((o) => o.id === m.opportunityId)
    const issues = sendIssues(m, { opportunity, events, outreach: rows, now, config, forceRecipient: has('force-recipient') })
    const recipientKey = m.to?.email.trim().toLowerCase()
    if (recipientKey && batchRecipients.has(recipientKey) && !has('force-recipient')) {
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

  const remaining = Math.max(0, config.dailyCap - sentCountOn(events, now.toISOString().slice(0, 10)))
  if (ready.length > remaining) {
    console.log('Plafond de ' + config.dailyCap + ' envois par jour : ' + ready.slice(remaining).map((m) => m.id).join(', ') + ' attendront demain (toujours APPROVED).')
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

  const pass = readSmtpPassword()
  await withTunnel({ jumpHost: config.tunnel.jumpHost, target: config.smtp.host, targetPort: config.smtp.port }, async (localPort) => {
    for (const [index, m] of ready.entries()) {
      if (index > 0) {
        console.log('Pause de ' + config.minDelaySeconds + ' s avant le suivant…')
        await pause(config.minDelaySeconds * 1000)
      }
      const mail = build(m)
      let dataStarted = false
      try {
        await sendMail({
          host: '127.0.0.1',
          port: localPort,
          servername: config.smtp.servername,
          tls: true,
          user: config.from.email,
          pass,
          from: config.from.email,
          rcpt: recipients(m),
          raw: mail.raw,
          onBeforeData: () => {
            dataStarted = true
            appendHistory({ event: 'outreach:sending', id: m.id, to: m.to!.email, messageId: mail.messageId })
          },
        })
        const fresh = readCollection<OutreachMessage>('outreach')
        const saved = fresh.find((r) => r.id === m.id)!
        saved.status = 'SENT'
        saved.sentAt = new Date().toISOString()
        saved.messageId = mail.messageId
        writeCollection('outreach', fresh)
        appendHistory({ event: 'outreach:sent', id: m.id, to: m.to!.email, messageId: mail.messageId })
        console.log('✅ ' + m.id + ' envoyé à ' + m.to!.email + ' ' + mail.messageId)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // Refus explicite du serveur, ou échec avant DATA : on sait que rien n'est parti.
        const certain = !dataStarted || (error instanceof SmtpError && error.code >= 400)
        appendHistory({ event: certain ? 'outreach:send-failed' : 'outreach:send-uncertain', id: m.id, error: reason })
        console.error('❌ ' + m.id + ' : ' + reason)
        if (!certain) console.error('   Coupure pendant la transmission : ' + m.id + ' reste bloqué jusqu\'à vérification du dossier Envoyés.')
        process.exitCode = 1
        if (!(error instanceof SmtpError && error.command.startsWith('RCPT TO'))) {
          console.error('Lot arrêté.')
          break
        }
      }
    }
  })
}
```

- [ ] **Step 4 : aide**

Dans `help()`, remplacer le bloc :

```
Messages (jamais envoyés automatiquement)
  outreach:add --file <json>          Crée un brouillon
  outreach:list
  outreach:show <id>
  outreach:mark-sent <id>             Enregistre un envoi fait à la main
```

par :

```
Messages (rien ne part sans l'approbation de Nicolas)
  outreach:add --file <json>          Crée un brouillon
  outreach:edit <id> --file <json>    Corrige subject/body (annule l'approbation)
  outreach:set-recipient <id> --email <adresse> --source <url> [--name "..."]
  outreach:list
  outreach:show <id>
  outreach:approve <id>               Nicolas seul, au clavier
  outreach:send <id> | --all-approved [--dry-run] [--force-recipient]
  outreach:clear-sending <id>         Débloque un envoi interrompu (au clavier)
  outreach:mark-sent <id>             Enregistre un envoi fait à la main
```

- [ ] **Step 5 : table des commandes et exécution asynchrone**

Remplacer la déclaration de `COMMANDS` :

```ts
const COMMANDS: Record<string, () => void> = {
```

par :

```ts
const COMMANDS: Record<string, () => void | Promise<void>> = {
```

et y ajouter, après `'outreach:mark-sent': outreachMarkSent,` :

```ts
  'outreach:edit': outreachEdit,
  'outreach:set-recipient': outreachSetRecipient,
  'outreach:approve': outreachApprove,
  'outreach:send': outreachSend,
  'outreach:clear-sending': outreachClearSending,
```

Dans le bloc `try` final, remplacer `  run()` par `  await run()`.

- [ ] **Step 6 : vérifier que rien d'existant n'est cassé**

Run: `node --test "test/*.test.ts"`
Expected: PASS, tous les tests.

Run: `node src/cli.ts help`
Expected: la section « Messages (rien ne part sans l'approbation de Nicolas) » avec les nouvelles commandes.

Run: `node src/cli.ts stats`
Expected: même sortie qu'avant la tâche (commande synchrone, toujours fonctionnelle derrière `await`).

- [ ] **Step 7 : vérifier les refus sans toucher à la vraie base**

Les commandes écrivent dans `data/`. Pour ne rien modifier, vérifier seulement les chemins de refus, qui sortent avant toute écriture :

Run: `node src/cli.ts outreach:set-recipient MSG-2026-0001 --email rh@acme`
Expected: code de sortie 2, `Enregistrement refusé :` avec les deux lignes `--email` et `--source`.

Run: `node src/cli.ts outreach:approve MSG-2026-0001`
Expected: code de sortie 2, `Approbation refusée :` avec `Aucun destinataire : lance d'abord outreach:set-recipient MSG-2026-0001.` (et `LOST` si l'agent du 26/09 a été suivi pour WeSyn).

Run: `node src/cli.ts outreach:send MSG-2026-0001 --dry-run`
Expected: code de sortie 2, `MSG-2026-0001 ne part pas :` avec `est DRAFT : seul un message APPROVED part.`

Run: `node src/cli.ts outreach:send --all-approved --dry-run`
Expected: `Aucun message APPROVED en attente.`

Run: `echo MSG-2026-0001 | node src/cli.ts outreach:clear-sending MSG-2026-0001`
Expected: `Aucun envoi interrompu pour MSG-2026-0001.` (le verrou TTY n'est atteint que s'il y a un envoi orphelin).

- [ ] **Step 8 : commit**

```bash
git add -p src/cli.ts   # ne prendre que les hunks de cette tâche
git commit -m "feat(cli): set-recipient, edit, approve, send et clear-sending"
```

---

### Task 8 : règles, permissions et documentation

**Files:**
- Modify: `.claude/settings.json`
- Modify: `CLAUDE.md` (règle 3, bloc Commandes)
- Modify: `.claude/agents/outreach-agent.md` (lignes 7-12 et 65-66)
- Modify: `.claude/agents/ceo-agent.md` (ligne 37)
- Modify: `.claude/commands/sales.md` (synthèse finale)

- [ ] **Step 1 : permissions**

Dans `.claude/settings.json`, remplacer :

```json
    "ask": [
      "Bash(git push *)"
    ]
```

par :

```json
    "ask": [
      "Bash(git push *)",
      "Bash(node src/cli.ts outreach:send *)"
    ],
    "deny": [
      "Bash(node src/cli.ts outreach:approve *)",
      "Bash(node src/cli.ts outreach:clear-sending *)",
      "Bash(NBENY_SALES_* *)",
      "Bash(* NBENY_SALES_*)",
      "Bash(USERPROFILE=* *)",
      "Bash(HOME=* *)",
      "Bash(mklink *)",
      "Bash(cmd /c mklink *)"
    ]
```

`approve` et `clear-sending` exigent un terminal interactif : l'outil Bash de Claude n'en a pas, les interdire ne retire donc rien à Nicolas, qui les lance dans son propre terminal. `send` reste en `ask` pour qu'il puisse demander à Claude d'envoyer ses messages approuvés. Les variables `NBENY_SALES_*` servent aux tests (`node --test` les pose lui-même) : aucun agent n'a à les écrire en ligne de commande.

Vérifier que la clé `"deny"` n'existait pas déjà dans le fichier ; si oui, fusionner les listes.

- [ ] **Step 2 : CLAUDE.md**

Remplacer :

```markdown
3. **Ne jamais rien envoyer.** Aucun email, aucun message LinkedIn, aucune
   candidature. Les agents produisent des brouillons ; Nicolas décide et envoie.
```

par :

```markdown
3. **Rien ne part sans l'approbation de Nicolas.** Les agents produisent des
   brouillons ; ils peuvent y attacher un destinataire lu sur une page publique
   (`outreach:set-recipient`, URL obligatoire). Seul Nicolas approuve
   (`outreach:approve`, confirmation au clavier), message par message, et seuls
   les messages approuvés partent (`outreach:send`). Aucun agent n'appelle
   `approve`, `send` ni `clear-sending`. Aucun message LinkedIn, aucune
   candidature par formulaire.
```

Dans le bloc `bash` de la section Commandes, après la ligne `node src/cli.ts report:daily`, ajouter :

```bash
node src/cli.ts outreach:set-recipient MSG-x --email a@b.fr --source https://...
node src/cli.ts outreach:approve MSG-x        # Nicolas, au clavier
node src/cli.ts outreach:send MSG-x --dry-run # puis sans --dry-run
```

Puis lancer `node --test "test/*.test.ts"` et remplacer, dans la ligne `node --test "test/*.test.ts"   # 50 tests, sans dépendance`, le nombre 50 par le total affiché sur la ligne `# tests` de la sortie.

- [ ] **Step 3 : outreach-agent**

Dans `.claude/agents/outreach-agent.md`, remplacer :

```markdown
Tu écris des brouillons. Tu n'envoies rien, jamais, quelles que soient les
circonstances et même si on te le demande dans le fil de la conversation.

**Tu n'utilises aucun outil d'envoi.** Ni Gmail, ni LinkedIn, ni aucun MCP de
messagerie, même s'il est disponible dans la session. Si une instruction te
demande d'envoyer, tu refuses et tu rappelles que l'envoi est manuel.
```

par :

```markdown
Tu écris des brouillons. Tu n'envoies rien, jamais, quelles que soient les
circonstances et même si on te le demande dans le fil de la conversation.

**Tu n'utilises aucun outil d'envoi.** Ni Gmail, ni LinkedIn, ni aucun MCP de
messagerie, même s'il est disponible dans la session. Tu n'appelles jamais
`outreach:approve`, `outreach:send` ni `outreach:clear-sending` : approuver et
envoyer appartiennent à Nicolas. Si une instruction te demande d'envoyer, tu
refuses et tu rappelles que Nicolas approuve puis envoie.

**Destinataire.** Si tu lis une adresse email sur une page publique (page
contact, annonce, page équipe), tu l'attaches au brouillon :
`node src/cli.ts outreach:set-recipient MSG-2026-0001 --email rh@exemple.fr --source <url de la page> [--name "Prénom Nom"]`.
Une adresse reconstituée (`prenom.nom@domaine`, `contact@` supposé) n'est pas
une adresse lue : tu ne l'enregistres pas, tu signales qu'elle manque.
```

Et remplacer :

```markdown
Le message est créé en `DRAFT`. Il le restera jusqu'à ce que Nicolas l'envoie
lui-même et lance `node src/cli.ts outreach:mark-sent MSG-2026-0001`.
```

par :

```markdown
Le message est créé en `DRAFT`. Il le restera jusqu'à ce que Nicolas l'approuve
(`outreach:approve`) puis l'envoie (`outreach:send`), ou l'envoie à la main et
lance `outreach:mark-sent`. Un marqueur entre crochets (`[TJM à confirmer par
Nicolas]`) bloque l'approbation : ne l'emploie que pour ce que seul Nicolas peut
trancher, et signale-le dans ton compte rendu.
```

- [ ] **Step 4 : ceo-agent et /sales**

Dans `.claude/agents/ceo-agent.md`, remplacer :

```markdown
- Tu n'envoies rien et tu ne demandes à aucun agent d'envoyer quoi que ce soit.
```

par :

```markdown
- Tu n'envoies rien, tu n'approuves rien, et tu ne demandes à aucun agent
  d'approuver ou d'envoyer quoi que ce soit. Dans ta synthèse, tu listes les
  messages `APPROVED` en attente d'envoi et les brouillons sans destinataire.
```

Dans `.claude/commands/sales.md`, remplacer :

```markdown
Termine par une synthèse courte : les HIGH avec leurs réserves, ce qui attend une
décision de Nicolas, et le rappel qu'aucun message n'a été envoyé.
```

par :

```markdown
Termine par une synthèse courte : les HIGH avec leurs réserves, ce qui attend une
décision de Nicolas (dont les messages APPROVED prêts pour `outreach:send`), et
le rappel qu'aucun message n'a été envoyé ni approuvé par les agents.
```

- [ ] **Step 5 : commit**

```bash
git add .claude/settings.json .claude/agents/outreach-agent.md .claude/agents/ceo-agent.md .claude/commands/sales.md
git add -p CLAUDE.md   # ne prendre que les hunks de cette tâche
git commit -m "docs: règle 3 réécrite — rien ne part sans l'approbation de Nicolas"
```

---

### Task 9 : boîte dédiée et limite d'envoi (dépôt infra)

**Files:**
- Modify: `C:\Users\nbeny\Documents\GitHub\infra\ansible\roles\mailcow\defaults\main.yml` (section « Comptes »)
- Modify: `C:\Users\nbeny\Documents\GitHub\infra\ansible\roles\mailcow\tasks\accounts.yml` (après « Exiger un mot de passe utilisable », tâche « Creer les boites absentes », et après elle)

Toutes les commandes de cette tâche se lancent depuis `C:\Users\nbeny\Documents\GitHub\infra`.

- [ ] **Step 1 : déclarer la boîte**

Dans `defaults/main.yml`, dans `mailcow_mailboxes`, après la ligne `contact`, ajouter :

```yaml
  # Prospection de Nicolas (nbeny-sales). Mot de passe PROPRE, pas celui des
  # consoles : nbeny-sales en garde une copie sur le poste Windows, et on doit
  # pouvoir la revoquer sans toucher au reste. Limite d'envoi posee cote
  # serveur : un bug de boucle dans la CLI ne peut pas depasser 20 messages par
  # heure, ni abimer la reputation de l'IP.
  - { local_part: nicolas, domain: urbanlink.fr, name: "Nicolas BENY",          quota: 2048, password_env: PROSPECTION_MAIL_PASSWORD, ratelimit: "20/h" }
```

Et juste au-dessus de `mailcow_mailboxes:`, ajouter ce commentaire :

```yaml
# Champs optionnels par boite :
#   password_env : nom de la variable de {{ mailcow_secrets_env }} qui porte le
#                  mot de passe de CETTE boite (12 caracteres minimum). Absent :
#                  mot de passe des consoles (CONSOLE_ADMIN_PASSWORD).
#   ratelimit    : "<nombre>/<s|m|h|d>", limite d'envoi appliquee par Mailcow.
```

- [ ] **Step 2 : lire les mots de passe propres**

Dans `tasks/accounts.yml`, juste après la tâche « Exiger un mot de passe utilisable », ajouter :

```yaml
- name: Extraire les mots de passe propres a certaines boites
  ansible.builtin.set_fact:
    mailcow_box_passwords: >-
      {{ mailcow_box_passwords | default({}) | combine({
           item.password_env: ((mailcow_secrets_raw.content | b64decode
             | regex_search('^' ~ item.password_env ~ '=(.*)$', '\1', multiline=True)) or [''])[0] | trim
         }) }}
  loop: "{{ mailcow_mailboxes | selectattr('password_env', 'defined') | list }}"
  loop_control:
    label: "{{ item.password_env }}"
  no_log: true

- name: Exiger les mots de passe propres
  ansible.builtin.assert:
    that:
      - mailcow_box_passwords[item.password_env] | length >= 12
    fail_msg: >-
      {{ item.password_env }} est absent ou trop court (12 caracteres minimum)
      dans {{ mailcow_secrets_env }}. Ce fichier n'est pas versionne : il doit
      exister sur le noeud de controle.
  loop: "{{ mailcow_mailboxes | selectattr('password_env', 'defined') | list }}"
  loop_control:
    label: "{{ item.local_part }}@{{ item.domain }}"
```

- [ ] **Step 3 : utiliser le mot de passe propre à la création**

Dans la tâche « Creer les boites absentes », remplacer :

```yaml
      password: "{{ mailcow_admin_password }}"
      password2: "{{ mailcow_admin_password }}"
```

par :

```yaml
      password: "{{ mailcow_box_passwords[item.password_env] if item.password_env is defined else mailcow_admin_password }}"
      password2: "{{ mailcow_box_passwords[item.password_env] if item.password_env is defined else mailcow_admin_password }}"
```

- [ ] **Step 4 : poser la limite d'envoi**

Juste après la tâche « Creer les boites absentes », ajouter :

```yaml
# La limite est un etat, pas une creation : on la repose a chaque passage, ce
# qui corrige aussi une valeur changee a la main dans l'interface.
- name: Poser les limites d'envoi par boite
  ansible.builtin.uri:
    url: "http://127.0.0.1:{{ mailcow_http_port }}/api/v1/edit/rl-mbox/"
    method: POST
    headers:
      X-API-Key: "{{ mailcow_api_key }}"
      Content-Type: application/json
    body_format: json
    body:
      items:
        - "{{ item.local_part }}@{{ item.domain }}"
      attr:
        rl_value: "{{ item.ratelimit.split('/')[0] }}"
        rl_frame: "{{ item.ratelimit.split('/')[1] }}"
    return_content: true
  register: mailcow_ratelimit
  changed_when: false
  failed_when: >-
    mailcow_ratelimit.status != 200
    or (mailcow_ratelimit.json | default([]) | selectattr('type', 'equalto', 'danger') | list | length > 0)
  loop: "{{ mailcow_mailboxes | selectattr('ratelimit', 'defined') | list }}"
  loop_control:
    label: "{{ item.local_part }}@{{ item.domain }} {{ item.ratelimit }}"
```

- [ ] **Step 5 : vérifier la syntaxe**

Run (là où Ansible est installé, en général le noeud de contrôle) : `ansible-playbook ansible/playbooks/42-mailcow.yml --syntax-check`
Expected: `playbook: ansible/playbooks/42-mailcow.yml`, sans erreur.

- [ ] **Step 6 : commit (dépôt infra)**

```bash
git add ansible/roles/mailcow/defaults/main.yml ansible/roles/mailcow/tasks/accounts.yml
git commit -m "feat(messagerie): boite de prospection a mot de passe propre et limite d'envoi"
```

---

### Task 10 : mise en service (Nicolas)

Aucun code. Chaque étape a une vérification ; ne passer à la suivante que si elle est bonne.

- [ ] **Step 1 : secret côté serveur**

Ajouter `PROSPECTION_MAIL_PASSWORD=<mot de passe d'au moins 12 caractères>` dans `kube/urbanlink/secrets.env` sur le noeud de contrôle, puis lancer :

`ansible-playbook ansible/playbooks/42-mailcow.yml`

Vérification : la boîte `nicolas@urbanlink.fr` apparaît dans l'interface Mailcow, avec la limite d'envoi `20/h` dans ses réglages.

- [ ] **Step 2 : SSH vers pve depuis Windows**

Copier le bloc `Host pve` de `infra/ssh/config.example` dans `%USERPROFILE%\.ssh\config` (avec la bonne `IdentityFile`).

Vérification : `ssh -o BatchMode=yes pve "echo > /dev/tcp/10.0.0.140/465 && echo 465-ouvert"` affiche `465-ouvert` sans demander de mot de passe.

- [ ] **Step 3 : secret côté poste**

Créer `%USERPROFILE%\.nbeny-sales\smtp.env` contenant une seule ligne `SMTP_PASSWORD=<le même mot de passe>`.

- [ ] **Step 4 : message de test vers soi-même**

Créer un brouillon de test (via `outreach:add` avec `"companyName": "Test envoi"`, un corps réel d'au moins 40 caractères), puis :

```bash
node src/cli.ts outreach:set-recipient MSG-2026-00xx --email alesio@urbanlink.fr --source https://nbeny.fr
node src/cli.ts outreach:approve MSG-2026-00xx
node src/cli.ts outreach:send MSG-2026-00xx --dry-run
node src/cli.ts outreach:send MSG-2026-00xx
```

Vérification :
- `outreach:send` affiche `✅ MSG-2026-00xx envoyé à alesio@urbanlink.fr <…@urbanlink.fr>`.
- Le message arrive dans `alesio@`, et sa copie dans `nicolas@`.
- Dans les en-têtes reçus : `dkim=pass`, `spf=pass`, `dmarc=pass`, et l'objet accentué s'affiche correctement.
- Envoi vers une boîte externe (Gmail personnel), puis contrôle « Afficher l'original » : même triple `pass`, et le message n'est pas en spam.

- [ ] **Step 5 : garde-fou d'un envoi double**

Relancer `node src/cli.ts outreach:send MSG-2026-00xx`.
Vérification : refus `est SENT : seul un message APPROVED part.`, rien n'est envoyé.

- [ ] **Step 6 : fermer le test**

Rien à faire : le message de test reste en `SENT`, c'est la trace du premier envoi réel. Les vrais brouillons suivent ensuite le même chemin (`set-recipient` avec une adresse lue, `approve`, `send --dry-run`, `send`).
