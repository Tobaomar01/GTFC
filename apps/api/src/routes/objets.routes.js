/**
 * Objets taxables autres que le commerce — /affichages, /chantiers
 *
 * DISPOSITIFS D'AFFICHAGE
 * Le recensement se fait par balayage systématique, RUE PAR RUE, et non
 * redevable par redevable. Chaque support porte donc sa propre rue et ses
 * propres coordonnées : un panneau de régie n'a aucun commerce derrière lui.
 * Une ligne par support, chacune avec sa surface — c'est la seule façon de
 * calculer une taxe au m² et par dispositif.
 *
 * CHANTIERS
 * Recensés, jamais facturés pendant le pilote. Tous les champs de calcul sont
 * pourtant collectés : le jour où la commune délibère un tarif, les chantiers
 * de cette année seront refermés depuis longtemps et un repassage terrain
 * serait impossible.
 */

'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerRole, exigerCommune } = require('../middleware/auth');
const {
  z, valider, uuid, position, surface, texteCourt, pagination, paramsId,
} = require('../middleware/validation');
const {
  asyncHandler, ok, cree, lirePagination, pagine,
} = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');

const router = express.Router();
router.use(['/affichages', '/chantiers', '/objets-sans-redevable'],
  authentifier, exigerCommune);

const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

// ===========================================================================
//  DISPOSITIFS D'AFFICHAGE
// ===========================================================================

const corpsAffichage = z.object({
  type_affichage_id: uuid,
  redevable_id: uuid.optional(),
  commerce_id: uuid.optional(),
  rue_id: uuid.optional(),
  quartier_id: uuid.optional(),
  zone_id: uuid.optional(),
  adresse_libelle: texteCourt(250).optional(),
  ...position.partial().shape,
  surface_m2: surface.refine((v) => v > 0, 'La surface doit être supérieure à zéro'),
  largeur_m: z.coerce.number().min(0).max(100).optional(),
  hauteur_m: z.coerce.number().min(0).max(100).optional(),
  nb_faces: z.coerce.number().int().min(1).max(4).default(1),
  lumineux: z.coerce.boolean().default(false),
  texte_affiche: texteCourt(250).optional(),
  date_apposition: dateIso.optional(),
  numero_autorisation: texteCourt(60).optional(),
  notes: z.string().trim().max(2000).optional(),
});

// Ni redevable ni commerce est un cas LÉGITIME : c'est celui du panneau
// publicitaire relevé dans la rue, dont l'exploitant se lit dans un contrat
// détenu par la mairie, pas sur le support. L'objet est enregistré et rejoint
// app.v_objets_sans_redevable, d'où il sera rattaché.

