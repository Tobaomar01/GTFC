/**
 * Ossature du portail redevable.
 *
 * Volontairement dépouillée, et sans rien de commun avec le tableau de bord
 * de la mairie : pas de barre latérale, pas de menu, pas de navigation entre
 * sections. Le redevable a UNE chose à faire — consulter son dossier et
 * payer — et il la fait souvent sur un téléphone d'entrée de gamme, en 3G,
 * debout dans sa boutique.
 *
 * Le portail est servi par la même application Next.js que le tableau de
 * bord, mais sous son propre chemin et avec son propre cookie. Deux raisons :
 *  · une seule application à déployer, à surveiller et à mettre à jour ;
 *  · le mandataire /api/portail n'expose QUE les routes du portail, en liste
 *    blanche — un cookie de redevable ne donne accès à rien d'autre.
 */

export const metadata = {
  title: 'Mon dossier — taxes communales',
  description: 'Consultez votre situation fiscale et vos quittances',
};

export default function DispositionPortail({ children }) {
  return (
    <div className="min-h-screen bg-surface-alt">
      <header className="border-b border-bordure bg-surface">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-marque text-sm font-bold text-white">
            GT
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-encre">
              Taxes communales
            </p>
            <p className="text-[12px] text-encre-attenuee">
              Gueule Tapée-Fass-Colobane
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">{children}</main>

      <footer className="mx-auto max-w-2xl px-4 pb-8 pt-2">
        <p className="text-[12px] leading-relaxed text-encre-attenuee">
          Ce service est fourni par la mairie de Gueule Tapée-Fass-Colobane.
          Pour toute question sur un montant, utilisez le formulaire de
          contestation depuis votre dossier, ou présentez-vous à la mairie.
        </p>
      </footer>
    </div>
  );
}
