// lib/supabaseAdmin.js
// -----------------------------------------------------------------------
// Petit client Supabase "maison" utilisant uniquement fetch() (aucune
// dépendance npm) — le front (aquiklin_final_2_migre.html) utilise, lui,
// le SDK officiel @supabase/supabase-js, mais ces fonctions SERVEUR n'en
// ont pas besoin : de simples appels REST/Storage authentifiés avec la clé
// service_role suffisent, comme dans la copie de ce fichier utilisée par
// l'app Îlots flottants (même projet Supabase partagé).
//
// Ce module ne doit JAMAIS être importé par du code exécuté dans le
// navigateur — il porte la clé service_role (contourne toutes les policies
// RLS). Il n'est utilisé que par les fonctions serveur sous /api.
// -----------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dnunawdqljlvkhwvwxxa.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Valeur par défaut = la clé anon (format JWT legacy) déjà utilisée dans
// aquiklin_final_2_migre.html (SUPABASE_KEY) — surchargeable par la
// variable d'environnement SUPABASE_ANON_KEY si vous migrez vers le format
// "publishable" plus récent (comme l'app Îlots flottants).
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudW5hd2RxbGpsdmtod3Z3eHhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2NzQ1MzgsImV4cCI6MjA5MjI1MDUzOH0.4m_Cm8T2OcGs43FX3aWu6ZvDUev_Y-qjxmWbSkvUaRQ';

function assertServiceRoleConfigured() {
  if (!SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY manquante dans les variables d\'environnement Vercel — voir SETUP.md.');
  }
}

// Appel générique à l'API REST (table Postgres) avec la clé service_role
// (contourne RLS — usage strictement serveur). `path` commence par
// "/rest/v1/...".
async function restAdmin(path, options) {
  assertServiceRoleConfigured();
  options = options || {};
  const headers = Object.assign(
    {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    options.headers || {}
  );
  const res = await fetch(`${SUPABASE_URL}${path}`, Object.assign({}, options, { headers }));
  return res;
}

// Appel générique à l'API Storage avec la clé service_role. `path`
// commence par "/storage/v1/...".
async function storageAdmin(path, options) {
  assertServiceRoleConfigured();
  options = options || {};
  const headers = Object.assign(
    {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    },
    options.headers || {}
  );
  const res = await fetch(`${SUPABASE_URL}${path}`, Object.assign({}, options, { headers }));
  return res;
}

// Vérifie un jeton d'accès Supabase Auth (celui obtenu par un administrateur
// connecté dans configurateuradmin.html, transmis par le navigateur dans
// l'en-tête Authorization de l'appel à nos fonctions /api/admin-*) et
// renvoie l'utilisateur Supabase correspondant, ou null si le jeton est
// invalide/expiré. Utilise la clé anonyme pour cet appel précis (c'est
// l'usage normal de /auth/v1/user : identifier QUI est ce jeton, pas une
// opération privilégiée).
async function getUserFromAccessToken(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Vérifie qu'un jeton d'accès appartient bien à un compte opérateur —
// RE-VÉRIFIÉ ICI CÔTÉ SERVEUR avec la clé service_role (source de vérité,
// ne dépend d'aucune policy RLS qui pourrait être mal configurée) — jamais
// uniquement sur la base de ce que prétend le navigateur. Échec fermé :
// toute erreur renvoie false, jamais true par défaut.
//
// Deux systèmes coexistent sur ce projet Supabase partagé (voir loginOp()
// dans aquiklin_final_2_migre.html et migration_analyse_eau_admin_unification.sql
// du 31/08/2026) : la table admin_users, historique et propre à cette app,
// ET la table profiles (colonne role) mise en place pour l'app Îlots
// flottants. Un compte est reconnu opérateur ici s'il figure dans L'UN OU
// L'AUTRE — sinon un opérateur historique non (encore) présent dans
// profiles perdrait l'accès aux fonctions /api/admin-* alors qu'il peut
// toujours se connecter à la console elle-même.
async function isAdminToken(accessToken) {
  const user = await getUserFromAccessToken(accessToken);
  if (!user || !user.id) return false;
  try {
    const [profileRes, adminUserRes] = await Promise.all([
      restAdmin(`/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(user.id)}`),
      restAdmin(`/rest/v1/admin_users?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`)
    ]);
    let isAdmin = false;
    if (profileRes.ok) {
      const rows = await profileRes.json().catch(() => []);
      isAdmin = Array.isArray(rows) && rows[0] && rows[0].role === 'admin';
    }
    if (!isAdmin && adminUserRes.ok) {
      const rows = await adminUserRes.json().catch(() => []);
      isAdmin = Array.isArray(rows) && rows.length > 0;
    }
    return isAdmin;
  } catch (e) {
    return false;
  }
}

module.exports = {
  SUPABASE_URL,
  ANON_KEY,
  restAdmin,
  storageAdmin,
  getUserFromAccessToken,
  isAdminToken
};
