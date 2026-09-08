'use strict';
/**
 * La mémoire mensuelle des situations, et l'indicateur qui la lit.
 *
 * CE QUE CES TESTS PROTÈGENT
 *
 * Un indicateur qui change tout seul entre deux consultations n'est pas un
 * indicateur : c'est un tirage. Toute la valeur de ce dispositif tient à une
 * propriété — le passé ne bouge pas — et cette propriété ne se lit pas dans le
 * code. Elle se constate en essayant de le réécrire.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, enTransaction, fermer } = require('./aide');

const app = require('../src/app');

const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const AGENT = '+221700000011';
const SUPERVISEUR = '+221700000003';

let serveur; let base;

async function appel(chemin, { methode = 'GET', corps = null, jeton = null } = {}) {
  const reponse = await fetch(base + chemin, {
    method: methode,
    headers: {
      'content-type': 'application/json',
      ...(jeton ? { authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await reponse.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* réponse non JSON */ }
  return { statut: reponse.status, json, texte };
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  await fermer();
  await new Promise((r) => serveur.close(r));
});

/** Le dernier mois entièrement écoulé — le seul qu'on ait le droit de figer. */
const MOIS_CLOS = "(date_trunc('month', current_date) - interval '1 month')::date";

async function commune() {
  const c = await un('SELECT id FROM app.commune ORDER BY cree_le LIMIT 1');
  assert.ok(c, 'aucune commune : le jeu de données est vide');
  return c.id;
}

// ===========================================================================
//  Le passé ne bouge pas
// ===========================================================================

test('une observation arrêtée ne se réécrit pas', async () => {
  await enTransaction(async (client) => {
    const { rows: [o] } = await client.query(`
      INSERT INTO app.observation_mensuelle (
          commune_id, commerce_id, mois, nb_avis,
          montant_du_cumule, montant_regle_cumule, montant_restant,
          montant_regle_mois, nb_paiements_mois, echeance_depassee,
          nb_avis_relances, contestation_ouverte, exoneration_en_vigueur,
          nb_visites_mois, commerce_archive)
      SELECT c.commune_id, c.id, '2000-01-01'::date, 1,
             1000, 0, 1000, 0, 0, false, 0, false, false, 0, false
        FROM app.commerce c LIMIT 1
      RETURNING id`);

    await assert.rejects(
      () => client.query('UPDATE app.observation_mensuelle SET montant_regle_cumule = 999 WHERE id = $1', [o.id]),
      /ne se reecrit pas/,
      'la mémoire accepte d\'être réécrite : le passé peut donc changer',
    );
  });
});

test('une observation arrêtée ne se supprime pas', async () => {
  await enTransaction(async (client) => {
    const { rows: [o] } = await client.query(`
      INSERT INTO app.observation_mensuelle (
          commune_id, commerce_id, mois, nb_avis,
          montant_du_cumule, montant_regle_cumule, montant_restant,
          montant_regle_mois, nb_paiements_mois, echeance_depassee,
          nb_avis_relances, contestation_ouverte, exoneration_en_vigueur,
          nb_visites_mois, commerce_archive)
      SELECT c.commune_id, c.id, '2000-02-01'::date, 1,
             1000, 0, 1000, 0, 0, false, 0, false, false, 0, false
        FROM app.commerce c LIMIT 1
      RETURNING id`);

    await assert.rejects(
      () => client.query('DELETE FROM app.observation_mensuelle WHERE id = $1', [o.id]),
      /ne se supprime pas/,
      'la mémoire accepte d\'être effacée',
    );
  });
});

test('un mois non terminé ne peut pas être arrêté', async () => {
  const id = await commune();
  await assert.rejects(
    () => q('SELECT * FROM app.arreter_observations($1, current_date)', [id]),
    /n'est pas termine/,
    'figer un mois en cours fige une situation qui va encore changer',
  );
});

// ===========================================================================
//  Arrêter, rejouer, corriger
// ===========================================================================

