/**
 * Taxes, barèmes et exonérations — /taxes
 *
 * Un barème engage juridiquement la commune : il n'est jamais modifié en
 * place, il est clos et remplacé. L'API suit cette règle — pas de PUT sur un
 * barème, seulement une clôture et une création.
 */
'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerCommune, exigerRole } = require('../middleware/auth');
const {
  z, valider, uuid, texteCourt, montantXof, paramsId,
} = require('../middleware/validation');
const { asyncHandler, ok, cree } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');

const router = express.Router();
router.use(authentifier, exigerCommune);

// ===========================================================================
//  TYPES DE TAXES
// ===========================================================================
router.get('/types', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT tt.id, tt.code, tt.libelle, tt.libelle_court, tt.description,
           tt.conditionnelle, tt.condition_libelle,
           tt.parametre_requis, tt.parametre_unite, tt.ordre_affichage,
           ctt.actif, COALESCE(ctt.periodicite, tt.periodicite_defaut) AS periodicite,
           COALESCE(ctt.mode_calcul, tt.mode_calcul_defaut) AS mode_calcul,
           ctt.libelle_local, ctt.delib_reference, ctt.delib_date,
           EXISTS (SELECT 1 FROM app.bareme_taxe b
                    WHERE b.type_taxe_id = tt.id
                      AND b.commune_id = ctt.commune_id
                      AND b.periode @> current_date) AS bareme_en_vigueur
      FROM ref.type_taxe tt
      LEFT JOIN ref.commune_type_taxe ctt
             ON ctt.type_taxe_id = tt.id AND ctt.commune_id = $1
     WHERE tt.actif
     ORDER BY tt.ordre_affichage`, [req.utilisateur.communeId]);
  return ok(res, rows);
}));

// ===========================================================================
//  BARÈMES
// ===========================================================================
router.get('/baremes',
  valider(z.object({
    type_taxe_id: uuid.optional(),
    en_vigueur: z.coerce.boolean().optional(),
    date: z.coerce.date().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    const conditions = [];
    if (req.query.type_taxe_id) {
      params.push(req.query.type_taxe_id);
      conditions.push(`b.type_taxe_id = $${params.length}`);
    }
    if (req.query.en_vigueur) {
      params.push(req.query.date ?? new Date());
      conditions.push(`b.periode @> $${params.length}::date`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await requete(req.contexte, `
      SELECT b.id, b.libelle, b.mode_calcul, b.periodicite,
             b.montant_fixe, b.montant_unitaire, b.unite,
             b.montant_minimum, b.montant_maximum,
             b.date_effet, b.date_fin, b.a_remplacer,
             b.delib_reference, b.delib_date,
             tt.code AS taxe_code, tt.libelle_court AS taxe,
             (b.periode @> current_date) AS en_vigueur,
             (SELECT count(*) FROM app.bareme_tranche t WHERE t.bareme_id = b.id)::int AS nb_tranches
        FROM app.bareme_taxe b JOIN ref.type_taxe tt ON tt.id = b.type_taxe_id
        ${where}
       ORDER BY tt.ordre_affichage, b.date_effet DESC`, params);
    return ok(res, rows);
  }));

router.get('/baremes/:id', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT b.*, tt.code AS taxe_code, tt.libelle_court AS taxe
      FROM app.bareme_taxe b JOIN ref.type_taxe tt ON tt.id = b.type_taxe_id
     WHERE b.id = $1`, [req.params.id]);
  if (!rows[0]) throw erreurs.introuvable('Barème');

  const { rows: tranches } = await requete(req.contexte, `
    SELECT t.id, t.libelle, t.borne_min, t.borne_max, t.montant, t.montant_unitaire,
           t.ordre, t.a_remplacer,
           c.code AS categorie_code, c.libelle AS categorie,
           z.code AS zone_code, e.libelle AS type_emplacement
      FROM app.bareme_tranche t
      LEFT JOIN ref.categorie_commerce c ON c.id = t.categorie_id
      LEFT JOIN app.zone z ON z.id = t.zone_id
      LEFT JOIN ref.type_emplacement e ON e.id = t.type_emplacement_id
     WHERE t.bareme_id = $1 ORDER BY t.ordre, t.borne_min NULLS FIRST`, [req.params.id]);

  return ok(res, { ...rows[0], tranches });
}));

