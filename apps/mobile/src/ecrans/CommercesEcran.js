/**
 * Liste des commerces, fiche détaillée et scanner de QR code.
 *
 * Tout est servi depuis la base locale : la liste fonctionne à l'identique
 * avec ou sans réseau. Seuls les montants dus exigent une connexion, parce
 * qu'ils sont calculés par le serveur d'après le barème en vigueur.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, Alert,
  RefreshControl, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { useApp } from '../contextes/AppContexte';
import {
  listerCommerces, lireCommerce, lireCommerceParQr, lireTaxesCommerce,
  enregistrerVisite, enregistrerPaiement,
} from '../bdd/commerces.repo';
import { photosDuCommerce, lireReferentiel } from '../bdd/sync.repo';
import { api } from '../api/client';
import { releverPosition } from '../services/localisation';
import { PriseDePhoto } from '../composants/terrain';
import {
  Bouton, Champ, Carte, BadgeStatut, Message, Chargement, EtatVide, LigneInfo, Separateur,
} from '../composants/ui';
import {
  couleurs, espacements, typographie, rayons, formaterXof, formaterDate,
  STATUTS_COMMERCE, RESULTATS_VISITE, CIBLE_TACTILE,
} from '../theme';

// ===========================================================================
//  Liste
// ===========================================================================
export function ListeCommercesEcran({ navigation }) {
  const [commerces, setCommerces] = useState([]);
  const [recherche, setRecherche] = useState('');
  const [filtre, setFiltre] = useState(null);
  const [charge, setCharge] = useState(true);

  const charger = useCallback(async () => {
    setCommerces(await listerCommerces({ recherche, statutFiscal: filtre, limite: 300 }));
    setCharge(false);
  }, [recherche, filtre]);

  useFocusEffect(useCallback(() => { charger(); }, [charger]));

  const filtres = [
    { code: null, libelle: 'Tous' },
    { code: 'impaye', libelle: 'Impayés' },
    { code: 'partiel', libelle: 'Partiels' },
    { code: 'a_jour', libelle: 'À jour' },
  ];

  if (charge) return <Chargement />;

  return (
    <View style={{ flex: 1, backgroundColor: couleurs.fond }}>
      <View style={styles.barreRecherche}>
        <Champ
          valeur={recherche}
          onChangeText={setRecherche}
          placeholder="Rechercher un commerce, un code…"
          autoCorrect={false}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ marginTop: -espacements.s }}
        >
          <View style={{ flexDirection: 'row', gap: espacements.s }}>
            {filtres.map((f) => (
              <TouchableOpacity
                key={f.libelle}
                onPress={() => setFiltre(f.code)}
                style={[styles.puce, filtre === f.code && styles.puceActive]}
              >
                <Text style={[
                  styles.puceTexte, filtre === f.code && { color: '#FFF', fontWeight: '700' },
                ]}
                >
                  {f.libelle}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>

      <FlatList
        data={commerces}
        keyExtractor={(c) => c.id_local}
        contentContainerStyle={{ padding: espacements.l, paddingTop: 0 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={charger} />}
        ListEmptyComponent={(
          <EtatVide
            icone="storefront-outline"
            titre={recherche ? 'Aucun résultat' : 'Aucun commerce'}
            texte={recherche
              ? 'Essayez avec le début du nom, ou le code du commerce.'
              : 'Synchronisez pour récupérer les commerces de votre zone, ou recensez-en un nouveau.'}
          />
        )}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => navigation.navigate('FicheCommerce', { idLocal: item.id_local })}
            activeOpacity={0.8}
          >
            <Carte style={{ marginBottom: espacements.s }}>
              <View style={styles.ligneCommerce}>
                <View style={{ flex: 1 }}>
                  <Text style={[typographie.corps, { fontWeight: '700' }]} numberOfLines={1}>
                    {item.enseigne}
                  </Text>
                  <Text style={typographie.petit}>
                    {item.code ?? 'Pas encore envoyé au serveur'}
                  </Text>
                  {item.solde_du > 0 ? (
                    <Text style={[typographie.petit, { color: couleurs.impaye, fontWeight: '600' }]}>
                      {formaterXof(item.solde_du)} dus
                    </Text>
                  ) : null}
                </View>

                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <BadgeStatut statut={item.statut_fiscal ?? 'inconnu'} petit />
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {item.origine_locale === 1 ? (
                      <Ionicons name="phone-portrait-outline" size={15}
                        color={couleurs.horsLigne} />
                    ) : null}
                    {item.modifie_localement === 1 ? (
                      <Ionicons name="cloud-upload-outline" size={15} color={couleurs.accent} />
                    ) : null}
                    {item.photos_en_attente > 0 ? (
                      <Ionicons name="images-outline" size={15} color={couleurs.accent} />
                    ) : null}
                  </View>
                </View>
              </View>
            </Carte>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

// ===========================================================================
//  Fiche
// ===========================================================================
export function FicheCommerceEcran({ route, navigation }) {
  const { idLocal } = route.params;
  const { connexionFiable } = useApp();

  const [commerce, setCommerce] = useState(null);
  const [taxes, setTaxes] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [categories, setCategories] = useState([]);
  const [simulation, setSimulation] = useState(null);
  const [chargeSimulation, setChargeSimulation] = useState(false);

  const charger = useCallback(async () => {
    const c = await lireCommerce(idLocal);
    setCommerce(c);
    setTaxes(await lireTaxesCommerce(idLocal));
    setPhotos(await photosDuCommerce(idLocal));
    setCategories(await lireReferentiel('categories', []));
  }, [idLocal]);

  useFocusEffect(useCallback(() => { charger(); }, [charger]));

  /** Les montants viennent du serveur : le barème n'est pas embarqué. */
  const simuler = async () => {
    if (!commerce?.id_serveur) {
      Alert.alert('Fiche non synchronisée',
        'Ce commerce n\'a pas encore été envoyé au serveur. Synchronisez d\'abord.');
      return;
    }
    setChargeSimulation(true);
    try {
      setSimulation(await api.simulerTaxes(commerce.id_serveur));
    } catch (err) {
      Alert.alert(err.duReseau ? 'Pas de réseau' : 'Calcul impossible',
        err.duReseau
          ? 'Les montants sont calculés par la mairie. Reconnectez-vous pour les consulter.'
          : err.message);
    } finally {
      setChargeSimulation(false);
    }
  };

  const noterVisite = async (resultat) => {
    let position = null;
    try {
      position = await releverPosition({ delaiMaxMs: 8000 });
    } catch { /* la visite reste valable sans position */ }

    await enregistrerVisite({
      commerce_local: idLocal,
      commerce_id: commerce.id_serveur,
      resultat,
      longitude: position?.longitude,
      latitude: position?.latitude,
      precision_gps_m: position?.precision_gps_m,
    });
    Alert.alert('Visite enregistrée', RESULTATS_VISITE[resultat]);
    charger();
  };

  if (!commerce) return <Chargement />;

  const categorie = categories.find((c) => c.id === commerce.categorie_id);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: couleurs.fond }}
      contentContainerStyle={{ padding: espacements.l }}
    >
      <Carte>
        <Text style={typographie.titre}>{commerce.enseigne}</Text>
        <Text style={[typographie.monospace, { marginTop: 2 }]}>
          {commerce.code ?? '— code attribué à la synchronisation —'}
        </Text>
        <View style={{ marginTop: espacements.m, flexDirection: 'row', gap: espacements.s }}>
          <BadgeStatut statut={commerce.statut_fiscal ?? 'inconnu'} />
        </View>

        {commerce.origine_locale === 1 ? (
          <Message
            type="avertissement"
            texte="Cette fiche n'a pas encore été envoyée au serveur. Elle n'existe que sur ce téléphone."
          />
        ) : null}
      </Carte>

      <Carte>
        <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>Identité</Text>
        <LigneInfo etiquette="Catégorie" valeur={categorie?.libelle} icone="pricetag-outline" />
        <LigneInfo etiquette="État" valeur={STATUTS_COMMERCE[commerce.statut]} icone="business-outline" />
        <LigneInfo
          etiquette="Gérant"
          valeur={[commerce.gerant_prenom, commerce.gerant_nom].filter(Boolean).join(' ') || null}
          icone="person-outline"
        />
        {commerce.gerant_telephone ? (
          <TouchableOpacity onPress={() => Linking.openURL(`tel:${commerce.gerant_telephone}`)}>
            <LigneInfo etiquette="Téléphone" valeur={commerce.gerant_telephone} icone="call-outline" />
          </TouchableOpacity>
        ) : null}
        <LigneInfo etiquette="Repère" valeur={commerce.point_repere} icone="pin-outline" />
        <LigneInfo
          etiquette="Position"
          valeur={commerce.latitude
            ? `${commerce.latitude.toFixed(5)}, ${commerce.longitude.toFixed(5)}`
            : 'non relevée'}
          icone="navigate-outline"
        />
        <LigneInfo etiquette="Surface locale"
          valeur={commerce.surface_locale_m2 ? `${commerce.surface_locale_m2} m²` : null}
          icone="resize-outline" />
      </Carte>

      {/* ---- Taxes ---- */}
      <Carte>
        <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>
          Taxes applicables
        </Text>

        {taxes.length === 0 ? (
          <Text style={typographie.petit}>Aucune taxe enregistrée pour ce commerce.</Text>
        ) : taxes.map((t) => (
          <LigneInfo
            key={t.id_local}
            etiquette={t.type_taxe_code.toUpperCase()}
            valeur={t.parametre_valeur != null ? `${t.parametre_valeur}` : 'forfait'}
          />
        ))}

        {commerce.todp_surface_m2 ? (
          <Message
            type="info"
            texte={`Débordement mesuré sur le trottoir : ${commerce.todp_surface_m2} m². Le montant est calculé par la mairie d'après le barème en vigueur.`}
          />
        ) : null}

        <Bouton
          titre="Calculer les montants dus"
          variante="secondaire"
          icone="calculator-outline"
          onPress={simuler}
          charge={chargeSimulation}
          desactive={!connexionFiable}
        />
        {!connexionFiable ? (
          <Text style={[typographie.petit, { marginTop: espacements.xs }]}>
            Le calcul nécessite une connexion : les barèmes restent sur le serveur.
          </Text>
        ) : null}

        {simulation ? (
          <View style={{ marginTop: espacements.m }}>
            <Separateur titre={`Estimation au ${formaterDate(simulation.date)}`} />
            {simulation.lignes.map((l) => (
              <View key={l.code} style={styles.ligneTaxe}>
                <View style={{ flex: 1 }}>
                  <Text style={typographie.corps}>{l.taxe}</Text>
                  {l.base_calcul ? (
                    <Text style={typographie.petit}>
                      {l.base_calcul} {l.unite} × {formaterXof(l.montant_unitaire)}
                    </Text>
                  ) : null}
                  {l.erreur ? (
                    <Text style={[typographie.petit, { color: couleurs.erreur }]}>{l.erreur}</Text>
                  ) : null}
                </View>
                <Text style={[typographie.corps, { fontWeight: '700' }]}>
                  {l.montant != null ? formaterXof(l.montant) : '—'}
                </Text>
              </View>
            ))}
            <View style={[styles.ligneTaxe, { borderTopWidth: 2, borderTopColor: couleurs.primaire }]}>
              <Text style={[typographie.sousTitre, { flex: 1 }]}>Total mensuel</Text>
              <Text style={[typographie.sousTitre, { color: couleurs.primaire }]}>
                {formaterXof(simulation.total)}
              </Text>
            </View>
          </View>
        ) : null}
      </Carte>

      {/* ---- Photos ---- */}
      <Carte>
        <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>
          Photos ({photos.length})
        </Text>
        <PriseDePhoto
          type="devanture"
          commerceLocal={idLocal}
          commerceId={commerce.id_serveur}
          photos={photos.map((p) => ({ ...p, chemin: p.chemin_fichier }))}
          onAjout={charger}
        />
        <PriseDePhoto
          type="trottoir_todp"
          commerceLocal={idLocal}
          commerceId={commerce.id_serveur}
          photos={photos.map((p) => ({ ...p, chemin: p.chemin_fichier }))}
          onAjout={charger}
        />
      </Carte>

      {/* ---- Actions ---- */}
      <Carte>
        <Text style={[typographie.sousTitre, { marginBottom: espacements.m }]}>
          Enregistrer un passage
        </Text>
        <View style={styles.actionsVisite}>
          {['controle', 'ferme', 'refus'].map((r) => (
            <TouchableOpacity key={r} style={styles.actionVisite} onPress={() => noterVisite(r)}>
              <Text style={styles.actionVisiteTexte}>{RESULTATS_VISITE[r]}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Bouton
          titre="Encaisser en espèces"
          icone="cash-outline"
          variante="secondaire"
          onPress={() => navigation.navigate('Encaissement', { idLocal })}
          style={{ marginTop: espacements.m }}
        />
      </Carte>
    </ScrollView>
  );
}

// ===========================================================================
//  Scanner de QR code
// ===========================================================================
export function ScannerEcran({ navigation }) {
  const [permission, demanderPermission] = useCameraPermissions();
  const [scanne, setScanne] = useState(false);
  const [recherche, setRecherche] = useState(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) demanderPermission();
  }, [permission, demanderPermission]);

  const surScan = async ({ data }) => {
    if (scanne) return;
    setScanne(true);
    setRecherche(true);

    try {
      // Le QR encode une URL : https://gtfc.domaine.sn/c/<jeton>
      const jeton = String(data).trim().split('/').filter(Boolean).pop();

      // D'abord en local : le scan doit fonctionner sans réseau, c'est
      // l'usage principal sur le terrain.
      const local = await lireCommerceParQr(jeton);
      if (local) {
        navigation.replace('FicheCommerce', { idLocal: local.id_local });
        return;
      }

      // Sinon, demande au serveur — commerce recensé par un autre agent.
      const distant = await api.scanPublic(jeton);
      Alert.alert(
        distant.enseigne,
        `${distant.code}\n${distant.categorie}\n${distant.quartier}\n\n`
        + 'Cette fiche n\'est pas encore sur votre téléphone. Synchronisez pour la récupérer.',
        [{ text: 'Continuer', onPress: () => setScanne(false) }],
      );
    } catch (err) {
      Alert.alert(
        'QR code non reconnu',
        err.duReseau
          ? 'Ce commerce n\'est pas sur votre téléphone et le réseau est indisponible.'
          : 'Ce QR code ne correspond à aucun commerce enregistré. Vérifiez qu\'il s\'agit bien d\'un sticker de la commune.',
        [{ text: 'Réessayer', onPress: () => setScanne(false) }],
      );
    } finally {
      setRecherche(false);
    }
  };

  if (!permission) return <Chargement texte="Vérification de l'appareil photo…" />;

  if (!permission.granted) {
    return (
      <EtatVide
        icone="camera-outline"
        titre="Appareil photo non autorisé"
        texte="Le scan des QR codes nécessite l'accès à l'appareil photo."
        action={<Bouton titre="Autoriser" onPress={demanderPermission} />}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanne ? undefined : surScan}
      />
      <View style={styles.viseur}>
        <View style={styles.cadre} />
        <Text style={styles.viseurTexte}>
          {recherche ? 'Recherche du commerce…' : 'Cadrez le sticker QR du commerce'}
        </Text>
      </View>
    </View>
  );
}

