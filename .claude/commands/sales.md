---
description: Semaine commerciale complète — recherche sur 7 jours (Lille, Paris, tout le Pas-de-Calais, remote), qualification, prospection, brouillons, relances, rapport
allowed-tools: Task, Bash, Read, Glob, Grep
---

Lance la semaine commerciale. Délègue au `ceo-agent`, qui répartit le travail.

## Périmètre

- **Fenêtre : les 7 derniers jours**, pas seulement la journée. Une offre entre
  si sa date de publication (ou de mise à jour) lue sur la page tombe dans les
  7 derniers jours. Date absente de la page : l'offre peut entrer, mais la date
  manquante va dans `assumptions`, jamais dans `facts`.
- **Zones, toutes couvertes à chaque lancement :**
  1. **Lille** et sa métropole
  2. **Paris** et l'Île-de-France
  3. **Tout le Pas-de-Calais** : Côte d'Opale (Boulogne-sur-Mer, Wimereux,
     Calais, Le Touquet, Berck…), Saint-Omer, Arras, Lens, Liévin, Béthune,
     Hénin-Beaumont, Bruay…
  4. Remote France, en complément.

  Les villes à croiser dans les requêtes sont les libellés de la config, pas une
  liste de mémoire : `node src/cli.ts location:list lille paris pas-de-calais
  boulogne calais wimereux`. Ce que Nicolas a réglé dans l'app (menu Lieux) fait
  donc partie de la recherche. Les agents lisent les lieux, ils ne les modifient
  jamais (`location:set`, `location:add` et `location:home` sont réservés à Nicolas).

## Déroulé attendu

1. État des lieux : `node src/cli.ts stats` et `data/history/` des 7 derniers
   jours, pour ne pas relancer une recherche déjà faite ni réenregistrer une offre
   déjà en base (la CLI refuse les doublons, mais une recherche évitée est du
   temps gagné).
2. En parallèle, **une délégation par zone et par agent** — chaque agent reçoit
   sa zone, la fenêtre de 7 jours et le nombre de résultats attendus :
   - `job-research-agent` : Lille · Paris · Pas-de-Calais
   - `freelance-agent` : Lille · Paris · Pas-de-Calais · remote
   - `sales-agent` : signaux publiés ces 7 derniers jours (levée, recrutements,
     nouveau produit) chez des entreprises de Lille, de Paris et du Pas-de-Calais
3. Puis `match-agent` pour faire monter la couverture des opportunités mal
   documentées, puis `node src/cli.ts match:all`.
4. `outreach-agent` sur les opportunités HIGH sans brouillon existant.
5. `followup-agent` pour les relances dues.
6. `node src/cli.ts report:daily --days 7`.

Termine par une synthèse courte, **ventilée par zone** (Lille, Paris,
Pas-de-Calais, remote) : nouvelles opportunités de la semaine, les HIGH avec leurs
réserves, une zone qui n'a rien donné (dis-le, ne la passe pas sous silence), ce
qui attend une décision de Nicolas (dont les messages APPROVED prêts pour
`outreach:send`), et le rappel qu'aucun message n'a été envoyé ni approuvé par
les agents.

$ARGUMENTS
