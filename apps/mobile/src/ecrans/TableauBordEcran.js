/**
 * Écran d'accueil de l'agent.
 *
 * Doit répondre en un coup d'œil, au soleil, à trois questions :
 *   « où j'en suis aujourd'hui ? », « qu'est-ce qui reste à envoyer ? »,
 *   « qu'est-ce que je fais maintenant ? »
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, RefreshControl, StyleSheet, TouchableOpacity, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../contextes/AppContexte';
import { statistiquesDuJour } from '../bdd/commerces.repo';
import { Carte, Bouton, Message, EtatVide } from '../composants/ui';
import { ResumeSync } from '../composants/terrain';
import {
  couleurs, espacements, typographie, rayons, formaterXof, ombre,
} from '../theme';

export function TableauBordEcran({ navigation }) {
  const {
    utilisateur, etatSync, lancerSynchronisation, rafraichirEtatSync,
    donneesChargees, connexionFiable,
  } = useApp();

  const [stats, setStats] = useState({
    visites: 0, enregistrements: 0, paiements: 0, montant_encaisse: 0,
  });
  const [rafraichit, setRafraichit] = useState(false);
  const [syncEnCours, setSyncEnCours] = useState(false);

  const charger = useCallback(async () => {
    setStats(await statistiquesDuJour());
    await rafraichirEtatSync();
  }, [rafraichirEtatSync]);

  // useFocusEffect plutôt que useEffect : les chiffres doivent être à jour
  // quand l'agent revient de l'écran de recensement.
  useFocusEffect(useCallback(() => { charger(); }, [charger]));

  const synchroniser = async () => {
    setSyncEnCours(true);
    try {
      const bilan = await lancerSynchronisation();
      if (bilan?.ignoree) return;
      const parties = [];
      if (bilan.envoyees) parties.push(`${bilan.envoyees} enregistrement(s) envoyé(s)`);
      if (bilan.photos) parties.push(`${bilan.photos} photo(s) envoyée(s)`);
      if (bilan.recus || bilan.mis_a_jour) {
        parties.push(`${bilan.recus + bilan.mis_a_jour} fiche(s) mise(s) à jour`);
      }
      if (bilan.conflits) parties.push(`${bilan.conflits} conflit(s) à arbitrer`);
      Alert.alert('Synchronisation terminée',
        parties.length ? parties.join('\n') : 'Aucune donnée à échanger.');
    } catch (err) {
      Alert.alert(
        err.duReseau ? 'Pas de réseau' : 'Synchronisation interrompue',
        err.duReseau
          ? 'Votre travail reste enregistré sur le téléphone. Réessayez quand vous aurez du réseau.'
          : err.message,
      );
    } finally {
      setSyncEnCours(false);
      charger();
    }
  };

  if (!donneesChargees) {
    return (
      <EtatVide
        icone="cloud-download-outline"
        titre="Données de la commune non chargées"
        texte={connexionFiable
          ? 'Lancez une synchronisation pour télécharger les catégories, quartiers et commerces. C\'est nécessaire une seule fois.'
          : 'Une connexion est nécessaire pour le premier chargement. Placez-vous dans une zone couverte.'}
        action={<Bouton titre="Télécharger les données" icone="cloud-download"
          onPress={synchroniser} charge={syncEnCours} />}
      />
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: couleurs.fond }}
      contentContainerStyle={{ padding: espacements.l }}
      refreshControl={(
        <RefreshControl refreshing={rafraichit} onRefresh={async () => {
          setRafraichit(true); await charger(); setRafraichit(false);
        }}
        />
      )}
    >
      <Text style={typographie.titre}>
        Bonjour {utilisateur?.nom_complet?.split(' ')[0] ?? ''}
      </Text>
      <Text style={[typographie.petit, { marginBottom: espacements.l }]}>
        {new Date().toLocaleDateString('fr-FR', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        })}
      </Text>

      {/* --- Actions principales, en haut : c'est ce que l'agent vient faire */}
      <View style={styles.actions}>
        <ActionPrincipale
          icone="add-circle"
          titre="Recenser"
          sousTitre="Nouveau commerce"
          couleur={couleurs.primaire}
          onPress={() => navigation.navigate('Recensement')}
        />
        <ActionPrincipale
          icone="qr-code"
          titre="Scanner"
          sousTitre="QR d'un commerce"
          couleur={couleurs.primaireClair}
          onPress={() => navigation.navigate('Scanner')}
        />
      </View>

      {/* --- Le reste du domaine public : ce qui ne passe pas par une
              devanture. Un panneau de régie et un dépôt de sable n'ont ni
              enseigne ni gérant, et échappaient donc entièrement au
              recensement jusqu'ici. */}
      <View style={styles.actions}>
        <ActionPrincipale
          icone="megaphone"
          titre="Affichage"
          sousTitre="Enseigne, panneau"
          couleur={couleurs.primaireClair}
          onPress={() => navigation.navigate('Affichage')}
        />
        <ActionPrincipale
          icone="construct"
          titre="Chantier"
          sousTitre="Occupation du sol"
          couleur={couleurs.primaireClair}
          onPress={() => navigation.navigate('Chantier')}
        />
      </View>

      {/* --- Chiffres du jour */}
      <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>
        Votre journée
      </Text>
      <View style={styles.grilleStats}>
        <Statistique valeur={stats.enregistrements} libelle="Recensements" icone="storefront" />
        <Statistique valeur={stats.visites} libelle="Visites" icone="walk" />
        <Statistique valeur={stats.paiements} libelle="Encaissements" icone="cash" />
      </View>

      {stats.montant_encaisse > 0 ? (
        <Carte style={{ backgroundColor: couleurs.primaire }}>
          <Text style={{ color: '#CFE3D6', fontSize: 14 }}>Encaissé aujourd'hui</Text>
          <Text style={{ color: '#FFF', fontSize: 28, fontWeight: '700' }}>
            {formaterXof(stats.montant_encaisse)}
          </Text>
          <Text style={{ color: '#CFE3D6', fontSize: 13, marginTop: espacements.xs }}>
            À remettre en caisse à la mairie en fin de tournée
          </Text>
        </Carte>
      ) : null}

      {/* --- Synchronisation */}
      <Text style={[typographie.sousTitre, {
        marginTop: espacements.l, marginBottom: espacements.s,
      }]}
      >
        Synchronisation
      </Text>
      <ResumeSync etat={etatSync} onSynchroniser={synchroniser} occupe={syncEnCours} />

      {etatSync.rejetees > 0 ? (
        <Message
          type="erreur"
          titre={`${etatSync.rejetees} enregistrement(s) refusé(s)`}
          texte="Le serveur a refusé ces données. Consultez l'onglet Outils pour voir pourquoi."
        />
      ) : null}

      <Bouton
        titre="Voir mes commerces"
        variante="secondaire"
        icone="list"
        onPress={() => navigation.navigate('Commerces')}
        style={{ marginTop: espacements.s }}
      />
    </ScrollView>
  );
}

