'use strict';
/**
 * Les vues échappaient à l'isolation par commune.
 *
 * CE QUI A ÉTÉ CONSTATÉ. Avec un contexte pointant une commune inexistante :
 *
 *     SET gtfc.commune_id = '00000000-0000-0000-0000-000000000000';
 *     SELECT count(*) FROM app.commerce;           -->  0 lignes
 *     SELECT count(*) FROM app.v_commerce_carte;   --> 69 lignes
 *
 * La table est protégée, la vue ne l'est pas : toutes appartiennent à
 * « postgres », qui porte BYPASSRLS, et une vue s'exécute par défaut avec les
 * droits de son PROPRIÉTAIRE. La sécurité au niveau des lignes ne s'appliquait
 * donc jamais aux tables lues au travers d'une vue.
 *
 * POURQUOI PERSONNE NE L'AVAIT VU. Il n'y a qu'une commune. Chaque page du
 * tableau de bord affichait exactement ce qu'elle devait afficher, et le
 * contrôle d'isolation existant vérifie que les TABLES portent bien leur
 * politique — ce qui était vrai. Le trou n'était pas dans les politiques : il
 * était dans le chemin qui les contourne.
 *
 * Ce fichier tient la porte fermée. Principe II de la constitution, marqué NON
 * NÉGOCIABLE : à la deuxième commune, chaque page alimentée par une vue aurait
 * montré les données de l'autre.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, enTransaction, fermer } = require('./aide');

test.after(async () => { await fermer(); });

// ===========================================================================
//  L'isolation, que les vues contournaient
// ===========================================================================

test('aucune vue ne contourne l\'isolation par commune', async () => {
  const fautives = await q('SELECT vue, table_protegee FROM app.v_controle_vues_isolees');
  assert.deepEqual(
    fautives, [],
    'Ces vues lisent une table protégée sans security_invoker : on lit par '
    + 'elles les données d\'une autre commune.\n'
    + fautives.map((f) => `  · ${f.vue} → ${f.table_protegee}`).join('\n'),
  );
});

test('le contrôle d\'isolation sait désigner une vue fautive', async () => {
  // Un contrôle qui ne peut pas se déclencher ne contrôle rien. On en fabrique
  // une, on vérifie qu'il la nomme, et la transaction l'emporte.
  await enTransaction(async (client) => {
    await client.query(
      'CREATE VIEW app.v_essai_isolation AS SELECT id, commune_id FROM app.commerce');
    const { rows } = await client.query(
      "SELECT vue FROM app.v_controle_vues_isolees WHERE vue = 'v_essai_isolation'");
    assert.equal(rows.length, 1,
      'le contrôle laisse passer une vue qui contourne manifestement la RLS');
  });
});
