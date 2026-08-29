'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, refuse, fermer } = require('./aide');

test.after(fermer);

/**
 * Liquidation annuelle et solde restant dû.
 *
 * Quatre défauts de facturation ont échappé à la relecture et à l'analyseur
 * syntaxique. Trois touchaient à l'argent, dont une sous-facturation d'un
 * facteur douze. Ces tests existent pour qu'aucun ne revienne.
 */

async function periodeAnnuelle() {
  return un(`SELECT id, to_char(date_debut, 'MM-DD') AS debut,
                    to_char(date_fin,   'MM-DD') AS fin
               FROM app.periode_fiscale
              WHERE periodicite = 'annuelle' ORDER BY annee DESC LIMIT 1`);
}

test('la période fiscale est annuelle', async () => {
  const p = await periodeAnnuelle();
  assert.ok(p, 'une période annuelle doit exister');
  assert.equal(p.debut, '01-01');
  assert.equal(p.fin,   '12-31');
});

test('creer_periode_annuelle est idempotente', async () => {
  const c = await un("SELECT id FROM app.commune WHERE code = 'GTFC'");
  const a = await un('SELECT app.creer_periode_annuelle($1, 2027) AS id', [c.id]);
  const b = await un('SELECT app.creer_periode_annuelle($1, 2027) AS id', [c.id]);
  assert.equal(a.id, b.id, 'relancer ne doit pas créer une seconde période');
});

test('un avis annuel vaut le mensuel multiplié par les mois couverts', async () => {
  // Le défaut trouvé : le montant était divisé par douze au lieu d'être
  // multiplié, sous-facturant d'un facteur douze.
  //
  // La comparaison se fait LIGNE À LIGNE, sur les seules taxes présentes des
  // deux côtés : les deux avis peuvent avoir été générés à des moments où le
  // rattachement des taxes différait, et comparer les totaux ferait alors
  // échouer un calcul pourtant juste.
  const lignes = await q(`
    SELECT lm.montant AS mensuel, la.montant AS annuel, a.mois_couverts, t.code AS taxe
      FROM app.avis_imposition m
      JOIN app.periode_fiscale pm ON pm.id = m.periode_id AND pm.periodicite = 'mensuelle'
      JOIN app.avis_ligne lm      ON lm.avis_id = m.id
      JOIN app.avis_imposition a  ON a.commerce_id = m.commerce_id
      JOIN app.periode_fiscale pa ON pa.id = a.periode_id AND pa.periodicite = 'annuelle'
      JOIN app.avis_ligne la      ON la.avis_id = a.id AND la.type_taxe_id = lm.type_taxe_id
      JOIN ref.type_taxe t        ON t.id = lm.type_taxe_id
     WHERE lm.montant > 0
     LIMIT 20`);
  assert.ok(lignes.length > 0, 'il faut des lignes comparables des deux périodicités');
  for (const l of lignes) {
    assert.equal(Number(l.annuel), Number(l.mensuel) * Number(l.mois_couverts),
      `${l.taxe} : annuel ${l.annuel} devrait valoir ${l.mensuel} × ${l.mois_couverts}`);
  }
});

test('aucun avis annuel n’est à zéro franc', async () => {
  // Le défaut trouvé : la sélection des taxes testait l'inclusion du premier
  // jour, si bien qu'un commerce rattaché en cours d'année n'était jamais
  // facturé — 60 avis à zéro.
  const r = await un(`
    SELECT count(*)::int AS n
      FROM app.avis_imposition a
      JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE p.periodicite = 'annuelle' AND a.montant_total = 0`);
  assert.equal(r.n, 0, 'un avis à zéro signale une taxe non retenue');
});

test('mois_couverts est renseigné et borné entre 1 et 12', async () => {
  const r = await un(`
    SELECT count(*)::int AS n
      FROM app.avis_imposition a
      JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE p.periodicite = 'annuelle'
       AND (a.mois_couverts IS NULL OR a.mois_couverts < 1 OR a.mois_couverts > 12)`);
  assert.equal(r.n, 0);
});

test('un redevable au rythme n’est jamais signalé en retard', async () => {
  // Le défaut trouvé : le prorata comptait depuis janvier, si bien qu'un
  // commerce recensé en août apparaissait en retard dès son premier mois.
  const r = await un(`
    SELECT count(*)::int AS n FROM app.v_regularite_prorata
     WHERE montant_paye >= attendu_prorata AND retard_regularite > 0`);
  assert.equal(r.n, 0, 'relancer quelqu’un qui a payé détruit la confiance');
});

test('le prorata ne dépasse jamais le montant dû', async () => {
  const r = await un(
    'SELECT count(*)::int AS n FROM app.v_regularite_prorata WHERE attendu_prorata > montant_total');
  assert.equal(r.n, 0);
});

test('suivre le conseil mensuel solde toujours l’avis', async () => {
  // Le défaut trouvé : le conseil divisait par douze même sur une année
  // partielle, conduisant le redevable à sous-payer.
  const r = await un(`
    SELECT count(*)::int AS n FROM app.v_regularite_prorata
     WHERE solde > 0 AND mensuel_conseille * mois_restants < solde`);
  assert.equal(r.n, 0);
});

test('un avis soldé ne conseille aucun versement', async () => {
  const r = await un(
    'SELECT count(*)::int AS n FROM app.v_regularite_prorata WHERE solde = 0 AND mensuel_conseille > 0');
  assert.equal(r.n, 0);
});

test('le surpaiement est refusé par la base', async () => {
  const avis = await un(`
    SELECT id, montant_total FROM app.avis_imposition
     WHERE montant_total > 0 AND annule_le IS NULL LIMIT 1`);
  const ok = await refuse(
    'UPDATE app.avis_imposition SET montant_paye = $1 WHERE id = $2',
    [Number(avis.montant_total) + 1000, avis.id]);
  assert.equal(ok, true);
});

test('le solde est toujours la différence du dû et du versé', async () => {
  const r = await un(`
    SELECT count(*)::int AS n FROM app.avis_imposition
     WHERE montant_restant <> montant_total - montant_paye`);
  assert.equal(r.n, 0);
});

test('un chantier non facturable ne produit aucune ligne', async () => {
  const r = await un(`
    SELECT count(*)::int AS n
      FROM app.avis_ligne l
      JOIN app.chantier c ON c.id = l.objet_id AND l.objet_type = 'chantier'
     WHERE NOT c.facturable`);
  assert.equal(r.n, 0, 'le chantier est recensé mais non facturé durant le pilote');
});
