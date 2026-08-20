'use client';

/**
 * Journal d'audit.
 *
 * Rien n'est modifiable ici, et c'est le sujet : le journal est inaltérable
 * par construction (droits PostgreSQL + déclencheurs). L'écran ne fait que
 * donner à lire.
 */
import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { date, nombre, xof, ACTIONS_AUDIT, ROLES } from '@/lib/format';
import { Carte, Bouton, Chargement, Message, Tableau, Selection, Champ } from '@/composants/ui';

export default function PageAudit() {
  const [journal, setJournal] = useState(null);
  const [connexions, setConnexions] = useState(null);
  const [filtres, setFiltres] = useState({ action: null, entite: null });
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const [erreur, setErreur] = useState(null);

  const charger = useCallback(async () => {
    try {
      setJournal(await api.liste('/audit', { ...filtres, page, limite: 50 }));
    } catch (err) { setErreur(err.message); }
  }, [filtres, page]);

  useEffect(() => { charger(); }, [charger]);

  useEffect(() => {
    api.get('/audit/connexions', { echecs_seulement: true })
      .then(setConnexions).catch(() => setConnexions([]));
  }, []);

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;

  const echecsRecents = (connexions ?? []).length;
  const appareilsInhabituels = (connexions ?? []).filter((c) => c.appareil_inhabituel).length;

  return (
    <div className="space-y-5">
      <Message type="info" titre="Journal inaltérable">
        Aucune ligne de ce journal ne peut être modifiée ni supprimée — ni par
        l'application, ni depuis la base. Les entrées sont écrites
        automatiquement par PostgreSQL à chaque action, y compris celles faites
        en dehors de l'application.
      </Message>

      {(echecsRecents > 0 || appareilsInhabituels > 0) && (
        <Message type="avertissement" titre="Connexions à surveiller">
          {echecsRecents} tentative(s) de connexion refusée(s) sur 30 jours
          {appareilsInhabituels > 0 && `, dont ${appareilsInhabituels} depuis un téléphone inhabituel`}.
        </Message>
      )}

      <div className="grid gap-3 sm:grid-cols-3 sans-impression">
        <Selection etiquette="Action" valeur={filtres.action}
          onChange={(v) => { setFiltres({ ...filtres, action: v }); setPage(1); }}
          options={Object.entries(ACTIONS_AUDIT).map(([v, l]) => ({ valeur: v, libelle: l }))}
          aucun="Toutes les actions" />
        <Selection etiquette="Type d'enregistrement" valeur={filtres.entite}
          onChange={(v) => { setFiltres({ ...filtres, entite: v }); setPage(1); }}
          options={['commerce', 'paiement', 'avis_imposition', 'utilisateur', 'bareme_taxe',
            'exoneration', 'commerce_taxe', 'qr_code', 'quittance']
            .map((e) => ({ valeur: e, libelle: e }))}
          aucun="Tous les types" />
      </div>

      <Carte titre="Journal des actions" sousTitre="30 derniers jours par défaut">
        {!journal ? <Chargement /> : (
          <>
            <Tableau compact cle="id" lignes={journal.lignes} vide="Aucune action enregistrée"
              colonnes={[
                { cle: 'horodatage', titre: 'Date', rendu: (l) => date(l.horodatage, { avecHeure: true }) },
                { cle: 'auteur', titre: 'Auteur' },
                { cle: 'role', titre: 'Rôle', rendu: (l) => (l.role ? ROLES[l.role] ?? l.role : '—') },
                { cle: 'action', titre: 'Action', rendu: (l) => ACTIONS_AUDIT[l.action] ?? l.action },
                { cle: 'entite', titre: 'Type' },
                {
                  cle: 'entite_libelle',
                  titre: 'Enregistrement',
                  rendu: (l) => (l.entite_libelle
                    ? <button type="button" onClick={() => setDetail(l)}
                        className="text-left underline-offset-2 hover:underline">{l.entite_libelle}</button>
                    : '—'),
                },
                { cle: 'montant', titre: 'Montant', alignement: 'droite', rendu: (l) => (l.montant ? xof(l.montant) : '—') },
                {
                  cle: 'champs_modifies',
                  titre: 'Champs',
                  rendu: (l) => (l.champs_modifies?.length
                    ? <span className="text-[12px] text-encre-2">{l.champs_modifies.slice(0, 3).join(', ')}
                        {l.champs_modifies.length > 3 && ` +${l.champs_modifies.length - 3}`}</span>
                    : '—'),
                },
              ]} />

            <div className="mt-4 flex items-center justify-between sans-impression">
              <Bouton taille="petit" desactive={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Précédent
              </Bouton>
              <span className="text-[13px] text-encre-2">Page {page}</span>
              <Bouton taille="petit" desactive={journal.lignes.length < 50}
                onClick={() => setPage((p) => p + 1)}>
                Suivant
              </Bouton>
            </div>
          </>
        )}
      </Carte>

      {detail && (
        <Carte titre={`Détail — ${detail.entite_libelle}`}
          actions={<Bouton taille="petit" variante="discret" onClick={() => setDetail(null)}>Fermer</Bouton>}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-encre">Avant</h3>
              <pre className="overflow-x-auto rounded-lg bg-surface-alt p-3 text-[12px] text-encre-2">
                {detail.valeurs_avant ? JSON.stringify(detail.valeurs_avant, null, 1) : '—'}
              </pre>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-encre">Après</h3>
              <pre className="overflow-x-auto rounded-lg bg-surface-alt p-3 text-[12px] text-encre-2">
                {detail.valeurs_apres ? JSON.stringify(detail.valeurs_apres, null, 1) : '—'}
              </pre>
            </div>
          </div>
          <div className="mt-3 text-[13px] text-encre-2">
            {detail.ip && <p>Adresse IP : <span className="font-mono">{detail.ip}</span></p>}
            {detail.latitude && (
              <p>Position : <span className="font-mono">
                {Number(detail.latitude).toFixed(5)}, {Number(detail.longitude).toFixed(5)}
              </span></p>
            )}
            {detail.motif && <p>Motif : {detail.motif}</p>}
          </div>
        </Carte>
      )}

      {connexions?.length > 0 && (
        <Carte titre="Connexions refusées" sousTitre="30 derniers jours">
          <Tableau compact cle="id" lignes={connexions.slice(0, 30)}
            colonnes={[
              { cle: 'horodatage', titre: 'Date', rendu: (l) => date(l.horodatage, { avecHeure: true }) },
              { cle: 'telephone_saisi', titre: 'Numéro saisi', monospace: true },
              { cle: 'motif_echec', titre: 'Motif' },
              { cle: 'ip', titre: 'IP', monospace: true },
              { cle: 'appareil_modele', titre: 'Appareil' },
            ]} />
        </Carte>
      )}
    </div>
  );
}
