/**
 * Référentiels territoriaux et catégories — /communes, /zones, /quartiers,
 * /marches, /categories
 *
 * Ces données changent rarement mais sont lues en permanence : elles sont
 * embarquées dans le paquet hors-ligne de l'app Android.
 */
'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const {
  authentifier, exigerCommune, exigerRole, exigerSuperAdmin,
} = require('../middleware/auth');
const {
  z, valider, uuid, texteCourt, paramsId,
} = require('../middleware/validation');
const { asyncHandler, ok, cree } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');

const router = express.Router();

// Ce routeur est monté sur « / » : on limite explicitement l'authentification
// à ses propres préfixes. Sans cette liste, toute URL inconnue de l'API
// traverserait ce middleware et répondrait 401 au lieu de 404.
const PREFIXES = ['/communes', '/zones', '/quartiers', '/marches', '/categories',
  '/types-emplacement', '/motifs-exoneration'];
router.use(PREFIXES, authentifier);

// ===========================================================================
//  COMMUNES
// ===========================================================================

/** Liste des communes — le super-admin les voit toutes, une mairie la sienne. */
router.get('/communes', asyncHandler(async (req, res) => {
  const { rows } = await requete(
    { ...req.contexte, superAdmin: req.utilisateur.role === 'super_admin' },
    `SELECT c.id, c.code, c.slug, c.nom, c.departement, c.region,
            c.superficie_km2, c.population, c.actif, c.est_pilote,
            c.couleur_principale, c.logo_url,
            ST_X(c.centre) AS centre_longitude, ST_Y(c.centre) AS centre_latitude,
            (SELECT count(*) FROM app.commerce x
              WHERE x.commune_id = c.id AND x.archive_le IS NULL)::int AS nb_commerces
       FROM app.commune c
      WHERE c.archive_le IS NULL
      ORDER BY c.est_pilote DESC, c.nom`);
  return ok(res, rows);
}));

router.get('/communes/:id', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT c.*, ST_X(c.centre) AS centre_longitude, ST_Y(c.centre) AS centre_latitude,
           to_jsonb(p) - 'commune_id' AS parametres
      FROM app.commune c
      LEFT JOIN app.commune_parametre p ON p.commune_id = c.id
     WHERE c.id = $1 AND c.archive_le IS NULL`, [req.params.id]);
  if (!rows[0]) throw erreurs.introuvable('Commune');

  // La géométrie complète pèse lourd et n'a pas sa place dans une fiche
  delete rows[0].geom;
  delete rows[0].centre;
  return ok(res, rows[0]);
}));

/** Création d'une commune : réservée au super-admin (nouveau locataire). */
router.post('/communes', exigerSuperAdmin,
  valider(z.object({
    code: z.string().regex(/^[A-Z0-9]{2,10}$/, 'Code en majuscules, 2 à 10 caractères'),
    slug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/,
      'Slug en minuscules (il deviendra le sous-domaine)'),
    nom: texteCourt(200),
    departement: z.string().max(100).optional(),
    region: z.string().max(100).optional(),
    superficie_km2: z.coerce.number().min(0).optional(),
    population: z.coerce.number().int().min(0).optional(),
    centre_longitude: z.coerce.number().optional(),
    centre_latitude: z.coerce.number().optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const resultat = await avecContexte({ ...req.contexte, superAdmin: true }, async (client) => {
      const { rows } = await client.query(`
        INSERT INTO app.commune (code, slug, nom, departement, region,
                                 superficie_km2, population, centre,
                                 actif, date_activation)
        VALUES ($1, $2, $3, $4, $5, $6, $7,
                CASE WHEN $8::numeric IS NOT NULL
                     THEN app.point_gps($8, $9) END,
                true, current_date)
        RETURNING id, code, slug, nom`,
      [b.code, b.slug, b.nom, b.departement ?? null, b.region ?? null,
        b.superficie_km2 ?? null, b.population ?? null,
        b.centre_longitude ?? null, b.centre_latitude ?? null]);

      // Sans ligne de paramètres, aucun calcul de taxe n'est possible :
      // on la crée d'office avec les valeurs par défaut.
      await client.query(
        `INSERT INTO app.commune_parametre (commune_id, prefixe_code_commerce)
         VALUES ($1, $2)`, [rows[0].id, b.code]);

      // Les 5 taxes sont activées par défaut ; la mairie désactivera celles
      // qu'elle ne perçoit pas.
      await client.query(`
        INSERT INTO ref.commune_type_taxe (commune_id, type_taxe_id, actif)
        SELECT $1, id, true FROM ref.type_taxe`, [rows[0].id]);

      return rows[0];
    });

    return cree(res, {
      ...resultat,
      rappel: `Créez l'enregistrement DNS puis lancez : bash scripts/add-commune-domain.sh ${resultat.slug}`,
    });
  }));

