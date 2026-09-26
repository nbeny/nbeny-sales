import { after, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { linkSync, mkdtempSync as makeTempDir, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseEnv, readSmtpPassword, SECRET_PATH, sendSafetyIssues, testOverridesActive, type MailConfig } from '../src/lib/mail-config.ts'

/** Dossiers temporaires créés par les tests, supprimés à la fin du fichier. */
const tempDirs: string[] = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function mkdtempSync(prefix: string): string {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

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

  test('NBENY_SALES_SMTP_ENV vide avec dossiers de test : traité comme absent, refusé', () => {
    assert.deepEqual(sendSafetyIssues(TEST, { ...overrides, NBENY_SALES_SMTP_ENV: '' }, SECRET), [PASSWORD_REFUSAL])
  })

  test('variables vides : considérées comme absentes', () => {
    assert.equal(testOverridesActive({ NBENY_SALES_DATA_DIR: '', NBENY_SALES_CONFIG_DIR: '' }), false)
    assert.equal(testOverridesActive({ NBENY_SALES_CONFIG_DIR: 'x' }), true)
  })
})

describe('sendSafetyIssues — alias du vrai secret', () => {
  const CONFIG: MailConfig = {
    from: { email: 'nicolas@urbanlink.fr', name: 'Nicolas BENY' },
    bccSelf: true,
    smtp: { host: '127.0.0.1', port: 2525, servername: 'localhost', tls: false },
    dailyCap: 10,
    minDelaySeconds: 1,
    recipientCooldownDays: 30,
  }
  const CONTENT_REFUSAL = 'Le fichier de test contient le vrai mot de passe SMTP : refusé.'
  const SAME_FILE_REFUSAL = 'Le fichier de test est le vrai fichier secret (même fichier sur le disque) : refusé.'

  /** Un faux « vrai secret » dans un dossier temporaire : le vrai ~/.nbeny-sales n'est jamais touché. */
  function files(realPassword: string, testPassword: string) {
    const dir = mkdtempSync(join(tmpdir(), 'nbeny-sales-alias-'))
    const real = join(dir, 'real-smtp.env')
    const fake = join(dir, 'test-smtp.env')
    writeFileSync(real, 'SMTP_PASSWORD=' + realPassword + '\n')
    writeFileSync(fake, 'SMTP_PASSWORD=' + testPassword + '\n')
    return { dir, real, fake }
  }
  const envFor = (smtpEnv: string) => ({ NBENY_SALES_DATA_DIR: join(tmpdir(), 'x', 'data'), NBENY_SALES_SMTP_ENV: smtpEnv })

  test('contenus différents : accepté', () => {
    const f = files('vrai-secret', 'secret-de-test')
    assert.deepEqual(sendSafetyIssues(CONFIG, envFor(f.fake), f.real), [])
  })

  test('même mot de passe dans un autre fichier : refusé', () => {
    const f = files('vrai-secret', 'vrai-secret')
    assert.deepEqual(sendSafetyIssues(CONFIG, envFor(f.fake), f.real), [CONTENT_REFUSAL])
  })

  test('lien physique vers le vrai secret : refusé comme même fichier', () => {
    const f = files('vrai-secret', 'inutilisé')
    const link = join(f.dir, 'hardlink-smtp.env')
    linkSync(f.real, link)
    const issues = sendSafetyIssues(CONFIG, envFor(link), f.real)
    assert.ok(issues.includes(SAME_FILE_REFUSAL), JSON.stringify(issues))
  })

  test('même dev+ino, contenus différents (lecteur factice) : refusé comme même fichier', () => {
    const probe = {
      password: (p: string) => (p === 'reel' ? 'a' : 'b'),
      identity: () => '42:1234',
    }
    assert.deepEqual(sendSafetyIssues(CONFIG, envFor('test'), 'reel', 'linux', probe), [SAME_FILE_REFUSAL])
  })

  test('vrai secret absent : seule la vérification de chemin compte', () => {
    const f = files('x', 'secret-de-test')
    assert.deepEqual(sendSafetyIssues(CONFIG, envFor(f.fake), join(f.dir, 'absent.env')), [])
  })

  test('flux NTFS ::$DATA du vrai secret : refusé', { skip: process.platform !== 'win32' }, () => {
    const f = files('vrai-secret', 'inutilisé')
    const issues = sendSafetyIssues(CONFIG, envFor(f.real + '::$DATA'), f.real)
    assert.ok(issues.includes(CONTENT_REFUSAL), JSON.stringify(issues))
  })

  test('aucun mot de passe n\'apparaît dans les messages', () => {
    const f = files('vrai-secret-unique', 'vrai-secret-unique')
    const text = sendSafetyIssues(CONFIG, envFor(f.fake), f.real).join('\n')
    assert.ok(!text.includes('vrai-secret-unique'))
  })
})

describe('SECRET_PATH', () => {
  test('ne suit pas USERPROFILE ni HOME : il vient du compte système', () => {
    const module = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'mail-config.ts')).href
    const other = mkdtempSync(join(tmpdir(), 'nbeny-sales-home-'))
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', 'const m = await import(' + JSON.stringify(module) + '); process.stdout.write(m.SECRET_PATH)'], {
      env: { ...process.env, USERPROFILE: other, HOME: other, NODE_OPTIONS: '' },
      encoding: 'utf8',
    })
    assert.equal(out, SECRET_PATH)
    assert.ok(!out.startsWith(other))
  })
})
