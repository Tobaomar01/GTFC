'use strict';
/**
 * Ce que le logiciel promet de ne PAS garder, il doit cesser de le garder.
 *
 * CE QUI A ÉTÉ CONSTATÉ le 11/09/2026, en rédigeant la politique de
 * confidentialité — c'est-à-dire en écrivant noir sur blanc ce que le logiciel
 * conserve, et en le vérifiant table par table plutôt qu'en recopiant un
 * modèle.
 *
 * app.purger_acces_expires() existait dans la base et n'était appelée NULLE
 * PART. Ni par le planificateur, ni par une route, ni par un script.
 *
 * Ce qu'elle devait nettoyer n'est pas anodin : app.code_acces conserve le
 * numéro de téléphone du commerçant et DEUX adresses IP — celle qui a demandé
 * le code, celle qui l'a consommé. app.session_redevable garde une adresse IP
 * et l'agent du navigateur. Sans purge, chaque demande de code jamais faite
 * restait indéfiniment : un registre des consultations de chaque commerçant,
 * que rien ne justifie de conserver une fois le code expiré.
 *
 * POURQUOI RIEN NE LE VOYAIT. La base de recette a deux jours ; aucune ligne
 * n'avait atteint la fenêtre de trente jours. Le défaut ne se serait manifesté
 * qu'après un mois de production, et sous la forme d'une ABSENCE — donc jamais.
 *
 * Ce test fabrique le temps qui manquait : il insère des lignes déjà vieilles.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, fermer } = require('./aide');

const MARQUE = `+2217799${String(Date.now()).slice(-6)}`;

test.after(fermer);

test('la purge des accès au portail est bien programmée', async () => {
  // Une fonction que personne n'appelle ne protège personne. C'est exactement
  // ce qui était le cas, et rien ne le signalait.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');

  assert.match(source, /purger_acces_expires/,
    'le planificateur n\'appelle pas app.purger_acces_expires : les numéros de '
    + 'téléphone et les adresses IP des demandes de code sont conservés sans terme');

  // Et elle doit figurer dans la TABLE des tâches, pas seulement être définie :
  // une fonction déclarée et non programmée ne s'exécute pas davantage.
  assert.match(source, /purgerAccesPortail,\s*'Purge des accès expirés au portail'/,
    'la tâche existe mais n\'est pas inscrite au calendrier');
});

test('une demande de code vieille de plus de 30 jours est effacée', async () => {
  const commune = await un('SELECT id FROM app.commune ORDER BY cree_le LIMIT 1');
  const redevable = await un(
    'SELECT id FROM app.redevable WHERE commune_id = $1 LIMIT 1', [commune.id]);
  assert.ok(redevable, 'le jeu de démonstration doit porter au moins un redevable');

  // Deux lignes : une vieille de 40 jours, une d'hier. Sans la seconde, le
  // test passerait aussi sur une purge qui efface TOUT — ce qui serait un
  // défaut d'une autre nature, et pire.
  // La table impose `expire_le > cree_le` et n'accepte que deux usages : on
  // fabrique donc un code CRÉÉ il y a 41 jours et EXPIRÉ il y a 40.
  await q(`
    INSERT INTO app.code_acces (commune_id, redevable_id, telephone, code_empreinte,
                                sel, usage, expire_le, cree_le)
    VALUES ($1, $2, $3, 'empreinte-test', 'sel-test', 'connexion',
            now() - interval '40 days', now() - interval '41 days'),
           ($1, $2, $3, 'empreinte-test', 'sel-test', 'connexion',
            now() + interval '1 hour', now() - interval '1 day')`,
  [commune.id, redevable.id, MARQUE]);

  const avant = await un(
    'SELECT count(*)::int AS n FROM app.code_acces WHERE telephone = $1', [MARQUE]);
  assert.equal(avant.n, 2, 'les deux lignes de l\'épreuve doivent exister');

  await q('SELECT app.purger_acces_expires(30)');

  const restantes = await q(
    'SELECT expire_le FROM app.code_acces WHERE telephone = $1', [MARQUE]);

  assert.equal(restantes.length, 1,
    `${restantes.length} ligne(s) après purge au lieu d'une : la demande de code `
    + 'de plus de trente jours n\'a pas été effacée, ou la purge a trop effacé');
  assert.ok(new Date(restantes[0].expire_le) > new Date(),
    'la purge a gardé la mauvaise ligne : c\'est la valide qui devait survivre');

  // On ne laisse rien derrière soi.
  await q('DELETE FROM app.code_acces WHERE telephone = $1', [MARQUE]);
});

test('les lectures publiques de QR cessent d\'identifier leur lecteur', async () => {
  // Même promesse, autre table. Celle-ci EST programmée depuis toujours — le
  // test existe pour qu'elle le reste, et pour que la politique de
  // confidentialité ne se mette pas à mentir au premier remaniement.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');
  assert.match(source, /anonymiserScans,\s*'Anonymisation des lectures publiques de QR'/,
    'l\'anonymisation des scans publics n\'est plus programmée');

  const fonction = await un(`
    SELECT 1 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app' AND p.proname = 'anonymiser_scans_publics'`);
  assert.ok(fonction, 'app.anonymiser_scans_publics a disparu de la base');
});
