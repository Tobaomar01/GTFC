'use client';

/**
 * Contestations — la file d'instruction.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CETTE PAGE ÉVITE
 *
 *  Sans canal officiel, la contestation se règle oralement sur le trottoir :
 *  rien n'est tracé, la mairie ignore combien de dossiers sont en litige, et
 *  l'agent arbitre seul devant un commerçant mécontent. Le litige bloque
 *  alors la collecte sur toute une rue.
 *
 *  L'ORDRE EST CELUI DE L'URGENCE, pas celui de l'arrivée. Les dossiers dont
 *  le délai est dépassé passent devant : c'est le retard qui transforme une
 *  contestation légitime en conflit.
 *
 *  UNE DÉCISION SE MOTIVE, TOUJOURS. Le formulaire refuse un rejet sans
 *  explication — non par formalisme, mais parce qu'un rejet non motivé
 *  ramène le commerçant au guichet, et cette fois en colère.
 *
 *  SUSPENDRE LE RECOUVREMENT EST UN ACTE, PAS UN RÉFLEXE. Si le simple dépôt
 *  suspendait, contester deviendrait le moyen le plus simple de ne pas payer.
 *  La case existe, elle exige un motif, et elle est tracée.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { xof, date as formaterDate } from '@/lib/format';
import {
  Carte, Bouton, Champ, ZoneTexte, Selection, Tableau, Chargement, Message, EtatVide,
} from '@/composants/ui';

const ETATS = {
  soumise: 'Déposée',
  en_instruction: 'En instruction',
  visite_demandee: 'Visite demandée',
  transmise_receveur: 'Chez le receveur',
  acceptee: 'Acceptée',
  rejetee: 'Rejetée',
  retiree: 'Retirée',
};

export default function PageContestations() {
  const [liste, setListe] = useState(null);
  const [filtre, setFiltre] = useState('ouvertes');
  const [ouverte, setOuverte] = useState(null);
  const [erreur, setErreur] = useState(null);

  const charger = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limite: '100' });
      if (filtre === 'ouvertes') {
        params.set('statut', 'soumise,en_instruction,visite_demandee,transmise_receveur');
      } else if (filtre === 'retard') {
        params.set('en_retard', 'oui');
      } else if (filtre === 'closes') {
        params.set('statut', 'acceptee,rejetee,retiree');
      }
      const r = await api.get(`/contestations?${params}`);
      setListe(r.donnees ?? []);
    } catch (e) {
      setErreur(e.message);
    }
  }, [filtre]);

  useEffect(() => { charger(); }, [charger]);

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!liste) return <Chargement />;

  const enRetard = liste.filter((c) => c.en_retard).length;

  return (
    <div className="space-y-4">
      {enRetard > 0 && filtre !== 'retard' ? (
        <div className="rounded-xl border border-bordure border-l-[3px] border-l-st-impaye bg-surface p-4">
          <p className="text-[15px] font-semibold text-encre">
            {enRetard} dossier(s) hors délai
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-encre-2">
            Le délai fixé par la convention est dépassé. Un contestataire sans
            réponse revient au guichet, et le litige s&apos;étend.
          </p>
          <button
            type="button"
            onClick={() => setFiltre('retard')}
            className="mt-2 text-[13px] font-medium text-marque underline underline-offset-2"
          >
            Les traiter
          </button>
        </div>
      ) : null}

      <Carte>
        <Selection
          etiquette="Afficher"
          valeur={filtre}
          onChange={(v) => setFiltre(v ?? 'ouvertes')}
          aucun="Toutes"
          options={[
            { valeur: 'ouvertes', libelle: 'À instruire' },
            { valeur: 'retard', libelle: 'Hors délai' },
            { valeur: 'closes', libelle: 'Closes' },
          ]}
        />
      </Carte>

      <Carte titre={`${liste.length} contestation(s)`}>
        {liste.length === 0 ? (
          <EtatVide
            titre="Rien à instruire"
            texte="Aucune contestation en attente. C'est bon signe — ou le canal n'est pas connu des redevables."
          />
        ) : (
          <Tableau
            cle="id"
            lignes={liste}
            colonnes={[
              { cle: 'numero', titre: 'N°', monospace: true },
              { cle: 'redevable', titre: 'Redevable', rendu: (c) => (
                <div>
                  <p className="font-medium text-encre">{c.redevable}</p>
                  <p className="text-[12px] text-encre-attenuee">
                    {c.redevable_code}
                    {c.telephone ? ` · ${c.telephone}` : ''}
                  </p>
                </div>
              ) },
              { cle: 'motif', titre: 'Motif', rendu: (c) => (
                <div>
                  <p className="text-encre">{c.motif}</p>
                  <p className="text-[12px] text-encre-attenuee">
                    {c.canal === 'portail' ? 'depuis le portail' : `saisie ${c.canal}`}
                    {c.nb_pieces > 0 ? ` · ${c.nb_pieces} pièce(s)` : ''}
                  </p>
                </div>
              ) },
              { cle: 'avis', titre: 'Facture', rendu: (c) => (
                c.avis
                  ? (
                    <div className="text-[13px]">
                      <p className="text-encre">{c.avis}</p>
                      <p className="text-[12px] text-encre-attenuee">{xof(c.montant_total)}</p>
                    </div>
                  )
                  : <span className="text-encre-attenuee">—</span>
              ) },
              { cle: 'delai', titre: 'Délai', rendu: (c) => (
                c.en_retard
                  ? <span className="font-medium text-st-impaye">dépassé</span>
                  : <span className="text-[13px] text-encre-2">{formaterDate(c.date_limite)}</span>
              ) },
              { cle: 'statut', titre: 'État', rendu: (c) => (
                <div>
                  <p className="text-[13px] text-encre">{ETATS[c.statut] ?? c.statut}</p>
                  {c.suspend_recouvrement ? (
                    <p className="text-[12px] font-medium text-st-partiel">recouvrement suspendu</p>
                  ) : null}
                </div>
              ) },
              { cle: 'actions', titre: '', rendu: (c) => (
                <Bouton variante="discret" onClick={() => setOuverte(c)}>Instruire</Bouton>
              ) },
            ]}
          />
        )}
      </Carte>

      {ouverte ? (
        <Instruction
          contestation={ouverte}
          onFerme={() => setOuverte(null)}
          onMaj={() => { setOuverte(null); charger(); }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Instruction({ contestation, onFerme, onMaj }) {
  const [notes, setNotes] = useState('');
  const [suspendre, setSuspendre] = useState(Boolean(contestation.suspend_recouvrement));
  const [motifSuspension, setMotifSuspension] = useState('');
  const [decision, setDecision] = useState('');
  const [motifDecision, setMotifDecision] = useState('');
  const [message, setMessage] = useState(null);
  const [occupe, setOccupe] = useState(false);

  const close = ['acceptee', 'rejetee', 'retiree'].includes(contestation.statut);

  const instruire = async (statut) => {
    setOccupe(true);
    setMessage(null);
    try {
      await api.post(`/contestations/${contestation.id}/instruire`, {
        statut,
        notes: notes || undefined,
        suspend_recouvrement: suspendre,
        motif_suspension: suspendre ? motifSuspension : undefined,
      });
      onMaj();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setOccupe(false);
    }
  };

  const resoudre = async () => {
    setOccupe(true);
    setMessage(null);
    try {
      await api.post(`/contestations/${contestation.id}/resoudre`, {
        decision,
        motif_decision: motifDecision,
      });
      onMaj();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Carte
      titre={`${contestation.numero} — ${contestation.motif}`}
      sousTitre={`${contestation.redevable} · déposée le ${formaterDate(contestation.cree_le)}`}
      actions={<Bouton variante="discret" onClick={onFerme}>Fermer</Bouton>}
    >
      <div className="rounded-lg bg-surface-alt p-3">
        <p className="text-[13px] font-medium text-encre-2">Ce que dit le redevable</p>
        <p className="mt-1 whitespace-pre-line text-[14px] leading-relaxed text-encre">
          {contestation.description}
        </p>
      </div>

      {contestation.visite_recommandee ? (
        <Message type="info" titre="Constat sur place conseillé">
          Ce motif se vérifie difficilement depuis un bureau. Une visite d&apos;agent
          tranchera plus vite qu&apos;un échange de courriers.
        </Message>
      ) : null}
      {contestation.escalade_receveur ? (
        <Message type="info" titre="À transmettre au receveur">
          Ce motif relève du rapprochement comptable, pas du superviseur de zone.
        </Message>
      ) : null}

      {message ? <Message type="erreur">{message}</Message> : null}

      {close ? (
        <Message type="info" titre="Dossier clos">
          Décision : {ETATS[contestation.statut]}. Il n&apos;est plus modifiable.
        </Message>
      ) : (
        <div className="mt-4 space-y-4">
          {/* ---------------- Instruction ---------------- */}
          <section className="rounded-lg border border-bordure p-3">
            <h3 className="text-[14px] font-semibold text-encre">Instruire</h3>
            <div className="mt-2">
              <ZoneTexte
                etiquette="Notes d'instruction"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ce qui a été vérifié, qui a été contacté…"
              />
            </div>

            <label className="mt-2 flex items-start gap-2">
              <input
                type="checkbox"
                checked={suspendre}
                onChange={(e) => setSuspendre(e.target.checked)}
                className="mt-1"
              />
              <span className="text-[13px] leading-relaxed text-encre">
                Suspendre le recouvrement pendant l&apos;instruction
                <span className="block text-[12px] text-encre-attenuee">
                  À réserver aux cas où le montant est manifestement erroné. La
                  suspension est tracée au journal d&apos;audit.
                </span>
              </span>
            </label>

            {suspendre ? (
              <div className="mt-2">
                <Champ
                  etiquette="Motif de la suspension"
                  value={motifSuspension}
                  onChange={(e) => setMotifSuspension(e.target.value)}
                  placeholder="Surface manifestement erronée, à revérifier sur place"
                />
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Bouton onClick={() => instruire('en_instruction')}
                desactive={occupe || (suspendre && motifSuspension.trim().length < 3)}
              >
                Prendre en charge
              </Bouton>
              <Bouton variante="secondaire" onClick={() => instruire('visite_demandee')} desactive={occupe}>
                Demander une visite
              </Bouton>
              <Bouton variante="secondaire" onClick={() => instruire('transmise_receveur')} desactive={occupe}>
                Transmettre au receveur
              </Bouton>
            </div>
          </section>

          {/* ---------------- Résolution ---------------- */}
          <section className="rounded-lg border border-bordure p-3">
            <h3 className="text-[14px] font-semibold text-encre">Décider</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Selection
                etiquette="Décision"
                valeur={decision}
                onChange={(v) => setDecision(v ?? '')}
                aucun="Choisir…"
                options={[
                  { valeur: 'acceptee', libelle: 'Accepter — corriger le dossier' },
                  { valeur: 'rejetee', libelle: 'Rejeter' },
                ]}
              />
            </div>
            <div className="mt-2">
              <ZoneTexte
                lignes={3}
                etiquette="Motivation"
                aide="Elle sera communiquée au redevable. Un rejet non motivé le ramène au guichet."
                value={motifDecision}
                onChange={(e) => setMotifDecision(e.target.value)}
                placeholder="Vérification faite sur place le 12/09 : la surface relevée est bien de 4 m²."
              />
            </div>
            <div className="mt-3">
              <Bouton
                onClick={resoudre}
                desactive={occupe || !decision || motifDecision.trim().length < 10}
              >
                Enregistrer la décision
              </Bouton>
            </div>
          </section>
        </div>
      )}
    </Carte>
  );
}
