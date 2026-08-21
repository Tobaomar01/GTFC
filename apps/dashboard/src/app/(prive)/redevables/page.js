'use client';

/**
 * Redevables — la page qui remplace « Commerces » comme point d'entrée.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  DEUX ALERTES QUI VALENT PLUS QUE LA LISTE
 *
 *  1. LES NUMÉROS NON VÉRIFIÉS. Un redevable dont le numéro n'a jamais été
 *     confirmé par un code est INJOIGNABLE : ni lien de paiement, ni accès à
 *     son dossier. La mairie ne s'en apercevra qu'à l'échéance, quand les
 *     SMS partiront dans le vide. Le compteur est donc en haut de page, pas
 *     dans un filtre qu'il faut penser à cocher.
 *
 *  2. LES OBJETS SANS REDEVABLE. Un panneau publicitaire relevé dans la rue
 *     dont l'exploitant reste à identifier n'est facturé à personne. Recensé,
 *     invisible, gratuit — exactement ce que le recensement devait éviter.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { xof, date as formaterDate } from '@/lib/format';
import {
  Carte, Bouton, Champ, Selection, Tableau, Chargement, Message, BadgeStatut, EtatVide,
} from '@/composants/ui';

export default function PageRedevables() {
  const [liste, setListe] = useState(null);
  const [orphelins, setOrphelins] = useState([]);
  const [recherche, setRecherche] = useState('');
  const [filtreTel, setFiltreTel] = useState('');
  const [filtreStatut, setFiltreStatut] = useState('');
  const [choisi, setChoisi] = useState(null);
  const [erreur, setErreur] = useState(null);

  const charger = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limite: '100' });
      if (recherche) params.set('q', recherche);
      if (filtreTel) params.set('telephone_verifie', filtreTel);
      if (filtreStatut) params.set('statut_fiscal', filtreStatut);

      const [r, o] = await Promise.all([
        api.get(`/redevables?${params}`),
        api.get('/objets-sans-redevable').catch(() => ({ donnees: [] })),
      ]);
      setListe(r.donnees ?? []);
      setOrphelins(o.donnees ?? []);
    } catch (e) {
      setErreur(e.message);
    }
  }, [recherche, filtreTel, filtreStatut]);

  useEffect(() => {
    const t = setTimeout(charger, recherche ? 300 : 0);
    return () => clearTimeout(t);
  }, [charger, recherche]);

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!liste) return <Chargement />;

  const nonVerifies = liste.filter((r) => r.statut_telephone !== 'verifie').length;

  return (
    <div className="space-y-4">
      {/* ---------------- Ce qui empêchera d'encaisser ---------------- */}
      {nonVerifies > 0 || orphelins.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {nonVerifies > 0 ? (
            <Alerte
              nombre={nonVerifies}
              titre="numéro(s) non vérifié(s)"
              explication={'Ces redevables ne recevront ni lien de paiement ni code d\'accès. '
                + 'Un agent doit confirmer leur numéro sur le terrain.'}
              action={() => setFiltreTel('non')}
              libelleAction="Voir la liste"
            />
          ) : null}
          {orphelins.length > 0 ? (
            <Alerte
              nombre={orphelins.length}
              titre="objet(s) sans redevable"
              explication={'Panneaux ou chantiers recensés dont le propriétaire reste à '
                + 'identifier. Ils ne sont facturés à personne.'}
              action={() => setChoisi({ type: 'orphelins' })}
              libelleAction="Traiter"
            />
          ) : null}
        </div>
      ) : null}

      {/* ---------------- Recherche ---------------- */}
      <Carte>
        <div className="grid gap-3 sm:grid-cols-3">
          <Champ
            etiquette="Rechercher"
            placeholder="Nom, téléphone, code…"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
          />
          <Selection
            etiquette="Numéro vérifié"
            valeur={filtreTel}
            onChange={setFiltreTel}
            aucun="Tous"
            options={[{ valeur: 'oui', libelle: 'Vérifié' }, { valeur: 'non', libelle: 'Non vérifié' }]}
          />
          <Selection
            etiquette="Situation"
            valeur={filtreStatut}
            onChange={setFiltreStatut}
            aucun="Toutes"
            options={[
              { valeur: 'a_jour', libelle: 'À jour' },
              { valeur: 'partiel', libelle: 'Paiement partiel' },
              { valeur: 'impaye', libelle: 'En retard' },
              { valeur: 'exonere', libelle: 'Exonéré' },
            ]}
          />
        </div>
      </Carte>

      {choisi?.type === 'orphelins' ? (
        <ObjetsOrphelins objets={orphelins} onFerme={() => setChoisi(null)} onMaj={charger} />
      ) : null}

      {/* ---------------- Liste ---------------- */}
      <Carte titre={`${liste.length} redevable(s)`}>
        <Tableau
          cle="id"
          lignes={liste}
          vide="Aucun redevable ne correspond."
          colonnes={[
            { cle: 'code', titre: 'Code', rendu: (r) => (
              <span className="font-mono text-[13px]">{r.code}</span>
            ) },
            { cle: 'designation', titre: 'Désignation', rendu: (r) => (
              <div>
                <p className="font-medium text-encre">{r.designation}</p>
                <p className="text-[12px] text-encre-attenuee">
                  {r.type_redevable === 'personne_morale' ? 'Personne morale' : 'Personne physique'}
                  {r.quartier ? ` · ${r.quartier}` : ''}
                </p>
              </div>
            ) },
            { cle: 'telephone', titre: 'Téléphone', rendu: (r) => (
              <div>
                <p className="text-[13px] text-encre">{r.telephone ?? '—'}</p>
                {r.statut_telephone !== 'verifie' ? (
                  // Le libellé porte l'information, pas seulement la couleur :
                  // un daltonien doit lire l'alerte, pas la deviner.
                  <p className="text-[12px] font-medium text-st-impaye">non vérifié</p>
                ) : null}
              </div>
            ) },
            { cle: 'nb_objets_taxables', titre: 'Objets', rendu: (r) => r.nb_objets_taxables },
            { cle: 'statut_fiscal', titre: 'Situation', rendu: (r) => (
              <BadgeStatut statut={r.statut_fiscal} compact />
            ) },
            { cle: 'solde_du', titre: 'Solde', rendu: (r) => (
              Number(r.solde_du) > 0
                ? <span className="font-medium text-st-impaye">{xof(r.solde_du)}</span>
                : <span className="text-encre-attenuee">—</span>
            ) },
            { cle: 'actions', titre: '', rendu: (r) => (
              <Bouton variante="discret" onClick={() => setChoisi({ type: 'fiche', id: r.id })}>
                Ouvrir
              </Bouton>
            ) },
          ]}
        />
      </Carte>

      {choisi?.type === 'fiche' ? (
        <FicheRedevable id={choisi.id} onFerme={() => setChoisi(null)} onMaj={charger} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Alerte({ nombre, titre, explication, action, libelleAction }) {
  return (
    <div className="rounded-xl border border-bordure border-l-[3px] border-l-st-partiel bg-surface p-4">
      <p className="text-[15px] font-semibold text-encre">
        {nombre} {titre}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-encre-2">{explication}</p>
      <button
        type="button"
        onClick={action}
        className="mt-2 text-[13px] font-medium text-marque underline underline-offset-2"
      >
        {libelleAction}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FicheRedevable({ id, onFerme, onMaj }) {
  const [fiche, setFiche] = useState(null);
  const [message, setMessage] = useState(null);

  const charger = useCallback(async () => {
    const r = await api.get(`/redevables/${id}`);
    setFiche(r.donnees);
  }, [id]);

  useEffect(() => { charger(); }, [charger]);

  const envoyerCode = async () => {
    try {
      const r = await api.post(`/redevables/${id}/telephone/code`);
      setMessage(r.donnees?.code_simule
        ? `Code envoyé. Aucun opérateur SMS raccordé — code de démonstration : ${r.donnees.code_simule}`
        : 'Code envoyé. Demandez au redevable de vous le lire.');
    } catch (e) {
      setMessage(e.message);
    }
  };

  if (!fiche) return <Carte><Chargement /></Carte>;

  return (
    <Carte
      titre={fiche.designation}
      sousTitre={`${fiche.code} · ${fiche.telephone ?? 'sans téléphone'}`}
      actions={<Bouton variante="discret" onClick={onFerme}>Fermer</Bouton>}
    >
      {fiche.statut_telephone !== 'verifie' ? (
        <Message type="avertissement" titre="Numéro non vérifié">
          <p>
            Ce redevable ne recevra ni lien de paiement ni code d&apos;accès au
            portail tant que son numéro n&apos;a pas été confirmé.
          </p>
          <div className="mt-2">
            <Bouton onClick={envoyerCode}>Envoyer un code de vérification</Bouton>
          </div>
        </Message>
      ) : null}

      {message ? <Message type="info">{message}</Message> : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section>
          <h3 className="mb-2 text-[14px] font-semibold text-encre">Objets taxables</h3>
          <ul className="space-y-1.5">
            {fiche.objets.map((o) => (
              <li key={o.objet_id} className="text-[13px]">
                <span className="mr-2 rounded bg-surface-alt px-1.5 py-0.5 text-[11px] text-encre-2">
                  {o.objet_type}
                </span>
                <span className="text-encre">{o.objet_libelle}</span>
                <span className="text-encre-attenuee"> · {o.objet_code}</span>
              </li>
            ))}
            {fiche.objets.length === 0 ? (
              <li className="text-[13px] text-encre-attenuee">Aucun objet.</li>
            ) : null}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-[14px] font-semibold text-encre">Dernières factures</h3>
          <ul className="space-y-1.5">
            {fiche.avis.slice(0, 6).map((a) => (
              <li key={a.id} className="flex justify-between text-[13px]">
                <span className="text-encre">{a.periode}</span>
                <span className={Number(a.montant_restant) > 0 ? 'text-st-impaye' : 'text-encre-attenuee'}>
                  {xof(a.montant_total)}
                </span>
              </li>
            ))}
            {fiche.avis.length === 0 ? (
              <li className="text-[13px] text-encre-attenuee">Aucune facture émise.</li>
            ) : null}
          </ul>
        </section>
      </div>

      {fiche.contestations.length > 0 ? (
        <section className="mt-4">
          <h3 className="mb-2 text-[14px] font-semibold text-encre">Contestations</h3>
          <ul className="space-y-1.5">
            {fiche.contestations.map((c) => (
              <li key={c.id} className="text-[13px]">
                <span className="font-mono text-encre-2">{c.numero}</span>
                <span className="text-encre"> · {c.motif}</span>
                <span className="text-encre-attenuee"> · {c.statut}</span>
                <span className="text-encre-attenuee"> · {formaterDate(c.cree_le)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Carte>
  );
}

// ---------------------------------------------------------------------------

function ObjetsOrphelins({ objets, onFerme, onMaj }) {
  const [recherche, setRecherche] = useState('');
  const [candidats, setCandidats] = useState([]);
  const [cible, setCible] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (recherche.length < 2) { setCandidats([]); return undefined; }
    const t = setTimeout(async () => {
      const r = await api.get(`/redevables?limite=8&q=${encodeURIComponent(recherche)}`);
      setCandidats(r.donnees ?? []);
    }, 300);
    return () => clearTimeout(t);
  }, [recherche]);

  const rattacher = async (redevableId) => {
    const chemin = cible.objet_type === 'affichage'
      ? `/affichages/${cible.objet_id}/redevable`
      : `/chantiers/${cible.objet_id}/redevable`;
    try {
      await api.post(chemin, { redevable_id: redevableId });
      setMessage(`${cible.code} rattaché.`);
      setCible(null);
      setRecherche('');
      onMaj();
    } catch (e) {
      setMessage(e.message);
    }
  };

  return (
    <Carte
      titre="Objets sans redevable"
      sousTitre="Recensés sur le terrain, propriétaire à identifier"
      actions={<Bouton variante="discret" onClick={onFerme}>Fermer</Bouton>}
    >
      {message ? <Message type="info">{message}</Message> : null}

      {objets.length === 0 ? (
        <EtatVide titre="Rien à traiter" texte="Tous les objets recensés ont un redevable." />
      ) : (
        <Tableau
          cle="objet_id"
          lignes={objets}
          colonnes={[
            { cle: 'code', titre: 'Code', rendu: (o) => (
              <span className="font-mono text-[13px]">{o.code}</span>
            ) },
            { cle: 'libelle', titre: 'Objet', rendu: (o) => (
              <div>
                <p className="text-encre">{o.libelle}</p>
                <p className="text-[12px] text-encre-attenuee">
                  {o.type_libelle} · {o.surface_m2} m²
                </p>
              </div>
            ) },
            { cle: 'rue', titre: 'Où', rendu: (o) => (
              <div className="text-[13px]">
                <p className="text-encre">{o.rue ?? o.quartier ?? '—'}</p>
                {o.adresse_libelle ? (
                  <p className="text-[12px] text-encre-attenuee">{o.adresse_libelle}</p>
                ) : null}
              </div>
            ) },
            { cle: 'recense_par', titre: 'Recensé par', rendu: (o) => (
              <div className="text-[13px]">
                <p className="text-encre">{o.recense_par ?? '—'}</p>
                <p className="text-[12px] text-encre-attenuee">{formaterDate(o.date_constat)}</p>
              </div>
            ) },
            { cle: 'actions', titre: '', rendu: (o) => (
              <Bouton variante="discret" onClick={() => setCible(o)}>Rattacher</Bouton>
            ) },
          ]}
        />
      )}

      {cible ? (
        <div className="mt-4 rounded-lg border border-bordure p-3">
          <p className="text-[14px] font-medium text-encre">
            Rattacher {cible.code} — {cible.libelle}
          </p>
          <div className="mt-2">
            <Champ
              etiquette="Chercher le redevable"
              placeholder="Nom, raison sociale, téléphone…"
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
            />
          </div>
          <ul className="mt-2 space-y-1">
            {candidats.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => rattacher(c.id)}
                  className="w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-surface-alt"
                >
                  <span className="font-medium text-encre">{c.designation}</span>
                  <span className="text-encre-attenuee"> · {c.code} · {c.telephone ?? 'sans tél.'}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-encre-attenuee">
            Le redevable n&apos;existe pas encore ? Créez-le d&apos;abord, puis revenez ici.
          </p>
        </div>
      ) : null}
    </Carte>
  );
}
