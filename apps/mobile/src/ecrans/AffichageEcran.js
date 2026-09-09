/**
 * Recensement d'un dispositif d'affichage.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUI DIFFÈRE DU RECENSEMENT D'UN COMMERCE
 *
 *  Le balayage est SYSTÉMATIQUE ET RUE PAR RUE, pas redevable par redevable.
 *  L'agent remonte une rue et saisit tout ce qui est apposé : enseignes,
 *  auvents, pré-enseignes, panneaux. Beaucoup n'ont aucune devanture
 *  derrière eux — un panneau de régie appartient à une société qui n'a pas
 *  de commerce dans la commune.
 *
 *  D'où deux différences :
 *   · la rue est portée par le dispositif, pas héritée d'un commerce ;
 *   · le redevable est soit celui du commerce, soit désigné explicitement.
 *
 *  LA PHOTO CADRE LA FAÇADE ENTIÈRE, pas le seul panneau. Sans le contexte,
 *  une surface annoncée est invérifiable : un cliché serré ne permet à
 *  personne, six mois plus tard, de dire si le support faisait 2 ou 6 m².
 *
 *  AFF-06 — les plaques réglementées de notaires, avocats et médecins — est
 *  absent de la liste : le serveur ne l'envoie pas dans le paquet hors-ligne
 *  tant que leur assujettissement n'est pas tranché avec la municipalité.
 * ─────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Alert, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';

import { useApp } from '../contextes/AppContexte';
import { referentielsComplets, lireReferentiel } from '../bdd/sync.repo';
import { creerAffichage } from '../bdd/objets.repo';
import { quartiersParProximite } from '../services/localisation';
import {
  Bouton, Champ, Selecteur, Message, Chargement, Separateur, useMargeBasse,
} from '../composants/ui';
import { ReleveurPosition, PriseDePhoto } from '../composants/terrain';
import { SelecteurRue } from '../composants/rue';
import { couleurs, espacements, typographie } from '../theme';

export function AffichageEcran({ navigation, route }) {
  // Sans elle, le dernier bouton se cache sous la barre système d'Android.
  const margeBasse = useMargeBasse();
  const { lancerSynchronisation, connexionFiable } = useApp();

  // Quand l'écran est ouvert depuis une fiche commerce, le support est déjà
  // rattaché : l'agent n'a plus qu'à mesurer.
  const commerce = route?.params?.commerce ?? null;

  const [referentiels, setReferentiels] = useState(null);
  const [rues, setRues] = useState([]);
  const [position, setPosition] = useState(null);
  const [quartiers, setQuartiers] = useState([]);

  const [form, setForm] = useState({
    type_affichage_id: null,
    rue_id: null,
    quartier_id: null,
    surface_m2: '',
    largeur_m: '',
    hauteur_m: '',
    nb_faces: 1,
    texte_affiche: '',
    adresse_libelle: '',
    numero_autorisation: '',
    notes: '',
  });
  const [photos, setPhotos] = useState([]);
  const [idLocal, setIdLocal] = useState(null);
  const [erreurs, setErreurs] = useState({});
  const [enregistre, setEnregistre] = useState(false);

  useEffect(() => {
    (async () => {
      setReferentiels(await referentielsComplets());
      setRues(await lireReferentiel('rues', []));
    })();
  }, []);

  const majForm = (champ, valeur) => {
    setForm((f) => ({ ...f, [champ]: valeur }));
    setErreurs((e) => ({ ...e, [champ]: null }));
  };

  // -------------------------------------------------------------------------
  // Surface déduite des dimensions
  //
  // L'agent mesure au décamètre : largeur et hauteur sont ce qu'il relève.
  // Recalculer la surface évite l'erreur de multiplication mentale, faite
  // debout, au soleil, avec un carnet dans une main.
  // -------------------------------------------------------------------------
  const surDimension = (champ, valeur) => {
    const suivant = { ...form, [champ]: valeur };
    const l = parseFloat(String(suivant.largeur_m).replace(',', '.'));
    const h = parseFloat(String(suivant.hauteur_m).replace(',', '.'));
    if (Number.isFinite(l) && Number.isFinite(h) && l > 0 && h > 0) {
      suivant.surface_m2 = (l * h).toFixed(2);
    }
    setForm(suivant);
    setErreurs((e) => ({ ...e, surface_m2: null }));
  };

  const surPosition = useCallback(async (p) => {
    setPosition(p);
    const proches = await quartiersParProximite(p.longitude, p.latitude);
    setQuartiers(proches);
    if (proches[0] && !form.quartier_id) majForm('quartier_id', proches[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.quartier_id]);

  // -------------------------------------------------------------------------
  const valider = () => {
    const e = {};
    if (!form.type_affichage_id) e.type_affichage_id = 'Choisissez le type de dispositif';

    const surface = parseFloat(String(form.surface_m2).replace(',', '.'));
    if (!Number.isFinite(surface) || surface <= 0) {
      e.surface_m2 = 'Mesurez la surface, ou saisissez largeur et hauteur';
    } else if (surface > 200) {
      // 200 m² : plus grand que n'importe quel panneau urbain. C'est une
      // virgule oubliée, pas une mesure.
      e.surface_m2 = 'Surface improbable — vérifiez l\'unité et la virgule';
    }

    // Sans commerce ET sans rue, le dispositif est irretrouvable sur le
    // terrain : ni devanture pour l'identifier, ni voie pour y revenir.
    if (!commerce && !form.rue_id && rues.length > 0) {
      e.rue_id = 'Indiquez la rue : sans commerce rattaché, c\'est le seul repère';
    }

    setErreurs(e);
    return Object.keys(e).length === 0;
  };

  const enregistrer = async () => {
    if (!valider()) return;

    try {
      const id = await creerAffichage({
        type_affichage_id: form.type_affichage_id,
        commerce_local: commerce?.id_local ?? null,
        commerce_serveur: commerce?.id_serveur ?? null,
        rue_id: form.rue_id,
        quartier_id: form.quartier_id,
        adresse_libelle: form.adresse_libelle || null,
        longitude: position?.longitude ?? null,
        latitude: position?.latitude ?? null,
        precision_gps_m: position?.precision_gps_m ?? null,
        surface_m2: parseFloat(String(form.surface_m2).replace(',', '.')),
        largeur_m: form.largeur_m ? parseFloat(String(form.largeur_m).replace(',', '.')) : null,
        hauteur_m: form.hauteur_m ? parseFloat(String(form.hauteur_m).replace(',', '.')) : null,
        nb_faces: form.nb_faces,
        lumineux: estLumineux(referentiels, form.type_affichage_id),
        texte_affiche: form.texte_affiche || null,
        numero_autorisation: form.numero_autorisation || null,
        notes: form.notes || null,
      });

      setIdLocal(id);
      setEnregistre(true);
      if (connexionFiable) lancerSynchronisation({ silencieux: true });
    } catch (err) {
      Alert.alert('Enregistrement impossible', err.message);
    }
  };

  if (!referentiels) return <Chargement texte="Préparation…" />;

  const types = referentiels.types_affichage ?? [];

  if (types.length === 0) {
    return (
      <View style={styles.vide}>
        <Message
          type="avertissement"
          titre="Référentiel absent"
          texte={'Les types de dispositifs ne sont pas encore chargés sur ce téléphone. '
                 + 'Synchronisez depuis l\'onglet Outils.'}
          action={<Bouton titre="Retour" variante="secondaire" onPress={() => navigation.goBack()} />}
        />
      </View>
    );
  }

  // -------------------------------------------------------------------------
  if (enregistre) {
    return (
      <View style={styles.vide}>
        <Message
          type="succes"
          titre="Dispositif enregistré"
          texte={commerce
            ? `Rattaché à ${commerce.enseigne}. Il partira à la prochaine synchronisation.`
            : 'Il partira à la prochaine synchronisation.'}
        />
        <PriseDePhoto
          type="facade"
          commerceLocal={commerce?.id_local ?? null}
          commerceId={commerce?.id_serveur ?? null}
          position={position}
          photos={photos}
          onAjout={setPhotos}
        />
        <Text style={styles.aidePhoto}>
          Cadrez la façade entière, pas seulement le support : sans le contexte,
          la surface annoncée est invérifiable.
        </Text>

        <Bouton titre="Recenser un autre dispositif" onPress={() => {
          setEnregistre(false);
          setIdLocal(null);
          setPhotos([]);
          setForm((f) => ({
            ...f,
            surface_m2: '', largeur_m: '', hauteur_m: '',
            texte_affiche: '', numero_autorisation: '', notes: '',
          }));
        }} />
        <Bouton titre="Terminer" variante="secondaire" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.ecran}
        contentContainerStyle={[styles.contenu, { paddingBottom: margeBasse }]}
        keyboardShouldPersistTaps="handled"
      >
        {commerce ? (
          <View style={styles.rattachement}>
            <Text style={styles.rattachementTitre}>Rattaché à</Text>
            <Text style={styles.rattachementNom}>{commerce.enseigne}</Text>
            {commerce.code ? <Text style={styles.rattachementCode}>{commerce.code}</Text> : null}
          </View>
        ) : (
          <Message
            type="info"
            titre="Support autonome"
            texte={'Aucun commerce rattaché : le redevable sera identifié depuis le '
                   + 'tableau de bord. C\'est le cas normal pour un panneau de régie.'}
          />
        )}

        <Separateur titre="Localisation" />
        <ReleveurPosition position={position} onPosition={surPosition} obligatoire={false} />

        <SelecteurRue
          rues={rues}
          valeur={form.rue_id}
          onChange={(v) => majForm('rue_id', v)}
          position={position ? { ...position, quartier_id: form.quartier_id } : null}
          obligatoire={!commerce}
        />
        {erreurs.rue_id ? <Text style={styles.erreur}>{erreurs.rue_id}</Text> : null}

        {quartiers.length > 0 ? (
          <Selecteur
            etiquette="Quartier"
            options={quartiers}
            valeur={form.quartier_id}
            onChange={(v) => majForm('quartier_id', v)}
            cleLibelle="nom"
          />
        ) : null}

        <Champ
          etiquette="Repère"
          valeur={form.adresse_libelle}
          onChangeText={(v) => majForm('adresse_libelle', v)}
          placeholder="En face de la pharmacie, angle de la rue…"
        />

        <Separateur titre="Le dispositif" />
        <Selecteur
          etiquette="Type"
          options={types}
          valeur={form.type_affichage_id}
          onChange={(v) => majForm('type_affichage_id', v)}
          obligatoire
        />
        {erreurs.type_affichage_id
          ? <Text style={styles.erreur}>{erreurs.type_affichage_id}</Text> : null}

        <View style={styles.dimensions}>
          <View style={{ flex: 1 }}>
            <Champ
              etiquette="Largeur (m)"
              valeur={form.largeur_m}
              onChangeText={(v) => surDimension('largeur_m', v)}
              keyboardType="decimal-pad"
              placeholder="2,50"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Champ
              etiquette="Hauteur (m)"
              valeur={form.hauteur_m}
              onChangeText={(v) => surDimension('hauteur_m', v)}
              keyboardType="decimal-pad"
              placeholder="1,20"
            />
          </View>
        </View>

        <Champ
          etiquette="Surface (m²)"
          valeur={String(form.surface_m2)}
          onChangeText={(v) => majForm('surface_m2', v)}
          keyboardType="decimal-pad"
          obligatoire
          erreur={erreurs.surface_m2}
          aide="Calculée si vous saisissez largeur et hauteur. Modifiable pour une forme irrégulière."
        />

        <Selecteur
          etiquette="Nombre de faces"
          options={[
            { id: 1, libelle: 'Une face' },
            { id: 2, libelle: 'Recto-verso', detail: 'surface comptée deux fois' },
          ]}
          valeur={form.nb_faces}
          onChange={(v) => majForm('nb_faces', v ?? 1)}
          horizontal
        />

        <Champ
          etiquette="Texte affiché"
          valeur={form.texte_affiche}
          onChangeText={(v) => majForm('texte_affiche', v)}
          placeholder="Ce qui est écrit sur le support"
        />

        <Champ
          etiquette="N° d'autorisation"
          valeur={form.numero_autorisation}
          onChangeText={(v) => majForm('numero_autorisation', v)}
          placeholder="Si une autorisation est présentée"
        />

        <Champ
          etiquette="Observations"
          valeur={form.notes}
          onChangeText={(v) => majForm('notes', v)}
          multiline
        />

        <Bouton titre="Enregistrer le dispositif" onPress={enregistrer} />
        <Text style={styles.rappel}>
          La photo se prend juste après l&apos;enregistrement, une fois la fiche créée.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Le caractère lumineux découle du type choisi (AFF-01), il n'est pas ressaisi.
 * Deux champs disant la même chose finissent par se contredire, et c'est
 * alors le montant facturé qui tranche.
 */
