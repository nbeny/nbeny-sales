/**
 * Faux serveur SMTP partagé par les tests (hors du motif test/*.test.ts : il n'est pas lui-même un test).
 */
import { createServer, type AddressInfo, type Socket } from 'node:net'

export interface FakeServer {
  port: number
  received: string[]
  data: () => string
  close: () => Promise<void>
}

export interface FakeServerOptions {
  /** Envoie chaque réponse octet par octet (avec un `setImmediate` entre chaque) pour vérifier que le lecteur recolle les morceaux. */
  bytewise?: boolean
  /** Appelé de façon synchrone à la réception du `.` final d'un message (numéroté à partir de 1), avant la réponse. */
  onMessageEnd?: (count: number) => void
}

/**
 * Faux serveur SMTP en clair. `replies` remplace la réponse par défaut d'un
 * verbe (`AUTH`) ou d'une ligne exacte (`RCPT TO:<x>`) ; `SILENCE` ne répond
 * pas, `CLOSE` coupe la connexion au lieu de répondre.
 */
export async function fakeServer(replies: Record<string, string> = {}, opts: FakeServerOptions = {}): Promise<FakeServer> {
  const received: string[] = []
  let data = ''
  let messages = 0

  const respond = (socket: Socket, text: string, after?: () => void) => {
    if (!opts.bytewise) {
      socket.write(text)
      after?.()
      return
    }
    const bytes = Buffer.from(text, 'utf8')
    let i = 0
    const step = () => {
      if (socket.destroyed) return
      if (i >= bytes.length) {
        after?.()
        return
      }
      socket.write(bytes.subarray(i, i + 1))
      i++
      setImmediate(step)
    }
    step()
  }

  const server = createServer((socket) => {
    let buffer = ''
    let inData = false
    respond(socket, '220 fake ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            messages++
            opts.onMessageEnd?.(messages)
            const custom = replies['.']
            if (custom === 'CLOSE') {
              socket.destroy()
              return
            }
            if (custom === 'SILENCE') continue
            respond(socket, (custom ?? '250 2.0.0 Ok: queued as ABC123') + '\r\n')
          } else {
            data += line + '\r\n'
          }
          continue
        }
        received.push(line)
        const verb = line.split(/[ :]/)[0].toUpperCase()
        const custom = replies[line] ?? replies[verb]
        if (custom === 'SILENCE') continue
        if (custom === 'CLOSE') {
          socket.destroy()
          return
        }
        if (custom) respond(socket, custom + '\r\n')
        else if (verb === 'EHLO') respond(socket, '250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
        else if (verb === 'AUTH') respond(socket, '235 2.7.0 Authentication successful\r\n')
        else if (verb === 'DATA') {
          inData = true
          respond(socket, '354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (verb === 'QUIT') respond(socket, '221 2.0.0 Bye\r\n', () => socket.end())
        else respond(socket, '250 2.1.0 Ok\r\n')
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    received,
    data: () => data,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
