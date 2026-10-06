/**
 * Réglage des lieux (config/locations.json) : trajet, jours sur site tenables,
 * présentiel accepté, libellés reconnus. Ce sont des arbitrages de Nicolas, pas
 * des faits : seule la CLI les écrit, à sa demande (commandes location:*).
 *
 * Tout est pur : on reçoit une config, on rend une copie modifiée et la liste
 * lisible de ce qui a changé. Une saisie incohérente lève une LocationError au
 * lieu d'écrire une config que le scoring lirait de travers.
 */
import type { LocationsConfig, Place } from './scoring.ts'

export class LocationError extends Error {}

export interface PlaceEdit {
  travelMinutes?: number
  maxOnsiteDays?: number
  onsiteAccepted?: boolean
  priority?: number
  /** null efface la note. */
  note?: string | null
  addLabels?: string[]
  removeLabels?: string[]
}

export interface NewPlace {
  key: string
  labels: string[]
  market: string
  travelMinutes: number
  maxOnsiteDays: number
  onsiteAccepted?: boolean
  priority?: number
  note?: string
}

const clean = (label: string) => label.trim().toLowerCase()

function integer(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LocationError(name + ' doit être un entier entre ' + min + ' et ' + max + ' (reçu : ' + value + ').')
  }
  return value
}

export function findPlace(config: LocationsConfig, key: string): Place {
  const place = config.places.find((p) => p.key === key)
  if (!place) throw new LocationError('Lieu inconnu : ' + key + '. Connus : ' + config.places.map((p) => p.key).join(', '))
  return place
}

/** Un libellé ne désigne qu'un lieu : sinon « lens » compterait pour deux trajets différents. */
function assertLabelFree(config: LocationsConfig, label: string, owner?: string): void {
  const other = config.places.find((p) => p.key !== owner && p.labels.some((l) => clean(l) === label))
  if (other) throw new LocationError('« ' + label + ' » désigne déjà le lieu ' + other.key + '. Retire-le de ' + other.key + ' d\'abord.')
}

export function editPlace(config: LocationsConfig, key: string, edit: PlaceEdit): { config: LocationsConfig; changes: string[] } {
  const next = structuredClone(config)
  const place = findPlace(next, key)
  const changes: string[] = []

  if (edit.travelMinutes !== undefined) {
    const v = integer('Le trajet (minutes)', edit.travelMinutes, 0, 1440)
    if (v !== place.travelMinutes) changes.push('trajet ' + place.travelMinutes + ' → ' + v + ' min')
    place.travelMinutes = v
  }
  if (edit.maxOnsiteDays !== undefined) {
    const v = integer('Le nombre de jours sur site', edit.maxOnsiteDays, 0, 5)
    if (v !== place.maxOnsiteDays) changes.push('jours sur site max ' + place.maxOnsiteDays + ' → ' + v)
    place.maxOnsiteDays = v
  }
  if (edit.onsiteAccepted !== undefined && edit.onsiteAccepted !== Boolean(place.onsiteAccepted)) {
    changes.push('présentiel accepté : ' + (edit.onsiteAccepted ? 'oui' : 'non'))
    if (edit.onsiteAccepted) place.onsiteAccepted = true
    else delete place.onsiteAccepted
  }
  if (edit.priority !== undefined) {
    const v = integer('La priorité', edit.priority, 1, 20)
    if (v !== place.priority) changes.push('priorité ' + place.priority + ' → ' + v)
    place.priority = v
  }
  if (edit.note !== undefined) {
    const note = edit.note?.trim() || undefined
    if (note !== place.note) changes.push(note ? 'note : ' + note : 'note effacée')
    if (note) place.note = note
    else delete place.note
  }
  for (const raw of edit.addLabels ?? []) {
    const label = clean(raw)
    if (!label) throw new LocationError('Libellé vide.')
    if (place.labels.some((l) => clean(l) === label)) continue
    assertLabelFree(next, label, key)
    place.labels.push(label)
    changes.push('+ « ' + label + ' »')
  }
  for (const raw of edit.removeLabels ?? []) {
    const label = clean(raw)
    const kept = place.labels.filter((l) => clean(l) !== label)
    if (kept.length === place.labels.length) throw new LocationError('« ' + label + ' » n\'est pas un libellé de ' + key + '.')
    if (!kept.length) throw new LocationError('Impossible de retirer le dernier libellé de ' + key + ' : le lieu ne serait plus jamais reconnu.')
    place.labels = kept
    changes.push('− « ' + label + ' »')
  }
  return { config: next, changes }
}

export function addPlace(config: LocationsConfig, input: NewPlace): LocationsConfig {
  const next = structuredClone(config)
  if (!/^[a-z0-9-]+$/.test(input.key)) throw new LocationError('La clé doit être en minuscules, chiffres et tirets (ex. saint-omer).')
  if (next.places.some((p) => p.key === input.key)) throw new LocationError('Le lieu ' + input.key + ' existe déjà : modifie-le plutôt.')
  const markets = [...new Set(next.places.map((p) => p.market))]
  if (!markets.includes(input.market)) throw new LocationError('Marché inconnu : ' + input.market + '. Connus : ' + markets.join(', '))
  const labels = [...new Set(input.labels.map(clean).filter(Boolean))]
  if (!labels.length) throw new LocationError('Il faut au moins un libellé (le nom tel qu\'il apparaît dans les annonces).')
  for (const label of labels) assertLabelFree(next, label)
  const place: Place = {
    key: input.key,
    labels,
    market: input.market,
    priority: integer('La priorité', input.priority ?? 5, 1, 20),
    travelMinutes: integer('Le trajet (minutes)', input.travelMinutes, 0, 1440),
    maxOnsiteDays: integer('Le nombre de jours sur site', input.maxOnsiteDays, 0, 5),
  }
  if (input.onsiteAccepted) place.onsiteAccepted = true
  if (input.note?.trim()) place.note = input.note.trim()
  next.places.push(place)
  return next
}

export function setHome(config: LocationsConfig, home: Partial<LocationsConfig['home']>): LocationsConfig {
  const next = structuredClone(config)
  if (home.city !== undefined && !home.city.trim()) throw new LocationError('Ville vide.')
  if (home.postalCode !== undefined && !/^[0-9A-Za-z -]{3,10}$/.test(home.postalCode.trim())) throw new LocationError('Code postal invalide : ' + home.postalCode)
  if (home.city !== undefined) next.home.city = home.city.trim()
  if (home.postalCode !== undefined) next.home.postalCode = home.postalCode.trim()
  if (home.country !== undefined) next.home.country = home.country.trim().toUpperCase()
  return next
}

/** Une ligne par lieu : clé, trajet, jours sur site, présentiel, nombre de libellés. */
export function describePlace(place: Place): string {
  const h = Math.floor(place.travelMinutes / 60)
  const m = place.travelMinutes % 60
  const travel = place.travelMinutes === 0 ? 'sur place' : ((h ? h + ' h ' : '') + (m ? String(m).padStart(h ? 2 : 1, '0') + ' min' : '')).trim()
  const onsite = place.maxOnsiteDays === 0 ? 'remote uniquement' : place.maxOnsiteDays + ' j/sem. sur site max'
  return place.key.padEnd(16) + travel.padEnd(12) + onsite.padEnd(24) + (place.onsiteAccepted ? 'présentiel accepté  ' : ''.padEnd(20)) +
    place.labels.length + ' libellé' + (place.labels.length > 1 ? 's' : '')
}
