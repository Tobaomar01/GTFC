/**
 * Intégration Wave Sénégal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CONFIDENTIALITÉ — règle absolue du projet
 *  Wave ne reçoit QUE deux informations : un numéro de téléphone et un
 *  montant. Jamais le nom du commerce, ni celui du gérant, ni le détail des
 *  taxes, ni l'adresse. Le champ `client_reference` ne contient que
 *  l'identifiant technique de l'avis, inexploitable hors de notre base.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * La phase 3 livre la réception du webhook (vérification de signature,
 * idempotence, rapprochement du paiement). La création des liens de paiement
 * et le planificateur mensuel sont finalisés en phase 5, une fois le compte
 * Wave Business ouvert et la clé sandbox disponible.
 */
'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const { avecContexte, requete } = require('../config/database');
const notifications = require('./notification.service');
const { erreurs } = require('../utils/erreurs');

/** Tolérance sur l'horodatage du webhook : rejoue impossible au-delà. */
const FENETRE_SIGNATURE_SECONDES = 300;

/**
 * Vérifie la signature HMAC-SHA256 du webhook.
 *
 * En-tête attendu : `Wave-Signature: t=<timestamp>,v1=<signature>`
 * Message signé   : `<timestamp>.<corps brut>`
 *
 * Le corps BRUT est indispensable : re-sérialiser le JSON change les espaces
 * et invalide la signature. D'où le `express.raw()` sur cette seule route.
 *
 * NOTE D'INTÉGRATION (phase 5) : confirmer le nom de l'en-tête et le format
 * exact auprès de Wave avant le passage en production. La logique ci-dessous
 * suit le schéma standard ; seul le découpage de l'en-tête serait à ajuster.
 */
function verifierSignature({ enteteSignature, corpsBrut, secret = config.wave.webhookSecret }) {
  if (!secret) {
    throw erreurs.interne('WAVE_WEBHOOK_SECRET non configuré : webhook refusé');
  }
  if (!enteteSignature) {
    return { valide: false, motif: 'en-tête de signature absent' };
  }

  const parties = Object.fromEntries(
    String(enteteSignature).split(',').map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );

  const horodatage = parties.t;
  const signatureRecue = parties.v1 || parties.v0;
  if (!horodatage || !signatureRecue) {
    return { valide: false, motif: 'en-tête de signature mal formé' };
  }

  // Fenêtre temporelle : sans elle, une requête interceptée resterait
  // rejouable indéfiniment, signature comprise.
  const ecart = Math.abs(Math.floor(Date.now() / 1000) - Number(horodatage));
  if (!Number.isFinite(ecart) || ecart > FENETRE_SIGNATURE_SECONDES) {
    return { valide: false, motif: `horodatage hors fenêtre (${ecart} s)` };
  }

  const attendue = crypto
    .createHmac('sha256', secret)
    .update(`${horodatage}.${corpsBrut}`)
    .digest('hex');

  const a = Buffer.from(attendue, 'utf8');
  const b = Buffer.from(String(signatureRecue), 'utf8');
  // Comparaison à temps constant : une comparaison ordinaire fuiterait la
  // signature octet par octet.
  const valide = a.length === b.length && crypto.timingSafeEqual(a, b);

  return { valide, motif: valide ? null : 'signature invalide' };
}

/** Statuts Wave -> statuts internes. */
const CORRESPONDANCE_STATUTS = {
  checkout_session_completed: 'reussie',
  checkout_session_payment_failed: 'echouee',
  checkout_session_expired: 'expiree',
  checkout_session_cancelled: 'annulee',
  refund_succeeded: 'remboursee',
};

/**
 * Traite un événement Wave.
 *
 * Idempotent : Wave réémet ses webhooks jusqu'à recevoir un 2xx. Le même
 * paiement peut donc arriver cinq fois. On s'appuie sur l'unicité de
 * `wave_session_id` et sur la référence de paiement pour n'encaisser qu'une
 * seule fois — sans cela, un avis pourrait être marqué payé cinq fois et les
 * statistiques de recouvrement seraient fausses.
 */
