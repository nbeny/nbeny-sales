# Envoi des emails de prospection depuis la messagerie urbanlink

**Date** : 2026-09-26
**Dépôts touchés** : `nbeny-sales` (CLI) et `infra` (rôle `mailcow`)

## Pourquoi

Les agents produisent des brouillons (`data/outreach.json`), mais rien n'en
sort : 27 brouillons, 0 envoi, 0 réponse. Le copier-coller vers un webmail
est la friction. On veut que la CLI envoie elle-même, sans rien céder sur ce
qui protège Nicolas : aucun message ne part sans qu'il l'ait relu et approuvé.

## Décisions

| Question | Décision |
|---|---|
| Qui déclenche l'envoi | Nicolas approuve chaque message ; la CLI envoie les messages approuvés. Aucun agent n'approuve ni n'envoie. |
| Expéditeur | Boîte dédiée `nicolas@urbanlink.fr`, mot de passe propre, révocable seul. |
| Transport | Tunnel SSH ouvert à la demande par la CLI via `pve`, vers `10.0.0.140:465` (SMTPS). Aucun port nouveau exposé. |
| Trace de l'envoi | Copie cachée à l'expéditeur : le message apparaît dans la boîte Mailcow. |

**Hors périmètre** : lecture des réponses (IMAP), relances automatiques,
LinkedIn et formulaires web. Les réponses se saisissent à la main comme
aujourd'hui.

## Règle 3 réécrite (CLAUDE.md)

> **Rien ne part sans l'approbation de Nicolas.** Les agents produisent des
> brouillons ; ils peuvent y attacher un destinataire lu sur une page publique.
> Seul Nicolas approuve (`outreach:approve`), message par message, et seuls les
> messages approuvés peuvent être envoyés (`outreach:send`). Aucun agent
> n'appelle `approve` ni `send`.

## Côté infra (rôle `mailcow`)

1. `mailcow_mailboxes` gagne une entrée
   `{ local_part: nicolas, domain: urbanlink.fr, name: "Nicolas BENY", quota: 2048, password_env: PROSPECTION_MAIL_PASSWORD, ratelimit: "20/h" }`.
2. `accounts.yml` : champ optionnel `password_env`. S'il est présent, le mot de
   passe est lu sous ce nom dans `kube/urbanlink/secrets.env` (même fichier,
   même lecture que `CONSOLE_ADMIN_PASSWORD`, même contrôle de longueur
   minimale et même message d'erreur s'il manque). Absent : comportement actuel,
   inchangé pour les boîtes existantes.
3. Champ optionnel `ratelimit` : appliqué par l'API Mailcow
   (`/api/v1/edit/rl-mbox`). C'est la borne côté serveur, indépendante de la
   CLI : un bug de boucle dans la CLI ne peut pas dépasser 20 messages par heure.
4. Les deux champs sont documentés en commentaire dans `defaults/main.yml`
   (le rôle n'a pas de README ; c'est là que vit sa documentation).

Déploiement : `ansible-playbook ansible/playbooks/42-mailcow.yml`, après avoir
ajouté `PROSPECTION_MAIL_PASSWORD` dans `secrets.env`.

## Côté nbeny-sales

### Modèle

`OutreachMessage` gagne :

```ts
to?: { email: string; name?: string; sourceUrl: string; readAt: string }
approvedAt?: string
approvedHash?: string   // empreinte de to + subject + body au moment de l'approbation
messageId?: string      // Message-ID de l'email réellement envoyé
```

`OutreachStatus` reste `'DRAFT' | 'APPROVED' | 'SENT'`.

### Cycle d'un message

```
DRAFT ──outreach:set-recipient──▶ DRAFT + to
      ──outreach:approve─────────▶ APPROVED      (Nicolas seul)
      ──outreach:send────────────▶ SENT          (sentAt, messageId)
                                └─▶ échec : reste APPROVED, erreur journalisée
```

- **`outreach:set-recipient <id> --email x --source <url> [--name n]`**
  Valide la forme de l'adresse et exige `--source` (règle 2 : un fait porte son
  URL). Enregistre `readAt`. Autorisé aux agents.
- **`outreach:approve <id>`**
  Refuse si `channel !== 'email'`, si `to` manque, si l'objet ou le corps
  contiennent encore un marqueur à compléter, ou si l'opportunité liée est
  dans un état terminal (`LOST`, `NO_RESPONSE`). Affiche le message complet tel
  qu'il partira (expéditeur, destinataire, objet, corps), puis enregistre
  `approvedAt` et `approvedHash`. Un marqueur est tout segment entre crochets
  (`[TJM à confirmer par Nicolas]`, forme utilisée par `outreach-agent`) ;
  détecté par une nouvelle fonction `findPlaceholders` de `validate.ts`. Les
  formules génériques de `lintOutreachBody` restent un avertissement, pas un
  blocage.
