import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildDailyReport, type ReportInput } from '../src/lib/report.ts'
import type { OutreachMessage } from '../src/lib/types.ts'

function message(over: Partial<OutreachMessage>): OutreachMessage {
  return {
    id: 'MSG-2026-0001',
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
    ...over,
  }
}

const TO = { email: 'rh@acme.example', sourceUrl: 'https://acme.example/contact', readAt: '2026-09-25T00:00:00Z' }

function report(outreach: OutreachMessage[], interruptedSends: string[] = []): string {
  const input: ReportInput = {
    date: '2026-09-28T08:00:00Z',
    opportunities: [],
    outreach,
    followups: [],
    companies: [],
    market: [],
    interruptedSends,
  }
  return buildDailyReport(input)
}

describe('rapport — messages', () => {
  test('brouillon sans destinataire : le dit, et la suite est outreach:set-recipient', () => {
    const md = report([message({ id: 'MSG-2026-0001' })])
    assert.match(md, /`MSG-2026-0001`[^\n]*sans destinataire/)
    assert.match(md, /outreach:set-recipient MSG-2026-0001/)
  })

  test('brouillon avec destinataire : l\'adresse, et la suite est outreach:approve dans un terminal', () => {
    const md = report([message({ id: 'MSG-2026-0002', to: TO })])
    assert.match(md, /`MSG-2026-0002`[^\n]*rh@acme\.example/)
    assert.match(md, /outreach:approve MSG-2026-0002/)
    assert.match(md, /terminal/)
  })

  test('message approuvé : en attente, suite outreach:send --dry-run puis sans', () => {
    const md = report([message({ id: 'MSG-2026-0003', status: 'APPROVED', to: TO, approvedAt: '2026-09-27T10:00:00Z' })])
    assert.match(md, /Approuvés, en attente d'envoi/)
    assert.match(md, /outreach:send MSG-2026-0003 --dry-run/)
  })

  test('envoi interrompu : vérifier la copie cachée, puis mark-sent ou clear-sending', () => {
    const md = report([message({ id: 'MSG-2026-0004', status: 'APPROVED', to: TO })], ['MSG-2026-0004'])
    assert.match(md, /Envois interrompus/)
    assert.match(md, /copie cachée dans la boîte de réception de nicolas@urbanlink\.fr \(ou le journal Postfix\)/)
    assert.match(md, /outreach:mark-sent MSG-2026-0004/)
    assert.match(md, /outreach:clear-sending MSG-2026-0004/)
  })

  test('plus aucune consigne d\'envoi à la main pour un email', () => {
    const md = report([message({ id: 'MSG-2026-0005', to: TO })])
    assert.doesNotMatch(md, /envoyer à la main/i)
  })

  test('canal LinkedIn : l\'envoi à la main reste l\'alternative, avec mark-sent', () => {
    const md = report([message({ id: 'MSG-2026-0006', channel: 'linkedin' })])
    assert.match(md, /à la main[^\n]*outreach:mark-sent MSG-2026-0006/)
  })

  test('statistiques : brouillons, approuvés, envoyés, sans destinataire, interrompus', () => {
    const md = report(
      [
        message({ id: 'MSG-1' }),
        message({ id: 'MSG-2', to: TO }),
        message({ id: 'MSG-3', status: 'APPROVED', to: TO }),
        message({ id: 'MSG-4', status: 'SENT', to: TO, sentAt: '2026-09-27T10:00:00Z' }),
      ],
      ['MSG-3'],
    )
    assert.match(md, /\| Messages en brouillon \| 2 \|/)
    assert.match(md, /\| Brouillons sans destinataire \| 1 \|/)
    assert.match(md, /\| Messages approuvés en attente \| 1 \|/)
    assert.match(md, /\| Messages envoyés \| 1 \|/)
    assert.match(md, /\| Envois interrompus \| 1 \|/)
  })
})