// ===========================================================================
//  Encaissement
// ===========================================================================
export function EncaissementEcran({ route, navigation }) {
  const { idLocal } = route.params;
  const [commerce, setCommerce] = useState(null);
  const [montant, setMontant] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [charge, setCharge] = useState(false);

  useEffect(() => { lireCommerce(idLocal).then(setCommerce); }, [idLocal]);

  const encaisser = async () => {
    const valeur = Number(montant);
    if (!(valeur > 0)) { Alert.alert('Montant invalide', 'Saisissez un montant supérieur à zéro.'); return; }

    Alert.alert(
      'Confirmer l\'encaissement',
      `${formaterXof(valeur)} reçus de ${commerce.enseigne}.\n\n`
      + 'Une fois enregistré, ce montant vous sera réclamé en caisse. Confirmez uniquement si vous avez bien reçu l\'argent.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer',
          onPress: async () => {
            setCharge(true);
            try {
              let position = null;
              try { position = await releverPosition({ delaiMaxMs: 8000 }); } catch { /* facultatif */ }

              const { reference } = await enregistrerPaiement({
                commerce_local: idLocal,
                commerce_id: commerce.id_serveur,
                montant: valeur,
                moyen: 'especes',
                telephone_payeur: commerce.telephone_paiement,
                commentaire: commentaire || null,
                longitude: position?.longitude,
                latitude: position?.latitude,
              });

              await enregistrerVisite({
                commerce_local: idLocal,
                commerce_id: commerce.id_serveur,
                resultat: 'encaissement',
                longitude: position?.longitude,
                latitude: position?.latitude,
              });

              Alert.alert(
                'Encaissement enregistré',
                `Référence : ${reference}\n\nCommuniquez-la au commerçant. `
                + 'La quittance officielle sera émise par la mairie après synchronisation.',
                [{ text: 'Terminé', onPress: () => navigation.goBack() }],
              );
            } catch (err) {
              Alert.alert('Enregistrement impossible', err.message);
            } finally {
              setCharge(false);
            }
          },
        },
      ],
    );
  };

  if (!commerce) return <Chargement />;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: couleurs.fond }}
      contentContainerStyle={{ padding: espacements.l }}
    >
      <Carte>
        <Text style={typographie.sousTitre}>{commerce.enseigne}</Text>
        <Text style={typographie.petit}>{commerce.code ?? 'non synchronisé'}</Text>
        {commerce.solde_du > 0 ? (
          <Text style={[typographie.titre, { color: couleurs.impaye, marginTop: espacements.s }]}>
            {formaterXof(commerce.solde_du)} dus
          </Text>
        ) : null}
      </Carte>

      <Message
        type="avertissement"
        titre="Encaissement en espèces"
        texte="Privilégiez le paiement Wave quand c'est possible : il est tracé de bout en bout et vous évite de transporter de l'argent. Tout encaissement en espèces est nominatif et devra être versé en caisse."
      />

      <Champ
        etiquette="Montant reçu"
        valeur={montant}
        onChangeText={(t) => setMontant(t.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        suffixe="FCFA"
        obligatoire
        placeholder="0"
      />

      <Champ etiquette="Observation" valeur={commentaire} onChangeText={setCommentaire}
        multiline numberOfLines={2} />

      <Bouton titre="Enregistrer l'encaissement" icone="cash" onPress={encaisser} charge={charge} />
    </ScrollView>
  );
}