router.get('/affichages', valider(pagination.extend({
  redevable_id: uuid.optional(),
  commerce_id: uuid.optional(),
  rue_id: uuid.optional(),
  type_affichage_id: uuid.optional(),
  sans_commerce: z.enum(['oui']).optional(),
  sans_redevable: z.enum(['oui']).optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const { limite, decalage, page } = lirePagination(req.query);
  const filtres = ['d.archive_le IS NULL'];
  const params = [];

  for (const champ of ['redevable_id', 'commerce_id', 'rue_id', 'type_affichage_id']) {
    if (req.query[champ]) {
      params.push(req.query[champ]);
      filtres.push(`d.${champ} = $${params.length}`);
    }
  }
  // Les panneaux de régie : ceux qu'aucune tournée « commerces » ne montre.
  if (req.query.sans_commerce === 'oui') filtres.push('d.commerce_id IS NULL');
  // La file de travail du service des finances.
  if (req.query.sans_redevable === 'oui') filtres.push('d.redevable_id IS NULL');
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    filtres.push(`(d.code ILIKE $${params.length} OR d.texte_affiche ILIKE $${params.length})`);
  }

  params.push(limite, decalage);
  const { rows } = await requete(req.contexte, `
    SELECT d.id, d.code, d.surface_m2, d.nb_faces, d.lumineux, d.texte_affiche,
           d.date_apposition, d.date_constat, d.actif,
           ta.code AS type_code, ta.libelle AS type_libelle,
           r.id AS redevable_id, r.code AS redevable_code, r.designation AS redevable,
           c.code AS commerce_code, c.enseigne,
           ru.nom AS rue, q.nom AS quartier,
           ST_X(d.geom) AS longitude, ST_Y(d.geom) AS latitude,
           count(*) OVER () AS total_general
      FROM app.dispositif_affichage d
      JOIN ref.type_affichage ta ON ta.id = d.type_affichage_id
      -- Jointure EXTERNE : un panneau de régie relevé lors d'un balayage de
      -- rue n'a pas encore de redevable. Une jointure interne le ferait
      -- disparaître de la liste — recensé, invisible, jamais facturé.
      LEFT JOIN app.redevable r  ON r.id = d.redevable_id
      LEFT JOIN app.commerce c   ON c.id = d.commerce_id
      LEFT JOIN app.rue ru       ON ru.id = d.rue_id
      LEFT JOIN app.quartier q   ON q.id = d.quartier_id
     WHERE ${filtres.join(' AND ')}
     ORDER BY d.code
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const total = rows[0] ? Number(rows[0].total_general) : 0;
  return pagine(res, rows.map(({ total_general, ...r }) => r), { page, limite }, total);
}));

router.post('/affichages', exigerRole('agent'), valider(corpsAffichage),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const resultat = await avecContexte(req.contexte, async (client) => {
      const { rows: [type] } = await client.query(
        'SELECT code, libelle, recensable, motif_non_recensable FROM ref.type_affichage WHERE id = $1',
        [b.type_affichage_id]);
      if (!type) throw erreurs.introuvable('Type de dispositif');

      // AFF-06 : les plaques professionnelles réglementées ne sont pas
      // saisies par les agents tant que leur assujettissement n'est pas
      // tranché avec la municipalité.
      if (!type.recensable) {
        throw erreurs.requeteInvalide(
          `« ${type.libelle} » n'est pas recensable. ${type.motif_non_recensable ?? ''}`.trim(),
        );
      }

      const { rows: [g] } = await client.query(
        "SELECT * FROM app.generer_code_objet($1, 'A')", [req.utilisateur.communeId]);

      const geom = (b.longitude !== undefined && b.latitude !== undefined)
        ? `ST_SetSRID(ST_MakePoint(${b.longitude}, ${b.latitude}), 4326)` : 'NULL';

      const { rows: [d] } = await client.query(`
        INSERT INTO app.dispositif_affichage (
          commune_id, redevable_id, commerce_id, type_affichage_id, code, numero_sequence,
          rue_id, quartier_id, zone_id, adresse_libelle, geom, precision_gps_m,
          surface_m2, largeur_m, hauteur_m, nb_faces, lumineux, texte_affiche,
          date_apposition, numero_autorisation, notes, agent_recenseur_id, cree_par)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${geom},$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
        RETURNING *`,
      [req.utilisateur.communeId, b.redevable_id ?? null, b.commerce_id ?? null,
        b.type_affichage_id, g.code, g.numero_sequence,
        b.rue_id ?? null, b.quartier_id ?? null, b.zone_id ?? null,
        b.adresse_libelle ?? null, b.precision_gps_m ?? null,
        b.surface_m2, b.largeur_m ?? null, b.hauteur_m ?? null,
        b.nb_faces, b.lumineux, b.texte_affiche ?? null,
        b.date_apposition ?? null, b.numero_autorisation ?? null,
        b.notes ?? null, req.utilisateur.id]);

      return d;
    });

    return cree(res, resultat);
  }));

/**
 * Dépose d'un dispositif.
 * On ne supprime pas : la taxe reste due pour la période pendant laquelle le
 * support était en place, et la quittance correspondante doit rester
 * explicable.
 */
router.post('/affichages/:id/deposer', exigerRole('agent'), valider(paramsId, 'params'),
  valider(z.object({ date_depose: dateIso, motif: texteCourt(200).optional() }), 'body'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.dispositif_affichage
         -- Le paramètre est transtypé : « concat_ws » accepte n'importe quel
         -- type, donc PostgreSQL ne déduit rien du contexte et refuse la
         -- requête. Le dépôt d'un dispositif échouait à chaque appel.
         SET date_depose = $2, actif = false, notes = concat_ws(E'\\n', notes, $3::text),
             modifie_le = now(), modifie_par = $4, version = version + 1
       WHERE id = $1 AND archive_le IS NULL
       RETURNING id, code, date_depose, actif`,
    [req.params.id, req.body.date_depose,
      req.body.motif ? `Déposé : ${req.body.motif}` : null, req.utilisateur.id]);

    if (!rows[0]) throw erreurs.introuvable('Dispositif');
    return ok(res, rows[0]);
  }));

/**
 * Rattachement d'un objet orphelin à son redevable.
 *
 * C'est le geste que fait le service des finances après avoir retrouvé, dans
 * un contrat ou une déclaration, l'exploitant d'un panneau relevé sur le
 * terrain. Tant qu'il n'est pas fait, l'objet existe mais n'est pas facturé.
 */
router.post('/affichages/:id/redevable', exigerRole('superviseur'),
  valider(paramsId, 'params'),
  valider(z.object({ redevable_id: uuid }), 'body'), asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.dispositif_affichage
         SET redevable_id = $2, modifie_le = now(), modifie_par = $3, version = version + 1
       WHERE id = $1 AND archive_le IS NULL
       RETURNING id, code, redevable_id`,
    [req.params.id, req.body.redevable_id, req.utilisateur.id]);

    if (!rows[0]) throw erreurs.introuvable('Dispositif');
    return ok(res, {
      ...rows[0],
      note: 'Le dispositif entre dans la facturation à la prochaine génération mensuelle.',
    });
  }));

