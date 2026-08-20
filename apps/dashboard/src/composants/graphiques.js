'use client';

/**
 * Graphiques.
 *
 * Écrits à la main en HTML/SVG, sans bibliothèque : la plateforme est
 * auto-hébergée et le dashboard ne charge aucune ressource externe hormis les
 * tuiles OpenStreetMap.
 *
 * Règles appliquées, dans l'ordre où elles ont été décidées :
 *
 *   1. LA FORME AVANT LA COULEUR. Un chiffre isolé est une tuile, pas un
 *      graphique à une barre. Une part-à-tout est une barre empilée. Une
 *      comparaison de grandeurs est une barre à teinte unique.
 *
 *   2. LA COULEUR SELON SON RÔLE. Les segments qui SIGNIFIENT bon/mauvais
 *      portent les couleurs de STATUT. Les barres qui ne portent qu'une
 *      grandeur portent toutes la MÊME teinte : colorer chaque barre selon sa
 *      valeur double l'encodage de sa longueur et gaspille le seul canal libre.
 *
 *   3. LA COULEUR NE PORTE JAMAIS SEULE. Légende systématique dès deux séries,
 *      étiquettes directes sélectives, symbole + libellé sur chaque statut,
 *      et une vue tableau pour chaque graphique.
 *
 *   4. DEUX ESPACEURS. Un intervalle de 2 px à la couleur du fond sépare les
 *      segments — jamais un contour tracé autour des marques.
 *
 * Le texte porte les encres (primaire / secondaire / atténuée), jamais la
 * couleur d'une série : une teinte claire est illisible en texte.
 */
import { useState } from 'react';
import { xof, nombre, pourcentage, STATUTS, ORDRE_STATUTS } from '@/lib/format';

/** Barres ≤ 24 px : au-delà, l'aplat devient lourd et écrase la page. */
const EPAISSEUR = 20;

// ===========================================================================
//  Tuiles et grands nombres
// ===========================================================================

/**
 * Tuile de statistique — la forme juste pour un chiffre isolé.
 * Chiffres proportionnels : `tabular-nums` ferait paraître « 121 » distendu
 * à cette taille. Les colonnes alignées, elles, l'utilisent.
 */
export function TuileStat({ etiquette, valeur, detail, accent = null, icone = null }) {
  return (
    <div className="rounded-carte border border-bordure bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-encre-2">{etiquette}</p>
        {icone && <span aria-hidden="true" className="text-encre-attenuee">{icone}</span>}
      </div>
      <p className="mt-1 text-2xl font-bold leading-tight"
        style={accent ? { color: `var(${accent})` } : { color: 'var(--encre)' }}
      >
        {valeur}
      </p>
      {detail && <p className="mt-0.5 text-[13px] text-encre-attenuee">{detail}</p>}
    </div>
  );
}

/** Le chiffre que le tableau de bord met en avant. */
export function FigureHero({ etiquette, valeur, detail, accent = '--marque' }) {
  return (
    <div>
      <p className="text-sm font-medium text-encre-2">{etiquette}</p>
      <p className="figure-hero mt-1" style={{ color: `var(${accent})` }}>{valeur}</p>
      {detail && <p className="mt-1 text-sm text-encre-2">{detail}</p>}
    </div>
  );
}

// ===========================================================================
//  Légende
// ===========================================================================

