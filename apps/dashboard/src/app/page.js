import { redirect } from 'next/navigation';
import { estConnecte } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Accueil() {
  redirect((await estConnecte()) ? '/tableau-bord' : '/connexion');
}
