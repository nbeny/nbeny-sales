/**
 * Menus au clavier pour l'application interactive : flèches, Entrée, Échap.
 *
 * Le rendu (largeur, fenêtre visible) est pur et testé ; seuls `readKey`,
 * `enterScreen` et `leaveScreen` touchent au terminal. Aucune dépendance : le
 * mode brut de Node et l'écran alternatif ANSI suffisent.
 */
import { emitKeypressEvents } from 'node:readline'
import { styleText } from 'node:util'

export interface Key {
  name?: string
  sequence: string
  ctrl?: boolean
}

// --- Écran ------------------------------------------------------------------
//
// Les menus s'affichent sur l'écran alternatif (comme vim ou htop) et se
// redessinent en place. Effacer l'écran principal (console.clear) casse les
// terminaux à blocs comme Warp : chaque rendu s'empile ou écrase le bloc.
// Les sorties de commandes, elles, restent sur l'écran principal et donc dans
// l'historique du terminal.

let onAltScreen = false

/** Passe sur l'écran alternatif, curseur masqué. Sans effet si on y est déjà. */
export function enterScreen(): void {
  if (onAltScreen) return
  onAltScreen = true
  process.stdout.write('\x1b[?1049h\x1b[?25l')
}

/** Revient à l'écran principal, curseur visible, clavier en mode normal. */
export function leaveScreen(): void {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false)
  if (!onAltScreen) return
  onAltScreen = false
  process.stdout.write('\x1b[?25h\x1b[?1049l')
}

process.on('exit', leaveScreen)

/**
 * Lit une seule touche. Par défaut, rend ensuite le terminal à son mode normal ;
 * `keepRaw` le laisse en mode brut, pour qu'une rafale de touches (flèche
 * maintenue) ne tombe pas entre deux lectures en mode ligne, où elle serait
 * affichée en écho puis perdue. Un redimensionnement rend `{ name: 'resize' }`.
 */
export function readKey(keepRaw = false): Promise<Key> {
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const done = (key: Key) => {
      process.stdin.off('keypress', onKey)
      process.stdout.off('resize', onResize)
      if (!keepRaw) {
        process.stdin.setRawMode(false)
        process.stdin.pause()
      }
      resolve(key)
    }
    const onKey = (sequence: string | undefined, key: Key | undefined) => {
      if (key?.ctrl && key.name === 'c') { leaveScreen(); process.stdout.write('\n'); process.exit(0) }
      done({ name: key?.name, sequence: sequence ?? key?.sequence ?? '', ctrl: key?.ctrl })
    }
    const onResize = () => done({ name: 'resize', sequence: '' })
    process.stdin.on('keypress', onKey)
    process.stdout.on('resize', onResize)
  })
}

const PICTO = /\p{Extended_Pictographic}/u

/** Largeur affichée d'un texte sans séquences ANSI : un pictogramme occupe deux colonnes. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    if (ch === '️' || ch === '‍') continue
    width += PICTO.test(ch) ? 2 : 1
  }
  return width
}

/** Tronque à `width` colonnes avec « … », pour qu'une ligne ne passe jamais à la ligne. */
export function fit(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = ch === '️' || ch === '‍' ? 0 : PICTO.test(ch) ? 2 : 1
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return out + '…'
}

/** Première ligne visible pour que `selected` reste dans une fenêtre de `height` lignes. */
export function viewportStart(selected: number, total: number, height: number, previous = 0): number {
  if (total <= height) return 0
  let start = Math.min(previous, total - height)
  if (selected < start) start = selected
  if (selected >= start + height) start = selected - height + 1
  return Math.max(0, start)
}

export type MenuResult =
  | { action: 'enter'; index: number }
  | { action: 'key'; key: string; index: number }
  | { action: 'back' }

export interface MenuOptions {
  /** Texte au-dessus de la liste : en-tête, fiche, explications. */
  top?: string
  items: string[]
  /** Raccourcis rendus à l'appelant tels quels (une lettre ou un symbole). */
  keys?: string[]
  hint?: string
  initial?: number
  empty?: string
}

/**
 * Liste navigable. ↑↓ (ou j/k) déplacent, PgPréc/PgSuiv sautent d'une page,
 * Début/Fin vont aux extrémités, Entrée valide, Échap / ← / q reviennent.
 */
export async function menu(options: MenuOptions): Promise<MenuResult> {
  const { items, keys = [], hint = '', top = '' } = options
  let selected = Math.min(Math.max(0, options.initial ?? 0), Math.max(0, items.length - 1))
  let start = 0
  enterScreen()

  try {
    for (;;) {
      const columns = process.stdout.columns || 100
      const topLines = top ? top.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(displayWidth(stripAnsi(line)) / columns)), 0) : 0
      const height = Math.max(5, (process.stdout.rows || 30) - topLines - 4)
      start = viewportStart(selected, items.length, height, start)

      const lines: string[] = []
      if (top) lines.push(top)
      if (!items.length) lines.push(styleText('yellow', '  ' + (options.empty ?? 'Rien à afficher.')))
      for (let i = start; i < Math.min(items.length, start + height); i++) {
        const text = fit(items[i], columns - 3)
        lines.push(i === selected ? styleText(['inverse', 'bold'], '❯ ' + text) : '  ' + text)
      }
      const position = items.length > height ? '  ' + (selected + 1) + '/' + items.length : ''
      lines.push(styleText('dim', fit('↑↓ naviguer · Entrée ouvrir · Échap retour' + (hint ? ' · ' + hint : '') + position, columns - 1)))

      // Effacement puis rendu en une seule écriture, sur l'écran alternatif.
      process.stdout.write('\x1b[H\x1b[2J' + lines.join('\n'))

      const key = await readKey(true)
      const page = Math.max(1, height - 1)
      switch (key.name) {
        case 'resize': continue
        case 'up': selected = selected > 0 ? selected - 1 : Math.max(0, items.length - 1); continue
        case 'down': selected = selected < items.length - 1 ? selected + 1 : 0; continue
        case 'pageup': selected = Math.max(0, selected - page); continue
        case 'pagedown': selected = Math.min(items.length - 1, selected + page); continue
        case 'home': selected = 0; continue
        case 'end': selected = Math.max(0, items.length - 1); continue
        case 'return': case 'enter': case 'right':
          if (items.length) return { action: 'enter', index: selected }
          continue
        case 'escape': case 'left': case 'backspace':
          return { action: 'back' }
      }
      if (keys.includes(key.sequence)) return { action: 'key', key: key.sequence, index: selected }
      if (key.sequence === 'q') return { action: 'back' }
      if (key.sequence === 'k') selected = Math.max(0, selected - 1)
      if (key.sequence === 'j') selected = Math.min(items.length - 1, selected + 1)
    }
  } finally {
    // L'écran alternatif reste en place pour le menu suivant ; seul le clavier
    // redevient normal. Qui affiche du texte ou pose une question appelle leaveScreen().
    if (process.stdin.isRaw) process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}
