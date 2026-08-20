'use client';

/**
 * Carte OpenStreetMap des commerces.
 *
 * Leaflet touche directement au DOM et à `window` : ce composant est chargé
 * dynamiquement, sans rendu côté serveur (voir CarteDynamique).
 *
 * Les marqueurs portent les couleurs de STATUT du cahier des charges — vert,
 * orange, rouge — mais jamais seules : chaque marqueur porte aussi un symbole,
 * la légende est permanente, et l'infobulle donne le libellé. Un daltonien, un
 * écran en plein soleil ou une impression noir et blanc restent lisibles.
 *
 * Le regroupement de marqueurs est indispensable : 5 443 points individuels
 * figeraient le navigateur d'un poste de mairie.
 */
import { useEffect, useRef, useState } from 'react';
import { STATUTS, xof } from '@/lib/format';

const CENTRE_DEFAUT = [14.6862, -17.4470];   // Gueule Tapée-Fass-Colobane

export default function CarteCommerces({ commerces = [], surSelection = null, hauteur = 560 }) {
  const conteneur = useRef(null);
  const carte = useRef(null);
  const couche = useRef(null);
  const [pret, setPret] = useState(false);
  const [erreur, setErreur] = useState(null);

  // --- Initialisation, une seule fois -------------------------------------
  useEffect(() => {
    let annule = false;

    (async () => {
      try {
        const L = (await import('leaflet')).default;
        await import('leaflet/dist/leaflet.css');
        await import('leaflet.markercluster');
        await import('leaflet.markercluster/dist/MarkerCluster.css');
        await import('leaflet.markercluster/dist/MarkerCluster.Default.css');

        if (annule || !conteneur.current || carte.current) return;

        carte.current = L.map(conteneur.current, {
          center: CENTRE_DEFAUT,
          zoom: 15,
          zoomControl: true,
          attributionControl: true,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          // Attribution obligatoire : OpenStreetMap est sous licence ODbL.
          attribution: '&copy; contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(carte.current);

        setPret(true);
      } catch (err) {
        setErreur(
          'La carte n\'a pas pu être chargée. Vérifiez que le serveur accède bien '
          + 'à openstreetmap.org — c\'est le seul appel sortant du tableau de bord.',
        );
      }
    })();

    return () => {
      annule = true;
      if (carte.current) { carte.current.remove(); carte.current = null; }
    };
  }, []);

  // --- Marqueurs, à chaque changement de données ---------------------------
  useEffect(() => {
    if (!pret || !carte.current) return undefined;
    let annule = false;

    (async () => {
      const L = (await import('leaflet')).default;
      if (annule || !carte.current) return;

      if (couche.current) { carte.current.removeLayer(couche.current); couche.current = null; }

      const groupe = L.markerClusterGroup({
        maxClusterRadius: 45,
        showCoverageOnHover: false,
        // Un agrégat prend la couleur de l'état LE PLUS GRAVE qu'il contient :
        // une pastille verte cachant douze impayés serait un contresens.
        iconCreateFunction: (agregat) => {
          const marqueurs = agregat.getAllChildMarkers();
          const pire = marqueurs.some((m) => m.options.statut === 'impaye') ? 'impaye'
            : marqueurs.some((m) => m.options.statut === 'partiel') ? 'partiel'
              : marqueurs.some((m) => m.options.statut === 'a_jour') ? 'a_jour' : 'inconnu';
          const s = STATUTS[pire];
          const n = agregat.getChildCount();
          const taille = n < 10 ? 34 : n < 100 ? 40 : 46;

          return L.divIcon({
            html: `<div style="
                background: var(${s.variable});
                color: #fff; width:${taille}px; height:${taille}px;
                border-radius: 50%; display:flex; align-items:center; justify-content:center;
                font-weight:700; font-size:${n < 100 ? 13 : 12}px;
                box-shadow: 0 0 0 2px var(--surface), 0 2px 6px rgba(0,0,0,.3);
              ">${n}</div>`,
            className: 'agregat-commerces',
            iconSize: [taille, taille],
          });
        },
      });

      for (const c of commerces) {
        if (c.latitude == null || c.longitude == null) continue;
        const s = STATUTS[c.statut_fiscal] ?? STATUTS.inconnu;

        const marqueur = L.marker([c.latitude, c.longitude], {
          statut: c.statut_fiscal,
          // Symbole + couleur, et un anneau de 2 px à la couleur du fond pour
          // que deux marqueurs qui se chevauchent restent distincts.
          icon: L.divIcon({
            html: `<div style="
                background: var(${s.variable}); color:#fff;
                width:22px; height:22px; border-radius:50%;
                display:flex; align-items:center; justify-content:center;
                font-size:12px; font-weight:700; line-height:1;
                box-shadow: 0 0 0 2px var(--surface), 0 1px 3px rgba(0,0,0,.35);
              ">${s.icone}</div>`,
            className: 'marqueur-commerce',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        });

        marqueur.bindPopup(`
          <div style="min-width:190px">
            <div style="font-weight:700;margin-bottom:2px">${echapper(c.enseigne)}</div>
            <div style="font-family:monospace;font-size:12px;color:var(--encre-2)">${echapper(c.code)}</div>
            <div style="margin-top:6px;font-size:13px">
              <span style="color:var(${s.variable});font-weight:600">${s.icone} ${s.libelle}</span>
            </div>
            <div style="font-size:13px;color:var(--encre-2);margin-top:2px">
              ${echapper(c.categorie ?? '')}<br>${echapper(c.quartier ?? '')}
            </div>
            ${Number(c.solde_du) > 0
    ? `<div style="margin-top:6px;font-weight:600;color:var(--st-impaye)">${xof(c.solde_du)} dus</div>`
    : ''}
          </div>
        `);

        if (surSelection) marqueur.on('click', () => surSelection(c));
        groupe.addLayer(marqueur);
      }

      groupe.addTo(carte.current);
      couche.current = groupe;

      // On cadre sur les données plutôt que sur un centre fixe : une commune
      // dont les polygones ne sont pas encore chargés reste bien cadrée.
      if (commerces.length > 0) {
        const bornes = groupe.getBounds();
        if (bornes.isValid()) carte.current.fitBounds(bornes, { padding: [40, 40], maxZoom: 17 });
      }
    })();

    return () => { annule = true; };
  }, [pret, commerces, surSelection]);

  if (erreur) {
    return (
      <div className="flex items-center justify-center rounded-carte border border-bordure bg-surface-alt p-8 text-center text-sm text-encre-2"
        style={{ height: hauteur }}
      >
        {erreur}
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-carte border border-bordure"
      style={{ height: hauteur }}
    >
      <div ref={conteneur} className="h-full w-full" />
      {!pret && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-alt text-sm text-encre-2">
          Chargement de la carte…
        </div>
      )}
    </div>
  );
}

const echapper = (t) => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
