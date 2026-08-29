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
  agent: 1, superviseur: 2, maire: 2, admin_commune: 3, super_admin: 4,
};

/**
 * Rôles en LECTURE SEULE, sauf exception nommée ci-dessous.
 *
 * Le maire constate la recette de sa commune. Il ne recense pas, n'encaisse
 * pas et ne modifie pas le barème — celui-ci relève d'une délibération du
 * conseil municipal, pas d'un écran.
 *
 * La règle est posée UNE FOIS, au niveau de l'authentification, et non route
 * par route : un garde oublié sur une route neuve rouvrirait la porte en
 * silence, et personne ne s'en apercevrait avant qu'une écriture n'ait eu
 * lieu.
 */
const LECTURE_SEULE = new Set(['maire']);

/** Méthodes qui ne modifient rien. HEAD et OPTIONS relèvent du protocole. */
const METHODES_LECTURE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Les écritures qu'un profil de consultation garde malgré tout.
 *
 * Deux familles, et l'inventaire tient volontairement en quelques lignes :
 * tout ce qui n'y figure pas est refusé, et une route neuve l'est par défaut.
 *
 *   · ce sans quoi le compte est inutilisable — changer son mot de passe,
 *     alors que tous les comptes y sont contraints à la première connexion.
 *     L'oubli de cette ligne enfermait le maire dehors ;
 *   · la VALIDATION d'une décision dérogatoire. Remettre une dette publique
 *     est un acte de la municipalité, pas de l'exploitant technique du
 *     partenariat, à qui la constitution interdit tout droit sur les
 *     échéances (principe III). C'est la seule écriture par laquelle le maire
 *     engage la commune, et elle ne fait jamais que confirmer une décision
 *     préparée par quelqu'un d'autre — la base refuse qu'un même agent
 *     saisisse et valide.
 */
const UUID = '[0-9a-fA-F-]{36}';
const ECRITURES_AUTORISEES = {
  maire: [
    { methode: 'POST', chemin: /^\/auth\/mot-de-passe$/ },
    { methode: 'POST', chemin: new RegExp(`^/derogations/${UUID}/validation$`) },
    { methode: 'POST', chemin: new RegExp(`^/exonerations/${UUID}/validation$`) },
  ],
};

/**
 * Refuse toute écriture aux rôles de consultation, hors exceptions nommées.
 *
 * Appelé depuis `authentifier`, donc sur toute route protégée. Les requêtes
 * anonymes n'y passent pas : ce sont les gardes de chaque route qui les
 * traitent.
 */
function lectureSeule(req, _res, next) {
  const role = req.utilisateur?.role;
  if (!role || !LECTURE_SEULE.has(role)) return next();
  if (METHODES_LECTURE.has(req.method)) return next();

  // `originalUrl` porte le chemin complet : les routeurs sont montés sur « / »
  // et `req.path` serait amputé du préfixe selon le point de montage.
  const chemin = (req.originalUrl || req.url).split('?')[0];
  const permises = ECRITURES_AUTORISEES[role] ?? [];
  if (permises.some((e) => e.methode === req.method && e.chemin.test(chemin))) {
    return next();
  }

  return next(erreurs.accesRefuse(
    'Ce profil est en consultation seule. Les opérations de recensement, '
    + 'd\'encaissement et de paramétrage relèvent des équipes qui en '
    + 'répondent.'));
}

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
