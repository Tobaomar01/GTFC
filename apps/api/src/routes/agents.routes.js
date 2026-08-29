/**
 * Utilisateurs et agents de terrain — /agents
 */
'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const {
  z, valider, uuid, telephone, texteCourt, pagination, paramsId,
} = require('../middleware/validation');
const { asyncHandler, ok, cree, lirePagination, pagine } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');
const auth = require('../services/auth.service');

const router = express.Router();
router.use(authentifier, exigerCommune);

// ---------------------------------------------------------------------------
// GET /agents
// ---------------------------------------------------------------------------
router.get('/',
  valider(pagination.extend({
    role: z.enum(['agent', 'superviseur', 'admin_commune']).optional(),
    actif: z.coerce.boolean().optional(),
    zone_id: uuid.optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const p = lirePagination(req.query);
    const params = [];
    const conditions = ['u.archive_le IS NULL'];

    if (req.query.role) { params.push(req.query.role); conditions.push(`u.role = $${params.length}`); }
    if (req.query.actif !== undefined) {
      params.push(req.query.actif); conditions.push(`u.actif = $${params.length}`);
    }
    if (req.query.zone_id) {
      params.push(req.query.zone_id);
      conditions.push(`EXISTS (SELECT 1 FROM app.affectation_agent a
                                WHERE a.utilisateur_id = u.id AND a.zone_id = $${params.length}
                                  AND a.date_fin IS NULL)`);
    }
    if (req.query.q) {
      params.push(req.query.q);
      conditions.push(`(u.nom_normalise LIKE '%' || app.normaliser($${params.length}) || '%'
                        OR u.telephone LIKE '%' || $${params.length} || '%'
                        OR u.matricule ILIKE '%' || $${params.length} || '%')`);
    }
    const where = conditions.join(' AND ');

    const { rows: total } = await requete(req.contexte,
      `SELECT count(*)::int AS n FROM app.utilisateur u WHERE ${where}`, params);

    params.push(p.limite, p.decalage);
    const { rows } = await requete(req.contexte, `
      SELECT u.id, u.matricule, u.nom, u.prenom, u.nom_complet, u.telephone, u.email,
             u.role, u.actif, u.date_embauche, u.derniere_connexion, u.derniere_sync,
             u.appareil_modele, u.version_app, u.doit_changer_mdp,
             u.verrouille_jusqu_a, u.tentatives_echouees,
             COALESCE(json_agg(json_build_object('id', z.id, 'code', z.code, 'nom', z.nom))
                      FILTER (WHERE z.id IS NOT NULL), '[]') AS zones,
             (SELECT count(*) FROM app.commerce c
               WHERE c.agent_recenseur_id = u.id AND c.archive_le IS NULL)::int AS nb_recensements,
             (SELECT count(*) FROM app.visite v
               WHERE v.agent_id = u.id AND v.debute_le::date = current_date)::int AS visites_aujourdhui
        FROM app.utilisateur u
        LEFT JOIN app.affectation_agent a ON a.utilisateur_id = u.id AND a.date_fin IS NULL
        LEFT JOIN app.zone z ON z.id = a.zone_id
       WHERE ${where}
       GROUP BY u.id
       ORDER BY u.role DESC, u.nom
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    return pagine(res, rows, p, total[0].n);
  }));

// ---------------------------------------------------------------------------
// POST /agents — création d'un compte
// ---------------------------------------------------------------------------
router.post('/',
  exigerRole('admin_commune'),
  valider(z.object({
    nom: texteCourt(120),
    prenom: texteCourt(120),
    telephone,
    email: z.string().email().optional(),
    matricule: z.string().max(40).optional(),
    role: z.enum(['agent', 'superviseur', 'admin_commune']),
    date_embauche: z.coerce.date().optional(),
    zones: z.array(uuid).optional(),
    mot_de_passe_provisoire: z.string().min(10).max(200),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;

    // Un admin de commune ne crée pas de super-admin, et ne peut pas se
    // hisser lui-même : la hiérarchie est vérifiée côté serveur.
    if (b.role === 'admin_commune' && req.utilisateur.role !== 'super_admin'
        && req.utilisateur.role !== 'admin_commune') {
      throw erreurs.accesRefuse('Seul un administrateur peut créer un administrateur');
    }

    const hash = await auth.hacherMotDePasse(b.mot_de_passe_provisoire);

    const resultat = await avecContexte(req.contexte, async (client) => {
      const { rows } = await client.query(`
        INSERT INTO app.utilisateur (
          commune_id, matricule, nom, prenom, telephone, email, role,
          mot_de_passe_hash, doit_changer_mdp, actif, date_embauche, cree_par
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true,$9,$10)
        RETURNING id, matricule, nom_complet, telephone, role`,
      [req.utilisateur.communeId, b.matricule ?? null, b.nom, b.prenom, b.telephone,
        b.email ?? null, b.role, hash, b.date_embauche ?? null, req.utilisateur.id]);

      for (const zoneId of b.zones ?? []) {
        await client.query(
          `INSERT INTO app.affectation_agent (utilisateur_id, zone_id, cree_par)
           VALUES ($1, $2, $3)`, [rows[0].id, zoneId, req.utilisateur.id]);
      }
      return rows[0];
    });

    return cree(res, {
      ...resultat,
      message: 'Compte créé. L\'agent devra changer son mot de passe à la première connexion.',
    });
  }));

// ---------------------------------------------------------------------------
// PATCH /agents/:id
// ---------------------------------------------------------------------------
router.patch('/:id',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({
    nom: texteCourt(120).optional(),
    prenom: texteCourt(120).optional(),
    email: z.string().email().nullable().optional(),
    matricule: z.string().max(40).nullable().optional(),
    role: z.enum(['agent', 'superviseur', 'admin_commune']).optional(),
    actif: z.boolean().optional(),
    date_fin: z.coerce.date().nullable().optional(),
  })),
  asyncHandler(async (req, res) => {
    const champs = Object.keys(req.body);
    if (champs.length === 0) throw erreurs.requeteInvalide('Aucun champ à modifier');

    const valeurs = [req.params.id, req.utilisateur.id];
    const sets = champs.map((c) => {
      valeurs.push(req.body[c]);
      return `${c} = $${valeurs.length}`;
    });

    const { rows } = await requete(req.contexte,
      `UPDATE app.utilisateur SET ${sets.join(', ')}, modifie_par = $2
        WHERE id = $1 AND archive_le IS NULL
        RETURNING id, nom_complet, role, actif`, valeurs);
    if (!rows[0]) throw erreurs.introuvable('Agent');

    // Désactiver un compte doit couper ses sessions immédiatement, sinon son
    // jeton d'accès reste valable jusqu'à 15 minutes.
    if (req.body.actif === false) {
      await requete(req.contexte,
        `UPDATE app.session SET revoque_le = now(), motif_revocation = 'compte_desactive'
          WHERE utilisateur_id = $1 AND revoque_le IS NULL`, [req.params.id]);
    }

    return ok(res, rows[0]);
  }));

// ---------------------------------------------------------------------------
// POST /agents/:id/reinitialiser-mot-de-passe
// ---------------------------------------------------------------------------
router.post('/:id/reinitialiser-mot-de-passe',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({ mot_de_passe_provisoire: z.string().min(10).max(200) })),
  asyncHandler(async (req, res) => {
    const hash = await auth.hacherMotDePasse(req.body.mot_de_passe_provisoire);

    const { rows } = await requete(req.contexte, `
      UPDATE app.utilisateur
         SET mot_de_passe_hash = $2, doit_changer_mdp = true,
             tentatives_echouees = 0, verrouille_jusqu_a = NULL, modifie_par = $3
       WHERE id = $1 AND archive_le IS NULL
       RETURNING id, nom_complet, telephone`,
    [req.params.id, hash, req.utilisateur.id]);
    if (!rows[0]) throw erreurs.introuvable('Agent');

    await requete(req.contexte,
      `UPDATE app.session SET revoque_le = now(), motif_revocation = 'mot_de_passe_reinitialise'
        WHERE utilisateur_id = $1 AND revoque_le IS NULL`, [req.params.id]);

    return ok(res, { ...rows[0], message: 'Mot de passe réinitialisé, sessions fermées' });
  }));

/** Déverrouillage après plusieurs échecs de connexion. */
router.post('/:id/deverrouiller',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.utilisateur
         SET tentatives_echouees = 0, verrouille_jusqu_a = NULL, modifie_par = $2
       WHERE id = $1 RETURNING id, nom_complet`, [req.params.id, req.utilisateur.id]);
    if (!rows[0]) throw erreurs.introuvable('Agent');
    return ok(res, rows[0]);
  }));

// ---------------------------------------------------------------------------
// Affectations aux zones
// ---------------------------------------------------------------------------
router.post('/:id/affectations',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  valider(z.object({ zone_id: uuid, quartier_id: uuid.optional(), principal: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      INSERT INTO app.affectation_agent (utilisateur_id, zone_id, quartier_id, principal, cree_par)
      VALUES ($1, $2, $3, COALESCE($4, true), $5)
      RETURNING id, zone_id, date_debut`,
    [req.params.id, req.body.zone_id, req.body.quartier_id ?? null,
      req.body.principal ?? null, req.utilisateur.id]);
    return cree(res, rows[0]);
  }));

router.delete('/affectations/:id',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      `UPDATE app.affectation_agent SET date_fin = current_date
        WHERE id = $1 AND date_fin IS NULL RETURNING id`, [req.params.id]);
    if (!rows[0]) throw erreurs.introuvable('Affectation active');
    return ok(res, rows[0]);
  }));

// ---------------------------------------------------------------------------
// GET /agents/:id/activite — suivi d'un agent
// ---------------------------------------------------------------------------
router.get('/:id/activite',
  valider(paramsId, 'params'),
  valider(z.object({
    depuis: z.coerce.date().optional(),
    jusqua: z.coerce.date().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const depuis = req.query.depuis ?? new Date(Date.now() - 30 * 86400000);
    const jusqua = req.query.jusqua ?? new Date();

    const journees = await requete(req.contexte, `
        SELECT journee, nb_visites, nb_enregistrements, nb_mises_a_jour,
               nb_controles, nb_encaissements, nb_fermes, nb_refus,
               nb_introuvables, nb_autres_objets, nb_commerces_distincts,
               duree_moyenne_s, minutes_intervention, amplitude_h,
               nb_hors_ligne, nb_visites_eloignees,
               premiere_visite, derniere_visite
          FROM app.v_activite_agent
         WHERE agent_id = $1 AND journee BETWEEN $2::date AND $3::date
         ORDER BY journee DESC`, [req.params.id, depuis, jusqua]);

    // Le cumul sur la période, et non la somme des lignes affichées : la page
    // en montre trente au plus, le total doit porter sur tout l'intervalle.
    const totaux = await requete(req.contexte, `
        SELECT count(DISTINCT journee)::int            AS jours_actifs,
               coalesce(sum(nb_visites), 0)::int       AS visites,
               coalesce(sum(nb_enregistrements), 0)::int AS recensements,
               coalesce(sum(nb_mises_a_jour), 0)::int  AS mises_a_jour,
               coalesce(sum(nb_controles), 0)::int     AS controles,
               coalesce(sum(nb_encaissements), 0)::int AS paiements_assistes,
               coalesce(sum(nb_refus), 0)::int         AS refus,
               coalesce(sum(nb_fermes), 0)::int        AS fermes,
               coalesce(sum(nb_introuvables), 0)::int  AS introuvables,
               coalesce(sum(nb_autres_objets), 0)::int AS autres_objets,
               coalesce(sum(minutes_intervention), 0)::int AS minutes_intervention,
               coalesce(sum(nb_visites_eloignees), 0)::int AS visites_eloignees
          FROM app.v_activite_agent
         WHERE agent_id = $1 AND journee BETWEEN $2::date AND $3::date`,
    [req.params.id, depuis, jusqua]);

    // Ce que l'agent a laissé derrière lui. Ce n'est pas un reproche : la
    // boutique était ouverte et le gérant absent, il fallait bien avancer.
    // C'est la charge de son second passage.
    const reprises = await requete(req.contexte, `
        SELECT count(*)::int AS n
          FROM app.v_fiche_a_completer
         WHERE agent_recenseur_id = $1
           AND date_recensement BETWEEN $2::date AND $3::date`,
    [req.params.id, depuis, jusqua]);

    return ok(res, {
      periode: { depuis, jusqua },
      journees: journees.rows,
      total: totaux.rows[0] ?? null,
      fiches_a_reprendre: reprises.rows[0]?.n ?? 0,
    });
  }));

/*
 * Le suivi de position des agents a été retiré (FR-051a, FR-051b).
 *
 * Géolocaliser des employés en continu relève de la loi 2008-12 : cela
 * exige une justification, une proportionnalité et l'information des
 * intéressés. Le commanditaire l'a écarté. Seules subsistent les positions
 * rattachées à une fiche recensée ou à une visite.
 */

module.exports = router;
