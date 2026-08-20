/**
 * Codes à usage unique — émission et vérification.
 *
 * Deux usages, un seul mécanisme :
 *   · `verification_terrain` — l'agent saisit le numéro, le redevable lui
 *     relit le code reçu. Sans cette vérification à la source, une faute de
 *     frappe rend le redevable définitivement injoignable, et l'erreur ne se
 *     découvre qu'à l'échéance.
 *   · `connexion` — ouverture de session sur le portail.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUI N'EST JAMAIS STOCKÉ
 *
 *  Le code lui-même. Seule une empreinte SHA-256 salée l'est. Une lecture de
 *  la base — sauvegarde égarée, accès administrateur, incident — ne permet
 *  donc pas de se connecter au nom d'un redevable.
 *
 *  Même règle pour le jeton de session : la base ne contient que son
 *  empreinte. Un vol de base ne donne aucune session valide.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');
const { requete } = require('../config/database');
const { erreurs } = require('../utils/erreurs');
const sms = require('./sms.service');
const logger = require('../config/logger');

const DEFAUTS = {
  otp_longueur: 6,
  otp_validite_minutes: 5,
  otp_max_tentatives: 3,
  otp_max_par_heure: 5,
  session_portail_heures: 4,
};

/** Paramètres de la commune, avec repli sur les valeurs du document. */
async function parametres(contexte, communeId) {
  const { rows } = await requete(contexte, `
    SELECT otp_longueur, otp_validite_minutes, otp_max_tentatives,
           otp_max_par_heure, session_portail_heures, portail_actif
      FROM app.commune_parametre WHERE commune_id = $1`, [communeId]);
  return { ...DEFAUTS, portail_actif: true, ...(rows[0] ?? {}) };
}

/**
 * Code numérique tiré au sort cryptographiquement.
 * `Math.random()` serait prévisible : un code à six chiffres deviné n'est
 * pas une hypothèse théorique quand cinq essais par heure sont permis.
 */
function tirerCode(longueur) {
  const max = 10 ** longueur;
  // Rejet du dépassement pour que chaque code soit équiprobable.
  let n;
  do {
    n = crypto.randomBytes(4).readUInt32BE(0);
  } while (n >= Math.floor(4294967296 / max) * max);
  return String(n % max).padStart(longueur, '0');
}

const empreinte = (code, sel) => crypto.createHash('sha256').update(`${code}${sel}`).digest('hex');

/**
 * Émet un code et l'envoie par SMS.
 *
 * @returns {{expire_le: Date, simule: boolean, code?: string}}
 *   `code` n'est renvoyé qu'en mode simulation : sans opérateur, il faut bien
 *   que l'agent puisse terminer sa démonstration. En production il n'apparaît
 *   nulle part ailleurs que dans le SMS.
 */
async function emettre(contexte, {
  communeId, telephone, usage = 'connexion', redevableId = null, demandePar = null, ip = null,
}) {
  const p = await parametres(contexte, communeId);

  if (usage === 'connexion' && !p.portail_actif) {
    throw erreurs.serviceIndisponible('Le portail est désactivé pour cette commune');
  }

  // --- Plafond horaire --------------------------------------------------
  const { rows: [quota] } = await requete(contexte,
    'SELECT * FROM app.code_acces_autorise($1, $2, $3::smallint)',
    [communeId, telephone, p.otp_max_par_heure]);

  if (!quota.autorise) {
    const minutes = Math.max(1, Math.ceil((new Date(quota.prochaine_possible) - Date.now()) / 60000));
    throw erreurs.tropDeRequetes(
      `Trop de demandes pour ce numéro. Réessayez dans ${minutes} minute(s).`,
    );
  }

  const code = tirerCode(p.otp_longueur);
  const sel = crypto.randomBytes(16).toString('hex');
  const expire = new Date(Date.now() + p.otp_validite_minutes * 60000);

  // Les codes encore ouverts pour ce numéro sont consommés : deux codes
  // valides en même temps doublent la surface d'attaque sans rien apporter.
  await requete(contexte, `
    UPDATE app.code_acces SET consomme_le = now()
     WHERE commune_id = $1 AND telephone = $2 AND consomme_le IS NULL`,
  [communeId, telephone]);

  const { rows: [ligne] } = await requete(contexte, `
    INSERT INTO app.code_acces (commune_id, redevable_id, telephone, code_empreinte,
                                sel, usage, expire_le, max_tentatives, ip_demande, demande_par)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::smallint, $9, $10)
    RETURNING id, expire_le`,
  [communeId, redevableId, telephone, empreinte(code, sel), sel, usage,
    expire, p.otp_max_tentatives, ip, demandePar]);

  // Message volontairement muet sur ce qui est en jeu : un téléphone prêté
  // ou une notification sur écran verrouillé ne doit rien révéler.
  const texte = usage === 'verification_terrain'
    ? `Code de verification : ${code}. Communiquez-le a l'agent municipal. Valable ${p.otp_validite_minutes} min.`
    : `Votre code d'acces : ${code}. Valable ${p.otp_validite_minutes} min. Ne le communiquez a personne.`;

  const envoi = await sms.envoyer(telephone, texte);

  return {
    id: ligne.id,
    expire_le: ligne.expire_le,
    validite_minutes: p.otp_validite_minutes,
    tentatives_permises: p.otp_max_tentatives,
    simule: envoi.simule,
    ...(envoi.simule ? { code } : {}),
  };
}

