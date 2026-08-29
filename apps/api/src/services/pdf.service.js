/**
 * Documents PDF : quittances et planches de stickers QR.
 *
 * Deux contraintes ont dicté les choix de ce fichier.
 *
 *   1. IMPRESSION EN MAIRIE. Les documents sortent d'une imprimante de bureau
 *      ordinaire, souvent en noir et blanc, parfois sur du papier de qualité
 *      moyenne. D'où : pas d'aplat de couleur sur toute la page, des traits
 *      épais, une police d'au moins 8 points, et des repères de découpe pour
 *      les stickers.
 *
 *   2. AUCUNE POLICE EMBARQUÉE. On s'en tient aux polices standard PDF
 *      (Helvetica), encodées en WinAnsi : les accents français passent, et le
 *      fichier reste léger — ce qui compte quand une quittance part par
 *      connexion mobile.
 */
'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const crypto = require('crypto');
const config = require('../config/env');
const { requete } = require('../config/database');
const { erreurs } = require('../utils/erreurs');
const stockage = require('./stockage.service');

const VERT = '#0B5D2B';
const GRIS = '#555555';
const GRIS_CLAIR = '#CCCCCC';

/** Rassemble le flux PDFKit en un seul Buffer. */
function versBuffer(doc) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    doc.on('data', (c) => morceaux.push(c));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);
    doc.end();
  });
}

const montantXof = (v) => `${Math.round(Number(v) || 0)
  .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;

const dateFr = (d, avecHeure = false) => {
  if (!d) return '—';
  const date = new Date(d);
  const j = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (!avecHeure) return j;
  return `${j} à ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
};

// ===========================================================================
//  QUITTANCE
// ===========================================================================

/**
 * Quittance de paiement, au format A5.
 *
 * Le QR imprimé encode l'URL de vérification publique : n'importe qui —
 * commerçant, contrôleur, agent d'une autre commune — peut s'assurer que la
 * quittance a bien été émise par la mairie et n'a pas été fabriquée.
 *
 * Le détail des taxes est reproduit ligne par ligne : c'est ce qui permet au
 * commerçant de comprendre ce qu'il paie, et à la mairie de justifier un
 * montant contesté au guichet.
 */
