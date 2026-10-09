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
3. **Rien ne part sans l'approbation de Nicolas.** Les agents produisent des
   brouillons ; ils peuvent y attacher un destinataire lu sur une page publique
   (`outreach:set-recipient`, URL obligatoire). Seul Nicolas approuve
   (`outreach:approve`, confirmation au clavier), message par message, et seuls
   les messages approuvés partent (`outreach:send`). Aucun agent n'appelle
   `approve` ni `clear-sending` ; `send` ne part que sur demande explicite de
   Nicolas, après confirmation. Aucun message LinkedIn, aucune candidature par
   formulaire.
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
node src/cli.ts opportunity:list --priority HIGH --remote full --sort remote
node src/cli.ts match:all
node src/cli.ts opportunity:remove-fact OPP-x seniorityYears --reason "..."   # fait non lu
node src/cli.ts report:daily --days 7
node src/cli.ts location:list lille paris pas-de-calais   # zones et villes reconnues
node src/cli.ts location:set lille --travel 100 --max-onsite 3   # Nicolas seul
node src/cli.ts runs                       # lancements planifiés (tâche Windows nbeny-sales-daily)
node src/cli.ts outreach:set-recipient MSG-x --email a@b.fr --source https://...
node src/cli.ts outreach:edit MSG-x --file x.json    # corrige, annule l'approbation
node src/cli.ts outreach:approve MSG-x        # Nicolas, au clavier
node src/cli.ts outreach:clear-sending MSG-x  # Nicolas, au clavier
node src/cli.ts outreach:send MSG-x --dry-run # puis sans --dry-run
node --test "test/*.test.ts"               # 235 tests, sans dépendance
```

Application interactive pour Nicolas : `sales.cmd` ou `node src/cli.ts` sans argument
(menus au clavier ; elle lit la base et relance la CLI pour chaque action). Les
agents ne la lancent pas : ils appellent les commandes directement.

`/sales` couvre les **7 derniers jours** sur Lille, Paris, tout le Pas-de-Calais,
le remote France et le **full remote international** (monde entier, fuseau,
éligibilité et contrat relevés sur l'offre). Les zones et leurs villes viennent de `config/locations.json`, que
Nicolas règle dans l'app (menu Lieux) ou via `location:set|add|home`. Ces
commandes lui sont réservées : les agents lisent les lieux (`location:list`), ne
les modifient pas, et la tâche planifiée les interdit.

Tous les agents tournent sur Sonnet (`model: sonnet` dans leur frontmatter) ; un
nouvel agent doit porter la même ligne.

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
