/**
 * Routes des commerces — /commerces
 *
 * Cœur du travail de terrain : recensement, mise à jour, photos, QR codes.
 */
'use strict';

const express = require('express');
const multer = require('multer');
const config = require('../config/env');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const { limiteEcriture } = require('../middleware/limites');
const {
  z, valider, uuid, telephone, longitude, latitude, surface, texteCourt, pagination, paramsId,
} = require('../middleware/validation');
const { asyncHandler, ok, cree, lirePagination, pagine, ordreSur } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');
const commerceService = require('../services/commerce.service');
const qrService = require('../services/qr.service');
const stockage = require('../services/stockage.service');

const router = express.Router();
router.use(authentifier, exigerCommune);

// Les photos transitent en mémoire : elles partent aussitôt vers MinIO, il
// serait inutile — et risqué — de les écrire sur le disque du serveur.
const televersement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.stockage.tailleMaxPhotoOctets, files: 4 },
});

// ---------------------------------------------------------------------------
// Schémas
// ---------------------------------------------------------------------------
// Champs bruts, sans règle croisée : réutilisés tels quels par le PATCH,
// où l'on ne peut pas exiger « GPS ou quartier » puisque la fiche existe déjà.
const champsCommerce = z.object({
  enseigne: texteCourt(200),
  categorie_id: uuid,
  quartier_id: uuid.optional(),

  longitude: longitude.optional(),
  latitude: latitude.optional(),
  precision_gps_m: z.coerce.number().min(0).max(10000).optional(),

  activite_precise: z.string().trim().max(200).optional(),
  gerant_nom: z.string().trim().max(120).optional(),
  gerant_prenom: z.string().trim().max(120).optional(),
  gerant_telephone: telephone.optional(),
  telephone_paiement: telephone.optional(),
  gerant_piece_type: z.enum(['cni', 'passeport', 'permis', 'autre']).optional(),
  gerant_piece_numero: z.string().trim().max(60).optional(),
  ninea: z.string().trim().max(30).optional(),
  numero_patente: z.string().trim().max(60).optional(),

  adresse_libelle: z.string().trim().max(300).optional(),
  point_repere: z.string().trim().max(300).optional(),

  surface_locale_m2: surface.optional(),
  todp_surface_m2: surface.optional(),
  enseigne_surface_m2: surface.optional(),
  enseigne_lumineuse: z.boolean().optional(),

  marche_id: uuid.optional(),
  type_emplacement_id: uuid.optional(),
  numero_emplacement: z.string().trim().max(30).optional(),
  nb_jours_marche: z.coerce.number().int().min(0).max(31).optional(),

  date_recensement: z.coerce.date().optional(),
  debute_le: z.coerce.date().optional(),
  hors_ligne: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
  taxes: z.array(z.string()).optional(),
});

const schemaCreation = champsCommerce
  // Le GPS n'est pas obligatoire (un agent peut être sous une dalle béton),
  // mais alors le quartier doit être choisi à la main.
  .refine((d) => (d.longitude != null && d.latitude != null) || d.quartier_id != null, {
    message: 'Fournissez des coordonnées GPS ou sélectionnez un quartier',
    path: ['quartier_id'],
  })
  .refine((d) => (d.longitude == null) === (d.latitude == null), {
    message: 'Longitude et latitude doivent être fournies ensemble',
    path: ['longitude'],
  });

const schemaFiltres = pagination.extend({
  zone_id: uuid.optional(),
  quartier_id: uuid.optional(),
  categorie_id: uuid.optional(),
  marche_id: uuid.optional(),
  agent_id: uuid.optional(),
  statut: z.enum(['actif', 'ferme_temporaire', 'ferme_definitif', 'introuvable', 'archive']).optional(),
  statut_fiscal: z.enum(['a_jour', 'partiel', 'impaye', 'exonere', 'inconnu']).optional(),
  avec_todp: z.coerce.boolean().optional(),
  sans_qr: z.coerce.boolean().optional(),
});

const TRIS_AUTORISES = ['c.code', 'c.enseigne', 'c.cree_le', 'c.modifie_le',
  'c.solde_du', 'c.derniere_visite_le'];

// ---------------------------------------------------------------------------
// GET /commerces
// ---------------------------------------------------------------------------
router.get('/', valider(schemaFiltres, 'query'), asyncHandler(async (req, res) => {
  const p = lirePagination(req.query);
  const tri = ordreSur(TRIS_AUTORISES, `c.${req.query.tri}`, req.query.sens, 'c.code');
  const { lignes, total } = await commerceService.lister(req.contexte, req.query, p, tri);
  return pagine(res, lignes, p, total);
}));

