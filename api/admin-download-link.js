// api/admin-download-link.js
// -----------------------------------------------------------------------
// Génère une URL de téléchargement SIGNÉE ET TEMPORAIRE pour UNE photo
// d'une demande, à l'usage exclusif de l'administrateur connecté (aperçu
// miniature ou téléchargement individuel dans "Fichiers reçus", §8 de la
// mission). Jamais d'URL publique permanente (§5/§3) : le lien renvoyé
// expire de lui-même après quelques minutes.
//
// Protégé par l'authentification Supabase Auth réelle de l'admin (jeton
// transmis en "Authorization: Bearer ...", re-vérifié ici côté serveur via
// isAdminToken() — jamais sur la seule foi du code d'accès cosmétique côté
// client de configurateuradmin.html).
// -----------------------------------------------------------------------
const { restAdmin, storageAdmin, isAdminToken, SUPABASE_URL } = require('../lib/supabaseAdmin');
const { getBearerToken, readJsonBody, sendJson } = require('../lib/security');

const BUCKET = 'client-uploads';
const EXPIRES_IN_SECONDS = 300; // 5 minutes — assez pour charger une miniature ou lancer un téléchargement

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée.' });

  const token = getBearerToken(req);
  if (!(await isAdminToken(token))) {
    return sendJson(res, 403, { error: 'Accès administrateur requis.' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Requête invalide.' }); }

  const uploadId = body.id;
  const storagePath = body.storage_path;
  if (!uploadId && !storagePath) {
    return sendJson(res, 400, { error: 'Fichier non spécifié.' });
  }

  // Ne signe QUE des chemins qui correspondent réellement à une ligne
  // client_uploads existante et effectivement "uploaded" — jamais un chemin
  // arbitraire fourni par l'appelant.
  const filter = uploadId
    ? `id=eq.${encodeURIComponent(uploadId)}`
    : `storage_path=eq.${encodeURIComponent(storagePath)}`;
  const rowRes = await restAdmin(`/rest/v1/client_uploads?select=id,storage_path,original_name,status&${filter}`);
  if (!rowRes.ok) return sendJson(res, 502, { error: 'Erreur serveur, réessayez.' });
  const rows = await rowRes.json().catch(() => []);
  const row = rows[0];
  if (!row || row.status !== 'uploaded') {
    return sendJson(res, 404, { error: 'Fichier introuvable.' });
  }

  const signRes = await storageAdmin(`/storage/v1/object/sign/${BUCKET}/${row.storage_path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: EXPIRES_IN_SECONDS })
  });
  if (!signRes.ok) {
    const errBody = await signRes.json().catch(() => ({}));
    console.warn('Échec génération lien signé :', signRes.status, errBody);
    return sendJson(res, 502, { error: 'Impossible de générer le lien, réessayez.' });
  }
  const signData = await signRes.json();

  return sendJson(res, 200, {
    url: `${SUPABASE_URL}/storage/v1${signData.signedURL}`,
    original_name: row.original_name,
    expires_in: EXPIRES_IN_SECONDS
  });
};