async function traiterEvenement({ evenement, signatureValide, corpsBrut }) {
  const type = evenement?.type;
  const donnees = evenement?.data || {};
  const sessionId = donnees.id || donnees.checkout_session_id;

  if (!sessionId) {
    logger.warn({ type }, 'Webhook Wave sans identifiant de session — ignoré');
    return { traite: false, motif: 'identifiant de session absent' };
  }

  const nouveauStatut = CORRESPONDANCE_STATUTS[type];
  if (!nouveauStatut) {
    // Type non géré : on l'accepte (2xx) pour que Wave cesse de réémettre,
    // mais on le trace.
    logger.info({ type, sessionId }, 'Type d\'événement Wave non traité');
    return { traite: false, motif: `type non géré : ${type}` };
  }

  // Contexte super-admin : le webhook n'est porteur d'aucun JWT, et la
  // transaction peut concerner n'importe quelle commune de la plateforme.
  const contexte = { superAdmin: true, ip: null };

  return avecContexte(contexte, async (client) => {
    const { rows: tr } = await client.query(
      `SELECT t.*, a.commune_id AS avis_commune, a.commerce_id, a.montant_restant, a.numero
         FROM app.transaction_wave t
         JOIN app.avis_imposition a ON a.id = t.avis_id
        WHERE t.wave_session_id = $1
        FOR UPDATE OF t`,
      [sessionId],
    );
    const transaction = tr[0];

    if (!transaction) {
      logger.warn({ sessionId, type }, 'Webhook Wave pour une session inconnue');
      return { traite: false, motif: 'session inconnue' };
    }

    // Déjà traitée : on ne rejoue pas l'encaissement.
    if (transaction.statut === 'reussie' && nouveauStatut === 'reussie') {
      return { traite: true, deja: true, transaction_id: transaction.id };
    }

    // Le paramètre $2 est utilisé à la fois comme énuméré (colonne statut) et
    // comme texte (comparaison du CASE). Sans les deux transtypages explicites,
    // PostgreSQL refuse : « inconsistent types deduced for parameter $2 ».
    await client.query(`
      UPDATE app.transaction_wave
         SET statut = $2::app.statut_transaction,
             wave_transaction_id = COALESCE($3, wave_transaction_id),
             confirme_le = CASE WHEN $2::text = 'reussie' THEN now() ELSE confirme_le END,
             webhook_recu_le = now(),
             webhook_payload = $4::jsonb,
             webhook_valide = $5,
             nb_tentatives = nb_tentatives + 1
       WHERE id = $1`,
    [transaction.id, nouveauStatut, donnees.transaction_id ?? null, corpsBrut, signatureValide]);

    if (nouveauStatut !== 'reussie') {
      return { traite: true, statut: nouveauStatut, transaction_id: transaction.id };
    }

    // --- Encaissement ------------------------------------------------------
    // Le montant retenu est celui annoncé par Wave, plafonné au reste dû :
    // un écart d'arrondi ne doit pas créer un trop-perçu en base.
    const montantWave = Math.round(Number(donnees.amount ?? transaction.montant));
    const montant = Math.min(montantWave, Number(transaction.montant_restant));

    if (montant <= 0) {
      logger.warn({ sessionId, montantWave }, 'Paiement Wave sans montant à imputer');
      return { traite: true, statut: 'reussie', montant_impute: 0 };
    }

    const reference = `WAVE-${String(sessionId).slice(-16).toUpperCase()}`;

    const { rows: paiement } = await client.query(`
      INSERT INTO app.paiement (
        commune_id, commerce_id, avis_id, reference, montant, moyen,
        paye_le, telephone_payeur, commentaire
      ) VALUES ($1, $2, $3, $4, $5, 'wave', COALESCE($6::timestamptz, now()), $7,
                'Paiement Wave confirmé par webhook')
      ON CONFLICT (commune_id, reference) DO NOTHING
      RETURNING id`,
    [
      transaction.avis_commune, transaction.commerce_id, transaction.avis_id,
      reference, montant, donnees.when_completed ?? null, transaction.telephone,
    ]);

    if (paiement[0]) {
      await client.query(
        'UPDATE app.transaction_wave SET paiement_id = $2 WHERE id = $1',
        [transaction.id, paiement[0].id],
      );

      // Quittance : on crée la LIGNE ici, dans la transaction du webhook, mais
      // pas le PDF. Générer le PDF exigerait MinIO, et un stockage
      // momentanément indisponible ferait échouer l'encaissement d'un paiement
      // déjà encaissé par Wave. Le planificateur produira les PDF manquants.
      const { rows: jeton } = await client.query('SELECT app.code_aleatoire(16) AS j');
      await client.query(`
        INSERT INTO app.quittance (commune_id, paiement_id, commerce_id, numero,
                                   jeton_verification)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (commune_id, numero) DO NOTHING`,
      [transaction.avis_commune, paiement[0].id, transaction.commerce_id,
        `QT-${reference}`, jeton[0].j]);
    }

    // Le déclencheur trg_paiement_maj_avis a déjà recalculé le statut de
    // l'avis et la couleur du commerce sur la carte : rien à faire de plus.
    return {
      traite: true,
      statut: 'reussie',
      transaction_id: transaction.id,
      paiement_id: paiement[0]?.id ?? null,
      montant_impute: paiement[0] ? montant : 0,
      deja: !paiement[0],
    };
  });
}

