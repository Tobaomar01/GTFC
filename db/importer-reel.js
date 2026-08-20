#!/usr/bin/env node
/**
 * Import des données officielles de la commune.
 *
 *   node db/importer-reel.js --verifier                      contrôle, n'écrit rien
 *   node db/importer-reel.js --apercu                        ce qui va changer
 *   node db/importer-reel.js --appliquer --date-effet AAAA-MM-JJ
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CE SCRIPT PROTÈGE
 *
 *  Il touche aux BARÈMES, c'est-à-dire à ce qui sera facturé à 5 443
 *  commerçants. Trois garde-fous, dans cet ordre :
 *
 *   1. TOUT est validé AVANT d'écrire quoi que ce soit. Une seule erreur
 *      dans un fichier annule l'import entier.
 *   2. Les barèmes ne sont jamais modifiés en place : les anciens sont CLOS
 *      à la date d'effet, les nouveaux prennent le relais. Les avis déjà
 *      émis restent explicables.
 *   3. Tout se fait dans UNE transaction, après une sauvegarde automatique.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const DOSSIER = path.join(__dirname, 'donnees-reelles');

const C = {
  gras: (t) => `\x1b[1m${t}\x1b[0m`,
  vert: (t) => `\x1b[32m${t}\x1b[0m`,
  rouge: (t) => `\x1b[31m${t}\x1b[0m`,
  jaune: (t) => `\x1b[33m${t}\x1b[0m`,
  gris: (t) => `\x1b[90m${t}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function chargerEnv() {
  const chemin = path.join(RACINE, '.env');
  if (!fs.existsSync(chemin)) {
    console.error(C.rouge('\n  .env introuvable.\n'));
    process.exit(1);
  }
  for (const ligne of fs.readFileSync(chemin, 'utf8').split('\n')) {
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
chargerEnv();

const CONTENEUR = process.env.PG_CONTENEUR || 'gtfc-postgres';

/**
 * Requête SQL via le conteneur : évite d'exiger psql sur l'hôte.
 *
 * Le SQL passe par l'ENTRÉE STANDARD, jamais par `-c`. Un import complet fait
 * une centaine d'instructions, ce qui dépasse la longueur maximale d'une ligne
 * de commande sous Windows (~32 000 caractères) — l'appel échouait alors sur
 * un « ENAMETOOLONG » incompréhensible. L'entrée standard n'a pas de limite.
 */
