// api/cleanup-expired-uploads.js
// -----------------------------------------------------------------------
// Tâche planifiée (Cron Job Vercel, voir vercel.json) qui applique la
// politique de rétention du §7 de la mission :
//   1. Supprime (Storage + ligne client_uploads) tout fichier "uploaded"
//      dont expires_at est dépassé ET qui n'a PAS été marqué "Conserver"
//      (keep=false) par l'administrateur.
//   2. Nettoie aussi les uploads "abandonnés" : des lignes 'pending'
//      (URL signée générée mais jamais réellement envoyée, ou envoi
//      interrompu avant confirm-upload.js) vieilles de plus de 24h — elles
//      n'ont jamais été comptées dans un e-mail de notification et ne
//      servent plus à rien.
//
// Protégé par le mécanisme standard des Vercel Cron Jobs : Vercel ajoute
// automatiquement l'en-tête "Authorization: Bearer $CRON_SECRET" à ses
// propres appels planifiés quand la variable d'environnement CRON_SECRET
// est définie — on revérifie ici cette valeur pour empêcher quiconque
// d'autre de déclencher des suppressions en masse en devinant l'URL.
// -----------------------------------------------------------------------
const { restAdmin, storageAdmin } = require('../lib/supabaseAdmin');
const { sendJson } = require('../lib/security');

const BUCKET = 'client-uploads';
const PENDING_MAX_AGE_HOURS = 24;
const BATCH_LIMIT = 500; // large marge par rapport au volume réel attendu
const STORAGE_DELETE_CHUNK = 100; // l'API Storage accepte un tableau de préfixes par appel

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function deleteRows(rows, label) {
  const paths = rows.map(r => r.storage_path).filter(Boolean);
  for (const group of chunk(paths, STORAGE_DELETE_CHUNK)) {
    const delRes = await storageAdmin(`/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: group })
    });
    if (!delRes.ok) {
      const errBody = await delRes.json().catch(() => ({}));
      console.warn(`Échec suppression Storage (${label}) :`, delRes.status, errBody);
      // On continue quand même vers la suppression des lignes en base pour
      // ce lot : un objet Storage orphelin sans ligne associée est sans
      // conséquence (jamais accessible sans ligne + URL signée), alors
      // qu'une ligne orpheline pointant vers un objet déjà supprimé casse
      // l'affichage admin. On log pour investigation manuelle si besoin.
    }
  }
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  for (const group of chunk(ids, STORAGE_DELETE_CHUNK)) {
    const delDbRes = await restAdmin(`/rest/v1/client_uploads?id=in.(${group.join(',')})`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    if (!delDbRes.ok) {
      console.warn(`Échec suppression lignes client_uploads (${label}) :`, group);
    }
  }
}

module.exports = async (req, res) => {
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return sendJson(res, 403, { error: 'Non autorisé.' });
  }

  const nowIso = new Date().toISOString();
  const pendingCutoffIso = new Date(Date.now() - PENDING_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  // 1) Fichiers expirés et non conservés
  const expiredRes = await restAdmin(
    `/rest/v1/client_uploads?select=id,storage_path&status=eq.uploaded&keep=eq.false&expires_at=lt.${encodeURIComponent(nowIso)}&limit=${BATCH_LIMIT}`
  );
  const expiredRows = expiredRes.ok ? await expiredRes.json().catch(() => []) : [];
  if (!expiredRes.ok) console.warn('Échec lecture des fichiers expirés.');
  await deleteRows(expiredRows, 'expirés');

  // 2) Uploads abandonnés (jamais confirmés)
  const abandonedRes = await restAdmin(
    `/rest/v1/client_uploads?select=id,storage_path&status=eq.pending&created_at=lt.${encodeURIComponent(pendingCutoffIso)}&limit=${BATCH_LIMIT}`
  );
  const abandonedRows = abandonedRes.ok ? await abandonedRes.json().catch(() => []) : [];
  if (!abandonedRes.ok) console.warn('Échec lecture des uploads abandonnés.');
  await deleteRows(abandonedRows, 'abandonnés');

  return sendJson(res, 200, {
    ok: true,
    expired_deleted: expiredRows.length,
    abandoned_deleted: abandonedRows.length
  });
};
