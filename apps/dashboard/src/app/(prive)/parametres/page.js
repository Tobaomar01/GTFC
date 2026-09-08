'use client';

/**
 * Paramètres : barèmes, données provisoires, impression des stickers,
 * changement de mot de passe.
 *
 * La liste des DONNÉES PROVISOIRES est en tête et volontairement voyante :
 * tant qu'elle n'est pas vide, aucun avis ne doit partir à un commerçant.
 */
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { xof, nombre, date } from '@/lib/format';
import { Carte, Bouton, Champ, Chargement, Message, Tableau, Selection } from '@/composants/ui';

function Contenu() {
  const params = useSearchParams();
  const [donnees, setDonnees] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [zoneSticker, setZoneSticker] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [types, baremes, provisoires, coherence, zones] = await Promise.all([
          api.get('/taxes/types'),
          api.get('/taxes/baremes'),
          api.get('/stats/donnees-a-remplacer').catch(() => []),
          api.get('/stats/coherence').catch(() => null),
          api.get('/zones'),
        ]);
        setDonnees({ types, baremes, provisoires, coherence, zones });
      } catch (err) { setErreur(err.message); }
    })();
  }, []);

  if (erreur) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!donnees) return <Chargement />;

  const { types, baremes, provisoires, coherence, zones } = donnees;
  const sansBareme = types.filter((t) => t.actif && !t.bareme_en_vigueur);

  return (
    <div className="space-y-5">
      {params.get('changer_mot_de_passe') && (
        <Message type="info" titre="Choisissez votre mot de passe">
          Le mot de passe qui vous a été communiqué est provisoire. Changez-le
          ci-dessous avant de continuer.
        </Message>
      )}

      {provisoires.length > 0 && (
        <Carte
          titre={`${nombre(provisoires.length)} données encore provisoires`}
          sousTitre="À remplacer par les délibérations de la mairie avant toute émission réelle"
        >
          <Message type="avertissement" titre="Ne pas émettre d'avis en l'état">
            Les montants ci-dessous sont des valeurs d'attente. La chaîne calcule
            correctement — sur des tarifs qui ne sont pas ceux de la commune.
            Une quittance fausse engage la mairie.
          </Message>
          <div className="mt-3">
            <Tableau compact cle={(l) => `${l.entite}/${l.libelle}`} lignes={provisoires.slice(0, 60)}
              colonnes={[
                { cle: 'entite', titre: 'Type' },
                { cle: 'libelle', titre: 'Libellé' },
                { cle: 'a_faire', titre: 'À faire' },
                {
                  cle: 'montant',
                  titre: 'Montant',
                  alignement: 'droite',
                  rendu: (l) => (l.montant ? xof(l.montant) : '—'),
                },
              ]} />
          </div>
          {provisoires.length > 60 && (
            <p className="mt-2 text-[13px] text-encre-attenuee">
              60 premières affichées sur {nombre(provisoires.length)}.
            </p>
          )}
        </Carte>
      )}

      {sansBareme.length > 0 && (
        <Message type="erreur" titre={`${sansBareme.length} taxe(s) sans barème en vigueur`}>
          {sansBareme.map((t) => t.libelle_court).join(', ')} — la génération des
          avis échouera pour les commerces concernés.
        </Message>
      )}

      {coherence?.controles?.length > 0 && (
        <Carte titre="Contrôles de cohérence">
          <Tableau compact cle="controle" lignes={coherence.controles}
            colonnes={[
              {
                cle: 'gravite',
                titre: '',
                rendu: (l) => (
                  <span style={{ color: l.gravite === 'erreur' ? 'var(--st-impaye)' : 'var(--st-partiel)' }}>
                    {l.gravite === 'erreur' ? '!' : '·'}
                  </span>
                ),
              },
              { cle: 'controle', titre: 'Contrôle' },
              { cle: 'nb', titre: 'Nombre', alignement: 'droite' },
              { cle: 'detail', titre: 'Conséquence' },
            ]} />
        </Carte>
      )}

      <Carte titre="Barèmes"
        sousTitre="Un tarif ne se modifie jamais : il se clôt, et un nouveau prend le relais"
      >
        <Tableau cle="id" lignes={baremes}
          colonnes={[
            { cle: 'taxe', titre: 'Taxe' },
            { cle: 'libelle', titre: 'Barème' },
            { cle: 'mode_calcul', titre: 'Mode' },
            {
              cle: 'montant_fixe',
              titre: 'Montant',
              alignement: 'droite',
              rendu: (l) => {
                if (l.montant_fixe) return xof(l.montant_fixe);
                if (l.montant_unitaire) return `${xof(l.montant_unitaire)} / ${l.unite ?? ''}`;
                return `${l.nb_tranches} tranches`;
              },
            },
            { cle: 'date_effet', titre: "Date d'effet", rendu: (l) => date(l.date_effet) },
            {
              cle: 'en_vigueur',
              titre: 'État',
              rendu: (l) => (l.en_vigueur
                ? <span style={{ color: 'var(--st-ajour)', fontWeight: 600 }}>En vigueur</span>
                : 'Clos'),
            },
            {
              cle: 'a_remplacer',
              titre: 'Provisoire',
              rendu: (l) => (l.a_remplacer
                ? <span style={{ color: 'var(--st-partiel)', fontWeight: 600 }}>À remplacer</span>
                : '—'),
            },
          ]} />
        <p className="mt-3 text-[13px] text-encre-attenuee">
          La création d&apos;un barème se fait par l&apos;API
          (<span className="font-mono">POST /taxes/baremes</span>) avec la
          référence de la délibération. Une contrainte de la base interdit deux
          tarifs concurrents sur la même période.
        </p>
      </Carte>

      <Carte titre="Stickers QR à imprimer"
        sousTitre="Planches A4 de 4 stickers A6, avec traits de découpe"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Selection etiquette="Zone" valeur={zoneSticker} onChange={setZoneSticker}
              options={zones.map((z) => ({ valeur: z.id, libelle: z.nom }))}
              aucun="Toutes les zones" />
          </div>
          <Bouton
            onClick={() => api.ouvrirPdf('/impression/stickers/planche',
              { numero: 1, zone_id: zoneSticker, sans_sticker: true })}
          >
            Première planche non imprimée
          </Bouton>
        </div>
        <p className="mt-3 text-[13px] text-encre-attenuee">
          Testez l&apos;alignement sur du papier ordinaire avant d&apos;engager le
          papier autocollant. Les commerces déjà imprimés sont exclus par défaut.
        </p>
      </Carte>

      <ChangementMotDePasse />
    </div>
  );
}

