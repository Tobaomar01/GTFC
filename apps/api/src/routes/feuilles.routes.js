/**
 * Feuilles de route quotidiennes — /feuilles-de-route
 *
 * Exigences FR-072 à FR-077.
 *
 * CE QUE CE MODULE NE FAIT PAS. Il ne renvoie aucune position d'agent et
 * n'expose aucun taux d'achèvement nominatif. FR-077 l'interdit, et la
 * constitution écarte le suivi de position. Une feuille dit QUELS commerces
 * voir, jamais OÙ se trouve celui qui les voit.
 */
'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const { z, valider, uuid, paramsId } = require('../middleware/validation');
const { asyncHandler, ok, cree } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');

const router = express.Router();
router.use(authentifier, exigerCommune);

/** Les lignes d'une feuille, motif compris — c'est le motif qui sert l'agent. */
const LIGNES = `
  SELECT l.id, l.ordre, l.motif, l.retiree_le IS NOT NULL AS retiree,
         l.motif_retrait, l.visite_id IS NOT NULL AS visitee,
         l.ajoutee_par IS NOT NULL AS ajoutee_a_la_main,
         c.id AS commerce_id, c.code, c.enseigne,
         c.adresse_libelle, c.point_repere,
         c.gerant_nom, c.gerant_telephone,
         q.nom AS quartier, r.nom AS rue,
         ST_Y(c.geom::geometry) AS latitude,
         ST_X(c.geom::geometry) AS longitude
    FROM app.feuille_route_ligne l
    JOIN app.commerce c ON c.id = l.commerce_id
    LEFT JOIN app.quartier q ON q.id = c.quartier_id
    LEFT JOIN app.rue r ON r.id = c.rue_id
   WHERE l.feuille_id = $1
   ORDER BY l.ordre`;

/**
 * Le libellé de chaque motif, pour que l'agent sache ce qu'il vient faire.
 * Il vit ici et non dans le téléphone : un motif ajouté demain doit parler
 * sans qu'on republie l'application.
 */
const LIBELLE_MOTIF = {
  fiche_a_completer: 'Fiche incomplète — le gérant n\'est pas joignable',
  jamais_paye: 'N\'a jamais rien réglé — expliquer le dispositif',
  paiement_interrompu: 'A réglé, puis s\'est arrêté — comprendre pourquoi',
  paiement_partiel: 'Règle une part seulement — expliquer le montant dû',
  echeance_depassee: 'Échéance dépassée — relance',
  ajout_superviseur: 'Ajouté par le superviseur',
};

const enrichir = (lignes) => lignes.map((l) => ({
  ...l, motif_libelle: LIBELLE_MOTIF[l.motif] ?? l.motif,
}));

// ---------------------------------------------------------------------------
// GET /feuilles-de-route/moi — la feuille du jour de l'agent connecté
//
// L'agent la compose implicitement s'il n'en a pas : un agent qui ouvre son
// application à six heures ne doit pas attendre que le planificateur soit
// passé pour savoir où aller.
// ---------------------------------------------------------------------------
router.get('/moi',
  valider(z.object({ date: z.coerce.date().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const jour = req.query.date ?? new Date();

    const feuille = await avecContexte(req.contexte, async (client) => {
      const { rows } = await client.query(
        'SELECT app.composer_feuille_route($1, $2::date) AS id',
        [req.utilisateur.id, jour],
      );
      return rows[0].id;
    });

    const { rows: [entete] } = await requete(req.contexte, `
        SELECT id, date_tournee, objectif, composee_le
          FROM app.feuille_route WHERE id = $1`, [feuille]);
    const { rows: lignes } = await requete(req.contexte, LIGNES, [feuille]);
    const restantes = lignes.filter((l) => !l.retiree && !l.visitee).length;

    return ok(res, {
      ...entete,
      // Un compte pour l'agent, pas une note : voir FR-077.
      nb_lignes: lignes.filter((l) => !l.retiree).length,
      nb_restantes: restantes,
      lignes: enrichir(lignes.filter((l) => !l.retiree)),
    });
  }));

// ---------------------------------------------------------------------------
// GET /feuilles-de-route — vue du superviseur
// ---------------------------------------------------------------------------
router.get('/',
  exigerRole('superviseur'),
  valider(z.object({
    agent_id: uuid.optional(),
    date: z.coerce.date().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const jour = req.query.date ?? new Date();
    const { rows: feuilles } = await requete(req.contexte, `
        SELECT f.id, f.date_tournee, f.objectif, f.composee_le,
               u.id AS agent_id, u.nom_complet AS agent,
               count(l.id) FILTER (WHERE l.retiree_le IS NULL)       AS nb_lignes,
               count(l.id) FILTER (WHERE l.visite_id IS NOT NULL)    AS nb_visitees,
               count(l.id) FILTER (WHERE l.retiree_le IS NOT NULL)   AS nb_retirees
          FROM app.feuille_route f
          JOIN app.utilisateur u ON u.id = f.agent_id
          LEFT JOIN app.feuille_route_ligne l ON l.feuille_id = f.id
         WHERE f.date_tournee = $1::date
           AND ($2::uuid IS NULL OR f.agent_id = $2)
         GROUP BY f.id, u.id
         ORDER BY u.nom_complet`, [jour, req.query.agent_id ?? null]);
    return ok(res, feuilles);
  }));

// ---------------------------------------------------------------------------
// GET /feuilles-de-route/:id — le détail, pour le superviseur
// ---------------------------------------------------------------------------
router.get('/:id',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows: [entete] } = await requete(req.contexte, `
        SELECT f.id, f.date_tournee, f.objectif, f.composee_le,
               u.nom_complet AS agent
          FROM app.feuille_route f
          JOIN app.utilisateur u ON u.id = f.agent_id
         WHERE f.id = $1`, [req.params.id]);
    if (!entete) throw erreurs.introuvable('Feuille de route');

    const { rows: lignes } = await requete(req.contexte, LIGNES, [req.params.id]);
    return ok(res, { ...entete, lignes: enrichir(lignes) });
  }));

