# nbeny-sales

Équipe d'agents de prospection, matching et suivi pour le profil de
[Nicolas BENY](https://nbeny.fr).

Aucune dépendance. TypeScript exécuté nativement par Node 24 — pas de build,
pas de `npm install`.

```bash
node --test "test/*.test.ts"   # 50 tests
node src/cli.ts help
node src/cli.ts opportunity:list --min-score 85 --min-coverage 6 --details
```

## Le principe

**Les agents sont les yeux, le code est la mémoire.**

Les agents cherchent, lisent des pages publiques et en extraient des faits
sourcés. Tout ce qui est déterministe — identifiants, déduplication, transitions
de pipeline, calcul du score, rendu des rapports — est du code testé. Un agent ne
peut pas écrire dans `data/` : il passe par la CLI, qui valide et refuse.

## Ce qui est garanti par le code, pas par la bonne volonté

| Garantie | Où elle est appliquée |
| --- | --- |
| Un fait sans URL source est rejeté | `src/lib/validate.ts` |
| Un champ ne peut pas être fait *et* hypothèse | `src/lib/validate.ts` |
| Une inconnue sort du score au lieu de valoir zéro | `src/lib/scoring.ts` |
| Les points faibles sont toujours retournés avec le score | `src/lib/scoring.ts` |
| Une offre republiée ailleurs ne compte qu'une fois | `src/lib/dedup.ts` |
| Un message est créé en `DRAFT` et ne peut pas naître `SENT` | `src/lib/validate.ts` |
| Une opportunité ne remonte pas le pipeline | `src/lib/pipeline.ts` |

## Slash commands

| Commande | Effet |
| --- | --- |
| `/sales` | Journée complète : recherche, qualification, prospection, brouillons, relances, rapport |
| `/jobs` | Offres publiées, tous contrats |
| `/freelance` | Missions freelance |
| `/cdi` | CDI, y compris sous des intitulés inattendus |
| `/prospect` | Entreprises à démarcher sans offre publiée |
| `/marketing` | Contenus et visibilité |
| `/seo` | Audit SEO de nbeny.fr |
| `/report` | Rapport global |

## Agents

`ceo` · `profile` · `job-research` · `freelance` · `cdi` · `sales` · `match` ·
`outreach` · `followup` · `personal-marketing` · `seo`

Ajouter un agent = ajouter un fichier dans `.claude/agents/`. Aucun code à
modifier.

**Restent à écrire** (itération 2) : `company`, `lead`, `intelligence`,
`hidden-opportunity`, `positioning`.

## Rémunération

Il n'y a pas de TJM unique dans ce système. `data/profile.json` porte une
référence **par marché** (`fr-hdf`, `fr-paris`, `ch`, `ca`, `us`, `sg`, `hk`…),
toutes à `unknown` au départ. Tant qu'un marché n'a pas de référence, la
dimension `SALARY_OR_TJM` est exclue du score plutôt que devinée.

```bash
node src/cli.ts profile:set-market fr-hdf --floor 420 --target 500 \
  --source https://www.hellowork.com/fr-fr/emplois/82680838.html
node src/cli.ts match:all
```

`--source` est obligatoire : un montant sans annonce à l'appui est une
estimation, pas un fait.

## Ce qui ne partira jamais tout seul

Aucun email, aucun message LinkedIn, aucune candidature. Les agents produisent
des brouillons ; Nicolas relit, envoie lui-même, puis enregistre l'envoi :

```bash
node src/cli.ts outreach:mark-sent MSG-2026-0001
```

## Données

`data/` est ignoré par git à l'exception de `profile.json` : la base contient des
informations sur des entreprises et des personnes, et n'a pas vocation à partir
sur un dépôt distant.
