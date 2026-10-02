/**
 * Application interactive : la CLI au clavier, sans retenir les commandes.
 * ↑↓ pour choisir, Entrée pour ouvrir, Échap pour revenir.
 *
 * Elle lit la base directement pour afficher, mais n'écrit jamais : chaque
 * action relance `node src/cli.ts <commande>` dans le même terminal. La
 * validation, la journalisation et les confirmations au clavier (approbation,
 * envoi) restent donc celles de la CLI, à l'identique.
 *
 *   node src/cli.ts            (sans argument, depuis un terminal)
 *   node src/cli.ts shell
 *   sales.cmd
 *
 * Le menu Agents lance Claude Code via scripts/sales-cron.ps1, avec les mêmes
 * interdits que la tâche planifiée.
 */
import { spawn, spawnSync, execFile } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { styleText } from 'node:util'
import { readCollection, ROOT } from './lib/store.ts'
import { filterOpportunities, SORT_KEYS, type ListCriteria } from './lib/query.ts'
import { formatCompact, formatDetailed } from './lib/format.ts'
import { canTransition } from './lib/pipeline.ts'
import { menu, readKey } from './lib/tui.ts'
import { STAGES, TERMINAL_STAGES, type Followup, type FollowupStatus, type Opportunity, type OutreachMessage, type StageName } from './lib/types.ts'

const CLI = join(ROOT, 'src', 'cli.ts')
const RUN_SCRIPT = join(ROOT, 'scripts', 'sales-cron.ps1')

const bold = (s: string) => styleText('bold', s)
const dim = (s: string) => styleText('dim', s)
const yellow = (s: string) => styleText('yellow', s)
const green = (s: string) => styleText('green', s)

// --- Primitives ------------------------------------------------------------

/** Saisie de texte (email, recherche, note…). Vide = annuler. */
async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.on('SIGINT', () => { rl.close(); console.log(); process.exit(0) })
  try {
    return (await rl.question(prompt)).trim()
  } catch {
    return ''
  } finally {
    rl.close()
  }
}

async function pressAnyKey(): Promise<void> {
  process.stdout.write(dim('\n\n— une touche pour continuer —'))
  await readKey()
}