/**
 * Vérifie un code.
 *
 * Retourne le redevable associé si la vérification réussit. Toute erreur est
 * volontairement indistincte du point de vue de l'appelant — code faux,
 * expiré, ou inexistant donnent le même message — pour ne pas indiquer à un
 * attaquant qu'un numéro est connu de la plateforme.
 */
async function verifier(contexte, {
  communeId, telephone, code, usage = 'connexion', ip = null,
}) {
  const { rows } = await requete(contexte, `
    SELECT id, redevable_id, code_empreinte, sel, tentatives, max_tentatives, expire_le
      FROM app.code_acces
     WHERE commune_id = $1 AND telephone = $2 AND usage = $3
       AND consomme_le IS NULL
     ORDER BY cree_le DESC
     LIMIT 1`, [communeId, telephone, usage]);

  const ligne = rows[0];
  const refus = () => erreurs.nonAuthentifie('Code invalide ou expiré');

  if (!ligne) throw refus();

  if (new Date(ligne.expire_le) < new Date()) {
    await requete(contexte, 'UPDATE app.code_acces SET consomme_le = now() WHERE id = $1', [ligne.id]);
    throw refus();
  }

  // Comparaison à temps constant : une comparaison naïve laisse fuir la
  // position du premier caractère faux.
  const attendu = Buffer.from(ligne.code_empreinte, 'hex');
  const fourni = Buffer.from(empreinte(String(code), ligne.sel), 'hex');
  const juste = attendu.length === fourni.length && crypto.timingSafeEqual(attendu, fourni);

  if (!juste) {
    const restantes = ligne.max_tentatives - (ligne.tentatives + 1);
    await requete(contexte, `
      UPDATE app.code_acces
         SET tentatives = tentatives + 1,
             consomme_le = CASE WHEN tentatives + 1 >= max_tentatives THEN now() ELSE NULL END
       WHERE id = $1`, [ligne.id]);

    if (restantes <= 0) {
      logger.warn({ telephone }, 'Code à usage unique : tentatives épuisées');
      throw erreurs.nonAuthentifie('Code invalide. Demandez un nouveau code.');
    }
    throw erreurs.nonAuthentifie(
      `Code invalide. ${restantes} tentative(s) restante(s).`,
    );
  }

  await requete(contexte, `
    UPDATE app.code_acces SET consomme_le = now(), ip_consommation = $2 WHERE id = $1`,
  [ligne.id, ip]);

  return { redevableId: ligne.redevable_id, codeAccesId: ligne.id };
}

// ---------------------------------------------------------------------------
// Sessions du portail
// ---------------------------------------------------------------------------

/**
 * Ouvre une session. Le jeton retourné n'existe qu'ici : la base n'en garde
 * que l'empreinte, et il ne peut donc pas être reconstitué côté serveur.
 */
async function ouvrirSession(contexte, {
  communeId, redevableId, ip = null, navigateur = null,
}) {
  const p = await parametres(contexte, communeId);
  const jeton = crypto.randomBytes(32).toString('base64url');
  const expire = new Date(Date.now() + p.session_portail_heures * 3600000);

  await requete(contexte, `
    INSERT INTO app.session_redevable (commune_id, redevable_id, jeton_empreinte,
                                       expire_le, ip, agent_navigateur)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [communeId, redevableId, crypto.createHash('sha256').update(jeton).digest('hex'),
    expire, ip, navigateur?.slice(0, 300) ?? null]);

  return { jeton, expire_le: expire, duree_heures: p.session_portail_heures };
}

/** Retrouve le redevable d'une session valide, et rafraîchit son activité. */
async function lireSession(contexte, jeton) {
  if (!jeton) return null;
  const empreinteJeton = crypto.createHash('sha256').update(jeton).digest('hex');

  const { rows } = await requete(contexte, `
    UPDATE app.session_redevable s
       SET derniere_activite_le = now()
     WHERE s.jeton_empreinte = $1
       AND s.revoque_le IS NULL
       AND s.expire_le > now()
    RETURNING s.id, s.commune_id, s.redevable_id, s.expire_le`, [empreinteJeton]);

  return rows[0] ?? null;
}

async function fermerSession(contexte, jeton, motif = 'deconnexion') {
  if (!jeton) return;
  const empreinteJeton = crypto.createHash('sha256').update(jeton).digest('hex');
  await requete(contexte, `
    UPDATE app.session_redevable
       SET revoque_le = now(), motif_revocation = $2
     WHERE jeton_empreinte = $1 AND revoque_le IS NULL`, [empreinteJeton, motif]);
}

module.exports = {
  emettre, verifier, ouvrirSession, lireSession, fermerSession, parametres,
};