async function construireQuittance(donnees) {
  const {
    quittance, paiement, commerce, commune, lignes, avis,
  } = donnees;

  const doc = new PDFDocument({
    size: 'A5',
    margins: { top: 28, bottom: 28, left: 32, right: 32 },
    info: {
      Title: `Quittance ${quittance.numero}`,
      Author: commune.nom,
      Subject: 'Quittance de paiement de taxes locales',
      Creator: 'Plateforme de collecte des taxes locales',
    },
  });

  const largeur = doc.page.width - 64;
  const urlVerification = `https://${commune.slug}.${config.domaine}/q/${quittance.jeton_verification}`;
  const qr = await QRCode.toBuffer(urlVerification, {
    errorCorrectionLevel: 'M', margin: 0, width: 300,
  });

  // --- En-tête -------------------------------------------------------------
  doc.rect(32, 28, largeur, 46).fill(VERT);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
    .text(commune.nom.toUpperCase(), 40, 38, { width: largeur - 16 });
  doc.font('Helvetica').fontSize(8)
    .text('QUITTANCE DE PAIEMENT DE TAXES LOCALES', 40, 56, { width: largeur - 16 });

  doc.fillColor('#000000');
  let y = 90;

  // --- Numéro et date ------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(11).text(quittance.numero, 32, y);
  doc.font('Helvetica').fontSize(8).fillColor(GRIS)
    .text(`Émise le ${dateFr(quittance.genere_le, true)}`, 32, y + 15);
  doc.fillColor('#000000');
  y += 36;

  // --- Redevable -----------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(9).text('REDEVABLE', 32, y);
  y += 13;
  doc.font('Helvetica').fontSize(9);
  doc.text(commerce.enseigne, 32, y, { width: largeur - 110 });
  y += 12;
  doc.fontSize(8).fillColor(GRIS);
  doc.text(`Code : ${commerce.code}`, 32, y);
  y += 10;
  doc.text(`${commerce.quartier} — ${commerce.zone}`, 32, y);
  if (commerce.gerant_nom || commerce.gerant_prenom) {
    y += 10;
    doc.text(`Gérant : ${[commerce.gerant_prenom, commerce.gerant_nom].filter(Boolean).join(' ')}`, 32, y);
  }
  doc.fillColor('#000000');

  // QR en haut à droite, avec sa légende
  doc.image(qr, doc.page.width - 32 - 78, 90, { width: 78 });
  doc.fontSize(6).fillColor(GRIS)
    .text('Vérifiez cette quittance', doc.page.width - 32 - 78, 172, {
      width: 78, align: 'center',
    });
  doc.fillColor('#000000');

  y = Math.max(y + 22, 190);

  // --- Détail des taxes ----------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(9).text('DÉTAIL', 32, y);
  y += 14;

  doc.moveTo(32, y).lineTo(32 + largeur, y).lineWidth(0.8).stroke(VERT);
  y += 6;

  doc.font('Helvetica').fontSize(8);
  for (const ligne of lignes) {
    const detail = ligne.base_calcul
      ? `${ligne.base_calcul} ${ligne.unite ?? ''} × ${montantXof(ligne.montant_unitaire)}`
      : null;

    doc.fillColor('#000000').text(ligne.libelle, 32, y, { width: largeur - 90, continued: false });
    doc.font('Helvetica-Bold')
      .text(montantXof(ligne.montant), 32, y, { width: largeur, align: 'right' });
    doc.font('Helvetica');
    y += 11;

    if (detail) {
      doc.fillColor(GRIS).fontSize(7).text(detail, 40, y);
      doc.fontSize(8);
      y += 9;
    }
    if (Number(ligne.montant_exonere) > 0) {
      doc.fillColor(GRIS).fontSize(7)
        .text(`Exonération ${ligne.taux_exoneration_pct} % : −${montantXof(ligne.montant_exonere)}`, 40, y);
      doc.fontSize(8);
      y += 9;
    }
    doc.fillColor('#000000');
    y += 2;
  }

  if (Number(avis?.montant_penalite) > 0) {
    doc.fillColor('#B3261E').text('Pénalité de retard', 32, y, { width: largeur - 90 });
    doc.font('Helvetica-Bold')
      .text(montantXof(avis.montant_penalite), 32, y, { width: largeur, align: 'right' });
    doc.font('Helvetica').fillColor('#000000');
    y += 13;
  }
  if (Number(avis?.report_anterieur) > 0) {
    doc.text('Report des périodes précédentes', 32, y, { width: largeur - 90 });
    doc.font('Helvetica-Bold')
      .text(montantXof(avis.report_anterieur), 32, y, { width: largeur, align: 'right' });
    doc.font('Helvetica');
    y += 13;
  }

  y += 4;
  doc.moveTo(32, y).lineTo(32 + largeur, y).lineWidth(0.8).stroke(VERT);
  y += 8;

  // --- Montant payé --------------------------------------------------------
  doc.rect(32, y, largeur, 30).fill('#EDF1EC');
  doc.fillColor(VERT).font('Helvetica-Bold').fontSize(10)
    .text('MONTANT PAYÉ', 40, y + 10);
  doc.fontSize(14).text(montantXof(paiement.montant), 32, y + 8, {
    width: largeur - 8, align: 'right',
  });
  doc.fillColor('#000000').font('Helvetica');
  y += 40;

  // Reste dû : information capitale pour le commerçant, mise en évidence.
  if (Number(avis?.montant_restant) > 0) {
    doc.fontSize(9).fillColor('#B3261E').font('Helvetica-Bold')
      .text(`Reste dû : ${montantXof(avis.montant_restant)}`, 32, y);
    doc.font('Helvetica').fillColor('#000000');
    y += 16;
  }

  // --- Modalités -----------------------------------------------------------
  doc.fontSize(8).fillColor(GRIS);
  const moyens = {
    wave: 'Wave',
  };
  doc.text(`Moyen de paiement : ${moyens[paiement.moyen] ?? paiement.moyen}`, 32, y);
  y += 10;
  doc.text(`Référence : ${paiement.reference}`, 32, y);
  y += 10;
  doc.text(`Payé le ${dateFr(paiement.paye_le, true)}`, 32, y);
  if (avis?.periode) {
    y += 10;
    doc.text(`Période : ${avis.periode}`, 32, y);
  }
  if (paiement.encaisse_par_nom) {
    y += 10;
    doc.text(`Encaissé par : ${paiement.encaisse_par_nom}`, 32, y);
  }

  // --- Pied de page --------------------------------------------------------
  const basPage = doc.page.height - 46;
  doc.moveTo(32, basPage).lineTo(32 + largeur, basPage).lineWidth(0.4).stroke(GRIS_CLAIR);
  doc.fontSize(6.5).fillColor(GRIS)
    .text(
      'Ce document fait foi du paiement. Sa validité se vérifie en ligne en scannant le QR code '
      + `ou à l'adresse ${urlVerification}`,
      32, basPage + 6, { width: largeur, align: 'center' },
    );
  doc.text(`${commune.nom} — document généré automatiquement, sans signature manuscrite`,
    32, basPage + 22, { width: largeur, align: 'center' });

  return versBuffer(doc);
}

