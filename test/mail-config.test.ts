import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseEnv, readSmtpPassword } from '../src/lib/mail-config.ts'

describe('parseEnv', () => {
  test('ignore commentaires et lignes vides, garde les = dans la valeur, retire les guillemets', () => {
    assert.deepEqual(
      parseEnv('# secret\n\nSMTP_PASSWORD=abc=def\r\nAUTRE="x y"\n'),
      { SMTP_PASSWORD: 'abc=def', AUTRE: 'x y' },
    )
  })
})

describe('readSmtpPassword', () => {
  test('fichier absent : erreur qui dit quoi créer', () => {
    assert.throws(() => readSmtpPassword(join(tmpdir(), 'inexistant-nbeny', 'smtp.env')), /SMTP_PASSWORD=/)
  })

  test('lit SMTP_PASSWORD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbeny-sales-'))
    const path = join(dir, 'smtp.env')
    writeFileSync(path, 'SMTP_PASSWORD=s3cret\n')
    assert.equal(readSmtpPassword(path), 's3cret')
  })

  test('clé absente : erreur', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbeny-sales-'))
    const path = join(dir, 'smtp.env')
    writeFileSync(path, 'AUTRE=1\n')
    assert.throws(() => readSmtpPassword(path), /SMTP_PASSWORD manque/)
  })
})
