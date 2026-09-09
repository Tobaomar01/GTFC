'use client';

/**
 * Conflits de synchronisation — les fiches que deux personnes ont modifiées.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POURQUOI CETTE PAGE EXISTE, ET POURQUOI ELLE MANQUAIT
 *
 *  Constaté le 09/09/2026. Le serveur sait détecter un conflit : un agent
 *  modifie une fiche hors ligne, quelqu'un la modifie au bureau entre-temps,
 *  et la synchronisation refuse d'écraser. Les routes GET /sync/conflits et
 *  POST /sync/conflits/:id/resoudre existaient, réservées au superviseur.
 *
 *  AUCUNE INTERFACE NE LES APPELAIT. Ni le tableau de bord, ni l'application
 *  de terrain. Un conflit ne pouvait donc être tranché par PERSONNE.
 *
 *  Ce que cela produisait, et qui ne se voyait nulle part : le téléphone
 *  gardait la fiche marquée « modifiée localement », donc sautée par la
 *  fusion des données du serveur — l'agent voyait un solde et un statut
 *  fiscal figés au jour du conflit, pour toujours. La mention « éléments à
 *  examiner » ne s'éteignait jamais. Et la modification de l'agent, elle,
 *  n'arrivait nulle part.
 *
 *  UNE DÉCISION, PAS UN RÉGLAGE. Trancher, c'est choisir entre ce qu'un agent
 *  a constaté sur place et ce que le bureau a saisi. Les deux versions sont
 *  affichées CÔTE À CÔTE, champ par champ : personne ne doit avoir à deviner
 *  ce qu'il valide. La date de chaque version est donnée, parce que la plus
 *  récente n'est pas toujours la bonne — un agent devant la devanture voit ce
 *  qu'un dossier ne montre pas.
 *
 *  La décision est tracée avec son auteur et sa date (app.sync_operation :
 *  resolution, resolu_par, resolu_le), et redescend sur le téléphone au
 *  paquet suivant.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback } from 'react';
import { api, profilCourant } from '@/lib/api';
import { date as formaterDate, auMoins, consulteSeulement } from '@/lib/format';
import {
  Carte, Bouton, Chargement, Message, EtatVide,
} from '@/composants/ui';

/** Noms lisibles : « todp_surface_m2 » ne dit rien à un superviseur. */
const CHAMPS = {
  enseigne: 'Enseigne',
  categorie_id: 'Catégorie',
  todp_surface_m2: 'Surface occupée sur le trottoir (m²)',
  enseigne_surface_m2: 'Surface de l’enseigne (m²)',
  surface_locale_m2: 'Surface du local (m²)',
  gerant_telephone: 'Téléphone du gérant',
  telephone_paiement: 'Téléphone de paiement',
  statut: 'Statut du commerce',
  point_repere: 'Point de repère',
};

const afficher = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
};