const schemaBareme = z.object({
  type_taxe_id: uuid,
  libelle: texteCourt(200),
  mode_calcul: z.enum(['forfait', 'par_categorie', 'par_m2', 'par_tranche', 'par_jour']),
  periodicite: z.enum(['journaliere', 'mensuelle', 'trimestrielle', 'semestrielle', 'annuelle']),
  montant_fixe: montantXof.optional(),
  montant_unitaire: z.coerce.number().min(0).optional(),
  unite: z.string().max(20).optional(),
  montant_minimum: montantXof.optional(),
  montant_maximum: montantXof.optional(),
  date_effet: z.coerce.date(),
  date_fin: z.coerce.date().nullable().optional(),
  delib_reference: texteCourt(120),
  delib_date: z.coerce.date().optional(),
  tranches: z.array(z.object({
    categorie_id: uuid.optional(),
    zone_id: uuid.optional(),
    type_emplacement_id: uuid.optional(),
    libelle: z.string().max(200).optional(),
    borne_min: z.coerce.number().optional(),
    borne_max: z.coerce.number().optional(),
    montant: montantXof.default(0),
    montant_unitaire: z.coerce.number().min(0).optional(),
    ordre: z.coerce.number().int().optional(),
  })).optional(),
  cloturer_precedent: z.boolean().optional(),
});

/**
 * Création d'un barème.
 *
 * `cloturer_precedent` ferme automatiquement le barème en vigueur à la veille
 * de la nouvelle date d'effet. Sans cela, la contrainte d'exclusion de la
 * base refuserait l'insertion — ce qui est le comportement voulu, mais un
 * message d'erreur en pleine séance du conseil municipal n'aide personne.
 */
router.post('/baremes', exigerRole('admin_commune'), valider(schemaBareme),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const resultat = await avecContexte(req.contexte, async (client) => {
      if (b.cloturer_precedent) {
        await client.query(`
          UPDATE app.bareme_taxe
             SET date_fin = $3::date
           WHERE commune_id = $1 AND type_taxe_id = $2
             AND periode @> $3::date AND date_effet < $3::date`,
        [req.utilisateur.communeId, b.type_taxe_id, b.date_effet]);
      }

      const { rows } = await client.query(`
        INSERT INTO app.bareme_taxe (
          commune_id, type_taxe_id, libelle, mode_calcul, periodicite,
          montant_fixe, montant_unitaire, unite, montant_minimum, montant_maximum,
          date_effet, date_fin, delib_reference, delib_date, a_remplacer, cree_par
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,$15)
        RETURNING id, libelle, date_effet`,
      [req.utilisateur.communeId, b.type_taxe_id, b.libelle, b.mode_calcul, b.periodicite,
        b.montant_fixe ?? null, b.montant_unitaire ?? null, b.unite ?? null,
        b.montant_minimum ?? null, b.montant_maximum ?? null,
        b.date_effet, b.date_fin ?? null, b.delib_reference, b.delib_date ?? null,
        req.utilisateur.id]);

      const bareme = rows[0];

      for (const [i, t] of (b.tranches ?? []).entries()) {
        await client.query(`
          INSERT INTO app.bareme_tranche (
            bareme_id, categorie_id, zone_id, type_emplacement_id, libelle,
            borne_min, borne_max, montant, montant_unitaire, ordre, a_remplacer
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)`,
        [bareme.id, t.categorie_id ?? null, t.zone_id ?? null, t.type_emplacement_id ?? null,
          t.libelle ?? null, t.borne_min ?? null, t.borne_max ?? null,
          t.montant, t.montant_unitaire ?? null, t.ordre ?? i]);
      }

      return { ...bareme, nb_tranches: (b.tranches ?? []).length };
    });

    return cree(res, resultat);
  }));

