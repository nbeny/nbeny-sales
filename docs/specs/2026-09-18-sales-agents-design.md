# Équipe d'agents commerciaux — Design

Date : 2026-09-18 · Statut : validé

## Problème

Nicolas BENY (développeur fullstack senior, Wimereux) veut augmenter le flux
d'opportunités professionnelles pertinentes — freelance et CDI, à poids égal —
sans y consacrer un temps de recherche manuel quotidien.

## Principe structurant

**Les agents sont les yeux, le code est la mémoire.**

Les LLM cherchent et lisent bien, mais hallucinent et perdent l'état. Donc :

- Ce qui est déterministe est du **code testé** : attribution des identifiants,
  déduplication, légalité des transitions de pipeline, calcul du score, rendu
  des rapports.
- Les agents ne font que chercher, lire et **extraire des faits sourcés**, puis
  appellent la CLI, qui valide et **refuse** les données non conformes.

Un agent ne peut pas écrire directement dans `data/` : il passe par
`node src/cli.ts`, seul point d'écriture.

## Faits vs hypothèses

Chaque champ qui participe au score porte une preuve :

```ts
type Evidence<T> = { value: T; sourceUrl: string; observedAt: string }
```

Un champ sans `sourceUrl` ne peut pas entrer dans `facts` : il va dans
`assumptions[]`, s'affiche avec ⚠️ dans les rapports et **ne participe pas au
score**. La validation d'écriture rejette toute opportunité dont un champ scoré
prétend être un fait sans URL.

## Rémunération : une table par marché, pas un nombre

Le marché local (Hauts-de-France) est faible ; les attentes de TJM et de salaire
n'ont de sens que rapportées à un marché. `profile.json` porte donc une table
`compensation.markets` avec, par marché, `floor` / `target` / `status`.

`status: "unknown"` est l'état initial de tous les marchés. Le scoring exclut
alors la dimension au lieu de deviner. `POSITIONING_AGENT` remplit ces cases
avec des chiffres **observés dans de vraies annonces, sourcés** — jamais estimés.

## Scoring

Huit dimensions : TECH, LOCATION, REMOTE, CONTRACT, SALARY_OR_TJM, TECHNOLOGY,
EXPERIENCE, SECTOR. Poids dans `config/scoring.json`.

Chaque dimension renvoie `{ status, score, weight, reason, evidence }`. Les
dimensions `UNKNOWN` sont **retirées du dénominateur** : le rapport affiche
`82/100 (couverture 6/8)` plutôt qu'un score gonflé par des inconnues. La liste
des points faibles est une section obligatoire du rendu — jamais masquée.

## Garde-fou anti-envoi

`OUTREACH_AGENT` produit des brouillons `status: DRAFT`. La transition
`DRAFT → SENT` n'existe que via `node src/cli.ts outreach:mark-sent <id>`,
lancée par un humain. Les agents ont interdiction explicite d'appeler les outils
d'envoi (Gmail, LinkedIn, MCP divers) ; c'est inscrit dans leur `allowed-tools`.

## Sources

Uniquement des sources publiques, via `WebSearch` et `WebFetch`. Pas de
scraping, pas de contournement de CAPTCHA ou de protection anti-bot, pas de
collecte de données personnelles sensibles. Les plateformes dont les CGU
interdisent l'extraction automatisée ne sont consultées que comme un humain le
ferait, et seules les informations professionnelles publiques sont conservées.

## Pipeline

```
DISCOVERED → FILTERED → QUALIFIED → MATCHED → PRIORITIZED → OUTREACH_READY
→ CONTACTED → REPLIED → INTERVIEW → NEGOTIATION → WON | LOST
```

Transitions avant uniquement, plus `LOST` et `NO_RESPONSE` atteignables depuis
tout état actif. Chaque transition est horodatée dans `history[]`.

## Itération 1

`PROFILE`, `CEO`, `JOB_RESEARCH`, `FREELANCE`, `SALES`, `MATCH`, `OUTREACH`,
`FOLLOWUP`, `PERSONAL_MARKETING` + couche data testée + commandes + rapport réel.

## Itération 2

`CDI`, `COMPANY`, `LEAD`, `SEO`, `INTELLIGENCE`, `HIDDEN_OPPORTUNITY`,
`POSITIONING`. Ajouter un agent = un fichier `.claude/agents/*.md`, aucun code
à modifier.
