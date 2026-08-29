'use client';

/**
 * Rues — le suivi de la phase 0 et de la couverture du recensement.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  LA QUESTION À LAQUELLE CET ÉCRAN RÉPOND
 *
 *  « Que reste-t-il à faire ? » Sans référentiel des rues, personne ne peut
 *  y répondre : on sait combien de commerces ont été recensés, jamais
 *  combien il en reste. Un chef d'équipe pilote alors à l'estime, et le
 *  recensement s'arrête quand les agents pensent avoir fini.
 *
 *  LE CHIFFRE EN HAUT EST UNE PROPORTION, PAS UN COMPTE. « 34 rues
 *  terminées » ne dit rien ; « 34 sur 85 » dit tout. Et tant qu'aucune rue
 *  n'est chargée, l'écran ne montre pas 0 % — il dit que la phase 0 n'a pas
 *  commencé, ce qui appelle une action différente.
 *
 *  LES COULEURS SONT CELLES DES STATUTS, et elles ne portent jamais
 *  l'information seules : chaque segment de la barre est étiqueté, chaque
 *  ligne du tableau porte son état en toutes lettres. « Non commencée »
 *  utilise le gris de grille plutôt qu'une teinte — c'est une absence, pas
 *  un état.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { date as formaterDate } from '@/lib/format';
import {
  Carte, Bouton, Champ, Selection, Tableau, Chargement, Message, EtatVide,
} from '@/composants/ui';

const ETATS = {
  terminee: { libelle: 'Terminée', couleur: 'var(--st-ajour)' },
  en_cours: { libelle: 'En cours', couleur: 'var(--st-partiel)' },
  non_commencee: { libelle: 'Non commencée', couleur: 'var(--grille)' },
};
const ORDRE = ['terminee', 'en_cours', 'non_commencee'];

export default function PageRues() {
  const [donnees, setDonnees] = useState(null);
  const [recherche, setRecherche] = useState('');
  const [filtre, setFiltre] = useState('');
  const [erreur, setErreur] = useState(null);
  const [message, setMessage] = useState(null);

  const charger = useCallback(async () => {
    try {
      const r = await api.get('/rues/couverture');
      setDonnees(r.donnees);
    } catch (e) {
      setErreur(e.message);
    }
  }, []);

  useEffect(() => { charger(); }, [charger]);

  const changerStatut = async (rue, statut) => {
    try {
      await api.post(`/rues/${rue.rue_id}/couverture`, { statut });
      setMessage(`${rue.nom} — ${ETATS[statut].libelle.toLowerCase()}.`);
      charger();
    } catch (e) {
      setMessage(e.message);
    }
  };

  const rattacher = async () => {
    try {
      const r = await api.post('/rues/recalculer-rattachements', { seuil_m: 25 });
      setMessage(`${r.donnees.rattaches} objet(s) rattaché(s). `
        + `${r.donnees.sans_rue} restent sans rue — trop loin d'un tracé connu.`);
      charger();
    } catch (e) {
      setMessage(e.message);
    }
  };

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!donnees) return <Chargement />;

  // -------------------------------------------------------------------------
  // Phase 0 non commencée : un écran vide serait interprété comme une panne.
  // -------------------------------------------------------------------------
  if (!donnees.phase_0_demarree) {
    return (
      <Carte titre="Référentiel des rues">
        <EtatVide
          titre="La phase 0 n'a pas commencé"
          texte={'Aucune rue n\'est enregistrée. Tant que ce référentiel est vide, les '
            + 'agents saisiront des noms en texte libre — et aucune statistique par rue '
            + 'ne sera possible ensuite. Cette phase doit précéder le recensement.'}
        />
        <div className="mt-2 rounded-lg bg-surface-alt p-3">
          <p className="text-[13px] font-medium text-encre">Comment le constituer</p>
          <pre className="mt-2 overflow-x-auto text-[12px] leading-relaxed text-encre-2">
{`node db/importer-rues-osm.js --extraire
node db/importer-rues-osm.js --apercu
node db/importer-rues-osm.js --importer`}
          </pre>
          <p className="mt-2 text-[12px] leading-relaxed text-encre-attenuee">
            OpenStreetMap ne fournit qu&apos;une partie des voies. Les rues du PDC
            qui en sont absentes doivent être ajoutées, et la mairie doit valider
            les libellés retenus.
          </p>
        </div>
      </Carte>
    );
  }

  const parStatut = donnees.par_statut ?? {};
  const total = donnees.total_rues;
  const compte = (s) => Number(parStatut[s]?.nb_rues ?? 0);
  const sansTrace = total - (donnees.rues ?? []).filter((r) => r.tracee).length;

  const visibles = (donnees.rues ?? []).filter((r) => {
    if (filtre && r.statut_couverture !== filtre) return false;
    if (!recherche) return true;
    const t = recherche.toLowerCase();
    return (r.nom ?? '').toLowerCase().includes(t) || (r.code ?? '').toLowerCase().includes(t);
  });

  return (
    <div className="space-y-4">
      {/* ---------------- Avancement ---------------- */}
      <Carte titre="Couverture du recensement">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            {/* Un nombre héros : la proportion, pas le compte brut. */}
            <p className="text-[38px] font-bold leading-none text-encre">
              {donnees.avancement_pct}
              <span className="text-[22px] font-semibold text-encre-2"> %</span>
            </p>
            <p className="mt-1 text-[13px] text-encre-2">
              {compte('terminee')} rue(s) terminée(s) sur {total}
            </p>
          </div>

          <div className="flex-1" />

          <Bouton variante="secondaire" onClick={rattacher}>
            Rattacher les objets aux rues
          </Bouton>
        </div>

        {/* --- La barre : trois segments, séparés de 2 px de surface --- */}
        <div className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-full">
          {ORDRE.map((s) => {
            const n = compte(s);
            if (n === 0) return null;
            return (
              <div
                key={s}
                style={{ width: `${(n / total) * 100}%`, backgroundColor: ETATS[s].couleur }}
                className="h-full first:rounded-l-full last:rounded-r-full"
              />
            );
          })}
        </div>

        {/* --- Légende : le libellé porte l'information, pas la couleur --- */}
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {ORDRE.map((s) => (
            <div key={s} className="flex items-baseline gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-sm"
                style={{ backgroundColor: ETATS[s].couleur }}
              />
              <span className="text-[13px] text-encre-2">{ETATS[s].libelle}</span>
              <span className="text-[13px] font-semibold text-encre">{compte(s)}</span>
            </div>
          ))}
        </div>
      </Carte>

      {message ? <Message type="info">{message}</Message> : null}

      {/* ---------------- Ce qui manque au référentiel ---------------- */}
      {sansTrace > 0 ? (
        <div className="rounded-xl border border-bordure border-l-[3px] border-l-st-partiel bg-surface p-4">
          <p className="text-[15px] font-semibold text-encre">
            {sansTrace} rue(s) sans tracé
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-encre-2">
            Elles restent utilisables comme étiquette : l&apos;agent les choisit dans
            la liste. C&apos;est le rattachement automatique par GPS qui attend le
            tracé — sans lui, chaque objet doit être rattaché à la main.
          </p>
        </div>
      ) : null}

      {/* ---------------- Le détail ---------------- */}
      <Carte titre={`${visibles.length} rue(s)`}>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Champ
            etiquette="Rechercher"
            placeholder="Nom ou code…"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
          />
          <Selection
            etiquette="Avancement"
            valeur={filtre}
            onChange={(v) => setFiltre(v ?? '')}
            aucun="Toutes"
            options={ORDRE.map((s) => ({ valeur: s, libelle: ETATS[s].libelle }))}
          />
        </div>

        <Tableau
          cle="rue_id"
          lignes={visibles}
          vide="Aucune rue ne correspond."
          colonnes={[
            { cle: 'code', titre: 'Code', monospace: true },
            {
              cle: 'nom',
              titre: 'Rue',
              rendu: (r) => (
                <div>
                  <p className="text-encre">{r.nom}</p>
                  <p className="text-[12px] text-encre-attenuee">
                    {[r.quartier, r.zone].filter(Boolean).join(' · ') || 'quartier non rattaché'}
                    {r.tracee ? '' : ' · sans tracé'}
                    {/* Le nom vient d'une source externe et n'engage pas
                        encore la commune. Le taux de collecte de cette voie
                        se lira dessus : le dire ici évite qu'on le découvre
                        le jour où le chiffre est contesté. */}
                    {r.a_valider
                      ? <span style={{ color: 'var(--st-partiel)' }}>
                        {' · '}
                        {r.source === 'osm' ? 'nom OpenStreetMap, à valider' : 'nom à valider'}
                      </span>
                      : null}
                  </p>
                </div>
              ),
            },
            {
              cle: 'nb_objets_recenses',
              titre: 'Objets',
              alignement: 'droite',
              rendu: (r) => (r.nb_objets_recenses > 0
                ? <span className="font-medium text-encre">{r.nb_objets_recenses}</span>
                : <span className="text-encre-attenuee">—</span>),
            },
            {
              cle: 'statut_couverture',
              titre: 'Avancement',
              rendu: (r) => (
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: ETATS[r.statut_couverture]?.couleur }}
                  />
                  <div>
                    <p className="text-[13px] text-encre">
                      {ETATS[r.statut_couverture]?.libelle ?? r.statut_couverture}
                    </p>
                    {r.couverture_terminee_le ? (
                      <p className="text-[12px] text-encre-attenuee">
                        {formaterDate(r.couverture_terminee_le)}
                        {r.agent ? ` · ${r.agent}` : ''}
                      </p>
                    ) : null}
                  </div>
                </div>
              ),
            },
            {
              cle: 'actions',
              titre: '',
              rendu: (r) => (
                <div className="flex justify-end gap-1">
                  {r.statut_couverture !== 'en_cours' ? (
                    <Bouton variante="discret" taille="petit"
                      onClick={() => changerStatut(r, 'en_cours')}
                    >
                      Commencer
                    </Bouton>
                  ) : null}
                  {r.statut_couverture !== 'terminee' ? (
                    <Bouton variante="discret" taille="petit"
                      onClick={() => changerStatut(r, 'terminee')}
                    >
                      Terminer
                    </Bouton>
                  ) : (
                    <Bouton variante="discret" taille="petit"
                      onClick={() => changerStatut(r, 'en_cours')}
                    >
                      Rouvrir
                    </Bouton>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Carte>
    </div>
  );
}
