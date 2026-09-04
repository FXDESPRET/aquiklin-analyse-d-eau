// api/create-upload-url.js
// -----------------------------------------------------------------------
// Point d'entrée appelé par le navigateur (configurateur.html) quand le
// client ajoute une ou plusieurs photos. Ne reçoit JAMAIS le contenu du
// fichier lui-même — seulement son nom/type/taille déclarés — et renvoie,
// pour chaque fichier accepté, une URL d'upload SIGNÉE ET TEMPORAIRE que le
// navigateur utilisera pour envoyer le fichier DIRECTEMENT à Supabase
// Storage (jamais via ce serveur, pour ne pas faire transiter le contenu
// des photos par cette fonction). La clé service_role qui permet de générer
// cette autorisation n'est jamais renvoyée au navigateur, seulement le
// résultat (URL + jeton) déjà signé et à portée limitée.
//
// Vérifications effectuées ICI, AVANT toute autorisation d'upload (§8 —
// "refuser l'upload AVANT stockage") :
//   1. Turnstile (anti-robot)
//   2. nombre de fichiers / taille par fichier / taille totale déclarés
//   3. type MIME déclaré dans la liste autorisée
//   4. limite de fréquence par IP (anti-abus)
// La taille/le type RÉELS sont revérifiés une seconde fois après l'upload
// effectif par confirm-upload.js — on ne fait ici confiance à rien de ce
// que le navigateur déclare, uniquement à ce que Supabase Storage confirme
// avoir réellement reçu.
// -----------------------------------------------------------------------
const { restAdmin, storageAdmin, SUPABASE_URL } = require('../lib/supabaseAdmin');
const {
  MAX_FILES_PER_REQUEST, MAX_FILE_SIZE_BYTES, MAX_TOTAL_SIZE_BYTES,
  RATE_LIMIT_WINDOW_MINUTES, MAX_UPLOAD_REQUESTS_PER_WINDOW,
  extensionForMime, getClientIp, hashIp, randomStoragePath, readJsonBody,
  sendJson, verifyTurnstile
} = require('../lib/security');

const BUCKET = 'client-uploads';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée.' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Requête invalide.' }); }

  const requestId = body.request_id;
  const files = Array.isArray(body.files) ? body.files : [];
  const turnstileToken = body.turnstile_token;

  if (!requestId || !UUID_RE.test(requestId)) {
    return sendJson(res, 400, { error: 'Identifiant de demande invalide.' });
  }
  if (!files.length) {
    return sendJson(res, 400, { error: 'Aucun fichier fourni.' });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return sendJson(res, 400, { error: `Maximum ${MAX_FILES_PER_REQUEST} fichiers par demande.` });
  }

  const ip = getClientIp(req);
  const ipHash = hashIp(ip);

  // 1) Anti-robot
  const turnstileCheck = await verifyTurnstile(turnstileToken, ip);
  if (!turnstileCheck.ok) {
    return sendJson(res, 403, { error: turnstileCheck.reason || 'Vérification anti-robot échouée.' });
  }

  // 2) Limites de taille/type déclarées
  let totalSize = 0;
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || typeof f.type !== 'string' || typeof f.size !== 'number') {
      return sendJson(res, 400, { error: 'Fichier mal formé dans la requête.' });
    }
    if (!extensionForMime(f.type)) {
      return sendJson(res, 400, { error: `Type de fichier non autorisé : ${f.name}. Formats acceptés : JPG, PNG, HEIC, WEBP, PDF.` });
    }
    if (f.size <= 0 || f.size > MAX_FILE_SIZE_BYTES) {
      return sendJson(res, 400, { error: `« ${f.name} » dépasse la taille maximale de 10 Mo par fichier.` });
    }
    totalSize += f.size;
  }
  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    return sendJson(res, 400, { error: 'La taille totale des fichiers dépasse la limite de 50 Mo par demande.' });
  }

  // 3) Limite de fréquence par IP — compte les demandes d'autorisation
  // d'upload récentes (une ligne par fichier accordé) sur la fenêtre
  // glissante, AVANT d'en accorder de nouvelles.
  try {
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
    const countRes = await restAdmin(
      `/rest/v1/upload_rate_log?select=id&ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${encodeURIComponent(since)}`,
      { headers: { Prefer: 'count=exact', Range: '0-0' } }
    );
    const contentRange = countRes.headers.get('content-range'); // format "0-0/123"
    const total = contentRange ? parseInt(contentRange.split('/')[1], 10) : 0;
    if (total + files.length > MAX_UPLOAD_REQUESTS_PER_WINDOW) {
      return sendJson(res, 429, { error: 'Trop de fichiers envoyés récemment depuis cette connexion. Réessayez un peu plus tard.' });
    }
  } catch (e) {
    // En cas de panne du journal anti-abus, on choisit de continuer plutôt
    // que de bloquer un client légitime — mais on log côté serveur pour que
    // l'administrateur puisse s'en apercevoir (voir logs Vercel).
    console.warn('upload_rate_log indisponible, limite de fréquence non appliquée pour cette requête :', e.message);
  }

  // 4) Génère une URL d'upload signée par fichier + pré-enregistre la
  // métadonnée en base avec status='pending' (permet aussi de repérer et
  // nettoyer les uploads abandonnés en cours de route, voir
  // cleanup-expired-uploads.js).
  const results = [];
  for (const f of files) {
    const storagePath = randomStoragePath(requestId, f.type);
    if (!storagePath) {
      return sendJson(res, 400, { error: `Type de fichier non autorisé : ${f.name}.` });
    }
    const signRes = await storageAdmin(
      `/storage/v1/object/upload/sign/${BUCKET}/${storagePath}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    if (!signRes.ok) {
      const errBody = await signRes.json().catch(() => ({}));
      console.warn('Échec création URL signée Storage :', signRes.status, errBody);
      return sendJson(res, 502, { error: `Impossible de préparer l'envoi de « ${f.name} », réessayez.` });
    }
    const signData = await signRes.json();

    const insertRes = await restAdmin('/rest/v1/client_uploads', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        request_id: requestId,
        original_name: f.name.slice(0, 255),
        storage_path: storagePath,
        mime_type: f.type,
        size_bytes: f.size,
        status: 'pending',
        client_ip_hash: ipHash
      }])
    });
    if (!insertRes.ok) {
      const errBody = await insertRes.json().catch(() => ({}));
      console.warn('Échec insertion client_uploads :', insertRes.status, errBody);
      return sendJson(res, 502, { error: `Impossible d'enregistrer « ${f.name} », réessayez.` });
    }

    await restAdmin('/rest/v1/upload_rate_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ ip_hash: ipHash, request_id: requestId }])
    }).catch(() => {});

    results.push({
      original_name: f.name,
      storage_path: storagePath,
      // signData.url est un chemin RELATIF (ex. "/object/upload/sign/client-uploads/...?token=...") ;
      // le navigateur doit le préfixer par l'URL Supabase pour obtenir l'URL complète (voir upload_url ci-dessous).
      upload_url: `${SUPABASE_URL}/storage/v1${signData.url}`,
      token: signData.token
    });
  }

  return sendJson(res, 200, { request_id: requestId, files: results });
};
