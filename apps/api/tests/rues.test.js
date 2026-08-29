'use strict';
/**
 * Le référentiel des rues, et ce qu'il engage.
 *
 * Cent voies composent le référentiel : quinze déduites du PDC, quatre-vingt-
 * cinq extraites d'OpenStreetMap — une source bénévole, précieuse et
 * faillible. L'outil d'import annonçait dans son en-tête que chaque rue
 * importée serait « marquée à valider » et figurerait à l'inventaire des
 * données à compléter. Il n'en était rien : la route ne posait aucun
 * indicateur, et l'inventaire ne connaissait pas les rues.
 *
 * Ce n'est pas une question de forme. Le taux de collecte PAR RUE est une des
 * lectures principales du tableau de bord, et il servira à décider où envoyer
 * les agents. Bâti sur des noms que la mairie n'a jamais relus, il sera
 * contesté le jour où il désignera un quartier.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, enTransaction, fermer } = require('./aide');

test.after(fermer);

test('le référentiel porte de vraies voies, avec leur tracé', async () => {
  const r = await un(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE geom IS NOT NULL)::int AS tracees,
           count(*) FILTER (WHERE source = 'osm')::int AS osm
      FROM app.rue WHERE archive_le IS NULL`);

  assert.ok(r.total >= 50,
    `${r.total} rues seulement : le référentiel n'a pas été importé`);
  assert.ok(r.tracees >= r.osm,
    'les voies importées d\'OpenStreetMap doivent toutes porter leur tracé');
});

test('aucune voie n\'est en double, ni par code ni par nom', async () => {
  // Trois tronçons de la même rocade saisis par trois contributeurs donnent
  // trois rues, et le taux de collecte de cette voie se répartit entre elles.
  const codes = await q(`
    SELECT code FROM app.rue WHERE archive_le IS NULL
     GROUP BY commune_id, code HAVING count(*) > 1`);
  assert.equal(codes.length, 0, `codes en double : ${codes.map((c) => c.code).join(', ')}`);

  const noms = await q(`
    SELECT app.normaliser(nom) AS n FROM app.rue WHERE archive_le IS NULL
     GROUP BY commune_id, app.normaliser(nom) HAVING count(*) > 1`);
  assert.equal(noms.length, 0, `noms en double : ${noms.map((x) => x.n).join(', ')}`);
});

test('une voie importée attend la relecture de la mairie', async () => {
  const externes = await un(`
    SELECT count(*)::int AS n
      FROM app.rue
     WHERE source <> 'a_saisir' AND valide_le IS NULL AND archive_le IS NULL`);
  assert.ok(externes.n > 0, 'il faut des voies importées pour éprouver la règle');

  const inventaire = await un(
    "SELECT count(*)::int AS n FROM app.v_donnees_a_remplacer WHERE entite = 'rue'");
  assert.equal(inventaire.n, externes.n,
    'toute voie importée non validée doit figurer à l\'inventaire des données provisoires');
});

test('l\'inventaire dit d\'où vient le nom, pas seulement qu\'il est provisoire', async () => {
  // « Nom provisoire » n'aide personne. Savoir que le nom vient d'OSM dit à
  // l'agent municipal où aller vérifier : la plaque, ou le plan de voirie.
  const l = await un(
    "SELECT a_faire FROM app.v_donnees_a_remplacer WHERE entite = 'rue' LIMIT 1");
  assert.match(l.a_faire, /OpenStreetMap|PDC|mairie/);
});

test('valider une voie la sort de l\'inventaire et laisse une trace', async () => {
  await enTransaction(async (client) => {
    const { rows: [rue] } = await client.query(`
      SELECT id, code FROM app.rue
       WHERE a_remplacer AND valide_le IS NULL AND archive_le IS NULL LIMIT 1`);
    assert.ok(rue, 'il faut une voie à valider');

    const { rows: [agent] } = await client.query(
      "SELECT id FROM app.utilisateur WHERE role = 'admin_commune' LIMIT 1");

    await client.query(`
      UPDATE app.rue SET a_remplacer = false, valide_le = now(), valide_par = $2
       WHERE id = $1`, [rue.id, agent.id]);

    const { rows: reste } = await client.query(
      "SELECT id FROM app.v_donnees_a_remplacer WHERE entite = 'rue' AND id = $1", [rue.id]);
    assert.equal(reste.length, 0, 'une voie validée ne doit plus figurer à l\'inventaire');

    const { rows: [apres] } = await client.query(
      'SELECT valide_par, valide_le FROM app.rue WHERE id = $1', [rue.id]);
    assert.ok(apres.valide_par && apres.valide_le,
      'la validation doit être attribuable : c\'est elle qui engage la commune');
  });
});

test('les taux par rue ne portent que sur des voies du référentiel', async () => {
  // Un commerce rattaché à une rue qui n'existe plus fausserait une ligne du
  // tableau sans qu'aucun total ne bouge.
  const orphelins = await un(`
    SELECT count(*)::int AS n
      FROM app.commerce c
     WHERE c.rue_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM app.rue r WHERE r.id = c.rue_id)`);
  assert.equal(orphelins.n, 0);
});
