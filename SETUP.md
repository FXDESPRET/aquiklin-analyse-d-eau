# Envoi sécurisé de fichiers client — Analyse d'eau — guide de mise en service

Ce document décrit ce qu'il reste à faire pour activer l'envoi réel de
fichiers dans l'app Analyse d'eau. La zone d'envoi existait déjà dans le
parcours client (« Cliquez ou déposez vos fichiers »), mais les fichiers
n'étaient jusqu'ici jamais réellement transmis — seul leur nombre était
enregistré. C'est corrigé : ils sont maintenant envoyés vers un stockage
Supabase privé, avec le même niveau de sécurité que la fonctionnalité
équivalente livrée pour l'app Îlots flottants (même principe, deuxième
déploiement indépendant).

⚠️ **Même avertissement que pour la première app** : le code touchant à
l'API Storage de Supabase n'a pas pu être testé contre un vrai projet
depuis cet environnement (pas d'accès réseau). Faites le test de bout en
bout de la section **9** avant de considérer cette fonctionnalité prête.

Ce document suppose que **la migration de l'app Îlots flottants a déjà été
exécutée** sur ce même projet Supabase (bucket `client-uploads` et tables
`client_uploads`/`upload_rate_log` déjà créés). Si ce n'est pas encore le
cas, exécutez d'abord `migration_client_uploads_storage.sql` (livré avec
l'app Îlots flottants), PUIS la migration ci-dessous.

---

## 1. Exécuter la migration SQL (spécifique à cette app)

Dashboard Supabase → **SQL Editor** → collez le contenu de
`sql/migration_analyse_eau_photos.sql` → Exécuter. Cette migration :

- ajoute `request_id`/`notified_at` à la table `dossiers` ;
- remonte la limite native du bucket partagé `client-uploads` de 10 à
  20 Mo (l'app Analyse d'eau annonce déjà « max 20 Mo » à ses clients —
  cela n'assouplit rien pour l'app Îlots flottants, qui applique de toute
  façon sa propre limite de 10 Mo au niveau applicatif) ;
- étend les policies de lecture/mise à jour de `client_uploads` pour
  reconnaître aussi les comptes listés dans `admin_users` (et pas
  seulement `profiles.role='admin'`) — cohérent avec la double
  vérification déjà faite par `loginOp()` dans cette app.

Idempotente, peut être relancée sans risque.

---

## 2. Récupérer la clé service_role

Identique à l'app Îlots flottants — Dashboard Supabase → **Project
Settings → API** → clé **`service_role`** (même projet Supabase, donc
c'est la MÊME clé pour les deux apps si vous l'avez déjà notée).

---

## 3. Déployer sur le second projet Vercel

Ce dépôt contient maintenant, en plus de `aquiklin_final_2_migre.html` :

```
api/
  create-upload-url.js       (identique à l'app Îlots flottants)
  confirm-upload.js          (identique)
  admin-download-link.js     (identique)
  admin-zip.js                (identique)
  admin-delete-upload.js      (identique)
  cleanup-expired-uploads.js  (identique)
  notify-admin.js             (adapté à la table "dossiers")
lib/
  supabaseAdmin.js  (isAdminToken reconnaît aussi admin_users)
  security.js       (limite 20 Mo/fichier au lieu de 10 Mo)
package.json         (dépendance "archiver")
vercel.json           (tâche planifiée quotidienne, 4h — décalée d'une
                        heure par rapport à l'app Îlots flottants pour ne
                        pas solliciter le projet Supabase partagé au même
                        instant)
sql/
  migration_analyse_eau_photos.sql
```

Poussez ces fichiers sur le dépôt GitHub de l'app Analyse d'eau. Vercel
détecte automatiquement `api/` et `package.json` — aucun réglage de build
particulier.

---

## 4. Variables d'environnement — second projet Vercel

Dashboard Vercel → **ce second projet** (celui de l'app Analyse d'eau) →
**Settings → Environment Variables** :

| Variable | Valeur | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://dnunawdqljlvkhwvwxxa.supabase.co` | identique aux deux apps |
| `SUPABASE_ANON_KEY` | *(la clé `SUPABASE_KEY` déjà utilisée dans `aquiklin_final_2_migre.html`)* | format JWT legacy, différent de la clé "publishable" utilisée par l'app Îlots flottants — les deux fonctionnent, ne pas les confondre |
| `SUPABASE_SERVICE_ROLE_KEY` | *(étape 2)* | **la même valeur que pour l'app Îlots flottants** (même projet Supabase) |
| `TURNSTILE_SECRET_KEY` | *(étape 5)* | propre à CE domaine — pas la même que l'autre app |
| `RESEND_API_KEY` | *(étape 6)* | peut être le même compte Resend que l'autre app |
| `RESEND_FROM` | ex. `Aquiklin <notifications@votredomaine.be>` | |
| `ADMIN_NOTIFY_EMAIL` | adresse qui reçoit les notifications | peut être la même adresse que l'autre app, ou une adresse dédiée à l'analyse d'eau |
| `NOTIFY_SHARED_SECRET` | une longue chaîne aléatoire | propre à cette app (ne pas réutiliser celle de l'autre, par hygiène) |
| `CRON_SECRET` | une autre longue chaîne aléatoire | propre à cette app |
| `SITE_URL` | l'URL de production de CETTE app (ex. celle affichée dans le lien "Découvrir" de l'app Îlots flottants) | |
| `IP_HASH_SALT` | une chaîne aléatoire quelconque | optionnel |

Redéployez après les avoir ajoutées.

---

## 5. Cloudflare Turnstile

Comme pour l'app Îlots flottants, mais avec un **widget Turnstile
distinct** (les clés Cloudflare sont liées à un domaine) :

1. https://dash.cloudflare.com → **Turnstile** → "Add site" → domaine de
   CETTE app.
2. Site Key → à coller dans `aquiklin_final_2_migre.html`, constante
   `TURNSTILE_SITE_KEY` (juste après `SUPABASE_KEY`).
3. Secret Key → variable Vercel `TURNSTILE_SECRET_KEY` de ce projet.

---

## 6. Resend

Vous pouvez réutiliser le même compte Resend et le même domaine vérifié
que pour l'app Îlots flottants (juste une adresse `RESEND_FROM`
différente si vous le souhaitez, ex. `analyse-eau@votredomaine.be`), ou
un compte séparé — les deux fonctionnent.

