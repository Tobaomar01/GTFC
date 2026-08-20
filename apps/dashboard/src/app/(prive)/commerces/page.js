'use client';

/**
 * Liste des commerces et fiche détaillée.
 *
 * La fiche s'ouvre dans un panneau latéral plutôt que sur une page dédiée :
 * un agent de mairie au guichet enchaîne les consultations, et repasser par la
 * liste à chaque fois lui coûterait deux clics de trop.
 */
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  xof, nombre, date, pourcentage, STATUTS, ORDRE_STATUTS, STATUTS_COMMERCE, MOYENS_PAIEMENT,
} from '@/lib/format';
import {
  Carte, Champ, Selection, Bouton, Chargement, Message, Tableau, BadgeStatut, EtatVide,
} from '@/composants/ui';

function Liste() {
  const params = useSearchParams();
  const [donnees, setDonnees] = useState(null);
  const [zones, setZones] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filtres, setFiltres] = useState({ q: '', zone_id: null, statut_fiscal: null, categorie_id: null });
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState(null);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [z, c] = await Promise.all([api.get('/zones'), api.get('/categories')]);
        setZones(z); setCategories(c);
      } catch (err) { setErreur(err.message); }
    })();
  }, []);

  const charger = useCallback(async () => {
    try {
      setDonnees(await api.liste('/commerces', { ...filtres, page, limite: 50 }));
    } catch (err) { setErreur(err.message); }
  }, [filtres, page]);

  useEffect(() => { charger(); }, [charger]);

  // Ouverture directe depuis la carte
  useEffect(() => {
    const id = params.get('ouvrir');
    if (id) setSelection(id);
  }, [params]);

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 sans-impression">
        <Champ
          etiquette="Rechercher"
          value={filtres.q}
          onChange={(e) => { setFiltres({ ...filtres, q: e.target.value }); setPage(1); }}
          placeholder="Enseigne, code, gérant…"
        />
        <Selection etiquette="Zone" valeur={filtres.zone_id}
          onChange={(v) => { setFiltres({ ...filtres, zone_id: v }); setPage(1); }}
          options={zones.map((z) => ({ valeur: z.id, libelle: z.nom }))} aucun="Toutes" />
        <Selection etiquette="Catégorie" valeur={filtres.categorie_id}
          onChange={(v) => { setFiltres({ ...filtres, categorie_id: v }); setPage(1); }}
          options={categories.map((c) => ({ valeur: c.id, libelle: c.libelle }))} aucun="Toutes" />
        <Selection etiquette="Situation" valeur={filtres.statut_fiscal}
          onChange={(v) => { setFiltres({ ...filtres, statut_fiscal: v }); setPage(1); }}
          options={ORDRE_STATUTS.map((s) => ({ valeur: s, libelle: STATUTS[s].libelle }))} aucun="Toutes" />
      </div>

      <Carte
        titre={donnees ? `${nombre(donnees.pagination?.total ?? 0)} commerce(s)` : 'Commerces'}
        actions={(
          <>
            <Bouton taille="petit" onClick={() => api.telecharger('/exports/commerces.xlsx', filtres)}>
              Excel
            </Bouton>
            <Bouton taille="petit" onClick={() => api.ouvrirPdf('/exports/commerces.pdf', filtres)}>
              PDF
            </Bouton>
          </>
        )}
      >
        {!donnees ? <Chargement /> : (
          <>
            <Tableau
              cle="id"
              lignes={donnees.lignes}
              vide="Aucun commerce ne correspond à ces filtres"
              colonnes={[
                { cle: 'code', titre: 'Code', monospace: true },
                {
                  cle: 'enseigne',
                  titre: 'Enseigne',
                  rendu: (l) => (
                    <button type="button" onClick={() => setSelection(l.id)}
                      className="text-left font-medium text-encre underline-offset-2 hover:underline">
                      {l.enseigne}
                    </button>
                  ),
                },
                { cle: 'categorie', titre: 'Catégorie' },
                { cle: 'quartier', titre: 'Quartier' },
                { cle: 'statut_fiscal', titre: 'Situation', rendu: (l) => <BadgeStatut statut={l.statut_fiscal} compact /> },
                {
                  cle: 'solde_du',
                  titre: 'Reste dû',
                  alignement: 'droite',
                  rendu: (l) => (Number(l.solde_du) > 0
                    ? <span style={{ color: 'var(--st-impaye)', fontWeight: 600 }}>{xof(l.solde_du)}</span>
                    : '—'),
                },
              ]}
            />

            {donnees.pagination && donnees.pagination.pages > 1 && (
              <div className="mt-4 flex items-center justify-between sans-impression">
                <Bouton taille="petit" desactive={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Précédent
                </Bouton>
                <span className="text-[13px] text-encre-2">
                  Page {donnees.pagination.page} sur {donnees.pagination.pages}
                </span>
                <Bouton taille="petit" desactive={page >= donnees.pagination.pages}
                  onClick={() => setPage((p) => p + 1)}>
                  Suivant
                </Bouton>
              </div>
            )}
          </>
        )}
      </Carte>

      {selection && <Fiche id={selection} surFermeture={() => setSelection(null)} />}
    </div>
  );
}

