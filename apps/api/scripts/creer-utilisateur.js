#!/usr/bin/env node
/**
 * Création d'un compte en ligne de commande.
 *
 * Sert à créer le PREMIER compte de la plateforme — le super-admin — alors
 * qu'aucune interface n'existe encore et qu'aucun compte ne permet de se
 * connecter pour en créer un. Sert aussi à débloquer un admin de mairie qui
 * s'est verrouillé hors de son propre dashboard.
 *
 * Usage :
 *   node scripts/creer-utilisateur.js --role super_admin \
 *        --nom Diop --prenom Amadou --telephone +221771234567
 *
 *   node scripts/creer-utilisateur.js --role admin_commune --commune GTFC \
 *        --nom Ndiaye --prenom Fatou --telephone +221771234568
 *
 * Le mot de passe est demandé de façon masquée, ou généré si l'on n'en
 * fournit pas. Il n'apparaît jamais dans l'historique du shell.
 */
'use strict';

const crypto = require('crypto');
const readline = require('readline');
const config = require('../src/config/env');
const { pool, avecContexte } = require('../src/config/database');

/** Contexte super-admin : voir la note dans simuler-wave.js. */
const SUPER = { superAdmin: true };
const lire = (sql, params = []) => avecContexte(SUPER, (client) => client.query(sql, params));
const auth = require('../src/services/auth.service');

const ROLES = ['agent', 'superviseur', 'admin_commune', 'super_admin'];

function lireArguments() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const cle = argv[i].slice(2);
      const valeur = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      args[cle] = valeur;
      if (valeur !== true) i += 1;
    }
  }
  return args;
}

function demander(question, masque = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!masque) {
      rl.question(question, (r) => { rl.close(); resolve(r.trim()); });
      return;
    }
    // Saisie masquée : le mot de passe ne doit pas rester lisible à l'écran
    // ni dans un partage d'écran pendant la formation des agents.
    process.stdout.write(question);
    const surStdin = (char) => {
      if (['\n', '\r', ''].includes(char.toString())) {
        process.stdin.removeListener('data', surStdin);
      } else {
        process.stdout.write('[2K[200D' + question + '*'.repeat(rl.line.length));
      }
    };
    process.stdin.on('data', surStdin);
    rl.question('', (r) => {
      rl.close();
      process.stdout.write('\n');
      resolve(r.trim());
    });
  });
}

/** Mot de passe généré : lisible à l'oral, sans caractère ambigu. */
function genererMotDePasse() {
  const majuscules = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const minuscules = 'abcdefghijkmnpqrstuvwxyz';
  const chiffres = '23456789';
  const tout = majuscules + minuscules + chiffres;
  const tirer = (source) => source[crypto.randomInt(source.length)];

  const base = [tirer(majuscules), tirer(minuscules), tirer(chiffres)];
  while (base.length < 12) base.push(tirer(tout));
  // Mélange de Fisher-Yates, avec une source aléatoire cryptographique
  for (let i = base.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join('');
}

async function principal() {
  const args = lireArguments();

  if (args.help || args.h) {
    console.log(`
Création d'un compte — plateforme GTFC

  --role <role>        agent | superviseur | admin_commune | super_admin  (obligatoire)
  --nom <nom>          Nom de famille                                     (obligatoire)
  --prenom <prenom>    Prénom                                             (obligatoire)
  --telephone <num>    Identifiant de connexion, ex. +221771234567        (obligatoire)
  --commune <code>     Code de la commune, ex. GTFC   (obligatoire sauf super_admin)
  --email <email>      Facultatif
  --matricule <code>   Facultatif
  --mot-de-passe <mdp> Facultatif — généré et affiché si absent
`);
    process.exit(0);
  }

  const role = args.role || await demander('Rôle (agent/superviseur/admin_commune/super_admin) : ');
  if (!ROLES.includes(role)) {
    console.error(`\n  ✗ Rôle invalide : ${role}\n    Valeurs acceptées : ${ROLES.join(', ')}\n`);
    process.exit(1);
  }

  const nom = args.nom || await demander('Nom : ');
  const prenom = args.prenom || await demander('Prénom : ');
  const telephone = args.telephone || await demander('Téléphone (+221...) : ');

  if (!/^\+?[0-9]{8,15}$/.test(telephone)) {
    console.error(`\n  ✗ Numéro de téléphone invalide : ${telephone}\n`);
    process.exit(1);
  }

  let communeId = null;
  if (role !== 'super_admin') {
    const codeCommune = args.commune || await demander('Code de la commune (ex. GTFC) : ');
    const { rows } = await lire(
      'SELECT id, nom FROM app.commune WHERE code = $1 AND archive_le IS NULL',
      [codeCommune.toUpperCase()],
    );
    if (!rows[0]) {
      console.error(`\n  ✗ Commune « ${codeCommune} » introuvable.`
        + '\n    Communes existantes :');
      const { rows: liste } = await lire(
        'SELECT code, nom FROM app.commune WHERE archive_le IS NULL ORDER BY code');
      liste.forEach((c) => console.error(`      ${c.code}  ${c.nom}`));
      console.error('');
      process.exit(1);
    }
    communeId = rows[0].id;
    console.log(`  Commune : ${rows[0].nom}`);
  }

  let motDePasse = args['mot-de-passe'];
  let genere = false;
  if (!motDePasse) {
    motDePasse = await demander('Mot de passe (vide = généré) : ', true);
    if (!motDePasse) { motDePasse = genererMotDePasse(); genere = true; }
  }
  if (motDePasse.length < 10) {
    console.error('\n  ✗ Le mot de passe doit faire au moins 10 caractères\n');
    process.exit(1);
  }

  const hash = await auth.hacherMotDePasse(motDePasse);

  // L'insertion passe par le contexte super-admin : sans lui, la politique RLS
  // de app.utilisateur refuserait la ligne, et le tout premier compte de la
  // plateforme serait impossible à créer.

  const { rows } = await lire(`
    INSERT INTO app.utilisateur (
      commune_id, matricule, nom, prenom, telephone, email, role,
      mot_de_passe_hash, doit_changer_mdp, actif
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true)
    RETURNING id, nom_complet, telephone, role`,
  [communeId, args.matricule ?? null, nom, prenom, telephone,
    args.email ?? null, role, hash]).catch((err) => {
    if (err.code === '23505') {
      console.error(`\n  ✗ Un compte actif utilise déjà le numéro ${telephone}\n`);
    } else if (err.code === '42501') {
      console.error('\n  ✗ Droits insuffisants. Ce script doit tourner sur le serveur, '
        + 'avec le .env de la plateforme.\n');
    } else {
      console.error(`\n  ✗ ${err.message}\n`);
    }
    process.exit(1);
  });

  console.log(`
  ✓ Compte créé

    Nom        : ${rows[0].nom_complet}
    Rôle       : ${rows[0].role}
    Téléphone  : ${rows[0].telephone}
    ${genere ? `Mot de passe : ${motDePasse}` : 'Mot de passe : (celui que vous avez saisi)'}

  ${genere ? 'Notez ce mot de passe MAINTENANT : il ne sera plus affiché.\n' : ''}
  Le changement de mot de passe sera exigé à la première connexion.
`);

  await pool.end();
}

principal().catch((err) => {
  console.error('\n  ✗ Erreur :', err.message, '\n');
  process.exit(1);
});
