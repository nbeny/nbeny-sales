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
