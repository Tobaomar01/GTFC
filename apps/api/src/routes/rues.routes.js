/**
 * Référentiel des rues — /rues
 *
 * Phase 0 du dispositif : cette table doit être remplie AVANT que les agents
 * descendent sur le terrain. Si la rue est saisie en texte libre, « rue GT
 * 63 », « Rue GT63 » et « rue gt 63 » cohabitent, la reprise se fait à la
 * main sur plusieurs milliers de lignes, et le suivi de couverture — quelles
 * rues restent à faire — devient impossible.
 *
 * La géométrie est facultative. Sans elle, la rue reste parfaitement
 * utilisable comme étiquette : seuls le rattachement automatique par GPS et
 * la carte par segments attendent le tracé.
 */

'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerRole, exigerCommune } = require('../middleware/auth');
const {
  z, valider, uuid, texteCourt, pagination, paramsId, longitude, latitude,
} = require('../middleware/validation');
const {
  asyncHandler, ok, cree, lirePagination, pagine,
} = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');

const router = express.Router();
router.use(authentifier, exigerCommune);

const TYPES_VOIE = ['rue', 'boulevard', 'avenue', 'ruelle', 'impasse', 'place', 'route'];
const SOURCES = ['pdc', 'osm', 'cadastre', 'terrain', 'a_saisir'];

const corpsRue = z.object({
  code: texteCourt(30),
  nom: texteCourt(150),
  quartier_id: uuid.optional(),
  zone_id: uuid.optional(),
  type_voie: z.enum(TYPES_VOIE).optional(),
  source: z.enum(SOURCES).default('a_saisir'),
  variantes: z.array(texteCourt(150)).max(10).default([]),
  // GeoJSON LineString ou MultiLineString. Accepté brut : c'est ce que
  // produisent QGIS, Overpass et la plupart des exports de voirie.
  geometrie: z.object({
    type: z.enum(['LineString', 'MultiLineString']),
    coordinates: z.array(z.any()).min(1),
  }).optional(),
});

// ===========================================================================
//  LISTE
// ===========================================================================
router.get('/', valider(pagination.extend({
  quartier_id: uuid.optional(),
  zone_id: uuid.optional(),
  couverture: z.enum(['non_commencee', 'en_cours', 'terminee']).optional(),
  sans_trace: z.enum(['oui']).optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const { limite, decalage, page } = lirePagination(req.query, { defaut: 100, max: 500 });
  const filtres = ['r.archive_le IS NULL', 'r.actif'];
  const params = [];

  for (const champ of ['quartier_id', 'zone_id']) {
    if (req.query[champ]) {
      params.push(req.query[champ]);
      filtres.push(`r.${champ} = $${params.length}`);
    }
  }
  if (req.query.couverture) {
    params.push(req.query.couverture);
    filtres.push(`r.statut_couverture = $${params.length}::app.statut_couverture`);
  }
  if (req.query.sans_trace === 'oui') filtres.push('r.geom IS NULL');
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    // La recherche porte aussi sur les variantes : l'agent tape le nom qu'il
    // a en tête, pas forcément celui retenu par la mairie.
    filtres.push(`(r.nom_normalise LIKE app.normaliser($${params.length})
                   OR r.code ILIKE $${params.length}
                   OR EXISTS (SELECT 1 FROM unnest(r.variantes) v
                               WHERE app.normaliser(v) LIKE app.normaliser($${params.length})))`);
  }

  params.push(limite, decalage);
  const { rows } = await requete(req.contexte, `
    SELECT r.id, r.code, r.nom, r.type_voie, r.source, r.variantes,
           r.statut_couverture, r.nb_objets_recenses, r.longueur_m,
           (r.geom IS NOT NULL) AS tracee,
           q.nom AS quartier, z.nom AS zone,
           count(*) OVER () AS total_general
      FROM app.rue r
      LEFT JOIN app.quartier q ON q.id = r.quartier_id
      LEFT JOIN app.zone z     ON z.id = r.zone_id
     WHERE ${filtres.join(' AND ')}
     ORDER BY r.nom
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const total = rows[0] ? Number(rows[0].total_general) : 0;
  return pagine(res, rows.map(({ total_general, ...r }) => r), { page, limite }, total);
}));

// ===========================================================================
//  COUVERTURE DU RECENSEMENT
// ===========================================================================
router.get('/couverture', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT statut_couverture,
           count(*)::int              AS nb_rues,
           sum(nb_objets_recenses)::int AS nb_objets,
           count(*) FILTER (WHERE tracee)::int AS nb_tracees
      FROM app.v_couverture_rues
     GROUP BY statut_couverture`);

  const parStatut = Object.fromEntries(rows.map((r) => [r.statut_couverture, r]));
  const total = rows.reduce((s, r) => s + r.nb_rues, 0);
  const terminees = parStatut.terminee?.nb_rues ?? 0;

  const { rows: detail } = await requete(req.contexte, `
    SELECT * FROM app.v_couverture_rues ORDER BY statut_couverture, nom LIMIT 500`);

  return ok(res, {
    total_rues: total,
    // Sans rue enregistrée, le pourcentage vaudrait 0 % ou NaN et laisserait
    // croire à un retard : on dit plutôt que la phase 0 n'a pas commencé.
    avancement_pct: total === 0 ? null : Math.round((terminees / total) * 100),
    phase_0_demarree: total > 0,
    par_statut: parStatut,
    rues: detail,
  });
}));

