/**
 * Périodes fiscales, avis d'imposition et paiements — /avis, /periodes, /paiements
 */
'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const { limiteEcriture } = require('../middleware/limites');
const {
  z, valider, uuid, texteCourt, montantXof, telephone, pagination, paramsId, longitude, latitude,
} = require('../middleware/validation');
const { asyncHandler, ok, cree, lirePagination, pagine } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');
const wave = require('../services/wave.service');

const router = express.Router();

// Monté sur « / » : l'authentification est restreinte aux préfixes de ce
// routeur, sinon une URL inconnue répondrait 401 plutôt que 404.
router.use(['/periodes', '/avis', '/paiements'], authentifier, exigerCommune);

// ===========================================================================
//  PÉRIODES FISCALES
// ===========================================================================
router.get('/periodes', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT p.id, p.code, p.annee, p.mois, p.periodicite,
           p.date_debut, p.date_fin, p.date_exigibilite, p.date_penalite,
           p.close, p.avis_generes, p.avis_generes_le, p.nb_avis,
           v.montant_attendu, v.montant_recouvre, v.montant_restant,
           v.taux_recouvrement_pct, v.nb_payes, v.nb_partiels, v.nb_impayes
      FROM app.periode_fiscale p
      LEFT JOIN app.v_recouvrement_periode v ON v.periode_id = p.id
     ORDER BY p.date_debut DESC LIMIT 36`);
  return ok(res, rows);
}));

router.post('/periodes',
  exigerRole('admin_commune'),
  valider(z.object({
    annee: z.coerce.number().int().min(2024).max(2100),
    mois: z.coerce.number().int().min(1).max(12),
  })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT app.creer_periode_mensuelle($1, $2, $3) AS id',
      [req.utilisateur.communeId, req.body.annee, req.body.mois]);

    const { rows: periode } = await requete(req.contexte,
      'SELECT id, code, date_debut, date_fin, date_exigibilite FROM app.periode_fiscale WHERE id = $1',
      [rows[0].id]);
    return cree(res, periode[0]);
  }));

/**
 * Génération des avis d'une période.
 *
 * Opération lourde (5 443 commerces) et sensible : réservée à l'admin de la
 * commune. Idempotente — relancée, elle ne facture pas deux fois. Un commerce
 * mal configuré est journalisé et n'empêche pas les autres d'être facturés.
 */
router.post('/periodes/:id/generer',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    // Contrôles préalables : mieux vaut refuser que produire 5 443 avis faux
    const { rows: controles } = await requete(req.contexte,
      'SELECT * FROM app.verifier_coherence($1)', [req.utilisateur.communeId]);
    const bloquants = controles.filter(
      (c) => c.gravite === 'erreur' && c.controle.includes('barème'));

    if (bloquants.length > 0) {
      throw erreurs.conflit(
        'Des taxes actives n\'ont aucun barème en vigueur : la facturation produirait des erreurs.',
        bloquants);
    }

    const { rows } = await requete(req.contexte,
      'SELECT * FROM app.generer_avis_periode($1, $2)', [req.params.id, req.utilisateur.id]);

    return ok(res, {
      ...rows[0],
      avertissements: controles.filter((c) => c.gravite === 'avertissement'),
      message: rows[0].nb_erreurs > 0
        ? `${rows[0].nb_erreurs} commerce(s) en erreur — voir le journal d'audit`
        : 'Génération terminée sans erreur',
    });
  }));

/** Émission : passage de brouillon à « émis », les avis deviennent exigibles. */
router.post('/periodes/:id/emettre',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.avis_imposition
         SET statut = 'emis', date_emission = current_date
       WHERE periode_id = $1 AND statut = 'brouillon' AND montant_total > 0
       RETURNING id`, [req.params.id]);
    return ok(res, { nb_avis_emis: rows.length });
  }));

router.post('/periodes/:id/cloturer',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.periode_fiscale
         SET close = true, close_le = now(), close_par = $2
       WHERE id = $1 AND NOT close
       RETURNING id, code`, [req.params.id, req.utilisateur.id]);
    if (!rows[0]) throw erreurs.introuvable('Période ouverte');
    return ok(res, { ...rows[0], message: 'Période close : plus aucun avis ne peut y être ajouté' });
  }));

/** Application des pénalités de retard sur les avis échus. */
router.post('/periodes/penalites',
  exigerRole('admin_commune'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT app.appliquer_penalites($1) AS nb', [req.utilisateur.communeId]);
    return ok(res, { avis_penalises: rows[0].nb });
  }));

