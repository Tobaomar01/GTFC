/**
 * Thème visuel.
 *
 * Contraintes de terrain qui ont dicté ces choix :
 *   - l'agent travaille EN PLEIN SOLEIL : contrastes élevés, aucun gris clair
 *     sur blanc, pas de texte fin ;
 *   - il tape avec le pouce, parfois debout : cibles tactiles de 48 px minimum,
 *     jamais deux boutons destructeurs côte à côte ;
 *   - les couleurs de statut fiscal reprennent EXACTEMENT la convention du
 *     cahier des charges (vert / orange / rouge), pour que l'app et la carte du
 *     dashboard racontent la même chose.
 */

export const couleurs = {
  primaire: '#0B5D2B',
  primaireClair: '#1D7A45',
  primaireFonce: '#073F1D',
  accent: '#CF8000',

  fond: '#F5F6F4',
  surface: '#FFFFFF',
  surfaceAlt: '#EDF1EC',
  bordure: '#D3DAD2',

  texte: '#16211A',
  texteSecondaire: '#4A5850',
  texteInverse: '#FFFFFF',
  texteDesactive: '#8A968F',

  // Convention du cahier des charges. Ces valeurs sont VALIDÉES : les six
  // contrôles de la méthode de visualisation passent dans les deux modes
  // (séparation daltonisme, contraste, bande de clarté). Ne pas les modifier
  // sans relancer la validation — voir docs/PHASE-6-dashboard.md.
  aJour: '#1D7A45',
  partiel: '#CF8000',
  impaye: '#B3261E',
  exonere: '#6B7A72',
  inconnu: '#4A6FA5',

  succes: '#1D7A45',
  avertissement: '#CF8000',
  erreur: '#B3261E',
  info: '#4A6FA5',

  horsLigne: '#8A6D3B',
  horsLigneFond: '#FCF4E3',
};

export const STATUTS_FISCAUX = {
  a_jour: { libelle: 'À jour', couleur: couleurs.aJour, icone: 'checkmark-circle' },
  partiel: { libelle: 'Paiement partiel', couleur: couleurs.partiel, icone: 'time' },
  impaye: { libelle: 'Impayé', couleur: couleurs.impaye, icone: 'alert-circle' },
  exonere: { libelle: 'Exonéré', couleur: couleurs.exonere, icone: 'shield-checkmark' },
  inconnu: { libelle: 'Non facturé', couleur: couleurs.inconnu, icone: 'help-circle' },
};

export const STATUTS_COMMERCE = {
  actif: 'Ouvert',
  ferme_temporaire: 'Fermé temporairement',
  ferme_definitif: 'Cessation d\'activité',
  introuvable: 'Introuvable',
  archive: 'Archivé',
};

export const RESULTATS_VISITE = {
  controle: 'Contrôle effectué',
  mise_a_jour: 'Fiche mise à jour',
  ferme: 'Commerce fermé',
  refus: 'Refus du commerçant',
  introuvable: 'Commerce introuvable',
};

export const espacements = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 };

export const rayons = { s: 6, m: 10, l: 16, rond: 999 };

export const typographie = {
  titre: { fontSize: 22, fontWeight: '700', color: couleurs.texte },
  sousTitre: { fontSize: 17, fontWeight: '600', color: couleurs.texte },
  corps: { fontSize: 16, color: couleurs.texte },
  // 14 px est le plancher : en dessous, illisible au soleil pour un agent
  // qui ne porte pas ses lunettes.
  petit: { fontSize: 14, color: couleurs.texteSecondaire },
  etiquette: { fontSize: 14, fontWeight: '600', color: couleurs.texteSecondaire },
  monospace: { fontFamily: 'monospace', fontSize: 15, color: couleurs.texte },
};

/** Hauteur minimale d'un élément tactile — recommandation Android. */
export const CIBLE_TACTILE = 48;

export const ombre = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.08,
  shadowRadius: 4,
  elevation: 2,
};

/** Montants en francs CFA : jamais de décimale, séparateur de milliers. */
export function formaterXof(montant) {
  const n = Math.round(Number(montant) || 0);
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

export function formaterDate(iso, { avecHeure = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (!avecHeure) return date;
  return `${date} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

export function formaterDelai(iso) {
  if (!iso) return 'jamais';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'à l\'instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;
  const jours = Math.floor(heures / 24);
  return jours === 1 ? 'hier' : `il y a ${jours} jours`;
}
