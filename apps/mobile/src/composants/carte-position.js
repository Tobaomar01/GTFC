/**
 * Placement du point sur une carte — le geste de Google Maps.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POURQUOI CE COMPOSANT EXISTE
 *
 *  Le GPS d'un téléphone donne 30 m dans une rue commerçante, davantage sous
 *  les tôles d'un marché. Trente mètres, à Colobane, c'est une dizaine de
 *  devantures : le point désigne « ce pâté de maisons », pas « cette
 *  boutique ». Un registre fiscal à cette précision ne permet ni de
 *  retrouver un commerce, ni de contester utilement une taxation.
 *
 *  Durcir le seuil GPS ne résoudrait rien : sous une toiture, un téléphone
 *  n'atteint jamais 5 m, et l'agent resterait bloqué devant un écran qui
 *  refuse d'enregistrer.
 *
 *  La réponse est l'œil de l'agent. Le GPS centre la carte, l'agent
 *  reconnaît la devanture et amène le repère dessus.
 *
 *  LE RÉTICULE EST FIXE, LA CARTE GLISSE DESSOUS. Un marqueur qu'on fait
 *  glisser se retrouve sous le doigt au moment précis où il faut viser.
 *  C'est le choix de Google Maps, et il est juste.
 *
 *  SOUVERAINETÉ ET HORS LIGNE. Leaflet est embarqué dans l'application,
 *  aucun script distant. Les tuiles viennent du serveur communal. Sans
 *  tuiles — hors ligne, ou fond pas encore généré — la carte affiche une
 *  grille de repérage plutôt qu'un écran blanc, et le repère reste
 *  déplaçable : l'agent sait où il est, même sans image.
 *
 *  L'ORIGINE EST TRACÉE. Un point posé à la main est enregistré comme tel.
 *  Il vaut mieux qu'une mesure automatique — quelqu'un était sur place —
 *  mais on doit pouvoir distinguer les deux.
 * ─────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { couleurs, espacements, typographie, rayons } from '../theme';
import { LEAFLET_CSS, LEAFLET_JS } from './leaflet-embarque';

/** Zoom 19 : on distingue les devantures. Au-delà, les tuiles manquent. */
const ZOOM_DEFAUT = 19;
const ZOOM_MAX = 21;

/** Distance approximative entre deux points, en mètres. */
function distanceM(a, b) {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const x = dLon * Math.cos(lat);
  return Math.round(Math.sqrt(dLat * dLat + x * x) * R);
}

