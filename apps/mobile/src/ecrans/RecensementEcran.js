/**
 * Recensement d'un commerce.
 *
 * L'écran le plus important de l'application : c'est lui qui produit les
 * 5 443 fiches attendues. Trois exigences ont guidé sa conception.
 *
 *   1. TOUT EST ENREGISTRÉ LOCALEMENT D'ABORD. Aucun appel réseau n'est
 *      nécessaire pour valider une fiche. L'agent ne doit jamais perdre une
 *      saisie parce que le réseau a coupé au moment de valider.
 *
 *   2. LES DOUBLONS SONT REPÉRÉS AVANT LA SAISIE. Dès que la position est
 *      relevée, on affiche les commerces déjà recensés à moins de 50 m.
 *      Corriger un doublon après coup coûte bien plus cher que l'éviter.
 *
 *   3. LES MONTANTS NE SONT PAS CALCULÉS ICI. L'agent saisit des mesures ;
 *      le barème est appliqué par le serveur. Dupliquer les règles fiscales
 *      garantirait qu'un jour les deux divergent.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Alert, StyleSheet, KeyboardAvoidingView, Platform,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../contextes/AppContexte';
import { referentielsComplets, lireReferentiel } from '../bdd/sync.repo';
import { creerCommerce, commercesProches, ficheACompleter } from '../bdd/commerces.repo';
import { quartiersParProximite } from '../services/localisation';
import {
  Bouton, Champ, Selecteur, Message, Chargement, Separateur, Carte, useMargeBasse,
} from '../composants/ui';
import { ReleveurPosition, PriseDePhoto, FormulaireTaxes } from '../composants/terrain';
import { couleurs, espacements, typographie, STATUTS_COMMERCE } from '../theme';

export function RecensementEcran({ navigation }) {
  const { lancerSynchronisation, connexionFiable } = useApp();
  // Sans elle, « Terminer » se cache sous la barre de navigation d'Android.
  const margeBasse = useMargeBasse();

  const [referentiels, setReferentiels] = useState(null);

  const [position, setPosition] = useState(null);
  const [quartiers, setQuartiers] = useState([]);
  const [voisins, setVoisins] = useState([]);
  // Tracés des rues : ce qui permet à l'agent de se repérer sur la carte
  // tant qu'aucun fond de plan n'est disponible.
  const [rues, setRues] = useState([]);

  const [form, setForm] = useState({
    enseigne: '', categorie_id: null, quartier_id: null,
    gerant_nom: '', gerant_prenom: '', gerant_telephone: '', telephone_paiement: '',
    point_repere: '', surface_locale_m2: '', ninea: '',
    marche_id: null, type_emplacement_id: null, numero_emplacement: '',
    statut: 'actif', notes: '',
  });
  const [mesuresTaxes, setMesuresTaxes] = useState({});
  const [photos, setPhotos] = useState([]);
  const [commerceLocal, setCommerceLocal] = useState(null);
  const [erreurs, setErreurs] = useState({});
  const [enregistre, setEnregistre] = useState(false);

  useEffect(() => {
    referentielsComplets().then(setReferentiels);
    lireReferentiel('rues', []).then(setRues);
  }, []);

  const majForm = (champ, valeur) => {
    setForm((f) => ({ ...f, [champ]: valeur }));
    setErreurs((e) => ({ ...e, [champ]: null }));
  };

  // -------------------------------------------------------------------------
  // Position relevée : on cherche immédiatement les doublons potentiels
  // -------------------------------------------------------------------------
  const surPosition = useCallback(async (p, suggestion) => {
    setPosition(p);
    setQuartiers(await quartiersParProximite(p.longitude, p.latitude));

    if (suggestion?.fiable) majForm('quartier_id', suggestion.quartier.id);

    const proches = await commercesProches(p.longitude, p.latitude, 50);
    setVoisins(proches);
  }, []);

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------
  const validerFiche = () => {
    const e = {};
    if (!form.enseigne.trim()) e.enseigne = 'Le nom du commerce est obligatoire';
    if (!form.categorie_id) e.categorie_id = 'Choisissez une catégorie';
    if (!position && !form.quartier_id) {
      e.quartier_id = 'Relevez la position ou choisissez le quartier';
    }
    if (form.gerant_telephone && !/^\+?[0-9]{8,15}$/.test(form.gerant_telephone.replace(/\s/g, ''))) {
      e.gerant_telephone = 'Numéro invalide';
    }
    for (const [code, valeur] of Object.entries(mesuresTaxes)) {
      if (valeur != null && valeur !== '' && !(Number(valeur) > 0)) {
        e[`taxe_${code}`] = 'Saisissez une mesure supérieure à zéro';
      }
    }
    setErreurs(e);
    return Object.keys(e).length === 0;
  };

  const enregistrer = async () => {
    if (!validerFiche()) {
      Alert.alert('Fiche incomplète', 'Corrigez les champs signalés en rouge.');
      return;
    }

    const categorie = referentiels.categories.find((c) => c.id === form.categorie_id);
    const quartier = quartiers.find((q) => q.id === form.quartier_id)
      ?? referentiels.quartiers.find((q) => q.id === form.quartier_id);

    const taxes = Object.entries(mesuresTaxes)
      .filter(([, v]) => v !== null && v !== '')
      .map(([code, v]) => ({ code, valeur: Number(v) }));

    // Les taxes sans mesure (patente, TEOM) sont ajoutées d'après la catégorie
    for (const t of referentiels.types_taxes) {
      if (!t.conditionnelle && !taxes.some((x) => x.code === t.code)) {
        taxes.push({ code: t.code, valeur: null });
      }
    }

    const donnees = {
      enseigne: form.enseigne.trim(),
      categorie_id: form.categorie_id,
      quartier_id: form.quartier_id ?? null,
      zone_id: quartier?.zone_id ?? null,
      longitude: position?.longitude ?? null,
      latitude: position?.latitude ?? null,
      precision_gps_m: position?.precision_gps_m ?? null,
      gerant_nom: form.gerant_nom.trim() || null,
      gerant_prenom: form.gerant_prenom.trim() || null,
      gerant_telephone: form.gerant_telephone.replace(/\s/g, '') || null,
      telephone_paiement: (form.telephone_paiement || form.gerant_telephone).replace(/\s/g, '') || null,
      point_repere: form.point_repere.trim() || null,
      ninea: form.ninea.trim() || null,
      surface_locale_m2: form.surface_locale_m2 ? Number(form.surface_locale_m2) : null,
      todp_surface_m2: mesuresTaxes.todp ? Number(mesuresTaxes.todp) : null,
      enseigne_surface_m2: mesuresTaxes.enseigne ? Number(mesuresTaxes.enseigne) : null,
      nb_jours_marche: mesuresTaxes.droit_place ? Number(mesuresTaxes.droit_place) : null,
      marche_id: form.marche_id ?? null,
      type_emplacement_id: form.type_emplacement_id ?? null,
      numero_emplacement: form.numero_emplacement.trim() || null,
      statut: form.statut,
      notes: form.notes.trim() || null,
      hors_ligne: !connexionFiable,
    };

    try {
      const idLocal = await creerCommerce(donnees, taxes);
      setCommerceLocal(idLocal);
      setEnregistre(true);

      // Deux rappels possibles, un seul écran : deux alertes lancées ensemble
      // se recouvrent, et l'agent n'en lit aucune. On les réunit, la reprise
      // en tête parce qu'une fiche sans numéro ne rapporte rien du tout.
      const rappels = [];

      // Le gérant n'était pas là. On le dit maintenant, pendant que l'agent
      // est encore devant la boutique : c'est le seul moment où il peut
      // demander le numéro au voisin ou noter un repère pour son retour.
      if (ficheACompleter(donnees)) {
        const manque = (donnees.gerant_nom ?? '').trim()
          ? 'le numéro de téléphone'
          : 'le nom du gérant et son numéro';
        rappels.push(
          `La devanture est enregistrée, mais il manque ${manque}.\n\n`
          + 'Sans numéro, l\'avis mensuel avec le lien Wave ne part pas : ce '
          + 'commerce ne paiera rien tant que la fiche est incomplète. Elle '
          + 'apparaît dans « À reprendre » sur la liste des commerces.');
      }

      // Simple rappel, pas un blocage : un restaurant sans débordement
      // constaté est parfaitement possible.
      if (categorie?.todp_probable && !mesuresTaxes.todp) {
        rappels.push(
          `Les commerces de type « ${categorie.libelle} » débordent souvent sur `
          + 'le domaine public. Si c\'est le cas ici, revenez ajouter la mesure TODP.');
      }

      if (rappels.length > 0) {
        setTimeout(() => Alert.alert(
          ficheACompleter(donnees) ? 'Fiche à reprendre' : 'Vérifiez le trottoir',
          rappels.join('\n\n'),
        ), 400);
      }
    } catch (err) {
      Alert.alert('Enregistrement impossible', err.message);
    }
  };

  const terminer = async () => {
    if (connexionFiable) lancerSynchronisation().catch(() => {});
    // « Accueil » est un ONGLET, à l'intérieur du navigateur « Principal ».
    // React Navigation remonte vers les parents pour trouver un nom, il ne
    // descend PAS dans les navigateurs imbriqués : navigate('Accueil') depuis
    // la pile n'était traité par personne, et l'agent restait sur le
    // formulaire avec un bandeau rouge, sa fiche pourtant enregistrée.
    // Constaté sur un vrai téléphone le 09/09/2026.
    navigation.navigate('Principal', { screen: 'Accueil' });
  };

  if (!referentiels?.categories?.length) {
    return <Chargement texte="Chargement des référentiels…" />;
  }

  // -------------------------------------------------------------------------
  // Étape 3 — fiche enregistrée, photos
  // -------------------------------------------------------------------------
  if (enregistre) {
    return (
      <ScrollView style={styles.page}
        contentContainerStyle={{ padding: espacements.l, paddingBottom: margeBasse }}
      >
        <Message
          type="succes"
          titre="Commerce enregistré sur le téléphone"
          texte={connexionFiable
            ? 'Il partira au serveur à la prochaine synchronisation.'
            : 'Il sera envoyé automatiquement dès que vous aurez du réseau.'}
        />

        <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>
          Photos à prendre
        </Text>

        <PriseDePhoto
          type="devanture" commerceLocal={commerceLocal} position={position}
          photos={photos} onAjout={(p) => setPhotos((l) => [...l, { ...p, type: 'devanture' }])}
        />

        {mesuresTaxes.todp ? (
          <PriseDePhoto
            type="trottoir_todp" commerceLocal={commerceLocal} position={position}
            photos={photos}
            onAjout={(p) => setPhotos((l) => [...l, { ...p, type: 'trottoir_todp' }])}
          />
        ) : null}

        {mesuresTaxes.enseigne ? (
          <PriseDePhoto
            type="enseigne" commerceLocal={commerceLocal} position={position}
            photos={photos} onAjout={(p) => setPhotos((l) => [...l, { ...p, type: 'enseigne' }])}
          />
        ) : null}

        {photos.length === 0 ? (
          <Message
            type="avertissement"
            texte="Aucune photo prise. La photo de devanture est la preuve du recensement — prenez-la avant de quitter le commerce."
          />
        ) : null}

        <Bouton titre="Terminer" icone="checkmark-done" onPress={terminer} />
        <Bouton
          titre="Recenser un autre commerce"
          variante="secondaire"
          icone="add"
          onPress={() => {
            setEnregistre(false); setPosition(null); setVoisins([]);
            setPhotos([]); setCommerceLocal(null); setMesuresTaxes({});
            setForm({
              enseigne: '', categorie_id: null, quartier_id: null,
              gerant_nom: '', gerant_prenom: '', gerant_telephone: '', telephone_paiement: '',
              point_repere: '', surface_locale_m2: '', ninea: '',
              marche_id: null, type_emplacement_id: null, numero_emplacement: '',
              statut: 'actif', notes: '',
            });
          }}
          style={{ marginTop: espacements.m }}
        />
      </ScrollView>
    );
  }

  const categorieChoisie = referentiels.categories.find((c) => c.id === form.categorie_id);

  // -------------------------------------------------------------------------
  // Étapes 1 et 2 — position puis saisie
  // -------------------------------------------------------------------------
  return (
    <KeyboardAvoidingView style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.page}
        contentContainerStyle={{ padding: espacements.l, paddingBottom: margeBasse }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---------------- Position ---------------- */}
        <ReleveurPosition
          position={position}
          onPosition={surPosition}
          urlTuiles={process.env.EXPO_PUBLIC_TUILES_URL ?? null}
          rues={rues}
        />

        {/* ---------------- Doublons potentiels ---------------- */}
        {voisins.length > 0 ? (
          <Carte style={{ borderLeftWidth: 4, borderLeftColor: couleurs.avertissement }}>
            <View style={styles.ligneTitre}>
              <Ionicons name="warning" size={20} color={couleurs.avertissement} />
              <Text style={typographie.sousTitre}>
                {voisins.length} commerce(s) déjà recensé(s) à proximité
              </Text>
            </View>
            <Text style={[typographie.petit, { marginBottom: espacements.s }]}>
              Vérifiez qu'il ne s'agit pas du même commerce avant d'en créer un nouveau.
            </Text>
            {voisins.slice(0, 5).map((v) => (
              <TouchableOpacity
                key={v.id_local}
                style={styles.voisin}
                onPress={() => navigation.navigate('FicheCommerce', { idLocal: v.id_local })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[typographie.corps, { fontWeight: '600' }]}>{v.enseigne}</Text>
                  <Text style={typographie.petit}>{v.code ?? 'non encore envoyé'}</Text>
                </View>
                <Text style={[typographie.petit, { fontWeight: '700' }]}>{v.distance_m} m</Text>
                <Ionicons name="chevron-forward" size={18} color={couleurs.texteDesactive} />
              </TouchableOpacity>
            ))}
          </Carte>
        ) : null}

        <Separateur titre="Identité du commerce" />

        <Champ
          etiquette="Nom du commerce / enseigne"
          valeur={form.enseigne}
          onChangeText={(t) => majForm('enseigne', t)}
          placeholder="Ex. Boutique Ndiaye"
          obligatoire
          erreur={erreurs.enseigne}
          autoCapitalize="words"
        />

        <Selecteur
          etiquette="Catégorie d'activité"
          options={referentiels.categories.map((c) => ({ id: c.id, libelle: c.libelle }))}
          valeur={form.categorie_id}
          onChange={(v) => majForm('categorie_id', v)}
          obligatoire
        />
        {erreurs.categorie_id ? (
          <Text style={styles.erreur}>{erreurs.categorie_id}</Text>
        ) : null}

        <Selecteur
          etiquette="Quartier"
          options={(quartiers.length ? quartiers : referentiels.quartiers).map((q) => ({
            id: q.id,
            libelle: q.nom,
            detail: q.distance_m != null && Number.isFinite(q.distance_m)
              ? `${q.distance_m} m` : null,
          }))}
          valeur={form.quartier_id}
          onChange={(v) => majForm('quartier_id', v)}
          obligatoire={!position}
          aide={position
            ? 'Proposé d\'après votre position. La mairie confirmera le rattachement exact.'
            : 'Choisissez le quartier, faute de position GPS.'}
        />
        {erreurs.quartier_id ? <Text style={styles.erreur}>{erreurs.quartier_id}</Text> : null}

        <Champ
          etiquette="Point de repère"
          valeur={form.point_repere}
          onChangeText={(t) => majForm('point_repere', t)}
          placeholder="Ex. en face de la pharmacie"
          aide="Précieux dans les rues sans plaque, pour retrouver le commerce plus tard."
        />

        <Separateur titre="Gérant" />

        <View style={styles.deuxColonnes}>
          <View style={{ flex: 1 }}>
            <Champ etiquette="Prénom" valeur={form.gerant_prenom}
              onChangeText={(t) => majForm('gerant_prenom', t)} autoCapitalize="words" />
          </View>
          <View style={{ flex: 1 }}>
            <Champ etiquette="Nom" valeur={form.gerant_nom}
              onChangeText={(t) => majForm('gerant_nom', t)} autoCapitalize="words" />
          </View>
        </View>

        <Champ
          etiquette="Téléphone du gérant"
          valeur={form.gerant_telephone}
          onChangeText={(t) => majForm('gerant_telephone', t)}
          keyboardType="phone-pad"
          placeholder="+221 77 123 45 67"
          erreur={erreurs.gerant_telephone}
          aide="Servira à envoyer la demande de paiement Wave. C'est la seule donnée transmise à Wave, avec le montant."
        />

        <Champ etiquette="NINEA (si connu)" valeur={form.ninea}
          onChangeText={(t) => majForm('ninea', t)} autoCapitalize="characters" />

        <Separateur titre="Local" />

        <Champ
          etiquette="Surface du local"
          valeur={form.surface_locale_m2}
          onChangeText={(t) => majForm('surface_locale_m2', t.replace(',', '.'))}
          keyboardType="decimal-pad"
          suffixe="m²"
          placeholder="0"
        />

        <Selecteur
          etiquette="État du commerce"
          options={Object.entries(STATUTS_COMMERCE)
            .filter(([k]) => k !== 'archive')
            .map(([k, v]) => ({ id: k, libelle: v }))}
          valeur={form.statut}
          onChange={(v) => majForm('statut', v ?? 'actif')}
          horizontal
        />

        {referentiels.marches?.length ? (
          <Selecteur
            etiquette="Marché (si le commerce y est installé)"
            options={referentiels.marches.map((m) => ({ id: m.id, libelle: m.nom }))}
            valeur={form.marche_id}
            onChange={(v) => majForm('marche_id', v)}
            aide="Laissez vide pour un commerce en rue."
          />
        ) : null}

        {form.marche_id && referentiels.types_emplacement?.length ? (
          <Selecteur
            etiquette="Type d'emplacement"
            options={referentiels.types_emplacement.map((e) => ({ id: e.id, libelle: e.libelle }))}
            valeur={form.type_emplacement_id}
            onChange={(v) => majForm('type_emplacement_id', v)}
            horizontal
          />
        ) : null}

        <Separateur titre="Taxes" />

        <FormulaireTaxes
          typesTaxes={referentiels.types_taxes ?? []}
          categorie={categorieChoisie}
          valeurs={mesuresTaxes}
          marcheChoisi={form.marche_id}
          onChange={(code, valeur) => setMesuresTaxes((m) => ({ ...m, [code]: valeur }))}
        />

        <Champ
          etiquette="Observations"
          valeur={form.notes}
          onChangeText={(t) => majForm('notes', t)}
          multiline
          numberOfLines={3}
          placeholder="Remarques utiles pour la mairie"
        />

        <Bouton titre="Enregistrer le commerce" icone="save" onPress={enregistrer} />
        <Text style={[typographie.petit, {
          textAlign: 'center', marginTop: espacements.s, marginBottom: espacements.xxl,
        }]}
        >
          Les photos seront demandées juste après.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: couleurs.fond },
  ligneTitre: {
    flexDirection: 'row', alignItems: 'center',
    gap: espacements.s, marginBottom: espacements.xs,
  },
  voisin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espacements.s,
    paddingVertical: espacements.s,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: couleurs.bordure,
  },
  deuxColonnes: { flexDirection: 'row', gap: espacements.m },
  erreur: {
    fontSize: 13, color: couleurs.erreur,
    marginTop: -espacements.m, marginBottom: espacements.m,
  },
});
