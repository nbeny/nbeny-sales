/**
 * Règles d'approbation et d'envoi des messages. Pur : aucune I/O, pour que
 * chaque garde-fou soit testé sans réseau et sans toucher à `data/`.
 */
import { createHash } from 'node:crypto'
import { TERMINAL_STAGES, type Opportunity, type OutreachMessage } from './types.ts'
import { findHiddenCharacters, findPlaceholders } from './validate.ts'
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

/**
 * Empreinte de ce que Nicolas a lu au moment d'approuver. L'expéditeur vient
 * de config/mail.json et n'y entre pas.
 */
export function approvalHash(m: Pick<OutreachMessage, 'to' | 'subject' | 'body'>): string {
  return createHash('sha256')
    .update(JSON.stringify([m.to?.email ?? '', m.to?.name ?? '', m.subject, m.body]))
    .digest('hex')
    .slice(0, 16)
}

/** Où vérifier qu'un message interrompu est parti : l'envoi SMTP ne laisse aucune copie dans le dossier des messages envoyés. */
export function sentEvidence(config: Pick<MailConfig, 'from'>): string {
  return 'la copie cachée dans la boîte de réception de ' + config.from.email + ' (ou le journal Postfix)'
}

function isClosed(opportunity: Opportunity | undefined): opportunity is Opportunity {
  return !!opportunity && (TERMINAL_STAGES as readonly string[]).includes(opportunity.stage)
}

function commonIssues(m: OutreachMessage, opportunity: Opportunity | undefined): string[] {
  const issues: string[] = []
  if (m.channel !== 'email') issues.push('Canal `' + m.channel + '` : seuls les emails partent par la CLI.')
  if (!m.to) issues.push('Aucun destinataire : lance d\'abord outreach:set-recipient ' + m.id + '.')
  if (m.opportunityId && !opportunity) {
    issues.push('Opportunité ' + m.opportunityId + ' introuvable : impossible de vérifier qu\'elle est encore ouverte.')
  }
  if (isClosed(opportunity)) {
    issues.push('L\'opportunité ' + opportunity.id + ' est ' + opportunity.stage + ' : on n\'écrit pas pour une annonce close.')
  }
  const markers = findPlaceholders(m.subject + '\n' + m.body)
  if (markers.length) {
    issues.push('Marqueurs à compléter : ' + markers.join(', ') + '. Corrige avec outreach:edit ' + m.id + '.')
  }
  const hidden = findHiddenCharacters(m.subject + '\n' + m.body)
  if (hidden.length) {
    issues.push('Caractères invisibles ou de contrôle dans l\'objet ou le corps : ' + hidden.join(', ') + '. Corrige avec outreach:edit ' + m.id + '.')
  }
  if (m.to) {
    const hiddenTo = findHiddenCharacters([m.to.email, m.to.name ?? '', m.to.sourceUrl].join('\n'))
    if (hiddenTo.length) {
      issues.push('Caractères invisibles ou de contrôle dans le destinataire (adresse, nom ou source) : ' + hiddenTo.join(', ') + '. Corrige avec outreach:set-recipient ' + m.id + '.')
    }
  }
  return issues
}

export function approvalIssues(m: OutreachMessage, opportunity?: Opportunity): string[] {
  const issues: string[] = []
  if (m.status === 'SENT') issues.push(m.id + ' est déjà envoyé.')
  issues.push(...commonIssues(m, opportunity))
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

/** Envois réussis un jour UTC donné (`YYYY-MM-DD`, comme le journal) : le plafond repart à 02:00 heure de Paris en été. */
export function sentCountOn(events: HistoryEvent[], day: string): number {
  return events.filter((e) => e.event === 'outreach:sent' && e.at.startsWith(day)).length
}

function lastSentTo(email: string, outreach: OutreachMessage[], now: Date, days: number): OutreachMessage | undefined {
  const since = now.getTime() - days * 86_400_000
  const target = email.trim().toLowerCase()
  return outreach.find(
    (o) => o.status === 'SENT' && o.to?.email.trim().toLowerCase() === target && !!o.sentAt && Date.parse(o.sentAt) >= since,
  )
}

export function sendIssues(m: OutreachMessage, ctx: SendContext): string[] {
  const issues: string[] = []
  if (m.status !== 'APPROVED') issues.push(m.id + ' est ' + m.status + ' : seul un message APPROVED part.')
  issues.push(...commonIssues(m, ctx.opportunity))
  if (m.status === 'APPROVED' && m.approvedHash !== approvalHash(m)) {
    issues.push('Le message a changé depuis son approbation : relis-le et réapprouve-le (outreach:approve ' + m.id + ').')
  }
  // Le journal fait foi même si data/outreach.json a été réécrit par une copie périmée.
  if (ctx.events.some((e) => e.id === m.id && (e.event === 'outreach:sent' || e.event === 'outreach:mark-sent'))) {
    issues.push(m.id + ' a déjà été envoyé (journal) : il ne repart pas.')
  }
  if (orphanSendings(ctx.events).includes(m.id)) {
    issues.push(
      // L'envoi SMTP ne dépose aucune copie dans le dossier des messages envoyés : la preuve est la copie cachée.
      'Un envoi de ' + m.id + ' a été interrompu : on ne sait pas s\'il est parti. Vérifie ' + sentEvidence(ctx.config) +
        ', puis outreach:mark-sent ' + m.id + ' ou outreach:clear-sending ' + m.id + '.',
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
