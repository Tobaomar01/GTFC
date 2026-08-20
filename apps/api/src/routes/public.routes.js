/**
 * Routes publiques — aucune authentification requise.
 *
 * Ces trois routes sont les seules ouvertes sur l'extérieur sans JWT. Elles
 * n'exposent que le strict minimum, via des fonctions SQL dédiées
 * (migration 0017) : ni nom de gérant, ni numéro de téléphone, ni montant dû.
 *
 * Raison d'être : un sticker QR collé sur une devanture est scanné par
 * n'importe qui avec l'appareil photo de son téléphone. La page doit
 * fonctionner sans application ni compte, sinon le QR ne sert qu'aux agents.
 */
'use strict';

const express = require('express');
const { requeteSysteme } = require('../config/database');
const { limitePublic } = require('../middleware/limites');
const { z, valider } = require('../middleware/validation');
const { asyncHandler, ok } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');

const router = express.Router();
router.use(limitePublic);

const jetonQr = z.string().regex(/^[A-Z0-9]{10,32}$/, 'Jeton invalide');

// ---------------------------------------------------------------------------
// GET /public/commune/:slug — identité de la mairie, pour l'écran de connexion
// ---------------------------------------------------------------------------
router.get('/commune/:slug',
  valider(z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'Sous-domaine invalide'),
  }), 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requeteSysteme(
      'SELECT * FROM app.public_commune_par_slug($1)', [req.params.slug]);
    if (!rows[0]) throw erreurs.introuvable('Commune');
    return ok(res, rows[0]);
  }));

// ---------------------------------------------------------------------------
// GET /public/c/:jeton — scan d'un QR code
//
// Renvoie de quoi confirmer qu'un commerce est bien enregistré auprès de la
// commune. Aucune donnée fiscale : ni montant, ni statut de paiement, ni
// identité du gérant. Un passant ne doit pas pouvoir savoir qui est en retard
// de paiement en scannant les devantures d'une rue.
// ---------------------------------------------------------------------------
router.get('/c/:jeton',
  valider(z.object({ jeton: jetonQr }), 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requeteSysteme(
      'SELECT * FROM app.public_commerce_par_qr($1, $2::inet, $3)',
      [req.params.jeton, req.ip, req.headers['user-agent'] ?? null]);

    if (!rows[0]) {
      throw erreurs.introuvable('Ce QR code ne correspond à aucun commerce enregistré');
    }
    if (!rows[0].qr_actif) {
      return ok(res, {
        ...rows[0],
        avertissement: 'Ce sticker a été remplacé. Demandez le sticker à jour à votre agent.',
      });
    }
    return ok(res, rows[0]);
  }));

// ---------------------------------------------------------------------------
// GET /public/quittance/:jeton — vérification d'une quittance papier
// ---------------------------------------------------------------------------
router.get('/quittance/:jeton',
  valider(z.object({ jeton: jetonQr }), 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requeteSysteme(
      'SELECT * FROM app.public_verifier_quittance($1)', [req.params.jeton]);

    if (!rows[0]) {
      // Réponse explicite plutôt qu'un 404 muet : c'est le cas d'usage même
      // de cette route — prouver qu'une quittance a été fabriquée.
      return ok(res, {
        valide: false,
        message: 'Aucune quittance ne correspond à ce code. Ce document n\'a pas été '
          + 'émis par la commune.',
      });
    }
    return ok(res, rows[0]);
  }));

module.exports = router;
