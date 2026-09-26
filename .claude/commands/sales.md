---
description: Journée commerciale complète — recherche, qualification, prospection, brouillons, relances, rapport
allowed-tools: Task, Bash, Read, Glob, Grep
---

Lance la journée commerciale. Délègue au `ceo-agent`, qui répartit le travail.

Déroulé attendu :

1. État des lieux : `node src/cli.ts stats` et `data/history/` du jour, pour ne
   pas relancer une recherche déjà faite.
2. En parallèle : `job-research-agent`, `freelance-agent`, `sales-agent`.
3. Puis `match-agent` pour faire monter la couverture des opportunités mal
   documentées, puis `node src/cli.ts match:all`.
4. `outreach-agent` sur les opportunités HIGH sans brouillon existant.
5. `followup-agent` pour les relances dues.
6. `node src/cli.ts report:daily`.

Termine par une synthèse courte : les HIGH avec leurs réserves, ce qui attend une
décision de Nicolas (dont les messages APPROVED prêts pour `outreach:send`), et
le rappel qu'aucun message n'a été envoyé ni approuvé par les agents.

$ARGUMENTS
