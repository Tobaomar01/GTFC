/**
 * Vérification publique d'une quittance.
 *
 * C'est l'URL encodée dans le QR imprimé sur chaque quittance. Elle permet à
 * un commerçant — ou à un contrôleur — de s'assurer qu'un document papier a
 * bien été émis par la commune et n'a pas été fabriqué.
 *
 * Elle répond explicitement « aucune quittance ne correspond » plutôt qu'une
 * page d'erreur : c'est exactement le cas d'usage recherché.
 */
import { URL_API } from '@/lib/session';
import { xof, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Vérification d\'une quittance',
  robots: 'noindex, nofollow',
};

async function verifier(jeton) {
  try {
    const reponse = await fetch(`${URL_API}/public/quittance/${encodeURIComponent(jeton)}`, {
      cache: 'no-store',
    });
    if (!reponse.ok) return null;
    const corps = await reponse.json();
    return corps?.donnees ?? null;
  } catch {
    return null;
  }
}

export default async function PageQuittance({ params }) {
  const { jeton } = await params;
  const resultat = await verifier(jeton);

  // Trois cas à distinguer, et l'API les sépare bien :
  //   - aucune quittance ne porte ce code  -> pas de `numero` dans la réponse ;
  //   - la quittance existe et le paiement tient -> valide = true ;
  //   - la quittance existe mais le paiement a été annulé -> valide = false.
  // Les confondre dirait « paiement annulé » à quelqu'un qui présente un faux,
  // ce qui est exactement l'inverse du message attendu.
  const introuvable = !resultat || !resultat.numero;
  const authentique = !introuvable && resultat.valide === true;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md overflow-hidden rounded-carte border border-bordure bg-surface shadow-carte">
        <div className="bg-marque px-6 py-5 text-center text-white">
          <p className="text-[13px] uppercase tracking-wide opacity-90">
            {resultat?.commune ?? 'Commune'}
          </p>
          <p className="mt-0.5 text-sm font-semibold">Vérification d&apos;une quittance</p>
        </div>

        <div className="p-6">
          {introuvable ? (
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-2xl font-bold"
                style={{ background: 'var(--st-impaye-fond)', color: 'var(--st-impaye)' }}>!</div>
              <p className="text-lg font-bold text-encre">Quittance inconnue</p>
              <p className="mt-2 text-sm text-encre-2">
                {resultat?.message
                  ?? "Aucune quittance ne correspond à ce code. Ce document n'a pas été émis par la commune."}
              </p>
            </div>
          ) : (
            <>
              <div className="text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-2xl font-bold"
                  style={authentique
                    ? { background: 'var(--st-ajour-fond)', color: 'var(--st-ajour)' }
                    : { background: 'var(--st-impaye-fond)', color: 'var(--st-impaye)' }}>
                  {authentique ? '✓' : '✗'}
                </div>
                <p className="text-lg font-bold text-encre">
                  {authentique ? 'Quittance authentique' : 'Paiement annulé'}
                </p>
                {!authentique && (
                  <p className="mt-2 text-sm text-encre-2">
                    Cette quittance a bien été émise, mais le paiement
                    correspondant a été annulé par la commune.
                  </p>
                )}
              </div>

              <dl className="mt-5 space-y-2 border-t border-grille pt-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-encre-2">Numéro</dt>
                  <dd className="text-right font-mono text-encre">{resultat.numero}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-encre-2">Commerce</dt>
                  <dd className="text-right font-mono text-encre">{resultat.commerce_code}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-encre-2">Payé le</dt>
                  <dd className="text-right font-medium text-encre">
                    {date(resultat.paye_le, { avecHeure: true })}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-grille pt-2">
                  <dt className="font-semibold text-encre">Montant</dt>
                  <dd className="text-right text-lg font-bold" style={{ color: 'var(--marque)' }}>
                    {xof(resultat.montant)}
                  </dd>
                </div>
              </dl>
            </>
          )}

          <p className="mt-5 text-center text-[13px] text-encre-attenuee">
            Vérification effectuée directement auprès du registre de la commune.
          </p>
        </div>
      </div>
    </main>
  );
}
