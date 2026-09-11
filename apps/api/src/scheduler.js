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
  const enveloppee = async (origine = 'planificateur') => {
    if (enCours.has(nom)) {
      logger.warn({ tache: nom }, 'Exécution précédente encore en cours — passage ignoré');
      return { ignore: true };
    }
    enCours.add(nom);
    const debut = Date.now();

    // Chaque exécution est consignée EN BASE, pas seulement dans le journal du
    // serveur. Une tâche qui échoue à trois heures du matin ne laissait qu'une
    // ligne dans un fichier que personne ne lit : elle pouvait échouer toutes
    // les nuits pendant des mois sans que rien ne le dise.
    let ligne = null;
    try {
      const { rows } = await db.requete(CONTEXTE,
        'INSERT INTO app.tache_planifiee (tache, origine) VALUES ($1, $2) RETURNING id',
        [nom, origine]);
      ligne = rows[0]?.id ?? null;
    } catch (err) {
      // Journaliser ne doit jamais empêcher la tâche de tourner.
      logger.warn({ tache: nom, err: err.message }, 'Journal des tâches indisponible');
    }

    const consigner = async (succes, resultat, erreur) => {
      if (!ligne) return;
      await db.requete(CONTEXTE, `
        UPDATE app.tache_planifiee
           SET termine_le = now(), duree_ms = $2, succes = $3,
               resultat = $4::jsonb, erreur = $5
         WHERE id = $1`,
      [ligne, Date.now() - debut, succes,
        resultat ? JSON.stringify(resultat) : null, erreur ?? null])
        .catch((e) => logger.warn({ err: e.message }, 'Consignation impossible'));
    };

    try {
      const resultat = await fn();
      logger.info({ tache: nom, duree_ms: Date.now() - debut, resultat }, 'Tâche terminée');
      await consigner(true, resultat, null);
      return { succes: true, resultat };
    } catch (err) {
      logger.error({ tache: nom, err, duree_ms: Date.now() - debut }, 'Tâche en échec');
      await consigner(false, null, String(err?.message ?? err).slice(0, 2000));
      return { succes: false, erreur: String(err?.message ?? err) };
    } finally {
      enCours.delete(nom);
    }
  };
  // Le nom voyage avec la fonction : sans lui, on ne peut pas désigner une
  // tâche depuis la ligne de commande.
  enveloppee.nomTache = nom;
  return enveloppee;
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
  // Cette tâche appelait d'abord `app.creer_partitions_position`, supprimée
  // avec le suivi de position des agents (migration 0042). L'appel est resté.
  //
  // Elle échouait donc AVANT d'arriver à la ligne suivante — celle qui compte.
  // Le journal d'audit est partitionné par mois et n'a pas de partition par
  // défaut : le mois où la dernière s'épuise, plus aucune écriture auditée ne
  // passe. Comme l'audit se déclenche sur toute écriture sensible, c'est le
  // système entier qui s'arrête, un premier du mois, sans prévenir.
  //
  // La seule trace aurait été une ligne de journal, à une heure du matin, le
  // 25 du mois précédent.
  const { rows: audit } = await db.requete(CONTEXTE,
    'SELECT audit.creer_partitions_journal(0, 4) AS nb');
  return { partitions_audit: audit[0].nb };
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
// 5 bis. Anonymisation des lectures publiques de QR — tous les jours, 03h30
//
// Une lecture de sticker par un PASSANT enregistre son adresse et son
// navigateur. La personne n'est ni redevable, ni agent : son adresse n'est
// nécessaire ni à l'identification du redevable, ni au recouvrement, et la
// conserver sans terme contrevient à la minimisation des données.
//
// L'événement subsiste — savoir qu'un sticker a été lu, quand, sur quel
// commerce, sert aux statistiques et à repérer un sticker arraché ou recopié.
// Seuls les identifiants du lecteur s'effacent, après une fenêtre courte qui
// laisse le temps de détecter une lecture massive et automatisée du registre.
//
// Les scans d'agent ne sont jamais touchés : l'action est professionnelle et
// sa traçabilité est un principe du dispositif.
// ---------------------------------------------------------------------------
const anonymiserScans = tache('scans-publics', async () => {
  const { rows } = await db.requete(CONTEXTE,
    'SELECT app.anonymiser_scans_publics(30) AS nb');
  return { lectures_anonymisees: rows[0].nb };
});