/**
 * Génère la quittance d'un paiement et la dépose dans MinIO.
 * Idempotent : si le PDF existe déjà, il n'est pas régénéré — une quittance
 * remise au commerçant ne doit jamais changer de contenu.
 */
async function genererQuittance(contexte, paiementId, { forcer = false } = {}) {
  const { rows } = await requete(contexte, `
    SELECT q.id, q.numero, q.jeton_verification, q.genere_le, q.bucket, q.chemin_pdf,
           p.id AS paiement_id, p.reference, p.montant, p.moyen, p.paye_le, p.annule_le,
           u.nom_complet AS encaisse_par_nom,
           c.code, c.enseigne, c.gerant_nom, c.gerant_prenom,
           qu.nom AS quartier, z.nom AS zone,
           m.nom AS commune_nom, m.slug AS commune_slug, m.code AS commune_code,
           a.id AS avis_id, a.montant_penalite, a.report_anterieur, a.montant_restant,
           pf.code AS periode
      FROM app.quittance q
      JOIN app.paiement p ON p.id = q.paiement_id
      JOIN app.commerce c ON c.id = q.commerce_id
      JOIN app.quartier qu ON qu.id = c.quartier_id
      JOIN app.zone z ON z.id = c.zone_id
      JOIN app.commune m ON m.id = q.commune_id
      LEFT JOIN app.utilisateur u ON u.id = p.encaisse_par
      LEFT JOIN app.avis_imposition a ON a.id = p.avis_id
      LEFT JOIN app.periode_fiscale pf ON pf.id = a.periode_id
     WHERE q.paiement_id = $1`, [paiementId]);

  const q = rows[0];
  if (!q) throw erreurs.introuvable('Quittance');
  if (q.annule_le) throw erreurs.conflit('Ce paiement a été annulé : aucune quittance ne peut être émise');

  if (q.chemin_pdf && !forcer) {
    return { deja: true, bucket: q.bucket, chemin: q.chemin_pdf, numero: q.numero };
  }

  const { rows: lignes } = q.avis_id
    ? await requete(contexte, `
        SELECT l.libelle, l.base_calcul, l.unite, l.montant_unitaire, l.montant,
               l.montant_exonere, l.taux_exoneration_pct
          FROM app.avis_ligne l WHERE l.avis_id = $1 ORDER BY l.ordre`, [q.avis_id])
    : { rows: [] };

  const pdf = await construireQuittance({
    quittance: q,
    paiement: q,
    commerce: q,
    commune: { nom: q.commune_nom, slug: q.commune_slug, code: q.commune_code },
    lignes: lignes.length > 0 ? lignes : [{
      libelle: 'Taxes locales', montant: q.montant, montant_exonere: 0,
    }],
    avis: q.avis_id ? q : null,
  });

  const chemin = `${q.commune_code}/quittances/${new Date().getFullYear()}/${q.numero}.pdf`;
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');

  await stockage.televerserObjet({
    bucket: config.stockage.buckets.documents,
    chemin,
    buffer: pdf,
    contentType: 'application/pdf',
  });

  await requete(contexte, `
    UPDATE app.quittance SET bucket = $2, chemin_pdf = $3, sha256 = $4 WHERE id = $1`,
  [q.id, config.stockage.buckets.documents, chemin, sha256]);

  return {
    deja: false,
    bucket: config.stockage.buckets.documents,
    chemin,
    numero: q.numero,
    taille_octets: pdf.length,
    pdf,
  };
}