// ===========================================================================
//  PERFORMANCE PAR RUE
//
//  Ce que la phase 0 débloque : un taux de recouvrement à l'échelle où l'on
//  peut agir. Une zone regroupe des milliers de commerces et sa moyenne ne
//  désigne personne ; une rue en compte quelques dizaines, et un taux bas y
//  désigne quelque chose de concret.
// ===========================================================================
router.get('/performance', valider(z.object({
  quartier_id: uuid.optional(),
  zone_id: uuid.optional(),
  avec_redevables: z.enum(['oui']).optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const filtres = [];
  const params = [];

  for (const champ of ['quartier_id', 'zone_id']) {
    if (req.query[champ]) {
      params.push(req.query[champ]);
      // La vue expose les libellés, pas les identifiants : on repasse par la
      // table des rues pour filtrer.
      filtres.push(`rue_id IN (SELECT id FROM app.rue WHERE ${champ} = $${params.length})`);
    }
  }
  // Les rues sans aucun redevable dominent la liste tant que le recensement
  // n'est pas avancé — 78 sur 86 aujourd'hui. Les masquer donne la vue
  // « où en est la collecte », les garder donne « où reste-t-il à passer ».
  if (req.query.avec_redevables === 'oui') filtres.push('nb_redevables > 0');

  const where = filtres.length ? `WHERE ${filtres.join(' AND ')}` : '';

  const { rows } = await requete(req.contexte, `
    SELECT * FROM app.v_performance_rue
     ${where}
     ORDER BY montant_restant DESC, nb_redevables DESC, nom
     LIMIT 500`, params);

  const avec = rows.filter((r) => r.nb_redevables > 0);
  const du = avec.reduce((s2, r) => s2 + Number(r.montant_du), 0);
  const paye = avec.reduce((s2, r) => s2 + Number(r.montant_paye), 0);

  return ok(res, {
    rues: rows,
    // Le total sert de repère : une rue à 40 % se lit différemment selon que
    // la commune est à 30 % ou à 80 %.
    ensemble: {
      nb_rues_avec_redevables: avec.length,
      montant_du: du,
      montant_paye: paye,
      taux_recouvrement_pct: du > 0 ? Math.round((100 * paye) / du) : null,
    },
  });
}));

/**
 * Tracés des rues en GeoJSON, avec leur performance.
 *
 * Séparé de /performance : la géométrie pèse plusieurs centaines de kilo-
 * octets, et le tableau n'en a aucun besoin. Sur un poste de mairie en 3G,
 * la différence se voit.
 */
router.get('/carte', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte,
    'SELECT app.rues_geojson($1) AS geojson', [req.utilisateur.communeId]);
  return ok(res, rows[0].geojson);
}));

// ===========================================================================
//  CRÉATION ET IMPORT
// ===========================================================================
router.post('/', exigerRole('admin_commune'), valider(corpsRue), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await requete(req.contexte, `
    INSERT INTO app.rue (commune_id, code, nom, quartier_id, zone_id, type_voie,
                         source, variantes, geom, longueur_m, cree_par)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
            CASE WHEN $9::text IS NULL THEN NULL
                 ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)) END,
            CASE WHEN $9::text IS NULL THEN NULL
                 ELSE round(ST_Length(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)::geography)::numeric, 1) END,
            $10)
    RETURNING id, code, nom, source, (geom IS NOT NULL) AS tracee, longueur_m`,
  [req.utilisateur.communeId, b.code, b.nom, b.quartier_id ?? null, b.zone_id ?? null,
    b.type_voie ?? null, b.source, b.variantes,
    b.geometrie ? JSON.stringify(b.geometrie) : null, req.utilisateur.id]);

  return cree(res, rows[0]);
}));

/**
 * Import d'un lot — typiquement une extraction OpenStreetMap ou le plan de
 * voirie communal.
 *
 * Les rues déjà connues sont MISES À JOUR sans écraser le libellé retenu par
 * la mairie : c'est elle qui tranche les graphies, pas OpenStreetMap. Seul le
 * tracé, s'il manquait, est complété.
 */
