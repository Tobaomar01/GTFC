/**
 * Service d'authentification.
 *
 * Choix de conception :
 *   - le jeton d'ACCÈS est court (15 min) et n'est pas stocké : il se vérifie
 *     par signature, sans aller en base ;
 *   - le jeton de RAFRAÎCHISSEMENT est long (30 j), stocké haché, et à usage
 *     unique — chaque utilisation le remplace. Si un ancien jeton réapparaît,
 *     c'est qu'il a été volé.
 *   - le message d'erreur est identique que le compte existe ou non, pour ne
 *     pas transformer l'API en annuaire des agents.
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const logger = require('../config/logger');
const { requeteSysteme, requete } = require('../config/database');
const { erreurs } = require('../utils/erreurs');
const { signerJetonAcces } = require('../middleware/auth');

/** Le jeton de rafraîchissement n'est jamais stocké en clair. */
const empreinte = (jeton) => crypto.createHash('sha256').update(jeton).digest('hex');

const genererJetonRafraichissement = () => crypto.randomBytes(48).toString('base64url');

function dureeEnMs(duree) {
  const m = String(duree).match(/^(\d+)([smhd])$/);
  if (!m) return 30 * 24 * 3600 * 1000;
  const facteur = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return Number(m[1]) * facteur;
}

async function enregistrerTentative(params) {
  const { rows } = await requeteSysteme(
    `SELECT * FROM app.auth_enregistrer_tentative(
        $1, $2, $3, $4, $5::inet, $6, $7, $8, $9, $10, $11)`,
    [
      params.utilisateurId ?? null,
      params.telephone,
      params.reussie,
      params.motifEchec ?? null,
      params.ip ?? null,
      params.userAgent ?? null,
      params.appareilId ?? null,
      params.appareilModele ?? null,
      params.versionApp ?? null,
      config.securite.tentativesAvantVerrouillage,
      config.securite.dureeVerrouillageMinutes,
    ],
  );
  return rows[0] ?? { verrouille: false, tentatives: 0 };
}

async function creerSession(utilisateurId, infos) {
  const jeton = genererJetonRafraichissement();
  const expireLe = new Date(Date.now() + dureeEnMs(config.jwt.dureeRafraichissement));

  await requeteSysteme(
    'SELECT app.auth_creer_session($1, $2, $3, $4, $5, $6::inet, $7)',
    [
      utilisateurId, empreinte(jeton), expireLe,
      infos.appareilId ?? null, infos.appareilModele ?? null,
      infos.ip ?? null, infos.userAgent ?? null,
    ],
  );

  return { jeton, expireLe };
}

/**
 * Connexion par numéro de téléphone + mot de passe.
 * L'app Android transmet en plus l'identifiant de l'appareil : une connexion
 * depuis un téléphone inhabituel est signalée dans le journal d'audit sans
 * pour autant bloquer l'agent — un téléphone se casse et se remplace.
 */