- **`outreach:send <id> | --all-approved [--dry-run] [--force-recipient]`**
  Détaillé plus bas.
- **Invalidation** : si `to`, `subject` ou `body` changent après approbation,
  l'empreinte ne correspond plus ; `send` refuse et le message doit être
  réapprouvé. `outreach:edit` et `outreach:set-recipient` effacent déjà
  l'approbation ; l'empreinte couvre en plus une édition manuelle de `data/`.
- **`outreach:edit <id> --file <json>`** (`subject` et/ou `body`) : seule façon
  de corriger un brouillon, notamment pour remplacer un marqueur. Mêmes
  validations que `outreach:add` ; repasse le message en `DRAFT` et efface
  l'approbation. Refusé sur un message `SENT`.
- **Confirmation au clavier** : `approve` et `clear-sending` exigent un
  terminal interactif (`process.stdin.isTTY`) et que Nicolas tape l'identifiant
  du message. Un agent lance ses commandes sans TTY : il ne peut pas approuver,
  même si ses permissions l'autorisent à appeler la CLI (la tâche planifiée
  pré-autorise `node src/cli.ts *`). C'est le verrou dur ; les règles `ask` de
  `.claude/settings.json` en sont un second.
- `outreach:mark-sent` reste pour les envois faits hors CLI.

### Nouveaux modules

- **`src/lib/mime.ts`** — `buildMessage({ from, to, subject, body, date, messageId? }) → { messageId, raw }`.
  En-têtes `From`, `To`, `Subject` (RFC 2047, UTF-8, encodé seulement si non
  ASCII), `Date` (RFC 5322), `Message-ID: <uuid@urbanlink.fr>`,
  `MIME-Version`, `Content-Type: text/plain; charset=utf-8`,
  `Content-Transfer-Encoding: quoted-printable`. Fins de ligne CRLF. Pas de
  `Bcc` dans les en-têtes : la copie cachée ne passe que par `RCPT TO`. Pur,
  sans réseau.
- **`src/lib/smtp.ts`** — `sendMail({ host, port, servername, user, pass, from, rcpt[], raw, tls })`
  sur `node:tls` (ou `node:net` quand `tls: false`, pour les tests). Séquence :
  lecture du 220, `EHLO`, `AUTH PLAIN`, `MAIL FROM`, un `RCPT TO` par
  destinataire, `DATA`, corps avec doublement des points en tête de ligne,
  `.`, `QUIT`. Chaque réponse inattendue lève une `SmtpError` portant la
  commande, le code et le texte du serveur. Délai maximal par réponse : 30 s.
  TLS vérifié normalement : `servername: mail.urbanlink.fr` couvre le
  certificat wildcard même à travers le tunnel.
- **`src/lib/tunnel.ts`** — `withTunnel({ jumpHost, target, targetPort }, fn)`.
  Choisit un port local libre, lance `ssh -N -o ExitOnForwardFailure=yes -L`,
  attend jusqu'à 15 s que le port local accepte une connexion, exécute `fn`, et
  termine le processus `ssh` dans un `finally`. Si `ssh` meurt avant d'être
  prêt, l'erreur remonte avec son stderr.
- **`config/mail.json`** (versionné, aucun secret) :

```json
{
  "from": { "email": "nicolas@urbanlink.fr", "name": "Nicolas BENY" },
  "bccSelf": true,
  "smtp": { "host": "10.0.0.140", "port": 465, "servername": "mail.urbanlink.fr" },
  "tunnel": { "jumpHost": "pve" },
  "dailyCap": 10,
  "minDelaySeconds": 90,
  "recipientCooldownDays": 30
}
```

### Le secret

Lu dans `%USERPROFILE%\.nbeny-sales\smtp.env` (`SMTP_PASSWORD=...`), hors du
dépôt et hors de `data/`. Pas de variable d'environnement : elle fuirait dans
les journaux de la tâche planifiée. Absent : `send` s'arrête en disant quel
fichier créer ; `--dry-run` fonctionne sans.

### `outreach:send` — les garde-fous, dans l'ordre

1. Le message est `APPROVED`, `channel: 'email'`, `to` présent, empreinte
   conforme.
