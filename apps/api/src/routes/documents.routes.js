/**
 * Quittances, stickers, campagnes et exports — /quittances, /impression,
 * /campagnes, /notifications, /exports
 *
 * Regroupe ce qui produit un document ou déclenche un envoi. Le point commun :
 * ces routes fabriquent quelque chose qui finira entre les mains d'un
 * commerçant, donc engage la commune.
 */
'use strict';

const express = require('express');
const config = require('../config/env');
const { requete } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const { z, valider, uuid, paramsId, telephone } = require('../middleware/validation');
const { asyncHandler, ok, cree } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');
const pdf = require('../services/pdf.service');
const stockage = require('../services/stockage.service');
const wave = require('../services/wave.service');
const notifications = require('../services/notification.service');
const exports_ = require('../services/export.service');

const router = express.Router();

// Monté sur « / » : l'authentification est restreinte aux préfixes de ce
// routeur, sinon une URL inconnue répondrait 401 plutôt que 404.
router.use(['/quittances', '/impression', '/campagnes', '/notifications', '/exports'],
  authentifier, exigerCommune);

// ===========================================================================
//  QUITTANCES
// ===========================================================================
router.get('/quittances',
  valider(z.object({
    commerce_id: uuid.optional(),
    depuis: z.coerce.date().optional(),
    sans_pdf: z.coerce.boolean().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    const conditions = [];
    if (req.query.commerce_id) {
      params.push(req.query.commerce_id);
      conditions.push(`q.commerce_id = $${params.length}`);
    }
    if (req.query.depuis) {
      params.push(req.query.depuis);
      conditions.push(`q.genere_le >= $${params.length}`);
    }
    if (req.query.sans_pdf) conditions.push('q.chemin_pdf IS NULL');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await requete(req.contexte, `
      SELECT q.id, q.numero, q.genere_le, q.imprime_le, q.nb_impressions,
             q.nb_verifications, (q.chemin_pdf IS NOT NULL) AS pdf_disponible,
             p.reference, p.montant, p.moyen, p.paye_le, p.annule_le,
             c.code AS commerce_code, c.enseigne
        FROM app.quittance q
        JOIN app.paiement p ON p.id = q.paiement_id
        JOIN app.commerce c ON c.id = q.commerce_id
        ${where}
       ORDER BY q.genere_le DESC LIMIT 200`, params);
    return ok(res, rows);
  }));

/**
 * Téléchargement du PDF. Généré à la volée s'il n'existe pas encore —
 * un agent au guichet ne doit pas attendre le passage du planificateur.
 */
router.get('/quittances/:id/pdf',
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT paiement_id, numero FROM app.quittance WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw erreurs.introuvable('Quittance');

    const resultat = await pdf.genererQuittance(req.contexte, rows[0].paiement_id);

    await requete(req.contexte, `
      UPDATE app.quittance
         SET imprime_le = COALESCE(imprime_le, now()), nb_impressions = nb_impressions + 1
       WHERE id = $1`, [req.params.id]);

    res.type('application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].numero}.pdf"`);

    if (resultat.pdf) return res.send(resultat.pdf);

    // Déjà en stock : on redirige vers une URL pré-signée plutôt que de faire
    // transiter le fichier par l'API.
    const url = await stockage.urlSignee(resultat.bucket, resultat.chemin);
    return res.redirect(302, url);
  }));

/** Régénération : après correction d'un barème, par exemple. */
router.post('/quittances/:id/regenerer',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT paiement_id FROM app.quittance WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw erreurs.introuvable('Quittance');

    const resultat = await pdf.genererQuittance(req.contexte, rows[0].paiement_id,
      { forcer: true });
    return ok(res, { numero: resultat.numero, taille_octets: resultat.taille_octets });
  }));

// ===========================================================================
//  IMPRESSION DES STICKERS
// ===========================================================================

