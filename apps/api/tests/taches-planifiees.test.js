'use strict';
/**
 * Les douze tâches qui tournent sans personne.
 *
 * Partitions, périodes, pénalités, facturation, relances, notifications,
 * quittances, purges. Elles s'exécutent à une heure du matin, à deux heures, à
 * trois heures et demie. Aucune n'avait jamais été exécutée, ni en test, ni à
 * la main : il n'existait même pas de moyen de les déclencher.
 *
 * La première exécution en a trouvé une cassée, et c'était la plus grave.
 *
 * La création des partitions appelait `app.creer_partitions_position`,
 * supprimée avec le suivi de position des agents. Elle échouait donc AVANT
 * d'arriver à la ligne suivante — celle qui prolonge les partitions du journal
 * d'audit. Ce journal n'a pas de partition par défaut : le mois où la dernière
 * s'épuise, toute écriture auditée est refusée, et comme l'audit se déclenche
 * sur chaque écriture sensible, c'est le système entier qui s'arrête. Un
 * premier du mois, d'un coup.
 *
 * La seule trace aurait été une ligne de journal, à une heure du matin, le 25
 * du mois précédent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { q, un, fermer } = require('./aide');

const DOSSIER_API = path.resolve(__dirname, '..');

test.after(fermer);

function planificateur(...args) {
  return execFileSync(process.execPath, ['src/scheduler.js', ...args], {
    cwd: DOSSIER_API,
    env: { ...process.env, LOG_LEVEL: 'error' },
    encoding: 'utf8',
    timeout: 180000,
  });
}

test('les douze tâches s\'exécutent sans échouer', async () => {
  // Elles sont idempotentes par construction : une seconde exécution ne
  // refacture rien et ne renotifie personne. On peut donc les jouer ici.
  let sortie;
  try {
    sortie = planificateur('--une-fois');
  } catch (e) {
    sortie = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    assert.fail(`une tâche a échoué :\n${sortie.slice(-1200)}`);
  }
  assert.match(sortie, /0 en échec/, sortie.slice(-600));
});

test('chaque exécution laisse une trace en base', async () => {
  // Sans elle, une tâche qui échoue toutes les nuits ne laisse qu'une ligne
  // dans un fichier que personne ne lit à trois heures du matin.
  const sante = await q('SELECT tache, succes FROM app.v_sante_taches');
  assert.ok(sante.length >= 12,
    `${sante.length} tâches consignées sur douze : certaines n'ont jamais tourné`);

  const echouees = sante.filter((t) => t.succes === false).map((t) => t.tache);
  assert.deepEqual(echouees, [], `tâches en échec : ${echouees.join(', ')}`);
});

test('le journal d\'audit a de la marge devant lui', async () => {
  // À zéro mois de marge, le système entier cesse d'écrire. Ce contrôle-ci
  // n'est pas un test parmi d'autres : c'est la panne la plus totale que ce
  // dispositif puisse connaître, et la plus discrète à voir venir.
  const m = await un('SELECT * FROM audit.marge_partitions()');
  assert.ok(m.mois_restants >= 2,
    `le journal d'audit n'est couvert que ${m.mois_restants} mois `
    + `(jusqu'au ${m.derniere_couverture}) — la tâche « partitions » tourne-t-elle ?`);
});

test('la vérification quotidienne surveille cette marge', async () => {
  // La réparation ne suffit pas : ce qui manquait, c'est que l'épuisement se
  // VOIE venir. Le contrôle de cohérence tourne tous les jours à six heures.
  const sortie = planificateur('--une-fois', 'coherence');
  assert.match(sortie, /partitions_audit_mois_restants/,
    'le contrôle quotidien doit rapporter la marge du journal d\'audit');
});

test('une tâche peut être déclenchée à la main', async () => {
  // Ni pour les éprouver, ni pour rattraper une nuit manquée après une
  // coupure, il n'existait de moyen de les lancer. Attendre le prochain
  // passage était la seule option — jusqu'à un mois pour la facturation.
  const liste = planificateur('--lister');
  for (const nom of ['partitions', 'penalites', 'notifications', 'coherence']) {
    assert.match(liste, new RegExp(`\\b${nom}\\b`), `« ${nom} » doit être déclenchable`);
  }
});
