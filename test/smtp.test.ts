import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'

import { sendMail, dotStuff, SmtpError, type SmtpOptions } from '../src/lib/smtp.ts'

interface FakeServer {
  port: number
  received: string[]
  data: () => string
  close: () => Promise<void>
}

/**
 * Faux serveur SMTP en clair. `replies` remplace la réponse par défaut d'un
 * verbe (`AUTH`) ou d'une ligne exacte (`RCPT TO:<x>`) ; `SILENCE` ne répond pas.
 */
async function fakeServer(replies: Record<string, string> = {}): Promise<FakeServer> {
  const received: string[] = []
  let data = ''
  const server = createServer((socket) => {
    let buffer = ''
    let inData = false
    socket.write('220 fake ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write((replies['.'] ?? '250 2.0.0 Ok: queued as ABC123') + '\r\n')
          } else {
            data += line + '\r\n'
          }
          continue
        }
        received.push(line)
        const verb = line.split(/[ :]/)[0].toUpperCase()
        const custom = replies[line] ?? replies[verb]
        if (custom === 'SILENCE') continue
        if (custom) socket.write(custom + '\r\n')
        else if (verb === 'EHLO') socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
        else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n')
        else if (verb === 'DATA') {
          inData = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (verb === 'QUIT') socket.end('221 2.0.0 Bye\r\n')
        else socket.write('250 2.1.0 Ok\r\n')
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
})