// ===========================================================================
//  AVIS D'IMPOSITION
// ===========================================================================
router.get('/avis',
  valider(pagination.extend({
    commerce_id: uuid.optional(),
    periode_id: uuid.optional(),
    statut: z.enum(['brouillon', 'emis', 'partiellement_paye', 'paye', 'annule', 'exonere']).optional(),
    echus: z.coerce.boolean().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const p = lirePagination(req.query);
    const params = [];
    const conditions = ['a.annule_le IS NULL'];

    for (const [champ, colonne] of [['commerce_id', 'a.commerce_id'], ['periode_id', 'a.periode_id'],
      ['statut', 'a.statut']]) {
      if (req.query[champ]) {
        params.push(req.query[champ]);
        conditions.push(`${colonne} = $${params.length}`);
      }
    }
    if (req.query.echus) {
      conditions.push("a.date_exigibilite < current_date AND a.statut IN ('emis','partiellement_paye')");
    }
    const where = conditions.join(' AND ');

    const { rows: total } = await requete(req.contexte,
      `SELECT count(*)::int AS n FROM app.avis_imposition a WHERE ${where}`, params);

    params.push(p.limite, p.decalage);
    const { rows } = await requete(req.contexte, `
      SELECT a.id, a.numero, a.statut, a.montant_taxes, a.montant_penalite,
             a.montant_total, a.montant_paye, a.montant_restant, a.report_anterieur,
             a.date_emission, a.date_exigibilite, a.date_paiement, a.nb_relances,
             c.id AS commerce_id, c.code AS commerce_code, c.enseigne,
             c.telephone_paiement, pf.code AS periode
        FROM app.avis_imposition a
        JOIN app.commerce c ON c.id = a.commerce_id
        JOIN app.periode_fiscale pf ON pf.id = a.periode_id
       WHERE ${where}
       ORDER BY a.date_exigibilite DESC, c.code
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    return pagine(res, rows, p, total[0].n);
  }));

router.get('/avis/:id', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT a.*, c.code AS commerce_code, c.enseigne, c.telephone_paiement,
           q.nom AS quartier, z.nom AS zone, pf.code AS periode,
           pf.date_debut AS periode_debut, pf.date_fin AS periode_fin
      FROM app.avis_imposition a
      JOIN app.commerce c ON c.id = a.commerce_id
      JOIN app.quartier q ON q.id = c.quartier_id
      JOIN app.zone z ON z.id = c.zone_id
      JOIN app.periode_fiscale pf ON pf.id = a.periode_id
     WHERE a.id = $1`, [req.params.id]);
  if (!rows[0]) throw erreurs.introuvable('Avis d\'imposition');

  const [lignes, paiements, transactions] = await Promise.all([
    requete(req.contexte, `
      SELECT l.libelle, l.mode_calcul, l.base_calcul, l.unite, l.montant_unitaire,
             l.montant_brut, l.taux_exoneration_pct, l.montant_exonere, l.montant,
             l.detail_calcul, tt.code AS taxe_code
        FROM app.avis_ligne l JOIN ref.type_taxe tt ON tt.id = l.type_taxe_id
       WHERE l.avis_id = $1 ORDER BY l.ordre`, [req.params.id]),
    requete(req.contexte, `
      SELECT p.id, p.reference, p.montant, p.moyen, p.paye_le, p.annule_le,
             u.nom_complet AS encaisse_par
        FROM app.paiement p LEFT JOIN app.utilisateur u ON u.id = p.encaisse_par
       WHERE p.avis_id = $1 ORDER BY p.paye_le DESC`, [req.params.id]),
    requete(req.contexte, `
      SELECT id, wave_session_id, checkout_url, montant, statut, initie_le,
             confirme_le, expire_le
        FROM app.transaction_wave WHERE avis_id = $1 ORDER BY initie_le DESC`, [req.params.id]),
  ]);

  return ok(res, {
    ...rows[0],
    lignes: lignes.rows,
    paiements: paiements.rows,
    transactions_wave: transactions.rows,
  });
}));

router.post('/avis/:id/annuler',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({ motif: texteCourt(500) })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.avis_imposition
         SET annule_le = now(), annule_par = $2, motif_annulation = $3, statut = 'annule'
       WHERE id = $1 AND annule_le IS NULL AND montant_paye = 0
       RETURNING id, numero, commerce_id`, [req.params.id, req.utilisateur.id, req.body.motif]);
    if (!rows[0]) {
      throw erreurs.conflit(
        'Avis introuvable, déjà annulé, ou partiellement payé — un avis payé ne s\'annule pas');
    }
    await requete(req.contexte, 'SELECT app.recalculer_statut_fiscal($1)', [rows[0].commerce_id]);
    return ok(res, rows[0]);
  }));

/** Lien de paiement Wave regroupant toutes les taxes de l'avis (phase 5). */
router.post('/avis/:id/lien-paiement',
  limiteEcriture,
  valider(paramsId, 'params'),
  valider(z.object({ telephone: telephone.optional() })),
  asyncHandler(async (req, res) => {
    const lien = await wave.creerLienPaiement(req.contexte, {
      avisId: req.params.id,
      telephone: req.body.telephone,
    });
    return cree(res, lien);
  }));

// ===========================================================================
//  PAIEMENTS
// ===========================================================================
router.get('/paiements',
  valider(pagination.extend({
    commerce_id: uuid.optional(),
    moyen: z.literal('wave').optional(),
    agent_id: uuid.optional(),
    depuis: z.coerce.date().optional(),
    jusqua: z.coerce.date().optional(),
    non_verses: z.coerce.boolean().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const p = lirePagination(req.query);
    const params = [];
    const conditions = ['p.annule_le IS NULL'];

    for (const [champ, colonne, op] of [
      ['commerce_id', 'p.commerce_id', '='],
      ['moyen', 'p.moyen', '='],
      ['agent_id', 'p.encaisse_par', '='],
      ['depuis', 'p.paye_le', '>='],
      ['jusqua', 'p.paye_le', '<='],
    ]) {
      if (req.query[champ]) {
        params.push(req.query[champ]);
        conditions.push(`${colonne} ${op} $${params.length}`);
      }
    }
    const where = conditions.join(' AND ');

    const { rows: total } = await requete(req.contexte,
      `SELECT count(*)::int AS n, COALESCE(sum(p.montant),0) AS somme
         FROM app.paiement p WHERE ${where}`, params);

    params.push(p.limite, p.decalage);
    const { rows } = await requete(req.contexte, `
      SELECT p.id, p.reference, p.montant, p.moyen, p.paye_le,
             c.code AS commerce_code, c.enseigne, a.numero AS avis_numero,
             q.numero AS quittance_numero
        FROM app.paiement p
        JOIN app.commerce c ON c.id = p.commerce_id
        LEFT JOIN app.avis_imposition a ON a.id = p.avis_id
        LEFT JOIN app.quittance q ON q.paiement_id = p.id
       WHERE ${where}
       ORDER BY p.paye_le DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    return pagine(res, rows, p, total[0].n);
  }));