/**
 * Crée un lien de paiement Wave regroupant toutes les taxes d'un avis.
 * Finalisée en phase 5 ; l'ossature est ici pour que le schéma et les
 * enregistrements de transaction soient déjà en place.
 */
async function creerLienPaiement(contexte, { avisId, telephone }) {
  if (!config.wave.actif && !config.wave.simuler) {
    throw erreurs.serviceIndisponible(
      'de paiement Wave (WAVE_ACTIF=false et simulation désactivée)');
  }

  return avecContexte(contexte, async (client) => {
    const { rows } = await client.query(`
      SELECT a.id, a.commune_id, a.numero, a.montant_restant,
             -- Le numéro du redevable d'abord : c'est lui le payeur, et c'est
             -- ce numéro qui a été vérifié par code sur le terrain. Le
             -- commerce ne sert que de repli pour les fiches non reprises.
             coalesce(r.telephone, c.telephone_paiement) AS telephone_paiement,
             r.statut_telephone
        FROM app.avis_imposition a
        JOIN app.redevable r        ON r.id = a.redevable_id
        -- Jointure EXTERNE : une régie publicitaire est facturée sans
        -- posséder le moindre commerce.
        LEFT JOIN app.commerce c    ON c.id = a.commerce_id
       WHERE a.id = $1 AND a.annule_le IS NULL`, [avisId]);
    const avis = rows[0];
    if (!avis) throw erreurs.introuvable('Avis d\'imposition');
    if (Number(avis.montant_restant) <= 0) {
      throw erreurs.requeteInvalide('Cet avis est déjà soldé');
    }

    const numero = telephone || avis.telephone_paiement;
    if (!numero) {
      throw erreurs.requeteInvalide(
        'Aucun numéro de téléphone enregistré pour ce redevable. '
        + 'Un agent doit le saisir et le faire vérifier avant tout envoi de lien.');
    }

    // Seules ces trois valeurs partent chez Wave.
    const charge = {
      amount: String(avis.montant_restant),
      currency: config.wave.devise,
      client_reference: avis.id,
      error_url: `https://${config.domaine}/paiement/echec`,
      success_url: `https://${config.domaine}/paiement/succes`,
    };

    // ---------------------------------------------------------------------
    // Mode simulation — aucun compte Wave Business n'est encore ouvert.
    //
    // On fabrique une session localement, avec un identifiant reconnaissable.
    // Tout le reste de la chaîne est IDENTIQUE au mode réel : même table, même
    // webhook, même rapprochement, même quittance. Le jour où la clé Wave
    // arrive, il suffit de renseigner WAVE_API_KEY et WAVE_ACTIF=true.
    // ---------------------------------------------------------------------
    if (config.wave.simuler) {
      const sessionSimulee = `sim_${crypto.randomBytes(12).toString('hex')}`;
      const { rows: sim } = await client.query(`
        INSERT INTO app.transaction_wave (
          commune_id, avis_id, wave_session_id, checkout_url, montant, devise,
          telephone, statut, environnement, expire_le
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'initiee', 'sandbox',
                  now() + ($8 || ' hours')::interval)
        RETURNING id, wave_session_id, checkout_url, montant, expire_le`,
      [avis.commune_id, avis.id, sessionSimulee,
        `https://${config.domaine}/paiement/simulation/${sessionSimulee}`,
        avis.montant_restant, config.wave.devise, numero,
        String(config.wave.dureeLienHeures)]);

      logger.info({ session: sessionSimulee, avis: avis.numero, montant: avis.montant_restant },
        'Lien de paiement SIMULÉ créé (aucun appel à Wave)');

      return {
        ...sim[0],
        avis_numero: avis.numero,
        simulation: true,
        confirmer_avec: `node scripts/simuler-wave.js payer ${sessionSimulee}`,
      };
    }

    const reponse = await fetch(`${config.wave.baseUrl}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.wave.apiKey}`,
        'Content-Type': 'application/json',
        // Rejouer la même requête ne crée pas une seconde session de paiement
        'Idempotency-Key': `avis-${avis.id}`,
      },
      body: JSON.stringify(charge),
      signal: AbortSignal.timeout(15000),
    }).catch((err) => {
      logger.error({ err }, 'Wave injoignable');
      throw erreurs.serviceIndisponible('de paiement Wave');
    });

    if (!reponse.ok) {
      const texte = await reponse.text().catch(() => '');
      logger.error({ statut: reponse.status, texte }, 'Wave a refusé la création de session');
      throw erreurs.serviceIndisponible('de paiement Wave');
    }

    const session = await reponse.json();

    const { rows: tr } = await client.query(`
      INSERT INTO app.transaction_wave (
        commune_id, avis_id, wave_session_id, checkout_url, montant, devise,
        telephone, statut, environnement, expire_le
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'initiee', $8, now() + interval '24 hours')
      RETURNING id, checkout_url, montant, expire_le`,
    [avis.commune_id, avis.id, session.id, session.wave_launch_url ?? session.launch_url,
      avis.montant_restant, config.wave.devise, numero, config.wave.environnement]);

    return { ...tr[0], avis_numero: avis.numero };
  });
}

