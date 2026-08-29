/**
 * Formatage et vocabulaire partagés.
 *
 * Les libellés de statut sont les MÊMES que dans l'application Android : un
 * agent et un agent de mairie doivent lire le même mot pour le même état.
 */

/** Francs CFA : jamais de décimale. */
export function xof(montant, { court = false } = {}) {
  const n = Math.round(Number(montant) || 0);
  if (court && Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M FCFA`;
  if (court && Math.abs(n) >= 10_000) return `${Math.round(n / 1000)} k FCFA`;
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

export const nombre = (v) => Math.round(Number(v) || 0)
  .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function pourcentage(v, { decimales = 1 } = {}) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(decimales).replace('.', ',')} %`;
}

export function date(iso, { avecHeure = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const j = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return avecHeure
    ? `${j} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : j;
}

export function delai(iso) {
  if (!iso) return 'jamais';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;
  const jours = Math.floor(heures / 24);
  return jours === 1 ? 'hier' : `il y a ${jours} jours`;
}

export function moisFr(code) {
  if (!code) return '—';
  const [annee, mois] = String(code).split('-');
  const noms = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
    'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  return `${noms[Number(mois) - 1] ?? mois} ${annee}`;
}

/**
 * Statuts fiscaux.
 *
 * `icone` et `libelle` accompagnent TOUJOURS la couleur : un statut ne se lit
 * jamais à la teinte seule. C'est la règle qui rend la palette utilisable par
 * un daltonien, en impression noir et blanc, et en contraste forcé.
 */
export const STATUTS = {
  a_jour: { libelle: 'À jour', court: 'À jour', variable: '--st-ajour', fond: '--st-ajour-fond', icone: '✓' },
  partiel: { libelle: 'Paiement partiel', court: 'Partiel', variable: '--st-partiel', fond: '--st-partiel-fond', icone: '◐' },
  impaye: { libelle: 'Impayé', court: 'Impayé', variable: '--st-impaye', fond: '--st-impaye-fond', icone: '!' },
  exonere: { libelle: 'Exonéré', court: 'Exonéré', variable: '--st-exonere', fond: '--st-exonere-fond', icone: '—' },
  inconnu: { libelle: 'Non facturé', court: 'Non facturé', variable: '--st-inconnu', fond: '--st-inconnu-fond', icone: '?' },
};

/** Ordre d'affichage : du meilleur au pire, puis les états neutres. */
export const ORDRE_STATUTS = ['a_jour', 'partiel', 'impaye', 'exonere', 'inconnu'];

export const STATUTS_COMMERCE = {
  actif: 'Ouvert',
  ferme_temporaire: 'Fermé temporairement',
  ferme_definitif: "Cessation d'activité",
  introuvable: 'Introuvable',
  archive: 'Archivé',
};

export const MOYENS_PAIEMENT = {
  wave: 'Wave',
};

export const ACTIONS_AUDIT = {
  creation: 'Création',
  modification: 'Modification',
  archivage: 'Archivage',
  consultation: 'Consultation',
  connexion: 'Connexion',
  deconnexion: 'Déconnexion',
  connexion_echouee: 'Connexion refusée',
  paiement: 'Paiement',
  exoneration: 'Exonération',
  export: 'Export',
  impression_quittance: 'Impression de quittance',
  changement_bareme: 'Changement de barème',
};

export const ROLES = {
  agent: 'Agent de terrain',
  superviseur: 'Superviseur',
  admin_commune: 'Administrateur de la commune',
  super_admin: 'Super-administrateur',
  // Hors hiérarchie : il détient les dérogations, pas le barème. Il est
  // volontairement absent de NIVEAU ci-dessous — le ranger sur l'échelle
  // donnerait ses pouvoirs au super-administrateur (Constitution III).
  chef_projet: 'Chef de projet',
  maire: 'Maire',
};

/** Profils qui consultent sans jamais écrire. */
export const LECTURE_SEULE = new Set(['maire']);
export const consulteSeulement = (role) => LECTURE_SEULE.has(role);

/** Le rôle donne accès à ce que peuvent les rôles au-dessous. */
// Le maire est au niveau du superviseur : il voit tous les écrans de
// consultation de sa commune. Ce n'est pas une équivalence de pouvoir — ce
// qu'il peut écrire est fermé par l'API, à l'authentification.
const NIVEAU = {
  agent: 1, superviseur: 2, maire: 2, admin_commune: 3, super_admin: 4,
};
export const auMoins = (role, minimum) => (NIVEAU[role] ?? 0) >= (NIVEAU[minimum] ?? 99);
