/**
 * Synchronisation, diagnostic et paramètres.
 *
 * C'est l'écran qu'on demande à l'agent d'ouvrir quand il appelle en disant
 * « ça ne marche pas ». Il doit donc montrer, sans jargon : ce qui reste à
 * envoyer, ce qui a été refusé et pourquoi, et l'état du téléphone.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Alert, StyleSheet, TouchableOpacity, RefreshControl, Share,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import * as Device from 'expo-device';

import { useApp } from '../contextes/AppContexte';
import { statistiquesBase, lireTout, reinitialiser } from '../bdd/database';
import * as sync from '../bdd/sync.repo';
import { espaceOccupe } from '../services/photos';
import { api } from '../api/client';
import {
  Bouton, Carte, Message, LigneInfo, Separateur, EtatVide,
} from '../composants/ui';
import { ResumeSync } from '../composants/terrain';
import {
  couleurs, espacements, typographie, rayons, formaterDate, formaterDelai,
} from '../theme';

export function OutilsEcran({ navigation }) {
  const {
    utilisateur, etatSync, lancerSynchronisation, deconnecter, connexionFiable,
  } = useApp();

  const [stats, setStats] = useState(null);
  const [espace, setEspace] = useState(null);
  const [bloquees, setBloquees] = useState([]);
  const [occupe, setOccupe] = useState(false);
  const [rafraichit, setRafraichit] = useState(false);

  const charger = useCallback(async () => {
    setStats(await statistiquesBase());
    setBloquees(await sync.operationsBloquees());
    setEspace(await espaceOccupe().catch(() => null));
  }, []);

  useFocusEffect(useCallback(() => { charger(); }, [charger]));

  const synchroniser = async () => {
    setOccupe(true);
    try {
      const bilan = await lancerSynchronisation();
      if (!bilan?.ignoree) {
        Alert.alert('Synchronisation terminée',
          `Envoyés : ${bilan.envoyees ?? 0}\nPhotos : ${bilan.photos ?? 0}\n`
          + `Reçus : ${(bilan.recus ?? 0) + (bilan.mis_a_jour ?? 0)}`
          + (bilan.conflits ? `\nConflits : ${bilan.conflits}` : ''));
      }
    } catch (err) {
      Alert.alert(err.duReseau ? 'Pas de réseau' : 'Erreur', err.message);
    } finally {
      setOccupe(false);
      charger();
    }
  };

  const seDeconnecter = async () => {
    try {
      await deconnecter();
    } catch (err) {
      if (err.code === 'TRAVAIL_NON_SYNCHRONISE') {
        Alert.alert(
          'Travail non synchronisé',
          `${err.etat.en_attente} enregistrement(s) et ${err.etat.photos_en_attente} photo(s) `
          + 'ne sont pas encore partis. Si vous vous déconnectez maintenant, ils seront perdus.',
          [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Synchroniser d\'abord', onPress: synchroniser },
            {
              text: 'Perdre et se déconnecter',
              style: 'destructive',
              onPress: () => deconnecter({ forcer: true }),
            },
          ],
        );
      } else {
        Alert.alert('Erreur', err.message);
      }
    }
  };

  const exporterJournal = async () => {
    const lignes = await lireTout(
      'SELECT niveau, message, detail, horodatage FROM journal_local ORDER BY id DESC LIMIT 200');
    const texte = [
      `Diagnostic GTFC Collecte — ${new Date().toLocaleString('fr-FR')}`,
      `Agent : ${utilisateur?.nom_complet} (${utilisateur?.role})`,
      `Commune : ${utilisateur?.commune_nom}`,
      `Version : ${Application.nativeApplicationVersion} (${Application.nativeBuildVersion})`,
      `Appareil : ${Device.manufacturer} ${Device.modelName} — Android ${Device.osVersion}`,
      `Serveur : ${api.urlBase}`,
      `En attente : ${stats?.operations_en_attente} opérations, ${stats?.photos_en_attente} photos`,
      '',
      ...lignes.map((l) => `[${l.horodatage}] ${l.niveau.toUpperCase()} ${l.message}`
        + (l.detail ? ` — ${l.detail}` : '')),
    ].join('\n');

    await Share.share({ message: texte, title: 'Diagnostic GTFC Collecte' });
  };

  const reinitialiserBase = () => {
    Alert.alert(
      'Réinitialiser l\'application',
      'Toutes les données locales seront effacées. À ne faire que sur demande de votre superviseur.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Effacer',
          style: 'destructive',
          onPress: async () => {
            try {
              await reinitialiser();
              Alert.alert('Terminé', 'Données locales effacées. Synchronisez pour les recharger.');
              charger();
            } catch (err) {
              // Le garde-fou a joué : il reste du travail non envoyé.
              Alert.alert('Impossible', err.message);
            }
          },
        },
      ],
    );
  };

  if (!stats) return <EtatVide icone="settings-outline" titre="Chargement…" />;

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
      <ResumeSync etat={etatSync} onSynchroniser={synchroniser} occupe={occupe} />

      {!connexionFiable ? (
        <Message
          type="avertissement"
          titre="Hors ligne"
          texte="Continuez à travailler : tout est enregistré sur le téléphone et partira automatiquement au retour du réseau."
        />
      ) : null}

      {/* ------- Éléments bloqués ------- */}
      {bloquees.length > 0 ? (
        <Carte>
          <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>
            {bloquees.length} élément(s) à examiner
          </Text>
          {bloquees.slice(0, 10).map((o) => (
            <View key={o.id} style={styles.bloquee}>
              <Ionicons
                name={o.statut === 'conflit' ? 'git-compare-outline' : 'close-circle-outline'}
                size={20}
                color={o.statut === 'conflit' ? couleurs.avertissement : couleurs.erreur}
              />
              <View style={{ flex: 1, marginLeft: espacements.s }}>
                <Text style={[typographie.corps, { fontWeight: '600' }]}>
                  {o.entite} — {o.operation}
                </Text>
                <Text style={typographie.petit} numberOfLines={2}>
                  {o.message ?? 'Sans message'}
                </Text>
                <Text style={[typographie.petit, { fontSize: 12 }]}>
                  {formaterDate(o.cree_le, { avecHeure: true })}
                </Text>
              </View>
              {o.statut !== 'conflit' ? (
                <TouchableOpacity
                  onPress={async () => { await sync.reessayerOperation(o.id); charger(); }}
                  style={styles.boutonReessayer}
                >
                  <Ionicons name="refresh" size={20} color={couleurs.primaire} />
                </TouchableOpacity>
              ) : null}
            </View>
          ))}

          {bloquees.some((o) => o.statut === 'conflit') ? (
            <Message
              type="info"
              texte="Les conflits se règlent depuis le tableau de bord de la mairie : un superviseur choisit quelle version conserver."
            />
          ) : null}
        </Carte>
      ) : null}

      {/* ------- État du téléphone ------- */}
      <Carte>
        <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>
          Données sur ce téléphone
        </Text>
        <LigneInfo etiquette="Commerces" valeur={stats.commerces} icone="storefront-outline" />
        <LigneInfo etiquette="À envoyer" valeur={stats.operations_en_attente} icone="cloud-upload-outline" />
        <LigneInfo etiquette="Photos en attente" valeur={stats.photos_en_attente} icone="images-outline" />
        <LigneInfo etiquette="Dernière synchronisation"
          valeur={formaterDelai(stats.derniere_sync)} icone="time-outline" />
        {espace ? (
          <LigneInfo
            etiquette="Espace photos"
            valeur={`${espace.mega_octets.toFixed(1)} Mo (${espace.fichiers} fichiers)`}
            icone="folder-outline"
          />
        ) : null}
      </Carte>

      {/* ------- Compte ------- */}
      <Carte>
        <Text style={[typographie.sousTitre, { marginBottom: espacements.s }]}>Mon compte</Text>
        <LigneInfo etiquette="Nom" valeur={utilisateur?.nom_complet} icone="person-outline" />
        <LigneInfo etiquette="Rôle" valeur={utilisateur?.role} icone="ribbon-outline" />
        <LigneInfo etiquette="Commune" valeur={utilisateur?.commune_nom} icone="business-outline" />
      </Carte>

      <Separateur titre="Assistance" />

      <Bouton
        titre="Envoyer un diagnostic"
        variante="secondaire"
        icone="bug-outline"
        onPress={exporterJournal}
      />
      <Text style={[typographie.petit, { marginTop: espacements.xs, marginBottom: espacements.l }]}>
        Transmettez ce texte à votre superviseur en cas de problème. Il ne contient aucune
        donnée de commerce, seulement l'état technique de l'application.
      </Text>

      <Bouton titre="Se déconnecter" variante="secondaire" icone="log-out-outline"
        onPress={seDeconnecter} />

      <Bouton titre="Réinitialiser l'application" variante="danger" icone="trash-outline"
        onPress={reinitialiserBase} style={{ marginTop: espacements.xxl }} />

      <Text style={styles.pied}>
        GTFC Collecte {Application.nativeApplicationVersion}
        {' '}(build {Application.nativeBuildVersion}){'\n'}
        {api.urlBase}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bloquee: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: espacements.s,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: couleurs.bordure,
  },
  boutonReessayer: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: rayons.m,
  },
  pied: {
    ...typographie.petit,
    fontSize: 12,
    textAlign: 'center',
    marginTop: espacements.xxl,
    marginBottom: espacements.xxl,
    lineHeight: 18,
  },
});
