'use client';

/**
 * Carte des commerces.
 *
 * Les filtres sont dans UNE seule rangée au-dessus de la carte, jamais à
 * l'intérieur : tout ce qui est affiché répond au même découpage.
 */
import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { xof, nombre, pourcentage, STATUTS, ORDRE_STATUTS } from '@/lib/format';
import { Carte, Selection, Bouton, Chargement, Message, Tableau } from '@/composants/ui';
import { LegendeStatuts, TuileStat } from '@/composants/graphiques';
import CarteDynamique from '@/composants/CarteDynamique';

export default function PageCarte() {
  const router = useRouter();
  const [commerces, setCommerces] = useState(null);
  const [zones, setZones] = useState([]);
  const [quartiers, setQuartiers] = useState([]);
  const [erreur, setErreur] = useState(null);

  const [filtres, setFiltres] = useState({ zone_id: null, quartier_id: null, statut_fiscal: null });

  useEffect(() => {
    (async () => {
      try {
        const [z, q] = await Promise.all([api.get('/zones'), api.get('/quartiers')]);
        setZones(z); setQuartiers(q);
      } catch (err) { setErreur(err.message); }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setCommerces(await api.get('/commerces/carte', filtres));
      } catch (err) { setErreur(err.message); }
    })();
  }, [filtres]);

  const totaux = useMemo(() => {
    const t = { a_jour: 0, partiel: 0, impaye: 0, exonere: 0, inconnu: 0, du: 0 };
    for (const c of commerces ?? []) {
      t[c.statut_fiscal] = (t[c.statut_fiscal] ?? 0) + 1;
      t.du += Number(c.solde_du) || 0;
    }
    return t;
  }, [commerces]);

  const quartiersFiltres = filtres.zone_id
    ? quartiers.filter((q) => q.zone_id === filtres.zone_id)
    : quartiers;

  const sansPosition = (commerces ?? []).length === 0;

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;

  return (
    <div className="space-y-4">
      {/* --- Une seule rangée de filtres, au-dessus de tout ce qu'elle cadre --- */}
      <div className="grid gap-3 sm:grid-cols-3 sans-impression">
        <Selection
          etiquette="Zone"
          valeur={filtres.zone_id}
          onChange={(v) => setFiltres({ zone_id: v, quartier_id: null, statut_fiscal: filtres.statut_fiscal })}
          options={zones.map((z) => ({ valeur: z.id, libelle: z.nom }))}
          aucun="Toutes les zones"
        />
        <Selection
          etiquette="Quartier"
          valeur={filtres.quartier_id}
          onChange={(v) => setFiltres({ ...filtres, quartier_id: v })}
          options={quartiersFiltres.map((q) => ({ valeur: q.id, libelle: q.nom }))}
          aucun="Tous les quartiers"
        />
        <Selection
          etiquette="Situation fiscale"
          valeur={filtres.statut_fiscal}
          onChange={(v) => setFiltres({ ...filtres, statut_fiscal: v })}
          options={ORDRE_STATUTS.map((s) => ({ valeur: s, libelle: STATUTS[s].libelle }))}
          aucun="Toutes les situations"
        />
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <TuileStat etiquette="Affichés" valeur={nombre(commerces?.length ?? 0)} />
        <TuileStat etiquette="À jour" valeur={nombre(totaux.a_jour)} accent={STATUTS.a_jour.variable} />
        <TuileStat etiquette="Partiels" valeur={nombre(totaux.partiel)} accent={STATUTS.partiel.variable} />
        <TuileStat etiquette="Impayés" valeur={nombre(totaux.impaye)} accent={STATUTS.impaye.variable} />
        <TuileStat etiquette="Reste dû" valeur={xof(totaux.du, { court: true })} accent={STATUTS.impaye.variable} />
      </div>

      <Carte
        titre="Commerces géolocalisés"
        sousTitre="Cliquez sur un marqueur pour ouvrir la fiche"
        actions={<Bouton taille="petit" onClick={() => api.telecharger('/exports/commerces.xlsx', filtres)}>
          Exporter
        </Bouton>}
      >
        <div className="mb-3">
          <LegendeStatuts statuts={ORDRE_STATUTS} />
        </div>

        {commerces === null ? <Chargement texte="Chargement des commerces…" /> : (
          <>
            <CarteDynamique
              commerces={commerces}
              surSelection={(c) => router.push(`/commerces?ouvrir=${c.id}`)}
            />
            {sansPosition && (
              <p className="mt-3 text-sm text-encre-2">
                Aucun commerce géolocalisé avec ces filtres. Les fiches sans
                coordonnées GPS n'apparaissent jamais sur la carte — elles
                restent listées dans la page Commerces.
              </p>
            )}
          </>
        )}
      </Carte>

      {/* Le jumeau tabulaire de la carte : aucune valeur n'est accessible
          uniquement par la couleur d'un marqueur. */}
      <Carte titre="Vue tableau" sousTitre="Les mêmes commerces, sous forme de liste">
        <Tableau
          compact
          cle="id"
          lignes={(commerces ?? []).slice(0, 200)}
          vide="Aucun commerce"
          colonnes={[
            { cle: 'code', titre: 'Code', monospace: true },
            { cle: 'enseigne', titre: 'Enseigne' },
            { cle: 'categorie', titre: 'Catégorie' },
            { cle: 'quartier', titre: 'Quartier' },
            {
              cle: 'statut_fiscal',
              titre: 'Situation',
              rendu: (l) => `${STATUTS[l.statut_fiscal]?.icone ?? ''} ${STATUTS[l.statut_fiscal]?.libelle ?? l.statut_fiscal}`,
            },
            { cle: 'solde_du', titre: 'Reste dû', alignement: 'droite', rendu: (l) => (Number(l.solde_du) > 0 ? xof(l.solde_du) : '—') },
          ]}
        />
        {(commerces ?? []).length > 200 && (
          <p className="mt-2 text-[13px] text-encre-attenuee">
            200 premiers affichés sur {nombre(commerces.length)}. Utilisez
            l'export Excel pour la liste complète.
          </p>
        )}
      </Carte>
    </div>
  );
}
