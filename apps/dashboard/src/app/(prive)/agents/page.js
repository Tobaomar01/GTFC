'use client';

/**
 * Agents : activité, positions récentes, espèces non versées.
 *
 * Les « visites éloignées » ne sont pas une accusation : c'est un écart entre
 * la position relevée et celle du commerce, qui mérite un coup d'œil. Le
 * libellé le dit explicitement — un tableau de bord ne doit pas transformer
 * une donnée technique en soupçon.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { xof, nombre, date, delai, ROLES } from '@/lib/format';
import { Carte, Bouton, Chargement, Message, Tableau } from '@/composants/ui';
import { TuileStat, BarresMagnitude } from '@/composants/graphiques';

export default function PageAgents() {
  const [donnees, setDonnees] = useState(null);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [agents, stats, positions, especes] = await Promise.all([
          api.liste('/agents', { limite: 100 }),
          api.get('/stats/agents'),
          api.get('/agents/positions/dernieres').catch(() => []),
          api.get('/stats/especes-non-versees').catch(() => []),
        ]);
        setDonnees({ agents: agents.lignes, stats, positions, especes });
      } catch (err) { setErreur(err.message); }
    })();
  }, []);

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!donnees) return <Chargement />;

  const { agents, stats, positions, especes } = donnees;
  const totalEspeces = especes.reduce((s, e) => s + Number(e.montant_total || 0), 0);

  return (
    <div className="space-y-5">
      {especes.length > 0 && (
        <Message type="avertissement" titre={`${xof(totalEspeces)} encaissés en espèces, non versés en caisse`}>
          Ces montants ont été encaissés sur le terrain et n'ont pas encore été
          remis à la mairie. C'est le contrôle le plus direct du dispositif :
          rapprochez-les avec la caisse.
        </Message>
      )}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <TuileStat etiquette="Agents" valeur={nombre(agents.length)} />
        <TuileStat etiquette="Visites (7 jours)"
          valeur={nombre(stats.agents.reduce((s, a) => s + a.visites, 0))} />
        <TuileStat etiquette="Recensements (7 jours)"
          valeur={nombre(stats.agents.reduce((s, a) => s + a.enregistrements, 0))} />
        <TuileStat etiquette="Espèces à rapprocher" valeur={xof(totalEspeces, { court: true })}
          accent={totalEspeces > 0 ? '--st-impaye' : null} />
      </div>

      <Carte titre="Activité des agents" sousTitre="Visites sur les 7 derniers jours">
        <BarresMagnitude
          lignes={stats.agents.map((a) => ({ cle: a.agent_id, libelle: a.agent, valeur: a.visites }))}
          formatValeur={nombre}
        />
      </Carte>

      <Carte titre="Détail par agent">
        <Tableau cle="agent_id" lignes={stats.agents} vide="Aucune activité sur la période"
          colonnes={[
            { cle: 'agent', titre: 'Agent' },
            { cle: 'jours_actifs', titre: 'Jours', alignement: 'droite' },
            { cle: 'visites', titre: 'Visites', alignement: 'droite' },
            { cle: 'enregistrements', titre: 'Recensements', alignement: 'droite' },
            { cle: 'encaissements', titre: 'Encaissements', alignement: 'droite' },
            {
              cle: 'visites_eloignees',
              titre: 'Visites à vérifier',
              alignement: 'droite',
              rendu: (l) => (l.visites_eloignees > 0
                ? <span title="Position relevée à plus de 100 m du commerce"
                    style={{ color: 'var(--st-partiel)', fontWeight: 600 }}>{l.visites_eloignees}</span>
                : '—'),
            },
          ]} />
        <p className="mt-2 text-[13px] text-encre-attenuee">
          « Visites à vérifier » : la position relevée était à plus de 100 m du
          commerce. Cela arrive avec un signal GPS faible — ce n'est un signal
          d'alerte qu'en cas de répétition.
        </p>
      </Carte>

      {especes.length > 0 && (
        <Carte titre="Espèces non versées en caisse">
          <Tableau cle="agent_id" lignes={especes}
            colonnes={[
              { cle: 'agent', titre: 'Agent' },
              { cle: 'nb_paiements', titre: 'Encaissements', alignement: 'droite' },
              { cle: 'montant_total', titre: 'Montant', alignement: 'droite', rendu: (l) => xof(l.montant_total) },
              { cle: 'plus_ancien', titre: 'Plus ancien', rendu: (l) => date(l.plus_ancien) },
              {
                cle: 'anciennete_jours',
                titre: 'Ancienneté',
                alignement: 'droite',
                rendu: (l) => (l.anciennete_jours > 3
                  ? <span style={{ color: 'var(--st-impaye)', fontWeight: 600 }}>{l.anciennete_jours} j</span>
                  : `${l.anciennete_jours} j`),
              },
            ]} />
        </Carte>
      )}

      <Carte titre="Dernières positions" sousTitre="Relevés des 12 dernières heures">
        <Tableau cle="agent_id" lignes={positions} vide="Aucune position transmise récemment"
          colonnes={[
            { cle: 'agent', titre: 'Agent' },
            { cle: 'releve_le', titre: 'Relevé', rendu: (l) => delai(l.releve_le) },
            {
              cle: 'longitude',
              titre: 'Position',
              monospace: true,
              rendu: (l) => `${Number(l.latitude).toFixed(5)}, ${Number(l.longitude).toFixed(5)}`,
            },
            { cle: 'precision_gps_m', titre: 'Précision', alignement: 'droite', rendu: (l) => (l.precision_gps_m ? `${Math.round(l.precision_gps_m)} m` : '—') },
            { cle: 'batterie_pct', titre: 'Batterie', alignement: 'droite', rendu: (l) => (l.batterie_pct != null ? `${l.batterie_pct} %` : '—') },
          ]} />
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
