// api/admin-zip.js
// -----------------------------------------------------------------------
// "Télécharger tout en ZIP" (§6 de la mission) : génère un ZIP à la volée
// (jamais stocké, jamais envoyé par e-mail — voir la note du §6 : les
// photos peuvent être trop volumineuses pour un e-mail) contenant toutes
// les photos "uploaded" d'une demande, et le renvoie directement en flux au
// navigateur de l'administrateur. Protégé par authentification admin réelle
// (comme admin-download-link.js).
//
// Chaque fichier est récupéré depuis Supabase Storage avec la clé
// service_role (jamais via une URL publique) puis ajouté au flux ZIP au fur
// et à mesure — le contenu des photos ne transite JAMAIS par le navigateur
// avant d'être dans le ZIP final, et n'est jamais écrit sur disque côté
// serveur (streaming pur, adapté aux fonctions serverless).
// -----------------------------------------------------------------------
const archiver = require('archiver');
const { restAdmin, storageAdmin, isAdminToken } = require('../lib/supabaseAdmin');
const { getBearerToken, sendJson } = require('../lib/security');

const BUCKET = 'client-uploads';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Méthode non autorisée.' });

  const token = getBearerToken(req) || (req.query && req.query.access_token);
  if (!(await isAdminToken(token))) {
    return sendJson(res, 403, { error: 'Accès administrateur requis.' });
  }

  const requestId = req.query && req.query.request_id;
  if (!requestId || !UUID_RE.test(requestId)) {
    return sendJson(res, 400, { error: 'Identifiant de demande invalide.' });
  }

  const filesRes = await restAdmin(
    `/rest/v1/client_uploads?select=original_name,storage_path&request_id=eq.${encodeURIComponent(requestId)}&status=eq.uploaded&order=uploaded_at.asc`
  );
  if (!filesRes.ok) return sendJson(res, 502, { error: 'Erreur serveur, réessayez.' });
  const files = await filesRes.json().catch(() => []);
  if (!files.length) {
    return sendJson(res, 404, { error: 'Aucun fichier à télécharger pour cette demande.' });
  }

  res.status(200);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="photos-${requestId}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => console.warn('archiver warning:', err.message));
  archive.on('error', (err) => {
    console.warn('archiver error:', err.message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  // Évite les collisions si deux fichiers de la demande partagent le même
  // nom d'origine (le nom d'origine, jamais le nom de stockage, est ce que
  // l'administrateur voit dans le ZIP — plus lisible qu'un UUID).
  const usedNames = new Set();
  function uniqueName(name) {
    let candidate = name || 'photo';
    let i = 2;
    while (usedNames.has(candidate)) {
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
      i += 1;
    }
    usedNames.add(candidate);
    return candidate;
  }

  for (const f of files) {
    try {
      const objRes = await storageAdmin(`/storage/v1/object/${BUCKET}/${f.storage_path}`);
      if (!objRes.ok || !objRes.body) {
        console.warn('Fichier ignoré dans le ZIP (introuvable sur Storage) :', f.storage_path);
        continue;
      }
      const buf = Buffer.from(await objRes.arrayBuffer());
      archive.append(buf, { name: uniqueName(f.original_name) });
    } catch (e) {
      console.warn('Fichier ignoré dans le ZIP (erreur de récupération) :', f.storage_path, e.message);
    }
  }

  await archive.finalize();
};