// ===========================================================================
function Fiche({ id, surFermeture }) {
  const [commerce, setCommerce] = useState(null);
  const [simulation, setSimulation] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    (async () => {
      try { setCommerce(await api.get(`/commerces/${id}`)); } catch (err) { setErreur(err.message); }
    })();
  }, [id]);

  const simuler = async () => {
    setOccupe(true);
    try { setSimulation(await api.get(`/taxes/simuler/${id}`)); } catch (err) { setErreur(err.message); } finally { setOccupe(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30 sans-impression">
      <button type="button" aria-label="Fermer" onClick={surFermeture} className="flex-1" />
      <aside className="w-full max-w-xl overflow-y-auto border-l border-bordure bg-surface p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {commerce ? (
              <>
                <h2 className="truncate text-lg font-bold text-encre">{commerce.enseigne}</h2>
                <p className="font-mono text-[13px] text-encre-2">{commerce.code}</p>
              </>
            ) : <h2 className="text-lg font-bold text-encre">Chargement…</h2>}
          </div>
          <Bouton taille="petit" variante="discret" onClick={surFermeture}>Fermer</Bouton>
        </div>

        {erreur && <Message type="erreur">{erreur}</Message>}
        {!commerce ? <Chargement /> : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <BadgeStatut statut={commerce.statut_fiscal} />
              <span className="text-[13px] text-encre-2">{STATUTS_COMMERCE[commerce.statut]}</span>
              {Number(commerce.solde_du) > 0 && (
                <span className="ml-auto font-semibold" style={{ color: 'var(--st-impaye)' }}>
                  {xof(commerce.solde_du)} dus
                </span>
              )}
            </div>

            <Bloc titre="Identité">
              <Ligne label="Catégorie" valeur={commerce.categorie} />
              <Ligne label="Zone / quartier" valeur={`${commerce.zone} — ${commerce.quartier}`} />
              <Ligne label="Gérant" valeur={[commerce.gerant_prenom, commerce.gerant_nom].filter(Boolean).join(' ')} />
              <Ligne label="Téléphone" valeur={commerce.telephone_paiement ?? commerce.gerant_telephone} />
              <Ligne label="NINEA" valeur={commerce.ninea} />
              <Ligne label="Repère" valeur={commerce.point_repere} />
              <Ligne label="Position"
                valeur={commerce.latitude
                  ? `${Number(commerce.latitude).toFixed(5)}, ${Number(commerce.longitude).toFixed(5)}`
                  : 'non relevée'} />
              <Ligne label="Recensé le" valeur={date(commerce.date_recensement)} />
              <Ligne label="Visites" valeur={nombre(commerce.nb_visites)} />
            </Bloc>

            <Bloc titre="Mesures et taxes">
              <Ligne label="Surface du local"
                valeur={commerce.surface_locale_m2 ? `${commerce.surface_locale_m2} m²` : null} />
              <Ligne label="Débordement trottoir (TODP)"
                valeur={commerce.todp_surface_m2 ? `${commerce.todp_surface_m2} m²` : 'aucun constaté'} />
              <Ligne label="Enseigne"
                valeur={commerce.enseigne_surface_m2 ? `${commerce.enseigne_surface_m2} m²` : null} />
              <div className="pt-2">
                <Bouton taille="petit" onClick={simuler} charge={occupe}>
                  Calculer les montants dus
                </Bouton>
              </div>

              {simulation && (
                <div className="mt-3 rounded-lg border border-bordure p-3">
                  {simulation.lignes.map((l) => (
                    <div key={l.code} className="flex items-baseline justify-between border-b border-grille py-1.5 last:border-0">
                      <div>
                        <p className="text-sm text-encre">{l.taxe}</p>
                        {l.base_calcul && (
                          <p className="text-[12px] text-encre-attenuee">
                            {l.base_calcul} {l.unite} × {xof(l.montant_unitaire)}
                            {l.detail?.regle_arrondi && ` · arrondi ${l.detail.regle_arrondi}`}
                          </p>
                        )}
                        {l.erreur && <p className="text-[12px]" style={{ color: 'var(--st-impaye)' }}>{l.erreur}</p>}
                      </div>
                      <span className="chiffres-alignes text-sm font-semibold text-encre">
                        {l.montant != null ? xof(l.montant) : '—'}
                      </span>
                    </div>
                  ))}
                  <div className="mt-2 flex items-baseline justify-between border-t-2 pt-2"
                    style={{ borderTopColor: 'var(--marque)' }}>
                    <span className="font-semibold text-encre">Total mensuel</span>
                    <span className="chiffres-alignes font-bold" style={{ color: 'var(--marque)' }}>
                      {xof(simulation.total)}
                    </span>
                  </div>
                </div>
              )}
            </Bloc>

            {commerce.avis?.length > 0 && (
              <Bloc titre="Avis d'imposition">
                <Tableau compact cle="id" lignes={commerce.avis}
                  colonnes={[
                    { cle: 'periode', titre: 'Période' },
                    { cle: 'montant_total', titre: 'Dû', alignement: 'droite', rendu: (l) => xof(l.montant_total) },
                    { cle: 'montant_paye', titre: 'Payé', alignement: 'droite', rendu: (l) => xof(l.montant_paye) },
                    { cle: 'statut', titre: 'Statut' },
                  ]} />
              </Bloc>
            )}

            {commerce.qr_code && (
              <Bloc titre="QR code">
                <Ligne label="Jeton" valeur={commerce.qr_code.jeton} />
                <Ligne label="Généré le" valeur={date(commerce.qr_code.genere_le)} />
                <Ligne label="Imprimé le" valeur={commerce.qr_code.imprime_le ? date(commerce.qr_code.imprime_le) : 'jamais'} />
                <Ligne label="Scans" valeur={nombre(commerce.qr_code.nb_scans)} />
                <div className="pt-2">
                  <Bouton taille="petit" onClick={() => api.ouvrirPdf(`/commerces/${id}/sticker`)}>
                    Sticker A6
                  </Bouton>
                </div>
              </Bloc>
            )}

            {commerce.photos?.length > 0 && (
              <Bloc titre={`Photos (${commerce.photos.length})`}>
                <div className="grid grid-cols-3 gap-2">
                  {commerce.photos.map((p) => (
                    <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer"
                      className="block overflow-hidden rounded-lg border border-bordure">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt={`Photo ${p.type}`} className="h-24 w-full object-cover" />
                      <span className="block bg-surface-alt px-1 py-0.5 text-[11px] text-encre-2">{p.type}</span>
                    </a>
                  ))}
                </div>
              </Bloc>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

const Bloc = ({ titre, children }) => (
  <section>
    <h3 className="mb-2 text-sm font-semibold text-encre">{titre}</h3>
    <div className="space-y-1">{children}</div>
  </section>
);

const Ligne = ({ label, valeur }) => (
  <div className="flex justify-between gap-4 border-b border-grille py-1.5 last:border-0">
    <span className="shrink-0 text-[13px] text-encre-2">{label}</span>
    <span className="text-right text-sm text-encre">{valeur || '—'}</span>
  </div>
);

export default function PageCommerces() {
  return (
    <Suspense fallback={<Chargement />}>
      <Liste />
    </Suspense>
  );
}
