'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exigerRole, exigerChefProjet } = require('../src/middleware/auth');

/**
 * Séparation des pouvoirs (Constitution III, FR-020e, FR-020j, FR-065).
 *
 * Le modèle n'est pas hiérarchique. Un chef de projet n'est pas « un
 * administrateur en plus fort » : il détient les décisions dérogatoires, que
 * personne d'autre n'a, et n'a pas la main sur le barème. Un ordre total
 * serait faux — et c'est ainsi qu'un super-administrateur finit par tout
 * pouvoir.
 */

function appeler(garde, role) {
  return new Promise((resolve) => {
    const req = { utilisateur: role ? { id: 'u1', role } : null };
    garde(req, {}, (err) => resolve(err ?? null));
  });
}

test('un rôle hors hiérarchie exigé par niveau échoue au démarrage', () => {
  // Sans ce garde-fou, NIVEAU['chef_projet'] vaudrait undefined et la
  // comparaison refuserait TOUT LE MONDE, silencieusement, à la première
  // requête en production.
  assert.throws(() => exigerRole('chef_projet'), /hors hiérarchie/);
});

test('un rôle inconnu exigé par niveau échoue au démarrage', () => {
  assert.throws(() => exigerRole('inspecteur_general'), /Rôle inconnu/);
});

test('seul le chef de projet passe le garde des dérogations', async () => {
  assert.equal(await appeler(exigerChefProjet, 'chef_projet'), null);
  for (const role of ['agent', 'superviseur', 'admin_commune', 'super_admin']) {
    const err = await appeler(exigerChefProjet, role);
    assert.ok(err, `${role} ne doit pas passer le garde des dérogations`);
  }
});

test("l'administrateur n'hérite pas des pouvoirs du chef de projet", async () => {
  // Le point le plus important : sur une échelle, admin_commune et
  // super_admin passeraient. Ils ne doivent pas.
  assert.ok(await appeler(exigerChefProjet, 'admin_commune'));
  assert.ok(await appeler(exigerChefProjet, 'super_admin'));
});

test('un utilisateur non authentifié est refusé', async () => {
  assert.ok(await appeler(exigerChefProjet, null));
});

test('la hiérarchie ordinaire fonctionne toujours', async () => {
  const gardeSuperviseur = exigerRole('superviseur');
  assert.equal(await appeler(gardeSuperviseur, 'superviseur'), null);
  assert.equal(await appeler(gardeSuperviseur, 'admin_commune'), null);
  assert.ok(await appeler(gardeSuperviseur, 'agent'));
});
