/**
 * Composants propres au travail de terrain : relevé GPS, prise de photo,
 * formulaire multi-taxes, bandeau d'état réseau.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, Image, Alert, ActivityIndicator, StyleSheet, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { couleurs, espacements, rayons, typographie, CIBLE_TACTILE, formaterDelai } from '../theme';
import { Bouton, Champ, Message, stylesUi } from './ui';
import CartePosition from './carte-position';
import {
  releverPosition, qualitePosition, suggererQuartier, PRECISION_ACCEPTABLE_M,
} from '../services/localisation';
import { TYPES_PHOTO, preparerPhoto } from '../services/photos';
import { useApp } from '../contextes/AppContexte';

// ===========================================================================
//  Bandeau d'état — visible en permanence
// ===========================================================================
export function BandeauEtat() {
  const { connexionFiable, etatSync, progression, lancerSynchronisation } = useApp();
  const enAttente = etatSync.en_attente + etatSync.photos_en_attente;

  if (progression) {
    return (
      <View style={[styles.bandeau, { backgroundColor: couleurs.primaireClair }]}>
        <ActivityIndicator size="small" color="#FFF" />
        <Text style={styles.bandeauTexte}>{progression.message}</Text>
      </View>
    );
  }

  if (!connexionFiable) {
    return (
      <View style={[styles.bandeau, { backgroundColor: couleurs.horsLigne }]}>
        <Ionicons name="cloud-offline" size={18} color="#FFF" />
        <Text style={styles.bandeauTexte}>
          Hors ligne — votre travail est enregistré sur le téléphone
          {enAttente > 0 ? ` (${enAttente} à envoyer)` : ''}
        </Text>
      </View>
    );
  }

  if (enAttente > 0) {
    return (
      <TouchableOpacity
        style={[styles.bandeau, { backgroundColor: couleurs.accent }]}
        onPress={() => lancerSynchronisation().catch(() => {})}
        accessibilityRole="button"
      >
        <Ionicons name="cloud-upload" size={18} color="#FFF" />
        <Text style={styles.bandeauTexte}>
          {enAttente} élément(s) à envoyer — appuyez pour synchroniser
        </Text>
      </TouchableOpacity>
    );
  }

  return null;
}

// ===========================================================================
//  Relevé de position
// ===========================================================================
export function ReleveurPosition({ position, onPosition, obligatoire = true, urlTuiles = null, rues = [] }) {
  const [enCours, setEnCours] = useState(false);
  const [etat, setEtat] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [suggestion, setSuggestion] = useState(null);

  const relever = useCallback(async () => {
    setEnCours(true);
    setErreur(null);
    setEtat(null);
    try {
      const p = await releverPosition({ surProgression: setEtat });
      const s = await suggererQuartier(p.longitude, p.latitude);
      setSuggestion(s);
      onPosition(p, s);
    } catch (err) {
      setErreur(err.message);
    } finally {
      setEnCours(false);
      setEtat(null);
    }
  }, [onPosition]);

  const qualite = position ? qualitePosition(position.precision_gps_m) : null;

  return (
    <View style={styles.blocPosition}>
      <View style={styles.enTeteBloc}>
        <Ionicons name="location" size={20} color={couleurs.primaire} />
        <Text style={typographie.sousTitre}>
          Position GPS
          {obligatoire && <Text style={{ color: couleurs.erreur }}> *</Text>}
        </Text>
      </View>

      {position ? (
        <View style={styles.positionRelevee}>
          <View style={{ flex: 1 }}>
            <Text style={typographie.monospace}>
              {position.latitude.toFixed(6)}, {position.longitude.toFixed(6)}
            </Text>
            <Text style={[typographie.petit, { color: qualite.couleur, fontWeight: '600' }]}>
              {qualite.libelle}
            </Text>
            {suggestion ? (
              <Text style={typographie.petit}>
                Quartier probable : {suggestion.quartier.nom}
                {!suggestion.fiable && ' (à confirmer)'}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={relever}
            style={styles.boutonReleverPetit}
            accessibilityLabel="Relever à nouveau la position"
          >
            <Ionicons name="refresh" size={22} color={couleurs.primaire} />
          </TouchableOpacity>
        </View>
      ) : (
        <Bouton
          titre={enCours ? 'Recherche du signal…' : 'Relever ma position'}
          icone="navigate"
          onPress={relever}
          charge={enCours}
          variante="secondaire"
        />
      )}

      {/* Le GPS ne suffit pas à désigner UNE devanture parmi dix : la carte
          laisse l'agent poser le point là où il voit la boutique. */}
      {position ? (
        <CartePosition
          position={position}
          urlTuiles={urlTuiles}
          rues={rues}
          onAjuste={(p) => onPosition({ ...position, ...p }, suggestion)}
        />
      ) : null}

      {enCours && etat ? (
        <Text style={[typographie.petit, { marginTop: espacements.s }]}>
          Précision actuelle : {etat.precision ? `${Math.round(etat.precision)} m` : 'recherche…'}
          {etat.precision > PRECISION_ACCEPTABLE_M
            && ' — patientez ou avancez de quelques pas'}
        </Text>
      ) : null}

      {/* Une position trop imprécise n'est pas bloquante : mieux vaut une
          fiche approximative qu'aucune fiche. Mais l'agent doit le savoir. */}
      {position && qualite.niveau === 'mauvaise' ? (
        <Message
          type="avertissement"
          texte="Signal GPS faible. Le commerce risque d'être mal placé sur la carte. Sortez à l'air libre et relevez à nouveau si possible."
        />
      ) : null}

      {erreur ? <Message type="erreur" texte={erreur} /> : null}
    </View>
  );
}

