'use strict';
/**
 * Ce que voit quelqu'un qui n'est personne.
 *
 * Deux routes sont ouvertes sans aucune authentification : la vue d'un sticker
 * QR collé sur une devanture, et la vérification d'une quittance papier. Ce
 * sont les seules surfaces du dispositif qu'un passant peut atteindre, et une
 * fuite y serait irréversible — on ne rappelle pas une page qui a été vue.
 *
 * La règle posée par le commanditaire est nette : « le QR code identifie un
 * commerce pour les agents authentifiés seulement, la vue publique ne montre
 * aucun montant ni nom ». L'enseigne fait exception, et c'est cohérent : elle
 * est peinte sur la devanture, la cacher ne protégerait personne.
 *
 * Le second sujet est l'inverse du premier : ce que le passant LAISSE. Chaque
 * lecture enregistrait son adresse et son navigateur, sans terme. Il n'est ni
 * redevable ni agent ; son adresse n'est nécessaire ni à l'identification du
 * redevable, ni au recouvrement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, enTransaction, fermer } = require('./aide');

const app = require('../src/app');

let serveur; let base;

async function ouvrir(chemin) {
  // Volontairement SANS en-tête d'autorisation : c'est le point du test.
  const r = await fetch(base + chemin);
  const texte = await r.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* non JSON */ }
  return { statut: r.status, json, texte };
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

test('la vue publique d\'un sticker ne livre ni montant ni identité', async () => {
  const qr = await un(`
    SELECT q.jeton, c.enseigne, c.gerant_nom, c.gerant_telephone, c.solde_du
      FROM app.qr_code q
      JOIN app.commerce c ON c.id = q.commerce_id
     WHERE q.actif AND c.archive_le IS NULL AND c.gerant_nom IS NOT NULL
     LIMIT 1`);
  assert.ok(qr, 'il faut un QR actif pour éprouver la vue publique');

  const r = await ouvrir(`/public/c/${qr.jeton}`);
  assert.equal(r.statut, 200, r.texte);

  // Deux contrôles, parce qu'ils attrapent des choses différentes.
  //
  // Le premier fige la LISTE EXACTE des champs publiés : un champ ajouté
  // demain par inadvertance échoue ici, alors qu'une liste de valeurs
  // interdites ne verrait rien venir.
  const champs = Object.keys(r.json.donnees).sort();
  assert.deepEqual(champs,
    ['categorie', 'code', 'commune', 'enregistre_le', 'enseigne', 'qr_actif', 'quartier'],
    `la vue publique a changé de forme : ${champs.join(', ')}`);

  // Le second porte sur les VALEURS réelles de ce commerce-là.
  const brut = JSON.stringify(r.json);
  if (qr.gerant_telephone) {
    assert.ok(!brut.includes(qr.gerant_telephone),
      'le numéro du gérant ne doit pas être public');
  }
  assert.ok(!brut.includes(String(qr.solde_du)) || Number(qr.solde_du) === 0,
    'le solde dû ne doit pas être public');

  // L'enseigne, elle, est peinte sur la devanture : la cacher ne protège
  // personne et rendrait le sticker inutile.
  assert.ok(brut.includes(qr.enseigne), 'l\'enseigne identifie le commerce scanné');
});

test('un jeton inconnu ne dit pas si le commerce existe', async () => {
  const r = await ouvrir('/public/c/ZZZZZZZZZZZZZZZZ');
  assert.equal(r.statut, 404);
  assert.doesNotMatch(r.texte, /commune|quartier|enseigne/i);
});

test('un sticker remplacé répond quand même, en le disant', async () => {
  // L'agent a recollé un sticker neuf, l'ancien traîne sur la devanture. Un
  // 404 ferait croire à une erreur ; mieux vaut orienter.
  await enTransaction(async (client) => {
    // Le sticker doit être posé sur un commerce VIVANT. Ce test éprouve le
    // REMPLACEMENT d'un sticker, pas l'ARCHIVAGE d'un commerce — que la
    // fonction écarte à bon droit, et qui rend donc zéro ligne.
    //
    // Sans cette condition, « WHERE actif LIMIT 1 » tirait au sort entre les
    // deux cas. Et le sort penchait un peu plus du mauvais côté à chaque
    // passage de la suite : parcours-terrain.test.js archive ses commerces
    // de test sans désactiver leur QR, si bien que chaque exécution ajoutait
    // un sticker actif sur un commerce archivé. Un test qui se dégrade à
    // force d'être joué.
    //
    // ORDER BY parce qu'un LIMIT sans tri ne désigne rien de stable : le même
    // test, la même base, et deux réponses selon l'humeur du planificateur.
    const { rows: [qr] } = await client.query(`
      SELECT q.jeton
        FROM app.qr_code q
        JOIN app.commerce c ON c.id = q.commerce_id
       WHERE q.actif AND c.archive_le IS NULL
       ORDER BY q.genere_le, q.id
       LIMIT 1`);
    assert.ok(qr, 'aucun sticker actif sur un commerce vivant : jeu de données inutilisable');
    // La base refuse une désactivation sans date — bonne contrainte : un
    // sticker retiré sans qu'on sache quand laisserait une devanture sans
    // explication.
    await client.query(`
      UPDATE app.qr_code
         SET actif = false, desactive_le = now(),
             motif_desactivation = 'remplacement de sticker (test)'
       WHERE jeton = $1`, [qr.jeton]);
    // La route lit via une fonction SECURITY DEFINER, sur une AUTRE connexion :
    // elle ne verrait pas cette transaction. On éprouve donc la fonction ici.
    const { rows } = await client.query(
      'SELECT * FROM app.public_commerce_par_qr($1, NULL, NULL)', [qr.jeton]);
    assert.equal(rows.length, 1, 'un sticker remplacé doit encore se résoudre');
    assert.equal(rows[0].qr_actif, false);
  });
});