function ActionPrincipale({ icone, titre, sousTitre, couleur, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.action, { backgroundColor: couleur }]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`${titre} — ${sousTitre}`}
    >
      <Ionicons name={icone} size={34} color="#FFF" />
      <Text style={styles.actionTitre}>{titre}</Text>
      <Text style={styles.actionSousTitre}>{sousTitre}</Text>
    </TouchableOpacity>
  );
}

function Statistique({ valeur, libelle, icone }) {
  return (
    <View style={styles.stat}>
      <Ionicons name={icone} size={22} color={couleurs.primaire} />
      <Text style={styles.statValeur}>{valeur}</Text>
      <Text style={styles.statLibelle}>{libelle}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: espacements.m, marginBottom: espacements.xl },
  action: {
    flex: 1,
    borderRadius: rayons.l,
    padding: espacements.l,
    alignItems: 'center',
    minHeight: 120,
    justifyContent: 'center',
    ...ombre,
  },
  actionTitre: { color: '#FFF', fontSize: 17, fontWeight: '700', marginTop: espacements.s },
  actionSousTitre: { color: '#D6E8DC', fontSize: 12, marginTop: 2 },

  grilleStats: { flexDirection: 'row', gap: espacements.m, marginBottom: espacements.m },
  stat: {
    flex: 1,
    backgroundColor: couleurs.surface,
    borderRadius: rayons.m,
    padding: espacements.m,
    alignItems: 'center',
    ...ombre,
  },
  statValeur: { fontSize: 26, fontWeight: '700', color: couleurs.texte, marginTop: espacements.xs },
  statLibelle: { fontSize: 12, color: couleurs.texteSecondaire, textAlign: 'center' },
});
