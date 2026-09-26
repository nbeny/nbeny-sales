import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseEnv, readSmtpPassword, sendSafetyIssues, testOverridesActive, type MailConfig } from '../src/lib/mail-config.ts'

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

describe('sendSafetyIssues', () => {
  const SECRET = join(tmpdir(), 'nbeny-home', '.nbeny-sales', 'smtp.env')
  const REAL: MailConfig = {
    from: { email: 'nicolas@urbanlink.fr', name: 'Nicolas BENY' },
    bccSelf: true,
    smtp: { host: '10.0.0.140', port: 465, servername: 'mail.urbanlink.fr' },
    tunnel: { jumpHost: 'pve' },
    dailyCap: 10,
    minDelaySeconds: 90,
    recipientCooldownDays: 30,
  }
  const TEST: MailConfig = { ...REAL, smtp: { host: '127.0.0.1', port: 2525, servername: 'localhost', tls: false }, tunnel: undefined }
  const overrides = { NBENY_SALES_DATA_DIR: join(tmpdir(), 'x', 'data') }
  const PASSWORD_REFUSAL = 'Dossiers de test actifs (NBENY_SALES_*) : le vrai mot de passe SMTP n\'est jamais utilisé avec eux.'
  const CONFIG_REFUSAL = 'Configuration d\'envoi réservée aux tests : TLS et tunnel sont obligatoires.'

  test('configuration réelle, sans variable de test : rien à redire', () => {
    assert.deepEqual(sendSafetyIssues(REAL, {}, SECRET), [])
  })

  test('dossiers de test sans NBENY_SALES_SMTP_ENV : refusé (le vrai mot de passe serait lu)', () => {
    assert.deepEqual(sendSafetyIssues(REAL, overrides, SECRET), [PASSWORD_REFUSAL])
    assert.deepEqual(sendSafetyIssues(REAL, { NBENY_SALES_CONFIG_DIR: join(tmpdir(), 'c') }, SECRET), [PASSWORD_REFUSAL])
  })

  test('NBENY_SALES_SMTP_ENV pointant vers le vrai secret, même écrit autrement : refusé', () => {
    assert.deepEqual(sendSafetyIssues(REAL, { ...overrides, NBENY_SALES_SMTP_ENV: SECRET }, SECRET), [PASSWORD_REFUSAL])
    const other = join(SECRET, '..', '..', '.nbeny-sales', 'smtp.env')
    assert.deepEqual(sendSafetyIssues(REAL, { ...overrides, NBENY_SALES_SMTP_ENV: other }, SECRET), [PASSWORD_REFUSAL])
    assert.deepEqual(sendSafetyIssues(REAL, { ...overrides, NBENY_SALES_SMTP_ENV: SECRET.toUpperCase() }, SECRET, 'win32'), [PASSWORD_REFUSAL])
  })

  test('configuration de test (clair, sans tunnel, 127.0.0.1) avec dossiers et secret de test : accepté', () => {
    assert.deepEqual(sendSafetyIssues(TEST, { ...overrides, NBENY_SALES_SMTP_ENV: join(tmpdir(), 'x', 'smtp.env') }, SECRET), [])
    const localhost = { ...TEST, smtp: { ...TEST.smtp, host: 'localhost' } }
    assert.deepEqual(sendSafetyIssues(localhost, { ...overrides, NBENY_SALES_SMTP_ENV: join(tmpdir(), 'x', 'smtp.env') }, SECRET), [])
  })

  test('TLS coupé ou tunnel absent sans dossiers de test : refusé', () => {
    assert.deepEqual(sendSafetyIssues({ ...REAL, smtp: { ...REAL.smtp, tls: false } }, {}, SECRET), [CONFIG_REFUSAL])
    assert.deepEqual(sendSafetyIssues({ ...REAL, tunnel: undefined }, {}, SECRET), [CONFIG_REFUSAL])
    assert.deepEqual(sendSafetyIssues(TEST, {}, SECRET), [CONFIG_REFUSAL])
  })

  test('TLS coupé vers un hôte distant, même avec dossiers de test : refusé', () => {
    const remote = { ...TEST, smtp: { ...TEST.smtp, host: '10.9.9.9' } }
    assert.deepEqual(sendSafetyIssues(remote, { ...overrides, NBENY_SALES_SMTP_ENV: join(tmpdir(), 'x', 'smtp.env') }, SECRET), [CONFIG_REFUSAL])
  })

  test('variables vides : considérées comme absentes', () => {
    assert.equal(testOverridesActive({ NBENY_SALES_DATA_DIR: '', NBENY_SALES_CONFIG_DIR: '' }), false)
    assert.equal(testOverridesActive({ NBENY_SALES_CONFIG_DIR: 'x' }), true)
  })
})