// ---------------------------------------------------------------------------
// POST /feuilles-de-route — composer celle d'un agent (superviseur)
// ---------------------------------------------------------------------------
router.post('/',
  exigerRole('superviseur'),
  valider(z.object({
    agent_id: uuid,
    date: z.coerce.date().optional(),
  })),
  asyncHandler(async (req, res) => {
    const jour = req.body.date ?? new Date();
    const id = await avecContexte(req.contexte, async (client) => {
      const { rows } = await client.query(
        'SELECT app.composer_feuille_route($1, $2::date, $3) AS id',
        [req.body.agent_id, jour, req.utilisateur.id],
      );
      return rows[0].id;
    });
    const { rows: [entete] } = await requete(req.contexte,
      'SELECT id, date_tournee, objectif, composee_le FROM app.feuille_route WHERE id = $1', [id]);
    return cree(res, entete);
  }));

// ---------------------------------------------------------------------------
// POST /feuilles-de-route/:id/lignes — ajouter un commerce à la main
//
// FR-075. L'ajout porte le motif `ajout_superviseur` : personne ne doit croire
// plus tard qu'une règle l'a désigné.
// ---------------------------------------------------------------------------
router.post('/:id/lignes',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  valider(z.object({ commerce_id: uuid })),
  asyncHandler(async (req, res) => {
    const ligne = await avecContexte(req.contexte, async (client) => {
      const { rows: f } = await client.query(
        'SELECT id FROM app.feuille_route WHERE id = $1', [req.params.id]);
      if (!f[0]) throw erreurs.introuvable('Feuille de route');

      const { rows: c } = await client.query(
        'SELECT id FROM app.commerce WHERE id = $1 AND archive_le IS NULL',
        [req.body.commerce_id]);
      if (!c[0]) throw erreurs.introuvable('Commerce actif');

      const { rows } = await client.query(`
          INSERT INTO app.feuille_route_ligne
                 (feuille_id, commerce_id, motif, ordre, ajoutee_par)
          SELECT $1, $2, 'ajout_superviseur',
                 coalesce(max(ordre), 0) + 1, $3
            FROM app.feuille_route_ligne WHERE feuille_id = $1
          ON CONFLICT (feuille_id, commerce_id) DO NOTHING
          RETURNING id, ordre, motif`, [req.params.id, req.body.commerce_id, req.utilisateur.id]);

      if (!rows[0]) throw erreurs.conflit('Ce commerce est déjà sur la feuille');
      return rows[0];
    });
    return cree(res, ligne);
  }));

// ---------------------------------------------------------------------------
// POST /feuilles-de-route/:id/lignes/:ligneId/retirer
//
// On ne supprime pas : FR-075 exige la trace, et la contrainte
// `retrait_coherent` refuse un retrait sans qui, quand et pourquoi.
// ---------------------------------------------------------------------------
router.post('/:id/lignes/:ligneId/retirer',
  exigerRole('superviseur'),
  valider(z.object({ id: uuid, ligneId: uuid }), 'params'),
  valider(z.object({ motif: z.string().trim().min(5).max(300) })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
        UPDATE app.feuille_route_ligne
           SET retiree_le = now(), retiree_par = $3, motif_retrait = $4
         WHERE id = $1 AND feuille_id = $2 AND retiree_le IS NULL
         RETURNING id, motif_retrait, retiree_le`,
    [req.params.ligneId, req.params.id, req.utilisateur.id, req.body.motif]);
    if (!rows[0]) throw erreurs.introuvable('Ligne à retirer');
    return ok(res, rows[0]);
  }));

module.exports = router;
