'use client';

/**
 * Ossature des pages authentifiées : barre latérale, en-tête, bascule de thème.
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { deconnexion, profilCourant } from '@/lib/api';
import { ROLES, auMoins, consulteSeulement } from '@/lib/format';

const PAGES = [
  { href: '/tableau-bord', libelle: "Vue d'ensemble", icone: '▤', role: 'superviseur' },
  { href: '/carte', libelle: 'Carte', icone: '◉', role: 'superviseur' },
  { href: '/rues', libelle: 'Rues', icone: '⌇', role: 'superviseur' },
  { href: '/redevables', libelle: 'Redevables', icone: '☰', role: 'superviseur' },
  { href: '/commerces', libelle: 'Commerces', icone: '▦', role: 'superviseur' },
  { href: '/contestations', libelle: 'Contestations', icone: '⚖', role: 'superviseur' },
  { href: '/recouvrement', libelle: 'Recouvrement', icone: '◈', role: 'superviseur' },
  { href: '/agents', libelle: 'Agents', icone: '☗', role: 'superviseur' },
  { href: '/audit', libelle: "Journal d'audit", icone: '⎗', role: 'superviseur' },
  { href: '/parametres', libelle: 'Paramètres', icone: '⚙', role: 'admin_commune' },
  { href: '/communes', libelle: 'Communes', icone: '⌂', role: 'super_admin' },
  // Rôle EXACT, non hiérarchique. Un chef de projet n'est pas « un
  // administrateur en plus fort » : il détient les décisions dérogatoires
  // que personne d'autre n'a. Les ranger sur une échelle donnerait ce
  // pouvoir à l'administrateur (Constitution III).
  // Les deux parties à la décision : l'exploitant qui saisit, la municipalité
  // qui valide. Rôles exacts, jamais un niveau — les ranger sur une échelle
  // donnerait la remise de dette au super-administrateur.
  { href: '/derogations', libelle: 'Dérogations', icone: '⚑', rolesExacts: ['chef_projet', 'maire'] },
];

export default function Coquille({ children }) {
  const chemin = usePathname();
  const [profil, setProfil] = useState(null);
  const [menuOuvert, setMenuOuvert] = useState(false);
  const [theme, setTheme] = useState(null);

  useEffect(() => {
    setProfil(profilCourant());
    setTheme(localStorage.getItem('gtfc-theme'));
  }, []);

  const basculerTheme = () => {
    // Trois états : suivre le système, forcer clair, forcer sombre.
    const suivant = theme === 'sombre' ? 'clair' : theme === 'clair' ? null : 'sombre';
    setTheme(suivant);
    if (suivant) {
      localStorage.setItem('gtfc-theme', suivant);
      document.documentElement.setAttribute('data-theme', suivant);
    } else {
      localStorage.removeItem('gtfc-theme');
      document.documentElement.removeAttribute('data-theme');
    }
  };

  // Un rôle exact ne se compare pas à un niveau : il correspond, ou pas.
  const pages = PAGES.filter((p) => (p.rolesExacts
    ? p.rolesExacts.includes(profil?.role)
    : auMoins(profil?.role ?? 'agent', p.role)));

  return (
    <div className="flex min-h-screen">
      {/* ---------------- Barre latérale ---------------- */}
      <aside className={`sans-impression fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-bordure
        bg-surface transition-transform lg:static lg:translate-x-0
        ${menuOuvert ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-bordure px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-marque text-sm font-bold text-white">
            {profil?.commune_slug?.slice(0, 2).toUpperCase() ?? 'GT'}
          </span>
          <div className="min-w-0">
            {/* Nom tronqué avec points de suspension : l'infobulle donne
                le nom complet, jamais rogné sans recours. */}
            <p className="truncate text-[13px] font-semibold text-encre"
              title={profil?.commune_nom ?? undefined}>
              {profil?.commune_nom ?? 'Plateforme'}
            </p>
            <p className="text-[11px] text-encre-attenuee">Taxes locales</p>
          </div>
        </div>

        <nav className="p-2">
          {pages.map((p) => {
            const actif = chemin.startsWith(p.href);
            return (
              <Link key={p.href} href={p.href} onClick={() => setMenuOuvert(false)}
                aria-current={actif ? 'page' : undefined}
                className={`mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors
                  ${actif ? 'bg-surface-alt font-semibold text-encre' : 'text-encre-2 hover:bg-surface-alt'}`}
              >
                <span aria-hidden="true" className="w-4 text-center">{p.icone}</span>
                {p.libelle}
              </Link>
            );
          })}
        </nav>

        <div className="absolute inset-x-0 bottom-0 border-t border-bordure p-3">
          <p className="truncate text-[13px] font-medium text-encre">{profil?.nom_complet}</p>
          <p className="mb-2 truncate text-[11px] text-encre-attenuee">
            {ROLES[profil?.role] ?? profil?.role}
            {consulteSeulement(profil?.role) ? (
              // Dit une fois, à sa place. Sans cela, le maire découvrirait la
              // restriction en butant sur un bouton, ce qui se lit comme une
              // panne plutôt que comme un partage des rôles.
              <span className="ml-1 text-encre-attenuee">· consultation seule</span>
            ) : null}
          </p>
          <button type="button" onClick={deconnexion}
            className="w-full rounded-lg border border-bordure px-3 py-1.5 text-[13px] text-encre-2 hover:bg-surface-alt"
          >
            Se déconnecter
          </button>
        </div>
      </aside>

      {menuOuvert && (
        <button type="button" aria-label="Fermer le menu"
          onClick={() => setMenuOuvert(false)}
          className="fixed inset-0 z-30 bg-black/30 lg:hidden" />
      )}

      {/* ---------------- Contenu ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sans-impression sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-bordure bg-surface px-4">
          <button type="button" onClick={() => setMenuOuvert(true)}
            aria-label="Ouvrir le menu"
            className="rounded-lg p-1.5 text-encre-2 hover:bg-surface-alt lg:hidden">☰</button>

          <h1 className="flex-1 truncate text-sm font-semibold text-encre">
            {pages.find((p) => chemin.startsWith(p.href))?.libelle ?? 'Tableau de bord'}
          </h1>

          <button type="button" onClick={basculerTheme}
            title={theme === 'sombre' ? 'Thème sombre (cliquer pour clair)'
              : theme === 'clair' ? 'Thème clair (cliquer pour suivre le système)'
                : 'Suit le système (cliquer pour sombre)'}
            className="rounded-lg border border-bordure px-2.5 py-1.5 text-[13px] text-encre-2 hover:bg-surface-alt"
          >
            {theme === 'sombre' ? '◑ Sombre' : theme === 'clair' ? '◐ Clair' : '◒ Système'}
          </button>
        </header>

        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