/** Présente dès deux séries — l'identité ne repose jamais sur la couleur seule. */
export function Legende({ entrees }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {entrees.map((e) => (
        <li key={e.cle} className="flex items-center gap-1.5 text-[13px] text-encre-2">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: `var(${e.variable})` }} />
          {e.libelle}
          {e.valeur !== undefined && (
            <span className="chiffres-alignes font-medium text-encre">{e.valeur}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export const LegendeStatuts = ({ statuts = ORDRE_STATUTS.slice(0, 3), totaux = null }) => (
  <Legende entrees={statuts.map((s) => ({
    cle: s,
    libelle: `${STATUTS[s].icone} ${STATUTS[s].libelle}`,
    variable: STATUTS[s].variable,
    valeur: totaux?.[s] !== undefined ? nombre(totaux[s]) : undefined,
  }))} />
);

// ===========================================================================
//  Barre empilée — part-à-tout, couleurs de statut
// ===========================================================================

/**
 * Une ligne par catégorie (zone, quartier, période), des segments qui
 * signifient bon → mauvais.
 *
 * Les segments portent les couleurs de STATUT parce qu'ils encodent un état,
 * pas une identité. Un intervalle de 2 px à la couleur du fond les sépare.
 * L'étiquette n'est posée DANS un segment que si elle y tient : sinon elle
 * part dans l'infobulle et le tableau, jamais rognée.
 */
export function BarresEmpilees({ lignes, segments, formatValeur = nombre, etiquetteTotal }) {
  const [survol, setSurvol] = useState(null);
  const maximum = Math.max(...lignes.map((l) => segments.reduce((s, c) => s + (l[c.cle] || 0), 0)), 1);

  return (
    <div className="space-y-3">
      {lignes.map((ligne) => {
        const total = segments.reduce((s, c) => s + (ligne[c.cle] || 0), 0);
        const largeurLigne = (total / maximum) * 100;

        return (
          <div key={ligne.cle}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="truncate text-[13px] font-medium text-encre">{ligne.libelle}</span>
              <span className="shrink-0 chiffres-alignes text-[13px] text-encre-2">
                {etiquetteTotal ? etiquetteTotal(ligne, total) : formatValeur(total)}
              </span>
            </div>

            <div className="flex" style={{ height: EPAISSEUR, width: `${largeurLigne}%` }}>
              {segments.map((seg, i) => {
                const valeur = ligne[seg.cle] || 0;
                if (valeur === 0) return null;
                const part = (valeur / total) * 100;
                const premier = segments.slice(0, i).every((s) => (ligne[s.cle] || 0) === 0);
                const dernier = segments.slice(i + 1).every((s) => (ligne[s.cle] || 0) === 0);
                // Une étiquette n'entre dans un segment qu'au-delà de ~14 % de
                // la ligne ; en dessous elle serait rognée.
                const tientDedans = part > 14 && largeurLigne > 30;
                const actif = survol?.ligne === ligne.cle && survol?.segment === seg.cle;

                return (
                  <div
                    key={seg.cle}
                    role="img"
                    aria-label={`${ligne.libelle} — ${seg.libelle} : ${formatValeur(valeur)}`}
                    title={`${seg.libelle} : ${formatValeur(valeur)} (${pourcentage(part, { decimales: 0 })})`}
                    onMouseEnter={() => setSurvol({ ligne: ligne.cle, segment: seg.cle })}
                    onMouseLeave={() => setSurvol(null)}
                    className="relative flex items-center justify-center overflow-visible transition-opacity"
                    style={{
                      width: `${part}%`,
                      background: `var(${seg.variable})`,
                      // Extrémité de donnée arrondie ; côté ligne de base, carré.
                      borderTopLeftRadius: premier ? 2 : 0,
                      borderBottomLeftRadius: premier ? 2 : 0,
                      borderTopRightRadius: dernier ? 4 : 0,
                      borderBottomRightRadius: dernier ? 4 : 0,
                      // L'espaceur : 2 px de fond, pas un contour.
                      marginRight: dernier ? 0 : 2,
                      opacity: survol && !actif ? 0.72 : 1,
                    }}
                  >
                    {tientDedans && (
                      <span className="px-1 text-[11px] font-semibold leading-none"
                        style={{ color: seg.encreClaire ? '#16211A' : '#FFFFFF' }}
                      >
                        {formatValeur(valeur)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ===========================================================================
//  Barres de magnitude — teinte unique
// ===========================================================================

/**
 * Comparaison de grandeurs sur des catégories nominales (taxes, agents).
 *
 * TOUTES les barres portent la même teinte. Les colorer selon leur valeur
 * ré-encoderait leur longueur et dépenserait le canal identité pour rien.
 * Une seule série : pas de boîte de légende, le titre suffit.
 */
export function BarresMagnitude({ lignes, formatValeur = nombre, variable = '--serie', maxVisible = 10 }) {
  const visibles = lignes.slice(0, maxVisible);
  const maximum = Math.max(...visibles.map((l) => l.valeur || 0), 1);

  return (
    <div className="space-y-2.5">
      {visibles.map((ligne) => (
        <div key={ligne.cle} className="grid grid-cols-[minmax(90px,26%)_1fr] items-center gap-3">
          <span className="truncate text-[13px] text-encre" title={ligne.libelle}>
            {ligne.libelle}
          </span>
          <div className="flex items-center gap-2">
            <div
              role="img"
              aria-label={`${ligne.libelle} : ${formatValeur(ligne.valeur)}`}
              title={`${ligne.libelle} : ${formatValeur(ligne.valeur)}`}
              style={{
                height: EPAISSEUR,
                width: `${Math.max((ligne.valeur / maximum) * 100, 0.5)}%`,
                background: `var(${variable})`,
                borderRadius: '2px 4px 4px 2px',
              }}
            />
            {/* Valeur à la pointe : l'axe ne porterait pas mieux. */}
            <span className="shrink-0 chiffres-alignes text-[13px] font-medium text-encre-2">
              {formatValeur(ligne.valeur)}
            </span>
          </div>
        </div>
      ))}
      {lignes.length > maxVisible && (
        <p className="pt-1 text-[13px] text-encre-attenuee">
          {lignes.length - maxVisible} autre(s) — voir la vue tableau
        </p>
      )}
    </div>
  );
}

// ===========================================================================
//  Jauge — un ratio contre une cible
// ===========================================================================

/**
 * Un seul rapport contre une limite : une jauge, pas un camembert à deux parts.
 * La piste et le remplissage sont la même teinte à deux clartés.
 */
export function Jauge({ valeur, etiquette, detail, cible = null }) {
  const part = Math.max(0, Math.min(Number(valeur) || 0, 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-encre-2">{etiquette}</span>
        <span className="chiffres-alignes text-lg font-bold text-encre">
          {pourcentage(part, { decimales: 1 })}
        </span>
      </div>
      <div className="relative mt-2 overflow-hidden rounded-full"
        style={{ height: 10, background: 'var(--grille)' }}
      >
        <div className="h-full rounded-full transition-all"
          style={{ width: `${part}%`, background: 'var(--marque)' }} />
        {cible !== null && (
          <div aria-hidden="true" className="absolute top-0 h-full"
            style={{ left: `${cible}%`, width: 2, background: 'var(--encre-2)' }} />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[13px] text-encre-attenuee">
        <span>{detail}</span>
        {cible !== null && <span>objectif {pourcentage(cible, { decimales: 0 })}</span>}
      </div>
    </div>
  );
}

// ===========================================================================
//  Évolution — courbe d'une série unique
// ===========================================================================

/**
 * Tendance dans le temps, une seule série : trait de 2 px, points ≥ 8 px avec
 * un anneau de 2 px à la couleur du fond, grille en filet plein (jamais
 * pointillé), et une étiquette directe seulement au dernier point.
 */
export function Courbe({ points, formatValeur = pourcentage, hauteur = 150, variable = '--marque' }) {
  const [survol, setSurvol] = useState(null);
  if (!points || points.length < 2) {
    return <p className="py-8 text-center text-sm text-encre-attenuee">Pas assez de périodes pour tracer une évolution.</p>;
  }

  const L = 100;
  const H = hauteur;
  const margeH = 28;
  const margeB = 22;
  const maximum = Math.max(...points.map((p) => p.valeur || 0), 1) * 1.1;

  const x = (i) => (i / (points.length - 1)) * (L - 4) + 2;
  const y = (v) => H - margeB - ((v || 0) / maximum) * (H - margeH - margeB);

  const chemin = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.valeur)}`).join(' ');
  const dernier = points.length - 1;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${L} ${H}`} preserveAspectRatio="none"
        className="w-full" style={{ height: hauteur }} role="img"
        aria-label={`Évolution : ${points.map((p) => `${p.libelle} ${formatValeur(p.valeur)}`).join(', ')}`}
      >
        {/* Grille : filet plein, une nuance au-dessus du fond */}
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1="0" x2={L} y1={y(maximum * f)} y2={y(maximum * f)}
            stroke="var(--grille)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
        ))}

        <path d={chemin} fill="none" stroke={`var(${variable})`} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

        {points.map((p, i) => (
          <g key={p.cle}>
            {/* Cible de survol large : viser un point de 8 px est impossible */}
            <rect x={x(i) - 4} y={0} width="8" height={H} fill="transparent"
              onMouseEnter={() => setSurvol(i)} onMouseLeave={() => setSurvol(null)} />
            <circle cx={x(i)} cy={y(p.valeur)} r={i === dernier || survol === i ? 4 : 2.5}
              fill={`var(${variable})`} stroke="var(--surface)" strokeWidth="2"
              vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>

      {/* Étiquettes d'axe : premier, dernier, et le point survolé */}
      <div className="mt-1 flex justify-between text-[12px] text-encre-attenuee">
        <span>{points[0].libelle}</span>
        <span className="font-medium text-encre">
          {survol !== null
            ? `${points[survol].libelle} · ${formatValeur(points[survol].valeur)}`
            : `${points[dernier].libelle} · ${formatValeur(points[dernier].valeur)}`}
        </span>
      </div>
    </div>
  );
}

export { xof, nombre, pourcentage };
