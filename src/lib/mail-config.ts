/**
 * Paramètres d'envoi (versionnés, dans config/mail.json) et secret SMTP (hors
 * du dépôt). Le mot de passe n'est jamais une variable d'environnement : il
 * fuirait dans les journaux de la tâche planifiée.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'

export interface MailConfig {
  from: { email: string; name: string }
  /** Copie cachée à l'expéditeur : la trace de l'envoi dans Mailcow. */
  bccSelf: boolean
  /** `tls` absent : vrai. Seuls les tests parlent en clair à un faux serveur local. */
  smtp: { host: string; port: number; servername: string; tls?: boolean }
  /** Absent : connexion directe à smtp.host:port, sans tunnel SSH. */
  tunnel?: { jumpHost: string }
  dailyCap: number
  minDelaySeconds: number
  recipientCooldownDays: number
}

/**
 * Dossier du compte système, pas `homedir()` : celui-ci suit USERPROFILE / HOME,
 * qu'il suffirait de changer pour que le vrai secret passe pour un fichier de test.
 */
export const SECRET_PATH = join(userInfo().homedir, '.nbeny-sales', 'smtp.env')

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

type Env = Record<string, string | undefined>

/** Dossiers de données ou de configuration remplacés (tests). Une variable vide compte comme absente. */
export function testOverridesActive(env: Env = process.env): boolean {
  return !!(env.NBENY_SALES_DATA_DIR || env.NBENY_SALES_CONFIG_DIR)
}

function samePath(a: string, b: string, platform: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost']

/** Accès aux fichiers secrets, injectable pour les tests. Aucun des deux ne lève d'erreur. */
export interface SecretProbe {
  /** SMTP_PASSWORD du fichier, ou `undefined` s'il est absent ou illisible. */
  password: (path: string) => string | undefined
  /** `dev:ino` du fichier, ou `undefined` s'il est absent. */
  identity: (path: string) => string | undefined
}

export const fileProbe: SecretProbe = {
  password: (path) => {
    try {
      return parseEnv(readFileSync(path, 'utf8')).SMTP_PASSWORD || undefined
    } catch {
      return undefined
    }
  },
  identity: (path) => {
    try {
      const s = statSync(path, { bigint: true })
      return s.dev + ':' + s.ino
    } catch {
      return undefined
    }
  },
}

/**
 * Refus à opposer avant tout envoi réel, avant même de lire un mot de passe.
 * Des dossiers de test ne doivent jamais servir à faire partir un message avec
 * le vrai secret (ils permettent d'écrire une ligne APPROVED sans passer par
 * outreach:approve), et une connexion en clair ou sans tunnel n'est admise
 * que vers un faux serveur local, en test.
 */
export function sendSafetyIssues(
  config: MailConfig,
  env: Env = process.env,
  secretPath: string = SECRET_PATH,
  platform: string = process.platform,
  probe: SecretProbe = fileProbe,
): string[] {
  const issues: string[] = []
  const overrides = testOverridesActive(env)
  const testSecret = env.NBENY_SALES_SMTP_ENV
  if (overrides && (!testSecret || samePath(testSecret, secretPath, platform))) {
    issues.push('Dossiers de test actifs (NBENY_SALES_*) : le vrai mot de passe SMTP n\'est jamais utilisé avec eux.')
  } else if (overrides && testSecret) {
    // Un chemin différent peut désigner le même fichier (flux ::$DATA, jonction,
    // lien physique, nom court 8.3) : on compare aussi l'identité et le contenu.
    const testId = probe.identity(testSecret)
    const realId = probe.identity(secretPath)
    if (testId !== undefined && testId === realId) {
      issues.push('Le fichier de test est le vrai fichier secret (même fichier sur le disque) : refusé.')
    }
    const realPassword = probe.password(secretPath)
    if (realPassword !== undefined && probe.password(testSecret) === realPassword) {
      issues.push('Le fichier de test contient le vrai mot de passe SMTP : refusé.')
    }
  }
  const insecure = config.smtp.tls === false || !config.tunnel
  if (insecure && !(overrides && LOCAL_HOSTS.includes(config.smtp.host))) {
    issues.push('Configuration d\'envoi réservée aux tests : TLS et tunnel sont obligatoires.')
  }
  return issues
}
