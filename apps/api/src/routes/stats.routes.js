/**
 * Statistiques et journal d'audit — /stats, /audit
 *
 * Toutes les vues interrogées ici sont soumises au RLS : une mairie ne peut
 * pas lire les chiffres d'une autre, même en forgeant sa requête.
 */
'use strict';

const express = require('express');
const { requete } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const { z, valider, uuid, pagination } = require('../middleware/validation');
const { asyncHandler, ok, lirePagination, pagine } = require('../utils/reponse');

const router = express.Router();

// Monté sur « / » : l'authentification est restreinte aux préfixes de ce
// routeur, sinon une URL inconnue répondrait 401 plutôt que 404.
router.use(['/stats', '/audit'], authentifier, exigerCommune);

// ===========================================================================
//  STATISTIQUES
// ===========================================================================

/** Chiffres d'accueil du dashboard. */
router.get('/stats/tableau-bord', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, 'SELECT * FROM app.v_tableau_bord');
  return ok(res, rows[0] ?? null);
}));

router.get('/stats/zones', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte,
    'SELECT * FROM app.v_stats_zone ORDER BY zone_code');
  return ok(res, rows);
}));

router.get('/stats/quartiers',
  valider(z.object({ zone_id: uuid.optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    let filtre = '';
    if (req.query.zone_id) {
      params.push(req.query.zone_id);
      filtre = `WHERE quartier_id IN (SELECT id FROM app.quartier WHERE zone_id = $${params.length})`;
    }
    const { rows } = await requete(req.contexte,
      `SELECT * FROM app.v_stats_quartier ${filtre} ORDER BY zone_nom, quartier_nom`, params);
    return ok(res, rows);
  }));

router.get('/stats/recouvrement', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte,
    'SELECT * FROM app.v_recouvrement_periode ORDER BY date_debut DESC LIMIT 24');
  return ok(res, rows);
}));

