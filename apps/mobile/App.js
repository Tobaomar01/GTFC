/**
 * Point d'entrée de l'application.
 *
 * L'écran de démarrage reste affiché tant que la base locale n'est pas
 * ouverte : sans elle, aucun écran n'a de données à montrer, et un écran vide
 * qui se remplit une seconde plus tard donne l'impression d'un bug.
 */
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { FournisseurApp } from './src/contextes/AppContexte';
import { Navigation } from './src/navigation';
import { couleurs } from './src/theme';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor={couleurs.primaire} />
        <FournisseurApp>
          <Navigation />
        </FournisseurApp>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