function sql(requete, { silencieux = false } = {}) {
  try {
    return execFileSync('docker', [
      'exec', '-i',
      '-e', `PGPASSWORD=${process.env.DB_SUPERUSER_PASSWORD}`,
      CONTENEUR, 'psql', '-tAX', '-F', '', '-v', 'ON_ERROR_STOP=1',
      '-U', process.env.DB_SUPERUSER, '-d', process.env.DB_NAME,
    ], { encoding: 'utf8', input: requete, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    if (!silencieux) {
      console.error(C.rouge(`\n  Erreur SQL : ${(err.stderr || err.message).toString().trim()}\n`));
    }
    throw err;
  }
}

const lignes = (sortie) => sortie.trim().split('\n').filter(Boolean)
  .map((l) => l.split(''));

// ---------------------------------------------------------------------------
// Lecture des CSV
// ---------------------------------------------------------------------------
function lireCsv(nom) {
  const chemin = path.join(DOSSIER, nom);
  if (!fs.existsSync(chemin)) {
    throw new Error(`Fichier manquant : db/donnees-reelles/${nom}`);
  }
  // Excel sous Windows préfixe un BOM ; sans ce retrait, la première colonne
  // s'appellerait « ﻿code » et rien ne correspondrait.
  let texte = fs.readFileSync(chemin, 'utf8').replace(/^﻿/, '');
  const brut = texte.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (brut.length < 2) throw new Error(`${nom} est vide`);

  const entetes = brut[0].split(';').map((h) => h.trim());
  return brut.slice(1).map((ligne, i) => {
    const cellules = ligne.split(';');
    const objet = { _ligne: i + 2 };
    entetes.forEach((h, j) => { objet[h] = (cellules[j] ?? '').trim(); });
    return objet;
  });
}

const estVide = (v) => v === undefined || v === null || v === '';
const nombre = (v) => (estVide(v) ? null : Number(String(v).replace(',', '.').replace(/\s/g, '')));
const booleen = (v) => ['oui', 'true', '1', 'o'].includes(String(v).toLowerCase().trim());
const echapper = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const erreurs = [];
const alertes = [];
const err = (fichier, ligne, message) => erreurs.push(`${fichier}:${ligne} — ${message}`);
const avert = (fichier, ligne, message) => alertes.push(`${fichier}:${ligne} — ${message}`);

function valider() {
  const donnees = {
    zones: lireCsv('1-zones.csv'),
    quartiers: lireCsv('2-quartiers.csv'),
    categories: lireCsv('3-categories.csv'),
    parametres: lireCsv('4-parametres.csv'),
    baremes: lireCsv('5-baremes.csv'),
    marches: lireCsv('6-marches-emplacements.csv'),
  };

  // --- Zones -------------------------------------------------------------
  const codesZones = new Set();
  for (const z of donnees.zones) {
    if (estVide(z.code)) err('1-zones', z._ligne, 'code manquant');
    if (estVide(z.nom)) err('1-zones', z._ligne, 'nom manquant');
    if (codesZones.has(z.code)) err('1-zones', z._ligne, `code « ${z.code} » en double`);
    codesZones.add(z.code);
    if (String(z.nom).includes('À_REMPLACER')) {
      avert('1-zones', z._ligne, `le nom est encore provisoire : « ${z.nom} »`);
    }
  }

  // --- Quartiers ---------------------------------------------------------
  const codesQuartiers = new Set();
  for (const q of donnees.quartiers) {
    if (estVide(q.code)) err('2-quartiers', q._ligne, 'code manquant');
    if (estVide(q.nom)) err('2-quartiers', q._ligne, 'nom manquant');
    if (codesQuartiers.has(q.code)) err('2-quartiers', q._ligne, `code « ${q.code} » en double`);
    codesQuartiers.add(q.code);
    // Un quartier rattaché à une zone inexistante casserait la cohérence
    // territoriale que la base impose par déclencheur.
    if (!codesZones.has(q.zone_code)) {
      err('2-quartiers', q._ligne, `zone « ${q.zone_code} » inconnue (voir 1-zones.csv)`);
    }
    if (String(q.nom).includes('À_REMPLACER')) {
      avert('2-quartiers', q._ligne, `le nom est encore provisoire : « ${q.nom} »`);
    }
  }

  // --- Catégories --------------------------------------------------------
  const codesCategories = new Set();
  for (const c of donnees.categories) {
    if (estVide(c.code)) err('3-categories', c._ligne, 'code manquant');
    if (estVide(c.libelle)) err('3-categories', c._ligne, 'libellé manquant');
    if (codesCategories.has(c.code)) err('3-categories', c._ligne, `code « ${c.code} » en double`);
    codesCategories.add(c.code);
    if (String(c.libelle).includes('À_REMPLACER')) {
      avert('3-categories', c._ligne, `libellé encore provisoire : « ${c.libelle} »`);
    }
  }

  // --- Paramètres --------------------------------------------------------
  const params = {};
  for (const p of donnees.parametres) {
    if (estVide(p.parametre)) continue;
    params[p.parametre] = p.valeur;
  }

  const jour = nombre(params.jour_exigibilite);
  if (jour === null || jour < 1 || jour > 28) {
    err('4-parametres', '-', 'jour_exigibilite doit être entre 1 et 28 '
      + '(28 au maximum pour rester valide en février)');
  }
  const taux = nombre(params.taux_penalite_pct);
  if (taux === null || taux < 0 || taux > 100) {
    err('4-parametres', '-', 'taux_penalite_pct doit être entre 0 et 100');
  }
  if (!['superieur', 'inferieur', 'proche', 'dixieme'].includes(params.todp_arrondi)) {
    err('4-parametres', '-', `todp_arrondi « ${params.todp_arrondi} » invalide `
      + '(superieur | inferieur | proche | dixieme)');
  }
  if (estVide(params.delib_reference) || String(params.delib_reference).includes('À_REMPLACER')) {
    avert('4-parametres', '-', 'delib_reference non renseignée — elle figurera sur les quittances');
  }
  if (!estVide(params.delib_date) && !String(params.delib_date).includes('À_REMPLACER')
      && !/^\d{4}-\d{2}-\d{2}$/.test(params.delib_date)) {
    err('4-parametres', '-', 'delib_date doit être au format AAAA-MM-JJ');
  }

  // --- Barèmes -----------------------------------------------------------
  const TAXES = ['patente', 'todp', 'teom', 'droit_place', 'enseigne'];
  const parTaxe = {};

  for (const b of donnees.baremes) {
    if (estVide(b.taxe)) continue;
    if (!TAXES.includes(b.taxe)) {
      err('5-baremes', b._ligne, `taxe « ${b.taxe} » inconnue (${TAXES.join(', ')})`);
      continue;
    }
    (parTaxe[b.taxe] ??= []).push(b);

    const montant = nombre(b.montant);
    const unitaire = nombre(b.montant_unitaire);

    if (montant === null && unitaire === null) {
      err('5-baremes', b._ligne, 'ni montant ni montant_unitaire — ligne inexploitable');
    }
    if (montant !== null && (Number.isNaN(montant) || montant < 0)) {
      err('5-baremes', b._ligne, `montant invalide : « ${b.montant} »`);
    }
    if (unitaire !== null && (Number.isNaN(unitaire) || unitaire < 0)) {
      err('5-baremes', b._ligne, `montant_unitaire invalide : « ${b.montant_unitaire} »`);
    }

    // Le critère doit exister : un tarif rattaché à une catégorie inconnue
    // ne s'appliquerait jamais, sans que personne ne s'en aperçoive.
    if (b.critere_type === 'categorie' && !codesCategories.has(b.critere_code)) {
      err('5-baremes', b._ligne, `catégorie « ${b.critere_code} » inconnue`);
    }
    if (b.critere_type === 'zone' && !codesZones.has(b.critere_code)) {
      err('5-baremes', b._ligne, `zone « ${b.critere_code} » inconnue`);
    }
    if (b.critere_type === 'emplacement'
        && !['TABLE', 'ETAL', 'CANTINE', 'HANGAR'].includes(b.critere_code)) {
      avert('5-baremes', b._ligne, `type d'emplacement « ${b.critere_code} » `
        + 'inhabituel — vérifiez qu\'il existe en base');
    }
  }

  // Chaque catégorie doit avoir un tarif de patente et de TEOM : sinon la
  // génération des avis échouera pour tous les commerces concernés.
  for (const taxe of ['patente', 'teom']) {
    const couvertes = new Set((parTaxe[taxe] ?? [])
      .filter((b) => b.critere_type === 'categorie').map((b) => b.critere_code));
    const manquantes = [...codesCategories].filter((c) => !couvertes.has(c));
    if (manquantes.length > 0) {
      err('5-baremes', '-', `${taxe} : aucun tarif pour ${manquantes.length} catégorie(s) — `
        + `${manquantes.slice(0, 6).join(', ')}${manquantes.length > 6 ? '…' : ''}`);
    }
  }

  for (const taxe of TAXES) {
    if (!parTaxe[taxe] || parTaxe[taxe].length === 0) {
      avert('5-baremes', '-', `aucun tarif pour « ${taxe} » — cette taxe ne sera pas facturée`);
    }
  }

  // --- Marchés et types d'emplacement ------------------------------------
  const codesEmplacements = new Set();
  for (const m of donnees.marches) {
    if (estVide(m.type)) continue;
    if (!['marche', 'emplacement'].includes(m.type)) {
      err('6-marches', m._ligne, `type « ${m.type} » inconnu (marche | emplacement)`);
      continue;
    }
    if (estVide(m.code)) err('6-marches', m._ligne, 'code manquant');
    if (estVide(m.libelle)) err('6-marches', m._ligne, 'libellé manquant');
    if (m.type === 'emplacement') codesEmplacements.add(m.code);
    // Un marché rattaché à un quartier inexistant serait invisible sur la carte
    if (m.type === 'marche' && !estVide(m.quartier_code)
        && !codesQuartiers.has(m.quartier_code)) {
      err('6-marches', m._ligne, `quartier « ${m.quartier_code} » inconnu`);
    }
    if (String(m.libelle).includes('À_REMPLACER')) {
      avert('6-marches', m._ligne, `libellé encore provisoire : « ${m.libelle} »`);
    }
  }

  // Un tarif de droit de place qui viserait un emplacement absent du fichier
  // ne s'appliquerait jamais — silencieusement.
  for (const b of donnees.baremes) {
    if (b.critere_type === 'emplacement' && codesEmplacements.size > 0
        && !codesEmplacements.has(b.critere_code)) {
      err('5-baremes', b._ligne,
        `emplacement « ${b.critere_code} » absent de 6-marches-emplacements.csv`);
    }
  }

  return { donnees, params, parTaxe, codesZones, codesCategories };
}

// ---------------------------------------------------------------------------
// Aperçu
// ---------------------------------------------------------------------------
function apercu(valide) {
  const { donnees, params, parTaxe } = valide;
  console.log(`\n${C.gras('Ce qui va changer')}\n`);

  const communeId = sql("SELECT id FROM app.commune WHERE actif ORDER BY est_pilote DESC LIMIT 1").trim();
  if (!communeId) { console.error(C.rouge('  Aucune commune active en base.')); process.exit(1); }

  let changements = 0;

  const comparer = (titre, actuels, nouveaux, cle, champ) => {
    const carte = new Map(actuels.map((a) => [a[0], a[1]]));
    const diff = nouveaux
      .filter((n) => carte.has(n[cle]) && carte.get(n[cle]) !== n[champ])
      .map((n) => [n[cle], carte.get(n[cle]), n[champ]]);
    const absents = nouveaux.filter((n) => !carte.has(n[cle]));

    if (diff.length === 0 && absents.length === 0) {
      console.log(`  ${C.gris(`${titre} : rien à changer`)}`);
      return;
    }
    console.log(`  ${C.gras(titre)}`);
    for (const [code, avant, apres] of diff.slice(0, 20)) {
      console.log(`    ${code}  ${C.gris(avant)}  →  ${C.vert(apres)}`);
      changements += 1;
    }
    if (diff.length > 20) console.log(C.gris(`    … et ${diff.length - 20} autres`));
    for (const a of absents) {
      console.log(`    ${C.jaune(`${a[cle]} — absent en base, sera ignoré`)}`);
    }
    console.log('');
  };

  comparer('Zones',
    lignes(sql(`SELECT code, nom FROM app.zone WHERE commune_id='${communeId}' ORDER BY code`)),
    donnees.zones, 'code', 'nom');

  comparer('Quartiers',
    lignes(sql(`SELECT code, nom FROM app.quartier WHERE commune_id='${communeId}' ORDER BY code`)),
    donnees.quartiers, 'code', 'nom');

  comparer('Marchés et emplacements',
    [
      ...lignes(sql(`SELECT code, nom FROM app.marche WHERE commune_id='${communeId}'`)),
      ...lignes(sql(`SELECT code, libelle FROM ref.type_emplacement WHERE commune_id='${communeId}'`)),
    ],
    donnees.marches, 'code', 'libelle');

  comparer('Catégories',
    lignes(sql(`SELECT code, libelle FROM ref.categorie_commerce WHERE commune_id='${communeId}' ORDER BY code`)),
    donnees.categories, 'code', 'libelle');

  // --- Barèmes -----------------------------------------------------------
  console.log(`  ${C.gras('Barèmes')}`);
  // On laisse PostgreSQL produire le libellé : `booleen::text` renvoie
  // « true »/« false », pas « t »/« f », et comparer au mauvais littéral
  // afficherait « officiel » sur un barème provisoire — exactement
  // l'information qu'il ne faut pas se tromper de sens.
  const actuels = lignes(sql(`
    SELECT t.code,
           COALESCE(b.montant_fixe::text, b.montant_unitaire::text, '—'),
           CASE WHEN b.a_remplacer THEN 'PROVISOIRE' ELSE 'officiel' END,
           b.date_effet::text
      FROM app.bareme_taxe b JOIN ref.type_taxe t ON t.id = b.type_taxe_id
     WHERE b.commune_id='${communeId}' AND b.date_fin IS NULL
     ORDER BY t.ordre_affichage`));

  for (const [code, valeur, provisoire, effet] of actuels) {
    const nb = (parTaxe[code] ?? []).length;
    const etat = provisoire === 'PROVISOIRE' ? C.jaune('PROVISOIRE') : C.vert('officiel');
    console.log(`    ${code.padEnd(13)} ${etat}  en vigueur depuis le ${effet}`);
    console.log(`      ${C.gris(`sera clos, remplacé par ${nb} ligne(s) du fichier`)}`);
    changements += nb;
  }

  for (const taxe of Object.keys(parTaxe)) {
    if (!actuels.some((a) => a[0] === taxe)) {
      console.log(`    ${C.jaune(`${taxe} — aucun barème actuel, un nouveau sera créé`)}`);
    }
  }

  console.log(`\n  ${C.gras('Paramètres de facturation')}`);
  const paramsActuels = lignes(sql(`
    SELECT jour_exigibilite::text, taux_penalite_pct::text,
           todp_surface_minimale_m2::text, todp_arrondi
      FROM app.commune_parametre WHERE commune_id='${communeId}'`))[0] ?? [];
  const paires = [
    ['Jour d\'exigibilité', paramsActuels[0], params.jour_exigibilite],
    ['Pénalité (%)', paramsActuels[1], params.taux_penalite_pct],
    ['Surface TODP minimale', paramsActuels[2], params.todp_surface_minimale_m2],
    ['Arrondi TODP', paramsActuels[3], params.todp_arrondi],
  ];
  for (const [libelle, avant, apres] of paires) {
    const change = String(Number(avant)) !== String(Number(apres)) && avant !== apres;
    console.log(`    ${libelle.padEnd(24)} ${C.gris(avant ?? '—')} → ${change ? C.vert(apres) : C.gris(apres)}`);
  }

  console.log(`\n  ${changements} modification(s) au total\n`);
  return communeId;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
function appliquer(valide, communeId, dateEffet) {
  const { donnees, params, parTaxe } = valide;

  // Un barème ne peut pas prendre effet avant un avis déjà émis : cela
  // rendrait inexplicables des quittances déjà remises.
  const dernierAvis = sql(`
    SELECT COALESCE(max(p.date_fin)::text, '')
      FROM app.avis_imposition a JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE a.commune_id='${communeId}' AND a.statut <> 'brouillon'`).trim();

  if (dernierAvis && dateEffet <= dernierAvis) {
    console.error(C.rouge(`\n  Date d'effet refusée.`));
    console.error(`  Des avis ont déjà été émis jusqu'au ${dernierAvis}.`);
    console.error(`  Choisissez une date postérieure — par exemple le 1er du mois suivant.\n`);
    process.exit(1);
  }

  console.log(`\n  ${C.gris('Sauvegarde de sécurité…')}`);
  try {
    execFileSync('bash', [path.join(RACINE, 'scripts/backup-postgres.sh')],
      { cwd: RACINE, stdio: 'pipe' });
    console.log(`  ${C.vert('✓')} sauvegarde effectuée`);
  } catch {
    console.log(`  ${C.jaune('!')} sauvegarde impossible — on continue à votre demande`);
  }

  const instructions = ['BEGIN;'];
  const delibRef = String(params.delib_reference ?? '').includes('À_REMPLACER')
    ? null : params.delib_reference;
  const delibDate = /^\d{4}-\d{2}-\d{2}$/.test(String(params.delib_date ?? ''))
    ? params.delib_date : null;

  // --- Territoire et catégories -----------------------------------------
  for (const z of donnees.zones) {
    instructions.push(`UPDATE app.zone SET nom=${echapper(z.nom)},
      description=${echapper(z.description || null)}, a_remplacer=false
      WHERE commune_id='${communeId}' AND code=${echapper(z.code)};`);
  }
  for (const q of donnees.quartiers) {
    instructions.push(`UPDATE app.quartier q SET nom=${echapper(q.nom)},
      population=${nombre(q.population) ?? 'NULL'},
      nb_commerces_estime=${nombre(q.nb_commerces_estime) ?? 'NULL'},
      zone_id=(SELECT id FROM app.zone WHERE commune_id='${communeId}' AND code=${echapper(q.zone_code)}),
      a_remplacer=false
      WHERE q.commune_id='${communeId}' AND q.code=${echapper(q.code)};`);
  }
  for (const c of donnees.categories) {
    instructions.push(`UPDATE ref.categorie_commerce SET libelle=${echapper(c.libelle)},
      todp_probable=${booleen(c.todp_probable)},
      enseigne_probable=${booleen(c.enseigne_probable)},
      sur_marche=${booleen(c.sur_marche)}, a_remplacer=false
      WHERE commune_id='${communeId}' AND code=${echapper(c.code)};`);
  }

  for (const m of donnees.marches) {
    if (m.type === 'marche') {
      instructions.push(`UPDATE app.marche SET nom=${echapper(m.libelle)},
        nb_places=${nombre(m.nb_places) ?? 'NULL'},
        quartier_id=COALESCE((SELECT id FROM app.quartier
          WHERE commune_id='${communeId}' AND code=${echapper(m.quartier_code)}), quartier_id),
        a_remplacer=false
        WHERE commune_id='${communeId}' AND code=${echapper(m.code)};`);
    } else if (m.type === 'emplacement') {
      instructions.push(`UPDATE ref.type_emplacement SET libelle=${echapper(m.libelle)},
        surface_type_m2=${nombre(m.surface_type_m2) ?? 'NULL'}, a_remplacer=false
        WHERE commune_id='${communeId}' AND code=${echapper(m.code)};`);
    }
  }

  // --- Paramètres --------------------------------------------------------
  instructions.push(`UPDATE app.commune_parametre SET
    jour_exigibilite=${nombre(params.jour_exigibilite)},
    delai_grace_jours=${nombre(params.delai_grace_jours) ?? 5},
    taux_penalite_pct=${nombre(params.taux_penalite_pct)},
    penalite_plafond_pct=${nombre(params.penalite_plafond_pct) ?? 50},
    todp_surface_minimale_m2=${nombre(params.todp_surface_minimale_m2) ?? 1},
    todp_surface_maximale_m2=${nombre(params.todp_surface_maximale_m2) ?? 'NULL'},
    todp_arrondi=${echapper(params.todp_arrondi)},
    remise_paiement_annuel_pct=${nombre(params.remise_paiement_annuel_pct) ?? 0},
    encaissement_especes_autorise=${booleen(params.encaissement_especes_autorise)},
    objectif_visites_jour_agent=${nombre(params.objectif_visites_jour_agent) ?? 25},
    a_remplacer=false
    WHERE commune_id='${communeId}';`);

  // --- Barèmes : clore les anciens, créer les nouveaux --------------------
  instructions.push(`UPDATE app.bareme_taxe SET date_fin=${echapper(dateEffet)}
    WHERE commune_id='${communeId}' AND date_fin IS NULL
      AND date_effet < ${echapper(dateEffet)};`);

  // Un barème qui commencerait le même jour que le nouveau ne peut pas être
  // simplement clos (période vide) : on le supprime.
  instructions.push(`DELETE FROM app.bareme_taxe
    WHERE commune_id='${communeId}' AND date_effet >= ${echapper(dateEffet)};`);

  const MODES = {
    patente: 'par_categorie', teom: 'par_categorie',
    todp: 'par_m2', enseigne: 'par_m2', droit_place: 'par_jour',
  };

  for (const [taxe, lignesTaxe] of Object.entries(parTaxe)) {
    if (lignesTaxe.length === 0) continue;
    const mode = MODES[taxe];
    const sansCritere = lignesTaxe.find((b) => estVide(b.critere_type));
    const unite = lignesTaxe.find((b) => !estVide(b.unite))?.unite ?? null;

    // Tarif de repli porté par l'en-tête du barème.
    //
    // Pour un calcul « au m² » ou « au jour », la base EXIGE un tarif unitaire
    // sur l'en-tête (contrainte bareme_montant_coherent) : c'est lui qui
    // s'applique si aucune tranche ne correspond — une zone créée après coup,
    // un type d'emplacement non tarifé. Sans ce repli, la taxe échouerait
    // silencieusement pour ces commerces.
    //
    // On prend le tarif de la première ligne, ou celui de la ligne sans
    // critère si elle existe.
    let unitaireGlobal = sansCritere ? nombre(sansCritere.montant_unitaire) : null;
    if (unitaireGlobal === null && ['par_m2', 'par_jour'].includes(mode)) {
      unitaireGlobal = lignesTaxe
        .map((b) => nombre(b.montant_unitaire))
        .find((v) => v !== null && v > 0) ?? null;

      if (unitaireGlobal === null) {
        console.error(C.rouge(`\n  ${taxe} : calcul « ${mode} » sans aucun tarif unitaire.`));
        console.error('  Renseignez la colonne montant_unitaire dans 5-baremes.csv.\n');
        process.exit(1);
      }
    }

    instructions.push(`
      INSERT INTO app.bareme_taxe (commune_id, type_taxe_id, libelle, mode_calcul,
        periodicite, montant_unitaire, unite, date_effet, delib_reference, delib_date,
        a_remplacer)
      SELECT '${communeId}', t.id,
             ${echapper(`Barème ${taxe} — ${delibRef ?? 'délibération communale'}`)},
             ${echapper(mode)}::app.mode_calcul_taxe, 'mensuelle',
             ${unitaireGlobal ?? 'NULL'}, ${echapper(unite)},
             ${echapper(dateEffet)}, ${echapper(delibRef)}, ${echapper(delibDate)}, false
        FROM ref.type_taxe t WHERE t.code=${echapper(taxe)};`);

    for (const b of lignesTaxe) {
      if (estVide(b.critere_type)) continue;
      const colonne = { categorie: 'categorie_id', zone: 'zone_id', emplacement: 'type_emplacement_id' }[b.critere_type];
      if (!colonne) continue;
      const source = {
        categorie: `(SELECT id FROM ref.categorie_commerce WHERE commune_id='${communeId}' AND code=${echapper(b.critere_code)})`,
        zone: `(SELECT id FROM app.zone WHERE commune_id='${communeId}' AND code=${echapper(b.critere_code)})`,
        emplacement: `(SELECT id FROM ref.type_emplacement WHERE commune_id='${communeId}' AND code=${echapper(b.critere_code)})`,
      }[b.critere_type];

      instructions.push(`
        INSERT INTO app.bareme_tranche (bareme_id, ${colonne}, libelle, borne_min, borne_max,
          montant, montant_unitaire, a_remplacer)
        SELECT b.id, ${source}, ${echapper(`${taxe} ${b.critere_code}`)},
               ${nombre(b.borne_min) ?? 'NULL'}, ${nombre(b.borne_max) ?? 'NULL'},
               ${nombre(b.montant) ?? 0}, ${nombre(b.montant_unitaire) ?? 'NULL'}, false
          FROM app.bareme_taxe b JOIN ref.type_taxe t ON t.id = b.type_taxe_id
         WHERE b.commune_id='${communeId}' AND t.code=${echapper(taxe)}
           AND b.date_effet=${echapper(dateEffet)};`);
    }
  }

  instructions.push('COMMIT;');

  console.log(`  ${C.gris(`${instructions.length - 2} instructions SQL, dans une seule transaction…`)}`);
  try {
    sql(instructions.join('\n'));
  } catch {
    console.error(C.rouge('\n  L\'import a échoué. RIEN n\'a été modifié (transaction annulée).\n'));
    process.exit(1);
  }

  console.log(`  ${C.vert('✓')} import appliqué\n`);

  const restant = sql(`SELECT count(*) FROM app.v_donnees_a_remplacer
    WHERE commune_id='${communeId}'`).trim();
  if (restant === '0') {
    console.log(`  ${C.vert(C.gras('Plus aucune donnée provisoire.'))}`);
    console.log('  La plateforme peut émettre des avis réels.\n');
  } else {
    console.log(`  ${C.jaune(`${restant} donnée(s) encore provisoire(s)`)}`);
    console.log(C.gris('  SELECT * FROM app.v_donnees_a_remplacer;\n'));
  }

  console.log(`  ${C.gras('À faire ensuite :')}`);
  console.log('    · Vérifier un montant sur une fiche commerce → « Calculer les montants dus »');
  console.log('    · bash scripts/recette.sh');
  console.log(`    · Les avis émis AVANT le ${dateEffet} gardent leur ancien tarif — c'est voulu\n`);
}

// ---------------------------------------------------------------------------
// Entrée
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const mode = args.find((a) => ['--verifier', '--apercu', '--appliquer'].includes(a)) ?? '--verifier';
const dateEffet = args[args.indexOf('--date-effet') + 1];

console.log(`\n${C.gras('Import des données officielles de la commune')}`);

let valide;
try {
  valide = valider();
} catch (e) {
  console.error(C.rouge(`\n  ${e.message}\n`));
  process.exit(1);
}

console.log(`\n${C.gras('Validation')}`);
if (erreurs.length > 0) {
  console.log(`\n  ${C.rouge(C.gras(`${erreurs.length} erreur(s) — rien ne sera importé`))}\n`);
  erreurs.forEach((e) => console.log(`  ${C.rouge('✗')} ${e}`));
  console.log(`\n  Corrigez les fichiers dans db/donnees-reelles/, puis relancez.\n`);
  process.exit(1);
}
console.log(`  ${C.vert('✓')} les 6 fichiers sont cohérents`);

if (alertes.length > 0) {
  console.log(`\n  ${C.jaune(`${alertes.length} avertissement(s)`)}`);
  alertes.slice(0, 12).forEach((a) => console.log(`  ${C.jaune('!')} ${a}`));
  if (alertes.length > 12) console.log(C.gris(`  … et ${alertes.length - 12} autres`));
}

if (mode === '--verifier') {
  console.log(`\n  Étape suivante :  node db/importer-reel.js --apercu\n`);
  process.exit(0);
}

const communeId = apercu(valide);

if (mode === '--apercu') {
  console.log(`  Pour appliquer :`);
  console.log(`    node db/importer-reel.js --appliquer --date-effet AAAA-MM-JJ\n`);
  process.exit(0);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEffet ?? '')) {
  console.error(C.rouge('\n  --date-effet AAAA-MM-JJ est obligatoire pour appliquer.'));
  console.error('  Choisissez le 1er d\'un mois à venir, par exemple le mois prochain.\n');
  process.exit(1);
}

if (alertes.some((a) => a.includes('À_REMPLACER') || a.includes('provisoire'))) {
  console.log(`  ${C.jaune(C.gras('Attention'))} : certaines valeurs sont encore provisoires.`);
  console.log(C.gris('  L\'import est possible, mais il restera des données à remplacer.\n'));
}

appliquer(valide, communeId, dateEffet);
