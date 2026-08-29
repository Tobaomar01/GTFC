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

/**
 * Garantit qu'il existe une période annuelle ET ses avis.
 *
 * Ces tests lisaient auparavant les avis qui se trouvaient là. Sur la base de
 * recette il y en avait, hérités des essais précédents ; sur une installation
 * NEUVE il n'y en a aucun, et deux tests échouaient sans rien signaler de
 * réel. Un test qui ne vaut que sur une base déjà façonnée ne protège de rien
 * le jour d'un déploiement.
 *
 * La génération est idempotente : relancée, elle ne facture pas deux fois.
 */
async function assurerPeriodeAnnuelle() {
  const commune = await un("SELECT id FROM app.commune WHERE code = 'GTFC'");
  const { id } = await un('SELECT app.creer_periode_annuelle($1, $2) AS id',
    [commune.id, new Date().getFullYear()]);
  return id;
}

async function preparerAvis() {
  const id = await assurerPeriodeAnnuelle();

  const existants = await un(
    `SELECT count(*)::int AS n FROM app.avis_imposition
      WHERE periode_id = $1 AND annule_le IS NULL`, [id]);
  if (existants.n === 0) await q('SELECT * FROM app.generer_avis_periode($1)', [id]);

  return id;
}

async function periodeAnnuelle() {
  // Sur une installation neuve aucune période n'existe encore : on la crée
  // plutôt que d'affirmer qu'elle devrait être là. C'est précisément la
  // fonction de création qu'on éprouve ensuite.
  await assurerPeriodeAnnuelle();
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

test('la ligne annuelle est un multiple entier du tarif mensuel', async () => {
  // Le défaut trouvé : le montant était DIVISÉ par douze au lieu d'être
  // multiplié, sous-facturant d'un facteur douze.
  //
  // La comparaison se faisait autrefois avec un avis MENSUEL. Depuis la
  // liquidation annuelle (migration 0046) le système ne crée plus de période
  // mensuelle : le test ne tenait que par les données héritées de la base de
  // recette, et n'aurait rien vérifié sur un serveur neuf.
  //
  // On ne refait pas non plus le calcul du générateur — un test qui redit
  // l'implémentation ne prouve rien. On vérifie ce qui doit être vrai quelle
  // que soit la façon de compter les mois : une ligne annuelle portant une
  // taxe mensuelle vaut un NOMBRE ENTIER de mensualités, entre une et douze.
  // La division par douze produisait une fraction de mensualité : elle échoue
  // ici sur les trois conditions à la fois.
  const periodeId = await preparerAvis();

  const lignes = await q(`
    SELECT t.code AS taxe, l.montant AS annuel, c.montant AS mensuel
      FROM app.avis_imposition av
      JOIN app.avis_ligne l      ON l.avis_id = av.id
      JOIN app.periode_fiscale p ON p.id = av.periode_id
      JOIN ref.type_taxe t       ON t.id = l.type_taxe_id
      JOIN app.commerce_taxe ct  ON ct.commerce_id = l.objet_id
                                AND ct.type_taxe_id = l.type_taxe_id AND ct.actif
      -- Le tarif est relevé à la date où la taxe commence, comme le fait le
      -- générateur : avant elle, aucun barème ne s'applique.
      CROSS JOIN LATERAL app.calculer_taxe(
        l.objet_id, l.type_taxe_id,
        greatest(p.date_debut, ct.date_debut)) c
     WHERE av.periode_id = $1
       AND av.annule_le IS NULL
       AND p.periodicite = 'annuelle'
       AND l.objet_type = 'commerce'
       AND l.taux_exoneration_pct = 0
       AND l.montant > 0
       AND c.montant > 0
       AND t.periodicite_defaut = 'mensuelle'
     LIMIT 30`, [periodeId]);

  assert.ok(lignes.length > 0,
    'la période annuelle doit porter des lignes de taxe mensuelle');

  for (const l of lignes) {
    const rapport = Number(l.annuel) / Number(l.mensuel);
    assert.ok(rapport >= 1,
      `${l.taxe} : ${l.annuel} est INFÉRIEUR à une mensualité de ${l.mensuel}`);
    assert.ok(rapport <= 12,
      `${l.taxe} : ${l.annuel} dépasse douze mensualités de ${l.mensuel}`);
    assert.ok(Math.abs(rapport - Math.round(rapport)) < 0.01,
      `${l.taxe} : ${l.annuel} ne fait pas un nombre entier de mensualités `
      + `de ${l.mensuel} (rapport ${rapport.toFixed(3)})`);
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
  await preparerAvis();
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
  // Sans cette première vérification le test serait vrai par vacuité : aucun
  // chantier, donc aucune ligne, donc « conforme ». C'est exactement ce qui
  // s'est passé pendant des semaines — le seed des chantiers tournait avant
  // celui des rues et n'en créait aucun, en silence.
  const chantiers = await un(
    'SELECT count(*)::int AS n FROM app.chantier WHERE NOT facturable');
  assert.ok(chantiers.n > 0,
    'aucun chantier non facturable en base : le test ne vérifierait rien');

  const r = await un(`
    SELECT count(*)::int AS n
      FROM app.avis_ligne l
      JOIN app.chantier c ON c.id = l.objet_id AND l.objet_type = 'chantier'
     WHERE NOT c.facturable`);
  assert.equal(r.n, 0, 'le chantier est recensé mais non facturé durant le pilote');
});
