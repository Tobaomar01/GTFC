/**
 * Synchronisation hors-ligne — /sync
 *
 * Point de contact entre l'app Android et le serveur après une journée sans
 * réseau. Trois routes seulement, mais ce sont les plus critiques du projet :
 * si elles échouent, le travail d'une journée de terrain est perdu.
 */
'use strict';

const express = require('express');
const { requete } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const { limiteSync } = require('../middleware/limites');
const { z, valider, uuid, paramsId } = require('../middleware/validation');
const { asyncHandler, ok } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');
const syncService = require('../services/sync.service');

const router = express.Router();
router.use(authentifier, exigerCommune);

// ---------------------------------------------------------------------------
// GET /sync/paquet — données à embarquer sur le téléphone
// ---------------------------------------------------------------------------
router.get('/paquet',
  valider(z.object({
    depuis: z.coerce.date().optional(),
    zone_id: uuid.optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const paquet = await syncService.paquetHorsLigne(req.contexte, {
      depuis: req.query.depuis ?? null,
      zoneId: req.query.zone_id ?? null,
    });
    return ok(res, paquet);
  }));

// ---------------------------------------------------------------------------
// POST /sync/batch — envoi d'un lot d'opérations
// ---------------------------------------------------------------------------
const schemaOperation = z.object({
  entite: z.enum(['commerce', 'visite', 'paiement', 'position', 'affichage', 'chantier']),
  operation: z.enum(['creation', 'modification', 'archivage']),
  identifiant_local: z.string().min(1).max(120),
  entite_id: uuid.optional(),
  version_client: z.coerce.number().int().optional(),
  horodatage_client: z.coerce.date(),
  donnees: z.record(z.any()),
});

const schemaLot = z.object({
  identifiant_client: z.string().min(8).max(120),
  appareil_id: z.string().max(120).optional(),
  version_app: z.string().max(30).optional(),
  hors_ligne_depuis: z.coerce.date().optional(),
  // 500 opérations : au-delà, la requête risque le délai d'expiration sur une
  // connexion 3G instable. L'app découpe en plusieurs lots, c'est plus sûr.
  operations: z.array(schemaOperation).min(1).max(500),
});

router.post('/batch', limiteSync, valider(schemaLot), asyncHandler(async (req, res) => {
  const resultat = await syncService.traiterLot(req.contexte, req.body);

  // 207 Multi-Status quand certaines opérations n'ont pas abouti : l'app
  // distingue ainsi « tout est passé » de « il reste des choses à traiter ».
  const partiel = resultat.resume
    && (resultat.resume.conflits > 0 || resultat.resume.rejetees > 0);

  return res.status(partiel ? 207 : 200).json({ succes: true, donnees: resultat });
}));

// ---------------------------------------------------------------------------
// GET /sync/lots — historique des synchronisations
// ---------------------------------------------------------------------------
router.get('/lots',
  valider(z.object({
    agent_id: uuid.optional(),
    statut: z.enum(['en_attente', 'traite', 'conflit', 'rejete']).optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    const conditions = [];
    // Un agent ne voit que ses propres lots ; un superviseur voit tout.
    if (req.utilisateur.role === 'agent') {
      params.push(req.utilisateur.id);
      conditions.push(`l.agent_id = $${params.length}`);
    } else if (req.query.agent_id) {
      params.push(req.query.agent_id);
      conditions.push(`l.agent_id = $${params.length}`);
    }
    if (req.query.statut) {
      params.push(req.query.statut);
      conditions.push(`l.statut = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await requete(req.contexte, `
      SELECT l.id, l.identifiant_client, l.appareil_id, l.version_app,
             l.nb_operations, l.nb_appliquees, l.nb_conflits, l.nb_rejetees,
             l.statut, l.hors_ligne_depuis, l.recu_le, l.traite_le, l.duree_ms,
             u.nom_complet AS agent
        FROM app.sync_lot l JOIN app.utilisateur u ON u.id = l.agent_id
        ${where}
       ORDER BY l.recu_le DESC LIMIT 100`, params);
    return ok(res, rows);
  }));

// ---------------------------------------------------------------------------
// GET /sync/conflits — à trancher par un superviseur
// ---------------------------------------------------------------------------
router.get('/conflits', exigerRole('superviseur'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT o.id, o.entite, o.operation, o.identifiant_local, o.entite_id,
           o.donnees, o.conflit_detail, o.version_client, o.version_serveur,
           o.horodatage_client, o.traite_le,
           u.nom_complet AS agent, c.code AS commerce_code, c.enseigne
      FROM app.sync_operation o
      JOIN app.sync_lot l ON l.id = o.lot_id
      JOIN app.utilisateur u ON u.id = l.agent_id
      LEFT JOIN app.commerce c ON c.id = o.entite_id
     WHERE o.statut = 'conflit' AND o.resolu_le IS NULL
     ORDER BY o.horodatage_client DESC LIMIT 200`);
  return ok(res, rows);
}));

/**
 * Résolution d'un conflit.
 *   `client`  : les données du téléphone l'emportent
 *   `serveur` : on garde la version serveur, l'opération est écartée
 * Dans les deux cas la décision et son auteur sont tracés.
 */
router.post('/conflits/:id/resoudre',
  exigerRole('superviseur'),
  valider(z.object({ id: z.coerce.number().int() }), 'params'),
  valider(z.object({
    resolution: z.enum(['client', 'serveur']),
    commentaire: z.string().max(500).optional(),
  })),
  asyncHandler(async (req, res) => {
    const { rows: op } = await requete(req.contexte,
      `SELECT * FROM app.sync_operation WHERE id = $1 AND statut = 'conflit'`, [req.params.id]);
    if (!op[0]) throw erreurs.introuvable('Conflit non résolu');

    if (req.body.resolution === 'client' && op[0].entite === 'commerce' && op[0].entite_id) {
      const d = op[0].donnees;
      const modifiables = ['enseigne', 'categorie_id', 'todp_surface_m2', 'enseigne_surface_m2',
        'surface_locale_m2', 'gerant_telephone', 'telephone_paiement', 'statut', 'point_repere'];
      const valeurs = [op[0].entite_id, req.utilisateur.id];
      const sets = [];
      for (const champ of modifiables) {
        if (d[champ] !== undefined) {
          valeurs.push(d[champ]);
          sets.push(`${champ} = $${valeurs.length}`);
        }
      }
      if (sets.length > 0) {
        await requete(req.contexte,
          `UPDATE app.commerce SET ${sets.join(', ')}, modifie_par = $2 WHERE id = $1`, valeurs);
      }
    }

    const { rows } = await requete(req.contexte, `
      UPDATE app.sync_operation
         SET statut = 'traite', resolu_par = $2, resolu_le = now(),
             resolution = $3, message = COALESCE($4, message)
       WHERE id = $1 RETURNING id, resolution, resolu_le`,
    [req.params.id, req.utilisateur.id, req.body.resolution, req.body.commentaire ?? null]);

    return ok(res, rows[0]);
  }));

// ---------------------------------------------------------------------------
// GET /sync/lots/:id — détail des opérations d'un lot
// ---------------------------------------------------------------------------
router.get('/lots/:id', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT ordre, entite, operation, identifiant_local, entite_id,
           statut, message, conflit_detail, horodatage_client, traite_le
      FROM app.sync_operation WHERE lot_id = $1 ORDER BY ordre`, [req.params.id]);
  return ok(res, rows);
}));

module.exports = router;
