/**
 * Tâches planifiées applicatives.
 *
 * Processus séparé de l'API, en UNE SEULE instance (voir ecosystem.config.js) :
 * l'API tourne en mode cluster sur plusieurs cœurs, et si le planificateur y
 * vivait, chaque worker enverrait sa propre facture au même commerçant.
 *
 * Onze tâches : entretien de la base, facturation mensuelle, relances,
 * notifications et production des quittances PDF.
 
 */
'use strict';

const cron = require('node-cron');
const config = require('./config/env');
const logger = require('./config/logger');
const db = require('./config/database');
const wave = require('./services/wave.service');
const notifications = require('./services/notification.service');
const pdf = require('./services/pdf.service');

const CONTEXTE = { superAdmin: true };
const OPTIONS = { timezone: config.timezone };

let enCours = new Set();

/**
 * Enveloppe une tâche : journalisation, mesure de durée, non-réentrance.
 * Sans le verrou, une tâche lente pourrait se chevaucher avec elle-même au
 * déclenchement suivant.
 */
function tache(nom, fn) {
  return async () => {
    if (enCours.has(nom)) {
      logger.warn({ tache: nom }, 'Exécution précédente encore en cours — passage ignoré');
      return;
    }
    enCours.add(nom);
    const debut = Date.now();
    try {
      const resultat = await fn();
      logger.info({ tache: nom, duree_ms: Date.now() - debut, resultat }, 'Tâche terminée');
    } catch (err) {
      logger.error({ tache: nom, err, duree_ms: Date.now() - debut }, 'Tâche en échec');
    } finally {
      enCours.delete(nom);
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Partitions mensuelles — 25 de chaque mois, 01h00
//
// Sans partition disponible pour le mois suivant, TOUT enregistrement de
// position d'agent ou d'entrée d'audit échoue. On les crée trois mois à
// l'avance : même si le serveur reste éteint plusieurs semaines, il y a de
// la marge.
// ---------------------------------------------------------------------------
const creerPartitions = tache('partitions', async () => {
  const { rows: positions } = await db.requete(CONTEXTE,
    'SELECT app.creer_partitions_position(0, 4) AS nb');
  const { rows: audit } = await db.requete(CONTEXTE,
    'SELECT audit.creer_partitions_journal(0, 4) AS nb');
  return { partitions_positions: positions[0].nb, partitions_audit: audit[0].nb };
});

// ---------------------------------------------------------------------------
// 2. Périodes fiscales — 25 de chaque mois, 01h30
//
// La période est ANNUELLE depuis 0046. La tâche crée celle de l'année en
// cours si elle manque, et celle de l'année suivante dès décembre : une
// liquidation ne doit jamais buter sur une période absente au 1er janvier.
// ---------------------------------------------------------------------------
const preparerPeriodes = tache('periodes', async () => {
  const { rows: communes } = await db.requete(CONTEXTE,
    'SELECT id, code FROM app.commune WHERE actif AND archive_le IS NULL');

  const maintenant = new Date();
  const annees = [maintenant.getFullYear()];
  if (maintenant.getMonth() === 11) annees.push(maintenant.getFullYear() + 1);

  const creees = [];
  for (const c of communes) {
    for (const annee of annees) {
      await db.requete(CONTEXTE, 'SELECT app.creer_periode_annuelle($1, $2)', [c.id, annee]);
      creees.push(`${c.code} ${annee}`);
    }
  }
  return { periodes: creees };
});

// ---------------------------------------------------------------------------
// 3. Pénalités de retard — tous les jours, 02h00
// ---------------------------------------------------------------------------
const appliquerPenalites = tache('penalites', async () => {
  const { rows: communes } = await db.requete(CONTEXTE,
    'SELECT id, code FROM app.commune WHERE actif AND archive_le IS NULL');

  const resultats = {};
  for (const c of communes) {
    const { rows } = await db.requete(CONTEXTE, 'SELECT app.appliquer_penalites($1) AS nb', [c.id]);
    resultats[c.code] = rows[0].nb;
  }
  return resultats;
});

// ---------------------------------------------------------------------------
// 4. Statuts fiscaux — tous les jours, 02h30
//
// Les statuts sont normalement recalculés à chaque paiement par un
// déclencheur. Ce passage nocturne rattrape les changements qui ne passent
// pas par un paiement : une exonération expirée, un avis devenu exigible.
// ---------------------------------------------------------------------------
const recalculerStatuts = tache('statuts_fiscaux', async () => {
  const { rows } = await db.requete(CONTEXTE, `
    SELECT count(*)::int AS nb FROM (
      SELECT app.recalculer_statut_fiscal(c.id)
        FROM app.commerce c
       WHERE c.archive_le IS NULL
         AND (c.statut_fiscal_calcule_le IS NULL
              OR c.statut_fiscal_calcule_le < current_date)
    ) x`);
  return { commerces_recalcules: rows[0].nb };
});

// ---------------------------------------------------------------------------
// 5. Purge des sessions expirées — tous les dimanches, 03h00
// ---------------------------------------------------------------------------
const purgerSessions = tache('sessions', async () => {
  const { rows } = await db.requete(CONTEXTE, 'SELECT app.purger_sessions_expirees() AS nb');
  return { sessions_supprimees: rows[0].nb };
});

// ---------------------------------------------------------------------------
// 6. Transactions Wave expirées — toutes les heures
// Un lien de paiement non honoré dans les 24 h est marqué expiré, sinon il
// resterait indéfiniment « en attente » dans les statistiques.
// ---------------------------------------------------------------------------
const expirerTransactions = tache('transactions_wave', async () => {
  const { rowCount } = await db.requete(CONTEXTE, `
    UPDATE app.transaction_wave
       SET statut = 'expiree'
     WHERE statut IN ('initiee', 'en_attente')
       AND expire_le IS NOT NULL AND expire_le < now()`);
  return { transactions_expirees: rowCount };
});

// ---------------------------------------------------------------------------
// 7. Contrôle de cohérence — tous les jours, 06h30
// Journalise ce qui cloche AVANT l'arrivée des agents, pour qu'un
// responsable puisse réagir dans la matinée.
// ---------------------------------------------------------------------------
const controlerCoherence = tache('coherence', async () => {
  const { rows: communes } = await db.requete(CONTEXTE,
    'SELECT id, code FROM app.commune WHERE actif AND archive_le IS NULL');

  const alertes = [];
  for (const c of communes) {
    const { rows } = await db.requete(CONTEXTE, 'SELECT * FROM app.verifier_coherence($1)', [c.id]);
    for (const controle of rows.filter((r) => r.gravite === 'erreur')) {
      alertes.push({ commune: c.code, ...controle });
      logger.warn({ commune: c.code, controle: controle.controle, nb: controle.nb },
        'Contrôle de cohérence en erreur');
    }
  }
  return { alertes: alertes.length, detail: alertes };
});

// ---------------------------------------------------------------------------
// 8. Liquidation annuelle — le 1er du mois, 03h30
//
// La taxe est liquidée UNE FOIS PAR AN (FR-021). La somme constitue un solde
// que le redevable résorbe à son rythme : en une fois, par mensualités, ou
// par versements de son choix. Il peut payer en avance.
//
// La tâche tourne néanmoins tous les mois, et c'est voulu : elle est
// idempotente, et un commerce recensé en cours d'année doit être liquidé
// sans attendre janvier prochain.
//
// La notification mensuelle, elle, reste mensuelle : elle rappelle le solde
// et porte le lien Wave, sans créer d'échéance opposable.
// ---------------------------------------------------------------------------
const facturerLeMois = tache('liquidation_annuelle', async () => {
  const { rows: communes } = await db.requete(CONTEXTE,
    'SELECT id, code FROM app.commune WHERE actif AND archive_le IS NULL');

  const resultats = {};
  const maintenant = new Date();

  for (const c of communes) {
    const contexte = { superAdmin: true, communeId: c.id };
    try {
      const periodeId = (await db.requete(contexte,
        'SELECT app.creer_periode_annuelle($1, $2) AS id',
        [c.id, maintenant.getFullYear()])).rows[0].id;

      const generation = (await db.requete(contexte,
        'SELECT * FROM app.generer_avis_periode($1, NULL)', [periodeId])).rows[0];

      const emission = await db.requete(contexte, `
        UPDATE app.avis_imposition
           SET statut = 'emis', date_emission = current_date
         WHERE periode_id = $1 AND statut = 'brouillon' AND montant_total > 0
         RETURNING id`, [periodeId]);

      const campagne = await wave.lancerCampagne(contexte, { periodeId });

      resultats[c.code] = {
        avis: generation.nb_avis,
        lignes: generation.nb_lignes,
        montant_attendu: generation.montant_total,
        erreurs_generation: generation.nb_erreurs,
        emis: emission.rowCount,
        liens: campagne.liens_crees,
        notifications: campagne.notifications,
        sans_telephone: campagne.sans_telephone.length,
      };

      if (campagne.sans_telephone.length > 0) {
        logger.warn(
          { commune: c.code, nombre: campagne.sans_telephone.length },
          'Commerces sans numéro de téléphone : ils ne recevront pas de lien Wave',
        );
      }
    } catch (err) {
      logger.error({ commune: c.code, err: err.message }, 'Facturation mensuelle en échec');
      resultats[c.code] = { erreur: err.message };
    }
  }

  return resultats;
});

// ---------------------------------------------------------------------------
// 9. Relance des impayés — tous les lundis, 08h00
// Lundi matin : le commerçant a la semaine devant lui pour régulariser.
// ---------------------------------------------------------------------------
const relancerImpayes = tache('relances', async () => {
  const { rows: communes } = await db.requete(CONTEXTE,
    'SELECT id, code FROM app.commune WHERE actif AND archive_le IS NULL');

  const resultats = {};
  for (const c of communes) {
    resultats[c.code] = await wave.relancerImpayes(
      { superAdmin: true, communeId: c.id }, { joursRetardMin: 3 });
  }
  return resultats;
});

// ---------------------------------------------------------------------------
// 10. File de notifications — toutes les 15 minutes
// ---------------------------------------------------------------------------
const traiterNotifications = tache('notifications', async () => {
  const { rows: communes } = await db.requete(CONTEXTE,
    'SELECT id, code FROM app.commune WHERE actif AND archive_le IS NULL');

  const resultats = {};
  for (const c of communes) {
    resultats[c.code] = await notifications.traiterFile(
      { superAdmin: true, communeId: c.id }, { limite: 200 });
  }
  return resultats;
});

// ---------------------------------------------------------------------------
// 11. Quittances PDF manquantes — toutes les 10 minutes
//
// Le webhook Wave crée la LIGNE de quittance mais pas le PDF : générer un
// document exigerait MinIO, et un stockage momentanément indisponible ferait
// échouer l'encaissement d'un paiement déjà encaissé par Wave. On rattrape ici.
// ---------------------------------------------------------------------------
const genererQuittancesManquantes = tache('quittances_pdf', async () => {
  const { rows } = await db.requete(CONTEXTE, `
    SELECT q.id, q.paiement_id, q.commune_id, q.numero
      FROM app.quittance q
      JOIN app.paiement p ON p.id = q.paiement_id
     WHERE q.chemin_pdf IS NULL AND p.annule_le IS NULL
     ORDER BY q.genere_le
     LIMIT 100`);

  let produites = 0;
  const echecs = [];

  for (const q of rows) {
    try {
      await pdf.genererQuittance({ superAdmin: true, communeId: q.commune_id }, q.paiement_id);
      produites += 1;
    } catch (err) {
      echecs.push({ numero: q.numero, message: err.message });
    }
  }

  if (echecs.length > 0) {
    logger.warn({ echecs: echecs.slice(0, 5), total: echecs.length },
      'Quittances non générées — vérifiez MinIO');
  }
  return { en_attente: rows.length, produites, echecs: echecs.length };
});

// ===========================================================================
//  Programmation
// ===========================================================================
const taches = [
  ['0 1 25 * *', creerPartitions, 'Création des partitions mensuelles'],
  ['30 1 25 * *', preparerPeriodes, 'Préparation des périodes fiscales'],
  ['0 2 * * *', appliquerPenalites, 'Application des pénalités de retard'],
  ['30 2 * * *', recalculerStatuts, 'Recalcul des statuts fiscaux'],
  ['30 3 1 * *', facturerLeMois, 'Facturation mensuelle (avis + liens + notifications)'],
  ['0 8 * * 1', relancerImpayes, 'Relance hebdomadaire des impayés'],
  ['*/15 * * * *', traiterNotifications, 'Traitement de la file de notifications'],
  ['*/10 * * * *', genererQuittancesManquantes, 'Génération des quittances PDF'],
  ['0 3 * * 0', purgerSessions, 'Purge des sessions expirées'],
  ['0 * * * *', expirerTransactions, 'Expiration des liens de paiement'],
  ['30 6 * * *', controlerCoherence, 'Contrôle de cohérence quotidien'],
];

async function demarrer() {
  logger.info({ tz: config.timezone }, 'Démarrage du planificateur');

  try {
    await db.verifierConnexion();
  } catch (err) {
    logger.fatal({ err: err.message }, 'PostgreSQL injoignable — planificateur arrêté');
    process.exit(1);
  }

  for (const [expression, fn, description] of taches) {
    cron.schedule(expression, fn, OPTIONS);
    logger.info({ cron: expression, tache: description }, 'Tâche programmée');
  }

  if (config.wave.simuler) {
    logger.warn(
      'Wave en SIMULATION : les liens de paiement sont fabriqués localement, aucun '
      + 'appel n\'est fait à Wave. Renseignez WAVE_API_KEY et WAVE_ACTIF=true pour '
      + 'passer en sandbox réel.',
    );
  }

  // Au démarrage, on s'assure immédiatement que les partitions existent :
  // après une coupure longue, elles peuvent manquer et tout écrirait en erreur.
  await creerPartitions();

  if (process.send) process.send('ready');
  logger.info(`Planificateur actif — ${taches.length} tâches programmées`);
}

async function arreter(signal) {
  logger.info({ signal }, 'Arrêt du planificateur');
  for (const t of cron.getTasks().values()) t.stop();

  // On laisse une tâche en cours se terminer : interrompre une génération
  // d'avis à mi-parcours laisserait la base dans un état difficile à lire.
  let attente = 0;
  while (enCours.size > 0 && attente < 20000) {
    logger.info({ taches: [...enCours] }, 'Attente de la fin des tâches en cours');
    await new Promise((r) => { setTimeout(r, 1000); });
    attente += 1000;
  }

  await db.fermer();
  process.exit(0);
}

process.on('SIGTERM', () => arreter('SIGTERM'));
process.on('SIGINT', () => arreter('SIGINT'));
process.on('unhandledRejection', (raison) => logger.error({ raison }, 'Promesse rejetée'));

demarrer().catch((err) => {
  logger.fatal({ err }, 'Échec du démarrage du planificateur');
  process.exit(1);
});
