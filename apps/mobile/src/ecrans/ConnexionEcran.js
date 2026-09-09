/**
 * Connexion et premier changement de mot de passe.
 *
 * Particularité assumée : la connexion EXIGE du réseau. Impossible de vérifier
 * un mot de passe hors ligne sans stocker de quoi le vérifier sur le
 * téléphone — ce qui reviendrait à mettre l'annuaire des agents dans la poche
 * de quiconque vole l'appareil.
 *
 * En revanche, une fois connecté, l'agent reste connecté : le jeton de
 * rafraîchissement dure 30 jours. Il peut travailler des journées entières
 * sans réseau. Seule la toute première connexion demande de la couverture.
 */
import React, { useState } from 'react';
import {
  View, Text, ScrollView, KeyboardAvoidingView, Platform, StyleSheet, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../contextes/AppContexte';
import { Bouton, Champ, Message } from '../composants/ui';
import { couleurs, espacements, typographie, rayons } from '../theme';
import { api, PROBLEME_ADRESSE_API } from '../api/client';

/**
 * Message à afficher au prochain passage sur l'écran de connexion.
 *
 * Les deux écrans de ce fichier ne se voient pas : l'un remplace l'autre dans
 * la pile. Quand le changement de mot de passe réussit mais que la reconnexion
 * échoue, l'agent atterrit ici sans savoir pourquoi — et son ancien mot de
 * passe ne marche plus. Cette variable porte l'explication.
 */
let avisConnexion = null;

export function ConnexionEcran() {
  const { connecter, connexionFiable } = useApp();
  const [avis] = useState(() => { const a = avisConnexion; avisConnexion = null; return a; });
  const [telephone, setTelephone] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [visible, setVisible] = useState(false);
  const [erreur, setErreur] = useState(null);
  const [charge, setCharge] = useState(false);

  const valider = async () => {
    setErreur(null);

    const numero = telephone.replace(/[\s.-]/g, '');
    if (!/^\+?[0-9]{8,15}$/.test(numero)) {
      setErreur('Numéro de téléphone invalide. Exemple : +221771234567');
      return;
    }
    if (!motDePasse) {
      setErreur('Saisissez votre mot de passe');
      return;
    }

    setCharge(true);
    try {
      await connecter(numero, motDePasse);
    } catch (err) {
      if (err.duReseau) {
        setErreur(
          'Impossible de joindre le serveur. La première connexion nécessite du réseau — '
          + 'placez-vous dans une zone couverte, ensuite vous pourrez travailler hors ligne.',
        );
      } else {
        setErreur(err.message);
      }
    } finally {
      setCharge(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: couleurs.primaire }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.defilement} keyboardShouldPersistTaps="handled">
        <View style={styles.entete}>
          <View style={styles.logo}>
            <Ionicons name="business" size={44} color={couleurs.primaire} />
          </View>
          <Text style={styles.titre}>Collecte des taxes locales</Text>
          <Text style={styles.sousTitre}>Application des agents de terrain</Text>
        </View>

        {avis ? (
          <Message type="succes" titre="Mot de passe modifié" texte={avis} />
        ) : null}

        {/* Dit AVANT la connexion, pas après une journée de recensement
            perdue : un APK sans son adresse de serveur laisse croire à une
            panne de réseau alors que le réseau va très bien. */}
        {PROBLEME_ADRESSE_API ? (
          <Message type="erreur" titre="Cet APK n'est pas prêt pour le terrain">
            {PROBLEME_ADRESSE_API}
          </Message>
        ) : null}

        <View style={styles.formulaire}>
          {!connexionFiable ? (
            <Message
              type="avertissement"
              titre="Aucune connexion détectée"
              texte="La connexion à votre compte nécessite du réseau, une seule fois. Ensuite l'application fonctionne hors ligne."
            />
          ) : null}

          <Champ
            etiquette="Numéro de téléphone"
            valeur={telephone}
            onChangeText={setTelephone}
            placeholder="+221 77 123 45 67"
            keyboardType="phone-pad"
            autoComplete="tel"
            autoCorrect={false}
            obligatoire
          />

          <Champ
            etiquette="Mot de passe"
            valeur={motDePasse}
            onChangeText={setMotDePasse}
            secureTextEntry={!visible}
            autoCapitalize="none"
            autoCorrect={false}
            obligatoire
            suffixe={visible ? 'Masquer' : 'Afficher'}
            onSubmitEditing={valider}
            returnKeyType="go"
          />
          <Bouton
            titre={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
            variante="discret"
            onPress={() => setVisible((v) => !v)}
            icone={visible ? 'eye-off-outline' : 'eye-outline'}
            style={{ marginTop: -espacements.m, marginBottom: espacements.m }}
          />

          {erreur ? <Message type="erreur" texte={erreur} /> : null}

          <Bouton titre="Se connecter" onPress={valider} charge={charge} icone="log-in-outline" />

          <Text style={styles.aide}>
            Mot de passe oublié ou compte bloqué ? Contactez votre superviseur :
            lui seul peut réinitialiser votre accès.
          </Text>
          <Text style={styles.serveur}>{api.urlBase}</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ===========================================================================
/**
 * Changement de mot de passe imposé à la première connexion.
 * Écran bloquant : tant qu'il n'est pas passé, l'agent n'accède à rien —
 * c'est ce qui garantit qu'aucun compte ne reste sur le mot de passe
 * provisoire communiqué à l'oral.
 */
export function ChangerMotDePasseEcran() {
  const { marquerMotDePasseChange, deconnecter, connecter, telephoneConnecte } = useApp();
  const [ancien, setAncien] = useState('');
  const [nouveau, setNouveau] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreur, setErreur] = useState(null);
  const [charge, setCharge] = useState(false);

  const regles = [
    { texte: 'Au moins 10 caractères', ok: nouveau.length >= 10 },
    { texte: 'Une majuscule', ok: /[A-Z]/.test(nouveau) },
    { texte: 'Une minuscule', ok: /[a-z]/.test(nouveau) },
    { texte: 'Un chiffre', ok: /[0-9]/.test(nouveau) },
  ];
  const toutesRespectees = regles.every((r) => r.ok);

  const valider = async () => {
    setErreur(null);
    if (!toutesRespectees) { setErreur('Le mot de passe ne respecte pas toutes les règles'); return; }
    if (nouveau !== confirmation) { setErreur('Les deux mots de passe ne correspondent pas'); return; }

    setCharge(true);
    let change = false;
    try {
      await api.changerMotDePasse(ancien, nouveau);
      change = true;

      // Changer de mot de passe révoque TOUTES les sessions du compte, y
      // compris celle qui vient de le faire — la nôtre. Mesuré le 09/09/2026 :
      // le jeton de rafraîchissement rendait 401 dès l'instant du changement.
      //
      // Sans ce qui suit, l'agent continuait quinze minutes sur son jeton
      // d'accès, puis se retrouvait éjecté à l'écran de connexion, en pleine
      // tournée, peut-être sans réseau — et la connexion, elle, EXIGE du
      // réseau (voir l'en-tête de ce fichier). Sa journée de saisie restait
      // dans le téléphone, inatteignable jusqu'à retrouver de la couverture.
      //
      // On se reconnecte donc immédiatement, tant qu'on sait le réseau
      // disponible : le changement vient de passer par lui.
      if (telephoneConnecte) {
        await connecter(telephoneConnecte, nouveau);
      } else {
        // Session d'avant cette correction : le numéro n'y a pas été rangé.
        await marquerMotDePasseChange();
      }
    } catch (err) {
      if (change) {
        // Le mot de passe EST changé, seule la reconnexion a échoué. Redire
        // « réessayez » serait un piège : l'ancien mot de passe n'existe plus,
        // et l'écran le redemande. On renvoie à la connexion en le disant.
        setErreur(null);
        avisConnexion = 'Votre nouveau mot de passe est enregistré. La reconnexion '
          + "automatique n'a pas abouti : connectez-vous avec ce nouveau mot de passe.";
        await deconnecter({ forcer: true }).catch(() => {});
        return;
      }
      setErreur(err.duReseau
        ? 'Réseau indisponible. Le changement de mot de passe nécessite une connexion.'
        : err.message);
    } finally {
      setCharge(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: couleurs.fond }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: espacements.l }}
        keyboardShouldPersistTaps="handled"
      >
        <Message
          type="info"
          titre="Choisissez votre mot de passe"
          texte="Le mot de passe qui vous a été communiqué est provisoire. Choisissez-en un que vous seul connaissez."
        />

        <Champ etiquette="Mot de passe provisoire" valeur={ancien} onChangeText={setAncien}
          secureTextEntry autoCapitalize="none" obligatoire />

        <Champ etiquette="Nouveau mot de passe" valeur={nouveau} onChangeText={setNouveau}
          secureTextEntry autoCapitalize="none" obligatoire />

        <View style={styles.regles}>
          {regles.map((r) => (
            <View key={r.texte} style={styles.regle}>
              <Ionicons
                name={r.ok ? 'checkmark-circle' : 'ellipse-outline'}
                size={18}
                color={r.ok ? couleurs.succes : couleurs.texteDesactive}
              />
              <Text style={[typographie.petit, r.ok && { color: couleurs.succes }]}>
                {r.texte}
              </Text>
            </View>
          ))}
        </View>

        <Champ etiquette="Confirmez le nouveau mot de passe" valeur={confirmation}
          onChangeText={setConfirmation} secureTextEntry autoCapitalize="none" obligatoire
          erreur={confirmation && nouveau !== confirmation ? 'Les deux saisies diffèrent' : null} />

        {erreur ? <Message type="erreur" texte={erreur} /> : null}

        <Bouton titre="Enregistrer" onPress={valider} charge={charge}
          desactive={!toutesRespectees || nouveau !== confirmation} />

        <Bouton titre="Se déconnecter" variante="discret"
          onPress={() => deconnecter({ forcer: true })}
          style={{ marginTop: espacements.m }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  defilement: { flexGrow: 1, justifyContent: 'center' },
  entete: { alignItems: 'center', paddingVertical: espacements.xxl },
  logo: {
    width: 84, height: 84, borderRadius: 42, backgroundColor: '#FFF',
    alignItems: 'center', justifyContent: 'center', marginBottom: espacements.l,
  },
  titre: { fontSize: 22, fontWeight: '700', color: '#FFF', textAlign: 'center' },
  sousTitre: { fontSize: 15, color: '#CFE3D6', marginTop: espacements.xs },
  formulaire: {
    backgroundColor: couleurs.fond,
    borderTopLeftRadius: rayons.l * 1.5,
    borderTopRightRadius: rayons.l * 1.5,
    padding: espacements.xl,
    minHeight: 420,
  },
  aide: {
    ...typographie.petit,
    textAlign: 'center',
    marginTop: espacements.xl,
    lineHeight: 20,
  },
  serveur: {
    fontSize: 12,
    color: couleurs.texteDesactive,
    textAlign: 'center',
    marginTop: espacements.l,
  },
  regles: { marginTop: -espacements.s, marginBottom: espacements.l, gap: espacements.xs },
  regle: { flexDirection: 'row', alignItems: 'center', gap: espacements.s },
});
