/**
 * Authentification et autorisation.
 *
 * Le jeton d'accès porte l'identité ET la commune. C'est le serveur qui
 * décide de la commune, à partir du compte — jamais le client, et jamais le
 * sous-domaine. Un agent de GTFC qui appellerait l'API depuis
 * `parcelles.domaine.sn` resterait cantonné à GTFC.
 */
'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { erreurs } = require('../utils/erreurs');

const ROLES = ['agent', 'superviseur', 'admin_commune', 'super_admin'];

/** Hiérarchie : un rôle donne accès à ce que peuvent les rôles au-dessous. */
const NIVEAU = { agent: 1, superviseur: 2, admin_commune: 3, super_admin: 4 };

/**
 * Rôles délibérément HORS de la hiérarchie.
 *
 * Un chef de projet n'est pas « un administrateur en plus fort » : il détient
 * les décisions dérogatoires — montant forcé, exonération — que personne
 * d'autre n'a, et n'a pas la main sur le barème, que l'administrateur
 * détient. Les ranger sur une échelle serait faux, et c'est ainsi qu'un
 * super-administrateur finit par tout pouvoir (Constitution III).
 *
 * Ils s'exigent donc par liste exacte, jamais par niveau.
 */
const HORS_HIERARCHIE = new Set(['chef_projet']);

function signerJetonAcces(utilisateur) {
  return jwt.sign(
    {
      sub: utilisateur.id,
      role: utilisateur.role,
      cid: utilisateur.commune_id ?? null,
      nom: utilisateur.nom_complet,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.dureeAcces, issuer: config.jwt.emetteur },
  );
}

function verifierJeton(jeton) {
  return jwt.verify(jeton, config.jwt.secret, { issuer: config.jwt.emetteur });
}

function extraireJeton(req) {
  const entete = req.headers.authorization || '';
  if (entete.startsWith('Bearer ')) return entete.slice(7).trim();
  return null;
}

/**
 * Exige un jeton valide. Alimente `req.utilisateur` et `req.contexte`,
 * ce dernier étant transmis tel quel aux fonctions d'accès à la base :
 * c'est lui qui active l'isolation multi-communes et le journal d'audit.
 */
function authentifier(req, _res, next) {
  const jeton = extraireJeton(req);
  if (!jeton) return next(erreurs.nonAuthentifie());

  let charge;
  try {
    charge = verifierJeton(jeton);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(erreurs.nonAuthentifie('Session expirée, reconnectez-vous'));
    }
    return next(erreurs.nonAuthentifie('Jeton invalide'));
  }

  req.utilisateur = {
    id: charge.sub,
    role: charge.role,
    communeId: charge.cid,
    nom: charge.nom,
  };

  req.contexte = {
    utilisateurId: charge.sub,
    communeId: charge.cid,
    superAdmin: charge.role === 'super_admin',
    ip: req.ip,
  };

  return next();
}

/** N'exige rien, mais renseigne l'utilisateur s'il est présent. */
function authentifierSiPossible(req, res, next) {
  if (!extraireJeton(req)) {
    req.contexte = { ip: req.ip };
    return next();
  }
  return authentifier(req, res, next);
}

/**
 * Restreint l'accès à une liste de rôles.
 *   exigerRole('admin_commune')            -> admin_commune et super_admin
 *   exigerRole(['agent', 'superviseur'])   -> exactement ces deux rôles
 */
function exigerRole(rolesAutorises) {
  const liste = Array.isArray(rolesAutorises) ? rolesAutorises : [rolesAutorises];
  const parNiveau = !Array.isArray(rolesAutorises);

  // Échec au démarrage plutôt qu'un refus silencieux à la première requête :
  // un rôle hors hiérarchie exigé par niveau donnerait NIVEAU[x] === undefined,
  // donc une comparaison toujours fausse, sans que rien ne le signale.
  if (parNiveau) {
    if (HORS_HIERARCHIE.has(liste[0])) {
      throw new Error(
        `Le rôle « ${liste[0]} » est hors hiérarchie : l'exiger par niveau `
        + `refuserait tout le monde. Utiliser exigerRole(['${liste[0]}']).`);
    }
    if (NIVEAU[liste[0]] === undefined) {
      throw new Error(`Rôle inconnu dans la hiérarchie : ${liste[0]}`);
    }
  }

  const niveauMinimum = parNiveau ? NIVEAU[liste[0]] : null;

  return (req, _res, next) => {
    if (!req.utilisateur) return next(erreurs.nonAuthentifie());

    const autorise = parNiveau
      ? NIVEAU[req.utilisateur.role] >= niveauMinimum
      : liste.includes(req.utilisateur.role);

    if (!autorise) {
      return next(erreurs.accesRefuse(
        `Action réservée aux profils : ${liste.join(', ')}`));
    }
    return next();
  };
}

/**
 * Réserve une route au super-admin.
 * Utilisé pour la gestion des communes : créer une nouvelle mairie n'est
 * pas une opération de mairie.
 */
const exigerSuperAdmin = exigerRole(['super_admin']);

/**
 * Décisions dérogatoires : montant forcé et exonération, les deux façons
 * d'effacer une dette (FR-020e, FR-020j). Liste exacte : ni l'administrateur
 * ni le super-administrateur n'en héritent.
 */
const exigerChefProjet = exigerRole(['chef_projet']);

/**
 * Vérifie qu'un utilisateur rattaché à une commune en a bien une.
 * Sans cela, un compte mal créé passerait le RLS avec un commune_id nul et
 * ne verrait rien, sans message explicite.
 */
function exigerCommune(req, _res, next) {
  if (!req.utilisateur) return next(erreurs.nonAuthentifie());
  if (req.utilisateur.role === 'super_admin') {
    // Le super-admin doit désigner explicitement la commune sur laquelle il
    // agit, via l'en-tête X-Commune-Id ou le paramètre ?commune_id=
    const cible = req.headers['x-commune-id'] || req.query.commune_id;
    if (cible) {
      req.contexte.communeId = String(cible);
      req.utilisateur.communeId = String(cible);
    }
    return next();
  }
  if (!req.utilisateur.communeId) {
    return next(erreurs.accesRefuse('Votre compte n\'est rattaché à aucune commune'));
  }
  return next();
}

module.exports = {
  ROLES,
  NIVEAU,
  signerJetonAcces,
  verifierJeton,
  authentifier,
  authentifierSiPossible,
  exigerRole,
  exigerSuperAdmin,
  exigerCommune,
  exigerChefProjet,
};