// ---------------------------------------------------------------------------
// 5 ter. Purge des accès au portail du redevable — tous les jours, 03h45
//
// CE QUI A ÉTÉ CONSTATÉ le 11/09/2026, en rédigeant la politique de
// confidentialité — c'est-à-dire en écrivant noir sur blanc ce que le logiciel
// conserve, et en le vérifiant table par table.
//
// app.purger_acces_expires() existait dans la base et N'ÉTAIT APPELÉE NULLE
// PART. Ni ici, ni dans une route, ni dans un script.
//
// Ce qu'elle devait nettoyer n'est pas anodin. app.code_acces conserve le
// NUMÉRO DE TÉLÉPHONE du commerçant et DEUX adresses IP — celle qui a demandé
// le code, celle qui l'a consommé. app.session_redevable garde une adresse IP
// et l'agent du navigateur. Sans purge, chaque demande de code jamais faite
// resterait indéfiniment : un registre des consultations de chaque commerçant,
// que rien ne justifie de conserver une fois le code expiré.
//
// Invisible sur la base de recette : elle a deux jours, aucune ligne n'a
// encore atteint la fenêtre de trente jours. Le défaut ne se serait manifesté
// qu'après un mois de production — et sous la forme d'une absence, donc
// jamais.
//
// La rétention est la même que pour les lectures publiques de QR : trente
// jours, de quoi enquêter sur un accès anormal, pas de quoi constituer un
// historique.
// ---------------------------------------------------------------------------
const purgerAccesPortail = tache('acces-portail', async () => {
  const { rows } = await db.requete(CONTEXTE,
    'SELECT * FROM app.purger_acces_expires(30)');
  return {
    codes_purges: rows[0].codes_purges,
    sessions_purgees: rows[0].sessions_purgees,
  };
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
  // La marge du journal d'audit n'est propre à aucune commune : c'est une
  // échéance d'infrastructure. Quand elle tombe à zéro, plus aucune écriture
  // sensible n'est possible — le système entier s'arrête, d'un coup, un
  // premier du mois. On la regarde tous les jours pour la voir venir de loin.
  const { rows: [marge] } = await db.requete(CONTEXTE, 'SELECT * FROM audit.marge_partitions()');
  if (marge?.alerte) {
    alertes.push({ commune: '—', controle: 'partitions_audit', detail: marge.alerte });
    logger.error({ marge }, marge.alerte);
  }

  return {
    alertes: alertes.length,
    detail: alertes,
    partitions_audit_mois_restants: marge?.mois_restants ?? null,
  };
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

        // Les echecs de campagne sont COLLECTES par wave.lancerCampagne, puis
        // ils etaient abandonnes ici : le journal des taches enregistrait
        // « succes: true » avec des compteurs a zero pendant que douze avis
        // echouaient dans les journaux du serveur.
        //
        // Ce journal existe precisement pour qu'une tache qui echoue a trois
        // heures du matin ne laisse pas qu'une ligne dans un fichier que
        // personne ne lit. Encore faut-il qu'il porte ce qui a echoue.
        //
        // Les trois premiers messages suffisent a orienter : au-dela, c'est
        // une panne generale, et le nombre le dit deja.
        erreurs_campagne: campagne.erreurs.length,
        detail_erreurs: campagne.erreurs.slice(0, 3),
      };

      if (campagne.erreurs.length > 0) {
        logger.warn(
          { commune: c.code, nombre: campagne.erreurs.length },
          "Campagne : des avis n'ont pas pu recevoir leur lien de paiement",
        );
      }

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
// ---------------------------------------------------------------------------
// 13. Feuilles de route du jour — tous les jours, 05h00
//
// Composées AVANT que les agents ne partent : un agent qui ouvre son
// application à six heures doit trouver sa journée prête.
//
// La route `/feuilles-de-route/moi` compose aussi à la volée, et c'est
// délibérément redondant. Si le planificateur n'a pas tourné — serveur
// redémarré, tâche en échec — l'agent ne reste pas devant une liste vide. La
// fonction est idempotente : les deux chemins ne peuvent pas se contredire.
//
// Un agent sans affectation reçoit une feuille VIDE, pas une erreur. C'est un
// fait à constater, pas une panne : il faut lui affecter un territoire.
// ---------------------------------------------------------------------------
const composerFeuilles = tache('feuilles-de-route', async () => {
  const { rows } = await db.requete(CONTEXTE, `
      SELECT u.id AS agent_id,
             app.composer_feuille_route(u.id, current_date) AS feuille_id
        FROM app.utilisateur u
       WHERE u.role = 'agent' AND u.actif AND u.archive_le IS NULL
       ORDER BY u.nom_complet`);

  const { rows: [compte] } = await db.requete(CONTEXTE, `
      -- Le meme filtre partout : sans lui, « 19 lignes dont 19 jamais_paye »
      -- alors qu'une est un ajout manuel et une autre retiree. Un decompte qui
      -- ne totalise pas son total ne veut rien dire.
      SELECT count(*) FILTER (WHERE l.retiree_le IS NULL)::int AS lignes,
             count(DISTINCT f.id)::int                          AS feuilles,
             count(*) FILTER (WHERE l.retiree_le IS NULL AND l.motif = 'jamais_paye')::int AS jamais_paye,
             count(*) FILTER (WHERE l.retiree_le IS NULL AND l.motif = 'fiche_a_completer')::int AS a_completer,
             count(*) FILTER (WHERE l.retiree_le IS NOT NULL)::int AS retirees
        FROM app.feuille_route f
        LEFT JOIN app.feuille_route_ligne l ON l.feuille_id = f.id
       WHERE f.date_tournee = current_date`);

  return {
    agents: rows.length,
    feuilles: compte.feuilles,
    lignes: compte.lignes,
    dont_jamais_paye: compte.jamais_paye,
    dont_fiche_a_completer: compte.a_completer,
    retirees: compte.retirees,
  };
});

// ---------------------------------------------------------------------------
// 14. Mémoire mensuelle des situations — le 1er du mois, 04h00
//
// Fige, pour chaque commerce facturé, sa situation à la fin du mois écoulé
// (FR-082). C'est le seul fondement autorisé de l'indicateur de risque : un
// classement calculé sur l'état courant changerait tout seul dès qu'un avis
// est annulé ou un versement repris.
//
// La fonction repart du PREMIER avis émis et rattrape tout mois qui manque.
// Un passage sauté — serveur arrêté, migration en cours — se répare donc au
// suivant, sans intervention et sans trou dans la mémoire.
//
// Elle refuse le mois courant : arrêter une situation qui va encore changer
// n'aurait aucun sens.
// ---------------------------------------------------------------------------
const arreterObservations = tache('observations-mensuelles', async () => {
  const { rows: communes } = await db.requete(CONTEXTE,
    'SELECT id, code FROM app.commune WHERE actif AND archive_le IS NULL');

  const resultats = {};
  let moisTotal = 0;
  let observationsTotal = 0;

  for (const c of communes) {
    const { rows } = await db.requete(CONTEXTE,
      'SELECT * FROM app.arreter_observations_dues($1)', [c.id]);
    resultats[c.code] = {
      mois_arretes: rows[0].mois_arretes,
      observations: rows[0].observations,
    };
    moisTotal += rows[0].mois_arretes;
    observationsTotal += rows[0].observations;
  }

  return {
    communes: communes.length,
    mois_arretes: moisTotal,
    observations: observationsTotal,
    detail: resultats,
  };
});

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
  ['30 3 * * *', anonymiserScans, 'Anonymisation des lectures publiques de QR'],
  ['45 3 * * *', purgerAccesPortail, 'Purge des accès expirés au portail'],
  ['0 * * * *', expirerTransactions, 'Expiration des liens de paiement'],
  ['30 6 * * *', controlerCoherence, 'Contrôle de cohérence quotidien'],
  ['0 5 * * *', composerFeuilles, 'Composition des feuilles de route du jour'],
  ['0 4 1 * *', arreterObservations, 'Mémoire mensuelle des situations'],
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

/**
 * Exécution à la demande, sans lancer le planificateur.
 *
 *     node src/scheduler.js --une-fois            toutes les tâches, une fois
 *     node src/scheduler.js --une-fois penalites  une seule
 *     node src/scheduler.js --lister              les noms disponibles
 *
 * Douze tâches tournent sans personne, à une heure du matin. Elles n'avaient
 * aucun moyen d'être déclenchées à la main : ni pour les éprouver, ni pour
 * rattraper une nuit manquée après une coupure. Attendre le prochain passage
 * était la seule option — jusqu'à un mois pour la facturation.
 */
async function uneFois(filtre) {
  const choisies = taches
    .map(([, fn, libelle]) => ({ nom: fn.nomTache, fn, libelle }))
    .filter((t) => !filtre || t.nom === filtre || t.libelle.toLowerCase().includes(filtre));

  if (choisies.length === 0) {
    console.error(`Aucune tâche ne correspond à « ${filtre} ».`);
    console.error(`Disponibles : ${taches.map(([, f]) => f.nomTache).join(', ')}`);
    process.exit(1);
  }

  let echecs = 0;
  for (const t of choisies) {
    process.stdout.write(`  ${t.libelle} … `);
    const bilan = await t.fn('manuel');
    if (bilan?.succes === false) {
      echecs += 1;
      console.log(`ÉCHEC — ${bilan.erreur}`);
    } else {
      console.log(`ok ${bilan?.resultat ? JSON.stringify(bilan.resultat) : ''}`);
    }
  }

  await db.fermer();
  console.log(`\n  ${choisies.length - echecs} réussie(s), ${echecs} en échec`);
  process.exit(echecs > 0 ? 1 : 0);
}

const argument = process.argv[2];
if (argument === '--lister') {
  for (const [cron, fn, libelle] of taches) {
    console.log(`  ${fn.nomTache.padEnd(22)} ${cron.padEnd(14)} ${libelle}`);
  }
  process.exit(0);
}
if (argument === '--une-fois') {
  uneFois(process.argv[3] ?? null).catch((err) => {
    console.error(`Échec : ${err.message}`);
    process.exit(1);
  });
} else {
  demarrer().catch((err) => {
    logger.fatal({ err }, 'Échec du démarrage du planificateur');
    process.exit(1);
  });
}