// ===========================================================================
//  PLANCHE DE STICKERS
// ===========================================================================

/**
 * Planche A4 de 4 stickers A6, avec repères de découpe.
 *
 * Format retenu après avoir posé la question suivante : comment une mairie
 * imprime-t-elle 5 443 stickers ? Réponse : sur du papier autocollant A4
 * ordinaire, avec l'imprimante du service. D'où 4 A6 par A4, des traits de
 * coupe, et le numéro de planche pour ne pas se perdre au découpage.
 */
async function construirePlancheStickers(commerces, { commune, numeroPlanche, totalPlanches }) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: `Stickers QR — planche ${numeroPlanche}/${totalPlanches}`,
      Author: commune.nom,
      Creator: 'Plateforme de collecte des taxes locales',
    },
  });

  const L = doc.page.width;   // 595,28 pt
  const H = doc.page.height;  // 841,89 pt
  const demiL = L / 2;
  const demiH = H / 2;

  // Repères de découpe : les traits vont d'un bord à l'autre, ce qui permet
  // un massicot ou simplement une règle.
  doc.moveTo(demiL, 0).lineTo(demiL, H).lineWidth(0.3).dash(4, { space: 3 }).stroke(GRIS_CLAIR);
  doc.moveTo(0, demiH).lineTo(L, demiH).stroke(GRIS_CLAIR);
  doc.undash();

  const positions = [
    { x: 0, y: 0 }, { x: demiL, y: 0 },
    { x: 0, y: demiH }, { x: demiL, y: demiH },
  ];

  for (let i = 0; i < commerces.length && i < 4; i += 1) {
    const c = commerces[i];
    const { x, y } = positions[i];
    const marge = 18;
    const largeur = demiL - marge * 2;

    // Cadre du sticker
    doc.rect(x + marge, y + marge, largeur, demiH - marge * 2)
      .lineWidth(1).stroke(VERT);

    // Bandeau
    doc.rect(x + marge, y + marge, largeur, 34).fill(VERT);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5)
      .text(commune.nom.toUpperCase(), x + marge + 8, y + marge + 8,
        { width: largeur - 16, align: 'center' });
    doc.font('Helvetica').fontSize(6)
      .text('REGISTRE COMMUNAL DES COMMERCES', x + marge + 8, y + marge + 21,
        { width: largeur - 16, align: 'center' });

    // QR — correction d'erreur élevée : un sticker collé dehors s'abîme.
    const qr = await QRCode.toBuffer(c.url, {
      errorCorrectionLevel: 'H', margin: 0, width: 500,
    });
    const tailleQr = 132;
    doc.image(qr, x + demiL / 2 - tailleQr / 2, y + marge + 48, { width: tailleQr });

    // Code du commerce — c'est ce que l'agent lit à voix haute au téléphone
    doc.fillColor(VERT).font('Helvetica-Bold').fontSize(15)
      .text(c.code, x + marge, y + marge + 196, { width: largeur, align: 'center' });

    const enseigne = String(c.enseigne ?? '');
    doc.fillColor('#333333').font('Helvetica').fontSize(8)
      .text(enseigne.length > 34 ? `${enseigne.slice(0, 33)}…` : enseigne,
        x + marge + 8, y + marge + 216, { width: largeur - 16, align: 'center' });

    doc.moveTo(x + marge + 24, y + marge + 234)
      .lineTo(x + demiL - marge - 24, y + marge + 234).lineWidth(0.4).stroke(GRIS_CLAIR);

    doc.fillColor(GRIS).fontSize(6.5)
      .text('Scannez pour vérifier l\'enregistrement de ce commerce',
        x + marge + 8, y + marge + 240, { width: largeur - 16, align: 'center' });
    doc.fontSize(5.5).fillColor('#999999')
      .text('Propriété de la commune — ne pas retirer',
        x + marge + 8, y + demiH - marge - 16, { width: largeur - 16, align: 'center' });

    doc.fillColor('#000000');
  }

  // Numéro de planche, hors zone de découpe
  doc.fontSize(6).fillColor('#AAAAAA')
    .text(`Planche ${numeroPlanche}/${totalPlanches} — ${dateFr(new Date())}`,
      0, H - 10, { width: L, align: 'center' });

  return versBuffer(doc);
}

