/**
 * Rendu console des opportunités.
 *
 * Deux niveaux : une ligne par opportunité pour balayer, ou une fiche complète
 * pour décider. Dans les deux cas la couverture est affichée à côté du score —
 * un 100/100 sur 4 dimensions et un 82/100 sur 8 ne se valent pas, et la ligne
 * doit le montrer sans qu'on ait à ouvrir la fiche.
 */
import type { Money, Opportunity } from './types.ts'
import { remotePolicy } from './query.ts'

const BADGE = { HIGH: '🔥', MEDIUM: '🟠', LOW: '⚪' } as const

function money(m?: Money & { period?: string }): string {
  if (!m) return '—'
  const unit = m.period === 'year' ? ' €/an' : ' €/j'
  const amount = m.min === m.max || m.max === undefined ? String(m.min) : m.min + '–' + m.max
  return amount + unit
}

function scoreCell(opp: Opportunity): string {
  const m = opp.match
  if (!m) return '  — non scorée'
  return String(m.score).padStart(3) + '/100 (' + m.coverage + '/8)'
}

/** Télétravail en une cellule de largeur fixe : full remote ou non se voit sans ouvrir la fiche. */
export function remoteCell(opp: Opportunity): string {
  const days = opp.facts.onsiteDaysPerWeek?.value
  switch (remotePolicy(opp)) {
    case 'full': return '🌍 ' + 'Full remote'.padEnd(11)
    case 'hybrid': return '🔀 ' + ('Hybride ' + (typeof days === 'number' ? days + 'j' : '?j')).padEnd(11)
    case 'onsite': return '🏢 ' + 'Présentiel'.padEnd(11)
    default: return '❔ ' + 'Non précisé'.padEnd(11)
  }
}

export function formatCompact(opp: Opportunity): string {
  const m = opp.match
  const badge = m ? BADGE[m.priority] : '⚪'
  return [
    opp.id,
    badge + ' ' + (m ? m.priority.padEnd(6) : 'NONE  '),
    scoreCell(opp),
    remoteCell(opp),
    opp.stage.padEnd(14),
    opp.company + ' — ' + opp.title + (opp.facts.location ? '  · ' + opp.facts.location.value : ''),
  ].join('  ')
}

/** Fiche complète : tout ce qu'il faut pour décider sans rouvrir l'annonce. */
export function formatDetailed(opp: Opportunity): string {
  const m = opp.match
  const badge = m ? BADGE[m.priority] : '⚪'
  const f = opp.facts


  const rows: [string, string][] = [
    ['Entreprise', opp.company],
    ['Poste', opp.title],
    ['Lieu', f.location?.value ?? '—'],
    ['Télétravail', remoteCell(opp).trimEnd()],
    ['Contrat', f.contract?.value ?? '—'],
    ['Rémunération', f.tjm ? money(f.tjm.value) : f.salary ? money(f.salary.value) : '—'],
    ['Stack', f.technologies?.value.join(', ') ?? '—'],
    ['Durée', typeof f.durationMonths?.value === 'number' ? f.durationMonths.value + ' mois' : '—'],
    ['Démarrage', f.startDate?.value ?? '—'],
    ['Secteur', f.sector?.value ?? '—'],
    ['Étape', opp.stage],
    ['Source', opp.sourceName + ' — ' + opp.sourceUrl],
  ]

  const lines = [badge + ' ' + opp.id + '  ' + scoreCell(opp) + (m ? '  ' + m.priority : '')]
  for (const [label, value] of rows) lines.push('   ' + (label + ' ').padEnd(14, '.') + ' ' + value)

  if (m) {
    for (const s of m.strengths) lines.push('   ✅ ' + s)
    for (const w of m.weaknesses) lines.push('   ⚠️  ' + w)
  }
  for (const a of opp.assumptions) {
    lines.push('   ⚠️  Hypothèse — ' + a.field + ' : ' + String(a.value) + ' (' + a.rationale + ')')
  }
  if (opp.notes) lines.push('   📝 ' + opp.notes)

  return lines.join('\n')
}