2. L'opportunité liée n'est pas dans un état terminal (une annonce retirée
   passée en `LOST` bloque l'envoi de son brouillon).
3. Aucun événement `outreach:sending` pour ce message sans `outreach:sent`
   correspondant dans `data/history/` (voir « Coupure en plein envoi »).
4. `to.email` n'a reçu aucun message `SENT` depuis `recipientCooldownDays`,
   sauf `--force-recipient`.
5. Le nombre d'envois du jour (événements `outreach:sent` du jour) est sous
   `dailyCap`. Au-delà, les messages restants sont listés et laissés
   `APPROVED`.
6. Entre deux envois d'un même lot : `minDelaySeconds`.

`--dry-run` exécute 1 à 5 et affiche le message brut qui partirait, sans ouvrir
de tunnel.

**Coupure en plein envoi.** `outreach:sending` est journalisé juste avant
`DATA` ; le passage à `SENT` (avec `sentAt`, `messageId`) et l'événement
`outreach:sent` suivent la réponse 250. Si le processus meurt entre les deux,
on ne sait pas si le message est parti : le garde-fou 3 bloque le message et
la commande demande de vérifier le dossier Envoyés, puis de trancher avec
`outreach:mark-sent` ou `outreach:clear-sending <id>`. Un doublon chez un
recruteur coûte plus cher qu'un message en retard.

**Échec SMTP** (4xx, 5xx, TLS, tunnel) : code et texte du serveur affichés
tels quels, le message reste `APPROVED`. Si l'échec survient avant `DATA`, ou
si le serveur refuse explicitement (code 4xx/5xx), c'est certain : événement
`outreach:send-failed`. Sinon (délai ou coupure après le début de la
transmission), on ne sait pas : événement `outreach:send-uncertain`, qui ne
lève pas le blocage `sending`. Un
lot s'arrête au premier échec d'authentification ou de tunnel, continue après
un refus propre à un destinataire.

### Ce que `send` fait après succès

Exactement ce que fait `outreach:mark-sent` aujourd'hui (statut, `sentAt`,
historique), plus `messageId`. Pas de création automatique de relance : le
comportement reste celui de `mark-sent`.

## Agents et documentation

- `CLAUDE.md` : règle 3 réécrite, commandes ajoutées, compteur de tests mis à
  jour.
- `.claude/agents/outreach-agent.md` : peut appeler `outreach:set-recipient`
  quand l'adresse est lue sur une page publique (URL obligatoire) ; jamais
  `approve` ni `send`. Une adresse reconstituée (`prenom.nom@domaine`) n'est pas
  une adresse lue.
- `.claude/agents/ceo-agent.md` et la commande `/sales` : la synthèse liste les
  messages `APPROVED` en attente d'envoi.
- `.claude/settings.json` : règles `ask` sur `outreach:approve`,
  `outreach:send` et `outreach:clear-sending`.

## Tests (`node --test`)

- **mime** : objet accentué encodé, objet ASCII laissé tel quel, ligne de plus
  de 76 caractères coupée, point en tête de ligne, absence d'en-tête `Bcc`.
- **smtp** : contre un faux serveur `node:net` démarré dans le test ; parcours
  complet (vérifie les commandes reçues et le doublement des points), refus
  `535` à l'authentification, refus `550` au `RCPT`, délai dépassé.
- **cycle** : `approve` refusé sans `to`, avec marqueur restant, sur
  opportunité `LOST` ; `send` refusé sur `DRAFT`, sur `SENT`, sur empreinte
  modifiée, sur `sending` orphelin, au-delà du plafond, sur destinataire récent
  sans `--force-recipient`.
- **validation** : `set-recipient` refusé sans `--source` ou avec une adresse
  mal formée ; `findPlaceholders` trouve `[TJM à confirmer par Nicolas]` et
  ignore un texte sans crochets.

Le tunnel n'a pas de test unitaire. Vérification manuelle : `--dry-run`, puis
un premier envoi réel vers `alesio@urbanlink.fr`.

## Mise en service

1. Ajouter `PROSPECTION_MAIL_PASSWORD` dans `kube/urbanlink/secrets.env`,
   lancer le playbook `42-mailcow`.
2. Ajouter l'hôte `pve` à `~/.ssh/config` (d'après `infra/ssh/config.example`)
   et vérifier `ssh pve true` sans mot de passe.
3. Créer `%USERPROFILE%\.nbeny-sales\smtp.env`.
4. `outreach:send --dry-run` sur un message de test, puis envoi réel vers
   `alesio@urbanlink.fr`, puis contrôle des en-têtes reçus (SPF, DKIM, DMARC
   `pass`).