// ---------------------------------------------------------------------------
// GET /commerces/carte — points pour la carte OpenStreetMap
// Réponse allégée : sur 5 443 commerces, les champs inutiles pèsent lourd.
// ---------------------------------------------------------------------------
router.get('/carte',
  valider(z.object({
    zone_id: uuid.optional(),
    quartier_id: uuid.optional(),
    statut_fiscal: z.string().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const conditions = [];
    const params = [];
    for (const [champ, colonne] of [['zone_id', 'zone_id'], ['quartier_id', 'quartier_id'],
      ['statut_fiscal', 'statut_fiscal']]) {
      if (req.query[champ]) {
        params.push(req.query[champ]);
        conditions.push(`${colonne} = $${params.length}`);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await requete(req.contexte,
      `SELECT id, code, enseigne, categorie, quartier, zone,
              longitude, latitude, statut_fiscal, couleur, solde_du
         FROM app.v_commerce_carte ${where}`, params);

    return ok(res, rows, { total: rows.length });
  }));

// ---------------------------------------------------------------------------
// GET /commerces/proches — anti-doublon sur le terrain
// ---------------------------------------------------------------------------
router.get('/proches',
  valider(z.object({
    longitude, latitude,
    rayon_m: z.coerce.number().int().min(10).max(2000).optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT * FROM app.commerces_proches($1, $2, $3, $4, 20)',
      [req.utilisateur.communeId, req.query.longitude, req.query.latitude,
        req.query.rayon_m ?? 100]);
    return ok(res, rows);
  }));

// ---------------------------------------------------------------------------
// GET /commerces/:id
// ---------------------------------------------------------------------------
router.get('/:id', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const commerce = await commerceService.detail(req.contexte, req.params.id);

  // Les photos ne sont jamais servies en direct : on délivre des URL
  // pré-signées, valables 15 minutes.
  commerce.photos = await Promise.all(commerce.photos.map(async (p) => ({
    ...p,
    url: await stockage.urlSignee(p.bucket, p.chemin),
  })));

  return ok(res, commerce);
}));

// ---------------------------------------------------------------------------
// POST /commerces — recensement
// ---------------------------------------------------------------------------
router.post('/', limiteEcriture, valider(schemaCreation), asyncHandler(async (req, res) => {
  const resultat = await commerceService.creer(req.contexte, req.body);

  // Le QR est généré dans la foulée : un commerce sans QR ne peut pas
  // recevoir de sticker, et l'agent est encore devant la boutique.
  let qr = null;
  try {
    qr = await qrService.genererPourCommerce(req.contexte, { commerceId: resultat.id });
  } catch (err) {
    req.log?.error({ err, commerce: resultat.id }, 'QR non généré à la création');
  }

  return cree(res, { ...resultat, qr_code: qr });
}));

// ---------------------------------------------------------------------------
// PATCH /commerces/:id
// ---------------------------------------------------------------------------
router.patch('/:id', limiteEcriture,
  valider(paramsId, 'params'),
  valider(champsCommerce.partial().extend({
    version: z.coerce.number().int().optional(),
    statut: z.enum(['actif', 'ferme_temporaire', 'ferme_definitif', 'introuvable']).optional(),
  })),
  asyncHandler(async (req, res) => {
    const { version, ...donnees } = req.body;
    const resultat = await commerceService.mettreAJour(
      req.contexte, req.params.id, donnees, version ?? null);
    return ok(res, resultat);
  }));

// ---------------------------------------------------------------------------
// DELETE /commerces/:id — archivage, jamais de suppression physique
// ---------------------------------------------------------------------------
router.delete('/:id',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  valider(z.object({ motif: texteCourt(500) })),
  asyncHandler(async (req, res) => {
    const resultat = await commerceService.archiver(req.contexte, req.params.id, req.body.motif);
    return ok(res, { ...resultat, message: 'Commerce archivé (les données sont conservées)' });
  }));

// ---------------------------------------------------------------------------
// POST /commerces/:id/photos
// ---------------------------------------------------------------------------
router.post('/:id/photos',
  limiteEcriture,
  valider(paramsId, 'params'),
  televersement.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw erreurs.requeteInvalide('Aucun fichier reçu (champ « photo » attendu)');

    const schema = z.object({
      type: z.enum(['devanture', 'trottoir_todp', 'enseigne', 'document', 'autre']),
      prise_le: z.coerce.date().optional(),
      longitude: longitude.optional(),
      latitude: latitude.optional(),
      precision_gps_m: z.coerce.number().min(0).optional(),
      commentaire: z.string().max(500).optional(),
    });
    const meta = schema.parse(req.body);

    const { rows } = await requete(req.contexte,
      `SELECT c.id, c.commune_id, m.code AS commune_code
         FROM app.commerce c JOIN app.commune m ON m.id = c.commune_id
        WHERE c.id = $1 AND c.archive_le IS NULL`, [req.params.id]);
    if (!rows[0]) throw erreurs.introuvable('Commerce');

    const fichier = await stockage.televerserPhoto({
      buffer: req.file.buffer,
      mimeDeclare: req.file.mimetype,
      communeCode: rows[0].commune_code,
      commerceId: req.params.id,
      type: meta.type,
      metadonnees: { agent: req.utilisateur.id },
    });

    // Une même photo réutilisée pour deux commerces différents est un signal
    // de fraude classique : on l'enregistre quand même, mais on le signale.
    const { rows: doublon } = await requete(req.contexte,
      `SELECT commerce_id FROM app.commerce_photo
        WHERE sha256 = $1 AND commerce_id <> $2 AND archive_le IS NULL LIMIT 1`,
      [fichier.sha256, req.params.id]);

    const { rows: photo } = await requete(req.contexte, `
      INSERT INTO app.commerce_photo (
        commune_id, commerce_id, type, bucket, chemin, type_mime, taille_octets,
        sha256, prise_le, geom, precision_gps_m, agent_id, commentaire
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()),
                app.point_gps($10, $11), $12, $13, $14)
      RETURNING id, type, prise_le`,
    [
      rows[0].commune_id, req.params.id, meta.type, fichier.bucket, fichier.chemin,
      fichier.type_mime, fichier.taille_octets, fichier.sha256, meta.prise_le ?? null,
      meta.longitude ?? null, meta.latitude ?? null, meta.precision_gps_m ?? null,
      req.utilisateur.id, meta.commentaire ?? null,
    ]);

    return cree(res, {
      ...photo[0],
      url: await stockage.urlSignee(fichier.bucket, fichier.chemin),
      taille_octets: fichier.taille_octets,
      photo_deja_utilisee: doublon[0] ? doublon[0].commerce_id : null,
    });
  }));

