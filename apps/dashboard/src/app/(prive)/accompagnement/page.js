'use client';

/**
 * Accompagnement — à qui le temps d'un agent profite-t-il le plus.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CETTE PAGE EST, ET CE QU'ELLE N'EST PAS
 *
 *  Elle ordonne des VISITES D'EXPLICATION. Elle ne décide rien : ni relance,
 *  ni mise en recouvrement, ni pénalité (FR-088). Un indicateur n'est pas une
 *  décision administrative, et le jour où il en déclencherait une, il faudrait
 *  l'écrire dans la constitution avant de l'écrire dans le code.
 *
 *  ELLE RESTE À LA MAIRIE. L'agent de terrain ne voit pas de niveau sur son
 *  téléphone : il lit un motif en clair — « paiement interrompu » — qui dit
 *  quoi faire sans porter de jugement. Quelqu'un qui lit « risque élevé »
 *  avant d'entrer ne parle pas de la même façon à la personne qu'il visite.
 *
 *  LE NIVEAU NE S'AFFICHE JAMAIS SEUL. FR-086 : chaque ligne porte les
 *  facteurs qui l'ont formée. Un classement qu'on ne peut pas expliquer au
 *  commerçant qu'il désigne n'a rien à faire dans une administration — et un
 *  superviseur qui envoie un agent doit pouvoir dire pourquoi.
 *
 *  « INDÉTERMINÉ » EST UNE RÉPONSE. En dessous du nombre de mois observés
 *  minimal, le système refuse de classer (FR-087). Ce n'est pas un défaut
 *  d'affichage : c'est le refus de faire passer un historique trop mince pour
 *  de la connaissance.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { xof, date as formaterDate } from '@/lib/format';
import { Carte, Tableau, Chargement, Message, EtatVide, Bouton } from '@/composants/ui';

/**
 * Les quatre réponses possibles.
 *
 * La couleur ne porte JAMAIS l'information seule : un symbole et un libellé
 * l'accompagnent toujours, comme pour les statuts fiscaux. Un écran de mairie
 * doit rester lisible par un daltonien et en impression noir et blanc.
 */
const NIVEAUX = {
  eleve: {
    libelle: 'Élevé', icone: '▲',
    aide: 'À voir en priorité.',
    fond: '--st-impaye-fond', variable: '--st-impaye',
  },
  attention: {
    libelle: 'Attention', icone: '◆',
    aide: 'À inscrire dans une tournée prochaine.',
    fond: '--st-partiel-fond', variable: '--st-partiel',
  },
  faible: {
    libelle: 'Faible', icone: '●',
    aide: 'Rien à signaler.',
    fond: '--st-ajour-fond', variable: '--st-ajour',
  },
  indetermine: {
    libelle: 'Indéterminé', icone: '—',
    aide: 'Pas assez de mois observés pour se prononcer.',
    fond: '--st-inconnu-fond', variable: '--st-inconnu',
  },
};

const FILTRES = [
  ['eleve', 'Élevés'],
  ['attention', 'Attention'],
  ['faible', 'Faibles'],
  ['indetermine', 'Indéterminés'],
  ['', 'Tous'],
];

