/**
 * Rendu du rapport quotidien.
 *
 * Le rapport est produit par le code à partir de `data/`, jamais rédigé par un
 * agent : c'est ce qui garantit que les chiffres affichés sont ceux de la base,
 * et que les points faibles d'une opportunité sont imprimés à côté de son score.
 */
import type { Followup, Opportunity, OutreachMessage } from './types.ts'

export interface ReportInput {
  date: string
  opportunities: Opportunity[]
  outreach: OutreachMessage[]
  followups: Followup[]
  companies: { id: string; name: string; website?: string; reason_to_contact?: string; sourceUrl?: string }[]
  market: { id: string; headline: string; sourceUrl: string; observedAt: string; whyItMatters?: string }[]
  /** Nombre de jours en arrière considérés comme « nouveau ». */
  windowDays?: number
  /** Messages dont l'envoi a été interrompu (`orphanSendings` sur le journal) : calculés par l'appelant, le rendu reste pur. */
  interruptedSends?: string[]
}

/** Où vérifier qu'un message est parti : l'envoi SMTP ne dépose rien dans le dossier des messages envoyés. */
const EVIDENCE = 'la copie cachée dans la boîte de réception de nicolas@urbanlink.fr (ou le journal Postfix)'

function recipientLabel(m: OutreachMessage): string {
  return m.to ? (m.to.name ? m.to.name + ' <' + m.to.email + '>' : m.to.email) : 'sans destinataire'
}

function draftLine(m: OutreachMessage): string {
  let next: string
  if (m.channel !== 'email') {
    next = 'canal ' + m.channel + ' : rien ne part par la CLI. Envoyer à la main, puis `node src/cli.ts outreach:mark-sent ' + m.id + '`'
  } else if (!m.to) {
    next = 'trouver l\'adresse sur une page publique, puis `node src/cli.ts outreach:set-recipient ' + m.id + ' --email <adresse> --source <url>`'
  } else {
    next = 'relire et approuver dans un terminal : `node src/cli.ts outreach:approve ' + m.id + '`'
  }
  return '- `' + m.id + '` → **' + m.companyName + '** (' + m.channel + ', ' + m.audience + ') · ' + recipientLabel(m) +
    '\n  - Objet : ' + m.subject +
    '\n  - Pourquoi : ' + m.reason +
    '\n  - Suite : ' + next
}

const BADGE = { HIGH: '🔥', MEDIUM: '🟠', LOW: '⚪' } as const

function isRecent(iso: string, days: number, now: Date): boolean {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  return now.getTime() - t <= days * 86_400_000
}

function contractOf(opp: Opportunity): string {
  return opp.facts.contract?.value ?? 'unknown'
}

function line(opp: Opportunity): string {
  const m = opp.match
  const badge = m ? BADGE[m.priority] : '⚪'
  const score = m ? m.score + '/100 (couverture ' + m.coverage + '/8)' : 'non scorée'
  return badge + ' **' + opp.title + '** — ' + opp.company + ' · ' + score + ' · [' + opp.sourceName + '](' + opp.sourceUrl + ') · `' + opp.id + '`'
}

function detail(opp: Opportunity): string {
  const out: string[] = [line(opp)]
  const m = opp.match
  if (m) {
    for (const s of m.strengths) out.push('  - ✅ ' + s)
    for (const w of m.weaknesses) out.push('  - ⚠️ ' + w)
  }
  for (const a of opp.assumptions) {
    out.push('  - ⚠️ Hypothèse non vérifiée — ' + a.field + ' : ' + String(a.value) + ' (' + a.rationale + ')')
  }
  return out.join('\n')
}

function section(title: string, body: string[]): string {
  return '## ' + title + '\n\n' + (body.length ? body.join('\n\n') : '_Rien à signaler sur la période._') + '\n'
}

