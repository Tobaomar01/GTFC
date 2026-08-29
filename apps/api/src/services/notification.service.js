/**
 * Notifications aux commerçants.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  IMPORTANT — aucun opérateur SMS n'est raccordé à ce jour.
 *
 *  Le cahier des charges ne mentionne pas de fournisseur SMS, et aucun compte
 *  n'existe. Plutôt que d'inventer une intégration qu'il faudrait refaire,
 *  ce service met les messages EN FILE et propose plusieurs canaux :
 *
 *    - `manuel`   (défaut) : le message est préparé et attend. L'agent le
 *                 transmet de vive voix ou montre le lien sur son téléphone,
 *                 et le dashboard permet de l'exporter pour un envoi groupé.
 *    - `sms`      : actif seulement si SMS_FOURNISSEUR est configuré.
 *    - `journal`  : écrit dans les logs, utile en sandbox.
 *
 *  Brancher un opérateur plus tard ne demandera que d'ajouter une fonction
 *  dans CANAUX ci-dessous — le reste du code n'a pas à changer.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const config = require('../config/env');
const logger = require('../config/logger');
const { requete } = require('../config/database');
const sms = require('./sms.service');

/** Un SMS fait 160 caractères. Au-delà il est facturé double, et tronqué par
 *  certains opérateurs : on compose donc court, et on vérifie. */
const LONGUEUR_SMS = 160;

const modeles = {
  avis_emis: ({ commerce, montant, echeance, lien }) => (lien
    ? `Mairie: taxes ${commerce} = ${montant} FCFA, a payer avant le ${echeance}. `
      + `Payez par Wave: ${lien}`
    : `Mairie: taxes ${commerce} = ${montant} FCFA, a payer avant le ${echeance} `
      + 'aupres de l agent ou a la mairie.'),

  relance: ({ commerce, montant, jours }) => `Mairie: rappel, ${montant} FCFA restent dus `
    + `pour ${commerce} (retard ${jours} jours). Regularisez pour eviter les penalites.`,

  quittance: ({ commerce, montant, numero }) => `Mairie: paiement de ${montant} FCFA recu `
    + `pour ${commerce}. Quittance ${numero}. Merci.`,
};

/**
 * Les SMS passent souvent par des passerelles qui ne gèrent pas l'UTF-8 :
 * un « é » devient un caractère de remplacement, ou fait basculer le message
 * en encodage 16 bits, divisant par deux le nombre de caractères utiles.
 * On écrit donc les SMS sans accent, délibérément.
 */
