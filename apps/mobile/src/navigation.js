/**
 * Navigation.
 *
 * Trois onglets seulement. Un agent qui travaille debout, au soleil, avec un
 * téléphone d'entrée de gamme, ne doit jamais chercher où appuyer.
 *
 * L'aiguillage est strict :
 *   pas de session          -> écran de connexion
 *   mot de passe provisoire -> écran de changement, bloquant
 *   session valide          -> application
 */
import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from './contextes/AppContexte';
import { ConnexionEcran, ChangerMotDePasseEcran } from './ecrans/ConnexionEcran';
import { TableauBordEcran } from './ecrans/TableauBordEcran';
import { RecensementEcran } from './ecrans/RecensementEcran';
import { AffichageEcran } from './ecrans/AffichageEcran';
import { ChantierEcran } from './ecrans/ChantierEcran';
import {
  ListeCommercesEcran, FicheCommerceEcran, ScannerEcran, EncaissementEcran,
} from './ecrans/CommercesEcran';
import { OutilsEcran } from './ecrans/OutilsEcran';
import { BandeauEtat } from './composants/terrain';
import { couleurs } from './theme';

const Pile = createNativeStackNavigator();
const Onglets = createBottomTabNavigator();

const enTete = {
  headerStyle: { backgroundColor: couleurs.primaire },
  headerTintColor: '#FFF',
  headerTitleStyle: { fontWeight: '700' },
};

function Barre() {
  return (
    <Onglets.Navigator
      screenOptions={({ route }) => ({
        ...enTete,
        tabBarActiveTintColor: couleurs.primaire,
        tabBarInactiveTintColor: couleurs.texteDesactive,
        // 60 px : un pouce ne vise pas juste sur une icône de 24 px.
        tabBarStyle: { height: 60, paddingBottom: 6, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarIcon: ({ color, size }) => {
          const icones = {
            Accueil: 'home',
            Commerces: 'storefront',
            Outils: 'settings',
          };
          return <Ionicons name={icones[route.name] ?? 'ellipse'} size={size} color={color} />;
        },
      })}
    >
      <Onglets.Screen name="Accueil" component={TableauBordEcran}
        options={{ title: 'Collecte des taxes' }} />
      <Onglets.Screen name="Commerces" component={ListeCommercesEcran}
        options={{ title: 'Mes commerces' }} />
      <Onglets.Screen name="Outils" component={OutilsEcran}
        options={{ title: 'Synchronisation et outils' }} />
    </Onglets.Navigator>
  );
}

export function Navigation() {
  const { pret, connecte, doitChangerMotDePasse } = useApp();

  if (!pret) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center',
        backgroundColor: couleurs.primaire }}
      >
        <ActivityIndicator size="large" color="#FFF" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {/* Le bandeau vit HORS du navigateur : il doit rester visible sur tous
          les écrans, y compris pendant une navigation. */}
      {connecte && !doitChangerMotDePasse ? <BandeauEtat /> : null}

      <Pile.Navigator screenOptions={enTete}>
        {!connecte ? (
          <Pile.Screen name="Connexion" component={ConnexionEcran}
            options={{ headerShown: false }} />
        ) : doitChangerMotDePasse ? (
          <Pile.Screen name="ChangerMotDePasse" component={ChangerMotDePasseEcran}
            options={{ title: 'Nouveau mot de passe', headerBackVisible: false }} />
        ) : (
          <>
            <Pile.Screen name="Principal" component={Barre}
              options={{ headerShown: false }} />
            <Pile.Screen name="Recensement" component={RecensementEcran}
              options={{ title: 'Recenser un commerce' }} />
            {/* Les deux familles d'objets taxables qui ne passent pas par une
                devanture : un panneau de régie et un dépôt de sable n'ont ni
                enseigne ni gérant. */}
            <Pile.Screen name="Affichage" component={AffichageEcran}
              options={{ title: 'Recenser un dispositif' }} />
            <Pile.Screen name="Chantier" component={ChantierEcran}
              options={{ title: 'Constater un chantier' }} />
            <Pile.Screen name="Scanner" component={ScannerEcran}
              options={{ title: 'Scanner un QR code' }} />
            <Pile.Screen name="FicheCommerce" component={FicheCommerceEcran}
              options={{ title: 'Fiche commerce' }} />
            <Pile.Screen name="Encaissement" component={EncaissementEcran}
              options={{ title: 'Encaissement' }} />
          </>
        )}
      </Pile.Navigator>
    </NavigationContainer>
  );
}
