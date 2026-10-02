import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { displayWidth, fit, viewportStart } from '../src/lib/tui.ts'

describe('menus au clavier : rendu', () => {
  test('un pictogramme compte pour deux colonnes', () => {
    assert.equal(displayWidth('abc'), 3)
    assert.equal(displayWidth('🌍 Full'), 7)
    assert.equal(displayWidth('⚠️ x'), 4)
  })

  test('une ligne trop longue est tronquée avec « … » sans dépasser la largeur', () => {
    const line = fit('🔥 HIGH  Dougs — Développeur Full Stack Node.js', 20)
    assert.ok(line.endsWith('…'))
    assert.ok(displayWidth(line) <= 20)
    assert.equal(fit('court', 20), 'court')
  })

  test('la fenêtre suit la sélection sans sauter inutilement', () => {
    assert.equal(viewportStart(0, 5, 10), 0)
    assert.equal(viewportStart(12, 100, 10, 0), 3)
    assert.equal(viewportStart(5, 100, 10, 3), 3)
    assert.equal(viewportStart(1, 100, 10, 3), 1)
    assert.equal(viewportStart(99, 100, 10, 0), 90)
  })
})
