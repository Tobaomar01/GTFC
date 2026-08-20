import { redirect } from 'next/navigation';
import { estConnecte, lireProfil } from '@/lib/session';
import Coquille from '@/composants/Coquille';

export const dynamic = 'force-dynamic';

/**
 * Garde d'accès des pages authentifiées.
 *
 * La vérification faite ici est un CONFORT : elle évite d'afficher une page
 * vide à qui n'est pas connecté. Les droits réels sont vérifiés par l'API à
 * chaque requête, à partir du jeton — jamais à partir de ce qu'annonce le
 * navigateur.
 */
export default async function LayoutPrive({ children }) {
  if (!(await estConnecte())) redirect('/connexion');

  const profil = await lireProfil();
  if (profil?.role === 'agent') redirect('/connexion?expiree=1');

  return <Coquille>{children}</Coquille>;
}
