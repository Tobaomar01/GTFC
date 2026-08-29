/**
 * Canal USSD entrant — /ussd
 *
 * L'agrégateur relaie chaque composition du code court. Le fil est court et
 * sans mémoire côté opérateur : chaque requête est autonome.
 *
 * Contraintes propres à ce canal :
 *
 *   1. la réponse doit partir VITE — l'opérateur coupe la session au-delà de
 *      quelques secondes ;
 *   2. aucune information n'est communiquée à un numéro non vérifié, et la
 *      réponse est indistinguable de celle servie à un numéro inconnu
 *      (FR-068) : sans cela, composer des numéros au hasard permettrait
 *      d'énumérer les redevables de la commune ;
 *   3. le corps de réponse est du texte brut, non du JSON : c'est ce que les
 *      passerelles USSD attendent.
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const logger = require('../config/logger');
const { asyncHandler } = require('../utils/reponse');
const { valider } = require('../middleware/validation');
const { limiteConnexion } = require('../middleware/limites');
const ussd = require('../services/ussd.service');

const router = express.Router();

const schemaRequete = z.object({
  // Le nom des champs varie d'un agrégateur à l'autre ; on accepte les plus
  // répandus plutôt que d'imposer un format et de casser à l'intégration.
  telephone: z.string().min(6).max(20).optional(),
  msisdn: z.string().min(6).max(20).optional(),
  phoneNumber: z.string().min(6).max(20).optional(),
  saisie: z.string().max(182).optional(),
  text: z.string().max(182).optional(),
  sessionId: z.string().max(120).optional(),
}).refine((d) => d.telephone || d.msisdn || d.phoneNumber,
  { message: 'Numéro appelant absent' });

function normaliser(corps) {
  const brut = corps.telephone ?? corps.msisdn ?? corps.phoneNumber;
  // Format international sans espaces ni séparateurs.
  const telephone = String(brut).replace(/[^\d+]/g, '');
  return { telephone, saisie: corps.saisie ?? corps.text ?? '' };
}

router.post('/',
  limiteConnexion,
  valider(schemaRequete),
  asyncHandler(async (req, res) => {
    const { telephone, saisie } = normaliser(req.body);

    const contexte = { communeId: null, utilisateurId: null };
    const reponse = await ussd.traiter(contexte, { telephone, saisie });

    // Le numéro n'est jamais journalisé en clair : c'est une donnée
    // personnelle, et un fichier de traces est aussi une collecte (FR-051).
    logger.info({ sessionId: req.body.sessionId, reconnu: Boolean(reponse.redevable_id) },
      'requête USSD');

    res.type('text/plain; charset=utf-8');
    // Convention des passerelles : « END » termine la session, « CON » la
    // poursuit. Ici, une seule question, une seule réponse.
    return res.send(`${reponse.fin ? 'END' : 'CON'} ${reponse.texte}`);
  }));

module.exports = router;