router.patch('/communes/:id/parametres',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({
    jour_exigibilite: z.coerce.number().int().min(1).max(28).optional(),
    delai_grace_jours: z.coerce.number().int().min(0).max(60).optional(),
    taux_penalite_pct: z.coerce.number().min(0).max(100).optional(),
    penalite_plafond_pct: z.coerce.number().min(0).max(200).optional(),
    todp_surface_minimale_m2: z.coerce.number().min(0).max(100).optional(),
    todp_surface_maximale_m2: z.coerce.number().min(0).max(10000).nullable().optional(),
    todp_arrondi: z.enum(['superieur', 'inferieur', 'proche', 'dixieme']).optional(),
    rayon_tolerance_gps_m: z.coerce.number().int().min(5).max(1000).optional(),
    photo_devanture_obligatoire: z.boolean().optional(),
    photo_todp_obligatoire: z.boolean().optional(),
    objectif_visites_jour_agent: z.coerce.number().int().min(0).max(200).optional(),
    encaissement_especes_autorise: z.boolean().optional(),
    a_remplacer: z.boolean().optional(),
  })),
  asyncHandler(async (req, res) => {
    const champs = Object.keys(req.body);
    if (champs.length === 0) throw erreurs.requeteInvalide('Aucun paramètre à modifier');

    const valeurs = [req.params.id];
    const sets = champs.map((c) => {
      valeurs.push(req.body[c]);
      return `${c} = $${valeurs.length}`;
    });

    const { rows } = await requete(req.contexte,
      `UPDATE app.commune_parametre SET ${sets.join(', ')} WHERE commune_id = $1
       RETURNING *`, valeurs);
    if (!rows[0]) throw erreurs.introuvable('Paramètres de la commune');
    return ok(res, rows[0]);
  }));

// ===========================================================================
//  ZONES ET QUARTIERS
// ===========================================================================
router.use('/zones', exigerCommune);
router.use('/quartiers', exigerCommune);

router.get('/zones', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT z.id, z.code, z.nom, z.description, z.couleur, z.ordre, z.a_remplacer,
           (z.geom IS NOT NULL) AS a_polygone,
           (SELECT count(*) FROM app.quartier q
             WHERE q.zone_id = z.id AND q.archive_le IS NULL)::int AS nb_quartiers,
           (SELECT count(*) FROM app.commerce c
             WHERE c.zone_id = z.id AND c.archive_le IS NULL)::int AS nb_commerces
      FROM app.zone z WHERE z.archive_le IS NULL ORDER BY z.ordre, z.code`);
  return ok(res, rows);
}));

router.get('/quartiers',
  valider(z.object({ zone_id: uuid.optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    let filtre = 'q.archive_le IS NULL';
    if (req.query.zone_id) { params.push(req.query.zone_id); filtre += ` AND q.zone_id = $${params.length}`; }

    const { rows } = await requete(req.contexte, `
      SELECT q.id, q.code, q.nom, q.zone_id, z.code AS zone_code, z.nom AS zone_nom,
             q.population, q.nb_commerces_estime, q.a_remplacer,
             (q.geom IS NOT NULL) AS a_polygone,
             ST_X(q.centre) AS centre_longitude, ST_Y(q.centre) AS centre_latitude,
             (SELECT count(*) FROM app.commerce c
               WHERE c.quartier_id = q.id AND c.archive_le IS NULL)::int AS nb_commerces
        FROM app.quartier q JOIN app.zone z ON z.id = q.zone_id
       WHERE ${filtre} ORDER BY z.ordre, q.code`, params);
    return ok(res, rows);
  }));

/**
 * Chargement des polygones officiels (GeoJSON fourni par la mairie ou l'ANAT).
 *
 * Après import, tous les commerces déjà recensés sont rerattachés d'après
 * leurs coordonnées : c'est ce qui permet de démarrer le recensement avant
 * même de disposer du fond de carte.
 */
router.post('/quartiers/:id/geometrie',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({
    geojson: z.any(),
    nom: texteCourt(200).optional(),
  })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.quartier
         SET geom = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)),
             centre = ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)),
             nom = COALESCE($3, nom),
             a_remplacer = false
       WHERE id = $1
       RETURNING id, code, nom, ST_Area(geom::geography) AS surface_m2`,
    [req.params.id, JSON.stringify(req.body.geojson), req.body.nom ?? null]);

    if (!rows[0]) throw erreurs.introuvable('Quartier');
    return ok(res, {
      ...rows[0],
      message: 'Polygone enregistré. Lancez POST /quartiers/recalculer pour '
        + 'rerattacher les commerces déjà recensés.',
    });
  }));

