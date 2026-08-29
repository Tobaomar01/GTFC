'use strict';
const { requete } = require('../config/database');
const logger = require('../config/logger');

/**
 * Canal USSD (FR-067, Constitution VI).
 *
 * Le principe VI de la constitution est explicite : aucune fonctionnalité
 * destinée au redevable ne peut exiger un smartphone, une application ou un
 * compte. Le portail web suppose un terminal capable d'ouvrir un lien ; ce
 * n'est pas le cas de la majorité des petits commerçants de la commune.
 *
 * L'USSD est donc le canal de référence, pas un repli.
 *
 * Deux règles gouvernent ce service :
 *
 *   1. Le numéro appelant vaut identification, mais SEULEMENT s'il
 *      correspond à un numéro vérifié.
 *   2. La réponse servie à un numéro non vérifié est INDISTINGUABLE de celle
 *      servie à un numéro inconnu (FR-068). Une différence, même de
 *      formulation, permettrait d'énumérer les redevables de la commune en
 *      composant des numéros au hasard.
 */

/**
 * Réponse unique pour tout numéro non reconnu. Un seul libellé, une seule
 * longueur, aucune variante : c'est ce qui rend l'énumération impossible.
 */
const REPONSE_INCONNUE =
  'Aucune information disponible pour ce numero. '
  + 'Rapprochez-vous de la mairie de Gueule Tapee-Fass-Colobane.';

/**
 * Sans accents ni caractères hors alphabet latin de base. L'USSD est limité
 * à 182 octets par écran, et un seul accent fait basculer l'encodage en
 * UCS-2, divisant la capacité par deux.
 */
function sansAccent(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function formaterMontant(n) {
  return Number(n).toLocaleString('fr-FR').replace(/ | /g, ' ');
}

/**
 * Situation d'un redevable à partir de son numéro.
 *
 * Retourne null pour un numéro inconnu ET pour un numéro non vérifié : le
 * service appelant ne doit pas pouvoir distinguer les deux cas.
 */
async function situationParTelephone(contexte, telephone) {
  const { rows } = await requete(contexte, `
    SELECT r.id, r.designation, r.solde_du, r.nb_objets_taxables,
           a.numero AS avis_numero, a.montant_restant, a.date_exigibilite
      FROM app.redevable r
      LEFT JOIN LATERAL (
        SELECT ai.numero, ai.montant_restant, ai.date_exigibilite
          FROM app.avis_imposition ai
         WHERE ai.redevable_id = r.id
           AND ai.annule_le IS NULL
           AND ai.statut <> 'brouillon'
           AND ai.montant_restant > 0
         ORDER BY ai.date_exigibilite
         LIMIT 1
      ) a ON true
     WHERE r.telephone = $1
       AND r.telephone_verifie
       AND r.archive_le IS NULL`, [telephone]);
  return rows[0] ?? null;
}

/**
 * Traite une requête USSD. Le fil est court et sans mémoire côté opérateur :
 * chaque appel est autonome, on ne construit pas d'arborescence de menus.
 * Une seule question, une seule réponse — c'est ce que l'usage réel demande.
 */
async function traiter(contexte, { telephone, saisie = '' }) {
  let situation = null;
  try {
    situation = await situationParTelephone(contexte, telephone);
  } catch (err) {
    logger.error({ err }, 'USSD : échec de la consultation');
    // Même en cas de panne, on ne révèle rien de plus.
    return { fin: true, texte: sansAccent(REPONSE_INCONNUE) };
  }

  if (!situation) {
    return { fin: true, texte: sansAccent(REPONSE_INCONNUE) };
  }

  const solde = Number(situation.solde_du ?? 0);
  if (solde <= 0) {
    return { fin: true, texte: sansAccent('Votre situation est a jour. Merci.') };
  }

  const date = situation.date_exigibilite
    ? new Date(situation.date_exigibilite).toLocaleDateString('fr-FR')
    : null;

  const texte = sansAccent(
    `Solde restant du : ${formaterMontant(solde)} FCFA.`
    + (date ? ` A regler avant le ${date}.` : '')
    + ' Un lien de paiement Wave vous est envoye par SMS chaque mois.');

  return { fin: true, texte, redevable_id: situation.id };
}

module.exports = { traiter, situationParTelephone, REPONSE_INCONNUE, sansAccent };
