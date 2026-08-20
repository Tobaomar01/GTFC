/**
 * Webhooks entrants — /webhooks
 *
 * Contraintes propres à un webhook, différentes du reste de l'API :
 *
 *   1. le CORPS BRUT est nécessaire au calcul de la signature. Re-sérialiser
 *      le JSON changerait les espaces et invaliderait le HMAC. D'où le
 *      express.raw() posé sur cette seule route ;
 *   2. il faut répondre 2xx VITE, sinon Wave réémet. On accuse réception de
 *      tout ce qui est correctement signé, même si le traitement échoue —
 *      le rejeu ne réparerait rien et saturerait les logs ;
 *   3. aucune limitation de débit : un paiement doit toujours pouvoir entrer.
 */
'use strict';

const express = require('express');
const logger = require('../config/logger');
const config = require('../config/env');
const { asyncHandler } = require('../utils/reponse');
const wave = require('../services/wave.service');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /webhooks/wave
// ---------------------------------------------------------------------------
router.post('/wave',
  express.raw({ type: '*/*', limit: '256kb' }),
  asyncHandler(async (req, res) => {
    const corpsBrut = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    const enteteSignature = req.headers['wave-signature'] || req.headers['x-wave-signature'];

    let verification;
    try {
      verification = wave.verifierSignature({ enteteSignature, corpsBrut });
    } catch (err) {
      logger.error({ err }, 'Webhook Wave : vérification impossible');
      return res.status(500).json({ succes: false, erreur: { code: 'CONFIGURATION' } });
    }

    if (!verification.valide) {
      // 401 et rien d'autre : on ne dit pas POURQUOI la signature est refusée,
      // sinon on aiderait à en forger une valide.
      logger.warn(
        { ip: req.ip, motif: verification.motif, taille: corpsBrut.length },
        'Webhook Wave refusé — signature invalide',
      );
      return res.status(401).json({ succes: false, erreur: { code: 'SIGNATURE_INVALIDE' } });
    }

    let evenement;
    try {
      evenement = JSON.parse(corpsBrut);
    } catch {
      logger.warn({ ip: req.ip }, 'Webhook Wave : corps illisible');
      return res.status(400).json({ succes: false, erreur: { code: 'CORPS_INVALIDE' } });
    }

    try {
      const resultat = await wave.traiterEvenement({
        evenement,
        signatureValide: true,
        corpsBrut,
      });

      logger.info(
        { type: evenement.type, ...resultat },
        'Webhook Wave traité',
      );
      return res.status(200).json({ succes: true, donnees: resultat });
    } catch (err) {
      // Signature valide mais traitement en échec : on accuse quand même
      // réception. Wave rejouerait à l'identique et échouerait pareil ; le
      // problème est de notre côté et doit être traité par un humain.
      logger.error(
        { err, type: evenement?.type, session: evenement?.data?.id },
        'Webhook Wave : échec de traitement — À REPRENDRE MANUELLEMENT',
      );
      return res.status(200).json({
        succes: false,
        erreur: { code: 'TRAITEMENT_DIFFERE', message: 'Reçu, traitement à reprendre' },
      });
    }
  }));

// ---------------------------------------------------------------------------
// GET /webhooks/wave — vérification de configuration
// Permet de contrôler depuis un navigateur que l'URL est bien joignable,
// sans révéler quoi que ce soit d'exploitable.
// ---------------------------------------------------------------------------
router.get('/wave', (_req, res) => res.json({
  succes: true,
  donnees: {
    endpoint: 'actif',
    environnement: config.wave.environnement,
    signature_configuree: Boolean(config.wave.webhookSecret),
    methode_attendue: 'POST',
  },
}));

module.exports = router;