router.post('/quartiers/recalculer', exigerRole('admin_commune'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT * FROM app.recalculer_quartiers($1)', [req.utilisateur.communeId]);
    return ok(res, rows[0]);
  }));

// ===========================================================================
//  MARCHÉS
// ===========================================================================
router.get('/marches', exigerCommune, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT m.id, m.code, m.nom, m.quartier_id, q.nom AS quartier,
           m.nb_places, m.jours_marche, m.a_remplacer,
           ST_X(m.geom) AS longitude, ST_Y(m.geom) AS latitude,
           (SELECT count(*) FROM app.commerce c
             WHERE c.marche_id = m.id AND c.archive_le IS NULL)::int AS nb_commerces
      FROM app.marche m LEFT JOIN app.quartier q ON q.id = m.quartier_id
     WHERE m.archive_le IS NULL ORDER BY m.nom`);
  return ok(res, rows);
}));

// ===========================================================================
//  CATÉGORIES DE COMMERCES
// ===========================================================================
router.get('/categories', exigerCommune, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT c.id, c.code, c.libelle, c.description, c.icone,
           c.todp_probable, c.enseigne_probable, c.sur_marche,
           c.ordre_affichage, c.a_remplacer,
           COALESCE(json_agg(json_build_object('code', tt.code, 'libelle', tt.libelle_court,
                                               'obligatoire', ct.obligatoire)
                             ORDER BY tt.ordre_affichage)
                    FILTER (WHERE tt.id IS NOT NULL), '[]') AS taxes
      FROM ref.categorie_commerce c
      LEFT JOIN ref.categorie_taxe ct ON ct.categorie_id = c.id
      LEFT JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
     WHERE c.actif AND c.archive_le IS NULL
     GROUP BY c.id
     ORDER BY c.ordre_affichage, c.libelle`);
  return ok(res, rows);
}));

router.patch('/categories/:id',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({
    libelle: texteCourt(200).optional(),
    description: z.string().max(500).optional(),
    todp_probable: z.boolean().optional(),
    enseigne_probable: z.boolean().optional(),
    sur_marche: z.boolean().optional(),
    ordre_affichage: z.coerce.number().int().optional(),
    actif: z.boolean().optional(),
    a_remplacer: z.boolean().optional(),
  })),
  asyncHandler(async (req, res) => {
    const champs = Object.keys(req.body);
    if (champs.length === 0) throw erreurs.requeteInvalide('Aucun champ à modifier');

    const valeurs = [req.params.id];
    const sets = champs.map((c) => {
      valeurs.push(req.body[c]);
      return `${c} = $${valeurs.length}`;
    });
    const { rows } = await requete(req.contexte,
      `UPDATE ref.categorie_commerce SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, code, libelle, a_remplacer`, valeurs);
    if (!rows[0]) throw erreurs.introuvable('Catégorie');
    return ok(res, rows[0]);
  }));

router.get('/types-emplacement', exigerCommune, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte,
    `SELECT id, code, libelle, surface_type_m2, ordre_affichage, a_remplacer
       FROM ref.type_emplacement WHERE actif ORDER BY ordre_affichage`);
  return ok(res, rows);
}));

router.get('/motifs-exoneration', exigerCommune, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte,
    `SELECT id, code, libelle, description, role_minimum,
            justificatif_requis, duree_max_mois, a_remplacer
       FROM ref.motif_exoneration WHERE actif ORDER BY libelle`);
  return ok(res, rows);
}));

module.exports = router;
