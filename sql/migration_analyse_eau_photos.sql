-- migration_analyse_eau_photos.sql
-- =============================================================================
-- Extension de la mission "Envoi sécurisé de photos client" (02/09/2026) à
-- l'app Analyse d'eau. Le bucket Storage privé "client-uploads" et les
-- tables client_uploads / upload_rate_log ont déjà été créés par
-- sql/migration_client_uploads_storage.sql (app Îlots flottants, même
-- projet Supabase) — CETTE migration NE LES RECRÉE PAS, elle les adapte
-- pour être utilisables aussi par cette app :
--   1) ajoute request_id/notified_at à "dossiers" (équivalent ici de
--      client_requests) ;
--   2) remonte la limite native du bucket de 10 à 20 Mo (l'app Analyse
--      d'eau annonce déjà "max 20 Mo" à ses clients ; l'app Îlots
--      flottants continue d'appliquer sa propre limite de 10 Mo au niveau
--      applicatif, donc rien ne change pour elle — cette limite de bucket
--      n'est qu'un plafond de sécurité supplémentaire, pas la limite
--      réellement affichée/appliquée) ;
--   3) étend les policies RLS de lecture/mise à jour de client_uploads
--      pour reconnaître aussi les comptes listés dans admin_users (table
--      historique propre à cette app), pas seulement profiles.role='admin'
--      — même logique de double reconnaissance que loginOp() dans
--      aquiklin_final_2_migre.html (voir migration_analyse_eau_admin_unification.sql
--      du 31/08/2026, déjà en place).
-- À exécuter une seule fois dans Supabase (Dashboard > SQL Editor).
-- Idempotente : peut être relancée sans risque.
-- =============================================================================

-- -----------------------------------------------------------------------
-- 1) dossiers : ajout du couple request_id / notified_at
-- -----------------------------------------------------------------------
-- Même principe que client_requests.request_id (app Îlots flottants) :
-- généré côté navigateur (crypto.randomUUID()) avant l'upload, jamais tiré
-- du champ "id" existant (texte généré côté client, format 'new_<ts>',
-- conservé tel quel — hors périmètre de cette mission).
alter table public.dossiers
  add column if not exists request_id uuid,
  add column if not exists notified_at timestamptz;

create unique index if not exists dossiers_request_id_idx
  on public.dossiers (request_id)
  where request_id is not null;

-- -----------------------------------------------------------------------
-- 2) Bucket partagé "client-uploads" : limite native remontée à 20 Mo
-- -----------------------------------------------------------------------
update storage.buckets
set file_size_limit = 20971520 -- 20 Mo
where id = 'client-uploads';

-- -----------------------------------------------------------------------
-- 3) client_uploads : les policies admin reconnaissent aussi admin_users
-- -----------------------------------------------------------------------
-- Remplace les deux policies créées par migration_client_uploads_storage.sql
-- par une version qui accepte l'UNE OU L'AUTRE des deux façons d'être
-- reconnu opérateur sur ce projet Supabase partagé.
drop policy if exists client_uploads_admin_select on public.client_uploads;
create policy client_uploads_admin_select on public.client_uploads
  for select
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (select 1 from public.admin_users au where au.user_id = auth.uid())
  );

drop policy if exists client_uploads_admin_update on public.client_uploads;
create policy client_uploads_admin_update on public.client_uploads
  for update
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (select 1 from public.admin_users au where au.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (select 1 from public.admin_users au where au.user_id = auth.uid())
  );

-- -----------------------------------------------------------------------
-- Fin de la migration. Prochaine étape : variables d'environnement du
-- second projet Vercel (voir SETUP.md de ce dépôt) avant de déployer.
-- -----------------------------------------------------------------------
