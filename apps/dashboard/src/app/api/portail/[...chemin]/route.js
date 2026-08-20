/**
 * Mandataire du portail redevable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POURQUOI UN MANDATAIRE ICI AUSSI
 *
 *  L'API pose un cookie de session `gtfc_portail`, httpOnly. Mais elle vit
 *  sur un autre hôte que la page (127.0.0.1:4000 derrière Nginx). Un cookie
 *  posé par l'API ne serait donc pas renvoyé par le navigateur lors des
 *  requêtes vers le portail — ou exigerait un cookie tiers, que les
 *  navigateurs bloquent de plus en plus.
 *
 *  Ce module fait donc la jonction :
 *   · à la connexion, il capte le Set-Cookie de l'API et le repose sur le
 *     domaine du portail, toujours httpOnly ;
 *   · aux requêtes suivantes, il relit ce cookie et le transmet à l'API.
 *
 *  Le jeton de session ne traverse jamais le JavaScript de la page. Une
 *  faille d'injection sur le portail — qui affiche des libellés saisis par
 *  des agents — ne permettrait donc pas de voler la session d'un redevable.
 *
 *  CE QUI N'EST PAS RELAYÉ
 *  Rien d'autre que /portail. Un chemin forgé ne doit pas permettre
 *  d'atteindre /commerces ou /avis avec un cookie de redevable.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { URL_API } from '@/lib/session';

export const dynamic = 'force-dynamic';

const COOKIE = 'gtfc_portail';

/**
 * Routes autorisées, en liste blanche.
 * Une liste noire laisserait passer tout ce qu'on n'aurait pas prévu.
 */
const AUTORISEES = [
  'code', 'session', 'deconnexion', 'dossier', 'quittances',
  'motifs-contestation', 'contestations', 'telephone',
];

function autorise(route) {
  const premier = route.split('/')[0];
  return AUTORISEES.includes(premier);
}

/** Durée de vie du cookie, reprise de celle annoncée par l'API. */
function expirationDepuis(donnees) {
  const brut = donnees?.donnees?.expire_le;
  const date = brut ? new Date(brut) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

async function relayer(requete, contexte, methode) {
  const { chemin } = await contexte.params;
  const route = (chemin ?? []).join('/');

  if (!autorise(route)) {
    return NextResponse.json(
      { succes: false, erreur: { message: 'Route non relayée' } },
      { status: 403 },
    );
  }

  const magasin = await cookies();
  const jeton = magasin.get(COOKIE)?.value ?? null;

  const url = new URL(requete.url);
  const cible = `${URL_API}/portail/${route}${url.search}`;

  const corps = ['POST', 'PATCH', 'PUT'].includes(methode)
    ? await requete.text()
    : undefined;

  const reponseApi = await fetch(cible, {
    method: methode,
    headers: {
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
      ...(jeton ? { Cookie: `${COOKIE}=${jeton}` } : {}),
      // L'API journalise l'adresse d'origine, pas celle du mandataire :
      // sans cela, le plafond de cinq demandes par heure et par numéro
      // s'appliquerait à la somme de tous les redevables.
      'X-Forwarded-For': requete.headers.get('x-forwarded-for')
        ?? requete.headers.get('x-real-ip') ?? '',
    },
    body: corps,
    cache: 'no-store',
  });

  const texte = await reponseApi.text();
  let donnees = null;
  try { donnees = JSON.parse(texte); } catch { /* réponse non JSON */ }

  const reponse = donnees
    ? NextResponse.json(donnees, { status: reponseApi.status })
    : new NextResponse(texte, { status: reponseApi.status });

  // --- Ouverture de session : on repose le cookie sur ce domaine ----------
  const posee = reponseApi.headers.get('set-cookie');
  if (posee && reponseApi.ok) {
    const valeur = posee.split(';')[0].split('=').slice(1).join('=');
    if (valeur) {
      reponse.cookies.set(COOKIE, valeur, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        expires: expirationDepuis(donnees) ?? undefined,
      });
    }
  }

  if (route === 'deconnexion') {
    reponse.cookies.set(COOKIE, '', { path: '/', maxAge: 0 });
  }

  return reponse;
}

export async function GET(requete, contexte) { return relayer(requete, contexte, 'GET'); }
export async function POST(requete, contexte) { return relayer(requete, contexte, 'POST'); }