router.post('/chantiers/:id/redevable', exigerRole('superviseur'),
  valider(paramsId, 'params'),
  valider(z.object({ redevable_id: uuid }), 'body'), asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.chantier
         SET redevable_id = $2, modifie_le = now(), modifie_par = $3, version = version + 1
       WHERE id = $1 AND archive_le IS NULL
       RETURNING id, code, redevable_id`,
    [req.params.id, req.body.redevable_id, req.utilisateur.id]);

    if (!rows[0]) throw erreurs.introuvable('Chantier');
    return ok(res, rows[0]);
  }));

/** Objets recensés dont le propriétaire reste à établir. */
router.get('/objets-sans-redevable', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte,
    'SELECT * FROM app.v_objets_sans_redevable ORDER BY date_constat DESC, code LIMIT 500');
  return ok(res, rows);
}));

/** Simulation du montant, sans rien écrire. Sert au guichet et au terrain. */
router.get('/affichages/:id/montant', valider(paramsId, 'params'),
  valider(z.object({ date: dateIso.optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT * FROM app.calculer_taxe_affichage($1, $2::date)',
      [req.params.id, req.query.date ?? new Date().toISOString().slice(0, 10)]);
    if (!rows[0]) {
      return ok(res, { montant: 0, motif: 'Aucune taxe due à cette date (dispositif déposé ou pas encore apposé)' });
    }
    return ok(res, rows[0]);
  }));

// ===========================================================================
//  CHANTIERS
// ===========================================================================

const corpsChantier = z.object({
  // Facultatif : le permis de construire n''est pas toujours affiche sur la
  // palissade. Un chantier sans promoteur identifie est recense quand meme,
  // et rattache depuis le tableau de bord. Voir migration 0034.
  redevable_id: uuid.optional(),
  libelle: texteCourt(200).optional(),
  types: z.array(uuid).min(1, 'Indiquez au moins une forme d\'occupation'),
  rue_id: uuid.optional(),
  quartier_id: uuid.optional(),
  zone_id: uuid.optional(),
  adresse_libelle: texteCourt(250).optional(),
  ...position.partial().shape,
  surface_m2: surface.refine((v) => v > 0, 'La surface doit être supérieure à zéro'),
  duree_prevue_jours: z.coerce.number().int().min(1).max(3650).optional(),
  date_fin_prevue: dateIso.optional(),
  numero_autorisation: texteCourt(60).optional(),
  autorisation_vue: z.coerce.boolean().default(false),
  notes: z.string().trim().max(2000).optional(),
});

router.get('/chantiers', valider(pagination.extend({
  statut: z.enum(['en_cours', 'prolonge', 'termine', 'introuvable']).optional(),
  a_revoir: z.enum(['oui']).optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const { limite, decalage, page } = lirePagination(req.query);
  const filtres = ['ch.archive_le IS NULL'];
  const params = [];

  if (req.query.statut) {
    params.push(req.query.statut);
    filtres.push(`ch.statut = $${params.length}::app.statut_chantier`);
  }
  // Le terme est dépassé et personne n'est allé constater la fin : c'est
  // exactement la liste de repassage de l'agent.
  if (req.query.a_revoir === 'oui') {
    filtres.push(`ch.statut IN ('en_cours','prolonge')
                  AND ch.date_fin_prevue IS NOT NULL AND ch.date_fin_prevue < current_date`);
  }

  params.push(limite, decalage);
  const { rows } = await requete(req.contexte, `
    SELECT ch.id, ch.code, ch.libelle, ch.surface_m2, ch.statut, ch.facturable,
           ch.date_constat, ch.date_fin_prevue, ch.date_fin_constatee,
           ch.numero_autorisation, ch.autorisation_vue,
           r.code AS redevable_code, r.designation AS redevable,
           ru.nom AS rue, q.nom AS quartier,
           ST_X(ch.geom) AS longitude, ST_Y(ch.geom) AS latitude,
           (SELECT array_agg(t.libelle ORDER BY t.ordre_affichage)
              FROM app.chantier_occupation o
              JOIN ref.type_occupation_chantier t ON t.id = o.type_id
             WHERE o.chantier_id = ch.id) AS occupations,
           count(*) OVER () AS total_general
      FROM app.chantier ch
      LEFT JOIN app.redevable r ON r.id = ch.redevable_id
      LEFT JOIN app.rue ru     ON ru.id = ch.rue_id
      LEFT JOIN app.quartier q ON q.id = ch.quartier_id
     WHERE ${filtres.join(' AND ')}
     ORDER BY ch.date_constat DESC, ch.code
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const total = rows[0] ? Number(rows[0].total_general) : 0;
  return pagine(res, rows.map(({ total_general, ...r }) => r), { page, limite }, total);
}));

