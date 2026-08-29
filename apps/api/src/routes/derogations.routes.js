/**
 * Décisions dérogatoires — /derogations
 *
 * Montant forcé et exonération sont les deux façons d'effacer une dette.
 * Elles partagent donc le même registre et la même règle : deux chefs de
 * projet distincts, l'un qui saisit, l'autre qui valide (Constitution III,
 * FR-020c à FR-020e, FR-020j, FR-020k).
 *
 * Tant que la validation manque, la décision n'a AUCUN effet sur les
 * montants : le calcul n'interroge que les vues v_montant_force_opposable et
 * v_exoneration_opposable, qui excluent les décisions non validées.
 *
 * La base refuse déjà qu'un auteur valide sa propre décision. On le vérifie
 * ici aussi, pour rendre le message compréhensible plutôt que de laisser
 * remonter une violation de contrainte.
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const { requete } = require('../config/database');
const { erreurs } = require('../utils/erreurs');
const { ok, cree, asyncHandler } = require('../utils/reponse');
const { valider, paramsId, uuid, texteCourt, montantXof } = require('../middleware/validation');
const { exigerChefProjet } = require('../middleware/auth');
const { limiteEcriture } = require('../middleware/limites');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /derogations — le registre, réservé aux chefs de projet (FR-020k)
// ---------------------------------------------------------------------------
router.get('/derogations',
  exigerChefProjet,
  valider(z.object({
    depuis: z.coerce.date().optional(),
    jusqua: z.coerce.date().optional(),
    nature: z.enum(['montant_force', 'exoneration']).optional(),
    en_attente: z.coerce.boolean().optional(),
  }), 'query'),
  asyncHandler(async (req, res) => {
    const p = req.query;
    const { rows } = await requete(req.contexte, `
      SELECT d.id, d.nature, d.commerce_id, c.code AS commerce_code, c.enseigne,
             d.montant_calcule, d.montant_retenu, d.taux_exoneration_pct,
             d.motif,
             d.saisi_par, us.nom_complet AS saisi_par_nom, d.saisi_le,
             d.valide_par, uv.nom_complet AS valide_par_nom, d.valide_le,
             (d.valide_par IS NOT NULL) AS opposable
        FROM app.decision_derogatoire d
        LEFT JOIN app.commerce c    ON c.id = d.commerce_id
        LEFT JOIN app.utilisateur us ON us.id = d.saisi_par
        LEFT JOIN app.utilisateur uv ON uv.id = d.valide_par
       WHERE ($1::date      IS NULL OR d.saisi_le >= $1)
         AND ($2::date      IS NULL OR d.saisi_le <  $2)
         AND ($3::text      IS NULL OR d.nature = $3)
         AND ($4::boolean   IS NULL OR (d.valide_par IS NULL) = $4)
       ORDER BY d.saisi_le DESC
       LIMIT 500`,
    [p.depuis ?? null, p.jusqua ?? null, p.nature ?? null,
      p.en_attente === undefined ? null : p.en_attente]);

    const enAttente = rows.filter((r) => !r.opposable).length;
    return ok(res, { decisions: rows, total: rows.length, en_attente: enAttente });
  }));

// ---------------------------------------------------------------------------
// POST /derogations/montant-force — saisie, sans effet avant validation
// ---------------------------------------------------------------------------
router.post('/derogations/montant-force',
  limiteEcriture,
  exigerChefProjet,
  valider(z.object({
    commerce_id: uuid,
    commerce_taxe_id: uuid,
    montant_calcule: montantXof,
    montant_retenu: montantXof,
    motif: texteCourt(500),
  })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.motif.trim()) {
      throw erreurs.requeteInvalide('Un montant forcé exige un motif écrit.');
    }

    const { rows } = await requete(req.contexte, `
      INSERT INTO app.decision_derogatoire
        (commune_id, nature, commerce_id, commerce_taxe_id,
         montant_calcule, montant_retenu, motif, saisi_par)
      VALUES ($1, 'montant_force', $2, $3, $4, $5, $6, $7)
      RETURNING id, saisi_le`,
    [req.utilisateur.communeId, b.commerce_id, b.commerce_taxe_id,
      b.montant_calcule, b.montant_retenu, b.motif, req.utilisateur.id]);

    return cree(res, {
      ...rows[0],
      opposable: false,
      message: "Enregistré. Sans validation par un second chef de projet, "
             + "ce montant ne modifie aucune liquidation.",
    });
  }));

// ---------------------------------------------------------------------------
// POST /derogations/:id/validation — par une personne DISTINCTE de l'auteur
// ---------------------------------------------------------------------------
router.post('/derogations/:id/validation',
  limiteEcriture,
  exigerChefProjet,
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows: existantes } = await requete(req.contexte,
      'SELECT id, nature, saisi_par, valide_par FROM app.decision_derogatoire WHERE id = $1',
      [req.params.id]);
    const d = existantes[0];
    if (!d) throw erreurs.introuvable('Décision dérogatoire');

    if (d.valide_par) {
      return ok(res, { id: d.id, opposable: true, deja_validee: true });
    }
    if (d.saisi_par === req.utilisateur.id) {
      throw erreurs.conflit(
        "Vous avez saisi cette décision : elle doit être validée par un autre chef de projet.");
    }

    const { rows } = await requete(req.contexte, `
      UPDATE app.decision_derogatoire
         SET valide_par = $1, valide_le = now()
       WHERE id = $2
       RETURNING id, nature, valide_le`,
    [req.utilisateur.id, req.params.id]);

    return ok(res, { ...rows[0], opposable: true });
  }));

// ---------------------------------------------------------------------------
// POST /exonerations/:id/validation — même règle (FR-020i)
// ---------------------------------------------------------------------------
router.post('/exonerations/:id/validation',
  limiteEcriture,
  exigerChefProjet,
  valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows: existantes } = await requete(req.contexte,
      'SELECT id, commerce_id, accorde_par, valide_par FROM app.exoneration WHERE id = $1',
      [req.params.id]);
    const e = existantes[0];
    if (!e) throw erreurs.introuvable('Exonération');

    if (e.valide_par) return ok(res, { id: e.id, opposable: true, deja_validee: true });
    if (e.accorde_par === req.utilisateur.id) {
      throw erreurs.conflit(
        "Vous avez accordé cette exonération : elle doit être validée par un autre chef de projet.");
    }

    const { rows } = await requete(req.contexte, `
      UPDATE app.exoneration
         SET valide_par = $1, valide_le = now()
       WHERE id = $2
       RETURNING id, taux_pct, valide_le`,
    [req.utilisateur.id, req.params.id]);

    // Le statut fiscal dépend des montants dus : l'exonération devenant
    // opposable, il faut le recalculer.
    await requete(req.contexte, 'SELECT app.recalculer_statut_fiscal($1)', [e.commerce_id]);

    return ok(res, { ...rows[0], opposable: true });
  }));

module.exports = router;