export default function PageAccompagnement() {
  const [donnees, setDonnees] = useState(null);
  const [erreur, setErreur] = useState(null);
  // On atterrit sur TOUS, et non sur « élevés ».
  //
  // Tant que la mémoire est mince, tout est « indéterminé » : ouvrir sur les
  // élevés donnerait une page vide, qu'un superviseur lirait comme une panne
  // plutôt que comme une absence d'historique.
  const [niveau, setNiveau] = useState('');
  const [detail, setDetail] = useState(null);

  const charger = useCallback(async () => {
    try {
      setErreur(null);
      setDonnees(await api.get('/stats/risque-defaut', niveau ? { niveau } : {}));
    } catch (err) { setErreur(err.message); }
  }, [niveau]);

  useEffect(() => { charger(); }, [charger]);

  if (erreur && !donnees) {
    return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  }
  if (!donnees) return <Chargement />;

  const lignes = donnees.donnees ?? donnees;
  const total = donnees.pagination?.total ?? lignes.length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-encre">Accompagnement</h1>
        <p className="mt-1 max-w-2xl text-sm text-encre-2">
          Qui a besoin qu&apos;on lui explique le dispositif, et pourquoi. Cette page
          ordonne des visites — elle ne décide d&apos;aucune relance et d&apos;aucune
          poursuite. Les agents ne voient pas ces niveaux : ils reçoivent un motif
          de visite en clair.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTRES.map(([valeur, libelle]) => (
          <Bouton
            key={valeur || 'tous'}
            variante={niveau === valeur ? 'primaire' : 'secondaire'}
            onClick={() => setNiveau(valeur)}
          >
            {libelle}
          </Bouton>
        ))}
      </div>

      <Carte titre={`${total} commerce(s)`}>
        {lignes.length === 0 ? (
          <EtatVide
            titre="Aucun commerce dans cette catégorie"
            texte={
              niveau === 'indetermine'
                ? 'Tous les commerces observés ont assez d’historique pour être classés.'
                : 'Rien à signaler ici. La mémoire mensuelle se constitue le 1er de chaque mois.'
            }
          />
        ) : (
          <Tableau
            cle="commerce_id"
            lignes={lignes}
            colonnes={[
              {
                cle: 'niveau',
                titre: 'Niveau',
                rendu: (l) => {
                  const n = NIVEAUX[l.niveau] ?? NIVEAUX.indetermine;
                  return (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-medium"
                      style={{ background: `var(${n.fond})`, color: `var(${n.variable})` }}
                      title={n.aide}
                    >
                      <span aria-hidden="true" className="font-bold leading-none">{n.icone}</span>
                      {n.libelle}
                    </span>
                  );
                },
              },
              { cle: 'code', titre: 'Code', monospace: true },
              { cle: 'enseigne', titre: 'Enseigne' },
              {
                cle: 'gerant',
                titre: 'Gérant',
                rendu: (l) => [l.gerant_prenom, l.gerant_nom].filter(Boolean).join(' ') || '—',
              },
              {
                cle: 'nb_mois',
                titre: 'Mois observés',
                alignement: 'droite',
                rendu: (l) => (l.nb_mois < l.mois_minimaux
                  ? `${l.nb_mois} / ${l.mois_minimaux}`
                  : String(l.nb_mois)),
              },
              {
                // FR-086 : le niveau ne se montre jamais sans ce qui l'a formé.
                // Ce n'est pas un détail que l'on déplie : c'est la ligne.
                cle: 'facteurs',
                titre: 'Ce qui l’a formé',
                rendu: (l) => (
                  (l.facteurs ?? []).length === 0
                    ? <span className="text-encre-attenuee">Rien à signaler</span>
                    : (
                      <ul className="space-y-0.5">
                        {(l.facteurs ?? []).map((f) => (
                          <li key={f.code} className="text-[13px]">
                            {f.libelle}
                            <span className="ml-1 text-encre-attenuee">({f.poids})</span>
                          </li>
                        ))}
                      </ul>
                    )
                ),
              },
              {
                titre: 'Mémoire',
                rendu: (l) => (
                  <Bouton variante="secondaire" onClick={() => ouvrirDetail(l, setDetail, setErreur)}>
                    Voir les mois
                  </Bouton>
                ),
              },
            ]}
          />
        )}
      </Carte>

      {detail && (
        <Carte titre={`Mémoire mensuelle — ${detail.commerce.enseigne ?? detail.commerce.code}`}>
          <p className="mb-3 text-sm text-encre-2">
            Chaque ligne a été figée à la fin de son mois et ne change plus. Une
            correction apparaît comme une seconde ligne datée, l&apos;ancienne restant
            lisible.
          </p>
          <Tableau
            compact
            cle={(o) => `${o.mois}-${o.arretee_le}`}
            lignes={detail.observations}
            colonnes={[
              { cle: 'mois', titre: 'Mois', rendu: (o) => formaterDate(o.mois) },
              { cle: 'montant_du_cumule', titre: 'Dû', alignement: 'droite', rendu: (o) => xof(o.montant_du_cumule) },
              { cle: 'montant_regle_cumule', titre: 'Réglé', alignement: 'droite', rendu: (o) => xof(o.montant_regle_cumule) },
              { cle: 'montant_regle_mois', titre: 'Dont ce mois', alignement: 'droite', rendu: (o) => xof(o.montant_regle_mois) },
              { cle: 'montant_restant', titre: 'Restant', alignement: 'droite', rendu: (o) => xof(o.montant_restant) },
              {
                cle: 'echeance_depassee',
                titre: 'Échéance',
                rendu: (o) => (o.echeance_depassee ? 'dépassée' : 'tenue'),
              },
              {
                titre: 'État',
                rendu: (o) => (o.remplacee_le
                  ? <span className="text-encre-attenuee">remplacée — {o.motif_remplacement}</span>
                  : 'en vigueur'),
              },
            ]}
          />
          <div className="mt-3">
            <Bouton variante="secondaire" onClick={() => setDetail(null)}>Fermer</Bouton>
          </div>
        </Carte>
      )}
    </div>
  );
}

async function ouvrirDetail(commerce, setDetail, setErreur) {
  try {
    const r = await api.get(`/stats/observations/${commerce.commerce_id}`);
    setDetail({ commerce, observations: r.observations ?? [] });
  } catch (err) { setErreur(err.message); }
}