/** Clôture d'un barème : seule modification autorisée sur un tarif publié. */
router.post('/baremes/:id/cloturer',
  exigerRole('admin_commune'),
  valider(paramsId, 'params'),
  valider(z.object({ date_fin: z.coerce.date() })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      `UPDATE app.bareme_taxe SET date_fin = $2, modifie_par = $3
        WHERE id = $1 AND (date_fin IS NULL OR date_fin > $2)
        RETURNING id, libelle, date_effet, date_fin`,
      [req.params.id, req.body.date_fin, req.utilisateur.id]);
    if (!rows[0]) throw erreurs.introuvable('Barème ouvert');
    return ok(res, rows[0]);
  }));

// ===========================================================================
//  SIMULATION — calculer sans facturer
// ===========================================================================

/**
 * Renvoie le montant que devrait chaque taxe pour un commerce, avec le détail
 * du calcul. C'est l'écran « pourquoi ce montant ? » de l'app et du guichet.
 */
router.get('/simuler/:commerceId',
  valider(z.object({ commerceId: uuid }), 'params'),
  valider(z.object({ date: z.coerce.date().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const date = req.query.date ?? new Date();

    const { rows: taxes } = await requete(req.contexte, `
      SELECT ct.type_taxe_id, tt.code, tt.libelle_court
        FROM app.commerce_taxe ct JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
       WHERE ct.commerce_id = $1 AND ct.actif AND ct.periode @> $2::date
       ORDER BY tt.ordre_affichage`, [req.params.commerceId, date]);

    const lignes = [];
    let total = 0;
    for (const t of taxes) {
      const { rows } = await requete(req.contexte,
        'SELECT * FROM app.calculer_taxe($1, $2, $3::date)',
        [req.params.commerceId, t.type_taxe_id, date]).catch((err) => {
        // Barème manquant : on le signale ligne par ligne plutôt que de faire
        // échouer toute la simulation.
        lignes.push({ taxe: t.libelle_court, code: t.code, erreur: err.message });
        return { rows: [] };
      });

      if (rows[0]) {
        total += Number(rows[0].montant);
        lignes.push({
          taxe: t.libelle_court,
          code: t.code,
          montant: Number(rows[0].montant),
          base_calcul: rows[0].base_calcul,
          unite: rows[0].unite,
          montant_unitaire: rows[0].montant_unitaire,
          mode_calcul: rows[0].mode_calcul,
          detail: rows[0].detail,
        });
      }
    }

    return ok(res, { date, lignes, total, devise: 'XOF' });
  }));

// ===========================================================================
//  TAXES D'UN COMMERCE
// ===========================================================================
router.get('/commerce/:commerceId',
  valider(z.object({ commerceId: uuid }), 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      SELECT ct.id, ct.type_taxe_id, tt.code, tt.libelle_court AS libelle,
             ct.parametre_valeur, tt.parametre_unite AS unite, ct.parametre_source,
             ct.montant_force, ct.motif_montant_force,
             ct.date_debut, ct.date_fin, ct.actif
        FROM app.commerce_taxe ct JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
       WHERE ct.commerce_id = $1 ORDER BY tt.ordre_affichage`, [req.params.commerceId]);
    return ok(res, rows);
  }));

router.post('/commerce/:commerceId',
  valider(z.object({ commerceId: uuid }), 'params'),
  valider(z.object({
    type_taxe_id: uuid,
    parametre_valeur: z.coerce.number().min(0).optional(),
    date_debut: z.coerce.date().optional(),
  })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      INSERT INTO app.commerce_taxe (commune_id, commerce_id, type_taxe_id,
                                     parametre_valeur, parametre_source, date_debut, cree_par)
      VALUES ($1, $2, $3, $4, 'agent',
              COALESCE($5::date, date_trunc('month', current_date)::date), $6)
      RETURNING id, type_taxe_id, parametre_valeur, date_debut`,
    [req.utilisateur.communeId, req.params.commerceId, req.body.type_taxe_id,
      req.body.parametre_valeur ?? null, req.body.date_debut ?? null, req.utilisateur.id]);
    return cree(res, rows[0]);
  }));

/**
 * Montant imposé manuellement.
 * Réservé aux superviseurs, motif obligatoire, tracé au journal d'audit par
 * le déclencheur de la base : une dérogation doit rester exceptionnelle et
 * explicable.
 */
