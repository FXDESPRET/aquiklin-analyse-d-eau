// api/admin-delete-upload.js
// -----------------------------------------------------------------------
// Supprime définitivement un ou plusieurs fichiers reçus d'une demande
// (bouton "Supprimer" de la section "Fichiers reçus", §8 de la mission) :
// retire l'objet de Supabase Storage PUIS sa ligne client_uploads. Utilise
// la clé service_role car aucune policy RLS de suppression n'existe pour
// les comptes authentifiés sur client_uploads/storage.objects (choix
// délibéré de la migration SQL — toute suppression doit obligatoirement
// passer par une fonction serveur qui revérifie l'identité admin, jamais
// directement depuis le navigateur).
//
// Deux modes, selon le corps de la requête :
//   { id: "<uuid client_uploads>" }        -> supprime UN fichier
//   { request_id: "<uuid>", all: true }     -> supprime TOUS les fichiers
//                                              de cette demande (utilisé
//                                              si l'admin supprime toute
//                                              une demande, ex. après le
//                                              délai de conservation)
// Protégé par authentification admin réelle, comme les autres endpoints
// admin-*.
// -----------------------------------------------------------------------
const { restAdmin, storageAdmin, isAdminToken } = require('../lib/supabaseAdmin');
const { getBearerToken, readJsonBody, sendJson } = require('../lib/security');

const BUCKET = 'client-uploads';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée.' });

  const token = getBearerToken(req);
  if (!(await isAdminToken(token))) {
    return sendJson(res, 403, { error: 'Accès administrateur requis.' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Requête invalide.' }); }

  let rows;
  if (body.all && body.request_id) {
    if (!UUID_RE.test(body.request_id)) return sendJson(res, 400, { error: 'Identifiant de demande invalide.' });
    const listRes = await restAdmin(
      `/rest/v1/client_uploads?select=id,storage_path&request_id=eq.${encodeURIComponent(body.request_id)}&status=neq.deleted`
    );
    if (!listRes.ok) return sendJson(res, 502, { error: 'Erreur serveur, réessayez.' });
    rows = await listRes.json().catch(() => []);
  } else if (body.id) {
    const rowRes = await restAdmin(`/rest/v1/client_uploads?select=id,storage_path&id=eq.${encodeURIComponent(body.id)}`);
    if (!rowRes.ok) return sendJson(res, 502, { error: 'Erreur serveur, réessayez.' });
    rows = await rowRes.json().catch(() => []);
  } else {
    return sendJson(res, 400, { error: 'Fichier(s) non spécifié(s).' });
  }

  if (!rows.length) return sendJson(res, 200, { ok: true, deleted: 0 });

  const paths = rows.map(r => r.storage_path).filter(Boolean);
  if (paths.length) {
    const delRes = await storageAdmin(`/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths })
    });
    if (!delRes.ok) {
      const errBody = await delRes.json().catch(() => ({}));
      console.warn('Échec suppression Storage :', delRes.status, errBody);
      return sendJson(res, 502, { error: 'Impossible de supprimer le(s) fichier(s), réessayez.' });
    }
  }

  const ids = rows.map(r => r.id);
  const delDbRes = await restAdmin(`/rest/v1/client_uploads?id=in.(${ids.join(',')})`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
  if (!delDbRes.ok) {
    console.warn('Fichiers supprimés de Storage mais échec suppression des lignes client_uploads :', ids);
    return sendJson(res, 502, { error: 'Fichiers supprimés mais erreur de nettoyage, contactez le support technique.' });
  }

  return sendJson(res, 200, { ok: true, deleted: rows.length });
};
