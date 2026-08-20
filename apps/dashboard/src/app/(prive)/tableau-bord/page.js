'use client';

/**
 * Vue d'ensemble.
 *
 * Ce que la mairie doit lire en dix secondes : combien de commerces, combien
 * sont à jour, combien reste-t-il à recouvrer, et où sont les impayés.
 *
 * Les formes ont été choisies avant les couleurs :
 *   - les chiffres isolés sont des TUILES, pas des graphiques à une barre ;
 *   - le taux de recouvrement est le CHIFFRE PHARE de la page ;
 *   - la situation par zone est une part-à-tout → barre empilée, couleurs de
 *     STATUT parce que les segments signifient bon/mauvais ;
 *   - la répartition par taxe est une comparaison de grandeurs → barres d'une
 *     SEULE teinte.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { xof, nombre, pourcentage, moisFr, STATUTS } from '@/lib/format';
import { Carte, Bouton, Chargement, Message, AvecVueTableau, EtatVide } from '@/composants/ui';
import {
  TuileStat, FigureHero, BarresEmpilees, BarresMagnitude, Courbe, Jauge, LegendeStatuts,
} from '@/composants/graphiques';

export default function TableauBord() {
  const [donnees, setDonnees] = useState(null);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [bord, zones, recouvrement, taxes, coherence] = await Promise.all([
          api.get('/stats/tableau-bord'),
          api.get('/stats/zones'),
          api.get('/stats/recouvrement'),
          api.get('/stats/taxes'),
          api.get('/stats/coherence').catch(() => null),
        ]);
        setDonnees({ bord, zones, recouvrement, taxes, coherence });
      } catch (err) {
        setErreur(err.message);
      }
    })();
  }, []);

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!donnees) return <Chargement />;

  const { bord, zones, recouvrement, taxes, coherence } = donnees;
  if (!bord) return <EtatVide titre="Aucune donnée" texte="Cette commune n'a pas encore de commerce enregistré." />;

  const periodeCourante = recouvrement?.[0] ?? null;
  const tauxCommerces = bord.nb_commerces > 0
    ? (bord.nb_a_jour / bord.nb_commerces) * 100 : 0;

  // Périodes en ordre chronologique pour la courbe (l'API renvoie l'inverse)
  const evolution = [...(recouvrement ?? [])].reverse()
    .filter((p) => p.montant_attendu > 0)
    .map((p) => ({
      cle: p.periode_id,
      libelle: moisFr(p.periode),
      valeur: Number(p.taux_recouvrement_pct) || 0,
    }));

  const totauxStatuts = {
    a_jour: zones.reduce((s, z) => s + z.nb_a_jour, 0),
    partiel: zones.reduce((s, z) => s + z.nb_partiel, 0),
    impaye: zones.reduce((s, z) => s + z.nb_impaye, 0),
  };

  return (
    <div className="space-y-5">
      {/* --- Alertes de cohérence, avant tout le reste --- */}
      {coherence?.total_provisoire > 0 && (
        <Message type="avertissement" titre={`${coherence.total_provisoire} données encore provisoires`}>
          Les barèmes et libellés du jeu initial sont des valeurs d'attente.
          {' '}<Link href="/parametres" className="underline underline-offset-2">
            Voir le détail
          </Link> — aucun avis ne doit être émis avant de les avoir remplacés.
        </Message>
      )}
      {coherence?.controles?.filter((c) => c.gravite === 'erreur').map((c) => (
        <Message key={c.controle} type="erreur" titre={`${c.nb} — ${c.controle}`}>
          {c.detail}
        </Message>
      ))}

      {/* --- Chiffre phare + jauges --- */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Carte>
          <FigureHero
            etiquette={periodeCourante ? `Recouvrement ${moisFr(periodeCourante.periode)}` : 'Recouvrement'}
            valeur={pourcentage(periodeCourante?.taux_recouvrement_pct ?? 0)}
            detail={periodeCourante
              ? `${xof(periodeCourante.montant_recouvre, { court: true })} sur ${xof(periodeCourante.montant_attendu, { court: true })}`
              : 'Aucune période facturée'}
          />
          <div className="mt-5 space-y-4">
            <Jauge
              valeur={tauxCommerces}
              etiquette="Commerces à jour"
              detail={`${nombre(bord.nb_a_jour)} sur ${nombre(bord.nb_commerces)}`}
            />
            <Jauge
              valeur={periodeCourante?.taux_recouvrement_pct ?? 0}
              etiquette="Montant recouvré"
              detail={periodeCourante ? `Reste ${xof(periodeCourante.montant_restant, { court: true })}` : '—'}
            />
          </div>
        </Carte>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
          <TuileStat etiquette="Commerces recensés" valeur={nombre(bord.nb_commerces)} />
          <TuileStat etiquette="À jour" valeur={nombre(bord.nb_a_jour)}
            accent={STATUTS.a_jour.variable} detail={pourcentage(tauxCommerces, { decimales: 0 })} />
          <TuileStat etiquette="Impayés" valeur={nombre(bord.nb_impayes)}
            accent={STATUTS.impaye.variable} />
          <TuileStat etiquette="Reste à recouvrer" valeur={xof(bord.montant_du_total, { court: true })}
            accent={STATUTS.impaye.variable} />
          <TuileStat etiquette="Encaissé ce mois" valeur={xof(bord.encaisse_ce_mois, { court: true })}
            accent={STATUTS.a_jour.variable} detail={`dont ${xof(bord.encaisse_aujourdhui, { court: true })} aujourd'hui`} />
          <TuileStat etiquette="Agents actifs" valeur={nombre(bord.nb_agents)}
            detail={`${nombre(bord.nb_visites_aujourdhui)} visites aujourd'hui`} />
        </div>
      </div>

      {/* --- Évolution --- */}
      {evolution.length >= 2 && (
        <Carte titre="Évolution du recouvrement"
          sousTitre="Part des montants effectivement encaissés, mois par mois"
          actions={<Bouton taille="petit" onClick={() => api.ouvrirPdf('/exports/recouvrement.pdf')}>
            État PDF
          </Bouton>}
        >
          <AvecVueTableau
            colonnes={[
              { cle: 'libelle', titre: 'Période' },
              { cle: 'valeur', titre: 'Taux', alignement: 'droite', rendu: (l) => pourcentage(l.valeur) },
            ]}
            lignes={evolution}
            cle="cle"
          >
            <Courbe points={evolution} formatValeur={(v) => pourcentage(v)} />
          </AvecVueTableau>
        </Carte>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Situation par zone : part-à-tout, couleurs de statut --- */}
        <Carte titre="Situation par zone"
          sousTitre="Répartition des commerces selon leur situation fiscale"
        >
          <div className="mb-4">
            <LegendeStatuts totaux={totauxStatuts} />
          </div>
          <AvecVueTableau
            colonnes={[
              { cle: 'zone_nom', titre: 'Zone' },
              { cle: 'nb_commerces', titre: 'Commerces', alignement: 'droite' },
              { cle: 'nb_a_jour', titre: 'À jour', alignement: 'droite' },
              { cle: 'nb_partiel', titre: 'Partiels', alignement: 'droite' },
              { cle: 'nb_impaye', titre: 'Impayés', alignement: 'droite' },
              { cle: 'montant_du', titre: 'Dû', alignement: 'droite', rendu: (l) => xof(l.montant_du, { court: true }) },
            ]}
            lignes={zones}
            cle="zone_id"
          >
            <BarresEmpilees
              lignes={zones.map((z) => ({
                cle: z.zone_id,
                libelle: z.zone_nom,
                a_jour: z.nb_a_jour,
                partiel: z.nb_partiel,
                impaye: z.nb_impaye,
              }))}
              segments={[
                { cle: 'a_jour', libelle: STATUTS.a_jour.libelle, variable: STATUTS.a_jour.variable },
                { cle: 'partiel', libelle: STATUTS.partiel.libelle, variable: STATUTS.partiel.variable },
                { cle: 'impaye', libelle: STATUTS.impaye.libelle, variable: STATUTS.impaye.variable },
              ]}
              etiquetteTotal={(_l, total) => `${nombre(total)} commerces`}
            />
          </AvecVueTableau>
        </Carte>

        {/* --- Par taxe : magnitude, teinte unique --- */}
        <Carte titre="Montants facturés par taxe"
          sousTitre={taxes?.[0]?.periode ? `Période ${moisFr(taxes[0].periode)}` : 'Toutes périodes'}
        >
          <AvecVueTableau
            colonnes={[
              { cle: 'taxe', titre: 'Taxe' },
              { cle: 'nb_lignes', titre: 'Lignes', alignement: 'droite' },
              { cle: 'montant_facture', titre: 'Facturé', alignement: 'droite', rendu: (l) => xof(l.montant_facture) },
              { cle: 'montant_recouvre_estime', titre: 'Recouvré (est.)', alignement: 'droite', rendu: (l) => xof(l.montant_recouvre_estime) },
            ]}
            lignes={taxes ?? []}
            cle="taxe_code"
          >
            <BarresMagnitude
              lignes={(taxes ?? []).map((t) => ({
                cle: `${t.periode}-${t.taxe_code}`,
                libelle: t.taxe,
                valeur: Number(t.montant_facture) || 0,
              }))}
              formatValeur={(v) => xof(v, { court: true })}
            />
            <p className="mt-3 text-[13px] text-encre-attenuee">
              Le montant recouvré par taxe est une estimation proportionnelle :
              un paiement Wave règle l'avis dans son ensemble, pas une taxe en
              particulier.
            </p>
          </AvecVueTableau>
        </Carte>
      </div>

      <div className="flex flex-wrap gap-2 sans-impression">
        <Bouton onClick={() => api.telecharger('/exports/commerces.xlsx')}>
          Exporter les commerces (Excel)
        </Bouton>
        <Bouton onClick={() => api.telecharger('/exports/paiements.xlsx')}>
          Exporter les paiements (Excel)
        </Bouton>
        <Bouton onClick={() => api.ouvrirPdf('/exports/recouvrement.pdf')}>
          État de recouvrement (PDF)
        </Bouton>
      </div>
    </div>
  );
}
