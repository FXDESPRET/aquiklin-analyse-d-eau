// api/confirm-upload.js
// -----------------------------------------------------------------------
// Appelé par le navigateur juste après qu'un PUT vers l'URL signée a
// réussi. Ne fait JAMAIS confiance à la taille/au type déclarés par le
// navigateur au moment de la demande d'URL (create-upload-url.js) :
// relit ici les métadonnées RÉELLES de l'objet effectivement stocké sur
// Supabase Storage (via l'API de listing, avec la clé service_role) et ne
// valide la ligne client_uploads (status -> 'uploaded') que si ces valeurs
// réelles respectent bien les limites — sinon l'objet est supprimé
// immédiatement et la ligne marquée en erreur. C'est la "validation de la
// taille réelle / du type MIME côté serveur" demandée au §2/§8 de la
// mission.
// -----------------------------------------------------------------------
const { restAdmin, storageAdmin } = require('../lib/supabaseAdmin');
const {
  MAX_FILE_SIZE_BYTES, ALLOWED_MIME_TYPES, readJsonBody, sendJson
} = require('../lib/security');

const BUCKET = 'client-uploads';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée.' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Requête invalide.' }); }

  const requestId = body.request_id;
  const storagePath = body.storage_path;
  if (!requestId || !storagePath || !storagePath.startsWith(`requests/${requestId}/`)) {
    return sendJson(res, 400, { error: 'Paramètres invalides.' });
  }

  // Retrouve la ligne 'pending' correspondante — refuse de confirmer un
  // chemin qui n'a pas été explicitement autorisé par create-upload-url.js.
  const rowRes = await restAdmin(
    `/rest/v1/client_uploads?select=id,status&storage_path=eq.${encodeURIComponent(storagePath)}&request_id=eq.${encodeURIComponent(requestId)}`
  );
  if (!rowRes.ok) return sendJson(res, 502, { error: 'Erreur serveur, réessayez.' });
  const rows = await rowRes.json().catch(() => []);
  const row = rows[0];
  if (!row) return sendJson(res, 404, { error: 'Fichier inconnu (aucune autorisation d\'upload correspondante).' });
  if (row.status === 'uploaded') return sendJson(res, 200, { ok: true }); // déjà confirmé, idempotent

  // Relit les métadonnées réelles de l'objet stocké (taille, type) —
  // jamais celles déclarées par le navigateur. L'API de listing Supabase
  // Storage renvoie ces informations dans le champ "metadata" de chaque
  // entrée.
  const folder = `requests/${requestId}`;
  const fileName = storagePath.slice(folder.length + 1);
  const listRes = await storageAdmin(`/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: folder, search: fileName, limit: 5 })
  });
  if (!listRes.ok) return sendJson(res, 502, { error: 'Impossible de vérifier le fichier envoyé, réessayez.' });
  const entries = await listRes.json().catch(() => []);
  const entry = Array.isArray(entries) ? entries.find(e => e.name === fileName) : null;

  async function rejectAndDelete(reason) {
    await storageAdmin(`/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [storagePath] })
    }).catch(() => {});
    await restAdmin(`/rest/v1/client_uploads?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'deleted' })
    }).catch(() => {});
    return sendJson(res, 400, { error: reason });
  }

  if (!entry || !entry.metadata) {
    return rejectAndDelete('Fichier introuvable après envoi — réessayez.');
  }
  const realSize = entry.metadata.size;
  const realMime = entry.metadata.mimetype;
  if (typeof realSize !== 'number' || realSize <= 0 || realSize > MAX_FILE_SIZE_BYTES) {
    return rejectAndDelete('Le fichier envoyé dépasse la taille maximale autorisée (10 Mo).');
  }
  if (!realMime || !ALLOWED_MIME_TYPES[realMime]) {
    return rejectAndDelete('Le fichier envoyé n\'est pas d\'un type autorisé (JPG, PNG, HEIC, WEBP, PDF).');
  }

  const updateRes = await restAdmin(`/rest/v1/client_uploads?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'uploaded',
      size_bytes: realSize,
      mime_type: realMime,
      uploaded_at: new Date().toISOString()
    })
  });
  if (!updateRes.ok) return sendJson(res, 502, { error: 'Erreur serveur, réessayez.' });

  return sendJson(res, 200, { ok: true });
};
