'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bouton, Champ, Message } from '@/composants/ui';

function Formulaire() {
  const router = useRouter();
  const params = useSearchParams();
  const [telephone, setTelephone] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [visible, setVisible] = useState(false);
  const [erreur, setErreur] = useState(null);
  const [charge, setCharge] = useState(false);
  const [commune, setCommune] = useState(null);

  // Identité de la mairie, d'après le sous-domaine : gtfc.domaine.sn affiche
  // « Gueule Tapée-Fass-Colobane » avant même la connexion.
  useEffect(() => {
    const sous = window.location.hostname.split('.')[0];
    if (!sous || ['www', 'localhost', '127'].includes(sous)) return;
    fetch(`/api/proxy/public/commune/${sous}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.donnees && setCommune(j.donnees))
      .catch(() => {});
  }, []);

  const soumettre = async (e) => {
    e.preventDefault();
    setErreur(null);

    const numero = telephone.replace(/[\s.-]/g, '');
    if (!/^\+?[0-9]{8,15}$/.test(numero)) {
      setErreur('Numéro de téléphone invalide. Exemple : +221771234567');
      return;
    }

    setCharge(true);
    try {
      const reponse = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telephone: numero, mot_de_passe: motDePasse }),
      });
      const resultat = await reponse.json();

      if (!reponse.ok) {
        setErreur(resultat?.erreur?.message ?? 'Connexion refusée');
        return;
      }

      // Le dashboard est réservé à la mairie : un agent de terrain a
      // l'application Android, et n'a rien à faire ici.
      if (resultat.donnees.utilisateur.role === 'agent') {
        await fetch('/api/session', { method: 'DELETE' });
        setErreur(
          'Ce tableau de bord est réservé aux superviseurs et aux administrateurs. '
          + 'Les agents de terrain utilisent l\'application Android.',
        );
        return;
      }

      router.replace(resultat.donnees.doit_changer_mot_de_passe
        ? '/parametres?changer_mot_de_passe=1'
        : '/tableau-bord');
      router.refresh();
    } catch {
      setErreur('Le serveur ne répond pas. Réessayez dans un instant.');
    } finally {
      setCharge(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-marque text-2xl font-bold text-white">
            {commune?.code?.slice(0, 2) ?? 'GT'}
          </div>
          <h1 className="text-xl font-bold text-encre">
            {commune?.nom ?? 'Collecte des taxes locales'}
          </h1>
          <p className="mt-1 text-sm text-encre-2">Tableau de bord de la commune</p>
        </div>

        <form onSubmit={soumettre}
          className="space-y-4 rounded-carte border border-bordure bg-surface p-6 shadow-carte"
        >
          {params.get('expiree') && (
            <Message type="avertissement">
              Votre session a expiré. Reconnectez-vous.
            </Message>
          )}

          <Champ
            etiquette="Numéro de téléphone"
            value={telephone}
            onChange={(e) => setTelephone(e.target.value)}
            placeholder="+221 77 123 45 67"
            type="tel"
            autoComplete="username"
            required
          />

          <div>
            <Champ
              etiquette="Mot de passe"
              value={motDePasse}
              onChange={(e) => setMotDePasse(e.target.value)}
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              required
            />
            <button type="button" onClick={() => setVisible((v) => !v)}
              className="mt-1 text-[13px] text-encre-2 underline underline-offset-2"
            >
              {visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
            </button>
          </div>

          {erreur && <Message type="erreur">{erreur}</Message>}

          <Bouton type="submit" variante="primaire" charge={charge}>
            Se connecter
          </Bouton>

          <p className="pt-2 text-center text-[13px] text-encre-attenuee">
            Mot de passe oublié ou compte bloqué ? Contactez l'administrateur de
            la commune : lui seul peut réinitialiser un accès.
          </p>
        </form>
      </div>
    </main>
  );
}

export default function PageConnexion() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-encre-2">Chargement…</div>}>
      <Formulaire />
    </Suspense>
  );
}
