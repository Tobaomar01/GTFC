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
import { Carte, EtatVide, Chargement, Message, useMargeBasse } from '../composants/ui';
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
  // Sans elle, le dernier bouton se cache sous la barre système d'Android.
  const margeBasse = useMargeBasse();
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

  // DE QUEL JOUR EST CETTE FEUILLE ?
  //
  // L'écran disait « aujourd'hui » sur ce qu'il avait en magasin, sans jamais
  // regarder date_tournee. Un agent qui synchronise lundi soir et part mardi
  // matin sans réseau parcourait donc la tournée de LUNDI, présentée comme
  // celle du jour : il repassait chez des commerçants qui ont payé depuis, et
  // manquait les priorités de la veille au soir.
  //
  // On ne cache pas la feuille pour autant — hors réseau, une tournée périmée
  // vaut mieux que rien. On dit sa date, et on invite à synchroniser.
  //
  // Le serveur envoie minuit UTC du jour ouvré ; Dakar est à UTC+0, la partie
  // date de l'ISO est donc bien le jour local.
  const jourLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
  const jourFeuille = feuille?.date_tournee?.slice(0, 10) ?? null;
  const perimee = Boolean(jourFeuille) && jourFeuille !== jourLocal;
  const dateLisible = jourFeuille
    ? new Date(`${jourFeuille}T12:00:00Z`).toLocaleDateString('fr-FR',
      { weekday: 'long', day: 'numeric', month: 'long' })
    : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: couleurs.fond }}
      contentContainerStyle={{ padding: espacements.l, paddingBottom: margeBasse }}
      refreshControl={<RefreshControl refreshing={rafraichit} onRefresh={surRafraichir} />}
    >
      {perimee ? (
        <Message
          type="avertissement"
          titre={`Feuille du ${dateLisible}`}
          texte="Elle n'a pas été mise à jour aujourd'hui. Synchronisez dès que vous avez du réseau : les commerçants qui ont payé depuis y figurent encore."
        />
      ) : null}

      {lignes.length === 0 ? (
        <EtatVide
          icone="map-outline"
          titre={perimee ? `Feuille du ${dateLisible} : aucune visite`
            : "Aucune visite prévue aujourd'hui"}
          texte={feuille
            ? 'Votre feuille est vide : soit tout est à jour dans votre secteur, soit aucun secteur ne vous est affecté. Voyez avec votre superviseur.'
            : 'Synchronisez pour recevoir votre feuille de route.'}
        />
      ) : (
        <>
          {/* Un repère de journée, pas une note : voir FR-077. */}
          <Text style={[typographie.petit, { marginBottom: espacements.m }]}>
            {lignes.length} visite{lignes.length > 1 ? 's' : ''} prévue
            {lignes.length > 1 ? 's' : ''} {perimee ? `le ${dateLisible}` : "aujourd'hui"}
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