---

## 7. Déclencher l'e-mail opérateur — Database Webhook Supabase

Même principe que pour l'app Îlots flottants : `notify-admin.js` de CETTE
app relit la table `dossiers` (pas `client_requests`).

1. Dashboard Supabase → **Database → Webhooks** → "Create a new hook".
2. Table : `dossiers`. Événement : `INSERT` uniquement.
3. URL : `https://<domaine-du-second-projet-vercel>/api/notify-admin`.
4. En-tête HTTP `X-Notify-Secret` = *(la valeur de `NOTIFY_SHARED_SECRET`
   de CE projet)*.

⚠️ Si un webhook existe déjà sur `client_requests` pour l'app Îlots
flottants, celui-ci est **distinct** (table différente) — les deux
coexistent sans conflit sur le même projet Supabase.

---

## 8. Tâche planifiée de nettoyage

`vercel.json` déclare une exécution quotidienne à 4h (UTC) de
`/api/cleanup-expired-uploads` sur ce second projet. Comme pour l'app
Îlots flottants, Vercel ajoute automatiquement l'en-tête `Authorization:
Bearer $CRON_SECRET` dès que la variable existe (étape 4).

Note : les deux crons (Îlots flottants à 3h, Analyse d'eau à 4h)
nettoient chacun uniquement les fichiers `client_uploads` liés à leur
propre table parente (`client_requests` vs `dossiers`) — pas de risque
qu'un cron supprime les fichiers de l'autre app.

---

## 9. Test de bout en bout

1. Ouvrez l'app en navigation privée, avancez jusqu'à l'étape "Fichiers"
   du parcours, ajoutez 2-3 fichiers de test (JPG et PDF), terminez le
   diagnostic, choisissez "Oui, transmettre mon analyse", complétez le
   formulaire de contact, envoyez.
2. Vérifiez dans Supabase : `dossiers` a une nouvelle ligne avec
   `request_id` rempli ; `client_uploads` a une ligne par fichier
   (`status='uploaded'`) ; Storage → `client-uploads/requests/<request_id>/`
   contient les fichiers sous des noms aléatoires.
3. Vérifiez l'e-mail de notification (si le webhook de l'étape 7 est
   configuré).
4. Connectez-vous à la console opérateur (`#admin`), ouvrez le dossier
   correspondant → onglet **📎 Fichiers** → miniatures, ouverture d'un
   fichier, ZIP, suppression, "Conserver".
5. Testez les limites : 9e fichier (refusé), fichier de plus de 20 Mo,
   type non autorisé (ex. `.docx`) — chaque cas doit afficher un message
   clair sans jamais atteindre Supabase.
6. Vérifiez qu'un compte opérateur qui n'existe QUE dans `admin_users`
   (pas dans `profiles`) peut bien accéder à l'onglet Fichiers — c'est
   précisément ce que corrige la migration de l'étape 1, point 3.
7. Test du nettoyage automatique : même procédure que pour l'app Îlots
   flottants (voir son propre SETUP.md, section 9, point 7), en pointant
   vers `<domaine-de-cette-app>/api/cleanup-expired-uploads` et le
   `CRON_SECRET` de ce projet.

---

## Ce qui reste volontairement inchangé

- La section "📷 Photos du terrain" de l'onglet **Notes internes** (lien
  vers un dossier Google Drive) : c'est un usage différent, pour les
  photos prises par l'opérateur lui-même lors d'une visite sur site — rien
  à voir avec les fichiers envoyés par le client à l'intake. Les deux
  coexistent sans conflit.
- Le champ `dossier.id` (texte, généré côté client au format `new_<ts>`) :
  non modifié, `request_id` est un champ séparé dédié aux fichiers.
- Le champ `dossier.photos` (tableau vide) : laissé tel quel, non utilisé
  — la source de vérité pour les fichiers reçus est désormais uniquement
  la table `client_uploads`.