router.post('/import', exigerRole('admin_commune'), valider(z.object({
  source: z.enum(SOURCES),
  rues: z.array(corpsRue.omit({ source: true })).min(1).max(2000),
}), 'body'), asyncHandler(async (req, res) => {
  const bilan = await avecContexte(req.contexte, async (client) => {
    let crees = 0; let majTraces = 0; let inchangees = 0;

    for (const r of req.body.rues) {
      const geoJson = r.geometrie ? JSON.stringify(r.geometrie) : null;

      const { rows } = await client.query(`
        INSERT INTO app.rue (commune_id, code, nom, quartier_id, zone_id, type_voie,
                             source, variantes, geom, longueur_m, cree_par)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                CASE WHEN $9::text IS NULL THEN NULL
                     ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)) END,
                CASE WHEN $9::text IS NULL THEN NULL
                     ELSE round(ST_Length(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)::geography)::numeric, 1) END,
                $10)
        ON CONFLICT (commune_id, code) DO UPDATE SET
            -- Le tracé n'écrase jamais un tracé existant, et le nom validé
            -- par la mairie n'est jamais remplacé par celui de la source.
            geom       = coalesce(app.rue.geom, EXCLUDED.geom),
            longueur_m = coalesce(app.rue.longueur_m, EXCLUDED.longueur_m),
            variantes  = ARRAY(SELECT DISTINCT unnest(app.rue.variantes || EXCLUDED.variantes)),
            quartier_id = coalesce(app.rue.quartier_id, EXCLUDED.quartier_id),
            zone_id     = coalesce(app.rue.zone_id, EXCLUDED.zone_id),
            modifie_le = now()
        RETURNING (xmax = 0) AS insere, (geom IS NOT NULL) AS tracee`,
      [req.utilisateur.communeId, r.code, r.nom, r.quartier_id ?? null, r.zone_id ?? null,
        r.type_voie ?? null, req.body.source, r.variantes ?? [],
        geoJson, req.utilisateur.id]);

      if (rows[0].insere) crees += 1;
      else if (rows[0].tracee && geoJson) majTraces += 1;
      else inchangees += 1;
    }

    return { crees, traces_completes: majTraces, inchangees };
  });

  return ok(res, {
    ...bilan,
    suite: 'POST /rues/recalculer-rattachements pour rerattacher les objets déjà recensés.',
  });
}));

/**
 * Rerattache les objets géolocalisés à leur rue.
 * À lancer après tout import de tracé. Ne touche jamais à une rue choisie
 * manuellement par un agent : il a vu la plaque, pas nous.
 */
router.post('/recalculer-rattachements', exigerRole('admin_commune'),
  valider(z.object({ seuil_m: z.coerce.number().min(5).max(200).default(25) }), 'body'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT * FROM app.recalculer_rues($1, $2)',
      [req.utilisateur.communeId, req.body.seuil_m]);
    return ok(res, {
      ...rows[0],
      note: `Rayon de ${req.body.seuil_m} m. Au-delà, dans un tissu dense, la rue voisine `
            + 'est aussi probable que la bonne : les objets restent alors sans rue.',
    });
  }));

/** Rue la plus proche d'un point — l'agent la voit proposée à la saisie. */
router.get('/proche', valider(z.object({
  longitude, latitude, seuil_m: z.coerce.number().min(5).max(200).default(25),
}), 'query'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT * FROM app.detecter_rue($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4)`,
  [req.utilisateur.communeId, req.query.longitude, req.query.latitude, req.query.seuil_m]);
  return ok(res, rows[0] ?? null);
}));

// ===========================================================================
//  SUIVI DE COUVERTURE
// ===========================================================================
router.post('/:id/couverture', exigerRole('agent'), valider(paramsId, 'params'),
  valider(z.object({
    statut: z.enum(['non_commencee', 'en_cours', 'terminee']),
  }), 'body'), asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.rue
         SET statut_couverture = $2::app.statut_couverture,
             couverture_debutee_le = CASE WHEN $2 = 'en_cours' AND couverture_debutee_le IS NULL
                                          THEN now() ELSE couverture_debutee_le END,
             couverture_terminee_le = CASE WHEN $2 = 'terminee' THEN now() ELSE NULL END,
             couverture_par = $3, modifie_le = now(), modifie_par = $3
       WHERE id = $1 AND archive_le IS NULL
       RETURNING id, code, nom, statut_couverture, nb_objets_recenses, couverture_terminee_le`,
    [req.params.id, req.body.statut, req.utilisateur.id]);

    if (!rows[0]) throw erreurs.introuvable('Rue');
    return ok(res, rows[0]);
  }));

router.patch('/:id', exigerRole('admin_commune'), valider(paramsId, 'params'),
  valider(corpsRue.partial().omit({ geometrie: true }), 'body'), asyncHandler(async (req, res) => {
    const colonnes = Object.keys(req.body);
    if (colonnes.length === 0) throw erreurs.requeteInvalide('Aucun champ à modifier');

    const sets = colonnes.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await requete(req.contexte, `
      UPDATE app.rue SET ${sets.join(', ')}, modifie_le = now(), modifie_par = $${colonnes.length + 2}
       WHERE id = $1 AND archive_le IS NULL
       RETURNING id, code, nom, type_voie, source, variantes`,
    [req.params.id, ...colonnes.map((c) => req.body[c]), req.utilisateur.id]);

    if (!rows[0]) throw erreurs.introuvable('Rue');
    return ok(res, rows[0]);
  }));

module.exports = router;