test('arrêter deux fois le même mois n\'ajoute rien', async () => {
  const id = await commune();
  await enTransaction(async (client) => {
    const { rows: [un1] } = await client.query(
      `SELECT * FROM app.arreter_observations($1, ${MOIS_CLOS})`, [id]);
    const { rows: [un2] } = await client.query(
      `SELECT * FROM app.arreter_observations($1, ${MOIS_CLOS})`, [id]);

    assert.equal(un2.arretees, 0, 'un second passage crée des doublons');
    assert.equal(un2.corrigees, 0, 'un second passage corrige sans raison');
    assert.equal(un2.inchangees, un1.arretees + un1.inchangees,
      'le décompte ne totalise pas ce qui a été arrêté au premier passage');
  });
});

test('une correction remplace l\'observation, elle ne la réécrit pas', async () => {
  const id = await commune();
  await enTransaction(async (client) => {
    await client.query(`SELECT app.arreter_observations($1, ${MOIS_CLOS})`, [id]);

    const { rows: [cible] } = await client.query(`
      SELECT commerce_id FROM app.observation_mensuelle
       WHERE commune_id = $1 AND mois = ${MOIS_CLOS} AND remplacee_le IS NULL
         AND nb_avis > 0
       LIMIT 1`, [id]);
    if (!cible) return; // aucun avis dans ce jeu : rien à corriger

    // Le passé change sous nos pieds : tous ses avis sont annulés.
    await client.query(`
      UPDATE app.avis_imposition SET annule_le = now(), motif_annulation = 'essai'
       WHERE commerce_id = $1 AND annule_le IS NULL`, [cible.commerce_id]);

    const { rows: [sans] } = await client.query(
      `SELECT * FROM app.arreter_observations($1, ${MOIS_CLOS})`, [id]);
    assert.equal(sans.corrigees, 0,
      'la mémoire a bougé sans qu\'on demande de correction');

    const { rows: [avec] } = await client.query(
      `SELECT * FROM app.arreter_observations($1, ${MOIS_CLOS}, true, 'essai')`, [id]);
    assert.equal(avec.corrigees, 1,
      'un commerce dont tous les avis sont annulés disparaît du calcul : '
      + 'son observation périmée doit être remplacée, pas oubliée');

    const lignes = await client.query(`
      SELECT nb_avis, remplacee_le, motif_remplacement
        FROM app.observation_mensuelle
       WHERE commerce_id = $1 AND mois = ${MOIS_CLOS}
       ORDER BY arretee_le`, [cible.commerce_id]);

    assert.equal(lignes.rows.length, 2, 'la correction n\'a pas laissé deux états');
    assert.ok(lignes.rows[0].remplacee_le, 'l\'ancienne observation n\'est pas datée comme remplacée');
    assert.equal(lignes.rows[0].motif_remplacement, 'essai', 'la correction ne dit pas pourquoi');
    assert.equal(lignes.rows[1].remplacee_le, null, 'la nouvelle observation n\'est pas en vigueur');
    assert.equal(lignes.rows[1].nb_avis, 0, 'la nouvelle observation garde des avis annulés');
  });
});

// ===========================================================================
//  L'indicateur
// ===========================================================================

test('sous le nombre de mois minimal, aucun niveau n\'est prononcé (FR-087)', async () => {
  const trop_tot = await q(`
    SELECT commerce_id, nb_mois, mois_minimaux, niveau
      FROM app.v_risque_defaut
     WHERE nb_mois < mois_minimaux AND niveau <> 'indetermine'`);

  assert.deepEqual(trop_tot, [],
    'un niveau est prononcé sur un historique trop mince : un chiffre calculé '
    + 'sur rien passerait pour de la connaissance');
});

