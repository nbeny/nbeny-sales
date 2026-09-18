/**
 * Accès disque. Toutes les collections sont des tableaux JSON, écrits de façon
 * atomique (fichier temporaire + rename) pour qu'une interruption ne laisse
 * jamais un JSON tronqué derrière elle.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DATA_DIR = join(ROOT, 'data')
export const CONFIG_DIR = join(ROOT, 'config')
export const REPORTS_DIR = join(DATA_DIR, 'reports')

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return fallback
  return JSON.parse(raw) as T
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** Écriture atomique d'un fichier texte (rapports markdown). */
export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

export function collectionPath(name: string): string {
  return join(DATA_DIR, name + '.json')
}

export function readCollection<T>(name: string): T[] {
  return readJson<T[]>(collectionPath(name), [])
}

export function writeCollection<T>(name: string, rows: T[]): void {
  writeJson(collectionPath(name), rows)
}

export function readConfig<T>(name: string): T {
  const path = join(CONFIG_DIR, name + '.json')
  if (!existsSync(path)) throw new Error('Configuration absente : config/' + name + '.json')
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Journal append-only : chaque écriture laisse une trace horodatée. */
export function appendHistory(event: Record<string, unknown>): void {
  const dir = join(DATA_DIR, 'history')
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const line = JSON.stringify({ at: new Date().toISOString(), ...event })
  appendFileSync(join(dir, day + '.jsonl'), line + '\n', 'utf8')
}