// ===========================================================================
//  Prise de photo
// ===========================================================================
export function PriseDePhoto({ type, commerceLocal, commerceId, position, photos, onAjout }) {
  const [permission, demanderPermission] = useCameraPermissions();
  const [appareilOuvert, setAppareilOuvert] = useState(false);
  const [enregistrement, setEnregistrement] = useState(false);
  const [camera, setCamera] = useState(null);

  const info = TYPES_PHOTO[type] ?? TYPES_PHOTO.autre;
  const dejaPrises = photos.filter((p) => p.type === type);

  const ouvrir = async () => {
    if (!permission?.granted) {
      const res = await demanderPermission();
      if (!res.granted) {
        Alert.alert(
          'Appareil photo indisponible',
          'Autorisez l\'accès à l\'appareil photo dans les réglages du téléphone pour photographier les devantures.',
        );
        return;
      }
    }
    setAppareilOuvert(true);
  };

  const capturer = async () => {
    if (!camera || enregistrement) return;
    setEnregistrement(true);
    try {
      const cliche = await camera.takePictureAsync({ quality: 1, skipProcessing: true });
      const photo = await preparerPhoto(cliche.uri, {
        commerceLocal,
        commerceId,
        type,
        longitude: position?.longitude,
        latitude: position?.latitude,
        precisionGps: position?.precision_gps_m,
      });
      setAppareilOuvert(false);
      onAjout(photo);
    } catch (err) {
      Alert.alert('Photo non enregistrée', err.message);
    } finally {
      setEnregistrement(false);
    }
  };

  if (appareilOuvert) {
    return (
      <View style={styles.camera}>
        <CameraView style={StyleSheet.absoluteFill} facing="back" ref={setCamera} />
        <View style={styles.cameraAide}>
          <Text style={styles.cameraAideTexte}>{info.aide}</Text>
        </View>
        <View style={styles.cameraBarre}>
          <TouchableOpacity
            onPress={() => setAppareilOuvert(false)}
            style={styles.cameraAnnuler}
            accessibilityLabel="Annuler la prise de photo"
          >
            <Ionicons name="close" size={30} color="#FFF" />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={capturer}
            disabled={enregistrement}
            style={styles.declencheur}
            accessibilityLabel="Prendre la photo"
          >
            {enregistrement
              ? <ActivityIndicator color={couleurs.primaire} />
              : <View style={styles.declencheurInterieur} />}
          </TouchableOpacity>

          <View style={{ width: 50 }} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.blocPhoto}>
      <View style={styles.enTeteBloc}>
        <Ionicons name="camera" size={20} color={couleurs.primaire} />
        <Text style={typographie.sousTitre}>
          {info.libelle}
          {info.obligatoire && <Text style={{ color: couleurs.erreur }}> *</Text>}
        </Text>
        {dejaPrises.length > 0 ? (
          <View style={styles.pastilleCompteur}>
            <Text style={styles.pastilleTexte}>{dejaPrises.length}</Text>
          </View>
        ) : null}
      </View>

      {dejaPrises.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ marginBottom: espacements.s }}
        >
          {dejaPrises.map((p) => (
            <Image
              key={p.id_local}
              source={{ uri: p.chemin ?? p.chemin_fichier }}
              style={styles.vignette}
            />
          ))}
        </ScrollView>
      ) : null}

      <Bouton
        titre={dejaPrises.length > 0 ? 'Ajouter une photo' : 'Prendre la photo'}
        icone="camera"
        variante="secondaire"
        onPress={ouvrir}
      />
      {info.aide ? (
        <Text style={[typographie.petit, { marginTop: espacements.xs }]}>{info.aide}</Text>
      ) : null}
    </View>
  );
}