test('un niveau ne se rend jamais sans les facteurs qui l\'ont formé (FR-086)', async () => {
  const muets = await q(`
    SELECT commerce_id, score
      FROM app.v_risque_defaut
     WHERE score > 0 AND jsonb_array_length(facteurs) = 0`);
  assert.deepEqual(muets, [],
    'un score sans facteur : rien ne permettrait de l\'expliquer au commerçant');

  const incoherents = await q(`
    SELECT commerce_id, score,
           (SELECT sum((f->>'poids')::int) FROM jsonb_array_elements(facteurs) f) AS somme
      FROM app.v_risque_defaut
     WHERE score <> coalesce((SELECT sum((f->>'poids')::int)
                                FROM jsonb_array_elements(facteurs) f), 0)`);
  assert.deepEqual(incoherents, [],
    'le score ne vaut pas la somme de ses facteurs : le détail affiché ment '
    + 'sur le total');

  const informes = await q(`
    SELECT commerce_id
      FROM app.v_risque_defaut, jsonb_array_elements(facteurs) f
     WHERE f->>'code' IS NULL OR f->>'libelle' IS NULL OR f->>'poids' IS NULL`);
  assert.deepEqual(informes, [], 'un facteur sans code, libellé ou poids');
});

test('une exonération en vigueur écarte le mois du calcul', async () => {
  const id = await commune();
  await enTransaction(async (client) => {
    const { rows: [c] } = await client.query(
      'SELECT id, commune_id FROM app.commerce WHERE commune_id = $1 LIMIT 1', [id]);

    const avant = await client.query(
      'SELECT nb_mois FROM app.v_risque_defaut WHERE commerce_id = $1', [c.id]);

    // Deux mois de plus, dont un couvert par une exonération : seul le premier
    // doit compter. Une exonération est une décision de la mairie, pas un
    // comportement du commerçant.
    for (const [mois, exonere] of [['1999-01-01', false], ['1999-02-01', true]]) {
      await client.query(`
        INSERT INTO app.observation_mensuelle (
            commune_id, commerce_id, mois, nb_avis,
            montant_du_cumule, montant_regle_cumule, montant_restant,
            montant_regle_mois, nb_paiements_mois, echeance_depassee,
            nb_avis_relances, contestation_ouverte, exoneration_en_vigueur,
            nb_visites_mois, commerce_archive)
        VALUES ($1, $2, $3::date, 1, 1000, 0, 1000, 0, 0, false, 0, false, $4, 0, false)`,
      [c.commune_id, c.id, mois, exonere]);
    }

    const { rows: [apres] } = await client.query(
      'SELECT nb_mois FROM app.v_risque_defaut WHERE commerce_id = $1', [c.id]);

    const attendu = (avant.rows[0]?.nb_mois ?? 0) + 1;
    assert.equal(apres.nb_mois, attendu,
      'le mois exonéré est compté : la décision de la mairie est portée au '
      + 'débit du commerçant');
  });
});

// ===========================================================================
//  L'indicateur sert a quelque chose
// ===========================================================================

test('la feuille de route ordonne par le risque, sans jamais primer le motif', async () => {
  await enTransaction(async (client) => {
    const { rows: [agent] } = await client.query(
      "SELECT id FROM app.utilisateur WHERE role = 'agent' AND actif LIMIT 1");
    if (!agent) return;

    await client.query(`SELECT app.arreter_observations(id, ${MOIS_CLOS})
                          FROM app.commune LIMIT 1`);

    // Une date future : on ne touche pas a la tournee du jour.
    await client.query(
      'SELECT app.composer_feuille_route($1, current_date + 400)', [agent.id]);

    const { rows: lignes } = await client.query(`
      SELECT l.ordre, l.motif::text AS motif, coalesce(r.score, 0) AS score
        FROM app.feuille_route f
        JOIN app.feuille_route_ligne l ON l.feuille_id = f.id
        LEFT JOIN app.v_risque_defaut r ON r.commerce_id = l.commerce_id
       WHERE f.agent_id = $1 AND f.date_tournee = current_date + 400
         AND l.retiree_le IS NULL
       ORDER BY l.ordre`, [agent.id]);

    if (lignes.length < 2) return; // agent sans affectation : rien a ordonner

    // Le score DEPARTAGE a l'interieur d'un motif ; il ne le renverse jamais.
    // Un motif qui se melangerait signifierait que le calcul a pris le dernier
    // mot sur la journee d'un agent.
    const motifsVus = [];
    for (let i = 1; i < lignes.length; i += 1) {
      const avant = lignes[i - 1];
      const apres = lignes[i];
      if (avant.motif === apres.motif) {
        assert.ok(Number(avant.score) >= Number(apres.score),
          `ordre ${apres.ordre} : score ${apres.score} place avant ${avant.score} `
          + `pour le meme motif « ${apres.motif} »`);
      } else {
        assert.ok(!motifsVus.includes(apres.motif),
          `le motif « ${apres.motif} » reapparait apres avoir ete quitte : `
          + 'le score a repris le pas sur le motif');
        motifsVus.push(avant.motif);
      }
    }
  });
});

