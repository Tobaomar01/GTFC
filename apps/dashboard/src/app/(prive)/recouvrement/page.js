'use client';

/**
 * Recouvrement : périodes, avis, campagnes de paiement, paiements, quittances.
 *
 * C'est ici que la mairie déclenche la facturation du mois. Les actions qui
 * engagent la commune — générer, émettre, lancer la campagne — sont
 * confirmées, jamais déclenchées d'un seul clic.
 */
import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  xof, nombre, date, pourcentage, moisFr, MOYENS_PAIEMENT, STATUTS,
} from '@/lib/format';
import {
  Carte, Bouton, Chargement, Message, Tableau, Selection, AvecVueTableau,
} from '@/composants/ui';
import { TuileStat, BarresEmpilees, Legende } from '@/composants/graphiques';

export default function PageRecouvrement() {
  const [periodes, setPeriodes] = useState(null);
  const [paiements, setPaiements] = useState(null);
  const [notifications, setNotifications] = useState(null);
  const [message, setMessage] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [occupe, setOccupe] = useState(null);
  const [moyen, setMoyen] = useState(null);

  const charger = useCallback(async () => {
    try {
      const [p, pa, n] = await Promise.all([
        api.get('/periodes'),
        api.liste('/paiements', { limite: 25, moyen }),
        api.get('/notifications/a-transmettre').catch(() => null),
      ]);
      setPeriodes(p); setPaiements(pa); setNotifications(n);
    } catch (err) { setErreur(err.message); }
  }, [moyen]);

  useEffect(() => { charger(); }, [charger]);

  const agir = async (cle, action, confirmation) => {
    if (confirmation && !window.confirm(confirmation)) return;
    setOccupe(cle); setMessage(null); setErreur(null);
    try {
      const resultat = await action();
      setMessage(resultat);
      await charger();
    } catch (err) { setErreur(err.message); } finally { setOccupe(null); }
  };

  if (erreur && !periodes) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!periodes) return <Chargement />;

  const courante = periodes.find((p) => !p.close) ?? periodes[0];

  return (
    <div className="space-y-5">
      {message && (
        <Message type="succes" titre="Opération effectuée">
          <pre className="whitespace-pre-wrap font-sans text-[13px]">
            {typeof message === 'string' ? message : JSON.stringify(message, null, 1)}
          </pre>
        </Message>
      )}
      {erreur && <Message type="erreur">{erreur}</Message>}

      {/* --- Période courante et actions --- */}
      {courante && (
        <Carte
          titre={`Période ${moisFr(courante.code)}`}
          sousTitre={`Exigible le ${date(courante.date_exigibilite)}${courante.close ? ' — période close' : ''}`}
        >
          <div className="mb-4 grid gap-3 grid-cols-2 lg:grid-cols-4">
            <TuileStat etiquette="Avis émis" valeur={nombre(courante.nb_avis)} />
            <TuileStat etiquette="Montant attendu" valeur={xof(courante.montant_attendu, { court: true })} />
            <TuileStat etiquette="Recouvré" valeur={xof(courante.montant_recouvre, { court: true })}
              accent={STATUTS.a_jour.variable}
              detail={pourcentage(courante.taux_recouvrement_pct)} />
            <TuileStat etiquette="Restant" valeur={xof(courante.montant_restant, { court: true })}
              accent={STATUTS.impaye.variable} />
          </div>

          <div className="flex flex-wrap gap-2 sans-impression">
            <Bouton
              charge={occupe === 'generer'}
              onClick={() => agir('generer',
                () => api.post(`/periodes/${courante.id}/generer`),
                `Générer les avis de ${moisFr(courante.code)} ?\n\n`
                + 'Un avis sera calculé pour chaque commerce actif. '
                + 'L\'opération est sans risque : relancée, elle ne facture pas deux fois.')}
            >
              1. Générer les avis
            </Bouton>
            <Bouton
              charge={occupe === 'emettre'}
              onClick={() => agir('emettre',
                () => api.post(`/periodes/${courante.id}/emettre`),
                'Émettre les avis ? Ils deviennent exigibles et pourront être payés.')}
            >
              2. Émettre
            </Bouton>
            <Bouton
              variante="primaire"
              charge={occupe === 'campagne'}
              onClick={() => agir('campagne',
                () => api.post(`/campagnes/${courante.id}/lancer`),
                'Lancer la campagne de paiement ?\n\n'
                + 'Un lien de paiement et une notification seront préparés pour '
                + 'chaque avis émis. Relancer la campagne ne crée pas de doublon.')}
            >
              3. Lancer la campagne
            </Bouton>
            <Bouton
              charge={occupe === 'relance'}
              onClick={() => agir('relance',
                () => api.post('/campagnes/relancer', { jours_retard_min: 3 }),
                'Relancer les impayés de plus de 3 jours ?')}
            >
              Relancer les impayés
            </Bouton>
            <Bouton onClick={() => api.ouvrirPdf('/exports/recouvrement.pdf', { periode_id: courante.id })}>
              État PDF
            </Bouton>
          </div>
        </Carte>
      )}

      {/* --- Historique des périodes --- */}
      <Carte titre="Historique du recouvrement">
        <div className="mb-4">
          <Legende entrees={[
            { cle: 'recouvre', libelle: 'Recouvré', variable: STATUTS.a_jour.variable },
            { cle: 'restant', libelle: 'Restant dû', variable: STATUTS.impaye.variable },
          ]} />
        </div>
        <AvecVueTableau
          cle="periode_id"
          lignes={periodes.filter((p) => p.montant_attendu > 0)}
          colonnes={[
            { cle: 'code', titre: 'Période', rendu: (l) => moisFr(l.code) },
            { cle: 'nb_avis', titre: 'Avis', alignement: 'droite' },
            { cle: 'montant_attendu', titre: 'Attendu', alignement: 'droite', rendu: (l) => xof(l.montant_attendu) },
            { cle: 'montant_recouvre', titre: 'Recouvré', alignement: 'droite', rendu: (l) => xof(l.montant_recouvre) },
            { cle: 'montant_restant', titre: 'Restant', alignement: 'droite', rendu: (l) => xof(l.montant_restant) },
            { cle: 'taux_recouvrement_pct', titre: 'Taux', alignement: 'droite', rendu: (l) => pourcentage(l.taux_recouvrement_pct) },
          ]}
        >
          <BarresEmpilees
            lignes={periodes.filter((p) => p.montant_attendu > 0).map((p) => ({
              cle: p.id,
              libelle: moisFr(p.code),
              recouvre: Number(p.montant_recouvre) || 0,
              restant: Number(p.montant_restant) || 0,
            }))}
            segments={[
              { cle: 'recouvre', libelle: 'Recouvré', variable: STATUTS.a_jour.variable },
              { cle: 'restant', libelle: 'Restant dû', variable: STATUTS.impaye.variable },
            ]}
            formatValeur={(v) => xof(v, { court: true })}
            etiquetteTotal={(_l, total) => xof(total, { court: true })}
          />
        </AvecVueTableau>
      </Carte>

      {/* --- Messages à transmettre : la sortie utile tant qu'aucun SMS --- */}
      {notifications?.nombre > 0 && (
        <Carte
          titre={`${nombre(notifications.nombre)} message(s) à transmettre`}
          sousTitre={`Canal : ${notifications.canal_actif}`}
        >
          <Message type="info">
            Aucun opérateur SMS n'est raccordé. Imprimez cette liste et confiez-la
            aux agents : ils transmettront les demandes de paiement lors de leur
            tournée, puis vous les marquerez comme remises.
          </Message>
          <div className="mt-3">
            {/* 15 lignes seulement : le message complet contient une URL de
                paiement longue, et afficher 500 lignes rendrait la page
                interminable. La liste exhaustive part à l'impression. */}
            <Tableau compact cle="id" lignes={notifications.messages.slice(0, 15)}
              colonnes={[
                { cle: 'commerce_code', titre: 'Code', monospace: true },
                { cle: 'enseigne', titre: 'Commerce' },
                { cle: 'quartier', titre: 'Quartier' },
                { cle: 'destinataire', titre: 'Téléphone', monospace: true },
                { cle: 'montant_restant', titre: 'Dû', alignement: 'droite', rendu: (l) => xof(l.montant_restant) },
                {
                  cle: 'checkout_url',
                  titre: 'Lien de paiement',
                  rendu: (l) => (l.checkout_url
                    ? <span className="font-mono text-[12px] text-encre-2">
                      …{String(l.checkout_url).slice(-14)}
                    </span>
                    : 'à la mairie'),
                },
              ]} />
          </div>

          {notifications.nombre > 15 && (
            <p className="mt-2 text-[13px] text-encre-attenuee">
              15 premiers affichés sur {nombre(notifications.nombre)}. Le message
              complet, lien de paiement compris, figure dans l&apos;export.
            </p>
          )}
        </Carte>
      )}

      {/* --- Paiements --- */}
      <Carte
        titre="Derniers paiements"
        actions={(
          <>
            <div className="w-44">
              <Selection valeur={moyen} onChange={setMoyen} aucun="Tous les moyens"
                options={Object.entries(MOYENS_PAIEMENT).map(([v, l]) => ({ valeur: v, libelle: l }))} />
            </div>
            <Bouton taille="petit" onClick={() => api.telecharger('/exports/paiements.xlsx', { moyen })}>
              Excel
            </Bouton>
          </>
        )}
      >
        {!paiements ? <Chargement /> : (
          <Tableau
            cle="id"
            lignes={paiements.lignes}
            vide="Aucun paiement enregistré"
            colonnes={[
              { cle: 'paye_le', titre: 'Date', rendu: (l) => date(l.paye_le, { avecHeure: true }) },
              { cle: 'commerce_code', titre: 'Code', monospace: true },
              { cle: 'enseigne', titre: 'Commerce' },
              { cle: 'moyen', titre: 'Moyen', rendu: (l) => MOYENS_PAIEMENT[l.moyen] ?? l.moyen },
              { cle: 'montant', titre: 'Montant', alignement: 'droite', rendu: (l) => xof(l.montant) },
              {
                cle: 'quittance_numero',
                titre: 'Quittance',
                rendu: (l) => (l.quittance_numero
                  ? <span className="font-mono text-[12px]">{l.quittance_numero}</span>
                  : '—'),
              },
            ]}
          />
        )}
      </Carte>
    </div>
  );
}