// ===========================================================================
//  Formulaire multi-taxes
// ===========================================================================
/**
 * Saisie des taxes dues par un commerce.
 *
 * Choix important : l'application ne CALCULE PAS les montants. Elle recueille
 * les mesures (surface de trottoir occupée, surface d'enseigne…) et laisse le
 * serveur appliquer le barème. Dupliquer les règles fiscales ici garantirait
 * qu'un jour les deux calculs divergent — et c'est le commerçant qui recevrait
 * une quittance fausse.
 *
 * Le montant estimé n'est affiché qu'en ligne, via /taxes/simuler.
 */
export function FormulaireTaxes({ typesTaxes, categorie, valeurs, onChange, marcheChoisi }) {
  const [ouvertes, setOuvertes] = useState({});

  useEffect(() => {
    // Pré-cochage d'après la catégorie : un restaurant déborde presque
    // toujours sur le trottoir, une pharmacie jamais. L'agent garde la main.
    if (!categorie) return;
    const initial = {};
    if (categorie.todp_probable) initial.todp = true;
    if (categorie.enseigne_probable) initial.enseigne = true;
    if (categorie.sur_marche && marcheChoisi) initial.droit_place = true;
    setOuvertes((o) => ({ ...initial, ...o }));
  }, [categorie, marcheChoisi]);

  const basculer = (code, actif) => {
    setOuvertes((o) => ({ ...o, [code]: actif }));
    if (!actif) onChange(code, null);
  };

  const applicables = typesTaxes.filter((t) => {
    if (t.code === 'droit_place') return Boolean(marcheChoisi);
    return true;
  });

  return (
    <View>
      <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>
        Taxes applicables
      </Text>
      <Text style={[typographie.petit, { marginBottom: espacements.m }]}>
        Les montants sont calculés par la mairie d'après le barème en vigueur.
        Vous saisissez uniquement les mesures constatées.
      </Text>

      {applicables.map((taxe) => {
        const actif = ouvertes[taxe.code] ?? false;
        const demandeMesure = Boolean(taxe.parametre_requis);

        return (
          <View key={taxe.code} style={[styles.taxe, actif && styles.taxeActive]}>
            <TouchableOpacity
              onPress={() => basculer(taxe.code, !actif)}
              style={styles.taxeEnTete}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: actif }}
            >
              <Ionicons
                name={actif ? 'checkbox' : 'square-outline'}
                size={24}
                color={actif ? couleurs.primaire : couleurs.texteDesactive}
              />
              <View style={{ flex: 1, marginLeft: espacements.m }}>
                <Text style={[typographie.corps, { fontWeight: '600' }]}>
                  {taxe.libelle_court}
                </Text>
                {taxe.conditionnelle ? (
                  <Text style={typographie.petit}>
                    {taxe.code === 'todp'
                      ? 'Uniquement si le commerce déborde sur le trottoir'
                      : 'Selon constat sur place'}
                  </Text>
                ) : null}
              </View>
            </TouchableOpacity>

            {actif && demandeMesure ? (
              <View style={styles.taxeMesure}>
                <Champ
                  etiquette={
                    taxe.code === 'todp'
                      ? 'Surface occupée sur le trottoir'
                      : `Mesure (${taxe.parametre_unite ?? ''})`
                  }
                  valeur={valeurs[taxe.code] ?? ''}
                  onChangeText={(t) => onChange(taxe.code, t.replace(',', '.'))}
                  keyboardType="decimal-pad"
                  placeholder="0.0"
                  suffixe={taxe.parametre_unite ?? ''}
                  obligatoire
                  aide={taxe.code === 'todp'
                    ? 'Mesurez longueur × largeur du débordement. Photographiez-le également.'
                    : null}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// ===========================================================================
//  Résumé de synchronisation
// ===========================================================================
export function ResumeSync({ etat, onSynchroniser, occupe }) {
  const enAttente = etat.en_attente + etat.photos_en_attente;

  return (
    <View style={[stylesUi.carte, { marginBottom: espacements.l }]}>
      <View style={styles.ligneSync}>
        <Ionicons
          name={enAttente > 0 ? 'cloud-upload-outline' : 'cloud-done-outline'}
          size={30}
          color={enAttente > 0 ? couleurs.accent : couleurs.succes}
        />
        <View style={{ flex: 1, marginLeft: espacements.m }}>
          <Text style={typographie.sousTitre}>
            {enAttente > 0 ? `${enAttente} élément(s) à envoyer` : 'Tout est synchronisé'}
          </Text>
          <Text style={typographie.petit}>
            Dernière synchronisation : {formaterDelai(etat.derniere_sync)}
          </Text>
        </View>
      </View>

      {etat.conflits > 0 ? (
        <Message
          type="avertissement"
          titre={`${etat.conflits} conflit(s) à arbitrer`}
          texte="Ces fiches ont été modifiées à la fois sur votre téléphone et sur le serveur. Un superviseur doit trancher depuis le tableau de bord."
        />
      ) : null}

      <Bouton
        titre="Synchroniser maintenant"
        icone="sync"
        onPress={onSynchroniser}
        charge={occupe}
      />
    </View>
  );
}

// ===========================================================================
const styles = StyleSheet.create({
  bandeau: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espacements.s,
    paddingVertical: espacements.s,
    paddingHorizontal: espacements.l,
  },
  bandeauTexte: { color: '#FFF', fontSize: 14, fontWeight: '600', flex: 1 },

  enTeteBloc: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espacements.s,
    marginBottom: espacements.s,
  },
  blocPosition: {
    backgroundColor: couleurs.surfaceAlt,
    borderRadius: rayons.m,
    padding: espacements.l,
    marginBottom: espacements.l,
  },
  positionRelevee: { flexDirection: 'row', alignItems: 'center' },
  boutonReleverPetit: {
    width: CIBLE_TACTILE,
    height: CIBLE_TACTILE,
    alignItems: 'center',
    justifyContent: 'center',
  },

  blocPhoto: {
    backgroundColor: couleurs.surfaceAlt,
    borderRadius: rayons.m,
    padding: espacements.l,
    marginBottom: espacements.l,
  },
  vignette: {
    width: 84, height: 84, borderRadius: rayons.s, marginRight: espacements.s,
    backgroundColor: couleurs.bordure,
  },
  pastilleCompteur: {
    backgroundColor: couleurs.primaire,
    minWidth: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  pastilleTexte: { color: '#FFF', fontSize: 12, fontWeight: '700' },

  camera: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000', zIndex: 50 },
  cameraAide: {
    position: 'absolute', top: 60, left: 0, right: 0,
    paddingHorizontal: espacements.xl, alignItems: 'center',
  },
  cameraAideTexte: {
    color: '#FFF', fontSize: 15, textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)', padding: espacements.m, borderRadius: rayons.m,
  },
  cameraBarre: {
    position: 'absolute', bottom: 40, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
  },
  cameraAnnuler: {
    width: 50, height: 50, borderRadius: 25,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  declencheur: {
    width: 76, height: 76, borderRadius: 38,
    borderWidth: 5, borderColor: '#FFF',
    alignItems: 'center', justifyContent: 'center',
  },
  declencheurInterieur: {
    width: 58, height: 58, borderRadius: 29, backgroundColor: '#FFF',
  },

  taxe: {
    borderWidth: 1.5,
    borderColor: couleurs.bordure,
    borderRadius: rayons.m,
    marginBottom: espacements.s,
    backgroundColor: couleurs.surface,
  },
  taxeActive: { borderColor: couleurs.primaire },
  taxeEnTete: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: espacements.l,
    minHeight: CIBLE_TACTILE,
  },
  taxeMesure: {
    paddingHorizontal: espacements.l,
    paddingBottom: espacements.s,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: couleurs.bordure,
    paddingTop: espacements.m,
  },

  ligneSync: { flexDirection: 'row', alignItems: 'center', marginBottom: espacements.l },
});
