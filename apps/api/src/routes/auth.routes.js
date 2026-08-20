/**
 * Routes d'authentification — /auth
 */
'use strict';

const express = require('express');
const { z, valider, telephone } = require('../middleware/validation');
const { authentifier } = require('../middleware/auth');
const { limiteConnexion } = require('../middleware/limites');
const { asyncHandler, ok } = require('../utils/reponse');
const { requete } = require('../config/database');
const auth = require('../services/auth.service');

const router = express.Router();

const schemaConnexion = z.object({
  telephone,
  mot_de_passe: z.string().min(1, 'Mot de passe requis').max(200),
  appareil_id: z.string().max(120).optional(),
  appareil_modele: z.string().max(120).optional(),
  version_app: z.string().max(30).optional(),
});

/**
 * Politique de mot de passe.
 * Volontairement modeste en longueur : les agents saisissent au clavier
 * tactile, en extérieur, parfois sous le soleil. On exige de la variété
 * plutôt qu'une longueur décourageante, et le verrouillage après 5 échecs
 * fait le reste du travail.
 */
const motDePasseFort = z.string()
  .min(10, 'Le mot de passe doit faire au moins 10 caractères')
  .max(200)
  .regex(/[a-z]/, 'Il doit contenir au moins une minuscule')
  .regex(/[A-Z]/, 'Il doit contenir au moins une majuscule')
  .regex(/[0-9]/, 'Il doit contenir au moins un chiffre');

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
router.post('/login', limiteConnexion, valider(schemaConnexion), asyncHandler(async (req, res) => {
  const resultat = await auth.connecter({
    telephone: req.body.telephone,
    motDePasse: req.body.mot_de_passe,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    appareilId: req.body.appareil_id,
    appareilModele: req.body.appareil_modele,
    versionApp: req.body.version_app,
  });
  return ok(res, resultat);
}));

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------
router.post('/refresh',
  valider(z.object({ jeton_rafraichissement: z.string().min(20) })),
  asyncHandler(async (req, res) => {
    const resultat = await auth.rafraichir({
      jetonRafraichissement: req.body.jeton_rafraichissement,
      ip: req.ip,
    });
    return ok(res, resultat);
  }));

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
router.post('/logout',
  valider(z.object({ jeton_rafraichissement: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const nb = await auth.deconnecter(req.body.jeton_rafraichissement);
    return ok(res, { sessions_fermees: nb });
  }));

// ---------------------------------------------------------------------------
// GET /auth/moi — profil de l'utilisateur connecté
// ---------------------------------------------------------------------------
router.get('/moi', authentifier, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT u.id, u.matricule, u.nom, u.prenom, u.nom_complet, u.telephone, u.email,
           u.role, u.doit_changer_mdp, u.derniere_connexion, u.derniere_sync,
           u.photo_url, u.appareil_modele, u.version_app,
           c.id AS commune_id, c.slug AS commune_slug, c.nom AS commune_nom,
           c.couleur_principale, c.logo_url
      FROM app.utilisateur u
      LEFT JOIN app.commune c ON c.id = u.commune_id
     WHERE u.id = $1`, [req.utilisateur.id]);

  const profil = rows[0];
  if (!profil) return ok(res, null);

  const { rows: zones } = await requete(req.contexte, `
    SELECT z.id, z.code, z.nom
      FROM app.affectation_agent a JOIN app.zone z ON z.id = a.zone_id
     WHERE a.utilisateur_id = $1 AND a.date_fin IS NULL
     ORDER BY z.ordre`, [req.utilisateur.id]);

  return ok(res, { ...profil, zones_affectees: zones });
}));

// ---------------------------------------------------------------------------
// POST /auth/mot-de-passe — changement par l'utilisateur lui-même
// ---------------------------------------------------------------------------
router.post('/mot-de-passe', authentifier,
  valider(z.object({
    ancien_mot_de_passe: z.string().min(1),
    nouveau_mot_de_passe: motDePasseFort,
  })),
  asyncHandler(async (req, res) => {
    await auth.changerMotDePasse(req.contexte, {
      utilisateurId: req.utilisateur.id,
      ancien: req.body.ancien_mot_de_passe,
      nouveau: req.body.nouveau_mot_de_passe,
    });
    // Les autres sessions ont été coupées : l'appelant doit se reconnecter.
    return ok(res, {
      message: 'Mot de passe modifié. Vos autres appareils ont été déconnectés.',
    });
  }));

// ---------------------------------------------------------------------------
// GET /auth/sessions — appareils connectés
// ---------------------------------------------------------------------------
router.get('/sessions', authentifier, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT id, appareil_modele, appareil_id, ip, cree_le, derniere_activite, expire_le
      FROM app.session
     WHERE utilisateur_id = $1 AND revoque_le IS NULL AND expire_le > now()
     ORDER BY derniere_activite DESC`, [req.utilisateur.id]);
  return ok(res, rows);
}));

// ---------------------------------------------------------------------------
// DELETE /auth/sessions — déconnexion de tous les appareils
// ---------------------------------------------------------------------------
router.delete('/sessions', authentifier, asyncHandler(async (req, res) => {
  const nb = await auth.deconnecterPartout(req.contexte, req.utilisateur.id);
  return ok(res, { sessions_fermees: nb });
}));

module.exports = router;
