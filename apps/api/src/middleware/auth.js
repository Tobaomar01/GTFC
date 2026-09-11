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

// Tous les rôles existants. `chef_projet` en fait partie même s'il n'apparaît
// pas dans NIVEAU : il est hors hiérarchie, non inexistant. L'omettre ici a
// rendu le rôle incréable — la base l'acceptait, les écrans l'attendaient, et
// aucun chemin ne permettait d'ouvrir le compte.
const ROLES = ['agent', 'superviseur', 'admin_commune', 'super_admin',
  'chef_projet', 'maire'];

/**
 * Hiérarchie : un rôle donne accès à ce que peuvent les rôles au-dessous.
 *
 * Le maire y figure au niveau du superviseur, ce qui lui ouvre tous les
 * écrans de consultation de sa commune. Ce n'est PAS une équivalence de
 * pouvoir : ce qu'il peut écrire est fermé plus loin, par `lectureSeule`.
 * Deux mécanismes distincts pour deux questions distinctes — que peut-il
 * voir, que peut-il faire.
 */
const NIVEAU = {
  agent: 1, superviseur: 2, maire: 2, admin_commune: 3,
  super_admin: 4, chef_projet: 4,
};

/**
 * Profils qui LISENT tout et n'écrivent que des actes nommés.
 *
 * Deux profils, pour deux raisons différentes.
 *
 * Le MAIRE constate la recette de sa commune. Il ne recense pas, n'encaisse
 * pas et ne touche pas au barème — celui-ci relève d'une délibération du
 * conseil municipal, pas d'un écran.
 *
 * Le CHEF DE PROJET, côté exploitant, voit tout : il conduit le déploiement et
 * ne peut pas soutenir un dispositif dont les écrans lui sont fermés. Mais la
 * constitution interdit au personnel de l'exploitant technique du partenariat
 * TOUT droit sur les échéances et sur le barème (principe III). Il instruit et
 * saisit ; il ne fixe pas la dette et ne la solde pas.
 *
 * La règle est posée UNE FOIS, dans l'authentification, et non route par
 * route : un garde oublié sur une route neuve rouvrirait la porte en silence.
 * Et c'est une liste d'autorisations, non d'interdictions — une route qui
 * n'y figure pas est refusée, y compris celles qui n'existent pas encore.
 */
const PROFILS_CONSULTATION = new Set(['maire', 'chef_projet']);

/** Méthodes qui ne modifient rien. HEAD et OPTIONS relèvent du protocole. */
const METHODES_LECTURE = new Set(['GET', 'HEAD', 'OPTIONS']);

const UUID = '[0-9a-fA-F-]{36}';

/**
 * Les écritures que chaque profil de consultation garde.
 *
 * L'inventaire tient volontairement en quelques lignes. Tout ce qui n'y
 * figure pas est refusé.
 */
const ECRITURES_AUTORISEES = {
  // Le maire ne signe qu'une chose : la remise d'une dette publique, qui est
  // un acte de la commune. Elle confirme toujours une décision préparée par
  // quelqu'un d'autre — la base refuse qu'un même agent saisisse et valide.
  maire: [
    { methode: 'POST', chemin: /^\/auth\/mot-de-passe$/ },
    { methode: 'POST', chemin: new RegExp(`^/derogations/${UUID}/validation$`) },
    { methode: 'POST', chemin: new RegExp(`^/exonerations/${UUID}/validation$`) },
  ],

  // Le chef de projet instruit et saisit les décisions dérogatoires. Aucune
  // n'a d'effet tant que la municipalité ne l'a pas validée : la saisie ne
  // touche donc pas aux échéances, elle prépare une décision.
  chef_projet: [
    { methode: 'POST', chemin: /^\/auth\/mot-de-passe$/ },
    { methode: 'POST', chemin: /^\/derogations\/montant-force$/ },
    { methode: 'POST', chemin: /^\/exonerations$/ },
    { methode: 'POST', chemin: new RegExp(`^/exonerations/${UUID}/revoquer$`) },
  ],
};

/**
 * Refuse les écritures non nommées aux profils de consultation.
 *
 * Appelé depuis `authentifier`, donc sur toute route protégée. Les requêtes
 * anonymes n'y passent pas : ce sont les gardes de chaque route qui les
 * traitent.
 */
function lectureSeule(req, _res, next) {
  const role = req.utilisateur?.role;
  if (!role || !PROFILS_CONSULTATION.has(role)) return next();
  if (METHODES_LECTURE.has(req.method)) return next();

  // `originalUrl` porte le chemin complet : les routeurs sont montés sur « / »
  // et `req.path` serait amputé du préfixe selon le point de montage.
  const chemin = (req.originalUrl || req.url).split('?')[0];
  const permises = ECRITURES_AUTORISEES[role] ?? [];
  if (permises.some((e) => e.methode === req.method && e.chemin.test(chemin))) {
    return next();
  }

  return next(erreurs.accesRefuse(
    role === 'chef_projet'
      ? 'Ce profil consulte l\'ensemble du dispositif mais n\'écrit ni le '
        + 'barème ni les échéances : la commune en répond seule.'
      : 'Ce profil est en consultation seule. Les opérations de recensement, '
        + 'd\'encaissement et de paramétrage relèvent des équipes qui en '
        + 'répondent.'));
}

/**
 * Rôles qu'on n'exige JAMAIS par niveau.
 *
 * Le chef de projet figure dans NIVEAU au rang le plus haut, parce qu'il voit
 * l'ensemble du dispositif. Mais exiger « au moins chef de projet » n'aurait
 * aucun sens : ce serait exiger le rang, donc admettre aussi le
 * super-administrateur, à qui les décisions dérogatoires n'appartiennent pas.
 *
 * Le rang dit ce qu'on VOIT, la liste exacte dit ce qu'on PEUT. Confondre les
 * deux est la façon ordinaire dont un administrateur finit par tout pouvoir
 * (Constitution III).
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
    // Le RÔLE, et pas seulement « est-il super-admin ». Sans lui, un service ne
    // peut pas savoir s'il a affaire à un agent, et tente des opérations que la
    // base refusera — ce qui a coûté un 500 sur /sync/paquet le 11/09/2026.
    role: charge.role,
    superAdmin: charge.role === 'super_admin',
    ip: req.ip,
  };

  // La lecture seule est vérifiée ICI, à l'intérieur de l'authentification,
  // et non montée séparément : toute route protégée passe par cette fonction,
  // donc aucune ne peut échapper à la règle. Un intergiciel distinct
  // s'oublierait sur la prochaine route écrite.
  return lectureSeule(req, _res, next);
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
 * Réserve une route au maire.
 *
 * Peu utile en l'état — le maire consulte ce que voit le superviseur — mais
 * nommé ici pour que l'intention soit disponible le jour où une décision lui
 * reviendra en propre.
 */
const exigerMaire = exigerRole(['maire']);

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
  lectureSeule,
  exigerMaire,
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
