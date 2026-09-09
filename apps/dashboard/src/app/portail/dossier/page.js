'use client';

/**
 * Le dossier du redevable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CETTE PAGE DOIT RÉUSSIR
 *
 *  Répondre en trois secondes à « combien je dois, et pour quand ». C'est la
 *  seule question que se pose un commerçant qui ouvre ce lien. Tout le reste
 *  — détail des objets, historique, quittances — vient après, et se déroule.
 *
 *  DIRE POURQUOI, PAS SEULEMENT COMBIEN. Un montant sans explication se
 *  conteste au guichet, et mobilise un agent une demi-heure. Chaque ligne
 *  porte donc son objet, sa base de calcul et son tarif : « enseigne,
 *  2,4 m² × 800 F ». C'est exactement ce que l'agent aurait dit de vive voix.
 *
 *  NE PAS AFFICHER CE QUI N'EST PAS DÛ. Les avis au brouillon sont exclus par
 *  l'API : une facture que la mairie n'a pas encore arrêtée n'existe pas pour
 *  le redevable, et l'annoncer créerait une contestation sur un montant qui
 *  peut encore changer.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

const FORMAT = new Intl.NumberFormat('fr-FR');
const xof = (v) => `${FORMAT.format(Math.round(Number(v) || 0))} FCFA`;

const dateCourte = (v) => (v
  ? new Date(v).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
  : '—');

const STATUTS = {
  a_jour: { texte: 'À jour', classe: 'bg-st-ajour-fond text-st-ajour' },
  partiel: { texte: 'Paiement partiel', classe: 'bg-st-partiel-fond text-st-partiel' },
  impaye: { texte: 'En retard', classe: 'bg-st-impaye-fond text-st-impaye' },
  exonere: { texte: 'Exonéré', classe: 'bg-st-exonere-fond text-st-exonere' },
  // « inconnu » recouvre DEUX situations, et le libellé ne peut pas être le
  // même. app.recalculer_statut_redevable() le rend aussi bien quand aucun avis
  // n'existe QUE lorsqu'un avis est émis, son échéance à venir, et que rien
  // n'a encore été versé — délibérément, pour ne pas afficher en rouge
  // quelqu'un qui n'est en retard de rien.
  //
  // Le portail traduisait les deux par « Aucun avis émis ». Sur un téléphone,
  // le commerçant lisait « Aucun avis émis » au-dessus de « À payer : 85 000
  // FCFA — avis GTFC-2026-000004 ». Le système se contredisait à l'écran,
  // devant celui qui doit payer.
  inconnu: { texte: 'Aucun avis émis', classe: 'bg-st-inconnu-fond text-st-inconnu' },
  en_attente: { texte: 'Échéance à venir', classe: 'bg-st-inconnu-fond text-st-inconnu' },
};

async function appel(chemin, corps = null) {
  const reponse = await fetch(`/api/portail/${chemin}`, {
    method: corps ? 'POST' : 'GET',
    headers: corps ? { 'Content-Type': 'application/json' } : {},
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const json = await reponse.json().catch(() => null);
  return { statut: reponse.status, json, donnees: json?.donnees };
}

export default function DossierPortail() {
  const router = useRouter();
  const [dossier, setDossier] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [avisOuvert, setAvisOuvert] = useState(null);
  const [detail, setDetail] = useState(null);

  const charger = useCallback(async () => {
    const r = await appel('dossier');
    if (r.statut === 401) { router.replace('/portail'); return; }
    if (r.statut !== 200) { setErreur('Dossier momentanément indisponible.'); return; }
    setDossier(r.donnees);
  }, [router]);

  useEffect(() => { charger(); }, [charger]);

  const ouvrirAvis = async (id) => {
    if (avisOuvert === id) { setAvisOuvert(null); return; }
    setAvisOuvert(id);
    setDetail(null);
    const r = await appel(`avis/${id}`);
    if (r.statut === 200) setDetail(r.donnees);
  };

  const seDeconnecter = async () => {
    await appel('deconnexion', {});
    router.replace('/portail');
  };

  if (erreur) {
    return <p className="rounded-lg border-l-[3px] border-st-impaye bg-surface p-4 text-[14px] text-encre">{erreur}</p>;
  }
  if (!dossier) {
    return <p className="py-8 text-center text-[14px] text-encre-attenuee">Chargement…</p>;
  }

  const { redevable, objets, avis, prochaine_echeance: echeance } = dossier;
  // On ne dit « aucun avis émis » que s'il n'y en a vraiment aucun.
  const statut = redevable.statut_fiscal === 'inconnu' && (avis?.length ?? 0) > 0
    ? STATUTS.en_attente
    : (STATUTS[redevable.statut_fiscal] ?? STATUTS.inconnu);

  return (
    <div className="space-y-5">
      {/* ---------------- Identité et situation ---------------- */}
      <section className="rounded-xl border border-bordure bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold text-encre">
              {redevable.designation}
            </p>
            <p className="text-[13px] text-encre-attenuee">{redevable.code}</p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${statut.classe}`}>
            {statut.texte}
          </span>
        </div>

        {/* La réponse à la question qu'il se pose, en gros, sans défilement. */}
        {echeance ? (
          <div className="mt-4 rounded-lg bg-surface-alt p-3">
            <p className="text-[13px] text-encre-2">À payer</p>
            <p className="text-[28px] font-bold leading-tight text-encre">
              {xof(echeance.montant)}
            </p>
            <p className="mt-0.5 text-[13px] text-encre-2">
              Échéance du {dateCourte(echeance.date)} · avis {echeance.numero}
            </p>
          </div>
        ) : (
          <div className="mt-4 rounded-lg bg-surface-alt p-3">
            <p className="text-[15px] font-semibold text-encre">Rien à payer actuellement</p>
            <p className="mt-0.5 text-[13px] text-encre-2">
              Vous serez averti par SMS à la prochaine échéance.
            </p>
          </div>
        )}
      </section>

      {/* ---------------- Ce qui est taxé ---------------- */}
      <section className="rounded-xl border border-bordure bg-surface p-4">
        <h2 className="mb-3 text-[15px] font-semibold text-encre">
          Ce qui vous est rattaché
        </h2>
        {/* La route du portail renvoie objet_type, objet_code, objet_libelle —
        PAS objet_id. La clé valait donc « undefined » sur CHAQUE ligne, et
        React le signalait dans la console du navigateur du commerçant.
        Le couple (type, code) identifie un objet taxable sans ambiguïté. */}
        <ul className="space-y-2">
          {objets.map((o) => (
            <li key={`${o.objet_type}-${o.objet_code}`} className="flex items-start gap-3 border-b border-bordure pb-2 last:border-0 last:pb-0">
              <span className="mt-0.5 shrink-0 rounded bg-surface-alt px-1.5 py-0.5 text-[11px] font-medium text-encre-2">
                {libelleFamille(o.objet_type)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-encre">{o.objet_libelle}</p>
                <p className="text-[12px] text-encre-attenuee">
                  {o.objet_code}
                  {o.precision ? ` · ${o.precision}` : ''}
                </p>
              </div>
            </li>
          ))}
          {objets.length === 0 ? (
            <li className="text-[14px] text-encre-attenuee">Aucun objet enregistré.</li>
          ) : null}
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-encre-attenuee">
          Un élément vous est rattaché à tort ? Signalez-le ci-dessous : une
          erreur de rattachement se corrige, elle ne se paie pas.
        </p>
      </section>

      {/* ---------------- Factures ---------------- */}
      <section className="rounded-xl border border-bordure bg-surface p-4">
        <h2 className="mb-3 text-[15px] font-semibold text-encre">Mes factures</h2>

        {avis.length === 0 ? (
          <p className="text-[14px] text-encre-attenuee">Aucune facture émise à ce jour.</p>
        ) : (
          <ul className="space-y-2">
            {avis.map((a) => (
              <li key={a.id} className="rounded-lg border border-bordure">
                <button
                  type="button"
                  onClick={() => ouvrirAvis(a.id)}
                  aria-expanded={avisOuvert === a.id}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                >
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-encre">{a.periode}</p>
                    <p className="text-[12px] text-encre-attenuee">
                      Échéance {dateCourte(a.date_exigibilite)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[14px] font-semibold text-encre">{xof(a.montant_total)}</p>
                    {Number(a.montant_restant) > 0 ? (
                      <p className="text-[12px] text-st-impaye">
                        reste {xof(a.montant_restant)}
                      </p>
                    ) : (
                      <p className="text-[12px] text-st-ajour">payé</p>
                    )}
                  </div>
                </button>

                {avisOuvert === a.id ? (
                  <div className="border-t border-bordure px-3 py-2.5">
                    {!detail ? (
                      <p className="text-[13px] text-encre-attenuee">Chargement du détail…</p>
                    ) : (
                      <>
                        <ul className="space-y-1.5">
                          {detail.lignes.map((l, i) => (
                            <li key={`${l.objet_code}-${i}`} className="flex justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-[13px] text-encre">{l.libelle}</p>
                                <p className="text-[12px] text-encre-attenuee">
                                  {expliquer(l)}
                                </p>
                              </div>
                              <p className="shrink-0 text-[13px] text-encre">{xof(l.montant)}</p>
                            </li>
                          ))}
                        </ul>
                        {Number(detail.report_anterieur) > 0 ? (
                          <p className="mt-2 flex justify-between text-[13px] text-encre-2">
                            <span>Reste dû des mois précédents</span>
                            <span>{xof(detail.report_anterieur)}</span>
                          </p>
                        ) : null}
                        {Number(detail.montant_penalite) > 0 ? (
                          <p className="mt-1 flex justify-between text-[13px] text-st-partiel">
                            <span>Pénalité de retard</span>
                            <span>{xof(detail.montant_penalite)}</span>
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Contestation avis={avis} />

      <button
        type="button"
        onClick={seDeconnecter}
        className="w-full rounded-lg border border-bordure px-4 py-2.5 text-[14px] text-encre-2"
      >
        Se déconnecter
      </button>

      <p className="text-center text-[12px] text-encre-attenuee">
        Votre session se ferme automatiquement après quelques heures.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function libelleFamille(type) {
  return { commerce: 'Commerce', affichage: 'Affichage', chantier: 'Chantier' }[type] ?? type;
}

/**
 * Explique une ligne dans les termes de l'agent, pas ceux de la base.
 * « 2,4 m² × 800 F » est vérifiable au décamètre ; « base_calcul: 2.4 » ne
 * l'est pas.
 */
function expliquer(ligne) {
  const morceaux = [];
  if (ligne.objet_code) morceaux.push(ligne.objet_code);
  if (ligne.base_calcul && ligne.montant_unitaire) {
    morceaux.push(`${FORMAT.format(ligne.base_calcul)} ${ligne.unite ?? ''} × ${FORMAT.format(ligne.montant_unitaire)} F`.trim());
  }
  if (Number(ligne.montant_exonere) > 0) {
    morceaux.push(`exonération ${xof(ligne.montant_exonere)}`);
  }
  return morceaux.join(' · ');
}

// ---------------------------------------------------------------------------

function Contestation({ avis }) {
  const [ouvert, setOuvert] = useState(false);
  const [motifs, setMotifs] = useState([]);
  const [motifId, setMotifId] = useState('');
  const [avisId, setAvisId] = useState('');
  const [description, setDescription] = useState('');
  const [envoye, setEnvoye] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    if (!ouvert || motifs.length > 0) return;
    appel('motifs-contestation').then((r) => {
      if (r.statut === 200) setMotifs(r.donnees);
    });
  }, [ouvert, motifs.length]);

  const envoyer = async (e) => {
    e.preventDefault();
    setErreur(null);
    setOccupe(true);
    try {
      const r = await appel('contestations', {
        motif_id: motifId,
        description,
        ...(avisId ? { avis_id: avisId } : {}),
      });
      if (r.statut !== 201) {
        setErreur(r.json?.erreur?.message ?? 'Envoi impossible.');
        return;
      }
      setEnvoye(r.donnees);
    } finally {
      setOccupe(false);
    }
  };

  if (envoye) {
    return (
      <section className="rounded-xl border-l-[3px] border-st-ajour bg-surface p-4">
        <p className="text-[15px] font-semibold text-encre">Contestation enregistrée</p>
        <p className="mt-1 text-[13px] leading-relaxed text-encre-2">
          Référence {envoye.numero}. La mairie doit statuer avant le{' '}
          {dateCourte(envoye.date_limite)}. Vous serez informé de la décision,
          qu&apos;elle vous donne raison ou non.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-encre-2">
          {envoye.message}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-bordure bg-surface p-4">
      <button
        type="button"
        onClick={() => setOuvert((o) => !o)}
        aria-expanded={ouvert}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[15px] font-semibold text-encre">Contester un montant</span>
        <span className="text-[13px] text-encre-attenuee">{ouvert ? 'Fermer' : 'Ouvrir'}</span>
      </button>

      {ouvert ? (
        <form onSubmit={envoyer} className="mt-3 space-y-3">
          <div>
            <label htmlFor="motif" className="mb-1 block text-[13px] font-medium text-encre">
              Motif
            </label>
            <select
              id="motif"
              required
              value={motifId}
              onChange={(e) => setMotifId(e.target.value)}
              className="w-full rounded-lg border border-bordure bg-surface px-3 py-2.5 text-[14px] text-encre"
            >
              <option value="">Choisissez…</option>
              {motifs.map((m) => (
                <option key={m.id} value={m.id}>{m.libelle}</option>
              ))}
            </select>
          </div>

          {avis.length > 0 ? (
            <div>
              <label htmlFor="avis" className="mb-1 block text-[13px] font-medium text-encre">
                Facture concernée
              </label>
              <select
                id="avis"
                value={avisId}
                onChange={(e) => setAvisId(e.target.value)}
                className="w-full rounded-lg border border-bordure bg-surface px-3 py-2.5 text-[14px] text-encre"
              >
                <option value="">Aucune en particulier</option>
                {avis.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.periode} — {xof(a.montant_total)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label htmlFor="desc" className="mb-1 block text-[13px] font-medium text-encre">
              Expliquez en quelques mots
            </label>
            <textarea
              id="desc"
              required
              minLength={10}
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mon commerce est fermé depuis mars, je ne tiens plus d'activité à cette adresse."
              className="w-full rounded-lg border border-bordure bg-surface px-3 py-2.5 text-[14px] text-encre"
            />
          </div>

          {erreur ? (
            <p className="rounded-lg border-l-[3px] border-st-impaye bg-surface-alt px-3 py-2 text-[13px] text-encre">
              {erreur}
            </p>
          ) : null}

          <p className="text-[12px] leading-relaxed text-encre-attenuee">
            Déposer une contestation ne suspend pas le paiement. Si elle est
            acceptée, votre dossier sera corrigé et le trop-perçu déduit.
          </p>

          <button
            type="submit"
            disabled={occupe || !motifId || description.trim().length < 10}
            className="w-full rounded-lg bg-marque px-4 py-2.5 text-[15px] font-semibold text-white disabled:opacity-50"
          >
            {occupe ? 'Envoi…' : 'Envoyer'}
          </button>
        </form>
      ) : null}
    </section>
  );
}