test('une quittance forgée est dénoncée, pas simplement introuvable', async () => {
  // C'est le cas d'usage même de cette route : prouver qu'un papier n'a pas
  // été émis par la commune.
  const r = await ouvrir('/public/quittance/ZZZZZZZZZZZZZZZZ');
  assert.equal(r.statut, 200, r.texte);
  assert.equal(r.json.donnees.valide, false);
  assert.match(r.json.donnees.message, /n'a pas été émis|pas été émis/i);
});

test('l\'adresse d\'un passant s\'efface, celle d\'un agent reste', async () => {
  await enTransaction(async (client) => {
    const { rows: [c] } = await client.query(
      'SELECT id, commune_id FROM app.commerce WHERE archive_le IS NULL LIMIT 1');
    const { rows: [qr] } = await client.query(
      'SELECT id FROM app.qr_code WHERE commerce_id = $1 LIMIT 1', [c.id]);
    const { rows: [u] } = await client.query(
      "SELECT id FROM app.utilisateur WHERE role = 'agent' LIMIT 1");

    // Deux lectures anciennes : l'une anonyme, l'autre par un agent.
    const { rows: [passant] } = await client.query(`
      INSERT INTO app.qr_scan (commune_id, qr_code_id, commerce_id, utilisateur_id,
                               scanne_le, ip, user_agent, source)
      VALUES ($1, $2, $3, NULL, now() - interval '60 days',
              '203.0.113.7', 'Mozilla/5.0 test', 'public')
      RETURNING id`, [c.commune_id, qr?.id ?? null, c.id]);

    const { rows: [agent] } = await client.query(`
      INSERT INTO app.qr_scan (commune_id, qr_code_id, commerce_id, utilisateur_id,
                               scanne_le, ip, user_agent, source)
      VALUES ($1, $2, $3, $4, now() - interval '60 days',
              '203.0.113.8', 'App agent', 'mobile')
      RETURNING id`, [c.commune_id, qr?.id ?? null, c.id, u.id]);

    const { rows: [bilan] } = await client.query(
      'SELECT app.anonymiser_scans_publics(30) AS nb');
    assert.ok(Number(bilan.nb) >= 1, 'la lecture anonyme aurait dû être anonymisée');

    const { rows: [apresPassant] } = await client.query(
      'SELECT ip, user_agent, scanne_le FROM app.qr_scan WHERE id = $1', [passant.id]);
    assert.equal(apresPassant.ip, null, 'l\'adresse du passant devait disparaître');
    assert.equal(apresPassant.user_agent, null);
    // L'ÉVÉNEMENT subsiste : il sert aux statistiques et à repérer un sticker
    // arraché. C'est le lecteur qui cesse d'être identifiable, pas la lecture.
    assert.ok(apresPassant.scanne_le, 'la lecture elle-même doit subsister');

    const { rows: [apresAgent] } = await client.query(
      'SELECT ip FROM app.qr_scan WHERE id = $1', [agent.id]);
    assert.equal(apresAgent.ip, '203.0.113.8',
      'un scan d\'agent est une action professionnelle : sa trace reste');
  });
});

test('le système se contrôle lui-même sur la vie privée', async () => {
  const controles = await q('SELECT controle, conforme FROM app.v_conformite_vie_privee');
  assert.ok(controles.length >= 3, 'les contrôles de conformité doivent être en place');
  const echecs = controles.filter((c) => !c.conforme).map((c) => c.controle);
  assert.deepEqual(echecs, [], `contrôles non conformes : ${echecs.join(' · ')}`);
});