router.post('/chantiers', exigerRole('agent'), valider(corpsChantier),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const resultat = await avecContexte(req.contexte, async (client) => {
      const { rows: [g] } = await client.query(
        "SELECT * FROM app.generer_code_objet($1, 'C')", [req.utilisateur.communeId]);

      const geom = (b.longitude !== undefined && b.latitude !== undefined)
        ? `ST_SetSRID(ST_MakePoint(${b.longitude}, ${b.latitude}), 4326)` : 'NULL';

      // date_fin_prevue est déduite de la durée si l'agent n'a saisi que
      // celle-ci : c'est elle qui alimente la liste de repassage.
      const finPrevue = b.date_fin_prevue
        ?? (b.duree_prevue_jours
          ? new Date(Date.now() + b.duree_prevue_jours * 86400000).toISOString().slice(0, 10)
          : null);

      const { rows: [ch] } = await client.query(`
        INSERT INTO app.chantier (
          commune_id, redevable_id, code, numero_sequence, libelle,
          rue_id, quartier_id, zone_id, adresse_libelle, geom,
          surface_m2, duree_prevue_jours, date_fin_prevue,
          numero_autorisation, autorisation_vue, notes,
          agent_recenseur_id, cree_par)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${geom},$10,$11,$12,$13,$14,$15,$16,$16)
        RETURNING *`,
      [req.utilisateur.communeId, b.redevable_id ?? null, g.code, g.numero_sequence,
        b.libelle ?? null, b.rue_id ?? null, b.quartier_id ?? null, b.zone_id ?? null,
        b.adresse_libelle ?? null, b.surface_m2, b.duree_prevue_jours ?? null,
        finPrevue, b.numero_autorisation ?? null, b.autorisation_vue,
        b.notes ?? null, req.utilisateur.id]);

      for (const typeId of b.types) {
        await client.query(
          'INSERT INTO app.chantier_occupation (chantier_id, type_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [ch.id, typeId]);
      }

      return ch;
    });

    return cree(res, {
      ...resultat,
      rappel: 'Recensement seul : ce chantier ne sera pas facturé tant que la commune '
              + 'n\'a pas délibéré un tarif d\'occupation temporaire.',
    });
  }));

/** Constat de fin, ou prolongation. C'est le repassage de l'agent. */
router.post('/chantiers/:id/constat', exigerRole('agent'), valider(paramsId, 'params'),
  valider(z.object({
    statut: z.enum(['en_cours', 'prolonge', 'termine', 'introuvable']),
    date_fin_constatee: dateIso.optional(),
    date_fin_prevue: dateIso.optional(),
    surface_m2: surface.optional(),
    notes: texteCourt(500).optional(),
  }).refine((v) => v.statut !== 'termine' || Boolean(v.date_fin_constatee), {
    message: 'Un chantier terminé exige la date à laquelle la fin a été constatée.',
  }), 'body'), asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await requete(req.contexte, `
      UPDATE app.chantier
         SET statut = $2::app.statut_chantier,
             date_fin_constatee = coalesce($3::date, date_fin_constatee),
             date_fin_prevue    = coalesce($4::date, date_fin_prevue),
             surface_m2         = coalesce($5::numeric, surface_m2),
             notes              = concat_ws(E'\\n', notes, $6::text),
             derniere_visite_le = now(),
             modifie_le = now(), modifie_par = $7, version = version + 1
       WHERE id = $1 AND archive_le IS NULL
       RETURNING id, code, statut, surface_m2, date_fin_prevue, date_fin_constatee`,
    [req.params.id, b.statut, b.date_fin_constatee ?? null, b.date_fin_prevue ?? null,
      b.surface_m2 ?? null, b.notes ?? null, req.utilisateur.id]);

    if (!rows[0]) throw erreurs.introuvable('Chantier');
    return ok(res, rows[0]);
  }));

module.exports = router;
