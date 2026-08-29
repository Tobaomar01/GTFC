/**
 * Ouverture et migration de la base SQLite locale.
 *
 * Règle intangible : une mise à jour de l'application ne détruit JAMAIS la
 * base. Un agent peut avoir trois jours de recensement non synchronisé au
 * moment où l'APK est mis à jour — effacer reviendrait à lui faire refaire
 * la tournée.
 */
import * as SQLite from 'expo-sqlite';
import { SCHEMA_SQL, MIGRATIONS, VERSION_SCHEMA } from './schema';

const NOM_BASE = 'gtfc-collecte.db';

let base = null;
let ouvertureEnCours = null;

/** Ouvre la base (une seule fois, même si plusieurs écrans la demandent). */
export async function ouvrirBase() {
  if (base) return base;
  if (ouvertureEnCours) return ouvertureEnCours;

  ouvertureEnCours = (async () => {
    const db = await SQLite.openDatabaseAsync(NOM_BASE);

    // WAL : les lectures ne bloquent pas les écritures. Sur le terrain, la
    // synchronisation écrit pendant que l'agent consulte une fiche.
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    await db.execAsync(SCHEMA_SQL);

    await appliquerMigrations(db);

    base = db;
    ouvertureEnCours = null;
    return db;
  })();

  return ouvertureEnCours;
}

async function appliquerMigrations(db) {
  const ligne = await db.getFirstAsync(
    "SELECT valeur FROM meta WHERE cle = 'version_schema'",
  );
  const versionActuelle = ligne ? Number(ligne.valeur) : 0;

  if (versionActuelle === 0) {
    await db.runAsync(
      "INSERT OR REPLACE INTO meta (cle, valeur) VALUES ('version_schema', ?)",
      [String(VERSION_SCHEMA)],
    );
    return;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= versionActuelle) continue;
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration.sql);
      await db.runAsync(
        "UPDATE meta SET valeur = ? WHERE cle = 'version_schema'",
        [String(migration.version)],
      );
    });
  }
}

/** Raccourcis. Chaque appel garantit que la base est ouverte. */
export async function lireTout(sql, params = []) {
  const db = await ouvrirBase();
  return db.getAllAsync(sql, params);
}

export async function lirePremier(sql, params = []) {
  const db = await ouvrirBase();
  return db.getFirstAsync(sql, params);
}

export async function executer(sql, params = []) {
  const db = await ouvrirBase();
  return db.runAsync(sql, params);
}

/**
 * Transaction. À utiliser dès qu'une action touche plusieurs tables :
 * créer un commerce écrit dans `commerce`, `commerce_taxe` ET
 * `operation_sync`. Les trois doivent réussir ou échouer ensemble, sinon on
 * obtient un commerce que la synchronisation ne remontera jamais.
 */
export async function transaction(fn) {
  const db = await ouvrirBase();
  let resultat;
  await db.withTransactionAsync(async () => {
    resultat = await fn(db);
  });
  return resultat;
}

// ---------------------------------------------------------------------------
// Métadonnées
// ---------------------------------------------------------------------------
export async function lireMeta(cle, defaut = null) {
  const l = await lirePremier('SELECT valeur FROM meta WHERE cle = ?', [cle]);
  return l ? l.valeur : defaut;
}

export async function ecrireMeta(cle, valeur) {
  await executer(
    'INSERT INTO meta (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur',
    [cle, valeur == null ? null : String(valeur)],
  );
}

// ---------------------------------------------------------------------------
// Journal local
// ---------------------------------------------------------------------------
export async function journaliser(niveau, message, detail = null) {
  try {
    await executer(
      'INSERT INTO journal_local (niveau, message, detail, horodatage) VALUES (?, ?, ?, ?)',
      [niveau, String(message).slice(0, 500),
        detail ? JSON.stringify(detail).slice(0, 2000) : null,
        new Date().toISOString()],
    );
  } catch {
    // Le journal ne doit jamais faire échouer une action métier.
  }
}

/** Conserve les 500 dernières lignes : un téléphone d'entrée de gamme n'a pas
 *  de place à gaspiller, et au-delà le journal n'aide plus au diagnostic. */
export async function purgerJournal() {
  await executer(
    'DELETE FROM journal_local WHERE id < (SELECT COALESCE(MAX(id), 0) - 500 FROM journal_local)',
  );
}

// ---------------------------------------------------------------------------
// Diagnostic — écran « Paramètres »
// ---------------------------------------------------------------------------
export async function statistiquesBase() {
  const [commerces, enAttente, photos, visites, paiements, conflits] = await Promise.all([
    lirePremier('SELECT count(*) AS n FROM commerce'),
    lirePremier("SELECT count(*) AS n FROM operation_sync WHERE statut = 'en_attente'"),
    lirePremier('SELECT count(*) AS n FROM photo_locale WHERE envoyee = 0'),
    lirePremier('SELECT count(*) AS n FROM visite WHERE envoyee = 0'),
    lirePremier('SELECT count(*) AS n FROM paiement WHERE envoye = 0'),
    lirePremier("SELECT count(*) AS n FROM operation_sync WHERE statut = 'conflit'"),
  ]);

  return {
    commerces: commerces?.n ?? 0,
    operations_en_attente: enAttente?.n ?? 0,
    photos_en_attente: photos?.n ?? 0,
    visites_en_attente: visites?.n ?? 0,
    paiements_en_attente: paiements?.n ?? 0,
    conflits: conflits?.n ?? 0,
    derniere_sync: await lireMeta('derniere_sync'),
  };
}

/**
 * Remise à zéro.
 *
 * Volontairement refusée s'il reste du travail non synchronisé : c'est le seul
 * garde-fou contre la perte définitive d'une journée de terrain. Le paramètre
 * `forcer` existe pour les cas désespérés, et l'écran qui l'appelle affiche
 * précisément ce qui va être perdu.
 */
export async function reinitialiser({ forcer = false } = {}) {
  const stats = await statistiquesBase();
  const enAttente = stats.operations_en_attente + stats.photos_en_attente;

  if (enAttente > 0 && !forcer) {
    const err = new Error(
      `${enAttente} élément(s) ne sont pas encore synchronisés. `
      + 'Synchronisez avant de réinitialiser, sinon ce travail sera perdu.',
    );
    err.code = 'TRAVAIL_NON_SYNCHRONISE';
    err.enAttente = enAttente;
    throw err;
  }

  const db = await ouvrirBase();
  await db.execAsync(`
    DELETE FROM operation_sync;
    DELETE FROM photo_locale;
    DELETE FROM paiement;
    DELETE FROM visite;
    DELETE FROM commerce_taxe;
    DELETE FROM commerce;
    DELETE FROM referentiel;
    DELETE FROM journal_local;
    DELETE FROM meta WHERE cle <> 'version_schema';
  `);
  return true;
}
