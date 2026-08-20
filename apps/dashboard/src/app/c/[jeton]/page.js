/**
 * Page publique de scan d'un QR code.
 *
 * C'est l'URL imprimée sur les stickers : https://gtfc.domaine.sn/c/<jeton>.
 * N'importe qui la scanne avec l'appareil photo de son téléphone — sans
 * compte, sans application.
 *
 * Elle ne divulgue AUCUNE donnée fiscale : ni montant dû, ni situation de
 * paiement, ni identité du gérant. Un passant ne doit pas pouvoir savoir qui
 * est en retard en scannant les devantures d'une rue. Elle sert uniquement à
 * prouver qu'un commerce est enregistré auprès de la commune.
 *
 * Rendu côté serveur : la page doit s'afficher sur un téléphone d'entrée de
 * gamme en 2G, sans exécuter de JavaScript.
 */
import { URL_API } from '@/lib/session';
import { date } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Vérification d\'un commerce',
  robots: 'noindex, nofollow',
};

async function chercher(jeton) {
  try {
    const reponse = await fetch(`${URL_API}/public/c/${encodeURIComponent(jeton)}`, {
      cache: 'no-store',
    });
    if (!reponse.ok) return null;
    const corps = await reponse.json();
    return corps?.donnees ?? null;
  } catch {
    return null;
  }
}

export default async function PageScan({ params }) {
  const { jeton } = await params;
  const commerce = await chercher(jeton);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md overflow-hidden rounded-carte border border-bordure bg-surface shadow-carte">
        <div className="bg-marque px-6 py-5 text-center text-white">
          <p className="text-[13px] uppercase tracking-wide opacity-90">
            {commerce?.commune ?? 'Commune'}
          </p>
          <p className="mt-0.5 text-sm font-semibold">Registre communal des commerces</p>
        </div>

        {!commerce ? (
          <div className="p-6 text-center">
            <p className="text-lg font-bold text-encre">QR code non reconnu</p>
            <p className="mt-2 text-sm text-encre-2">
              Ce code ne correspond à aucun commerce enregistré. Vérifiez qu&apos;il
              s&apos;agit bien d&apos;un sticker officiel de la commune.
            </p>
          </div>
        ) : (
          <div className="p-6">
            {!commerce.qr_actif && (
              <div className="mb-4 rounded-lg border-l-4 p-3 text-sm"
                style={{ borderLeftColor: 'var(--st-partiel)', background: 'var(--st-partiel-fond)' }}>
                Ce sticker a été remplacé. Demandez le sticker à jour à votre agent.
              </div>
            )}

            <p className="text-xl font-bold text-encre">{commerce.enseigne}</p>
            <p className="mt-0.5 font-mono text-sm text-encre-2">{commerce.code}</p>

            <dl className="mt-5 space-y-2 border-t border-grille pt-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-encre-2">Activité</dt>
                <dd className="text-right font-medium text-encre">{commerce.categorie}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-encre-2">Quartier</dt>
                <dd className="text-right font-medium text-encre">{commerce.quartier}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-encre-2">Enregistré le</dt>
                <dd className="text-right font-medium text-encre">{date(commerce.enregistre_le)}</dd>
              </div>
            </dl>

            <div className="mt-5 rounded-lg p-3 text-center text-sm"
              style={{ background: 'var(--st-ajour-fond)', color: 'var(--st-ajour)' }}>
              <span aria-hidden="true" className="font-bold">✓</span>{' '}
              Commerce enregistré auprès de la commune
            </div>

            <p className="mt-4 text-center text-[13px] text-encre-attenuee">
              Cette page atteste de l&apos;enregistrement du commerce au registre
              communal. Elle ne communique aucune information fiscale.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