async function connecter({ telephone, motDePasse, ip, userAgent,
  appareilId, appareilModele, versionApp }) {
  const { rows } = await requeteSysteme(
    'SELECT * FROM app.auth_trouver_utilisateur($1)', [telephone],
  );
  const u = rows[0];

  const contexteTentative = { telephone, ip, userAgent, appareilId, appareilModele, versionApp };

  if (!u) {
    // Comparaison factice : sans elle, une réponse instantanée révélerait
    // qu'aucun compte ne porte ce numéro (attaque temporelle).
    await bcrypt.compare(motDePasse, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    await enregistrerTentative({ ...contexteTentative, reussie: false, motifEchec: 'compte_inconnu' });
    throw erreurs.identifiantsInvalides();
  }

  if (u.verrouille_jusqu_a && new Date(u.verrouille_jusqu_a) > new Date()) {
    const minutes = Math.ceil((new Date(u.verrouille_jusqu_a) - Date.now()) / 60000);
    await enregistrerTentative({
      ...contexteTentative, utilisateurId: u.id, reussie: false, motifEchec: 'compte_verrouille',
    });
    throw erreurs.compteVerrouille(minutes);
  }

  if (!u.actif) {
    await enregistrerTentative({
      ...contexteTentative, utilisateurId: u.id, reussie: false, motifEchec: 'compte_inactif',
    });
    throw erreurs.compteInactif();
  }

  const correspond = await bcrypt.compare(motDePasse, u.mot_de_passe_hash);
  if (!correspond) {
    const suite = await enregistrerTentative({
      ...contexteTentative, utilisateurId: u.id, reussie: false, motifEchec: 'mot_de_passe_invalide',
    });
    if (suite.verrouille) {
      throw erreurs.compteVerrouille(config.securite.dureeVerrouillageMinutes);
    }
    throw erreurs.identifiantsInvalides();
  }

  await enregistrerTentative({ ...contexteTentative, utilisateurId: u.id, reussie: true });

  const session = await creerSession(u.id, { appareilId, appareilModele, ip, userAgent });

  return {
    jeton_acces: signerJetonAcces(u),
    jeton_rafraichissement: session.jeton,
    expire_le: session.expireLe,
    doit_changer_mot_de_passe: u.doit_changer_mdp,
    utilisateur: {
      id: u.id,
      nom_complet: u.nom_complet,
      role: u.role,
      commune_id: u.commune_id,
      commune_slug: u.commune_slug,
      commune_nom: u.commune_nom,
    },
  };
}

/** Rotation du jeton de rafraîchissement. L'ancien est révoqué du même geste. */
async function rafraichir({ jetonRafraichissement, ip }) {
  const ancien = empreinte(jetonRafraichissement);

  const { rows } = await requeteSysteme('SELECT * FROM app.auth_trouver_session($1)', [ancien]);
  const s = rows[0];

  if (!s) throw erreurs.nonAuthentifie('Session inconnue, reconnectez-vous');

  if (s.revoque_le) {
    // Un jeton déjà utilisé qui revient : soit un doublon réseau bénin, soit
    // un vol. Dans le doute on coupe TOUTES les sessions du compte, quitte à
    // demander à l'agent de se reconnecter.
    logger.warn({ utilisateur: s.utilisateur_id, ip },
      'Réutilisation d\'un jeton de rafraîchissement révoqué — sessions coupées');
    await requeteSysteme(
      `UPDATE app.session SET revoque_le = now(), motif_revocation = 'reutilisation_suspecte'
        WHERE utilisateur_id = $1 AND revoque_le IS NULL`,
      [s.utilisateur_id],
    ).catch(() => {});
    throw erreurs.nonAuthentifie('Session invalidée pour raison de sécurité, reconnectez-vous');
  }

  if (new Date(s.expire_le) < new Date()) {
    throw erreurs.nonAuthentifie('Session expirée, reconnectez-vous');
  }
  if (!s.actif) throw erreurs.compteInactif();

  const nouveau = genererJetonRafraichissement();
  const expireLe = new Date(Date.now() + dureeEnMs(config.jwt.dureeRafraichissement));

  const { rows: r } = await requeteSysteme(
    'SELECT app.auth_rafraichir_session($1, $2, $3, $4::inet) AS id',
    [ancien, empreinte(nouveau), expireLe, ip ?? null],
  );
  if (!r[0]?.id) throw erreurs.nonAuthentifie('Session invalide, reconnectez-vous');

  return {
    jeton_acces: signerJetonAcces({
      id: s.utilisateur_id,
      role: s.role,
      commune_id: s.commune_id,
      nom_complet: s.nom_complet,
    }),
    jeton_rafraichissement: nouveau,
    expire_le: expireLe,
    doit_changer_mot_de_passe: s.doit_changer_mdp,
  };
}

async function deconnecter(jetonRafraichissement) {
  if (!jetonRafraichissement) return 0;
  const { rows } = await requeteSysteme(
    'SELECT app.auth_revoquer_session($1, $2) AS nb',
    [empreinte(jetonRafraichissement), 'deconnexion'],
  );
  return rows[0]?.nb ?? 0;
}

/** Déconnecte l'utilisateur de tous ses appareils. */
async function deconnecterPartout(contexte, utilisateurId) {
  const { rowCount } = await requete(contexte,
    `UPDATE app.session SET revoque_le = now(), motif_revocation = 'deconnexion_globale'
      WHERE utilisateur_id = $1 AND revoque_le IS NULL`,
    [utilisateurId]);
  return rowCount;
}

async function changerMotDePasse(contexte, { utilisateurId, ancien, nouveau }) {
  const { rows } = await requete(contexte,
    'SELECT mot_de_passe_hash FROM app.utilisateur WHERE id = $1', [utilisateurId]);
  if (!rows[0]) throw erreurs.introuvable('Compte');

  const correspond = await bcrypt.compare(ancien, rows[0].mot_de_passe_hash);
  if (!correspond) throw erreurs.requeteInvalide('Ancien mot de passe incorrect');

  if (await bcrypt.compare(nouveau, rows[0].mot_de_passe_hash)) {
    throw erreurs.requeteInvalide('Le nouveau mot de passe doit être différent de l\'ancien');
  }

  const hash = await bcrypt.hash(nouveau, config.securite.coutBcrypt);
  await requete(contexte,
    `UPDATE app.utilisateur
        SET mot_de_passe_hash = $2, mot_de_passe_change_le = now(),
            doit_changer_mdp = false, modifie_par = $1
      WHERE id = $1`,
    [utilisateurId, hash]);

  // Changer de mot de passe coupe les autres sessions : si le compte était
  // compromis, l'intrus perd son accès immédiatement.
  await deconnecterPartout(contexte, utilisateurId);

  return true;
}

module.exports = {
  connecter,
  rafraichir,
  deconnecter,
  deconnecterPartout,
  changerMotDePasse,
  empreinte,
  hacherMotDePasse: (mdp) => bcrypt.hash(mdp, config.securite.coutBcrypt),
};
