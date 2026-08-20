/**
 * Connexion et déconnexion — les seules routes qui posent ou effacent des
 * cookies de session.
 *
 * Le mot de passe transite du navigateur au serveur Next.js (même origine,
 * HTTPS), puis du serveur à l'API en local. Il ne quitte jamais la machine.
 */
import { NextResponse } from 'next/server';
import { poserSession, effacerSession, lireJetons, URL_API } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(requete) {
  const corps = await requete.json().catch(() => null);
  if (!corps?.telephone || !corps?.mot_de_passe) {
    return NextResponse.json(
      { succes: false, erreur: { message: 'Numéro de téléphone et mot de passe requis' } },
      { status: 400 },
    );
  }

  let reponse;
  try {
    reponse = await fetch(`${URL_API}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // L'API journalise l'adresse réelle dans audit.connexion : sans cet
        // en-tête, toutes les connexions viendraient de 127.0.0.1.
        'X-Forwarded-For': requete.headers.get('x-forwarded-for')
          ?? requete.headers.get('x-real-ip') ?? '',
        'User-Agent': requete.headers.get('user-agent') ?? 'dashboard',
      },
      body: JSON.stringify({
        telephone: corps.telephone,
        mot_de_passe: corps.mot_de_passe,
        appareil_modele: 'Tableau de bord web',
      }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { succes: false, erreur: { message: 'Le serveur ne répond pas. Vérifiez que l\'API est démarrée.' } },
      { status: 503 },
    );
  }

  const resultat = await reponse.json().catch(() => null);

  if (!reponse.ok) {
    return NextResponse.json(
      { succes: false, erreur: resultat?.erreur ?? { message: 'Connexion refusée' } },
      { status: reponse.status },
    );
  }

  await poserSession(resultat.donnees);

  // On ne renvoie AUCUN jeton au navigateur — seulement de quoi afficher.
  return NextResponse.json({
    succes: true,
    donnees: {
      utilisateur: resultat.donnees.utilisateur,
      doit_changer_mot_de_passe: resultat.donnees.doit_changer_mot_de_passe,
    },
  });
}

export async function DELETE() {
  const { rafraichissement } = await lireJetons();

  // On révoque côté API avant d'effacer les cookies : sans cela, le jeton
  // resterait valable 30 jours pour qui l'aurait intercepté.
  if (rafraichissement) {
    await fetch(`${URL_API}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jeton_rafraichissement: rafraichissement }),
      cache: 'no-store',
    }).catch(() => null);
  }

  await effacerSession();
  return NextResponse.json({ succes: true });
}
