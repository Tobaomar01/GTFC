'use strict';
/**
 * Le code à usage unique ne doit jamais transiter par la réponse HTTP.
 *
 * Sans passerelle SMS raccordée, le code est SIMULÉ : écrit dans le journal, et
 * renvoyé dans la réponse du portail pour permettre les essais. C'est commode
 * en développement, et c'est une porte ouverte en production — quiconque
 * connaît le numéro d'un commerçant demande un code, le lit dans la réponse,
 * et ouvre son dossier fiscal : montants dus, historique, adresse.
 *
 * `SMS_ACTIF` vaut faux par défaut. L'oubli était donc le cas le plus
 * probable, et son coût une usurpation d'identité silencieuse.
 *
 * Le commentaire du service SMS annonçait un garde-fou — « ce mode refuse de
 * s'activer en production sans SMS_SIMULER_EN_PROD explicite » — qui n'avait
 * jamais été écrit. Ces tests le tiennent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const RACINE = path.resolve(__dirname, '../../..');

/** Démarre l'API avec un environnement donné, et rend ce qu'elle en dit. */
function tenterDemarrage(env) {
  try {
    execFileSync(process.execPath, ['-e', "require('./apps/api/src/config/env.js')"], {
      cwd: RACINE,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    });
    return { demarre: true, sortie: '' };
  } catch (e) {
    return {
      demarre: false,
      sortie: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    };
  }
}

test('en production sans passerelle SMS, l\'API refuse de démarrer', async () => {
  const r = tenterDemarrage({ NODE_ENV: 'production', SMS_ACTIF: 'false',
    SMS_SIMULER_EN_PROD: '', CORS_ORIGINS: 'https://exemple.sn' });
  assert.equal(r.demarre, false,
    'un démarrage silencieux laisserait le code à usage unique en clair dans les réponses');
  assert.match(r.sortie, /SMS_ACTIF/,
    `le motif du refus doit être explicite : ${r.sortie.slice(0, 300)}`);
});

test('elle démarre si la simulation est assumée explicitement', async () => {
  // On ne bloque pas un choix éclairé : on exige qu'il soit écrit.
  const r = tenterDemarrage({ NODE_ENV: 'production', SMS_ACTIF: 'false',
    SMS_SIMULER_EN_PROD: 'true', CORS_ORIGINS: 'https://exemple.sn' });
  assert.match(r.sortie, /^(?!.*SMS_ACTIF)/s,
    `le refus ne doit plus porter sur le SMS : ${r.sortie.slice(0, 300)}`);
});

test('hors production, la simulation reste permise sans rien déclarer', async () => {
  // Le poste de développement ne doit pas exiger de cérémonie.
  const r = tenterDemarrage({ NODE_ENV: 'development', SMS_ACTIF: 'false' });
  assert.equal(r.demarre, true, `l'API doit démarrer en développement : ${r.sortie.slice(0, 200)}`);
});

test('la réponse du portail ne porte le code qu\'hors production', async () => {
  // Second verrou, indépendant du premier : même forcée, la configuration ne
  // doit pas suffire à faire transiter un code par HTTP.
  const source = require('node:fs')
    .readFileSync(require.resolve('../src/routes/portail.routes'), 'utf8');
  const i = source.indexOf('code_simule');
  assert.ok(i > 0, 'le champ code_simule doit exister pour être encadré');
  const contexte = source.slice(Math.max(0, i - 400), i);
  assert.match(contexte, /!config\.production/,
    'le code simulé doit être conditionné à l\'absence de production');
});