// ===========================================================================
//  Qui a le droit de voir (FR-088)
// ===========================================================================

test('un agent de terrain n\'accède pas à l\'indicateur', async () => {
  const c = await appel('/auth/login', {
    methode: 'POST', corps: { telephone: AGENT, mot_de_passe: MDP },
  });
  assert.equal(c.statut, 200, `connexion agent refusée : ${c.texte}`);

  const r = await appel('/stats/risque-defaut', { jeton: c.json.donnees.jeton_acces });
  assert.equal(r.statut, 403,
    'un agent lit le niveau de risque : il ne parlerait plus de la même façon '
    + 'au commerçant qu\'il visite');
});

test('le superviseur lit l\'indicateur, avec ses facteurs', async () => {
  const c = await appel('/auth/login', {
    methode: 'POST', corps: { telephone: SUPERVISEUR, mot_de_passe: MDP },
  });
  if (c.statut !== 200) return; // ce compte peut exiger un changement de mot de passe

  const r = await appel('/stats/risque-defaut?limite=5', {
    jeton: c.json.donnees.jeton_acces,
  });
  assert.equal(r.statut, 200, `accès superviseur refusé : ${r.texte}`);
  for (const ligne of r.json.donnees) {
    assert.ok(Array.isArray(ligne.facteurs),
      'une ligne sans tableau de facteurs : FR-086 interdit de l\'afficher');
    assert.ok(['indetermine', 'faible', 'attention', 'eleve'].includes(ligne.niveau),
      `niveau inconnu : ${ligne.niveau}`);
  }
});

// ===========================================================================
//  L'indicateur classe-t-il vraiment ?
//
//  Tout ce qui precede eprouve les GARDE-FOUS : le passe ne bouge pas, aucun
//  niveau sous le minimum, jamais de niveau sans ses facteurs. Rien n'eprouvait
//  la chose elle-meme — savoir si, avec assez d'historique, elle range les
//  commercants dans le bon ordre.
//
//  Elle ne pouvait pas l'etre sur les donnees de demonstration : un seul mois
//  y est observe, donc TOUT y est « indetermine ». On fabrique donc trois
//  historiques, un par comportement, et on regarde ou ils tombent.
// ===========================================================================

/**
 * Ecarte les observations reelles d'un commerce le temps du test, sans en
 * supprimer aucune — le declencheur l'interdit, et c'est le sujet meme de ce
 * fichier. Marquees remplacees, elles sortent de la vue ; la transaction les
 * remettra en vigueur.
 */
async function isoler(client, commerceId) {
  await client.query(
    `UPDATE app.observation_mensuelle
        SET remplacee_le = now(), motif_remplacement = 'mise a l ecart pour un test'
      WHERE commerce_id = $1 AND remplacee_le IS NULL`, [commerceId]);
}

async function poserMois(client, commerce, mois, etat) {
  await client.query(`
    INSERT INTO app.observation_mensuelle (
        commune_id, commerce_id, mois, nb_avis,
        montant_du_cumule, montant_regle_cumule, montant_restant,
        montant_regle_mois, nb_paiements_mois, echeance_depassee,
        dernier_reglement_le, jours_depuis_reglement, nb_avis_relances,
        contestation_ouverte, exoneration_en_vigueur,
        nb_visites_mois, commerce_archive)
    VALUES ($1, $2, $3::date, 1, $4, $5, $6, $7, $8, $9, NULL, $10, $11,
            false, false, 0, false)`,
  [commerce.commune_id, commerce.id, mois,
    etat.du, etat.regleCumule, etat.restant, etat.regleMois,
    etat.regleMois > 0 ? 1 : 0, etat.echeanceDepassee,
    etat.joursSansReglement ?? null, etat.relances ?? 0]);
}

