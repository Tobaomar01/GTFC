/**
 * Sélection d'une rue.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POURQUOI CE COMPOSANT EXISTE
 *
 *  Toute la phase 0 — constituer le référentiel des voies avant le
 *  recensement — ne sert à rien si l'agent peut taper le nom à la main. Il
 *  écrira « rue GT 63 » un jour, « Rue GT63 » le lendemain, et aucune
 *  statistique par rue ne sera possible.
 *
 *  Ce champ ne permet donc PAS la saisie libre. Il propose, il filtre, il
 *  suggère d'après le GPS — mais la valeur retenue est toujours une rue du
 *  référentiel.
 *
 *  Deux garde-fous pour que cette contrainte reste tenable sur le terrain :
 *
 *   · la recherche accepte les graphies alternatives, celles du PDC comme
 *     celles d'OpenStreetMap. L'agent tape ce qu'il lit sur la plaque ;
 *
 *   · si le référentiel est vide — phase 0 non faite — le composant le dit
 *     franchement au lieu d'afficher une liste vide inexplicable, et laisse
 *     passer : mieux vaut un recensement sans rue qu'un recensement bloqué.
 * ─────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { chercherRue } from '../bdd/objets.repo';
import {
  couleurs, espacements, rayons, typographie, CIBLE_TACTILE,
} from '../theme';

export function SelecteurRue({
  rues = [],
  valeur = null,
  onChange,
  position = null,
  obligatoire = false,
  etiquette = 'Rue',
}) {
  const [terme, setTerme] = useState('');
  const [ouvert, setOuvert] = useState(false);
  const [suggeree, setSuggeree] = useState(null);

  const choisie = useMemo(
    () => rues.find((r) => r.id === valeur) ?? null,
    [rues, valeur],
  );

  const resultats = useMemo(() => chercherRue(rues, terme), [rues, terme]);

  // --- Suggestion par proximité --------------------------------------------
  // Le paquet hors-ligne n'embarque pas les tracés : trop lourds pour ce
  // qu'ils apporteraient sur un téléphone. La suggestion se fait donc sur le
  // quartier détecté, ce qui réduit déjà la liste de plusieurs milliers de
  // voies à quelques dizaines.
  useEffect(() => {
    if (!position?.quartier_id || valeur) { setSuggeree(null); return; }
    const duQuartier = rues.filter((r) => r.quartier_id === position.quartier_id);
    setSuggeree(duQuartier.length > 0 && duQuartier.length <= 12 ? duQuartier : null);
  }, [position?.quartier_id, rues, valeur]);

  // --- Référentiel absent ---------------------------------------------------
  if (rues.length === 0) {
    return (
      <View style={styles.conteneur}>
        <Text style={styles.etiquette}>{etiquette}</Text>
        <View style={styles.avertissement}>
          <Ionicons name="information-circle-outline" size={18} color={couleurs.avertissement} />
          <Text style={styles.avertissementTexte}>
            Aucune rue enregistrée. Le référentiel des voies n&apos;a pas encore été
            constitué par la mairie — vous pouvez continuer sans.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.conteneur}>
      <Text style={styles.etiquette}>
        {etiquette}
        {obligatoire && <Text style={{ color: couleurs.erreur }}> *</Text>}
      </Text>

      {/* --- Rue retenue --- */}
      {choisie ? (
        <TouchableOpacity
          style={styles.choisie}
          onPress={() => { onChange(null); setOuvert(true); }}
          activeOpacity={0.75}
          accessibilityLabel={`Rue sélectionnée : ${choisie.nom}. Appuyer pour changer.`}
        >
          <Ionicons name="navigate" size={18} color={couleurs.primaire} />
          <View style={{ flex: 1 }}>
            <Text style={styles.choisieNom}>{choisie.nom}</Text>
            {choisie.code ? <Text style={styles.choisieCode}>{choisie.code}</Text> : null}
          </View>
          <Ionicons name="close-circle" size={20} color={couleurs.texteDesactive} />
        </TouchableOpacity>
      ) : (
        <>
          <View style={styles.rechercheLigne}>
            <Ionicons name="search" size={18} color={couleurs.texteDesactive} />
            <TextInput
              style={styles.recherche}
              value={terme}
              onChangeText={(t) => { setTerme(t); setOuvert(true); }}
              onFocus={() => setOuvert(true)}
              placeholder="Chercher une rue…"
              placeholderTextColor={couleurs.texteDesactive}
              autoCorrect={false}
              accessibilityLabel="Chercher une rue"
            />
          </View>

          {/* --- Raccourci : les rues du quartier détecté --- */}
          {suggeree && !ouvert ? (
            <View style={styles.suggestions}>
              <Text style={styles.suggestionsTitre}>Rues de ce quartier</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {suggeree.map((r) => (
                  <TouchableOpacity
                    key={r.id}
                    style={styles.puce}
                    onPress={() => { onChange(r.id); setTerme(''); setOuvert(false); }}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.puceTexte}>{r.nom}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {ouvert ? (
            <View style={styles.liste}>
              {resultats.length === 0 ? (
                <Text style={styles.aucun}>
                  Aucune rue ne correspond. Essayez le numéro seul, ou le nom du
                  quartier — les graphies alternatives sont reconnues.
                </Text>
              ) : (
                resultats.map((r) => (
                  <TouchableOpacity
                    key={r.id}
                    style={styles.ligne}
                    onPress={() => { onChange(r.id); setTerme(''); setOuvert(false); }}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                  >
                    <Text style={styles.ligneNom}>{r.nom}</Text>
                    {r.code ? <Text style={styles.ligneCode}>{r.code}</Text> : null}
                  </TouchableOpacity>
                ))
              )}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { marginBottom: espacements.m },
  etiquette: { ...typographie.etiquette, marginBottom: espacements.xs },

  rechercheLigne: {
    flexDirection: 'row', alignItems: 'center', gap: espacements.s,
    borderWidth: 1, borderColor: couleurs.bordure, borderRadius: rayons.m,
    paddingHorizontal: espacements.m, backgroundColor: couleurs.surface,
    minHeight: CIBLE_TACTILE,
  },
  recherche: { flex: 1, ...typographie.corps, paddingVertical: 10 },

  choisie: {
    flexDirection: 'row', alignItems: 'center', gap: espacements.s,
    borderWidth: 1.5, borderColor: couleurs.primaire, borderRadius: rayons.m,
    padding: espacements.m, backgroundColor: couleurs.surfaceAlt,
    minHeight: CIBLE_TACTILE,
  },
  choisieNom: { ...typographie.corps, fontWeight: '600' },
  choisieCode: { ...typographie.petit, color: couleurs.texteSecondaire },

  suggestions: { marginTop: espacements.s },
  suggestionsTitre: {
    ...typographie.petit, color: couleurs.texteSecondaire, marginBottom: espacements.xs,
  },
  puce: {
    paddingHorizontal: espacements.m, paddingVertical: espacements.s,
    backgroundColor: couleurs.surfaceAlt, borderRadius: rayons.rond,
    marginRight: espacements.s, borderWidth: 1, borderColor: couleurs.bordure,
    minHeight: 40, justifyContent: 'center',
  },
  puceTexte: { ...typographie.petit, fontWeight: '500' },

  liste: {
    marginTop: espacements.xs, borderWidth: 1, borderColor: couleurs.bordure,
    borderRadius: rayons.m, backgroundColor: couleurs.surface, overflow: 'hidden',
  },
  ligne: {
    paddingHorizontal: espacements.m, paddingVertical: espacements.m,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: couleurs.bordure,
    minHeight: CIBLE_TACTILE, justifyContent: 'center',
  },
  ligneNom: { ...typographie.corps },
  ligneCode: { ...typographie.petit, color: couleurs.texteSecondaire },
  aucun: {
    padding: espacements.m, ...typographie.petit,
    color: couleurs.texteSecondaire, lineHeight: 18,
  },

  avertissement: {
    flexDirection: 'row', gap: espacements.s, alignItems: 'flex-start',
    padding: espacements.m, borderRadius: rayons.m,
    backgroundColor: couleurs.fond,
    // Un liseré porte l'alerte : la couleur seule ne doit jamais être le
    // seul indice, un agent daltonien lit le trait, pas la teinte.
    borderLeftWidth: 3, borderLeftColor: couleurs.avertissement,
  },
  avertissementTexte: {
    flex: 1, ...typographie.petit, lineHeight: 18,
  },
});