function ChangementMotDePasse() {
  const [ancien, setAncien] = useState('');
  const [nouveau, setNouveau] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [etat, setEtat] = useState(null);
  const [occupe, setOccupe] = useState(false);

  const regles = [
    { texte: 'Au moins 10 caractères', ok: nouveau.length >= 10 },
    { texte: 'Une majuscule', ok: /[A-Z]/.test(nouveau) },
    { texte: 'Une minuscule', ok: /[a-z]/.test(nouveau) },
    { texte: 'Un chiffre', ok: /[0-9]/.test(nouveau) },
  ];
  const valide = regles.every((r) => r.ok) && nouveau === confirmation;

  const soumettre = async (e) => {
    e.preventDefault();
    setOccupe(true); setEtat(null);
    try {
      await api.post('/auth/mot-de-passe', {
        ancien_mot_de_passe: ancien, nouveau_mot_de_passe: nouveau,
      });
      setEtat({ type: 'succes', texte: 'Mot de passe modifié. Vos autres sessions ont été fermées.' });
      setAncien(''); setNouveau(''); setConfirmation('');
    } catch (err) {
      setEtat({ type: 'erreur', texte: err.message });
    } finally { setOccupe(false); }
  };

  return (
    <Carte titre="Changer mon mot de passe">
      <form onSubmit={soumettre} className="max-w-md space-y-3">
        <Champ etiquette="Mot de passe actuel" type="password" value={ancien}
          onChange={(e) => setAncien(e.target.value)} autoComplete="current-password" required />
        <Champ etiquette="Nouveau mot de passe" type="password" value={nouveau}
          onChange={(e) => setNouveau(e.target.value)} autoComplete="new-password" required />

        <ul className="space-y-0.5">
          {regles.map((r) => (
            <li key={r.texte} className="text-[13px]"
              style={{ color: r.ok ? 'var(--st-ajour)' : 'var(--encre-attenuee)' }}>
              {r.ok ? '✓' : '○'} {r.texte}
            </li>
          ))}
        </ul>

        <Champ etiquette="Confirmer" type="password" value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" required
          erreur={confirmation && nouveau !== confirmation ? 'Les deux saisies diffèrent' : null} />

        {etat && <Message type={etat.type}>{etat.texte}</Message>}

        <Bouton type="submit" variante="primaire" charge={occupe} desactive={!valide}>
          Enregistrer
        </Bouton>
      </form>
    </Carte>
  );
}

export default function PageParametres() {
  return (
    <Suspense fallback={<Chargement />}>
      <Contenu />
    </Suspense>
  );
}