/** Lance une commande de la CLI dans ce terminal (elle peut demander une confirmation). */
function cli(...args: string[]): boolean {
  console.log(dim('$ node src/cli.ts ' + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')) + '\n')
  return spawnSync(process.execPath, [CLI, ...args], { stdio: 'inherit' }).status === 0
}

/** Lance une commande de lecture et rend sa sortie, pour l'afficher au-dessus d'un menu. */
function cliOutput(...args: string[]): string {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return ((r.stdout ?? '') + (r.stderr ?? '')).trimEnd()
}

async function runAndShow(...args: string[]): Promise<void> {
  console.clear()
  cli(...args)
  await pressAnyKey()
}

function openInBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', url])
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

/**
 * Choix dans une liste. `none` ajoute une première ligne (« Tous ») qui renvoie
 * null ; Échap renvoie undefined et ne change rien.
 */
async function choose<T extends string>(title: string, options: readonly T[], labels: Record<string, string> = {}, none?: string): Promise<T | null | undefined> {
  const items = [...(none ? [none] : []), ...options.map((o) => labels[o] ?? o)]
  const r = await menu({ top: header() + '\n' + bold(title) + '\n', items })
  if (r.action !== 'enter') return undefined
  if (none && r.index === 0) return null
  return options[r.index - (none ? 1 : 0)]
}

function header(): string {
  const opps = readCollection<Opportunity>('opportunities')
  const msgs = readCollection<OutreachMessage>('outreach')
  const by = (p: string) => opps.filter((o) => o.match?.priority === p).length
  const full = opps.filter((o) => o.facts.remote?.value === 'full').length
  const st = (s: OutreachMessage['status']) => msgs.filter((m) => m.status === s).length
  return bold('nbeny-sales') + dim('  ·  ') + opps.length + ' opportunités  🔥 ' + by('HIGH') + '  🟠 ' + by('MEDIUM') + '  ⚪ ' + by('LOW') +
    dim('  ·  ') + '🌍 ' + full + ' full remote' + dim('  ·  ') + st('DRAFT') + ' brouillons, ' + yellow(st('APPROVED') + ' approuvés') + ', ' + st('SENT') + ' envoyés\n' +
    dim('─'.repeat(Math.min(100, (process.stdout.columns || 100) - 1)))
}

// --- Opportunités ----------------------------------------------------------

const REMOTE_FILTERS = ['full', 'hybrid', 'onsite', 'hybrid,onsite', 'unspecified'] as const
const REMOTE_LABELS: Record<string, string> = {
  full: '🌍 Full remote',
  hybrid: '🔀 Hybride',
  onsite: '🏢 Présentiel',
  'hybrid,onsite': '🔀🏢 Pas full remote (hybride + présentiel)',
  unspecified: '❔ Non précisé',
}
const SORT_LABELS: Record<string, string> = {
  score: 'Score (meilleur d\'abord)', remote: 'Remote (full d\'abord)', date: 'Plus récentes', company: 'Entreprise', location: 'Lieu',
}

function describeCriteria(c: ListCriteria): string {
  return [
    'tri : ' + SORT_LABELS[c.sort ?? 'score'].toLowerCase(),
    c.priority && 'priorité ' + c.priority,
    c.remote && REMOTE_LABELS[c.remote],
    c.contract && 'contrat ' + c.contract,
    c.location && 'lieu ~ ' + c.location,
    c.search && 'recherche « ' + c.search + ' »',
    c.minScore !== undefined && 'score ≥ ' + c.minScore,
    c.stage && 'étape ' + c.stage,
  ].filter(Boolean).join(dim('  ·  '))
}

/** Applique un choix de filtre : Échap ne change rien, « Tous » efface le filtre. */
function apply<T>(current: T | undefined, picked: T | null | undefined): T | undefined {
  return picked === undefined ? current : picked ?? undefined
}

async function opportunitiesScreen(): Promise<void> {
  const c: ListCriteria = { sort: 'score' }
  let cursor = 0

  for (;;) {
    const all = readCollection<Opportunity>('opportunities')
    const rows = filterOpportunities(all, { ...c, limit: undefined })
    const top = header() + '\n' + bold('Opportunités') + '  ' + describeCriteria(c) + dim('  ·  ' + rows.length + ' sur ' + all.length) + '\n'
    const r = await menu({
      top,
      items: rows.map(formatCompact),
      initial: cursor,
      keys: ['r', 't', 'p', 'c', 'e', 'l', '/', 's', 'x'],
      hint: 'r remote · t tri · p priorité · c contrat · l lieu · / chercher · s score min · e étape · x effacer',
      empty: 'Aucune opportunité ne correspond à ces filtres (x pour tout effacer).',
    })
    if (r.action === 'back') return
    cursor = r.index
    if (r.action === 'enter') { await opportunityDetail(rows[r.index].id); continue }

    switch (r.key) {
      case 'r': c.remote = apply(c.remote, await choose('Télétravail', REMOTE_FILTERS, REMOTE_LABELS, 'Tous')); break
      case 't': c.sort = apply(c.sort, await choose('Trier par', SORT_KEYS, SORT_LABELS)); break
      case 'p': c.priority = apply(c.priority, await choose('Priorité', ['HIGH', 'MEDIUM', 'LOW'] as const, { HIGH: '🔥 HIGH', MEDIUM: '🟠 MEDIUM', LOW: '⚪ LOW' }, 'Toutes')); break
      case 'c': c.contract = apply(c.contract, await choose('Contrat', ['freelance', 'cdi'] as const, { freelance: 'Freelance', cdi: 'CDI' }, 'Tous')); break
      case 'e': c.stage = apply(c.stage, await choose('Étape du pipeline', [...STAGES, ...TERMINAL_STAGES], {}, 'Toutes')); break
      case 'l': console.log(top); c.location = (await ask('Lieu contient (vide = tous) : ')) || undefined; break
      case '/': console.log(top); c.search = (await ask('Recherche dans entreprise, intitulé, lieu, stack (vide = tout) : ')) || undefined; break
      case 's': {
        console.log(top)
        const v = await ask('Score minimum sur 100 (vide = aucun) : ')
        c.minScore = v === '' || Number.isNaN(Number(v)) ? undefined : Number(v)
        break
      }
      case 'x': for (const k of Object.keys(c) as (keyof ListCriteria)[]) delete c[k]; c.sort = 'score'; break
    }
    cursor = 0
  }
}

async function opportunityDetail(id: string): Promise<void> {
  for (;;) {
    const opp = readCollection<Opportunity>('opportunities').find((o) => o.id === id)
    if (!opp) return
    const msgs = readCollection<OutreachMessage>('outreach').filter((m) => m.opportunityId === id)
    const actions = [
      ['open', '🌐 Ouvrir l\'annonce dans le navigateur'],
      ['stage', '➡️  Changer d\'étape (actuelle : ' + opp.stage + ')'],
      ...msgs.map((m) => ['msg:' + m.id, '✉️  ' + m.id + ' (' + m.status + ') — ' + m.subject]),
      ['json', '{ } Voir le JSON complet'],
    ]
    const r = await menu({ top: header() + '\n' + formatDetailed(opp) + '\n', items: actions.map((a) => a[1]) })
    if (r.action !== 'enter') return
    const action = actions[r.index][0]

    if (action === 'open') openInBrowser(opp.sourceUrl)
    else if (action === 'json') await runAndShow('opportunity:show', id)
    else if (action.startsWith('msg:')) await messageDetail(action.slice(4))
    else if (action === 'stage') {
      const next = [...STAGES, ...TERMINAL_STAGES].filter((s) => canTransition(opp.stage, s))
      const to = await choose('Étape actuelle : ' + opp.stage + ' → nouvelle étape', next as StageName[])
      if (!to) continue
      console.log(header())
      const note = await ask('Note (facultatif) : ')
      await runAndShow('opportunity:stage', id, to, ...(note ? ['--note', note] : []))
    }
  }
}

// --- Messages --------------------------------------------------------------

async function messagesScreen(): Promise<void> {
  let status: OutreachMessage['status'] | undefined
  let cursor = 0
  for (;;) {
    const all = readCollection<OutreachMessage>('outreach')
    const rows = all.filter((m) => !status || m.status === status)
    const badge = { DRAFT: '📝', APPROVED: '✅', SENT: '📤' } as const
    const r = await menu({
      top: header() + '\n' + bold('Messages') + '  ' + (status ?? 'tous') + dim('  ·  ' + rows.length + ' sur ' + all.length) + '\n',
      items: rows.map((m) => badge[m.status] + ' ' + m.id + '  ' + m.status.padEnd(8) + '  ' + m.companyName + ' — ' + m.subject + '  → ' + (m.to?.email ?? 'sans destinataire')),
      initial: cursor,
      keys: ['f'],
      hint: 'f filtrer par statut',
    })
    if (r.action === 'back') return
    cursor = r.index
    if (r.action === 'enter') await messageDetail(rows[r.index].id)
    else { status = apply(status, await choose('Statut', ['DRAFT', 'APPROVED', 'SENT'] as const, { DRAFT: '📝 Brouillons', APPROVED: '✅ Approuvés (prêts à partir)', SENT: '📤 Envoyés' }, 'Tous')); cursor = 0 }
  }
}

async function messageDetail(id: string): Promise<void> {
  for (;;) {
    const m = readCollection<OutreachMessage>('outreach').find((r) => r.id === id)
    if (!m) return
    const actions = [
      ['recipient', '📇 Définir le destinataire (email lu sur une page publique)'],
      ['approve', '✅ Approuver (confirmation au clavier)'],
      ['dry', '🧪 Simuler l\'envoi (--dry-run)'],
      ['send', '📤 Envoyer pour de vrai'],
      ['source', '🌐 Ouvrir la page source'],
    ]
    const r = await menu({ top: header() + '\n' + cliOutput('outreach:show', id) + '\n', items: actions.map((a) => a[1]) })
    if (r.action !== 'enter') return

    switch (actions[r.index][0]) {
      case 'source': openInBrowser(m.sourceUrl); break
      case 'approve': await runAndShow('outreach:approve', id); break
      case 'dry': await runAndShow('outreach:send', id, '--dry-run'); break
      case 'recipient': {
        console.log(header())
        const email = await ask('Email (vide = annuler) : ')
        if (!email) break
        const source = await ask('URL de la page publique où il est publié : ')
        const name = await ask('Nom (facultatif) : ')
        await runAndShow('outreach:set-recipient', id, '--email', email, '--source', source, ...(name ? ['--name', name] : []))
        break
      }
      case 'send': {
        console.clear()
        if (m.status !== 'APPROVED') { console.log(yellow('Seul un message APPROVED peut partir. Approuve-le d\'abord.')); await pressAnyKey(); break }
        if (!cli('outreach:send', id, '--dry-run')) { await pressAnyKey(); break }
        if ((await ask(bold('\nEnvoyer pour de vrai ? Tape « envoyer » : '))) === 'envoyer') cli('outreach:send', id)
        else console.log('Rien n\'est parti.')
        await pressAnyKey()
        break
      }
    }
  }
}

// --- Suivis ----------------------------------------------------------------

const FOLLOWUP_STATUSES: FollowupStatus[] = ['NEW', 'CONTACTED', 'REPLIED', 'INTERVIEW', 'NEGOTIATION', 'WON', 'LOST', 'NO_RESPONSE']

async function followupsScreen(): Promise<void> {
  for (;;) {
    const rows = readCollection<Followup>('followups')
    const now = new Date().toISOString()
    const r = await menu({
      top: header() + '\n' + bold('Suivis') + dim('  ·  Entrée pour changer le statut') + '\n',
      items: rows.map((f) => {
        const due = f.nextActionAt && f.nextActionAt <= now ? '  ⏰ relance due' : f.nextActionAt ? '  · relance le ' + f.nextActionAt.slice(0, 10) : ''
        return f.id + '  ' + f.status.padEnd(12) + f.company + ' — ' + f.contactLabel + due + (f.recommendation ? '  · ' + f.recommendation : '')
      }),
      empty: 'Aucun suivi : ils apparaissent quand des messages sont partis.',
    })
    if (r.action !== 'enter') return
    const f = rows[r.index]
    const status = await choose('Nouveau statut pour ' + f.id + ' (' + f.company + ')', FOLLOWUP_STATUSES)
    if (!status) continue
    console.log(header())
    const note = await ask('Note (facultatif) : ')
    await runAndShow('followup:set', f.id, status, ...(note ? ['--note', note] : []))
  }
}

// --- Agents ----------------------------------------------------------------

/**
 * Les agents passent par scripts/sales-cron.ps1, comme la tâche planifiée : même
 * liste d'outils autorisés (ni approve, ni send, ni clear-sending), même journal
 * dans logs/, même ligne dans `runs`. Lancer un agent d'ici ne lui donne pas plus
 * de droits qu'au lancement automatique du matin.
 */
const AGENT_COMMANDS = ['/sales', '/jobs', '/freelance', '/cdi', '/prospect', '/report', '/marketing', '/seo', 'libre'] as const
const AGENT_LABELS: Record<string, string> = {
  '/sales': '/sales       Journée complète : recherche, scoring, brouillons, relances, rapport (~20 min)',
  '/jobs': '/jobs        Offres publiées, tous contrats',
  '/freelance': '/freelance   Missions freelance',
  '/cdi': '/cdi         CDI, y compris sous des intitulés inattendus',
  '/prospect': '/prospect    Entreprises à démarcher sans offre publiée',
  '/report': '/report      Rapport global',
  '/marketing': '/marketing   Idées de contenus et de visibilité',
  '/seo': '/seo         Audit SEO de nbeny.fr',
  libre: '✏️  Consigne libre   ex. « freelance-agent : missions full remote en Suisse »',
}

function launchAgent(command: string, background: boolean): void {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUN_SCRIPT, '-Command', command, '-Model', 'sonnet']
  if (background) {
    // Fenêtre à part : l'application reste utilisable pendant que l'agent travaille.
    spawn('powershell.exe', ['-NoExit', ...args], { detached: true, stdio: 'ignore' }).unref()
    console.log(green('Lancé dans une nouvelle fenêtre : ' + command) + dim('\nSuivi : menu Lancements, ou le dossier logs/. Rien ne sera approuvé ni envoyé.'))
    return
  }
  console.log(dim('$ scripts/sales-cron.ps1 -Command ' + JSON.stringify(command) + ' -Model sonnet\n(Ctrl+C arrête l\'agent, pas l\'application)\n'))
  // Ctrl+C doit couper l'agent, pas l'application qui l'attend.
  const ignore = () => {}
  process.on('SIGINT', ignore)
  try {
    spawnSync('powershell.exe', args, { stdio: 'inherit' })
  } finally {
    process.off('SIGINT', ignore)
  }
}

async function agentsScreen(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log(yellow('Le lancement des agents passe par scripts/sales-cron.ps1 (PowerShell, Windows).'))
    await pressAnyKey()
    return
  }
  const picked = await choose('Lancer des agents  ' + dim('(Sonnet · ils cherchent et rédigent, n\'approuvent ni n\'envoient rien)'), AGENT_COMMANDS, AGENT_LABELS)
  if (!picked) return
  let command: string = picked
  if (picked === 'libre') {
    console.log(header())
    command = await ask('Consigne : ')
    if (!command) return
  }
  const where = await choose('Où le lancer ?', ['window', 'here'] as const, {
    window: '🪟 Dans une nouvelle fenêtre (l\'app reste utilisable)',
    here: '📺 Ici, en suivant la sortie (l\'app attend la fin)',
  })
  if (!where) return
  console.clear()
  launchAgent(command, where === 'window')
  await pressAnyKey()
}

