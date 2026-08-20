/**
 * QR codes : génération, image PNG, sticker A6 imprimable.
 *
 * Le jeton encodé est aléatoire, tiré par PostgreSQL (app.generer_jeton_qr).
 * Il ne dérive PAS du code du commerce : connaître GTFC-Z1-00042 ne permet
 * donc pas de deviner le QR du voisin, ni d'en fabriquer un faux.
 *
 * L'URL encodée est une adresse web ordinaire : le sticker reste utile même
 * scanné avec l'appareil photo natif d'un téléphone, sans l'application.
 */
'use strict';

const QRCode = require('qrcode');
const config = require('../config/env');
const logger = require('../config/logger');
const { requete, avecContexte } = require('../config/database');
const { erreurs } = require('../utils/erreurs');
const stockage = require('./stockage.service');

const urlPublique = (jeton, slugCommune) => {
  const hote = config.domaine === 'localhost'
    ? `http://localhost:${config.serveur.port}`
    : `https://${slugCommune}.${config.domaine}`;
  return `${hote}/c/${jeton}`;
};

/** Correction d'erreur élevée : un sticker collé dehors s'abîme vite. */
const OPTIONS_QR = {
  errorCorrectionLevel: 'H',
  margin: 2,
  width: 512,
  color: { dark: '#000000', light: '#FFFFFF' },
};

/**
 * Crée le QR code d'un commerce et dépose son PNG dans MinIO.
 * Si un QR actif existe déjà, il est désactivé et chaîné au nouveau : un
 * ancien sticker scanné sera reconnu comme périmé, pas comme inconnu.
 *
 * @param client  Client PostgreSQL DÉJÀ dans une transaction. Indispensable
 *                pour la voie « synchronisation hors-ligne » : le commerce
 *                vient d'être inséré et n'est pas encore validé, une seconde
 *                connexion ne le verrait donc pas.
 */
async function genererAvecClient(client, { commerceId, motifRemplacement = null,
  utilisateurId = null }) {
  const { rows: cr } = await client.query(
    `SELECT c.id, c.code, c.commune_id, m.slug AS commune_slug, m.code AS commune_code
       FROM app.commerce c JOIN app.commune m ON m.id = c.commune_id
      WHERE c.id = $1 AND c.archive_le IS NULL`, [commerceId]);
  const commerce = cr[0];
  if (!commerce) throw erreurs.introuvable('Commerce');

  const { rows: ar } = await client.query(
    'SELECT id, version FROM app.qr_code WHERE commerce_id = $1 AND actif', [commerceId]);
  const ancien = ar[0];

  const { rows: jr } = await client.query('SELECT app.generer_jeton_qr() AS jeton');
  const jeton = jr[0].jeton;
  const url = urlPublique(jeton, commerce.commune_slug);

  // L'image PNG est un confort : ce qui compte, c'est le JETON en base, seul
  // élément indispensable au scan et à l'impression du sticker (rendu en SVG).
  // Si MinIO est momentanément indisponible, on crée quand même le QR code —
  // un agent sur le terrain ne doit pas rester bloqué pour une image.
  const chemin = `${commerce.commune_code}/qr/${commerce.code}-v${(ancien?.version ?? 0) + 1}.png`;
  let cheminStocke = null;
  try {
    const png = await QRCode.toBuffer(url, { ...OPTIONS_QR, type: 'png' });
    await stockage.televerserObjet({
      bucket: config.stockage.buckets.qrcodes,
      chemin,
      buffer: png,
      contentType: 'image/png',
    });
    cheminStocke = chemin;
  } catch (err) {
    logger.warn({ err: err.message, commerce: commerce.code },
      'Image PNG du QR non stockée (MinIO indisponible) — le QR code reste valide');
  }

  // Désactivation de l'ancien et création du nouveau dans la même
  // transaction : à aucun moment un commerce ne se retrouve sans QR actif,
  // ni avec deux (index unique partiel côté base).
  const { rows } = await client.query(`
    WITH desactive AS (
      UPDATE app.qr_code
         SET actif = false, desactive_le = now(),
             motif_desactivation = COALESCE($5, 'remplacement')
       WHERE commerce_id = $1 AND actif
      RETURNING id
    )
    INSERT INTO app.qr_code (commune_id, commerce_id, jeton, url, version,
                             bucket, chemin_png, genere_par)
    VALUES ($2, $1, $3, $4, $6, $7, $8, $9)
    RETURNING id, jeton, url, version, genere_le`,
  [
    commerceId, commerce.commune_id, jeton, url, motifRemplacement,
    (ancien?.version ?? 0) + 1,
    cheminStocke ? config.stockage.buckets.qrcodes : null, cheminStocke,
    utilisateurId,
  ]);

  if (ancien) {
    await client.query(
      'UPDATE app.qr_code SET remplace_par_id = $2 WHERE id = $1', [ancien.id, rows[0].id]);
  }

  return { ...rows[0], commerce_code: commerce.code, chemin_png: cheminStocke };
}

