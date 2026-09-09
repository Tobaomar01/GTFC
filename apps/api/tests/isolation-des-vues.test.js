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

// ===========================================================================
//  Une taxe qui ne revient pas à la commune ne doit pas être réclamée
//
//  La patente a été remplacée en 2018 par la CEL, établie et recouvrée par la
//  DGID. La migration 0023 l'avait désactivée — sans effet : ref.type_taxe
//  n'est peuplée que par les seeds, et migrate.sh joue les seeds APRÈS les
//  migrations. Sur toute base neuve, 0023 mettait à jour zéro ligne, était
//  consignée comme appliquée, et le seed réinsérait la patente active.
//
//  Ce test ne protège pas une ligne de code : il protège l'ORDRE dans lequel
//  la base se construit. C'est cet ordre qui a rendu la migration inopérante,
//  et rien dans un fichier SQL ne le laisse voir.
// ===========================================================================

test('aucune taxe désactivée n\'est réclamée par une commune', async () => {
  const fautives = await q('SELECT commune, taxe FROM app.v_controle_taxes_desactivees');
  assert.deepEqual(fautives, [],
    'une taxe désactivée nationalement est rattachée ACTIVE à une commune : '
    + 'un agent la réclamerait, et le redevable aurait raison de contester');
});

test('la patente n\'est plus proposée nulle part', async () => {
  const [active] = await q(
    "SELECT actif FROM ref.type_taxe WHERE code = 'patente'");
  assert.equal(active?.actif, false,
    'le type « patente » est actif : il a été remplacé par la CEL (DGID) en 2018');

  const rattachee = await q(`
    SELECT c.slug FROM ref.commune_type_taxe ctt
      JOIN ref.type_taxe t ON t.id = ctt.type_taxe_id
      JOIN app.commune   c ON c.id = ctt.commune_id
     WHERE t.code = 'patente' AND ctt.actif`);
  assert.deepEqual(rattachee, [],
    'la patente est active pour au moins une commune');
});

// ===========================================================================
//  Ce que l'application a le droit de lire
//
//  Les droits sont accordés UNE FOIS, en migration 0016, par
//  « GRANT ... ON ALL TABLES IN SCHEMA ». Cela ne vaut que pour ce qui existe
//  à cet instant : tout objet créé par une migration ultérieure n'est jamais
//  couvert, sauf si sa propre migration y pense.
//
//  Sept ne l'avaient pas fait — dont app.decision_derogatoire, la TABLE des
//  dérogations. Sur une base neuve, la fonctionnalité entière était
//  inaccessible à l'application, et six tests tombaient sur
//  « permission denied ».
//
//  Rien ne le signalait : la base de travail, construite au fil des mois,
//  avait reçu ces droits d'une façon ou d'une autre. Seule une base
//  RECONSTRUITE montrait le manque — et c'est celle qu'on déploie.
// ===========================================================================

test('l\'application peut lire tous les objets de app, ref et audit', async () => {
  const illisibles = await q(
    'SELECT schema, objet, nature FROM app.v_controle_droits_applicatifs ORDER BY schema, objet');
  assert.deepEqual(illisibles, [],
    'des objets sont illisibles par le rôle applicatif : toute page ou route '
    + 'qui s\'en sert répondra « permission denied » en production');
});
