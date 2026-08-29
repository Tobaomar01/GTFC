'use client';

/**
 * Recueil d'activité des agents de recouvrement.
 *
 * Deux lectures que la page doit tenir ensemble : le pilotage de la campagne —
 * où en est-on, qui a besoin d'aide — et la reconnaissance du travail fourni.
 * Elle ne comptait que trois natures d'intervention sur les dix que le terrain
 * produit ; un agent occupé à des contrôles et des mises à jour apparaissait
 * presque inactif. Un indicateur qui mesure mal finit par orienter le travail
 * vers ce qu'il mesure.
 *
 * Ce que la page ne montre pas, et ne montrera pas : les déplacements. Le
 * suivi de position des agents a été écarté par le commanditaire (FR-051a,
 * FR-051b). Les « positions à vérifier » sont l'écart entre le point relevé
 * lors d'une intervention et celui du commerce — un contrôle de qualité de la
 * donnée, jamais une trace de parcours ni un soupçon.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { nombre, delai, ROLES } from '@/lib/format';
import { Carte, Bouton, Chargement, Message, Tableau } from '@/composants/ui';
import { TuileStat, BarresMagnitude } from '@/composants/graphiques';

const PERIODES = [
  { jours: 7, libelle: '7 jours' },
  { jours: 30, libelle: '30 jours' },
  { jours: 90, libelle: '90 jours' },
];

/** Minutes en heures et minutes : « 3 h 20 » se lit, « 200 » se calcule. */
function duree(minutes) {
  const m = Number(minutes) || 0;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export default function PageAgents() {
  const [jours, setJours] = useState(7);
  const [donnees, setDonnees] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [exportEnCours, setExportEnCours] = useState(false);

  const depuis = new Date(Date.now() - jours * 86400000).toISOString().slice(0, 10);

  const charger = useCallback(async () => {
    try {
      setErreur(null);
      const [agents, stats] = await Promise.all([
        api.liste('/agents', { limite: 100 }),
        api.get('/stats/agents', { depuis }),
      ]);
      setDonnees({ agents: agents.lignes, stats });
    } catch (err) { setErreur(err.message); }
  }, [depuis]);

  useEffect(() => { charger(); }, [charger]);

  async function exporter() {
    setExportEnCours(true);
    try { await api.telecharger('/exports/activite-agents.csv', { depuis }); }
    catch (err) { setErreur(err.message); }
    finally { setExportEnCours(false); }
  }

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!donnees) return <Chargement />;

  const { agents, stats } = donnees;
  const lignes = stats.agents;
  const somme = (cle) => lignes.reduce((s, a) => s + (Number(a[cle]) || 0), 0);
  const reprises = stats.fiches_a_completer ?? { total: 0, bloquantes: 0 };

  return (
    <div className="space-y-5">

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5">
          {PERIODES.map((p) => (
            <button
              key={p.jours}
              type="button"
              onClick={() => setJours(p.jours)}
              className={`rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
                jours === p.jours
                  ? 'border-primaire bg-primaire text-white font-semibold'
                  : 'border-bordure bg-surface text-encre-2 hover:bg-surface-alt'
              }`}
            >
              {p.libelle}
            </button>
          ))}
        </div>
        <Bouton variante="secondaire" onClick={exporter} charge={exportEnCours}>
          Exporter le recueil (CSV)
        </Bouton>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <TuileStat etiquette="Agents" valeur={nombre(agents.length)} />
        <TuileStat etiquette={`Interventions (${jours} j)`} valeur={nombre(somme('visites'))} />
        <TuileStat etiquette={`Recensements (${jours} j)`}
          valeur={nombre(somme('enregistrements'))} />
        <TuileStat etiquette={`Temps en intervention (${jours} j)`}
          valeur={duree(somme('minutes_intervention'))} />
      </div>

      {reprises.total > 0 ? (
        <Carte
          titre="Fiches à reprendre"
          sousTitre="Recensées sans le gérant : boutique ouverte, personne pour répondre"
          actions={(
            <Link href="/commerces?a_completer=true"
              className="text-[13px] font-medium text-primaire hover:underline">
              Voir la liste
            </Link>
          )}
        >
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <TuileStat etiquette="À compléter" valeur={nombre(reprises.total)} />
            <TuileStat
              etiquette="Sans numéro"
              valeur={nombre(reprises.bloquantes)}
              accent={reprises.bloquantes > 0 ? '--st-impaye' : null}
            />
            <TuileStat etiquette="La plus ancienne"
              valeur={reprises.plus_ancienne_jours != null
                ? `${reprises.plus_ancienne_jours} j` : '—'} />
          </div>
          <p className="mt-3 text-[13px] text-encre-attenuee">
            Une fiche <strong>sans numéro</strong> ne rapportera rien : le pilote n'a
            qu'un canal de recouvrement, le SMS mensuel portant le lien Wave. Ces
            fiches doivent être complétées au second passage avant l'émission des avis.
          </p>
        </Carte>
      ) : null}

      <Carte titre="Interventions par agent" sousTitre={`Sur les ${jours} derniers jours`}>
        <BarresMagnitude
          lignes={lignes.map((a) => ({ cle: a.agent_id, libelle: a.agent, valeur: a.visites }))}
          formatValeur={nombre}
        />
      </Carte>

      <Carte titre="Détail par agent" sousTitre="Toutes natures d'intervention">
        <Tableau cle="agent_id" lignes={lignes} vide="Aucune activité sur la période"
          colonnes={[
            { cle: 'agent', titre: 'Agent' },
            { cle: 'jours_actifs', titre: 'Jours', alignement: 'droite' },
            { cle: 'visites', titre: 'Interv.', alignement: 'droite' },
            { cle: 'enregistrements', titre: 'Recens.', alignement: 'droite' },
            { cle: 'mises_a_jour', titre: 'Mises à jour', alignement: 'droite' },
            { cle: 'controles', titre: 'Contrôles', alignement: 'droite' },
            {
              cle: 'paiements_assistes',
              titre: 'Paiements',
              alignement: 'droite',
              // Zéro espèce : l'agent n'encaisse pas, il accompagne le
              // paiement Wave. Le libellé doit dire ce qui se passe.
              rendu: (l) => nombre(l.paiements_assistes),
            },
            {
              cle: 'minutes_intervention',
              titre: 'Temps',
              alignement: 'droite',
              rendu: (l) => duree(l.minutes_intervention),
            },
            {
              cle: 'fiches_a_reprendre',
              titre: 'À reprendre',
              alignement: 'droite',
              rendu: (l) => (l.fiches_a_reprendre > 0
                ? <span title="Fiches recensées sans le gérant, sur la période">
                    {nombre(l.fiches_a_reprendre)}
                  </span>
                : '—'),
            },
            {
              cle: 'visites_eloignees',
              titre: 'Positions à vérifier',
              alignement: 'droite',
              rendu: (l) => (l.visites_eloignees > 0
                ? <span title="Position relevée à plus de 100 m du commerce"
                    style={{ color: 'var(--st-partiel)', fontWeight: 600 }}>
                    {l.visites_eloignees}
                  </span>
                : '—'),
            },
          ]} />
        <p className="mt-2 text-[13px] text-encre-attenuee">
          « Positions à vérifier » : la position relevée était à plus de 100 m du
          commerce. Cela arrive avec un signal GPS faible — ce n'est un signal
          d'alerte qu'en cas de répétition. « Paiements » compte les paiements Wave
          accompagnés par l'agent : le pilote n'encaisse aucune espèce.
        </p>
      </Carte>

      <Carte titre="Comptes">
        <Tableau cle="id" lignes={agents}
          colonnes={[
            { cle: 'nom_complet', titre: 'Nom' },
            { cle: 'role', titre: 'Rôle', rendu: (l) => ROLES[l.role] ?? l.role },
            { cle: 'telephone', titre: 'Téléphone', monospace: true },
            { cle: 'nb_recensements', titre: 'Recensements', alignement: 'droite' },
            { cle: 'derniere_sync', titre: 'Dernière synchro', rendu: (l) => delai(l.derniere_sync) },
            {
              cle: 'actif',
              titre: 'État',
              rendu: (l) => {
                if (!l.actif) return <span style={{ color: 'var(--st-impaye)' }}>Désactivé</span>;
                if (l.verrouille_jusqu_a) return <span style={{ color: 'var(--st-partiel)' }}>Verrouillé</span>;
                return 'Actif';
              },
            },
          ]} />
      </Carte>
    </div>
  );
}