export default function PageConflits() {
  const [profil, setProfil] = useState(null);
  const [conflits, setConflits] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [enCours, setEnCours] = useState(null);
  const [commentaires, setCommentaires] = useState({});

  const charger = useCallback(async () => {
    try {
      setErreur(null);
      setConflits(await api.get('/sync/conflits'));
    } catch (err) { setErreur(err.message); }
  }, []);

  useEffect(() => { setProfil(profilCourant()); }, []);
  useEffect(() => { charger(); }, [charger]);

  // Montrer un bouton que le serveur refusera ferait croire à une panne.
  //
  // Deux conditions, et il faut les deux. Le NIVEAU donne la lecture : le maire
  // et le chef de projet sont au niveau du superviseur ou au-dessus, ils voient
  // donc la page. Mais ce sont des profils de CONSULTATION — l'API n'autorise
  // leurs écritures que sur une liste nommée, où trancher un conflit ne figure
  // pas. Ma première version les incluait : ils auraient vu deux boutons que le
  // serveur refuse, et cru à une panne.
  const peutTrancher = auMoins(profil?.role, 'superviseur') && !consulteSeulement(profil?.role);

  async function trancher(id, resolution) {
    setEnCours(`${id}-${resolution}`);
    try {
      await api.post(`/sync/conflits/${id}/resoudre`, {
        resolution,
        ...(commentaires[id] ? { commentaire: commentaires[id] } : {}),
      });
      await charger();
    } catch (err) { setErreur(err.message); }
    finally { setEnCours(null); }
  }

  if (erreur && !conflits) {
    return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  }
  if (!conflits) return <Chargement />;

  return (
    <div className="space-y-5">
      {erreur && <Message type="erreur" titre="Action refusée">{erreur}</Message>}

      {conflits.length > 0 && (
        <Message type="avertissement"
          titre={`${conflits.length} fiche${conflits.length > 1 ? 's' : ''} en attente d'arbitrage`}
        >
          Tant qu&apos;un conflit n&apos;est pas tranché, le téléphone de l&apos;agent
          garde la fiche gelée : il n&apos;en reçoit plus les mises à jour, et son
          propre relevé ne remonte pas. Aucune des deux versions n&apos;est perdue.
        </Message>
      )}

      {conflits.length === 0 ? (
        <Carte titre="Conflits de synchronisation">
          <EtatVide
            titre="Aucun conflit"
            texte="C'est le résultat attendu. Un conflit survient quand un agent modifie une fiche hors ligne pendant que le bureau la modifie aussi."
          />
        </Carte>
      ) : conflits.map((c) => {
        const detail = c.conflit_detail ?? {};
        const champs = detail.champs ?? [];
        return (
          <Carte
            key={c.id}
            titre={c.enseigne ?? 'Commerce sans enseigne'}
            sousTitre={`${c.commerce_code ?? '—'} · relevé par ${c.agent} le ${formaterDate(c.horodatage_client, { avecHeure: true })}`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-bordure">
                    <th className="py-2 pr-4 font-medium">Champ</th>
                    <th className="py-2 pr-4 font-medium">
                      Version de l’agent
                      <span className="block text-xs font-normal opacity-70">
                        constatée sur place
                      </span>
                    </th>
                    <th className="py-2 font-medium">
                      Version du bureau
                      <span className="block text-xs font-normal opacity-70">
                        {detail.modifie_le_serveur
                          ? `saisie le ${formaterDate(detail.modifie_le_serveur, { avecHeure: true })}`
                          : 'saisie au tableau de bord'}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {champs.map((champ) => (
                    <tr key={champ} className="border-b border-bordure/40">
                      <td className="py-2 pr-4">{CHAMPS[champ] ?? champ}</td>
                      <td className="py-2 pr-4 font-mono">{afficher(detail.client?.[champ])}</td>
                      <td className="py-2 font-mono">{afficher(detail.serveur?.[champ])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {champs.length === 0 && (
              <Message type="info">
                Le détail du conflit n&apos;a pas été enregistré. Choisissez la
                version du bureau : elle est celle que porte la base aujourd&apos;hui.
              </Message>
            )}

            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="block mb-1">Motif de la décision (facultatif, conservé au journal)</span>
                <input
                  type="text"
                  maxLength={500}
                  className="w-full rounded border border-bordure bg-transparent px-3 py-2"
                  placeholder="Ex. : l'agent a mesuré le trottoir sur place"
                  value={commentaires[c.id] ?? ''}
                  onChange={(e) => setCommentaires((m) => ({ ...m, [c.id]: e.target.value }))}
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <Bouton
                  variante="primaire"
                  desactive={!peutTrancher || enCours !== null}
                  onClick={() => trancher(c.id, 'client')}
                >
                  {enCours === `${c.id}-client` ? 'Enregistrement…' : 'Retenir la version de l’agent'}
                </Bouton>
                <Bouton
                  variante="secondaire"
                  desactive={!peutTrancher || enCours !== null}
                  onClick={() => trancher(c.id, 'serveur')}
                >
                  {enCours === `${c.id}-serveur` ? 'Enregistrement…' : 'Retenir la version du bureau'}
                </Bouton>
              </div>

              {!peutTrancher && (
                <Message type="info">
                  Votre profil consulte le dispositif sans écrire : arbitrer un
                  relevé de terrain revient au superviseur, qui en répond.
                </Message>
              )}
            </div>
          </Carte>
        );
      })}
    </div>
  );
}
