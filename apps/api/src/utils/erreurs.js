/**
 * Erreurs applicatives.
 *
 * Règle de conduite : le message renvoyé au client est en français, court, et
 * utilisable tel quel dans l'app Android. Le détail technique reste dans les
 * logs. Un agent sur le terrain doit comprendre ce qui bloque sans appeler
 * l'informaticien.
 */
'use strict';

class ErreurApi extends Error {
  constructor(statut, code, message, details = null) {
    super(message);
    this.name = 'ErreurApi';
    this.statut = statut;
    this.code = code;
    this.details = details;
    this.attendue = true;   // distingue des bugs : ne déclenche pas d'alerte
  }
}

const erreurs = {
  requeteInvalide: (message = 'Requête invalide', details = null) =>
    new ErreurApi(400, 'REQUETE_INVALIDE', message, details),

  nonAuthentifie: (message = 'Authentification requise') =>
    new ErreurApi(401, 'NON_AUTHENTIFIE', message),

  identifiantsInvalides: () =>
    // Volontairement identique que le compte existe ou non : sinon l'API
    // permettrait d'énumérer les numéros de téléphone des agents.
    new ErreurApi(401, 'IDENTIFIANTS_INVALIDES', 'Numéro de téléphone ou mot de passe incorrect'),

  compteVerrouille: (minutes) =>
    new ErreurApi(423, 'COMPTE_VERROUILLE',
      `Compte temporairement verrouillé après plusieurs tentatives. Réessayez dans ${minutes} minutes.`),

  compteInactif: () =>
    new ErreurApi(403, 'COMPTE_INACTIF', 'Ce compte a été désactivé. Contactez votre superviseur.'),

  motDePasseAChanger: () =>
    new ErreurApi(403, 'MOT_DE_PASSE_A_CHANGER',
      'Vous devez changer votre mot de passe avant de continuer'),

  accesRefuse: (message = 'Vous n\'avez pas les droits nécessaires pour cette action') =>
    new ErreurApi(403, 'ACCES_REFUSE', message),

  introuvable: (quoi = 'Ressource') =>
    new ErreurApi(404, 'INTROUVABLE', `${quoi} introuvable`),

  conflit: (message, details = null) =>
    new ErreurApi(409, 'CONFLIT', message, details),

  conflitSync: (details) =>
    new ErreurApi(409, 'CONFLIT_SYNCHRONISATION',
      'Cette fiche a été modifiée sur le serveur depuis votre dernière synchronisation',
      details),

  tropVolumineux: (message = 'Fichier trop volumineux') =>
    new ErreurApi(413, 'TROP_VOLUMINEUX', message),

  tropDeRequetes: (message = 'Trop de requêtes, veuillez patienter') =>
    new ErreurApi(429, 'TROP_DE_REQUETES', message),

  interne: (message = 'Erreur interne du serveur') =>
    new ErreurApi(500, 'ERREUR_INTERNE', message),

  serviceIndisponible: (service) =>
    new ErreurApi(503, 'SERVICE_INDISPONIBLE', `Le service ${service} est momentanément indisponible`),
};

/**
 * Traduit une erreur PostgreSQL en erreur métier compréhensible.
 * Les contraintes de la phase 2 portent des noms explicites : on s'en sert
 * pour renvoyer un message utile plutôt qu'un « erreur 500 » opaque.
 */
function depuisErreurPostgres(err) {
  const contrainte = err.constraint || '';

  switch (err.code) {
    case '23505': // unique_violation
      if (contrainte.includes('avis_unique_par_periode')) {
        return erreurs.conflit('Un avis a déjà été émis pour ce commerce sur cette période');
      }
      if (contrainte.includes('commerce_code_unique')) {
        return erreurs.conflit('Ce code de commerce est déjà utilisé');
      }
      if (contrainte.includes('telephone')) {
        return erreurs.conflit('Ce numéro de téléphone est déjà associé à un compte');
      }
      if (contrainte.includes('qr_actif_unique')) {
        return erreurs.conflit('Ce commerce possède déjà un QR code actif');
      }
      return erreurs.conflit('Cet enregistrement existe déjà', { contrainte });

    case '23514': // check_violation
      if (contrainte.includes('moyen_wave_seulement')) {
        return erreurs.requeteInvalide(
          'Wave est le seul moyen de paiement accepté.');
      }
      if (contrainte.includes('double_verification')) {
        return erreurs.conflit(
          "Une décision dérogatoire doit être validée par une personne distincte de son auteur.");
      }
      if (contrainte.includes('pas_de_surpaiement')) {
        return erreurs.requeteInvalide('Le montant payé dépasse le montant dû');
      }
      if (contrainte.includes('archivage_coherent')) {
        return erreurs.requeteInvalide('Un archivage doit être motivé');
      }
      return erreurs.requeteInvalide('Donnée refusée par une règle de gestion', { contrainte });

    case '23503': // foreign_key_violation
      return erreurs.requeteInvalide(
        'Référence inexistante : vérifiez la zone, le quartier ou la catégorie', { contrainte });

    case '23P01': // exclusion_violation
      if (contrainte.includes('bareme_pas_de_chevauchement')) {
        return erreurs.conflit(
          'Un barème est déjà en vigueur pour cette taxe sur cette période. '
          + 'Clôturez-le (date_fin) avant d\'en créer un nouveau.');
      }
      if (contrainte.includes('commerce_taxe_pas_de_doublon')) {
        return erreurs.conflit('Cette taxe est déjà appliquée à ce commerce sur cette période');
      }
      return erreurs.conflit('Chevauchement de périodes', { contrainte });

    case '42501': // insufficient_privilege
      // Levée notamment par le déclencheur d'inaltérabilité du journal d'audit
      return erreurs.accesRefuse(err.message);

    case '57014': // query_canceled (statement_timeout)
      return new ErreurApi(504, 'DELAI_DEPASSE',
        'La requête a pris trop de temps. Affinez vos filtres.');

    default:
      return null;
  }
}

module.exports = { ErreurApi, erreurs, depuisErreurPostgres };
