'use client';

/**
 * Composants d'interface communs.
 */
import { useState } from 'react';
import { STATUTS } from '@/lib/format';

// ---------------------------------------------------------------------------
export function Carte({ titre, sousTitre, actions, children, className = '' }) {
  return (
    <section className={`carte-impression rounded-carte border border-bordure bg-surface p-5 shadow-carte ${className}`}>
      {(titre || actions) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {titre && <h2 className="text-base font-semibold text-encre">{titre}</h2>}
            {sousTitre && <p className="mt-0.5 text-sm text-encre-2">{sousTitre}</p>}
          </div>
          {actions && <div className="flex shrink-0 gap-2 sans-impression">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
export function Bouton({
  children, onClick, variante = 'secondaire', taille = 'normal',
  charge = false, desactive = false, type = 'button', titre,
}) {
  const variantes = {
    primaire: 'bg-marque text-white hover:opacity-90 border-transparent',
    secondaire: 'bg-surface text-encre border-bordure hover:bg-surface-alt',
    discret: 'bg-transparent text-encre-2 border-transparent hover:bg-surface-alt',
    danger: 'bg-st-impaye text-white border-transparent hover:opacity-90',
  };
  const tailles = { normal: 'h-10 px-4 text-sm', petit: 'h-8 px-3 text-[13px]' };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={desactive || charge}
      title={titre}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border font-medium
        transition-opacity disabled:opacity-45 ${variantes[variante]} ${tailles[taille]}`}
    >
      {charge && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
/**
 * Badge de statut fiscal.
 *
 * La couleur ne porte JAMAIS l'information seule : un symbole et un libellé
 * l'accompagnent toujours. C'est ce qui rend l'écran lisible par un daltonien,
 * en impression noir et blanc et en contraste forcé.
 */
export function BadgeStatut({ statut, compact = false }) {
  const s = STATUTS[statut] ?? STATUTS.inconnu;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-medium"
      style={{ background: `var(${s.fond})`, color: `var(${s.variable})` }}
    >
      <span aria-hidden="true" className="font-bold leading-none">{s.icone}</span>
      {compact ? s.court : s.libelle}
    </span>
  );
}

// ---------------------------------------------------------------------------
export function Champ({ etiquette, aide, erreur, suffixe, ...props }) {
  return (
    <label className="block">
      {etiquette && (
        <span className="mb-1 block text-sm font-medium text-encre-2">{etiquette}</span>
      )}
      <span className={`flex items-center rounded-lg border bg-surface px-3
        ${erreur ? 'border-st-impaye' : 'border-bordure'}`}
      >
        <input
          className="h-10 w-full bg-transparent text-sm text-encre outline-none placeholder:text-encre-attenuee"
          {...props}
        />
        {suffixe && <span className="pl-2 text-sm text-encre-attenuee">{suffixe}</span>}
      </span>
      {erreur && <span className="mt-1 block text-[13px] text-st-impaye">{erreur}</span>}
      {aide && !erreur && <span className="mt-1 block text-[13px] text-encre-attenuee">{aide}</span>}
    </label>
  );
}

/**
 * Saisie multiligne.
 *
 * Distincte de Champ, qui ne rend qu'un input : une motivation de rejet ou
 * des notes d'instruction se rédigent sur plusieurs lignes, et un champ
 * d'une ligne pousse à écrire trois mots là où il en faudrait trente.
 */
export function ZoneTexte({ etiquette, aide, erreur, lignes = 4, ...props }) {
  const bordure = erreur ? 'border-st-impaye' : 'border-bordure';
  return (
    <label className="block">
      {etiquette && (
        <span className="mb-1 block text-sm font-medium text-encre-2">{etiquette}</span>
      )}
      <textarea
        rows={lignes}
        className={`w-full rounded-lg border ${bordure} bg-surface px-3 py-2 text-sm
          leading-relaxed text-encre outline-none placeholder:text-encre-attenuee`}
        {...props}
      />
      {erreur && <span className="mt-1 block text-[13px] text-st-impaye">{erreur}</span>}
      {aide && !erreur && <span className="mt-1 block text-[13px] text-encre-attenuee">{aide}</span>}
    </label>
  );
}

export function Selection({ etiquette, options, valeur, onChange, aucun = 'Tous' }) {
  return (
    <label className="block">
      {etiquette && (
        <span className="mb-1 block text-sm font-medium text-encre-2">{etiquette}</span>
      )}
      <select
        value={valeur ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-10 w-full rounded-lg border border-bordure bg-surface px-3 text-sm text-encre outline-none"
      >
        <option value="">{aucun}</option>
        {options.map((o) => (
          <option key={o.valeur} value={o.valeur}>{o.libelle}</option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
export function Message({ type = 'info', titre, children }) {
  const styles = {
    info: { bord: 'var(--st-inconnu)', fond: 'var(--st-inconnu-fond)', icone: 'i' },
    succes: { bord: 'var(--st-ajour)', fond: 'var(--st-ajour-fond)', icone: '✓' },
    avertissement: { bord: 'var(--st-partiel)', fond: 'var(--st-partiel-fond)', icone: '!' },
    erreur: { bord: 'var(--st-impaye)', fond: 'var(--st-impaye-fond)', icone: '!' },
  };
  const s = styles[type] ?? styles.info;

  return (
    <div className="flex gap-3 rounded-lg border-l-4 p-4"
      style={{ borderLeftColor: s.bord, background: s.fond }}
    >
      <span aria-hidden="true" className="font-bold" style={{ color: s.bord }}>{s.icone}</span>
      <div className="min-w-0 flex-1">
        {titre && <p className="font-semibold text-encre">{titre}</p>}
        <div className="text-sm text-encre-2">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Tableau({ colonnes, lignes, cle, vide = 'Aucune donnée', compact = false }) {
  // « cle » nomme un champ ('id'), ou calcule l’identité d’une ligne qui n’en
  // a pas : la vue des données provisoires n’a pas de clé primaire — son
  // identité est le couple (entite, libelle). Nommer un champ absent donnait
  // une clé indéfinie sur CHAQUE ligne, sans que rien ne le signale.
  const cleLigne = typeof cle === 'function'
    ? cle
    : (ligne, i) => (cle ? ligne[cle] : i);

  if (!lignes || lignes.length === 0) {
    return <p className="py-8 text-center text-sm text-encre-attenuee">{vide}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-full text-sm">
        <thead>
          <tr className="border-b border-grille text-left">
            {colonnes.map((c, iCol) => (
              <th key={c.cle ?? `colonne-${iCol}`}
                className={`whitespace-nowrap pb-2 pr-4 text-[13px] font-semibold text-encre-2
                  ${c.alignement === 'droite' ? 'text-right' : ''}`}
              >
                {c.titre}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lignes.map((ligne, i) => (
            <tr key={cleLigne(ligne, i)}
              className="border-b border-grille last:border-0 hover:bg-surface-alt"
            >
              {colonnes.map((c, iCol) => (
                <td key={c.cle ?? `colonne-${iCol}`}
                  className={`${compact ? 'py-1.5' : 'py-2.5'} pr-4 align-top text-encre
                    ${c.alignement === 'droite' ? 'text-right chiffres-alignes' : ''}
                    ${c.monospace ? 'font-mono text-[13px]' : ''}`}
                >
                  {c.rendu ? c.rendu(ligne) : (ligne[c.cle] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Chargement({ texte = 'Chargement…' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-marque border-t-transparent" />
      <p className="text-sm text-encre-2">{texte}</p>
    </div>
  );
}

export function EtatVide({ titre, texte, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-base font-semibold text-encre">{titre}</p>
      {texte && <p className="max-w-md text-sm text-encre-2">{texte}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * Bascule graphique / tableau.
 *
 * Chaque graphique a son jumeau tabulaire. Une valeur n'est jamais accessible
 * uniquement par la couleur ou par une infobulle.
 */
export function AvecVueTableau({ children, colonnes, lignes, cle }) {
  const [tableau, setTableau] = useState(false);
  return (
    <>
      <div className="mb-3 flex justify-end sans-impression">
        <div className="inline-flex rounded-lg border border-bordure p-0.5" role="tablist">
          <button type="button" role="tab" aria-selected={!tableau}
            onClick={() => setTableau(false)}
            className={`rounded px-3 py-1 text-[13px] font-medium ${!tableau ? 'bg-surface-alt text-encre' : 'text-encre-2'}`}
          >
            Graphique
          </button>
          <button type="button" role="tab" aria-selected={tableau}
            onClick={() => setTableau(true)}
            className={`rounded px-3 py-1 text-[13px] font-medium ${tableau ? 'bg-surface-alt text-encre' : 'text-encre-2'}`}
          >
            Tableau
          </button>
        </div>
      </div>
      {tableau ? <Tableau colonnes={colonnes} lignes={lignes} cle={cle} compact /> : children}
    </>
  );
}
