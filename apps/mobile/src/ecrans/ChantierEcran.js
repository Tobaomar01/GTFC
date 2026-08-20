/**
 * Constat d'un chantier occupant le domaine public.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  RECENSEMENT SEUL PENDANT LE PILOTE
 *
 *  Aucun montant n'est calculé, aucune facture n'est émise : la commune n'a
 *  pas encore délibéré de tarif d'occupation temporaire.
 *
 *  Tous les champs de calcul sont pourtant collectés dès maintenant. Un
 *  chantier dure quelques semaines : le jour où le tarif existera, ceux de
 *  cette année seront refermés depuis longtemps et aucun repassage ne
 *  permettra de reconstituer une emprise ou une durée.
 *
 *  L'agent doit le savoir, et le dire au promoteur qui le lui demandera.
 *  L'écran l'affiche donc explicitement, plutôt que de laisser croire à une
 *  facture qui ne viendra pas.
 *
 *  LA FICHE EST À DURÉE DÉTERMINÉE. Elle se clôt sur constat de fin, ce qui
 *  suppose un repassage. D'où la date de fin prévue, qui alimente la liste
 *  des chantiers à revoir côté superviseur.
 * ─────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Alert, StyleSheet, TouchableOpacity,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../contextes/AppContexte';
import { referentielsComplets, lireReferentiel } from '../bdd/sync.repo';
import { creerChantier } from '../bdd/objets.repo';
import { quartiersParProximite } from '../services/localisation';
import {
  Bouton, Champ, Selecteur, Message, Chargement, Separateur,
} from '../composants/ui';
import { ReleveurPosition, PriseDePhoto } from '../composants/terrain';
import { SelecteurRue } from '../composants/rue';
import {
  couleurs, espacements, typographie, rayons, CIBLE_TACTILE,
} from '../theme';

export function ChantierEcran({ navigation }) {
  const { lancerSynchronisation, connexionFiable } = useApp();

  const [referentiels, setReferentiels] = useState(null);
  const [rues, setRues] = useState([]);
  const [position, setPosition] = useState(null);
  const [quartiers, setQuartiers] = useState([]);

  const [form, setForm] = useState({
    libelle: '',
    types: [],
    rue_id: null,
    quartier_id: null,
    adresse_libelle: '',
    surface_m2: '',
    duree_prevue_jours: '',
    numero_autorisation: '',
    autorisation_vue: false,
    notes: '',
  });
  const [photos, setPhotos] = useState([]);
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

  // Un chantier cumule les formes d'occupation : dépôt de sable ET benne ET
  // échafaudage. Un choix unique obligerait l'agent à trancher arbitrairement,
  // et l'emprise réelle serait sous-estimée.
  const basculerType = (id) => {
    setForm((f) => ({
      ...f,
      types: f.types.includes(id) ? f.types.filter((t) => t !== id) : [...f.types, id],
    }));
    setErreurs((e) => ({ ...e, types: null }));
  };

  const surPosition = useCallback(async (p) => {
    setPosition(p);
    const proches = await quartiersParProximite(p.longitude, p.latitude);
    setQuartiers(proches);
    if (proches[0]) setForm((f) => (f.quartier_id ? f : { ...f, quartier_id: proches[0].id }));
  }, []);

  const valider = () => {
    const e = {};
    if (form.types.length === 0) e.types = 'Indiquez au moins une forme d\'occupation';

    const surface = parseFloat(String(form.surface_m2).replace(',', '.'));
    if (!Number.isFinite(surface) || surface <= 0) {
      e.surface_m2 = 'Mesurez l\'emprise au sol';
    } else if (surface > 5000) {
      e.surface_m2 = 'Emprise improbable — vérifiez l\'unité';
    }

    if (!position) e.position = 'Relevez la position : un chantier se retrouve par ses coordonnées';

    setErreurs(e);
    return Object.keys(e).length === 0;
  };

  const enregistrer = async () => {
    if (!valider()) return;

    const jours = parseInt(form.duree_prevue_jours, 10);
    // La date de fin prévue alimente la liste de repassage du superviseur :
    // la calculer ici évite de demander une date à quelqu'un qui n'a que la
    // durée annoncée par le chef de chantier.
    const finPrevue = Number.isFinite(jours) && jours > 0
      ? new Date(Date.now() + jours * 86400000).toISOString().slice(0, 10)
      : null;

    try {
      await creerChantier({
        libelle: form.libelle || null,
        types: form.types,
        rue_id: form.rue_id,
        quartier_id: form.quartier_id,
        adresse_libelle: form.adresse_libelle || null,
        longitude: position?.longitude ?? null,
        latitude: position?.latitude ?? null,
        surface_m2: parseFloat(String(form.surface_m2).replace(',', '.')),
        duree_prevue_jours: Number.isFinite(jours) ? jours : null,
        date_fin_prevue: finPrevue,
        numero_autorisation: form.numero_autorisation || null,
        autorisation_vue: form.autorisation_vue,
        notes: form.notes || null,
      });

      setEnregistre(true);
      if (connexionFiable) lancerSynchronisation({ silencieux: true });
    } catch (err) {
      Alert.alert('Enregistrement impossible', err.message);
    }
  };

  if (!referentiels) return <Chargement texte="Préparation…" />;

  const typesOccupation = referentiels.types_chantier ?? [];

  if (enregistre) {
    return (
      <View style={styles.vide}>
        <Message
          type="succes"
          titre="Chantier enregistré"
          texte={'Il partira à la prochaine synchronisation. Aucune facture ne sera émise : '
                 + 'le recensement précède la délibération du tarif.'}
        />
        <PriseDePhoto
          type="chantier"
          commerceLocal={null}
          commerceId={null}
          position={position}
          photos={photos}
          onAjout={setPhotos}
        />
        <Bouton titre="Constater un autre chantier" onPress={() => {
          setEnregistre(false);
          setPhotos([]);
          setForm((f) => ({
            ...f, libelle: '', types: [], surface_m2: '',
            duree_prevue_jours: '', numero_autorisation: '',
            autorisation_vue: false, notes: '',
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
        contentContainerStyle={styles.contenu}
        keyboardShouldPersistTaps="handled"
      >
        <Message
          type="info"
          titre="Recensement seul"
          texte={'Ce constat ne produira aucune facture. Il sert à préparer la mise en '
                 + 'place du tarif d\'occupation temporaire, que le conseil municipal '
                 + 'n\'a pas encore délibéré.'}
        />

        <Separateur titre="Localisation" />
        <ReleveurPosition position={position} onPosition={surPosition} obligatoire />
        {erreurs.position ? <Text style={styles.erreur}>{erreurs.position}</Text> : null}

        <SelecteurRue
          rues={rues}
          valeur={form.rue_id}
          onChange={(v) => majForm('rue_id', v)}
          position={position ? { ...position, quartier_id: form.quartier_id } : null}
        />

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
          placeholder="Devant le n° 12, angle de la rue…"
        />

        <Separateur titre="Ce qui occupe le domaine public" />
        <Text style={styles.aide}>
          Cochez tout ce qui est présent : les emprises s&apos;additionnent.
        </Text>

        <View style={styles.cases}>
          {typesOccupation.map((t) => {
            const actif = form.types.includes(t.id);
            return (
              <TouchableOpacity
                key={t.id}
                style={[styles.case, actif && styles.caseActive]}
                onPress={() => basculerType(t.id)}
                activeOpacity={0.75}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: actif }}
              >
                <Ionicons
                  name={actif ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={actif ? couleurs.primaire : couleurs.texteDesactive}
                />
                <Text style={[styles.caseTexte, actif && styles.caseTexteActif]}>
                  {t.libelle}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {erreurs.types ? <Text style={styles.erreur}>{erreurs.types}</Text> : null}

        <Separateur titre="Mesures" />
        <Champ
          etiquette="Emprise au sol (m²)"
          valeur={form.surface_m2}
          onChangeText={(v) => majForm('surface_m2', v)}
          keyboardType="decimal-pad"
          obligatoire
          erreur={erreurs.surface_m2}
          aide="Surface totale occupée sur le trottoir ou la chaussée."
        />

        <Champ
          etiquette="Durée annoncée (jours)"
          valeur={form.duree_prevue_jours}
          onChangeText={(v) => majForm('duree_prevue_jours', v)}
          keyboardType="number-pad"
          aide="Telle qu'annoncée sur place. Sert à programmer le repassage."
        />

        <Separateur titre="Autorisation" />
        <Champ
          etiquette="N° de permis ou d'autorisation"
          valeur={form.numero_autorisation}
          onChangeText={(v) => majForm('numero_autorisation', v)}
          placeholder="Si un document est présenté"
        />

        <TouchableOpacity
          style={styles.bascule}
          onPress={() => majForm('autorisation_vue', !form.autorisation_vue)}
          activeOpacity={0.75}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: form.autorisation_vue }}
        >
          <Ionicons
            name={form.autorisation_vue ? 'checkbox' : 'square-outline'}
            size={22}
            color={form.autorisation_vue ? couleurs.primaire : couleurs.texteDesactive}
          />
          <Text style={styles.basculeTexte}>
            Le document m&apos;a été présenté
          </Text>
        </TouchableOpacity>

        <Champ
          etiquette="Observations"
          valeur={form.notes}
          onChangeText={(v) => majForm('notes', v)}
          multiline
        />

        <Champ
          etiquette="Nom du chantier"
          valeur={form.libelle}
          onChangeText={(v) => majForm('libelle', v)}
          placeholder="Immeuble Diop, rue GT 63"
        />

        <Bouton titre="Enregistrer le constat" onPress={enregistrer} />
        <Text style={styles.rappel}>
          La photo se prend juste après l&apos;enregistrement.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  ecran: { flex: 1, backgroundColor: couleurs.fond },
  contenu: { padding: espacements.l, paddingBottom: espacements.xxl },
  vide: { flex: 1, padding: espacements.l, backgroundColor: couleurs.fond, gap: espacements.m },

  aide: {
    ...typographie.petit, color: couleurs.texteSecondaire,
    marginBottom: espacements.s,
  },
  cases: { gap: espacements.s },
  case: {
    flexDirection: 'row', alignItems: 'center', gap: espacements.m,
    minHeight: CIBLE_TACTILE, paddingHorizontal: espacements.m,
    borderWidth: 1, borderColor: couleurs.bordure, borderRadius: rayons.m,
    backgroundColor: couleurs.surface,
  },
  caseActive: { borderColor: couleurs.primaire, borderWidth: 1.5,
    backgroundColor: couleurs.surfaceAlt },
  caseTexte: { ...typographie.corps, flex: 1 },
  caseTexteActif: { fontWeight: '600' },

  bascule: {
    flexDirection: 'row', alignItems: 'center', gap: espacements.m,
    minHeight: CIBLE_TACTILE, marginBottom: espacements.m,
  },
  basculeTexte: { ...typographie.corps, flex: 1 },

  erreur: {
    ...typographie.petit, color: couleurs.erreur,
    marginTop: espacements.xs, marginBottom: espacements.s,
  },
  rappel: {
    ...typographie.petit, color: couleurs.texteSecondaire,
    textAlign: 'center', marginTop: espacements.s,
  },
});
