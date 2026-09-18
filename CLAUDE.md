# nbeny-sales — équipe commerciale virtuelle

Système d'agents de prospection, matching et suivi pour le profil de Nicolas BENY
(https://nbeny.fr). Aucune dépendance : TypeScript exécuté nativement par Node 24.

## Les règles que personne ne contourne

1. **Ne jamais inventer.** Ni une expérience, ni une compétence, ni un TJM, ni un
   contact, ni une entreprise. La source de vérité du profil est `data/profile.json`,
   lui-même construit à partir de https://nbeny.fr.
2. **Un fait porte son URL.** Tout ce qui entre dans `facts` doit venir d'une page
   publique consultée, avec son URL et sa date de lecture. Le reste va dans
   `assumptions`, avec la raison, et ne compte pas dans le score.
3. **Ne jamais rien envoyer.** Aucun email, aucun message LinkedIn, aucune
   candidature. Les agents produisent des brouillons ; Nicolas décide et envoie.
4. **Ne jamais masquer un point faible.** Un score sans ses réserves est un
   mensonge par omission.
5. **Ne jamais écrire dans `data/` à la main.** Tout passe par `node src/cli.ts`,
   qui valide, déduplique, attribue les identifiants et journalise.

## Ce qui manque encore au profil

`data/profile.json` → `unknowns`. Ces trous sont assumés : il vaut mieux une
dimension marquée UNKNOWN qu'un chiffre inventé. Les remplir améliore le scoring.

## Commandes

```bash
node src/cli.ts help                       # toutes les commandes
node src/cli.ts opportunity:add --file x.json
node src/cli.ts opportunity:list --priority HIGH
node src/cli.ts match:all
node src/cli.ts report:daily
node --test "test/*.test.ts"               # 50 tests, sans dépendance
```

## Slash commands

`/sales` `/jobs` `/freelance` `/cdi` `/prospect` `/marketing` `/seo` `/report`

## Architecture

- `src/lib/` — le déterministe : identifiants, déduplication, pipeline, scoring,
  validation, rapports. Testé. C'est la mémoire du système.
- `.claude/agents/` — les agents : ils cherchent, lisent, extraient des faits
  sourcés, et appellent la CLI. Ce sont les yeux du système.
- `config/` — poids du scoring, localisations et temps de trajet, vocabulaire,
  sources autorisées. Se règle sans toucher au code.
- `data/` — la base. Écrite uniquement par la CLI.

Ajouter un agent = ajouter un fichier dans `.claude/agents/`. Aucun code à modifier.

## Marché et rémunération

Le marché des Hauts-de-France est faible : il n'y a pas de TJM unique qui ait du
sens. `profile.json` porte une référence **par marché**, toutes à `unknown` au
départ. Tant qu'un marché n'a pas de référence, la dimension SALARY_OR_TJM est
exclue du score. On la remplit avec des montants lus dans de vraies annonces :

```bash
node src/cli.ts profile:set-market fr-hdf --floor 420 --target 500 --source https://...
```