// --- Aide ------------------------------------------------------------------

const GUIDE = `${bold('Qui fait quoi')}

  ${bold('Les agents')} (Claude, modèle Sonnet) cherchent sur le web, lisent les annonces,
  enregistrent les opportunités avec leurs preuves, les scorent et rédigent des
  brouillons. Ils ne peuvent ni approuver ni envoyer.

  ${bold('Toi')}, dans cette app : tu parcours, filtres, relis, ajoutes un destinataire,
  approuves et envoies. Rien ne part sans toi.

  ${bold('La CLI')} (node src/cli.ts) est la seule à écrire dans data/. Les agents comme
  cette app passent par elle.

${bold('Trois façons de lancer les agents')}

  1. Ici, menu ${bold('Agents')} : choisis /sales ou un agent, en nouvelle fenêtre.
  2. Dans Claude Code : tape /sales, /jobs, /freelance, /cdi, /prospect…
  3. Automatiquement : la tâche Windows nbeny-sales-daily lance /sales chaque matin.
     Menu ${bold('Lancements')} pour voir quand elle a tourné.

${bold('Ce que contient chaque menu')}

  ${bold('Opportunités')}  offres et missions trouvées, avec score /100 et couverture /8.
                🔥 HIGH 🟠 MEDIUM ⚪ LOW · 🌍 full remote 🔀 hybride 🏢 présentiel.
                Entrée = fiche complète (forces, réserves, source).
  ${bold('Messages')}      brouillons écrits par les agents. 📝 brouillon → ✅ approuvé
                (par toi) → 📤 envoyé (par toi).
  ${bold('Suivis')}        contacts engagés et relances dues.
  ${bold('Rapport')}       synthèse du jour, écrite dans data/reports/.
  ${bold('Re-scorer')}     recalcule tous les scores (après un réglage de config/).
  ${bold('Lancements')}    historique des lancements automatiques des agents.

${bold('Touches')}  ↑↓ choisir · Entrée ouvrir · Échap ou ← revenir · Ctrl+C quitter`

