#!/usr/bin/env node
/**
 * Simulateur Wave — tester toute la chaîne de paiement sans compte Wave.
 *
 * Tant qu'aucun compte Wave Business n'est ouvert, l'API fabrique des liens de
 * paiement localement (`WAVE_SIMULER=true`). Ce script joue le rôle de Wave :
 * il signe et envoie au webhook les mêmes événements que le vrai service.
 *
 * Tout le reste de la chaîne est IDENTIQUE au mode réel — même table, même
 * vérification de signature, même rapprochement, même quittance. Le jour où la
 * clé arrive, seul le .env change.
 *
 * Usage :
 *   node scripts/simuler-wave.js liste
 *       Liste les liens de paiement en attente.
 *
 *   node scripts/simuler-wave.js payer <session_id> [montant]
 *       Simule un paiement réussi. Sans montant, paie la totalité.
 *
 *   node scripts/simuler-wave.js echouer <session_id>
 *   node scripts/simuler-wave.js expirer <session_id>
 *
 *   node scripts/simuler-wave.js tout-payer [--commune GTFC] [--taux 0.6]
 *       Paie une proportion des liens en attente. Sert à produire un jeu de
 *       données réaliste — carte avec du vert, de l'orange et du rouge.
 */
'use strict';

const crypto = require('crypto');
const config = require('../src/config/env');
const { pool, avecContexte } = require('../src/config/database');

/**
 * Toutes les lectures passent par le contexte super-admin.
 * Sans lui, le role applicatif gtfc_app ne voit AUCUNE ligne : les politiques
 * RLS de la migration 0014 filtrent par commune, et un script CLI n'a pas de
 * commune. C'est le comportement voulu — il faut juste le declarer.
 */
const SUPER = { superAdmin: true };
const lire = (sql, params = []) => avecContexte(SUPER, (client) => client.query(sql, params));

const URL_WEBHOOK = process.env.WEBHOOK_URL
  || `http://${config.serveur.host}:${config.serveur.port}/webhooks/wave`;

const couleur = {
  vert: (t) => `\x1b[32m${t}\x1b[0m`,
  rouge: (t) => `\x1b[31m${t}\x1b[0m`,
  jaune: (t) => `\x1b[33m${t}\x1b[0m`,
  gras: (t) => `\x1b[1m${t}\x1b[0m`,
};