/** Variante autonome : ouvre sa propre transaction. Utilisée par les routes. */
function genererPourCommerce(contexte, { commerceId, motifRemplacement = null }) {
  return avecContexte(contexte, (client) => genererAvecClient(client, {
    commerceId,
    motifRemplacement,
    utilisateurId: contexte.utilisateurId ?? null,
  }));
}

/**
 * Sticker A6 (105 × 148 mm) prêt à imprimer, en SVG.
 *
 * Le SVG plutôt qu'une image matricielle : il s'imprime net à n'importe
 * quelle résolution, pèse quelques kilo-octets, et une imprimante de mairie
 * le rend aussi bien qu'un studio.
 */
function stickerA6({ qrSvg, codeCommerce, enseigne, nomCommune, url }) {
  const echapper = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Le nom du commerce est tronqué : au-delà, il déborderait du cadre.
  const enseigneAffichee = String(enseigne ?? '').length > 28
    ? `${String(enseigne).slice(0, 27)}…`
    : enseigne;

  // QR extrait du SVG généré par la bibliothèque, réinséré à l'échelle voulue
  const contenuQr = qrSvg.replace(/<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>|<\/svg>/g, '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="105mm" height="148mm"
     viewBox="0 0 105 148" font-family="Helvetica, Arial, sans-serif">
  <rect width="105" height="148" fill="#FFFFFF"/>
  <rect x="3" y="3" width="99" height="142" fill="none" stroke="#0B5D2B" stroke-width="1.2"/>

  <rect x="3" y="3" width="99" height="22" fill="#0B5D2B"/>
  <text x="52.5" y="12" text-anchor="middle" fill="#FFFFFF" font-size="4.2" font-weight="bold">
    ${echapper(nomCommune)}
  </text>
  <text x="52.5" y="18.5" text-anchor="middle" fill="#FFFFFF" font-size="3.2">
    REGISTRE COMMUNAL DES COMMERCES
  </text>

  <g transform="translate(20.5, 32) scale(0.0615)">
    ${contenuQr}
  </g>

  <text x="52.5" y="102" text-anchor="middle" font-size="7.5" font-weight="bold" fill="#0B5D2B">
    ${echapper(codeCommerce)}
  </text>
  <text x="52.5" y="110" text-anchor="middle" font-size="4" fill="#333333">
    ${echapper(enseigneAffichee)}
  </text>

  <line x1="12" y1="116" x2="93" y2="116" stroke="#CCCCCC" stroke-width="0.4"/>

  <text x="52.5" y="123" text-anchor="middle" font-size="3.4" fill="#555555">
    Scannez pour vérifier l'enregistrement
  </text>
  <text x="52.5" y="128.5" text-anchor="middle" font-size="3" fill="#777777">
    ${echapper(url)}
  </text>
  <text x="52.5" y="138" text-anchor="middle" font-size="2.8" fill="#999999">
    Ce sticker est la propriété de la commune — ne pas retirer
  </text>
</svg>`;
}

async function genererStickerA6(contexte, commerceId) {
  const { rows } = await requete(contexte, `
    SELECT q.jeton, q.url, c.code, c.enseigne, m.nom AS commune_nom
      FROM app.qr_code q
      JOIN app.commerce c ON c.id = q.commerce_id
      JOIN app.commune  m ON m.id = q.commune_id
     WHERE q.commerce_id = $1 AND q.actif`, [commerceId]);

  const qr = rows[0];
  if (!qr) throw erreurs.introuvable('QR code actif pour ce commerce');

  const qrSvg = await QRCode.toString(qr.url, { ...OPTIONS_QR, type: 'svg', width: 1000 });

  return {
    svg: stickerA6({
      qrSvg,
      codeCommerce: qr.code,
      enseigne: qr.enseigne,
      nomCommune: qr.commune_nom,
      url: qr.url,
    }),
    nomFichier: `sticker-${qr.code}.svg`,
  };
}

/** Planche de stickers pour une impression en lot (par zone ou quartier). */
async function genererPlanche(contexte, commerceIds) {
  const stickers = [];
  for (const id of commerceIds) {
    // Séquentiel volontairement : générer 500 QR en parallèle saturerait
    // le CPU du Mini PC et ralentirait l'API pour les agents sur le terrain.
    stickers.push(await genererStickerA6(contexte, id));
  }
  return stickers;
}

module.exports = { genererPourCommerce, genererAvecClient, genererStickerA6, genererPlanche, urlPublique };
