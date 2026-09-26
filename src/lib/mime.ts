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

function assertSafeAddress(email: string, role: string): void {
  if (!/^[\x21-\x7e]+$/.test(email) || !email.includes('@') || email.includes('<') || email.includes('>')) {
    throw new Error('Adresse ' + role + ' invalide : ' + JSON.stringify(email))
  }
}

export function buildMessage(input: MailInput): { messageId: string; raw: string } {
  assertSafeAddress(input.from.email, 'expéditeur')
  assertSafeAddress(input.to.email, 'destinataire')
  if (input.messageId !== undefined && !/^<[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(input.messageId)) {
    throw new Error('Message-ID invalide : ' + JSON.stringify(input.messageId))
  }
  if (Number.isNaN(input.date.getTime())) {
    throw new Error('Date invalide pour le message.')
  }
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