function estLumineux(referentiels, typeId) {
  const type = (referentiels?.types_affichage ?? []).find((t) => t.id === typeId);
  return type?.code === 'AFF-01';
}

const styles = StyleSheet.create({
  ecran: { flex: 1, backgroundColor: couleurs.fond },
  contenu: { padding: espacements.l, paddingBottom: espacements.xxl },
  vide: { flex: 1, padding: espacements.l, backgroundColor: couleurs.fond, gap: espacements.m },

  rattachement: {
    padding: espacements.m, borderRadius: 10,
    backgroundColor: couleurs.surfaceAlt, marginBottom: espacements.m,
  },
  rattachementTitre: { ...typographie.petit, color: couleurs.texteSecondaire },
  rattachementNom: { ...typographie.sousTitre },
  rattachementCode: { ...typographie.petit, color: couleurs.texteSecondaire },

  dimensions: { flexDirection: 'row', gap: espacements.m },
  erreur: {
    ...typographie.petit, color: couleurs.erreur,
    marginTop: -espacements.s, marginBottom: espacements.s,
  },
  rappel: {
    ...typographie.petit, color: couleurs.texteSecondaire,
    textAlign: 'center', marginTop: espacements.s,
  },
  aidePhoto: {
    ...typographie.petit, color: couleurs.texteSecondaire, lineHeight: 18,
  },
});