/**
 * Planches de stickers pour une liste de commerces.
 * Les QR sont générés séquentiellement : produire 500 QR en parallèle
 * saturerait le Mini PC et ralentirait l'API pour les agents sur le terrain.
 */
async function genererPlanches(contexte, { zoneId = null, quartierId = null,
  sansSticker = false, limite = 200 } = {}) {
  const conditions = ['c.archive_le IS NULL', 'q.actif'];
  const params = [];

  if (zoneId) { params.push(zoneId); conditions.push(`c.zone_id = $${params.length}`); }
  if (quartierId) { params.push(quartierId); conditions.push(`c.quartier_id = $${params.length}`); }
  if (sansSticker) conditions.push('q.imprime_le IS NULL');

  params.push(limite);

  const { rows: commerces } = await requete(contexte, `
    SELECT c.id, c.code, c.enseigne, q.jeton, q.url, q.id AS qr_id
      FROM app.commerce c
      JOIN app.qr_code q ON q.commerce_id = c.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.code
     LIMIT $${params.length}`, params);

  if (commerces.length === 0) {
    throw erreurs.introuvable('Aucun commerce à imprimer avec ces critères');
  }

  const { rows: cr } = await requete(contexte,
    'SELECT nom, code, slug FROM app.commune WHERE id = $1', [contexte.communeId]);
  const commune = cr[0];

  const totalPlanches = Math.ceil(commerces.length / 4);
  const documents = [];

  for (let i = 0; i < commerces.length; i += 4) {
    documents.push(await construirePlancheStickers(commerces.slice(i, i + 4), {
      commune,
      numeroPlanche: documents.length + 1,
      totalPlanches,
    }));
  }

  // On marque les QR comme imprimés : l'écran « stickers à poser » du
  // dashboard s'appuie dessus pour ne pas réimprimer indéfiniment les mêmes.
  await requete(contexte,
    `UPDATE app.qr_code SET imprime_le = COALESCE(imprime_le, now())
      WHERE id = ANY($1::uuid[])`, [commerces.map((c) => c.qr_id)]);

  return { documents, commerces, totalPlanches };
}

module.exports = {
  genererQuittance,
  construireQuittance,
  genererPlanches,
  construirePlancheStickers,
  montantXof,
};