const montantXof = (v) => `${Math.round(Number(v) || 0)
  .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;

/**
 * Envoie un événement au webhook, signé comme le ferait Wave.
 * On reproduit exactement le schéma attendu : `t=<timestamp>,v1=<hmac>` sur
 * `<timestamp>.<corps brut>`. Si la signature ne passe pas ici, elle ne
 * passera pas non plus en production.
 */
async function envoyerEvenement(type, donnees) {
  const corps = JSON.stringify({ type, data: donnees });
  const horodatage = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', config.wave.webhookSecret)
    .update(`${horodatage}.${corps}`)
    .digest('hex');

  const reponse = await fetch(URL_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Wave-Signature': `t=${horodatage},v1=${signature}`,
    },
    body: corps,
  });

  const resultat = await reponse.json().catch(() => null);
  return { statut: reponse.status, resultat };
}

async function lister() {
  const { rows } = await lire(`
    SELECT t.wave_session_id, t.montant, t.statut, t.initie_le, t.expire_le,
           t.telephone, a.numero AS avis, c.code, coalesce(c.enseigne, rd.designation) AS enseigne, m.code AS commune
      FROM app.transaction_wave t
      JOIN app.avis_imposition a ON a.id = t.avis_id
      LEFT JOIN app.commerce c ON c.id = a.commerce_id
      JOIN app.redevable rd ON rd.id = a.redevable_id
      JOIN app.commune m ON m.id = t.commune_id
     WHERE t.statut IN ('initiee', 'en_attente')
     ORDER BY t.initie_le DESC
     LIMIT 50`);

  if (rows.length === 0) {
    console.log(couleur.jaune('\n  Aucun lien de paiement en attente.\n'));
    console.log('  Pour en créer : lancez une campagne depuis le dashboard, ou');
    console.log('    POST /campagnes/:periode_id/lancer\n');
    return;
  }

  console.log(couleur.gras(`\n  ${rows.length} lien(s) de paiement en attente\n`));
  for (const r of rows) {
    console.log(`  ${couleur.gras(r.wave_session_id)}`);
    console.log(`      ${r.code} — ${r.enseigne}`);
    console.log(`      ${montantXof(r.montant)} · avis ${r.avis} · ${r.telephone ?? 'sans téléphone'}`);
    console.log(`      payer : node scripts/simuler-wave.js payer ${r.wave_session_id}`);
    console.log('');
  }
}

async function payer(sessionId, montantForce = null) {
  const { rows } = await lire(`
    SELECT t.montant, t.statut, a.montant_restant, c.code, coalesce(c.enseigne, rd.designation) AS enseigne
      FROM app.transaction_wave t
      JOIN app.avis_imposition a ON a.id = t.avis_id
      LEFT JOIN app.commerce c ON c.id = a.commerce_id
      JOIN app.redevable rd ON rd.id = a.redevable_id
     WHERE t.wave_session_id = $1`, [sessionId]);

  const transaction = rows[0];
  if (!transaction) {
    console.error(couleur.rouge(`\n  Session inconnue : ${sessionId}\n`));
    process.exitCode = 1;
    return;
  }
  if (transaction.statut === 'reussie') {
    console.log(couleur.jaune('\n  Cette session est déjà payée.\n'));
    return;
  }

  const montant = montantForce ?? transaction.montant;

  console.log(`\n  ${transaction.code} — ${transaction.enseigne}`);
  console.log(`  Paiement simulé de ${couleur.gras(montantXof(montant))}\n`);

  const { statut, resultat } = await envoyerEvenement('checkout_session_completed', {
    id: sessionId,
    amount: String(montant),
    currency: config.wave.devise,
    transaction_id: `sim_txn_${crypto.randomBytes(8).toString('hex')}`,
    when_completed: new Date().toISOString(),
    payment_status: 'succeeded',
  });

  if (statut === 200 && resultat?.donnees?.traite) {
    const d = resultat.donnees;
    console.log(couleur.vert('  Webhook accepté'));
    console.log(`      montant imputé : ${montantXof(d.montant_impute ?? 0)}`);
    if (d.deja) console.log(couleur.jaune('      (déjà encaissé — idempotence)'));
    console.log('\n  La quittance PDF sera produite par le planificateur dans les 10 minutes,');
    console.log('  ou immédiatement via GET /quittances/:id/pdf\n');
  } else {
    console.error(couleur.rouge(`  Webhook refusé (${statut})`));
    console.error(`  ${JSON.stringify(resultat)}\n`);
    if (statut === 401) {
      console.error(couleur.jaune(
        '  Signature invalide : WAVE_WEBHOOK_SECRET diffère entre ce script et l\'API.\n'));
    }
    process.exitCode = 1;
  }
}

async function changerStatut(sessionId, type, libelle) {
  const { statut, resultat } = await envoyerEvenement(type, { id: sessionId });
  if (statut === 200) {
    console.log(couleur.vert(`\n  ${libelle} — statut : ${resultat?.donnees?.statut ?? '?'}\n`));
  } else {
    console.error(couleur.rouge(`\n  Refusé (${statut}) : ${JSON.stringify(resultat)}\n`));
    process.exitCode = 1;
  }
}

/**
 * Paie une proportion des liens en attente.
 * Utile pour produire un jeu de données réaliste avant une démonstration à la
 * mairie : la carte doit montrer du vert, de l'orange et du rouge.
 */
async function toutPayer({ commune = null, taux = 0.6 }) {
  const params = [];
  let filtre = '';
  if (commune) {
    params.push(commune.toUpperCase());
    filtre = `AND m.code = $${params.length}`;
  }

  const { rows } = await lire(`
    SELECT t.wave_session_id, t.montant, c.code
      FROM app.transaction_wave t
      JOIN app.commune m ON m.id = t.commune_id
      JOIN app.avis_imposition a ON a.id = t.avis_id
      LEFT JOIN app.commerce c ON c.id = a.commerce_id
      JOIN app.redevable rd ON rd.id = a.redevable_id
     WHERE t.statut IN ('initiee', 'en_attente') ${filtre}
     ORDER BY c.code`, params);

  if (rows.length === 0) {
    console.log(couleur.jaune('\n  Aucun lien en attente.\n'));
    return;
  }

  console.log(couleur.gras(`\n  ${rows.length} lien(s) — ${Math.round(taux * 100)} % seront payés\n`));

  let complets = 0; let partiels = 0; let ignores = 0;

  for (const r of rows) {
    const tirage = Math.random();
    if (tirage > taux) { ignores += 1; continue; }

    // Un tiers des payeurs ne règle qu'une partie : c'est ce qui produit
    // l'orange sur la carte, et c'est réaliste.
    const partiel = Math.random() < 0.33;
    const montant = partiel
      ? Math.max(Math.round(Number(r.montant) * 0.4), 1)
      : r.montant;

    const { statut } = await envoyerEvenement('checkout_session_completed', {
      id: r.wave_session_id,
      amount: String(montant),
      currency: config.wave.devise,
      transaction_id: `sim_txn_${crypto.randomBytes(8).toString('hex')}`,
      when_completed: new Date().toISOString(),
    });

    if (statut === 200) {
      if (partiel) partiels += 1; else complets += 1;
      process.stdout.write(partiel ? couleur.jaune('~') : couleur.vert('.'));
    } else {
      process.stdout.write(couleur.rouge('x'));
    }
  }

  console.log(`\n\n  ${couleur.vert(`${complets} payés intégralement`)}`);
  console.log(`  ${couleur.jaune(`${partiels} payés partiellement`)}`);
  console.log(`  ${ignores} laissés impayés\n`);
}

// ---------------------------------------------------------------------------
async function principal() {
  const [commande, ...args] = process.argv.slice(2);

  if (!config.wave.webhookSecret) {
    console.error(couleur.rouge(
      '\n  WAVE_WEBHOOK_SECRET absent du .env — impossible de signer les événements.\n'));
    process.exit(1);
  }

  if (!config.wave.simuler && commande !== 'liste') {
    console.log(couleur.jaune(
      '\n  Attention : WAVE_SIMULER=false. Ce script envoie des événements SIGNÉS'));
    console.log(couleur.jaune(
      '  au webhook réel. À n\'utiliser que sur un environnement de test.\n'));
  }

  switch (commande) {
    case 'liste':
      await lister();
      break;
    case 'payer':
      if (!args[0]) { console.error('Usage : payer <session_id> [montant]'); process.exit(1); }
      await payer(args[0], args[1] ? Number(args[1]) : null);
      break;
    case 'echouer':
      if (!args[0]) { console.error('Usage : echouer <session_id>'); process.exit(1); }
      await changerStatut(args[0], 'checkout_session_payment_failed', 'Paiement en échec');
      break;
    case 'expirer':
      if (!args[0]) { console.error('Usage : expirer <session_id>'); process.exit(1); }
      await changerStatut(args[0], 'checkout_session_expired', 'Lien expiré');
      break;
    case 'tout-payer': {
      const i = args.indexOf('--commune');
      const j = args.indexOf('--taux');
      await toutPayer({
        commune: i !== -1 ? args[i + 1] : null,
        taux: j !== -1 ? Number(args[j + 1]) : 0.6,
      });
      break;
    }
    default:
      console.log(`
${couleur.gras('Simulateur Wave')} — tester la chaîne de paiement sans compte Wave

  ${couleur.gras('liste')}                          liens de paiement en attente
  ${couleur.gras('payer')} <session> [montant]      simule un paiement réussi
  ${couleur.gras('echouer')} <session>              simule un échec
  ${couleur.gras('expirer')} <session>              simule une expiration
  ${couleur.gras('tout-payer')} [--commune GTFC] [--taux 0.6]
                                 jeu de données réaliste pour la démonstration

  Webhook visé : ${URL_WEBHOOK}
  Mode         : ${config.wave.simuler ? couleur.jaune('SIMULATION') : couleur.vert(config.wave.environnement)}
`);
  }

  await pool.end();
}

principal().catch(async (err) => {
  console.error(couleur.rouge(`\n  Erreur : ${err.message}\n`));
  await pool.end().catch(() => {});
  process.exit(1);
});