/**
 * Campagne mensuelle : un lien de paiement et une notification par avis émis.
 *
 * Appelée par le planificateur après la génération des avis. Tolérante :
 * un commerce sans numéro de téléphone ne doit pas interrompre la campagne
 * des 5 442 autres — il est compté et listé pour que la mairie le complète.
 *
 * Idempotente : un avis qui possède déjà un lien valide est ignoré. Relancer
 * la campagne ne crée donc pas de second lien, ni un second message.
 */
async function lancerCampagne(contexte, { periodeId, limite = 2000 } = {}) {
  const bilan = {
    liens_crees: 0, notifications: 0, deja_traites: 0,
    sans_telephone: [], erreurs: [],
  };

  const { rows: avis } = await requete(contexte, `
    SELECT a.id, a.numero, a.montant_restant, a.date_exigibilite,
           c.id AS commerce_id, c.code, c.enseigne,
           coalesce(r.telephone, c.telephone_paiement) AS telephone_paiement,
           r.id AS redevable_id, r.designation, r.statut_telephone
      FROM app.avis_imposition a
      JOIN app.redevable r     ON r.id = a.redevable_id
      LEFT JOIN app.commerce c ON c.id = a.commerce_id
     WHERE a.periode_id = $1
       AND a.annule_le IS NULL
       AND a.statut IN ('emis', 'partiellement_paye')
       AND a.montant_restant > 0
     ORDER BY c.code
     LIMIT $2`, [periodeId, limite]);

  for (const av of avis) {
    try {
      // Lien encore valide ? On ne le remplace pas : le commerçant a peut-être
      // déjà reçu le premier, deux liens pour la même dette sèmeraient le doute.
      const { rows: existant } = await requete(contexte, `
        SELECT id, checkout_url FROM app.transaction_wave
         WHERE avis_id = $1 AND statut IN ('initiee', 'en_attente')
           AND (expire_le IS NULL OR expire_le > now())
         ORDER BY initie_le DESC LIMIT 1`, [av.id]);

      let lien = existant[0] ?? null;

      if (!lien) {
        if (!av.telephone_paiement) {
          bilan.sans_telephone.push({ code: av.code, enseigne: av.enseigne });
          // Pas de téléphone : on notifie quand même, en mode « à transmettre
          // par l'agent ». Le commerçant sera prévenu lors du prochain passage.
        } else {
          lien = await creerLienPaiement(contexte, { avisId: av.id });
          bilan.liens_crees += 1;
        }
      } else {
        bilan.deja_traites += 1;
      }

      const { rows: dejaNotifie } = await requete(contexte, `
        SELECT 1 FROM app.notification
         WHERE avis_id = $1 AND type = 'avis_emis' LIMIT 1`, [av.id]);

      if (dejaNotifie.length === 0 && av.telephone_paiement) {
        await notifications.empiler(contexte, {
          commerceId: av.commerce_id,
          avisId: av.id,
          type: 'avis_emis',
          destinataire: av.telephone_paiement,
          variables: {
            commerce: av.enseigne,
            montant: Math.round(av.montant_restant),
            echeance: new Date(av.date_exigibilite).toLocaleDateString('fr-FR'),
            lien: lien?.checkout_url ?? null,
          },
        });
        bilan.notifications += 1;
      }
    } catch (err) {
      logger.error({ err: err.message, avis: av.numero }, 'Campagne : avis en échec');
      bilan.erreurs.push({ avis: av.numero, message: err.message });
    }
  }

  return bilan;
}

