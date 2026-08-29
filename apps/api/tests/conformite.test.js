'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, refuse, fermer } = require('./aide');

test.after(fermer);

/**
 * Conformité à la spécification et à la constitution.
 *
 * Ces tests ne décrivent pas ce que le code fait : ils verrouillent des
 * décisions du commanditaire. Les faire échouer doit demander une décision,
 * pas un correctif distrait.
 */

test('Constitution I — Wave est le seul moyen de paiement', async () => {
  const ok = await refuse(`
    INSERT INTO app.paiement (commune_id, commerce_id, reference, montant, moyen)
    VALUES ((SELECT id FROM app.commune LIMIT 1),
            (SELECT id FROM app.commerce LIMIT 1), 'T-ESP', 1000, 'especes')`);
  assert.equal(ok, true, 'un paiement en espèces doit être refusé par la base');

  for (const moyen of ['virement', 'cheque', 'compensation']) {
    assert.equal(await refuse(`
      INSERT INTO app.paiement (commune_id, commerce_id, reference, montant, moyen)
      VALUES ((SELECT id FROM app.commune LIMIT 1),
              (SELECT id FROM app.commerce LIMIT 1), 'T-${moyen}', 1000, '${moyen}')`),
      true, `${moyen} doit être refusé`);
  }
});

test('Constitution I — aucun paiement hors Wave en base', async () => {
  const r = await un("SELECT count(*)::int AS n FROM app.paiement WHERE moyen <> 'wave'");
  assert.equal(r.n, 0);
});

test('Constitution II — le journal d’audit est chaîné et intact', async () => {
  const cols = await q(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='audit' AND table_name='journal'
       AND column_name IN ('empreinte','empreinte_precedente')`);
  assert.equal(cols.length, 2, 'les colonnes de chaînage doivent exister');

  const ruptures = await q('SELECT * FROM audit.verifier_chaine()');
  assert.deepEqual(ruptures, [], 'aucune rupture de chaîne ne doit être détectée');
});

test('Constitution III — le rôle chef de projet existe', async () => {
  const r = await un(
    "SELECT 'chef_projet' = ANY(enum_range(NULL::app.role_utilisateur)::text[]) AS ok");
  assert.equal(r.ok, true);
});

test('Constitution III — une exonération ne peut être validée par son auteur', async () => {
  const c = await un(`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conname = 'exoneration_double_verification'`);
  assert.equal(c.n, 1, 'la contrainte de double vérification doit exister');
});

test('Constitution III — seules les exonérations validées sont opposables', async () => {
  const r = await un(
    'SELECT count(*)::int AS n FROM app.v_exoneration_opposable WHERE valide_par IS NULL');
  assert.equal(r.n, 0);
});

test('Constitution III — le registre dérogatoire exige deux personnes', async () => {
  const c = await un(`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conname = 'derogation_double_verification'`);
  assert.equal(c.n, 1);
});

test('FR-051a — aucune trace de déplacement d’agent', async () => {
  const r = await un('SELECT conforme FROM app.v_conformite_vie_privee');
  assert.equal(r.conforme, true);

  const t = await q(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema='app' AND table_name ~ '(position_agent|trace_agent|suivi_agent)'`);
  assert.deepEqual(t, []);
});

test('FR-030 — la mécanique de caisse a disparu', async () => {
  const v = await q(`
    SELECT table_name FROM information_schema.views
     WHERE table_schema='app' AND table_name = 'v_especes_non_versees'`);
  assert.deepEqual(v, [], 'la vue des espèces non versées ne doit plus exister');

  const p = await un(
    'SELECT bool_and(NOT encaissement_especes_autorise) AS ok FROM app.commune_parametre');
  assert.equal(p.ok, true);
});
