---
description: Rapport global — opportunités, prospection, messages prêts, relances, statistiques
allowed-tools: Bash, Read
---

Régénère et présente le rapport.

```bash
node src/cli.ts match:all
node src/cli.ts report:daily --days 7
```

Puis lis `data/reports/daily-report.md` et présente-le en gardant les points
faibles à côté des scores. Si la base est vide, dis-le et propose `/sales`.

$ARGUMENTS