router.patch('/commerce-taxe/:id',
  exigerRole('superviseur'),
  valider(paramsId, 'params'),
  valider(z.object({
    parametre_valeur: z.coerce.number().min(0).optional(),
    montant_force: montantXof.nullable().optional(),
    motif_montant_force: texteCourt(500).optional(),
    actif: z.boolean().optional(),
    date_fin: z.coerce.date().nullable().optional(),
  }).refine((d) => d.montant_force == null || d.motif_montant_force, {
    message: 'Un montant imposé manuellement doit être motivé',
    path: ['motif_montant_force'],
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
      `UPDATE app.commerce_taxe SET ${sets.join(', ')}, modifie_par = $2
        WHERE id = $1 RETURNING *`, valeurs);
    if (!rows[0]) throw erreurs.introuvable('Taxe du commerce');
    return ok(res, rows[0]);
  }));

// ===========================================================================
//  EXONÉRATIONS
// ===========================================================================
router.get('/exonerations',
  valider(z.object({ commerce_id: uuid.optional(), actives: z.coerce.boolean().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const params = [];
    const conditions = [];
    if (req.query.commerce_id) {
      params.push(req.query.commerce_id);
      conditions.push(`e.commerce_id = $${params.length}`);
    }
    if (req.query.actives) conditions.push('e.revoque_le IS NULL AND e.periode @> current_date');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await requete(req.contexte, `
      SELECT e.id, e.commerce_id, c.code AS commerce_code, c.enseigne,
             m.libelle AS motif, tt.libelle_court AS taxe,
             e.taux_pct, e.date_debut, e.date_fin, e.justification,
             e.accorde_le, ua.nom_complet AS accorde_par,
             e.revoque_le, e.motif_revocation
        FROM app.exoneration e
        JOIN app.commerce c ON c.id = e.commerce_id
        JOIN ref.motif_exoneration m ON m.id = e.motif_id
        LEFT JOIN ref.type_taxe tt ON tt.id = e.type_taxe_id
        LEFT JOIN app.utilisateur ua ON ua.id = e.accorde_par
        ${where}
       ORDER BY e.accorde_le DESC LIMIT 500`, params);
    return ok(res, rows);
  }));

router.post('/exonerations',
  // FR-020j : ni l'agent, ni le superviseur, ni l'administrateur. Le chef de
  // projet accorde ; un SECOND chef de projet valide. Tant que la validation
  // manque, l'exonération ne réduit aucun montant (FR-020i).
  exigerRole(['chef_projet']),
  valider(z.object({
    commerce_id: uuid,
    motif_id: uuid,
    type_taxe_id: uuid.nullable().optional(),
    taux_pct: z.coerce.number().min(0.01).max(100).default(100),
    date_debut: z.coerce.date(),
    date_fin: z.coerce.date().nullable().optional(),
    justification: texteCourt(1000),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await requete(req.contexte, `
      INSERT INTO app.exoneration (commune_id, commerce_id, type_taxe_id, motif_id,
                                   taux_pct, date_debut, date_fin, justification, accorde_par)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, taux_pct, date_debut, date_fin`,
    [req.utilisateur.communeId, b.commerce_id, b.type_taxe_id ?? null, b.motif_id,
      b.taux_pct, b.date_debut, b.date_fin ?? null, b.justification, req.utilisateur.id]);

    await requete(req.contexte, 'SELECT app.recalculer_statut_fiscal($1)', [b.commerce_id]);
    return cree(res, rows[0]);
  }));

router.post('/exonerations/:id/revoquer',
  exigerRole(['chef_projet']),
  valider(paramsId, 'params'),
  valider(z.object({ motif: texteCourt(500) })),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.exoneration
         SET revoque_le = now(), revoque_par = $2, motif_revocation = $3
       WHERE id = $1 AND revoque_le IS NULL
       RETURNING id, commerce_id`, [req.params.id, req.utilisateur.id, req.body.motif]);
    if (!rows[0]) throw erreurs.introuvable('Exonération active');

    await requete(req.contexte, 'SELECT app.recalculer_statut_fiscal($1)', [rows[0].commerce_id]);
    return ok(res, rows[0]);
  }));

module.exports = router;
