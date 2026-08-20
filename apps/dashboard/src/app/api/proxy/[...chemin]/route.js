/**
 * Mandataire vers l'API.
 *
 * Toute requête de l'interface passe ici. Le navigateur envoie
 * `/api/proxy/commerces?limite=50` ; ce module y attache le jeton lu dans le
 * cookie httpOnly et transmet à `http://127.0.0.1:4000/commerces?limite=50`.
 *
 * Sur un 401, on rafraîchit le jeton et on rejoue UNE fois. L'utilisateur ne
 * voit jamais « session expirée » en pleine consultation.
 *
 * Les réponses binaires (PDF, XLSX) sont transmises telles quelles : c'est ce
 * qui permet aux exports de l'API d'arriver au navigateur sans détour.
 */
import { NextResponse } from 'next/server';
import { lireJetons, rafraichirJeton, URL_API } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Chemins que le mandataire refuse de relayer.
 *
 * `/auth/login` et `/auth/refresh` ne doivent JAMAIS passer par ici : sinon
 * l'interface pourrait récupérer un jeton en clair, ce que toute l'architecture
 * cherche précisément à empêcher. La connexion a sa propre route.
 */
const INTERDITS = ['auth/login', 'auth/refresh', 'auth/logout'];

async function relayer(requete, contexte, methode) {
  const { chemin } = await contexte.params;
  const route = (chemin ?? []).join('/');

  if (INTERDITS.some((i) => route.startsWith(i))) {
    return NextResponse.json(
      { succes: false, erreur: { message: 'Route non relayée' } },
      { status: 403 },
    );
  }

  const { acces } = await lireJetons();
  if (!acces) {
    return NextResponse.json(
      { succes: false, erreur: { code: 'NON_AUTHENTIFIE', message: 'Session absente' } },
      { status: 401 },
    );
  }

  const requeteUrl = new URL(requete.url);
  const cible = `${URL_API}/${route}${requeteUrl.search}`;

  const corps = ['POST', 'PATCH', 'PUT'].includes(methode)
    ? await requete.text()
    : undefined;

  const appeler = async (jeton) => fetch(cible, {
    method: methode,
    headers: {
      Authorization: `Bearer ${jeton}`,
      ...(corps ? { 'Content-Type': requete.headers.get('content-type') ?? 'application/json' } : {}),
      'X-Forwarded-For': requete.headers.get('x-forwarded-for')
        ?? requete.headers.get('x-real-ip') ?? '',
      'User-Agent': requete.headers.get('user-agent') ?? 'dashboard',
    },
    body: corps,
    cache: 'no-store',
    // Les exports PDF de quittance répondent par une redirection vers une URL
    // MinIO pré-signée ; on la suit côté serveur pour que le navigateur
    // reçoive directement le fichier.
    redirect: 'follow',
  });

  let reponse;
  try {
    reponse = await appeler(acces);
  } catch {
    return NextResponse.json(
      { succes: false, erreur: { message: 'L\'API ne répond pas' } },
      { status: 503 },
    );
  }

  if (reponse.status === 401) {
    const nouveau = await rafraichirJeton();
    if (!nouveau) {
      return NextResponse.json(
        { succes: false, erreur: { code: 'SESSION_EXPIREE', message: 'Session expirée' } },
        { status: 401 },
      );
    }
    reponse = await appeler(nouveau);
  }

  const typeContenu = reponse.headers.get('content-type') ?? 'application/json';

  // Fichiers : on transmet le flux et les en-têtes qui pilotent le
  // téléchargement, sans les relire en mémoire.
  if (!typeContenu.includes('application/json')) {
    const entetes = new Headers({ 'Content-Type': typeContenu });
    for (const nom of ['content-disposition', 'content-length', 'x-nb-lignes',
      'x-tronque', 'x-total-xof']) {
      const valeur = reponse.headers.get(nom);
      if (valeur) entetes.set(nom, valeur);
    }
    return new NextResponse(reponse.body, { status: reponse.status, headers: entetes });
  }

  const donnees = await reponse.json().catch(() => null);
  return NextResponse.json(donnees ?? { succes: false }, { status: reponse.status });
}

export const GET = (r, c) => relayer(r, c, 'GET');
export const POST = (r, c) => relayer(r, c, 'POST');
export const PATCH = (r, c) => relayer(r, c, 'PATCH');
export const DELETE = (r, c) => relayer(r, c, 'DELETE');
