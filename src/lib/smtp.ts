/**
 * Client SMTP minimal, sans dépendance : juste ce qu'il faut pour remettre un
 * message à Mailcow en SMTPS avec AUTH PLAIN. Chaque réponse inattendue lève
 * une SmtpError qui porte la commande et le texte exact du serveur.
 */
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

export class SmtpError extends Error {
  readonly command: string
  /** 0 quand le serveur n'a pas répondu (délai, coupure, TLS). */
  readonly code: number
  readonly reply: string
  constructor(command: string, code: number, reply: string) {
    super('SMTP ' + command + ' → ' + (code || 'sans réponse') + ' ' + reply)
    this.name = 'SmtpError'
    this.command = command
    this.code = code
    this.reply = reply
  }
}

export interface SmtpOptions {
  host: string
  port: number
  /** Nom vérifié dans le certificat : indispensable quand on passe par un tunnel. */
  servername?: string
  tls: boolean
  user: string
  pass: string
  from: string
  rcpt: string[]
  raw: string
  ehloName?: string
  timeoutMs?: number
  /** Appelé juste avant la commande DATA : à partir d'ici, le message peut être parti. */
  onBeforeData?: () => void
}

interface Reply {
  code: number
  text: string
}

interface Pending {
  command: string
  resolve: (reply: Reply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function dotStuff(raw: string): string {
  // Entrée en CRLF : buildMessage normalise déjà les fins de ligne.
  return raw.split('\r\n').map((line) => (line.startsWith('.') ? '.' + line : line)).join('\r\n')
}

/** Hors imprimable ASCII, ou '<'/'>' : de quoi injecter une commande dans l'enveloppe SMTP. */
const INVALID_ADDRESS = /[^\x21-\x7e]|[<>]/

function checkAddress(value: string): void {
  if (INVALID_ADDRESS.test(value)) throw new Error('Adresse SMTP invalide : ' + JSON.stringify(value))
}

function replyReader(socket: Socket, defaultTimeoutMs: number): (command: string, timeoutMs?: number) => Promise<Reply> {
  let buffer = ''
  let failure: Error | null = null
  let pending: Pending | null = null

  const settle = () => {
    if (!pending) return
    const lines = buffer.split('\r\n')
    for (let i = 0; i < lines.length - 1; i++) {
      if (!/^\d{3}(?: |$)/.test(lines[i])) continue
      const current = pending
      pending = null
      clearTimeout(current.timer)
      buffer = lines.slice(i + 1).join('\r\n')
      current.resolve({ code: Number(lines[i].slice(0, 3)), text: lines.slice(0, i + 1).map((l) => l.slice(4)).join('\n') })
      return
    }
  }

  const fail = (error: Error) => {
    failure ??= error
    if (!pending) return
    const current = pending
    pending = null
    clearTimeout(current.timer)
    current.reject(new SmtpError(current.command, 0, error.message))
  }

  socket.on('data', (chunk: string) => {
    buffer += chunk
    settle()
  })
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('connexion fermée par le serveur')))

  return (command, timeoutMs = defaultTimeoutMs) =>
    new Promise<Reply>((resolve, reject) => {
      if (failure) {
        reject(new SmtpError(command, 0, failure.message))
        return
      }
      const timer = setTimeout(() => {
        pending = null
        reject(new SmtpError(command, 0, 'délai dépassé (' + timeoutMs + ' ms)'))
        socket.destroy()
      }, timeoutMs)
      pending = { command, resolve, reject, timer }
      settle()
    })
}

export async function sendMail(options: SmtpOptions): Promise<{ reply: string }> {
  checkAddress(options.from)
  for (const rcpt of options.rcpt) checkAddress(rcpt)
  if (options.ehloName) checkAddress(options.ehloName)

  const timeoutMs = options.timeoutMs ?? 30_000
  const socket = options.tls
    ? tlsConnect({ host: options.host, port: options.port, servername: options.servername ?? options.host })
    : netConnect({ host: options.host, port: options.port })
  socket.setEncoding('utf8')
  const read = replyReader(socket, timeoutMs)
  const send = (line: string) => socket.write(line + '\r\n')
  const expect = async (command: string, accepted: number[]): Promise<Reply> => {
    const reply = await read(command)
    if (!accepted.includes(reply.code)) throw new SmtpError(command, reply.code, reply.text)
    return reply
  }

  try {
    await expect('CONNEXION', [220])
    // Le domaine est un FQDN valide et évite de fuiter le nom de la machine locale dans les en-têtes Received.
    send('EHLO ' + (options.ehloName ?? options.from.split('@')[1]))
    await expect('EHLO', [250])
    send('AUTH PLAIN ' + Buffer.from('\0' + options.user + '\0' + options.pass, 'utf8').toString('base64'))
    await expect('AUTH', [235])
    send('MAIL FROM:<' + options.from + '>')
    await expect('MAIL FROM', [250])
    for (const rcpt of options.rcpt) {
      send('RCPT TO:<' + rcpt + '>')
      await expect('RCPT TO:<' + rcpt + '>', [250, 251])
    }
    options.onBeforeData?.()
    send('DATA')
    await expect('DATA', [354])
    const raw = options.raw.endsWith('\r\n') ? options.raw : options.raw + '\r\n'
    socket.write(dotStuff(raw) + '.\r\n')
    const accepted = await expect('fin de DATA', [250])
    send('QUIT')
    await read('QUIT', Math.min(2000, timeoutMs)).catch(() => undefined)
    return { reply: accepted.text }
  } finally {
    socket.destroy()
  }
}