/**
 * Encaissement en espèces par un agent.
 *
 * La base exige `encaisse_par` pour tout paiement en espèces : la
 * traçabilité nominative est le principal garde-fou anti-détournement.
 * La position GPS est enregistrée au passage.
 */
router.post('/paiements',
  limiteEcriture,
  valider(z.object({
    commerce_id: uuid,
    avis_id: uuid.optional(),
    montant: montantXof.refine((v) => v > 0, 'Le montant doit être supérieur à zéro'),
    moyen: z.literal('wave').default('wave'),
    reference: texteCourt(60).optional(),
    telephone_payeur: telephone.optional(),
    commentaire: z.string().max(500).optional(),
    longitude: longitude.optional(),
    latitude: latitude.optional(),
    paye_le: z.coerce.date().optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const resultat = await avecContexte(req.contexte, async (client) => {
      // Référence lisible et unique, générée côté serveur si absente
      const reference = b.reference || `${req.utilisateur.communeId.slice(0, 4).toUpperCase()}-`
        + `${Date.now().toString(36).toUpperCase()}`;

      const { rows } = await client.query(`
        INSERT INTO app.paiement (
          commune_id, commerce_id, avis_id, reference, montant, moyen,
          paye_le, geom, telephone_payeur, commentaire, cree_par
        ) VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()),
                  app.point_gps($8,$9), $10, $11, $12)
        RETURNING id, reference, montant, moyen, paye_le`,
      [req.utilisateur.communeId, b.commerce_id, b.avis_id ?? null, reference,
        b.montant, b.moyen, b.paye_le ?? null,
        b.longitude ?? null, b.latitude ?? null,
        b.telephone_payeur ?? null, b.commentaire ?? null, req.utilisateur.id]);

      // Quittance : jeton de vérification aléatoire, encodé dans le QR imprimé
      const { rows: jeton } = await client.query('SELECT app.code_aleatoire(16) AS j');
      const { rows: quittance } = await client.query(`
        INSERT INTO app.quittance (commune_id, paiement_id, commerce_id, numero, jeton_verification)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, numero, jeton_verification`,
      [req.utilisateur.communeId, rows[0].id, b.commerce_id,
        `QT-${reference}`, jeton[0].j]);

      return { paiement: rows[0], quittance: quittance[0] };
    });

    return cree(res, resultat);
  }));

/*
 * L'endpoint de versement en caisse a été retiré (FR-025b, FR-030).
 *
 * Wave est l'unique moyen de paiement du pilote : aucune somme ne transite
 * par un agent, il n'y a donc plus de caisse à rapprocher. Le dispositif
 * précédent — vue des sommes non versées, contrainte nominative — était bien
 * conçu, mais il rendait le détournement visible plutôt qu'impossible.
 */

router.post('/paiements/:id/annuler',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({ motif: texteCourt(500) })),
  asyncHandler(async (req, res) => {
    // Contre-passation, jamais de suppression : la trace comptable subsiste.
    const { rows } = await requete(req.contexte, `
      UPDATE app.paiement
         SET annule_le = now(), annule_par = $2, motif_annulation = $3
       WHERE id = $1 AND annule_le IS NULL
       RETURNING id, reference, montant, commerce_id`,
    [req.params.id, req.utilisateur.id, req.body.motif]);
    if (!rows[0]) throw erreurs.introuvable('Paiement actif');
    return ok(res, rows[0]);
  }));

module.exports = router;
