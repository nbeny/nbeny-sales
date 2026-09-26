import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { sendMail, dotStuff, SmtpError, type SmtpOptions } from '../src/lib/smtp.ts'
import { fakeServer } from './helpers/fake-smtp.ts'

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
