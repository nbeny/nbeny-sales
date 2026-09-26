import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { escapeForDisplay, findHiddenCharacters, findPlaceholders, validateRecipient } from '../src/lib/validate.ts'
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

  test('opportunité liée introuvable : refusé', () => {
    assert.ok(approvalIssues(draft(), undefined).some((i) => i.includes('introuvable')))
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

  test('adresse avec espaces et majuscules contactée il y a 10 jours : cooldown quand même détecté', () => {
    const previous = draft({
      id: 'MSG-2026-0002',
      status: 'SENT',
      sentAt: '2026-09-18T10:00:00Z',
      to: { email: ' RH@acme.example ', sourceUrl: 'https://acme.example/contact', readAt: '2026-09-17T00:00:00Z' },
    })
    assert.ok(sendIssues(approved(), ctx({ outreach: [previous] })).some((i) => i.includes('a déjà reçu')))
  })

  test('opportunité liée introuvable : refusé', () => {
    assert.ok(sendIssues(approved(), ctx({ opportunity: undefined })).some((i) => i.includes('introuvable')))
  })

  test('sans opportunité liée : pas de vérification exigée', () => {
    assert.deepEqual(sendIssues(approved({ opportunityId: undefined }), ctx({ opportunity: undefined })), [])
  })

  test('marqueur réapparu après approbation : bloqué même avec une empreinte à jour', () => {
    const m = approved({ body: 'Bonjour, message avec un marqueur [TODO] resté après édition manuelle.' })
    assert.ok(sendIssues(m, ctx()).some((i) => i.includes('Marqueurs à compléter')))
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

describe('findHiddenCharacters', () => {
  test('texte ordinaire, accents, retours à la ligne et tabulations : rien', () => {
    assert.deepEqual(findHiddenCharacters('Bonjour Élodie,\n\tçà et là — « merci ».'), [])
  })

  test('CR, échappement ANSI, DEL et C1 : signalés une seule fois chacun, dans l\'ordre', () => {
    assert.deepEqual(findHiddenCharacters('a\r\nb\u001b[31m\u001bc\u007f\u0085\r'), ['U+000D', 'U+001B', 'U+007F', 'U+0085'])
  })

  test('largeur nulle, contrôles bidirectionnels, BOM : signalés', () => {
    assert.deepEqual(
      findHiddenCharacters('x\u200by\u200fz\u202ew\u2060v\u2064u\u2066t\u2069s\ufeff'),
      ['U+200B', 'U+200F', 'U+202E', 'U+2060', 'U+2064', 'U+2066', 'U+2069', 'U+FEFF'],
    )
  })

  test('NUL : signalé', () => {
    assert.deepEqual(findHiddenCharacters('a\u0000b'), ['U+0000'])
  })
})

describe('validateRecipient — nom', () => {
  const base = { email: 'rh@acme.example', sourceUrl: 'https://acme.example/contact' }

  test('nom ordinaire : accepté', () => {
    assert.deepEqual(validateRecipient({ ...base, name: 'Élodie Martin' }), [])
  })

  test('nom avec caractère invisible : refusé', () => {
    const issues = validateRecipient({ ...base, name: 'Élodie\u202eMartin' })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /--name.*U\+202E/)
  })

  test('nom commençant par un tiret (valeur de --name oubliée) : refusé', () => {
    const issues = validateRecipient({ ...base, name: '--source' })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /--name/)
  })
})

describe('caractères invisibles dans un message', () => {
  test('approbation refusée si le corps contient un caractère de contrôle', () => {
    const issues = approvalIssues(draft({ body: 'Bonjour,\u001b[2J un message assez long pour passer la validation.' }), opportunity('OUTREACH_READY'))
    assert.ok(issues.some((i) => i.includes('U+001B')))
  })

  test('envoi refusé si l\'objet contient un caractère bidirectionnel, même approuvé avec cette empreinte', () => {
    const m = approved({ subject: 'Votre annonce\u202e Node.js' })
    assert.ok(sendIssues(m, ctx()).some((i) => i.includes('U+202E')))
  })
})

describe('sendIssues — journal', () => {
  test('outreach:sent déjà journalisé pour ce message : refusé', () => {
    const issues = sendIssues(approved(), ctx({ events: [ev('outreach:sending'), ev('outreach:sent')] }))
    assert.ok(issues.includes('MSG-2026-0001 a déjà été envoyé (journal) : il ne repart pas.'))
  })

  test('outreach:mark-sent journalisé pour ce message : refusé', () => {
    const issues = sendIssues(approved(), ctx({ events: [ev('outreach:mark-sent')] }))
    assert.ok(issues.includes('MSG-2026-0001 a déjà été envoyé (journal) : il ne repart pas.'))
  })

  test('envoi journalisé pour un autre message : sans effet', () => {
    assert.deepEqual(sendIssues(approved(), ctx({ events: [ev('outreach:sent', 'MSG-2026-0009')] })), [])
  })
})

const cp = (...points: number[]) => String.fromCodePoint(...points)

describe('findHiddenCharacters — ensemble étendu', () => {
  test('trait d\'union conditionnel U+00AD : signalé', () => {
    assert.deepEqual(findHiddenCharacters('dé' + cp(0xad) + 'veloppeur'), ['U+00AD'])
  })

  test('caractère d\'étiquette U+E0041 : signalé', () => {
    assert.deepEqual(findHiddenCharacters('Node' + cp(0xe0041) + '.js'), ['U+E0041'])
  })

  test('U+034F, U+115F, U+1160, U+3164, U+FFA0, U+E0000, U+E007F : signalés', () => {
    assert.deepEqual(
      findHiddenCharacters(cp(0x34f, 0x115f, 0x1160, 0x3164, 0xffa0, 0xe0000, 0xe007f)),
      ['U+034F', 'U+115F', 'U+1160', 'U+3164', 'U+FFA0', 'U+E0000', 'U+E007F'],
    )
  })

  test('emoji et caractères hors BMP ordinaires : rien', () => {
    assert.deepEqual(findHiddenCharacters('Merci ' + cp(0x1f44d) + ' ' + cp(0x1d11e)), [])
  })
})

describe('escapeForDisplay', () => {
  test('échappe les caractères cachés en \\u{XXXX}, les tabulations en \\t', () => {
    assert.equal(escapeForDisplay('a' + cp(0x1b) + '[8mb\tc' + cp(0x202e) + cp(0xe0041)), 'a\\u{001B}[8mb\\tc\\u{202E}\\u{E0041}')
  })

  test('ligne simple : le saut de ligne est échappé', () => {
    assert.equal(escapeForDisplay('a\nb'), 'a\\u{000A}b')
  })

  test('corps : les sauts de ligne restent de vrais sauts de ligne, \\r est échappé', () => {
    assert.equal(escapeForDisplay('a\r\nb\nc', true), 'a\\u{000D}\nb\nc')
  })

  test('texte ordinaire : inchangé', () => {
    assert.equal(escapeForDisplay('Élodie Martin <rh@acme.example>'), 'Élodie Martin <rh@acme.example>')
  })
})

describe('validateRecipient — source', () => {
  test('source avec séquence d\'échappement : refusée', () => {
    const issues = validateRecipient({ email: 'rh@acme.example', sourceUrl: 'https://x.example/' + cp(0x1b) + '[8mhidden' })
    assert.ok(issues.some((i) => i.includes('--source') && i.includes('U+001B')))
  })
})

describe('commonIssues — destinataire', () => {
  const withTo = (to: Partial<NonNullable<OutreachMessage['to']>>) =>
    draft({ to: { email: 'rh@acme.example', sourceUrl: 'https://acme.example/contact', readAt: '2026-09-27T00:00:00Z', ...to } })

  test('nom du destinataire avec caractère caché : approbation refusée', () => {
    const issues = approvalIssues(withTo({ name: 'Élodie' + cp(0x1b) + '[1A' }), opportunity('OUTREACH_READY'))
    assert.ok(issues.some((i) => i.includes('destinataire') && i.includes('U+001B')))
  })

  test('source du destinataire avec caractère caché : envoi refusé', () => {
    const m = approved()
    m.to = { ...m.to!, sourceUrl: 'https://acme.example/' + cp(0x202e) }
    m.approvedHash = approvalHash(m)
    assert.ok(sendIssues(m, ctx()).some((i) => i.includes('destinataire') && i.includes('U+202E')))
  })

  test('adresse du destinataire avec caractère caché : approbation refusée', () => {
    const issues = approvalIssues(withTo({ email: 'rh' + cp(0x200b) + '@acme.example' }), opportunity('OUTREACH_READY'))
    assert.ok(issues.some((i) => i.includes('destinataire') && i.includes('U+200B')))
  })
})

describe('findHiddenCharacters — séparateurs de ligne et de paragraphe', () => {
  test('U+2028 et U+2029 : signalés', () => {
    assert.deepEqual(findHiddenCharacters('a' + String.fromCodePoint(0x2028) + 'b' + String.fromCodePoint(0x2029)), ['U+2028', 'U+2029'])
  })
})

describe('sendIssues — où vérifier un envoi interrompu', () => {
  test('la copie cachée dans la boîte de réception de l\'expéditeur, ou le journal Postfix (pas le dossier Envoyés)', () => {
    const issue = sendIssues(approved(), ctx({ events: [ev('outreach:sending')] })).find((i) => i.includes('interrompu'))!
    assert.ok(issue.includes('copie cachée dans la boîte de réception de nicolas@urbanlink.fr (ou le journal Postfix)'), issue)
    assert.ok(!issue.includes('Envoyés'))
  })
})
