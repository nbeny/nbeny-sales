import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Socket } from 'node:net'

import { sendMail, dotStuff, SmtpError, type SmtpOptions } from '../src/lib/smtp.ts'

interface FakeServer {
  port: number
  received: string[]
  data: () => string
  close: () => Promise<void>
}

interface FakeServerOptions {
  /** Envoie chaque réponse octet par octet (avec un `setImmediate` entre chaque) pour vérifier que le lecteur recolle les morceaux. */
  bytewise?: boolean
}

/**
 * Faux serveur SMTP en clair. `replies` remplace la réponse par défaut d'un
 * verbe (`AUTH`) ou d'une ligne exacte (`RCPT TO:<x>`) ; `SILENCE` ne répond
 * pas, `CLOSE` coupe la connexion au lieu de répondre.
 */
async function fakeServer(replies: Record<string, string> = {}, opts: FakeServerOptions = {}): Promise<FakeServer> {
  const received: string[] = []
  let data = ''

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

function options(port: number, over: Partial<SmtpOptions> = {}): SmtpOptions {
  return {
    host: '127.0.0.1',
    port,
    tls: false,
    user: 'nicolas@urbanlink.fr',
    pass: 'secret',
    from: 'nicolas@urbanlink.fr',
    rcpt: ['rh@acme.example', 'nicolas@urbanlink.fr'],
    raw: 'Subject: test\r\n\r\nligne\r\n.commence par un point\r\n',
    ehloName: 'test.local',
    timeoutMs: 2000,
    ...over,
  }
}

describe('dotStuff', () => {
  test('double le point en tête de ligne, seulement là', () => {
    assert.equal(dotStuff('a\r\n.b\r\nc.d\r\n'), 'a\r\n..b\r\nc.d\r\n')
  })
})

describe('sendMail', () => {
  test('parcours complet : AUTH PLAIN, enveloppe, corps doublé', async () => {
    const fake = await fakeServer()
    try {
      const result = await sendMail(options(fake.port))
      assert.match(result.reply, /queued as ABC123/)
      const auth = 'AUTH PLAIN ' + Buffer.from('\0nicolas@urbanlink.fr\0secret').toString('base64')
      assert.deepEqual(fake.received, [
        'EHLO test.local',
        auth,
        'MAIL FROM:<nicolas@urbanlink.fr>',
        'RCPT TO:<rh@acme.example>',
        'RCPT TO:<nicolas@urbanlink.fr>',
        'DATA',
        'QUIT',
      ])
      assert.ok(fake.data().includes('\r\n..commence par un point\r\n'))
    } finally {
      await fake.close()
    }
  })

  test('onBeforeData est appelé après les RCPT et avant DATA', async () => {
    const fake = await fakeServer()
    try {
      let seen: string[] = []
      await sendMail(options(fake.port, { onBeforeData: () => { seen = [...fake.received] } }))
      assert.ok(seen.includes('RCPT TO:<nicolas@urbanlink.fr>'))
      assert.ok(!seen.includes('DATA'))
    } finally {
      await fake.close()
    }
  })

  test('authentification refusée : SmtpError 535 sur AUTH', async () => {
    const fake = await fakeServer({ AUTH: '535 5.7.8 Error: authentication failed' })
    try {
      await assert.rejects(sendMail(options(fake.port)), (error: unknown) =>
        error instanceof SmtpError && error.code === 535 && error.command === 'AUTH' && /authentication failed/.test(error.reply))
    } finally {
      await fake.close()
    }
  })

  test('destinataire refusé : SmtpError 550 sur RCPT TO', async () => {
    const fake = await fakeServer({ 'RCPT TO:<rh@acme.example>': '550 5.1.1 User unknown' })
    try {
      await assert.rejects(sendMail(options(fake.port)), (error: unknown) =>
        error instanceof SmtpError && error.code === 550 && error.command.startsWith('RCPT TO'))
      assert.ok(!fake.received.includes('DATA'))
    } finally {
      await fake.close()
    }
  })

  test('serveur muet : SmtpError sans code, délai dépassé', async () => {
    const fake = await fakeServer({ EHLO: 'SILENCE' })
    try {
      await assert.rejects(sendMail(options(fake.port, { timeoutMs: 200 })), (error: unknown) =>
        error instanceof SmtpError && error.code === 0 && /délai/.test(error.reply))
    } finally {
      await fake.close()
    }
  })

  test('fin de DATA muette : SmtpError sans code, délai dépassé', async () => {
    const fake = await fakeServer({ '.': 'SILENCE' })
    try {
      await assert.rejects(sendMail(options(fake.port, { timeoutMs: 200 })), (error: unknown) =>
        error instanceof SmtpError && error.code === 0 && error.command === 'fin de DATA')
    } finally {
      await fake.close()
    }
  })

  test('le serveur coupe au lieu de répondre à la fin de DATA : SmtpError sans code', async () => {
    const fake = await fakeServer({ '.': 'CLOSE' })
    try {
      await assert.rejects(sendMail(options(fake.port)), (error: unknown) =>
        error instanceof SmtpError && error.code === 0)
    } finally {
      await fake.close()
    }
  })

  test('fin de DATA refusée : SmtpError 554', async () => {
    const fake = await fakeServer({ '.': '554 5.7.1 Rejected by policy' })
    try {
      await assert.rejects(sendMail(options(fake.port)), (error: unknown) =>
        error instanceof SmtpError && error.code === 554 && error.command === 'fin de DATA')
    } finally {
      await fake.close()
    }
  })

  test('le serveur coupe juste après le 250 final : succès quand même', async () => {
    const fake = await fakeServer({ QUIT: 'CLOSE' })
    try {
      const result = await sendMail(options(fake.port))
      assert.match(result.reply, /queued as ABC123/)
    } finally {
      await fake.close()
    }
  })

  test("l'attente du QUIT est plafonnée à 2 s même si timeoutMs est plus grand", async () => {
    const fake = await fakeServer({ QUIT: 'SILENCE' })
    try {
      const start = Date.now()
      const result = await sendMail(options(fake.port, { timeoutMs: 5000 }))
      assert.ok(Date.now() - start < 3000)
      assert.match(result.reply, /queued as ABC123/)
    } finally {
      await fake.close()
    }
  })

  test('accueil et EHLO reçus octet par octet : le client reste correct', async () => {
    const fake = await fakeServer({}, { bytewise: true })
    try {
      const result = await sendMail(options(fake.port))
      assert.match(result.reply, /queued as ABC123/)
      const auth = 'AUTH PLAIN ' + Buffer.from('\0nicolas@urbanlink.fr\0secret').toString('base64')
      assert.deepEqual(fake.received, [
        'EHLO test.local',
        auth,
        'MAIL FROM:<nicolas@urbanlink.fr>',
        'RCPT TO:<rh@acme.example>',
        'RCPT TO:<nicolas@urbanlink.fr>',
        'DATA',
        'QUIT',
      ])
    } finally {
      await fake.close()
    }
  })

  test("sans ehloName, le domaine de l'adresse d'expédition sert de nom EHLO", async () => {
    const fake = await fakeServer()
    try {
      await sendMail(options(fake.port, { ehloName: undefined }))
      assert.equal(fake.received[0], 'EHLO urbanlink.fr')
    } finally {
      await fake.close()
    }
  })

  test('adresse invalide : rejet avant toute connexion', async () => {
    await assert.rejects(
      sendMail(options(1, { rcpt: ['x@y.z>\r\nRCPT TO:<evil@e.v'] })),
      /Adresse SMTP invalide/,
    )
  })
})