/** Relance des impayés échus. Une seule relance par avis et par semaine. */
async function relancerImpayes(contexte, { joursRetardMin = 3, limite = 1000 } = {}) {
  const bilan = { relances: 0, ignores: 0 };

  const { rows } = await requete(contexte, `
    SELECT a.id, a.numero, a.montant_restant, a.date_exigibilite, a.nb_relances,
           c.id AS commerce_id, c.enseigne,
           coalesce(r.telephone, c.telephone_paiement) AS telephone_paiement,
           r.id AS redevable_id,
           (current_date - a.date_exigibilite) AS jours_retard
      FROM app.avis_imposition a
      JOIN app.redevable r     ON r.id = a.redevable_id
      LEFT JOIN app.commerce c ON c.id = a.commerce_id
     WHERE a.annule_le IS NULL
       AND a.statut IN ('emis', 'partiellement_paye')
       AND a.montant_restant > 0
       AND a.date_exigibilite < current_date - ($1 || ' days')::interval
       AND (a.derniere_relance_le IS NULL OR a.derniere_relance_le < now() - interval '7 days')
       AND coalesce(r.telephone, c.telephone_paiement) IS NOT NULL
     ORDER BY a.date_exigibilite
     LIMIT $2`, [String(joursRetardMin), limite]);

  for (const av of rows) {
    try {
      await notifications.empiler(contexte, {
        commerceId: av.commerce_id,
        avisId: av.id,
        type: 'relance',
        destinataire: av.telephone_paiement,
        variables: {
          commerce: av.enseigne,
          montant: Math.round(av.montant_restant),
          jours: av.jours_retard,
        },
      });
      await requete(contexte, `
        UPDATE app.avis_imposition
           SET nb_relances = nb_relances + 1, derniere_relance_le = now()
         WHERE id = $1`, [av.id]);
      bilan.relances += 1;
    } catch (err) {
      logger.warn({ err: err.message, avis: av.numero }, 'Relance non empilée');
      bilan.ignores += 1;
    }
  }

  return bilan;
}

module.exports = {
  verifierSignature,
  traiterEvenement,
  creerLienPaiement,
  lancerCampagne,
  relancerImpayes,
  CORRESPONDANCE_STATUTS,
};
