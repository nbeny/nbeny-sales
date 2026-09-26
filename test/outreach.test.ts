import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { findPlaceholders, validateRecipient } from '../src/lib/validate.ts'

describe('findPlaceholders', () => {
  test('trouve les marqueurs laissés par outreach-agent', () => {
    assert.deepEqual(
      findPlaceholders('Mon TJM : [TJM à confirmer par Nicolas].\nDispo [date].'),
      ['[TJM à confirmer par Nicolas]', '[date]'],
    )
  })

  test('texte sans crochets : rien', () => {
    assert.deepEqual(findPlaceholders('Bonjour,\n\nNicolas BENY\nhttps://nbeny.fr'), [])
  })
})

describe('validateRecipient', () => {
  test('adresse lue avec sa source : accepté', () => {
    assert.deepEqual(validateRecipient({ email: 'rh@acme.example', sourceUrl: 'https://acme.example/contact' }), [])
  })

  test('sans source : refusé', () => {
    const issues = validateRecipient({ email: 'rh@acme.example' })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /--source/)
  })

  test('adresse mal formée : refusé', () => {
    const issues = validateRecipient({ email: 'rh@acme', sourceUrl: 'https://acme.example/contact' })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /--email/)
  })
})
