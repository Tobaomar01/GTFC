/**
 * Envoi de SMS — passerelle unique et remplaçable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUI SORT DU SERVEUR
 *
 *  Un numéro de téléphone et un texte. Rien d'autre. Jamais un montant,
 *  jamais un nom, jamais une référence d'avis, jamais un identifiant interne.
 *
 *  C'est la même règle que pour Wave, qui ne reçoit qu'un numéro et un
 *  montant. Un opérateur SMS compromis ne doit rien apprendre de la
 *  situation fiscale de qui que ce soit.
 *
 *  La fonction `verifierMessage()` plus bas fait respecter cette règle par
 *  le code plutôt que par la discipline : un message contenant « FCFA », un
 *  numéro d'avis ou un UUID est REFUSÉ, pas seulement signalé.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  MODE SIMULATION
 *
 *  Tant qu'aucun opérateur n'est raccordé, le message est écrit dans le
 *  journal du serveur. Toute la chaîne fonctionne — code, tentatives,
 *  expiration, session — et seul le dernier maillon est absent. Le jour où
 *  la clé arrive, seul le .env change.
 */

'use strict';

const config = require('../config/env');
const logger = require('../config/logger');

/** Motifs interdits dans un SMS sortant. */
/**
 * Ce qu'un SMS ne doit jamais porter.
 *
 * Le MONTANT y figurait, et cette règle rendait le dispositif inerte : les
 * trois modèles de message annoncent une somme, donc chacun était refusé. Tant
 * que la passerelle restait débranchée, rien ne s'en apercevait — le canal
 * bascule alors sur « à transmettre par l'agent », qui n'appelle pas ce
 * contrôle. Le jour du raccordement, plus aucun SMS ne serait parti, et le
 * lien Wave avec eux : personne n'aurait su quoi payer ni comment.
 *
 * Le montant a donc été retiré de cette liste, après réflexion sur ce qu'elle
 * protège. Le message part sur le numéro VÉRIFIÉ du redevable, et lui annonce
 * SA dette : ce n'est pas une fuite, c'est l'objet même de l'envoi. Un avis
 * qui tairait la somme n'apprendrait rien à personne.
 *
 * Restent les identifiants INTERNES. Eux n'apprennent rien au destinataire et
 * servent à qui les intercepte : une référence d'avis ou un identifiant
 * technique dans un SMS est une prise, sans contrepartie.
 */
const FUITES = [
  { motif: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, quoi: 'un identifiant interne' },
  { motif: /\b[A-Z]{2,6}-\d{4}-\d{2}-\d{6}\b/, quoi: "un numéro d'avis" },
];

/**
 * Refuse un message qui exposerait une donnée fiscale.
 * Lève plutôt que d'assainir : un message tronqué en silence serait
 * incompréhensible pour le destinataire, et la faute resterait invisible.
 */
function verifierMessage(texte) {
  for (const { motif, quoi } of FUITES) {
    if (motif.test(texte)) {
      throw new Error(
        `SMS refusé : le message contient ${quoi}. `
        + 'Seuls un numéro et un texte neutre peuvent sortir vers l\'opérateur.',
      );
    }
  }
  if (texte.length > 320) {
    throw new Error(`SMS refusé : ${texte.length} caractères (maximum 320, soit deux segments).`);
  }
  return texte;
}

// ---------------------------------------------------------------------------
// Pilotes
// ---------------------------------------------------------------------------

/**
 * Simulation : le message part dans le journal.
 * Le code y figure en clair — c'est voulu, et c'est aussi pourquoi ce mode
 * refuse de s'activer en production sans SMS_SIMULER_EN_PROD explicite.
 */
async function pilotSimulation({ telephone, texte }) {
  logger.info({ sms: { telephone, texte } },
    `[SMS SIMULÉ] ${telephone} : ${texte}`);
  return { reference: `sim_${Date.now()}`, simule: true };
}

/**
 * Orange SMS Pro (Sénégal) — API REST, jeton OAuth2.
 * Le contrat exact dépend du contrat souscrit ; la forme ci-dessous est
 * celle de l'API publique Orange Developer.
 */
async function pilotOrange({ telephone, texte }) {
  const reponse = await fetch(`${config.sms.baseUrl}/smsmessaging/v1/outbound/requests`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.sms.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      outboundSMSMessageRequest: {
        address: `tel:${telephone}`,
        senderAddress: config.sms.expediteur,
        outboundSMSTextMessage: { message: texte },
      },
    }),
  });

  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => '');
    throw new Error(`Opérateur SMS : ${reponse.status} ${detail.slice(0, 200)}`);
  }
  const corps = await reponse.json().catch(() => ({}));
  return { reference: corps?.outboundSMSMessageRequest?.resourceURL ?? null, simule: false };
}

/**
 * Passerelle générique : un POST JSON { to, from, text }.
 * Couvre la plupart des agrégateurs et évite d'écrire un pilote par
 * fournisseur avant de savoir lequel la mairie retiendra.
 */
async function pilotGenerique({ telephone, texte }) {
  const reponse = await fetch(config.sms.baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.sms.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: telephone, from: config.sms.expediteur, text: texte }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => '');
    throw new Error(`Passerelle SMS : ${reponse.status} ${detail.slice(0, 200)}`);
  }
  return { reference: null, simule: false };
}

const PILOTES = {
  orange: pilotOrange,
  generique: pilotGenerique,
};

// ---------------------------------------------------------------------------
// Point d'entrée unique
// ---------------------------------------------------------------------------

/**
 * Envoie un SMS.
 *
 * @param {string} telephone  numéro au format +221XXXXXXXXX
 * @param {string} texte      message, sans aucune donnée fiscale
 * @returns {{reference: string|null, simule: boolean}}
 */
async function envoyer(telephone, texte) {
  verifierMessage(texte);

  if (!config.sms.actif) {
    return pilotSimulation({ telephone, texte });
  }

  const pilote = PILOTES[config.sms.fournisseur] ?? pilotGenerique;
  try {
    return await pilote({ telephone, texte });
  } catch (err) {
    // Le numéro est journalisé, jamais le contenu : un code à usage unique
    // dans les journaux d'erreur reste un code utilisable.
    logger.error({ err, telephone }, 'Échec d\'envoi SMS');
    throw err;
  }
}

/** Le service est-il réellement raccordé, ou en simulation ? */
function estSimule() {
  return !config.sms.actif;
}

module.exports = { envoyer, estSimule, verifierMessage };