/**
 * Planches A4 de 4 stickers A6.
 *
 * Renvoie un PDF par planche, concaténés dans un tableau base64 — la mairie
 * imprime planche par planche, ce qui évite de perdre 200 pages si le bac à
 * papier se vide au milieu.
 */
router.get('/impression/stickers',
  valider(z.object({
    zone_id: uuid.optional(),
    quartier_id: uuid.optional(),
    sans_sticker: z.coerce.boolean().optional(),
    limite: z.coerce.number().int().min(4).max(400).optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const { documents, commerces, totalPlanches } = await pdf.genererPlanches(req.contexte, {
      zoneId: req.query.zone_id ?? null,
      quartierId: req.query.quartier_id ?? null,
      sansSticker: req.query.sans_sticker ?? false,
      limite: req.query.limite ?? 200,
    });

    return ok(res, {
      nb_commerces: commerces.length,
      nb_planches: totalPlanches,
      commerces: commerces.map((c) => ({ code: c.code, enseigne: c.enseigne })),
      planches: documents.map((d, i) => ({
        numero: i + 1,
        taille_octets: d.length,
        pdf_base64: d.toString('base64'),
      })),
      conseil: 'Imprimez sur papier autocollant A4. Les traits pointillés indiquent '
        + 'les lignes de découpe.',
    });
  }));

/** Une seule planche, servie directement en PDF — plus simple à imprimer. */
router.get('/impression/stickers/planche',
  valider(z.object({
    zone_id: uuid.optional(),
    quartier_id: uuid.optional(),
    sans_sticker: z.coerce.boolean().optional(),
    numero: z.coerce.number().int().min(1).optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const numero = req.query.numero ?? 1;
    const { documents } = await pdf.genererPlanches(req.contexte, {
      zoneId: req.query.zone_id ?? null,
      quartierId: req.query.quartier_id ?? null,
      sansSticker: req.query.sans_sticker ?? false,
      limite: numero * 4,
    });

    const document = documents[numero - 1];
    if (!document) throw erreurs.introuvable(`Planche ${numero}`);

    res.type('application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="stickers-planche-${numero}.pdf"`);
    return res.send(document);
  }));

// ===========================================================================
//  CAMPAGNES DE PAIEMENT
// ===========================================================================

/**
 * Lance la campagne d'une période : un lien de paiement et une notification
 * par avis émis. Idempotente — relancer ne crée ni second lien ni second
 * message.
 */
router.post('/campagnes/:id/lancer',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT code, close FROM app.periode_fiscale WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw erreurs.introuvable('Période fiscale');
    if (rows[0].close) throw erreurs.conflit('Cette période est close');

    const bilan = await wave.lancerCampagne(req.contexte, { periodeId: req.params.id });

    return ok(res, {
      periode: rows[0].code,
      ...bilan,
      mode: config.wave.simuler ? 'simulation' : config.wave.environnement,
      message: config.wave.simuler
        ? 'Liens de paiement SIMULÉS — aucun appel à Wave. '
          + 'Confirmez un paiement avec : node scripts/simuler-wave.js payer <session>'
        : null,
    });
  }));

router.post('/campagnes/relancer',
  exigerRole('admin_commune'),
  valider(z.object({ jours_retard_min: z.coerce.number().int().min(0).max(365).optional() })),
  asyncHandler(async (req, res) => {
    const bilan = await wave.relancerImpayes(req.contexte, {
      joursRetardMin: req.body.jours_retard_min ?? 3,
    });
    return ok(res, bilan);
  }));

/** Lien de paiement pour un avis isolé — bouton du guichet et de l'app. */
router.post('/campagnes/lien/:avisId',
  valider(z.object({ avisId: uuid }), 'params'),
  valider(z.object({ telephone: telephone.optional() })),
  asyncHandler(async (req, res) => {
    const lien = await wave.creerLienPaiement(req.contexte, {
      avisId: req.params.avisId,
      telephone: req.body.telephone,
    });
    return cree(res, lien);
  }));

// ===========================================================================
//  NOTIFICATIONS
// ===========================================================================

/**
 * Messages à transmettre de vive voix par les agents.
 *
 * Tant qu'aucun opérateur SMS n'est raccordé, c'est LA sortie utile : le
 * superviseur imprime la liste par zone, les agents la distribuent pendant
 * leur tournée.
 */
router.get('/notifications/a-transmettre',
  valider(z.object({ zone_id: uuid.optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const messages = await notifications.messagesATransmettre(req.contexte, {
      zoneId: req.query.zone_id ?? null,
    });
    return ok(res, {
      nombre: messages.length,
      canal_actif: config.sms.actif ? config.sms.fournisseur : 'aucun (transmission par agent)',
      messages,
    });
  }));

/**
 * Vide la file d'attente maintenant.
 *
 * Le planificateur s'en charge tous les quarts d'heure, ce qui suffit au
 * rythme ordinaire. Mais celui qui vient de lancer une campagne veut voir
 * partir les messages, et savoir tout de suite si quelque chose bloque : sans
 * cette route, il attendait sans rien pouvoir observer, et un défaut de
 * passerelle ne se serait manifesté qu'un quart d'heure plus tard, dans un
 * journal.
 *
 * Idempotente : la file ne contient que ce qui n'est pas encore parti.
 */
router.post('/notifications/traiter',
  exigerRole('admin_commune'),
  valider(z.object({ limite: z.coerce.number().int().min(1).max(500).default(100) }), 'body'),
  asyncHandler(async (req, res) => {
    const bilan = await notifications.traiterFile(req.contexte, { limite: req.body.limite });
    return ok(res, bilan);
  }));

router.post('/notifications/remis',
  valider(z.object({ ids: z.array(uuid).min(1).max(500) })),
  asyncHandler(async (req, res) => {
    const nb = await notifications.marquerRemis(req.contexte, req.body.ids);
    return ok(res, { marques_remis: nb });
  }));

router.get('/notifications',
  valider(z.object({
    statut: z.enum(['en_attente', 'envoye', 'echec', 'annule']).optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    let filtre = '';
    if (req.query.statut) { params.push(req.query.statut); filtre = `WHERE n.statut = $${params.length}`; }

    const { rows } = await requete(req.contexte, `
      SELECT n.id, n.type, n.canal, n.destinataire, n.contenu, n.statut,
             n.envoye_le, n.erreur, n.nb_tentatives, n.cree_le,
             c.code AS commerce_code, c.enseigne
        FROM app.notification n
        LEFT JOIN app.commerce c ON c.id = n.commerce_id
        ${filtre}
       ORDER BY n.cree_le DESC LIMIT 300`, params);
    return ok(res, rows);
  }));

// ===========================================================================
//  EXPORTS
// ===========================================================================

/** Le nom du fichier téléchargé porte la date : indispensable quand la mairie
 *  en accumule douze dans le même dossier. */
const nomFichier = (base, extension) => {
  const d = new Date().toISOString().slice(0, 10);
  return `${base}-${d}.${extension}`;
};

/** Le contexte d'export porte le nom de la commune et de l'agent : ils
 *  figurent dans les propriétés du classeur Excel. */
async function contexteEnrichi(req) {
  const { rows } = await requete(req.contexte,
    'SELECT nom FROM app.commune WHERE id = $1', [req.utilisateur.communeId]);
  return {
    ...req.contexte,
    communeNom: rows[0]?.nom ?? '',
    utilisateurNom: req.utilisateur.nom,
  };
}

const filtresCommerces = z.object({
  zone_id: uuid.optional(),
  quartier_id: uuid.optional(),
  categorie_id: uuid.optional(),
  statut_fiscal: z.enum(['a_jour', 'partiel', 'impaye', 'exonere', 'inconnu']).optional(),
  statut: z.enum(['actif', 'ferme_temporaire', 'ferme_definitif', 'introuvable']).optional(),
});

router.get('/exports/commerces.xlsx',
  valider(filtresCommerces, 'query'),
  asyncHandler(async (req, res) => {
    const resultat = await exports_.commercesExcel(await contexteEnrichi(req), req.query);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${nomFichier('commerces', 'xlsx')}"`);
    res.setHeader('X-Nb-Lignes', String(resultat.nbLignes));
    // Le dashboard prévient l'utilisateur si l'export a été plafonné : un
    // fichier silencieusement tronqué serait pris pour la liste complète.
    if (resultat.tronque) res.setHeader('X-Tronque', 'true');
    return res.send(resultat.buffer);
  }));

/*
 * Exports de réversibilité — formats ouverts et documentés (FR-064, SC-018).
 *
 * Excel et PDF servent le travail quotidien. Ils ne servent pas la
 * réversibilité : dans un partenariat public-privé, la commune doit pouvoir
 * reprendre ses données sans l'outil qui les a produites.
 */
router.get('/exports/commerces.csv',
  valider(filtresCommerces, 'query'),
  asyncHandler(async (req, res) => {
    const r = await exports_.commercesCsv(await contexteEnrichi(req), req.query);
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${nomFichier('commerces', 'csv')}"`);
    res.setHeader('X-Nb-Lignes', String(r.nbLignes));
    return res.send(r.contenu);
  }));

router.get('/exports/activite-agents.csv',
  valider(z.object({
    depuis: z.coerce.date().optional(),
    jusqua: z.coerce.date().optional(),
    agent_id: uuid.optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const r = await exports_.activiteAgentsCsv(await contexteEnrichi(req), {
      depuis: req.query.depuis ?? new Date(Date.now() - 30 * 86400000),
      jusqua: req.query.jusqua ?? new Date(),
      agent_id: req.query.agent_id,
    });
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${nomFichier('activite-agents', 'csv')}"`);
    res.setHeader('X-Nb-Lignes', String(r.nbLignes));
    return res.send(r.contenu);
  }));

router.get('/exports/commerces.geojson',
  valider(filtresCommerces, 'query'),
  asyncHandler(async (req, res) => {
    const r = await exports_.commercesGeoJson(await contexteEnrichi(req), req.query);
    res.type('application/geo+json');
    res.setHeader('Content-Disposition',
      `attachment; filename="${nomFichier('commerces', 'geojson')}"`);
    res.setHeader('X-Nb-Lignes', String(r.nbLignes));
    // Une unité sans position est écartée, jamais placée à zéro. On le dit,
    // sans quoi l'écart entre les deux exports resterait inexpliqué.
    if (r.sansPosition > 0) res.setHeader('X-Sans-Position', String(r.sansPosition));
    return res.send(JSON.stringify(r.contenu));
  }));

router.get('/exports/commerces.pdf',
  valider(filtresCommerces, 'query'),
  asyncHandler(async (req, res) => {
    const resultat = await exports_.commercesPdf(await contexteEnrichi(req), req.query);
    res.type('application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${nomFichier('commerces', 'pdf')}"`);
    return res.send(resultat.buffer);
  }));

router.get('/exports/paiements.xlsx',
  valider(z.object({
    depuis: z.coerce.date().optional(),
    jusqua: z.coerce.date().optional(),
    moyen: z.literal('wave').optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const resultat = await exports_.paiementsExcel(await contexteEnrichi(req), req.query);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${nomFichier('paiements', 'xlsx')}"`);
    res.setHeader('X-Nb-Lignes', String(resultat.nbLignes));
    res.setHeader('X-Total-Xof', String(resultat.total));
    return res.send(resultat.buffer);
  }));

router.get('/exports/recouvrement.pdf',
  valider(z.object({ periode_id: uuid.optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const resultat = await exports_.recouvrementPdf(await contexteEnrichi(req),
      { periodeId: req.query.periode_id ?? null });
    res.type('application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${nomFichier('recouvrement', 'pdf')}"`);
    return res.send(resultat.buffer);
  }));

module.exports = router;
