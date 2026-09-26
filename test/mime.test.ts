import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildMessage, encodeHeaderWord, encodeQuotedPrintable, formatAddress } from '../src/lib/mime.ts'

const decodeWords = (encoded: string) =>
  encoded.split('\r\n ').map((w) => Buffer.from(w.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8')).join('')

describe('encodeHeaderWord', () => {
  test('ASCII : inchangé', () => {
    assert.equal(encodeHeaderWord('Mission Node.js'), 'Mission Node.js')
  })

  test('accents : RFC 2047, réversible', () => {
    const encoded = encodeHeaderWord('Développeur à Lille')
    assert.match(encoded, /^=\?UTF-8\?B\?/)
    assert.equal(decodeWords(encoded), 'Développeur à Lille')
  })

  test('objet long : chaque mot encodé tient en 75 caractères', () => {
    const subject = 'Refonte NestJS — un renfort qui l\'a déjà faite, à Lille ou à distance, dès octobre'
    const encoded = encodeHeaderWord(subject)
    for (const word of encoded.split('\r\n ')) assert.ok(word.length <= 75, word)
    assert.equal(decodeWords(encoded), subject)
  })
})

describe('encodeQuotedPrintable', () => {
  test('encode UTF-8, =, et l\'espace final', () => {
    assert.equal(encodeQuotedPrintable('é = x '), '=C3=A9 =3D x=20')
  })

  test('aucune ligne au-delà de 76 caractères', () => {
    const encoded = encodeQuotedPrintable('é'.repeat(100) + '\n' + 'a'.repeat(200))
    for (const line of encoded.split('\r\n')) assert.ok(line.length <= 76, line)
  })

  test('fins de ligne normalisées en CRLF', () => {
    assert.equal(encodeQuotedPrintable('a\nb\r\nc'), 'a\r\nb\r\nc')
  })
})

describe('buildMessage', () => {
  const mail = buildMessage({
    from: { email: 'nicolas@urbanlink.fr', name: 'Nicolas BENY' },
    to: { email: 'rh@acme.example' },
    subject: 'Votre annonce Node.js',
    body: 'Bonjour,\n\n.ligne qui commence par un point\n\nNicolas',
    date: new Date('2026-09-28T10:00:00Z'),
    messageId: '<fixe@urbanlink.fr>',
  })

  test('en-têtes attendus', () => {
    const head = mail.raw.split('\r\n\r\n')[0]
    assert.match(head, /^From: "Nicolas BENY" <nicolas@urbanlink\.fr>$/m)
    assert.match(head, /^To: rh@acme\.example$/m)
    assert.match(head, /^Subject: Votre annonce Node\.js$/m)
    assert.match(head, /^Date: Mon, 28 Sep 2026 10:00:00 \+0000$/m)
    assert.match(head, /^Message-ID: <fixe@urbanlink\.fr>$/m)
    assert.match(head, /^Content-Type: text\/plain; charset=utf-8$/m)
    assert.match(head, /^Content-Transfer-Encoding: quoted-printable$/m)
    assert.equal(mail.messageId, '<fixe@urbanlink.fr>')
  })

  test('jamais d\'en-tête Bcc', () => {
    assert.doesNotMatch(mail.raw, /^Bcc:/im)
  })

  test('uniquement des CRLF', () => {
    assert.doesNotMatch(mail.raw, /[^\r]\n/)
  })

  test('Message-ID généré sur le domaine de l\'expéditeur', () => {
    const generated = buildMessage({ from: { email: 'nicolas@urbanlink.fr', name: 'N' }, to: { email: 'a@b.example' }, subject: 's', body: 'b', date: new Date() })
    assert.match(generated.messageId, /^<[0-9a-f-]{36}@urbanlink\.fr>$/)
  })

  const base = {
    from: { email: 'nicolas@urbanlink.fr', name: 'Nicolas BENY' },
    to: { email: 'rh@acme.example' },
    subject: 'Votre annonce Node.js',
    body: 'Bonjour,\n\n.ligne qui commence par un point\n\nNicolas',
    date: new Date('2026-09-28T10:00:00Z'),
    messageId: '<fixe@urbanlink.fr>',
  }

  test('injection Bcc via l\'adresse destinataire refusée', () => {
    assert.throws(
      () => buildMessage({ ...base, to: { email: 'victim@example.com\r\nBcc: attacker@evil.com' } }),
      /destinataire invalide/,
    )
  })

  test('adresse expéditeur sans @ refusée', () => {
    assert.throws(
      () => buildMessage({ ...base, from: { email: 'nicolas-urbanlink.fr', name: 'Nicolas BENY' } }),
      /expéditeur invalide/,
    )
  })

  test('Message-ID contenant un saut de ligne refusé', () => {
    assert.throws(
      () => buildMessage({ ...base, messageId: '<x@y>\r\nBcc: a@b.c' }),
      /Message-ID invalide/,
    )
  })

  test('date invalide refusée', () => {
    assert.throws(
      () => buildMessage({ ...base, date: new Date('invalid') }),
      /Date invalide/,
    )
  })
})

describe('formatAddress', () => {
  test('nom accentué encodé', () => {
    assert.match(formatAddress({ email: 'a@b.example', name: 'Hélène' }), /^=\?UTF-8\?B\?.+\?= <a@b\.example>$/)
  })

  test('guillemets échappés', () => {
    assert.equal(formatAddress({ email: 'a@b.example', name: 'Le "Chef"' }), '"Le \\"Chef\\"" <a@b.example>')
  })
})
