'use client';

/**
 * Dérogations — le registre des décisions qui effacent une dette.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CETTE PAGE ÉVITE
 *
 *  Un montant forcé et une exonération produisent le même effet : une somme
 *  cesse d'être due. Ce sont les deux seules façons d'effacer une dette, et
 *  donc les deux points où un dispositif fiscal se détourne le plus
 *  discrètement — sans espèces, sans caisse, sans rien qui se voie.
 *
 *  D'où un registre COMMUN aux deux, et non deux écrans séparés : les
 *  regarder ensemble est le seul moyen de voir un motif se répéter.
 *
 *  DEUX PERSONNES, TOUJOURS. Celui qui saisit ne valide pas. Tant que la
 *  validation manque, la décision n'a AUCUN effet sur les montants — ce
 *  n'est pas une formalité administrative, c'est ce qui rend l'abus visible
 *  avant qu'il ne coûte.
 *
 *  LES DÉCISIONS EN ATTENTE PASSENT DEVANT. Une dérogation qui traîne non
 *  validée est soit un oubli, soit une tentative : dans les deux cas elle
 *  mérite d'être vue en premier.
 *
 *  RÉSERVÉ AU CHEF DE PROJET. Ni l'agent, ni le superviseur, ni
 *  l'administrateur — le rôle n'est pas hiérarchique.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback } from 'react';
import { api, profilCourant } from '@/lib/api';
import { xof, pourcentage, date as formaterDate } from '@/lib/format';
import {
  Carte, Bouton, Tableau, Chargement, Message, EtatVide, BadgeStatut,
} from '@/composants/ui';

const NATURES = {
  montant_force: 'Montant forcé',
  exoneration: 'Exonération',
};

export default function PageDerogations() {
  const [profil, setProfil] = useState(null);
  const [donnees, setDonnees] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [filtre, setFiltre] = useState('en_attente');
  const [enCours, setEnCours] = useState(null);

  const charger = useCallback(async () => {
    try {
      setErreur(null);
      const parametres = filtre === 'en_attente' ? { en_attente: true }
        : (filtre === 'tout' ? {} : { nature: filtre });
      setDonnees(await api.get('/derogations', parametres));
    } catch (err) { setErreur(err.message); }
  }, [filtre]);

  useEffect(() => { setProfil(profilCourant()); }, []);
  useEffect(() => { charger(); }, [charger]);

  // Le maire valide, le chef de projet saisit. Montrer à ce dernier un bouton
  // que le serveur refusera lui ferait croire à une panne.
  const peutValider = profil?.role === 'maire';

  async function valider(decision) {
    setEnCours(decision.id);
    try {
      await api.post(`/derogations/${decision.id}/validation`, {});
      await charger();
    } catch (err) { setErreur(err.message); }
    finally { setEnCours(null); }
  }

  if (erreur && !donnees) {
    return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  }
  if (!donnees) return <Chargement />;

  const { decisions, en_attente: enAttente } = donnees;

  return (
    <div className="space-y-5">
      {erreur && <Message type="erreur" titre="Action refusée">{erreur}</Message>}

      {enAttente > 0 && (
        <Message type="avertissement"
          titre={`${enAttente} décision${enAttente > 1 ? 's' : ''} en attente de validation`}>
          Tant qu&apos;une décision n&apos;est pas validée par un second chef de projet,
          elle ne modifie aucune liquidation. Une dérogation qui traîne est soit
          un oubli, soit une tentative.
        </Message>
      )}

      <div className="flex flex-wrap gap-2">
        {[
          ['en_attente', 'En attente'],
          ['montant_force', 'Montants forcés'],
          ['exoneration', 'Exonérations'],
          ['tout', 'Tout le registre'],
        ].map(([cle, libelle]) => (
          <Bouton key={cle} variante={filtre === cle ? 'principal' : 'secondaire'}
            onClick={() => setFiltre(cle)}>
            {libelle}
          </Bouton>
        ))}
      </div>

      <Carte titre="Registre des décisions dérogatoires"
        sousTitre="Montants forcés et exonérations — les deux façons d'effacer une dette">
        {decisions.length === 0 ? (
          <EtatVide titre="Aucune décision"
            description="Rien à afficher pour ce filtre. C'est le résultat attendu : une dérogation doit rester exceptionnelle." />
        ) : (
          <Tableau cle="id" lignes={decisions}
            colonnes={[
              {
                cle: 'nature',
                titre: 'Nature',
                rendu: (l) => NATURES[l.nature] ?? l.nature,
              },
              { cle: 'commerce_code', titre: 'Commerce', monospace: true },
              { cle: 'enseigne', titre: 'Enseigne' },
              {
                cle: 'montant_retenu',
                titre: 'Effet',
                alignement: 'droite',
                rendu: (l) => {
                  if (l.nature === 'exoneration') {
                    return l.taux_exoneration_pct != null
                      ? pourcentage(l.taux_exoneration_pct) : '—';
                  }
                  if (l.montant_calcule == null) return xof(l.montant_retenu);
                  // L'écart est ce qui compte : c'est la somme effacée.
                  const ecart = Number(l.montant_calcule) - Number(l.montant_retenu);
                  return (
                    <span title={`Calculé ${xof(l.montant_calcule)} → retenu ${xof(l.montant_retenu)}`}>
                      {xof(l.montant_retenu)}
                      {ecart !== 0 && (
                        <span style={{ color: 'var(--st-impaye)', fontWeight: 600 }}>
                          {' '}({ecart > 0 ? '−' : '+'}{xof(Math.abs(ecart))})
                        </span>
                      )}
                    </span>
                  );
                },
              },
              { cle: 'motif', titre: 'Motif' },
              {
                cle: 'saisi_par_nom',
                titre: 'Saisi par',
                rendu: (l) => (
                  <span title={formaterDate(l.saisi_le, { avecHeure: true })}>
                    {l.saisi_par_nom ?? '—'}
                  </span>
                ),
              },
              {
                cle: 'opposable',
                titre: 'État',
                rendu: (l) => (l.opposable
                  ? <BadgeStatut statut="a_jour">Validée par {l.valide_par_nom}</BadgeStatut>
                  : <BadgeStatut statut="impaye">Sans effet</BadgeStatut>),
              },
              {
                cle: 'action',
                titre: '',
                rendu: (l) => (l.opposable || !peutValider ? null : (
                  <Bouton taille="petit"
                    onClick={() => valider(l)}
                    desactive={enCours === l.id}>
                    {enCours === l.id ? '…' : 'Valider'}
                  </Bouton>
                )),
              },
            ]} />
        )}
        <p className="mt-3 text-[13px] text-encre-attenuee">
          {peutValider
            ? 'Valider engage la commune : la remise devient opposable et réduit '
              + 'le montant dû. Tant que vous ne validez pas, la décision reste '
              + 'sans effet sur les montants.'
            : 'Vous instruisez et saisissez ; la validation revient à la '
              + 'municipalité. Remettre une dette publique est un acte de la '
              + 'commune — ce partage protège celui qui saisit autant que la '
              + 'commune elle-même.'}
        </p>
      </Carte>
    </div>
  );
}
