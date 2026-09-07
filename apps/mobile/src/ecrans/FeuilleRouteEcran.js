/**
 * La feuille de route du jour — FR-072 à FR-077.
 *
 * Elle répond à une seule question, et doit y répondre au soleil, en marchant :
 * « chez qui je vais maintenant, et pourquoi ? »
 *
 * LE MOTIF EST AUSSI IMPORTANT QUE L'ADRESSE. Un agent qui sait qu'il entre
 * chez quelqu'un qui n'a jamais rien réglé ne tient pas le même discours que
 * chez quelqu'un qui a payé puis s'est arrêté. Sans le motif, il improvise.
 *
 * CE QUE CET ÉCRAN NE FAIT PAS. Il n'affiche aucun pourcentage d'achèvement et
 * ne compare rien à un objectif personnel. FR-077 l'interdit : le nombre sert
 * l'agent à se repérer dans sa journée, il ne le note pas.
 *
 * Tout vient de la base locale : l'écran fonctionne hors ligne, ce qui est la
 * situation ordinaire d'un agent en tournée.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, RefreshControl, StyleSheet, TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { lireReferentiel } from '../bdd/sync.repo';
import { listerCommerces } from '../bdd/commerces.repo';
import { Carte, EtatVide, Chargement } from '../composants/ui';
import { couleurs, espacements, typographie, rayons, ombre } from '../theme';

/**
 * Ce que l'agent doit avoir en tête en entrant. Le serveur envoie le code du
 * motif, pas sa phrase : le téléphone la connaît, et une version ancienne de
 * l'application affiche encore quelque chose de sensé.
 */
const MOTIFS = {
  fiche_a_completer: {
    titre: 'Fiche à compléter',
    aide: 'Le gérant n\'est pas joignable : sans son numéro, aucun avis ne part.',
    icone: 'person-add-outline',
    couleur: '#B26A00',
  },
  jamais_paye: {
    titre: 'N\'a jamais rien réglé',
    aide: 'Expliquer le dispositif : comment payer par Wave, et pourquoi.',
    icone: 'help-circle-outline',
    couleur: '#B3261E',
  },
  paiement_interrompu: {
    titre: 'A payé, puis s\'est arrêté',
    aide: 'Comprendre ce qui a changé. Il avait compris le principe.',
    icone: 'pause-circle-outline',
    couleur: '#8C5000',
  },
  paiement_partiel: {
    titre: 'Ne règle qu\'une partie',
    aide: 'Le principe est compris, pas le montant. Reprendre le détail de l\'avis.',
    icone: 'pie-chart-outline',
    couleur: '#6B4E00',
  },
  suivi_recensement: {
    titre: 'Visite de suivi',
    aide: 'Recensé il y a quelques semaines, avant son premier avis. Vérifier '
      + 'que le gérant a compris comment ça marche, pendant que la '
      + 'conversation est encore neutre.',
    icone: 'checkmark-circle-outline',
    couleur: couleurs.primaire,
  },
  echeance_depassee: {
    titre: 'Échéance dépassée',
    aide: 'Relance.',
    icone: 'time-outline',
    couleur: '#B3261E',
  },
  ajout_superviseur: {
    titre: 'Ajouté par le superviseur',
    aide: 'Cette visite a été demandée à la main.',
    icone: 'bookmark-outline',
    couleur: couleurs.primaire,
  },
};

export function FeuilleRouteEcran({ navigation }) {
  const [feuille, setFeuille] = useState(undefined);
  const [fiches, setFiches] = useState({});
  const [rafraichit, setRafraichit] = useState(false);

  const charger = useCallback(async () => {
    const f = await lireReferentiel('feuille_de_route', null);
    setFeuille(f);

    // Le serveur n'envoie que des identifiants : les fiches sont déjà là,
    // les renvoyer aurait doublé le poids du paquet.
    const tous = await listerCommerces({ limite: 5000 });
    const parId = {};
    for (const c of tous) {
      if (c.id_serveur) parId[c.id_serveur] = c;
    }
    setFiches(parId);
  }, []);

  useFocusEffect(useCallback(() => { charger(); }, [charger]));

  const surRafraichir = useCallback(async () => {
    setRafraichit(true);
    try { await charger(); } finally { setRafraichit(false); }
  }, [charger]);

  if (feuille === undefined) return <Chargement />;

  const lignes = feuille?.lignes ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: couleurs.fond }}
      contentContainerStyle={{ padding: espacements.l, paddingBottom: espacements.xxl }}
      refreshControl={<RefreshControl refreshing={rafraichit} onRefresh={surRafraichir} />}
    >
      {lignes.length === 0 ? (
        <EtatVide
          icone="map-outline"
          titre="Aucune visite prévue aujourd'hui"
          texte={feuille
            ? 'Votre feuille est vide : soit tout est à jour dans votre secteur, soit aucun secteur ne vous est affecté. Voyez avec votre superviseur.'
            : 'Synchronisez pour recevoir votre feuille de route.'}
        />
      ) : (
        <>
          {/* Un repère de journée, pas une note : voir FR-077. */}
          <Text style={[typographie.petit, { marginBottom: espacements.m }]}>
            {lignes.length} visite{lignes.length > 1 ? 's' : ''} prévue
            {lignes.length > 1 ? 's' : ''} aujourd'hui
          </Text>

          {lignes.map((l) => {
            const m = MOTIFS[l.motif] ?? {
              titre: l.motif, aide: '', icone: 'ellipse-outline', couleur: couleurs.texteSecondaire,
            };
            const fiche = fiches[l.commerce_id];
            return (
              <TouchableOpacity
                key={l.commerce_id}
                activeOpacity={0.7}
                disabled={!fiche}
                onPress={() => fiche && navigation.navigate('FicheCommerce', {
                  idLocal: fiche.id_local,
                })}
              >
                <Carte style={styles.ligne}>
                  <View style={styles.entete}>
                    <Ionicons name={m.icone} size={22} color={m.couleur} />
                    <Text style={[styles.motif, { color: m.couleur }]}>{m.titre}</Text>
                  </View>

                  <Text style={typographie.sousTitre}>
                    {fiche?.enseigne ?? 'Fiche non téléchargée'}
                  </Text>
                  <Text style={typographie.petit}>
                    {[fiche?.code, fiche?.adresse_libelle].filter(Boolean).join(' · ') || '—'}
                  </Text>

                  {m.aide ? <Text style={styles.aide}>{m.aide}</Text> : null}

                  {!fiche ? (
                    <Text style={styles.absente}>
                      Cette fiche n'est pas sur le téléphone. Synchronisez avant de partir.
                    </Text>
                  ) : null}
                </Carte>
              </TouchableOpacity>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  ligne: { marginBottom: espacements.m },
  entete: { flexDirection: 'row', alignItems: 'center', marginBottom: espacements.s },
  motif: { marginLeft: espacements.s, fontWeight: '700', fontSize: 14 },
  aide: {
    marginTop: espacements.s,
    fontSize: 13,
    lineHeight: 18,
    color: couleurs.texteSecondaire,
  },
  absente: {
    marginTop: espacements.s, fontSize: 13, color: couleurs.impaye, fontWeight: '600',
  },
});
