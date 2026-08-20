/**
 * Validation des entrées (zod).
 *
 * Tout ce qui vient du réseau est validé AVANT d'atteindre la base : une
 * surface TODP négative ou des coordonnées inversées doivent être rejetées
 * ici, avec un message que l'agent comprend, plutôt que de remonter sous
 * forme d'erreur de contrainte SQL.
 */
'use strict';

const { z } = require('zod');
const { erreurs } = require('../utils/erreurs');

/** Fabrique un middleware validant une partie de la requête. */
function valider(schema, source = 'body') {
  return (req, _res, next) => {
    const resultat = schema.safeParse(req[source]);
    if (!resultat.success) {
      const details = resultat.error.issues.map((i) => ({
        champ: i.path.join('.') || source,
        message: i.message,
      }));
      return next(erreurs.requeteInvalide('Données invalides', details));
    }
    // On remplace par la version validée : les valeurs sont typées et les
    // champs inconnus ont disparu.
    req[source] = resultat.data;
    return next();
  };
}

// ---------------------------------------------------------------------------
// Briques réutilisables
// ---------------------------------------------------------------------------
const uuid = z.string().uuid('Identifiant invalide');

const telephone = z.string()
  .trim()
  .regex(/^\+?[0-9]{8,15}$/, 'Numéro de téléphone invalide (8 à 15 chiffres)');

/**
 * Coordonnées GPS.
 * Bornes volontairement resserrées sur le Sénégal : c'est le garde-fou le
 * plus efficace contre l'inversion latitude/longitude, l'erreur la plus
 * fréquente et la plus difficile à repérer après coup.
 */
const longitude = z.coerce.number()
  .min(-180).max(180)
  .refine((v) => v >= -18 && v <= -11,
    'Longitude hors du Sénégal — vérifiez que latitude et longitude ne sont pas inversées');

const latitude = z.coerce.number()
  .min(-90).max(90)
  .refine((v) => v >= 12 && v <= 17,
    'Latitude hors du Sénégal — vérifiez que latitude et longitude ne sont pas inversées');

const position = z.object({
  longitude,
  latitude,
  precision_gps_m: z.coerce.number().min(0).max(10000).optional(),
});

const surface = z.coerce.number().min(0).max(10000, 'Surface irréaliste (plus de 10 000 m²)');

const montantXof = z.coerce.number().int('Le franc CFA ne se divise pas en centimes').min(0);

const texteCourt = (max = 200) => z.string().trim().min(1).max(max);

const pagination = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limite: z.coerce.number().int().min(1).max(500).optional(),
  tri: z.string().optional(),
  sens: z.enum(['asc', 'desc']).optional(),
  q: z.string().trim().max(120).optional(),
});

const paramsId = z.object({ id: uuid });

module.exports = {
  z,
  valider,
  uuid,
  telephone,
  longitude,
  latitude,
  position,
  surface,
  montantXof,
  texteCourt,
  pagination,
  paramsId,
};