// --- Menu principal --------------------------------------------------------

const MENU: [string, () => Promise<void>][] = [
  ['📋 Opportunités      parcourir, filtrer (full remote…), trier', opportunitiesScreen],
  ['✉️  Messages          brouillons, destinataire, approbation, envoi', messagesScreen],
  ['🔁 Suivis            relances et statuts', followupsScreen],
  ['🤖 Agents            lancer /sales, /jobs, /freelance… (Sonnet)', agentsScreen],
  ['📰 Rapport du jour   report:daily', () => runAndShow('report:daily')],
  ['🧮 Re-scorer tout    match:all', () => runAndShow('match:all')],
  ['🕒 Lancements        quand les agents ont tourné', () => runAndShow('runs')],
  ['📊 Statistiques', () => runAndShow('stats')],
  ['❓ Comment ça marche', async () => { console.clear(); console.log(GUIDE); await pressAnyKey() }],
  ['🚪 Quitter', async () => { process.exit(0) }],
]

export async function runShell(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('L\'application interactive se lance depuis un terminal. Pour un script ou un agent : node src/cli.ts help')
    process.exit(1)
  }
  let cursor = 0
  for (;;) {
    const r = await menu({ top: header() + '\n', items: MENU.map((m) => m[0]), initial: cursor })
    if (r.action === 'back') return
    if (r.action !== 'enter') continue
    cursor = r.index
    await MENU[r.index][1]()
  }
}