router.get('/stats/taxes',
  valider(z.object({ periode: z.string().max(10).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    let filtre = '';
    if (req.query.periode) {
      params.push(req.query.periode);
      filtre = `WHERE periode = $${params.length}`;
    }
    const { rows } = await requete(req.contexte,
      `SELECT * FROM app.v_recouvrement_taxe ${filtre}`, params);
    return ok(res, rows);
  }));

router.get('/stats/agents',
  valider(z.object({
    depuis: z.coerce.date().optional(),
    jusqua: z.coerce.date().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const depuis = req.query.depuis ?? new Date(Date.now() - 7 * 86400000);
    const jusqua = req.query.jusqua ?? new Date();
    // Le relevé porte sur TOUTES les natures d'intervention. N'en compter que
    // trois donnait d'un agent occupé à des contrôles et des mises à jour
    // l'image d'un agent inactif — et un indicateur qui mesure mal finit par
    // orienter le travail vers ce qu'il mesure.
    const { rows } = await requete(req.contexte, `
      SELECT a.agent_id, a.agent,
             sum(a.nb_visites)::int          AS visites,
             sum(a.nb_enregistrements)::int  AS enregistrements,
             sum(a.nb_mises_a_jour)::int     AS mises_a_jour,
             sum(a.nb_controles)::int        AS controles,
             sum(a.nb_encaissements)::int    AS paiements_assistes,
             sum(a.nb_fermes)::int           AS fermes,
             sum(a.nb_refus)::int            AS refus,
             sum(a.nb_autres_objets)::int    AS autres_objets,
             sum(a.minutes_intervention)::int AS minutes_intervention,
             sum(a.nb_visites_eloignees)::int AS visites_eloignees,
             round(avg(a.duree_moyenne_s))::int AS duree_moyenne_s,
             count(DISTINCT a.journee)::int  AS jours_actifs,
             -- Charge du second passage : ce que l'agent n'a pas pu compléter
             -- parce que le gérant était absent.
             coalesce((SELECT count(*) FROM app.v_fiche_a_completer f
                        WHERE f.agent_recenseur_id = a.agent_id
                          AND f.date_recensement BETWEEN $1::date AND $2::date), 0)::int
                                             AS fiches_a_reprendre
        FROM app.v_activite_agent a
       WHERE a.journee BETWEEN $1::date AND $2::date
       GROUP BY a.agent_id, a.agent
       ORDER BY visites DESC`, [depuis, jusqua]);

    // Le reste à reprendre, toutes périodes confondues : c'est lui qui doit
    // être vidé avant l'émission des avis, pas seulement celui de la semaine.
    const { rows: reprises } = await requete(req.contexte, `
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE bloque_le_recouvrement)::int AS bloquantes,
             max(jours_depuis_recensement)::int AS plus_ancienne_jours
        FROM app.v_fiche_a_completer`);

    return ok(res, {
      periode: { depuis, jusqua },
      agents: rows,
      fiches_a_completer: reprises[0],
    });
  }));

/** Contrôles de cohérence métier — à consulter avant chaque facturation. */
router.get('/stats/coherence', exigerRole('superviseur'), asyncHandler(async (req, res) => {
  const [controles, provisoires] = await Promise.all([
    requete(req.contexte, 'SELECT * FROM app.verifier_coherence($1)', [req.utilisateur.communeId]),
    requete(req.contexte,
      'SELECT entite, count(*)::int AS nb FROM app.v_donnees_a_remplacer GROUP BY entite ORDER BY 2 DESC'),
  ]);
  return ok(res, {
    controles: controles.rows,
    donnees_provisoires: provisoires.rows,
    total_provisoire: provisoires.rows.reduce((s, r) => s + r.nb, 0),
  });
}));

/** Inventaire détaillé des données factices restant à remplacer. */
router.get('/stats/donnees-a-remplacer', exigerRole('admin_commune'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT entite, libelle, a_faire, montant FROM app.v_donnees_a_remplacer ORDER BY entite, libelle');
    return ok(res, rows);
  }));

// ===========================================================================
//  JOURNAL D'AUDIT
// ===========================================================================
router.get('/audit',
  exigerRole('superviseur'),
  valider(pagination.extend({
    action: z.string().max(40).optional(),
    entite: z.string().max(40).optional(),
    entite_id: uuid.optional(),
    utilisateur_id: uuid.optional(),
    depuis: z.coerce.date().optional(),
    jusqua: z.coerce.date().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const p = lirePagination(req.query, { defaut: 50, max: 200 });
    const params = [];
    const conditions = [];

    for (const [champ, colonne, op] of [
      ['action', 'action', '='],
      ['entite', 'entite', '='],
      ['entite_id', 'entite_id', '='],
      ['utilisateur_id', 'utilisateur_id', '='],
      ['depuis', 'horodatage', '>='],
      ['jusqua', 'horodatage', '<='],
    ]) {
      if (req.query[champ]) {
        params.push(req.query[champ]);
        conditions.push(`${colonne} ${op} $${params.length}${champ === 'action' ? '::audit.action_audit' : ''}`);
      }
    }

    // Sans borne temporelle, une consultation du journal balaierait toutes les
    // partitions. On limite par défaut aux 30 derniers jours.
    if (!req.query.depuis) conditions.push("horodatage > now() - interval '30 days'");

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(p.limite, p.decalage);
    const { rows } = await requete(req.contexte,
      `SELECT id, horodatage, action, entite, entite_libelle, auteur, role, ip,
              champs_modifies, montant, reference, motif, longitude, latitude
         FROM app.v_journal_audit ${where}
        ORDER BY horodatage DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    return pagine(res, rows, p, null);
  }));

/** Historique complet d'une entité — « qui a touché à cette fiche ? » */
router.get('/audit/entite/:entite/:id',
  exigerRole('superviseur'),
  valider(z.object({ entite: z.string().max(40), id: uuid }), 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      SELECT id, horodatage, action, auteur, role, ip, champs_modifies,
             valeurs_avant, valeurs_apres, motif
        FROM app.v_journal_audit
       WHERE entite = $1 AND entite_id = $2
       ORDER BY horodatage DESC LIMIT 500`, [req.params.entite, req.params.id]);
    return ok(res, rows);
  }));

/** Connexions — utile pour repérer un accès depuis un téléphone inhabituel. */
router.get('/audit/connexions',
  exigerRole('admin_commune'),
  valider(z.object({
    utilisateur_id: uuid.optional(),
    echecs_seulement: z.coerce.boolean().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    const conditions = ["horodatage > now() - interval '30 days'"];
    if (req.query.utilisateur_id) {
      params.push(req.query.utilisateur_id);
      conditions.push(`utilisateur_id = $${params.length}`);
    }
    if (req.query.echecs_seulement) conditions.push('NOT reussie');

    const { rows } = await requete(req.contexte, `
      SELECT id, horodatage, utilisateur_id, telephone_saisi, reussie, motif_echec,
             ip, appareil_modele, version_app, appareil_inhabituel
        FROM audit.connexion
       WHERE ${conditions.join(' AND ')}
       ORDER BY horodatage DESC LIMIT 300`, params);
    return ok(res, rows);
  }));

module.exports = router;