// ===========================================================================
const styles = StyleSheet.create({
  barreRecherche: { padding: espacements.l, paddingBottom: espacements.s },
  puce: {
    paddingHorizontal: espacements.l,
    height: 38,
    justifyContent: 'center',
    borderRadius: rayons.rond,
    borderWidth: 1.5,
    borderColor: couleurs.bordure,
    backgroundColor: couleurs.surface,
  },
  puceActive: { backgroundColor: couleurs.primaire, borderColor: couleurs.primaire },
  puceTexte: { fontSize: 14, color: couleurs.texte },

  ligneCommerce: { flexDirection: 'row', alignItems: 'center', gap: espacements.m },

  ligneTaxe: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: espacements.s,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: couleurs.bordure,
  },

  actionsVisite: { gap: espacements.s },
  actionVisite: {
    minHeight: CIBLE_TACTILE,
    justifyContent: 'center',
    paddingHorizontal: espacements.l,
    borderRadius: rayons.m,
    borderWidth: 1.5,
    borderColor: couleurs.bordure,
    backgroundColor: couleurs.surface,
  },
  actionVisiteTexte: { fontSize: 15, color: couleurs.texte, fontWeight: '500' },

  viseur: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  cadre: {
    width: 240, height: 240, borderWidth: 3, borderColor: '#FFF',
    borderRadius: rayons.l, backgroundColor: 'transparent',
  },
  viseurTexte: {
    color: '#FFF', fontSize: 16, marginTop: espacements.xl, textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: espacements.l,
    paddingVertical: espacements.s, borderRadius: rayons.m,
  },
});
