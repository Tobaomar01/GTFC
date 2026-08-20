/**
 * Session côté serveur.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POURQUOI UN MANDATAIRE PLUTÔT QU'UN JETON DANS LE NAVIGATEUR
 *
 *  Le navigateur ne voit JAMAIS le jeton d'accès. Il ne parle qu'au serveur
 *  Next.js (même origine), qui garde les jetons dans des cookies `httpOnly`
 *  et les transmet à l'API.
 *
 *  Trois bénéfices, dans l'ordre d'importance :
 *    1. une faille XSS dans le dashboard ne permet pas de voler la session —
 *       du JavaScript ne peut pas lire un cookie httpOnly. Sur une
 *       application fiscale, c'est décisif ;
 *    2. plus aucune question de CORS : même origine ;
 *    3. le rafraîchissement du jeton est invisible pour l'interface.
 *
 *  Coût : un saut réseau de plus, en local, sur la même machine. Négligeable.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { cookies } from 'next/headers';

const URL_API = process.env.API_URL || 'http://127.0.0.1:4000';
const SECURISE = process.env.COOKIES_SECURE !== 'false';

const NOM_ACCES = 'gtfc_acces';
const NOM_RAFRAICHISSEMENT = 'gtfc_rafraichissement';
const NOM_PROFIL = 'gtfc_profil';

const optionsCookie = {
  httpOnly: true,
  secure: SECURISE,
  // `lax` et non `strict` : la mairie arrive souvent depuis un lien externe
  // (courriel du superviseur), et `strict` la renverrait sur la connexion.
  sameSite: 'lax',
  path: '/',
};

export async function poserSession(donnees) {
  const magasin = await cookies();

  // Le jeton d'accès vit 15 minutes côté API ; on donne un peu de marge au
  // cookie pour que le mandataire puisse détecter l'expiration et rafraîchir.
  magasin.set(NOM_ACCES, donnees.jeton_acces, { ...optionsCookie, maxAge: 60 * 20 });
  magasin.set(NOM_RAFRAICHISSEMENT, donnees.jeton_rafraichissement, {
    ...optionsCookie, maxAge: 60 * 60 * 24 * 30,
  });

  // Le profil n'est pas un secret : il est lisible par l'interface pour
  // afficher le nom et adapter les menus au rôle. Les DROITS restent vérifiés
  // par l'API — ce cookie n'autorise rien.
  magasin.set(NOM_PROFIL, JSON.stringify({
    ...donnees.utilisateur,
    doit_changer_mot_de_passe: donnees.doit_changer_mot_de_passe,
  }), { ...optionsCookie, httpOnly: false, maxAge: 60 * 60 * 24 * 30 });
}

export async function effacerSession() {
  const magasin = await cookies();
  for (const nom of [NOM_ACCES, NOM_RAFRAICHISSEMENT, NOM_PROFIL]) {
    magasin.set(nom, '', { ...optionsCookie, httpOnly: nom !== NOM_PROFIL, maxAge: 0 });
  }
}

export async function lireJetons() {
  const magasin = await cookies();
  return {
    acces: magasin.get(NOM_ACCES)?.value ?? null,
    rafraichissement: magasin.get(NOM_RAFRAICHISSEMENT)?.value ?? null,
  };
}

export async function lireProfil() {
  const magasin = await cookies();
  const brut = magasin.get(NOM_PROFIL)?.value;
  if (!brut) return null;
  try { return JSON.parse(brut); } catch { return null; }
}

export const estConnecte = async () => Boolean((await lireJetons()).acces);

/**
 * Rafraîchit le jeton d'accès auprès de l'API.
 * Renvoie le nouveau jeton, ou null si la session est définitivement finie.
 */
export async function rafraichirJeton() {
  const { rafraichissement } = await lireJetons();
  if (!rafraichissement) return null;

  const reponse = await fetch(`${URL_API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jeton_rafraichissement: rafraichissement }),
    cache: 'no-store',
  }).catch(() => null);

  if (!reponse?.ok) {
    await effacerSession();
    return null;
  }

  const corps = await reponse.json();
  const magasin = await cookies();
  magasin.set(NOM_ACCES, corps.donnees.jeton_acces, { ...optionsCookie, maxAge: 60 * 20 });
  magasin.set(NOM_RAFRAICHISSEMENT, corps.donnees.jeton_rafraichissement, {
    ...optionsCookie, maxAge: 60 * 60 * 24 * 30,
  });
  return corps.donnees.jeton_acces;
}

export { URL_API, NOM_ACCES, NOM_RAFRAICHISSEMENT, NOM_PROFIL };
