// api/notify-admin.js
// -----------------------------------------------------------------------
// Envoie l'e-mail de notification opérateur quand un dossier client est
// complété. Adapté depuis la copie de l'app Îlots flottants (même projet
// Supabase partagé) : relit ici la table "dossiers" (et non
// client_requests) et compose le message avec ses propres champs
// (nom_client, reference, ville_site, adresse_site...). NE FAIT JAMAIS
// CONFIANCE au contenu envoyé par l'appelant pour composer l'e-mail :
// reçoit uniquement un request_id, puis relit lui-même la ligne dossiers
// et les fichiers client_uploads associés directement en base (clé
// service_role) avant de composer le message.
//
// Déclenchement recommandé : un Database Webhook Supabase sur INSERT dans
// "dossiers" (voir SETUP.md) — jamais le navigateur du client, pour ne
// jamais exposer NOTIFY_SHARED_SECRET côté client.
//
// Protection anti-spam de cet endpoint : X-Notify-Secret (comparé à
// NOTIFY_SHARED_SECRET), + garde d'unicité sur dossiers.notified_at (un
// e-mail au maximum par dossier, quel que soit le nombre d'appels).
// -----------------------------------------------------------------------
const { restAdmin } = require('../lib/supabaseAdmin');
const { readJsonBody, sendJson } = require('../lib/security');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtSize(bytes) {
  if (!bytes) return '0 Mo';
  return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée.' });

  const providedSecret = req.headers['x-notify-secret'];
  const expectedSecret = process.env.NOTIFY_SHARED_SECRET;
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return sendJson(res, 403, { error: 'Non autorisé.' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Requête invalide.' }); }

  // Accepte soit { request_id: "..." } (appel direct), soit le format d'un
  // Database Webhook Supabase ({ record: { request_id: "..." } }).
  const requestId = body.request_id || (body.record && body.record.request_id);
  if (!requestId || !UUID_RE.test(requestId)) {
    return sendJson(res, 400, { error: 'request_id manquant ou invalide.' });
  }

  const dossierRes = await restAdmin(`/rest/v1/dossiers?select=*&request_id=eq.${encodeURIComponent(requestId)}`);
  if (!dossierRes.ok) return sendJson(res, 502, { error: 'Erreur serveur, réessayez.' });
  const dossiers = await dossierRes.json().catch(() => []);
  const dossier = dossiers[0];
  if (!dossier) return sendJson(res, 404, { error: 'Dossier introuvable.' });

  if (dossier.notified_at) {
    return sendJson(res, 200, { ok: true, already_sent: true });
  }

  // Réclame l'envoi de façon atomique : seule la requête qui parvient à
  // passer notified_at de NULL à une vraie date "gagne" le droit d'envoyer
  // l'e-mail — élimine les doublons en cas d'appel concurrent.
  const claimRes = await restAdmin(
    `/rest/v1/dossiers?request_id=eq.${encodeURIComponent(requestId)}&notified_at=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ notified_at: new Date().toISOString() })
    }
  );
  const claimed = claimRes.ok ? await claimRes.json().catch(() => []) : [];
  if (!claimed.length) {
    return sendJson(res, 200, { ok: true, already_sent: true });
  }

  const filesRes = await restAdmin(
    `/rest/v1/client_uploads?select=original_name,size_bytes,status&request_id=eq.${encodeURIComponent(requestId)}&status=eq.uploaded`
  );
  const files = filesRes.ok ? await filesRes.json().catch(() => []) : [];
  const totalSize = files.reduce((s, f) => s + (f.size_bytes || 0), 0);

  const siteUrl = process.env.SITE_URL || 'https://aquiklin-eau.vercel.app';
  // Pas de deep-link vers un dossier précis (l'app n'a pas encore de
  // routage par id) — ouvre directement l'accès opérateur, cohérent avec
  // le lien discret #admin déjà utilisé par l'app elle-même.
  const adminLink = `${siteUrl}/#admin`;

  const nomClient = dossier.nom_client || '(sans nom)';
  const lieu = [dossier.ville_site, dossier.pays_site].filter(Boolean).join(', ');
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#22322f;line-height:1.5;">
      <h2 style="color:#1f2937;">Nouveau dossier — Analyse d'eau</h2>
      <table cellpadding="4" style="border-collapse:collapse;">
        <tr><td><b>Référence</b></td><td>${esc(dossier.reference || '—')}</td></tr>
        <tr><td><b>Client</b></td><td>${esc(nomClient)}</td></tr>
        <tr><td><b>E-mail</b></td><td>${esc(dossier.email || '—')}</td></tr>
        <tr><td><b>Téléphone</b></td><td>${esc(dossier.telephone || '—')}</td></tr>
        <tr><td><b>Site</b></td><td>${esc(lieu || dossier.adresse_site || '—')}</td></tr>
        <tr><td><b>Fichiers reçus</b></td><td>${files.length} fichier${files.length > 1 ? 's' : ''} (${fmtSize(totalSize)} au total)</td></tr>
        ${dossier.description_libre ? `<tr><td><b>Commentaire</b></td><td>${esc(dossier.description_libre)}</td></tr>` : ''}
      </table>
      <p style="margin-top:16px;"><a href="${adminLink}" style="background:#1f6f8b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Ouvrir la console opérateur</a></p>
      ${files.length ? `<p style="font-size:12px;color:#5c6b66;">Dossier « ${esc(dossier.reference || nomClient)} » — onglet 📎 Fichiers.</p>` : ''}
      <p style="margin-top:20px;font-size:12px;color:#5c6b66;">Aucune photo/document n'est joint à cet e-mail ni accessible via une URL publique.</p>
    </div>
  `;

  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!resendKey || !from || !to) {
    console.warn('Notification e-mail non envoyée : RESEND_API_KEY/RESEND_FROM/ADMIN_NOTIFY_EMAIL manquant(s) — voir SETUP.md.');
    return sendJson(res, 200, { ok: true, email_sent: false, reason: 'Configuration e-mail incomplète côté serveur.' });
  }

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `Nouveau dossier analyse d'eau — ${nomClient}${files.length ? ` (${files.length} fichier${files.length > 1 ? 's' : ''})` : ''}`,
        html
      })
    });
    if (!emailRes.ok) {
      const errBody = await emailRes.text().catch(() => '');
      console.warn('Échec envoi e-mail Resend :', emailRes.status, errBody);
      return sendJson(res, 200, { ok: true, email_sent: false });
    }
  } catch (e) {
    console.warn('Erreur envoi e-mail Resend :', e.message);
    return sendJson(res, 200, { ok: true, email_sent: false });
  }

  return sendJson(res, 200, { ok: true, email_sent: true });
};
