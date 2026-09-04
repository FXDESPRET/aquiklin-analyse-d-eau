// lib/security.js
// -----------------------------------------------------------------------
// Petits utilitaires de sécurité partagés par les fonctions /api/*.
//
// Copie adaptée depuis l'app Îlots flottants (même principe, même projet
// Supabase partagé) : seules les limites ci-dessous diffèrent (l'app
// Analyse d'eau annonce déjà "max 20 Mo" par fichier à ses clients dans
// stepFichiers()). Le bucket Storage "client-uploads" est partagé entre
// les deux apps ; sa limite native a été remontée à 20 Mo en conséquence
// (voir sql/migration_analyse_eau_photos.sql) — cela n'assouplit pas la
// limite de 10 Mo de l'app Îlots flottants, qui reste appliquée par SA
// propre copie de ce fichier.
// -----------------------------------------------------------------------
const crypto = require('crypto');

// Limites de la mission photos — UNE SEULE source de vérité, réutilisée
// par create-upload-url.js (avant tout upload) et confirm-upload.js (après,
// sur la taille/le type RÉELS relus depuis Supabase Storage).
const ALLOWED_MIME_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
};
const MAX_FILES_PER_REQUEST = 8;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 Mo — cf. stepFichiers() déjà affiché au client
const MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024; // 50 Mo
// Fenêtre + quota de limite de fréquence (anti-abus §8) : une même IP ne
// peut pas demander plus de MAX_UPLOAD_REQUESTS_PER_WINDOW autorisations
// d'upload sur RATE_LIMIT_WINDOW_MINUTES minutes. Volontairement généreux
// pour ne jamais gêner un client normal (8 fichiers = 8 lignes de journal
// par demande), mais suffisant pour bloquer un remplissage automatisé.
const RATE_LIMIT_WINDOW_MINUTES = 60;
const MAX_UPLOAD_REQUESTS_PER_WINDOW = 40;

function extensionForMime(mimeType) {
  return ALLOWED_MIME_TYPES[mimeType] || null;
}

// IP du visiteur telle que vue par Vercel (en-tête standard des plateformes
// serverless derrière un proxy). Jamais stockée en clair (voir hashIp) —
// seule sa forme hachée sert à la limite de fréquence.
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return '0.0.0.0';
}

// Hachage à sens unique (SHA-256) — on ne conserve jamais l'IP en clair en
// base, seulement de quoi compter les tentatives récentes par visiteur.
function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'aquiklin-analyse-eau-upload';
  return crypto.createHash('sha256').update(salt + '|' + ip).digest('hex');
}

// Nom de fichier de stockage : jamais dérivé du nom fourni par le client
// (§2 de la mission) — un UUID aléatoire + l'extension déduite du type MIME
// VALIDÉ (jamais de l'extension du nom original, qui pourrait mentir).
function randomStoragePath(requestId, mimeType) {
  const ext = extensionForMime(mimeType);
  if (!ext) return null;
  const rand = crypto.randomUUID();
  return `requests/${requestId}/${rand}.${ext}`;
}

// Lit le corps JSON d'une requête Vercel Node — req.body est normalement
// déjà parsé automatiquement pour un Content-Type application/json, mais on
// se protège au cas où (corps déjà une chaîne, ou vide).
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

// Extrait le jeton Supabase Auth transmis par configurateuradmin.html dans
// l'en-tête "Authorization: Bearer <access_token>" des appels vers les
// fonctions /api/admin-*. Renvoie null si l'en-tête est absent/mal formé —
// à combiner systématiquement avec isAdminToken() (lib/supabaseAdmin.js)
// avant toute opération privilégiée, jamais utilisé seul.
function getBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Vérifie un jeton Cloudflare Turnstile auprès de l'API officielle de
// Cloudflare (siteverify) — la clé secrète ne quitte jamais ce serveur.
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Pas de clé configurée : on choisit ici d'échouer FERMÉ (refuser)
    // plutôt que de silencieusement désactiver la protection anti-bot en
    // production faute de configuration — voir SETUP.md.
    return { ok: false, reason: 'Protection anti-robot non configurée côté serveur (TURNSTILE_SECRET_KEY manquante).' };
  }
  if (!token) return { ok: false, reason: 'Vérification anti-robot manquante.' };
  try {
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', token);
    if (remoteIp) params.set('remoteip', remoteIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.success) return { ok: true };
    return { ok: false, reason: 'Vérification anti-robot échouée.' };
  } catch (e) {
    return { ok: false, reason: 'Vérification anti-robot indisponible, réessayez.' };
  }
}

module.exports = {
  ALLOWED_MIME_TYPES,
  MAX_FILES_PER_REQUEST,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_SIZE_BYTES,
  RATE_LIMIT_WINDOW_MINUTES,
  MAX_UPLOAD_REQUESTS_PER_WINDOW,
  extensionForMime,
  getBearerToken,
  getClientIp,
  hashIp,
  randomStoragePath,
  readJsonBody,
  sendJson,
  verifyTurnstile
};