function pageCarte({ longitude, latitude, urlTuiles, rues }) {
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>${LEAFLET_CSS}
  html,body,#c{height:100%;margin:0;background:#E4E6E1;overflow:hidden}
  /* Sans tuiles, une grille vaut mieux qu'un écran blanc : l'agent voit
     que la carte fonctionne et que seul le fond manque. */
  #c.sans-fond{background-image:
      linear-gradient(rgba(0,0,0,.05) 1px,transparent 1px),
      linear-gradient(90deg,rgba(0,0,0,.05) 1px,transparent 1px);
    background-size:26px 26px}
  .reticule{position:absolute;inset:0;pointer-events:none;z-index:500;
    display:flex;align-items:center;justify-content:center}
  .reticule svg{transform:translateY(-21px);
    filter:drop-shadow(0 3px 4px rgba(0,0,0,.45))}
  /* Un point d'ancrage au sol : sans lui, on ne sait pas quel pixel la
     pointe de l'épingle désigne réellement. */
  .ancre{position:absolute;left:50%;top:50%;width:8px;height:8px;
    margin:-4px 0 0 -4px;border-radius:50%;
    background:rgba(11,93,43,.9);box-shadow:0 0 0 2px #fff;z-index:499}
  .leaflet-control-zoom a{width:38px;height:38px;line-height:38px;
    font-size:20px;color:#12261A}
  .leaflet-control-attribution{font-size:9px;background:rgba(255,255,255,.7)}
  .nom-rue{font-size:11px;font-weight:600;background:#fff;border:1px solid #D3DAD2;
    color:#16211A;padding:2px 6px}
</style></head><body>
<div id="c" class="${urlTuiles ? '' : 'sans-fond'}"></div>
<div class="ancre"></div>
<div class="reticule">
  <svg width="32" height="44" viewBox="0 0 32 44">
    <path d="M16 43 C16 43 30 26 30 15 A14 14 0 1 0 2 15 C2 26 16 43 16 43 Z"
          fill="#0B5D2B" stroke="#fff" stroke-width="2.5"/>
    <circle cx="16" cy="15" r="4.5" fill="#fff"/>
  </svg>
</div>
<script>${LEAFLET_JS}</script>
<script>
  var carte = L.map('c', {
    zoomControl: true, attributionControl: ${urlTuiles ? 'true' : 'false'},
    doubleClickZoom: true, tap: true
  }).setView([${latitude}, ${longitude}], ${ZOOM_DEFAUT});

  ${urlTuiles ? `L.tileLayer(${JSON.stringify(urlTuiles)}, {
      maxZoom: ${ZOOM_MAX}, maxNativeZoom: 19,
      attribution: 'Commune de Gueule Tapée-Fass-Colobane'
    }).addTo(carte);` : ''}

  // Le dessin des rues, que la commune possède.
  //
  // Sans fond de plan — hors ligne, ou tuiles pas encore générées — c'est ce
  // qui permet à l'agent de se repérer : il reconnaît sa rue et
  // l'intersection la plus proche, et pose le point en connaissance de
  // cause. Une grille abstraite ne lui apprendrait rien.
  var rues = ${rues};
  if (rues && rues.length) {
    var couche = L.geoJSON(
      { type: 'FeatureCollection', features: rues },
      {
        style: { color: '#4A6FA5', weight: 3, opacity: .75 },
        onEachFeature: function (f, l) {
          if (f.properties && f.properties.nom) {
            l.bindTooltip(f.properties.nom, {
              permanent: false, direction: 'top', className: 'nom-rue'
            });
          }
        }
      }
    ).addTo(carte);
    couche.bringToBack();
  }

  // Position d'origine du GPS, gardée en repère : l'agent voit d'où il
  // part et de combien il s'écarte.
  L.circle([${latitude}, ${longitude}], {
    radius: 8, color: '#7A8B80', weight: 1,
    fillColor: '#7A8B80', fillOpacity: .25
  }).addTo(carte);

  function envoyer(fin) {
    var c = carte.getCenter();
    window.ReactNativeWebView.postMessage(JSON.stringify({
      longitude: c.lng, latitude: c.lat, zoom: carte.getZoom(), fin: !!fin
    }));
  }
  carte.on('move', function(){ envoyer(false); });
  carte.on('moveend', function(){ envoyer(true); });

  // Recentrage sur la position GPS d'origine.
  window.recentrer = function () {
    carte.setView([${latitude}, ${longitude}], ${ZOOM_DEFAUT});
  };
</script></body></html>`;
}

export default function CartePosition({ position, urlTuiles = null, rues = [], onAjuste }) {
  const [courante, setCourante] = useState(null);
  const [prete, setPrete] = useState(false);
  const vue = useRef(null);
  const depart = useRef({ longitude: position.longitude, latitude: position.latitude });

  // Les rues arrivent du référentiel hors ligne, avec leur tracé simplifié.
  // On ne garde que celles qui en ont un : une rue sans géométrie — ajoutée
  // d'après le PDC, jamais relevée — n'a rien à dessiner.
  const traces = useMemo(() => JSON.stringify(
    (rues ?? [])
      .filter((r) => r.trace)
      .map((r) => ({
        type: 'Feature',
        geometry: typeof r.trace === 'string' ? JSON.parse(r.trace) : r.trace,
        properties: { nom: r.nom },
      })),
  ), [rues]);

  const html = useMemo(
    () => pageCarte({ ...depart.current, urlTuiles, rues: traces }),
    [urlTuiles, traces],
  );

  const surMessage = useCallback((evenement) => {
    let p;
    try { p = JSON.parse(evenement.nativeEvent.data); }
    catch { return; }   // message illisible : ignorer plutôt que planter
    setCourante(p);
    if (!p.fin) return; // on ne remonte qu'à la fin du geste
    onAjuste({
      longitude: p.longitude,
      latitude: p.latitude,
      // La précision devient celle de ce que l'agent reconnaît, pas du capteur.
      precision_gps_m: 2,
      origine: 'saisie_manuelle',
    });
  }, [onAjuste]);

  const ecart = courante ? distanceM(depart.current, courante) : 0;
  const deplace = ecart >= 1;

  return (
    <View style={styles.bloc}>
      <View style={styles.enTete}>
        <Ionicons name="pin" size={18} color={couleurs.primaire} />
        <Text style={typographie.sousTitre}>Placer le point sur la devanture</Text>
      </View>

      <View style={styles.cadre}>
        <WebView
          ref={vue}
          originWhitelist={['*']}
          source={{ html }}
          style={styles.carte}
          onMessage={surMessage}
          onLoadEnd={() => setPrete(true)}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          allowFileAccess
        />

        {!prete ? (
          <View style={styles.chargement}>
            <ActivityIndicator color={couleurs.primaire} />
          </View>
        ) : null}

        <TouchableOpacity
          style={styles.boutonRecentrer}
          accessibilityLabel="Revenir à la position GPS"
          onPress={() => vue.current?.injectJavaScript('window.recentrer(); true;')}
        >
          <Ionicons name="locate" size={20} color={couleurs.primaire} />
        </TouchableOpacity>
      </View>

      <Text style={[typographie.petit, styles.aide]}>
        {urlTuiles
          ? 'Faites glisser la carte pour amener le repère sur la boutique.'
          : 'Pas de fond de plan, mais le tracé des rues est affiché. '
            + 'Repérez-vous dessus et amenez le repère sur la boutique.'}
      </Text>

      {deplace ? (
        <View style={styles.confirme}>
          <Ionicons name="checkmark-circle" size={16} color={couleurs.succes} />
          <Text style={[typographie.petit, { color: couleurs.succes, flex: 1 }]}>
            Point déplacé de {ecart} m et posé à la main — plus fiable qu&apos;une
            mesure automatique, et enregistré comme tel.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bloc: { marginTop: espacements.m },
  enTete: {
    flexDirection: 'row', alignItems: 'center',
    gap: espacements.s, marginBottom: espacements.s,
  },
  cadre: {
    height: 280, borderRadius: rayons.m, overflow: 'hidden',
    borderWidth: 1, borderColor: couleurs.bordure,
  },
  carte: { flex: 1 },
  chargement: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#E4E6E1',
  },
  boutonRecentrer: {
    position: 'absolute', right: espacements.s, bottom: espacements.s,
    width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: couleurs.bordure,
  },
  aide: { marginTop: espacements.s, color: couleurs.texteSecondaire },
  confirme: {
    flexDirection: 'row', alignItems: 'center',
    gap: espacements.xs, marginTop: espacements.s,
  },
});