test('avec assez d\'historique, l\'indicateur range les comportements', async () => {
  const id = await commune();

  await enTransaction(async (client) => {
    const { rows: commerces } = await client.query(
      'SELECT id, commune_id FROM app.commerce WHERE commune_id = $1 ORDER BY code LIMIT 3', [id]);
    assert.equal(commerces.length, 3, 'il faut trois commerces pour ce test');

    const [jamais, interrompu, regulier] = commerces;
    for (const c of commerces) await isoler(client, c.id);

    // --- Celui qui n'a jamais rien regle, en retard, et deja relance --------
    // 40 (jamais regle) + 15 (retard habituel) + 5 (relances) = 60
    for (const mois of ['1998-01-01', '1998-02-01', '1998-03-01']) {
      await poserMois(client, jamais, mois, {
        du: 30000, regleCumule: 0, restant: 30000, regleMois: 0,
        echeanceDepassee: true, relances: 2,
      });
    }

    // --- Celui qui a regle, puis s'est arrete -------------------------------
    // 25 (reglement interrompu). Rien d'autre : il n'est pas en retard au sens
    // de l'echeance, et un seul mois partiel ne suffit pas.
    await poserMois(client, interrompu, '1998-01-01', {
      du: 30000, regleCumule: 10000, restant: 20000, regleMois: 10000,
      echeanceDepassee: false,
    });
    for (const mois of ['1998-02-01', '1998-03-01']) {
      await poserMois(client, interrompu, mois, {
        du: 30000, regleCumule: 10000, restant: 20000, regleMois: 0,
        echeanceDepassee: false, joursSansReglement: 90,
      });
    }

    // --- Celui qui solde a temps -------------------------------------------
    for (const mois of ['1998-01-01', '1998-02-01', '1998-03-01']) {
      await poserMois(client, regulier, mois, {
        du: 30000, regleCumule: 30000, restant: 0, regleMois: 10000,
        echeanceDepassee: false,
      });
    }

    const lire = async (commerceId) => {
      const { rows: [r] } = await client.query(
        `SELECT niveau, score, nb_mois,
                (SELECT array_agg(f->>'code' ORDER BY f->>'code')
                   FROM jsonb_array_elements(facteurs) f) AS codes
           FROM app.v_risque_defaut WHERE commerce_id = $1`, [commerceId]);
      return r;
    };

    const a = await lire(jamais.id);
    assert.equal(a.nb_mois, 3, 'les trois mois posés ne sont pas tous comptés');
    assert.deepEqual(a.codes.sort(),
      ['jamais_regle', 'relances_repetees', 'retard_habituel'],
      'les facteurs attendus ne sont pas ceux qui sortent');
    assert.equal(a.score, 60, 'le total ne vaut pas la somme des trois poids');
    assert.equal(a.niveau, 'eleve',
      'celui qui n\'a jamais rien réglé, en retard et déjà relancé, n\'est pas '
      + 'signalé : l\'indicateur ne sert alors à rien');

    const b = await lire(interrompu.id);
    assert.deepEqual(b.codes, ['reglement_interrompu'],
      'l\'interruption de paiement n\'est pas reconnue');
    assert.equal(b.score, 25);

    const c = await lire(regulier.id);
    assert.equal(c.score, 0,
      'un commerçant qui solde à temps porte un score : il serait visité pour rien');
    assert.equal(c.niveau, 'faible');

    // L'ordre est ce qui sert : la feuille de route s'y fie.
    assert.ok(a.score > b.score && b.score > c.score,
      'les trois comportements ne sont pas ordonnés du plus grave au plus sain');
  });
});