// ---------------------------------------------------------------------------
// GET /commerces/:id/qr — QR code actif
// ---------------------------------------------------------------------------
router.get('/:id/qr', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT id, jeton, url, version, bucket, chemin_png, genere_le,
           imprime_le, pose_le, nb_scans, dernier_scan_le
      FROM app.qr_code WHERE commerce_id = $1 AND actif`, [req.params.id]);
  if (!rows[0]) throw erreurs.introuvable('QR code actif');

  return ok(res, {
    ...rows[0],
    image_url: rows[0].chemin_png
      ? await stockage.urlSignee(rows[0].bucket, rows[0].chemin_png)
      : null,
  });
}));

// ---------------------------------------------------------------------------
// POST /commerces/:id/qr — (re)génération, sticker abîmé ou décollé
// ---------------------------------------------------------------------------
router.post('/:id/qr',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  valider(z.object({ motif: texteCourt(300).optional() })),
  asyncHandler(async (req, res) => {
    const qr = await qrService.genererPourCommerce(req.contexte, {
      commerceId: req.params.id,
      motifRemplacement: req.body.motif ?? 'remplacement',
    });
    return cree(res, qr);
  }));

// ---------------------------------------------------------------------------
// GET /commerces/:id/sticker — planche A6 en SVG, prête à imprimer
// ---------------------------------------------------------------------------
router.get('/:id/sticker', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { svg, nomFichier } = await qrService.genererStickerA6(req.contexte, req.params.id);

  await requete(req.contexte,
    `UPDATE app.qr_code SET imprime_le = COALESCE(imprime_le, now())
      WHERE commerce_id = $1 AND actif`, [req.params.id]);

  res.type('image/svg+xml');
  res.setHeader('Content-Disposition', `inline; filename="${nomFichier}"`);
  return res.send(svg);
}));

// ---------------------------------------------------------------------------
// POST /commerces/:id/visite — passage de contrôle sans modification
// ---------------------------------------------------------------------------
router.post('/:id/visite', limiteEcriture,
  valider(paramsId, 'params'),
  valider(z.object({
    resultat: z.enum(['controle', 'ferme', 'refus', 'introuvable', 'mise_a_jour', 'encaissement']),
    commentaire: z.string().max(1000).optional(),
    longitude: longitude.optional(),
    latitude: latitude.optional(),
    precision_gps_m: z.coerce.number().min(0).optional(),
    debute_le: z.coerce.date().optional(),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await avecContexte(req.contexte, (client) => client.query(`
      INSERT INTO app.visite (commune_id, commerce_id, agent_id, resultat, commentaire,
                              geom, precision_gps_m, debute_le, termine_le)
      VALUES ($1, $2, $3, $4, $5, app.point_gps($6, $7), $8, COALESCE($9::timestamptz, now()), now())
      RETURNING id, resultat, distance_commerce_m, debute_le`,
    [req.utilisateur.communeId, req.params.id, req.utilisateur.id, b.resultat,
      b.commentaire ?? null, b.longitude ?? null, b.latitude ?? null,
      b.precision_gps_m ?? null, b.debute_le ?? null]));

    return cree(res, rows[0]);
  }));

module.exports = router;