const sansAccent = (t) => String(t ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ---------------------------------------------------------------------------
// Canaux
// ---------------------------------------------------------------------------
const CANAUX = {
  /** Le message attend d'être relevé par un agent ou exporté. */
  async manuel(notification) {
    return { statut: 'en_attente', message: 'À transmettre par l\'agent' };
  },

  async journal(notification) {
    logger.info(
      { destinataire: notification.destinataire, type: notification.type },
      `[SIMULATION SMS] ${notification.contenu}`,
    );
    return { statut: 'envoye' };
  },

  /**
   * Envoi réel, par la passerelle de l'opérateur.
   *
   * Ce canal levait « Fournisseur SMS déclaré mais non implémenté », alors que
   * l'envoi existait déjà, complet, dans sms.service.js — avec deux pilotes.
   * Deux modules parlaient du même sujet, l'un abouti, l'autre resté à
   * l'état d'intention ; et c'est celui-ci que la file appelle.
   *
   * Rien ne pouvait le voir tant qu'aucune passerelle n'était raccordée : sans
   * elle, `config.sms.actif` est faux et le message repart en file. Le jour du
   * branchement, la campagne mensuelle aurait échoué sur CHAQUE message — et
   * avec elle le seul canal par lequel l'argent rentre.
   */
  async sms(notification) {
    if (!config.sms?.actif) {
      // Aucun opérateur configuré : on ne perd pas le message, on le laisse
      // en file plutôt que de le marquer en échec.
      return { statut: 'en_attente', message: 'Aucun fournisseur SMS configuré' };
    }

    const { reference } = await sms.envoyer(notification.destinataire, notification.contenu);
    return { statut: 'envoye', reference };
  },
};

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

/** Met un message en file. Ne l'envoie pas : c'est `traiterFile` qui s'en charge. */
async function empiler(contexte, { commerceId, avisId, type, destinataire, variables,
  canal = null }) {
  const composer = modeles[type];
  if (!composer) throw new Error(`Modèle de notification inconnu : ${type}`);

  const contenu = sansAccent(composer(variables));
  const canalRetenu = canal ?? (config.sms?.actif ? 'sms' : 'manuel');

  if (contenu.length > LONGUEUR_SMS) {
    logger.warn({ type, longueur: contenu.length },
      'Message plus long que 160 caractères — il sera facturé en plusieurs SMS');
  }

  const { rows } = await requete(contexte, `
    INSERT INTO app.notification (commune_id, commerce_id, avis_id, canal, type,
                                  destinataire, contenu, statut)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'en_attente')
    RETURNING id, canal, contenu`,
  [contexte.communeId, commerceId ?? null, avisId ?? null,
    canalRetenu === 'manuel' ? 'sms' : canalRetenu, type, destinataire, contenu]);

  return rows[0];
}

/**
 * Traite la file d'envoi.
 * Appelé par le planificateur. Chaque message est traité indépendamment :
 * un numéro invalide ne doit pas bloquer les 300 suivants.
 */
async function traiterFile(contexte, { limite = 100 } = {}) {
  const { rows: enAttente } = await requete(contexte, `
    SELECT id, commune_id, canal, type, destinataire, contenu, nb_tentatives
      FROM app.notification
     WHERE statut = 'en_attente' AND nb_tentatives < 3
     ORDER BY cree_le LIMIT $1`, [limite]);

  const bilan = { envoyes: 0, en_attente: 0, echecs: 0 };

  for (const n of enAttente) {
    const canal = config.sms?.actif ? CANAUX.sms
      : (config.env === 'production' ? CANAUX.manuel : CANAUX.journal);

    try {
      const resultat = await canal(n);
      if (resultat.statut === 'envoye') {
        await requete(contexte,
          `UPDATE app.notification SET statut = 'envoye', envoye_le = now(),
                  nb_tentatives = nb_tentatives + 1 WHERE id = $1`, [n.id]);
        bilan.envoyes += 1;
      } else {
        // On n'incrémente pas les tentatives : le message n'a pas échoué,
        // il attend simplement un canal disponible.
        bilan.en_attente += 1;
      }
    } catch (err) {
      await requete(contexte,
        `UPDATE app.notification SET nb_tentatives = nb_tentatives + 1, erreur = $2,
                statut = CASE WHEN nb_tentatives + 1 >= 3 THEN 'echec' ELSE 'en_attente' END
          WHERE id = $1`, [n.id, err.message]);
      bilan.echecs += 1;
    }
  }

  return bilan;
}

/**
 * Messages à transmettre à la main, groupés par agent responsable de la zone.
 * C'est la sortie utile tant qu'aucun opérateur SMS n'est raccordé : le
 * superviseur imprime la liste, les agents la distribuent lors de leur tournée.
 */
async function messagesATransmettre(contexte, { zoneId = null, limite = 500 } = {}) {
  const params = [];
  let filtre = '';
  if (zoneId) { params.push(zoneId); filtre = `AND c.zone_id = $${params.length}`; }
  params.push(limite);

  const { rows } = await requete(contexte, `
    SELECT n.id, n.type, n.destinataire, n.contenu, n.cree_le,
           c.code AS commerce_code, c.enseigne,
           q.nom AS quartier, z.nom AS zone,
           a.numero AS avis_numero, a.montant_restant,
           t.checkout_url
      FROM app.notification n
      JOIN app.commerce c ON c.id = n.commerce_id
      JOIN app.quartier q ON q.id = c.quartier_id
      JOIN app.zone z ON z.id = c.zone_id
      LEFT JOIN app.avis_imposition a ON a.id = n.avis_id
      LEFT JOIN LATERAL (
        SELECT checkout_url FROM app.transaction_wave w
         WHERE w.avis_id = n.avis_id AND w.statut IN ('initiee','en_attente')
         ORDER BY w.initie_le DESC LIMIT 1
      ) t ON true
     WHERE n.statut = 'en_attente' ${filtre}
     ORDER BY z.ordre, q.code, c.code
     LIMIT $${params.length}`, params);

  return rows;
}

/** Marque comme remis les messages transmis de vive voix par un agent. */
async function marquerRemis(contexte, ids) {
  const { rowCount } = await requete(contexte, `
    UPDATE app.notification
       SET statut = 'envoye', envoye_le = now()
     WHERE id = ANY($1::uuid[]) AND statut = 'en_attente'`, [ids]);
  return rowCount;
}

module.exports = {
  empiler, traiterFile, messagesATransmettre, marquerRemis, modeles, sansAccent, CANAUX,
};