export function buildDailyReport(input: ReportInput): string {
  const now = new Date(input.date)
  const days = input.windowDays ?? 1
  const recent = input.opportunities.filter((o) => isRecent(o.discoveredAt, days, now))
  const byScore = (a: Opportunity, b: Opportunity) => (b.match?.score ?? -1) - (a.match?.score ?? -1)

  const top = [...recent].sort(byScore).slice(0, 8)
  const freelance = [...input.opportunities]
    .filter((o) => ['freelance', 'both'].includes(contractOf(o)) && !['LOST', 'WON'].includes(o.stage))
    .sort(byScore)
    .slice(0, 6)
  const cdi = [...input.opportunities]
    .filter((o) => ['cdi', 'both'].includes(contractOf(o)) && !['LOST', 'WON'].includes(o.stage))
    .sort(byScore)
    .slice(0, 6)

  const drafts = input.outreach.filter((m) => m.status === 'DRAFT')
  const approved = input.outreach.filter((m) => m.status === 'APPROVED')
  const sent = input.outreach.filter((m) => m.status === 'SENT')
  const interrupted = input.interruptedSends ?? []
  const dueFollowups = input.followups.filter(
    (f) => f.nextActionAt && Date.parse(f.nextActionAt) <= now.getTime() && !['WON', 'LOST'].includes(f.status),
  )

  const contacted = input.followups.filter((f) => f.status !== 'NEW').length
  const replied = input.followups.filter((f) => ['REPLIED', 'INTERVIEW', 'NEGOTIATION', 'WON'].includes(f.status)).length
  const interviews = input.followups.filter((f) => ['INTERVIEW', 'NEGOTIATION', 'WON'].includes(f.status)).length
  const qualified = input.opportunities.filter((o) => o.match && o.match.priority !== 'LOW').length
  const rate = contacted ? Math.round((replied / contacted) * 100) : 0

  const parts: string[] = []
  parts.push('# Daily Sales Report — ' + input.date.slice(0, 10) + '\n')
  parts.push(
    '> Généré par `node src/cli.ts report:daily`. Chaque ligne renvoie à sa source. ' +
    'Un ⚠️ marque une information non vérifiée : elle ne compte pas dans le score.\n',
  )

  parts.push(section('🔥 Nouvelles opportunités', top.map(detail)))
  parts.push(section('💼 Freelance', freelance.map(line)))
  parts.push(section('🏢 CDI', cdi.map(line)))
  parts.push(
    section(
      '🎯 Prospection directe',
      input.companies.slice(0, 8).map(
        (c) => '- **' + c.name + '**' + (c.website ? ' — ' + c.website : '') + (c.reason_to_contact ? '\n  - Raison : ' + c.reason_to_contact : '') + (c.sourceUrl ? '\n  - Source : ' + c.sourceUrl : ''),
      ),
    ),
  )
  parts.push(
    section(
      '📈 Signaux business',
      input.market.slice(0, 8).map((s) => '- ' + s.headline + ' — [source](' + s.sourceUrl + ') · ' + s.observedAt.slice(0, 10) + (s.whyItMatters ? '\n  - Pourquoi c\'est pertinent : ' + s.whyItMatters : '')),
    ),
  )
  parts.push(section('✉️ Brouillons à relire (NON envoyés)', drafts.map(draftLine)))
  parts.push(
    section(
      '📤 Approuvés, en attente d\'envoi',
      approved.map(
        (m) => '- `' + m.id + '` → **' + m.companyName + '** · ' + recipientLabel(m) +
          '\n  - Objet : ' + m.subject +
          '\n  - Suite : `node src/cli.ts outreach:send ' + m.id + ' --dry-run`, puis sans `--dry-run`',
      ),
    ),
  )
  parts.push(
    section(
      '⚠️ Envois interrompus',
      interrupted.map((id) => {
        const m = input.outreach.find((o) => o.id === id)
        return '- `' + id + '`' + (m ? ' → **' + m.companyName + '** · ' + recipientLabel(m) : '') +
          '\n  - On ne sait pas s\'il est parti. Vérifier ' + EVIDENCE +
          ', puis `node src/cli.ts outreach:mark-sent ' + id + '` (parti) ou `node src/cli.ts outreach:clear-sending ' + id + '` (pas parti)'
      }),
    ),
  )
  parts.push(
    section(
      '🔁 Follow-ups',
      dueFollowups.map(
        (f) => '- `' + f.id + '` **' + f.company + '** — ' + f.contactLabel + ' · statut ' + f.status + ' · dernier contact ' + f.lastTouchAt.slice(0, 10) + (f.recommendation ? '\n  - Recommandation : ' + f.recommendation : ''),
      ),
    ),
  )

  parts.push(
    [
      '## 📊 Statistiques',
      '',
      '| Indicateur | Valeur |',
      '| --- | --- |',
      '| Nouvelles opportunités (' + days + ' j) | ' + recent.length + ' |',
      '| Opportunités en base | ' + input.opportunities.length + ' |',
      '| Opportunités qualifiées (HIGH ou MEDIUM) | ' + qualified + ' |',
      '| Entreprises en prospection | ' + input.companies.length + ' |',
      '| Messages en brouillon | ' + drafts.length + ' |',
      '| Brouillons sans destinataire | ' + drafts.filter((m) => !m.to).length + ' |',
      '| Messages approuvés en attente | ' + approved.length + ' |',
      '| Messages envoyés | ' + sent.length + ' |',
      '| Envois interrompus | ' + interrupted.length + ' |',
      '| Contacts engagés | ' + contacted + ' |',
      '| Réponses obtenues | ' + replied + ' |',
      '| Entretiens | ' + interviews + ' |',
      '| Taux de réponse | ' + rate + ' % |',
      '',
    ].join('\n'),
  )

  return parts.join('\n')
}
