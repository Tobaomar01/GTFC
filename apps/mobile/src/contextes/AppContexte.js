/**
 * État global de l'application : session, réseau, synchronisation.
 *
 * Un seul contexte plutôt que trois : ces trois états sont indissociables sur
 * le terrain. Le retour du réseau déclenche une synchronisation, une session
 * expirée l'interrompt, et l'agent voit les trois dans la même barre d'état.
 */
import React, {
  createContext, useContext, useEffect, useState, useCallback, useRef, useMemo,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import NetInfo from '@react-native-community/netinfo';

import { api, definirJetons, definirRappelExpiration } from '../api/client';
import { ouvrirBase, journaliser } from '../bdd/database';
import { referentielsPresents } from '../bdd/sync.repo';
import * as syncService from '../services/sync.service';

const CLE_SESSION = 'gtfc.session';

const AppContexte = createContext(null);

export function FournisseurApp({ children }) {
  const [pret, setPret] = useState(false);
  const [session, setSession] = useState(null);
  const [enLigne, setEnLigne] = useState(true);
  const [connexionFiable, setConnexionFiable] = useState(true);
  const [etatSync, setEtatSync] = useState({
    en_attente: 0, photos_en_attente: 0, conflits: 0, a_synchroniser: false, en_cours: false,
  });
  const [donneesChargees, setDonneesChargees] = useState(false);
  const [progression, setProgression] = useState(null);

  // `useRef` et non `useState` : on lit cette valeur dans un écouteur réseau
  // qui capturerait sinon une version périmée de la session.
  const sessionRef = useRef(null);
  const syncAutoFaite = useRef(false);

  // -------------------------------------------------------------------------
  // Démarrage
  // -------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        await ouvrirBase();

        const brut = await SecureStore.getItemAsync(CLE_SESSION);
        if (brut) {
          const s = JSON.parse(brut);
          sessionRef.current = s;
          setSession(s);
          definirJetons({ acces: s.jeton_acces, rafraichissement: s.jeton_rafraichissement });
        }

        setDonneesChargees(await referentielsPresents());
        await rafraichirEtatSync();
      } catch (err) {
        await journaliser('erreur', 'Échec du démarrage', { message: err.message });
      } finally {
        setPret(true);
      }
    })();
  }, []);

  // -------------------------------------------------------------------------
  // Session expirée signalée par le client HTTP
  // -------------------------------------------------------------------------
  useEffect(() => {
    definirRappelExpiration(async () => {
      await journaliser('avertissement', 'Session expirée — déconnexion');
      await effacerSession();
    });
  }, []);

  // -------------------------------------------------------------------------
  // Surveillance du réseau
  // -------------------------------------------------------------------------
  useEffect(() => {
    const arreter = NetInfo.addEventListener((etat) => {
      const connecte = Boolean(etat.isConnected);
      // `isInternetReachable` distingue « connecté au wifi » de « l'internet
      // répond ». Un portail captif de cybercafé donne le premier sans le
      // second, et ferait échouer toutes les synchronisations.
      const utilisable = connecte && etat.isInternetReachable !== false;

      setEnLigne(connecte);
      setConnexionFiable(utilisable);

      if (utilisable && sessionRef.current && !syncAutoFaite.current) {
        syncAutoFaite.current = true;
        // Léger délai : au retour du réseau, la connexion met quelques
        // secondes à se stabiliser. Partir trop tôt fait échouer le premier lot.
        setTimeout(() => { lancerSynchronisation({ automatique: true }); }, 3000);
      }
      if (!utilisable) syncAutoFaite.current = false;
    });
    return arreter;
  }, []);

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------
  const enregistrerSession = useCallback(async (donnees, { telephone } = {}) => {
    const s = {
      jeton_acces: donnees.jeton_acces,
      jeton_rafraichissement: donnees.jeton_rafraichissement,
      utilisateur: donnees.utilisateur,
      doit_changer_mot_de_passe: donnees.doit_changer_mot_de_passe,
      // Le numéro n'est PAS dans la réponse de /auth/login : on garde celui que
      // l'agent a saisi. Il sert à se reconnecter juste après un changement de
      // mot de passe, qui coupe la session en cours (voir ChangerMotDePasseEcran).
      telephone: telephone ?? sessionRef.current?.telephone ?? null,
      connecte_le: new Date().toISOString(),
    };
    await SecureStore.setItemAsync(CLE_SESSION, JSON.stringify(s));
    sessionRef.current = s;
    setSession(s);
    definirJetons({ acces: s.jeton_acces, rafraichissement: s.jeton_rafraichissement });
    return s;
  }, []);

  const effacerSession = useCallback(async () => {
    await SecureStore.deleteItemAsync(CLE_SESSION);
    sessionRef.current = null;
    setSession(null);
    definirJetons({ acces: null, rafraichissement: null });
  }, []);

  const connecter = useCallback(async (telephone, motDePasse) => {
    const donnees = await api.connexion({
      telephone,
      mot_de_passe: motDePasse,
      appareil_id: Device.osInternalBuildId ?? Device.modelName ?? undefined,
      appareil_modele: `${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim() || undefined,
      version_app: Application.nativeApplicationVersion ?? '1.0.0',
    });
    const s = await enregistrerSession(donnees, { telephone });

    // Premier chargement : sans référentiels, aucun formulaire n'est saisissable.
    if (!(await referentielsPresents())) {
      try {
        await syncService.chargementInitial(setProgression);
        setDonneesChargees(true);
      } catch (err) {
        await journaliser('avertissement', 'Chargement initial impossible',
          { message: err.message });
      } finally {
        setProgression(null);
      }
    } else {
      setDonneesChargees(true);
    }

    await rafraichirEtatSync();
    return s;
  }, [enregistrerSession]);

  /**
   * Déconnexion.
   *
   * Refusée s'il reste du travail non synchronisé : la session fermée, l'agent
   * ne pourrait plus remonter sa journée. Le paramètre `forcer` existe pour le
   * cas où l'agent rend son téléphone, et l'écran affiche alors ce qui sera perdu.
   */
  const deconnecter = useCallback(async ({ forcer = false } = {}) => {
    const etat = await syncService.etatSynchronisation();
    if (etat.a_synchroniser && !forcer) {
      const err = new Error(
        `${etat.en_attente + etat.photos_en_attente} élément(s) ne sont pas encore envoyés. `
        + 'Synchronisez avant de vous déconnecter.',
      );
      err.code = 'TRAVAIL_NON_SYNCHRONISE';
      err.etat = etat;
      throw err;
    }

    const jeton = sessionRef.current?.jeton_rafraichissement;
    if (jeton) await api.deconnexion(jeton);
    await effacerSession();
  }, [effacerSession]);

  // -------------------------------------------------------------------------
  // Synchronisation
  // -------------------------------------------------------------------------
  const rafraichirEtatSync = useCallback(async () => {
    try {
      setEtatSync(await syncService.etatSynchronisation());
    } catch { /* la base n'est pas encore ouverte */ }
  }, []);

  const lancerSynchronisation = useCallback(async ({ automatique = false } = {}) => {
    if (!sessionRef.current) return { ignoree: true, motif: 'Non connecté' };
    if (syncService.estEnCours()) return { ignoree: true, motif: 'Déjà en cours' };

    setEtatSync((e) => ({ ...e, en_cours: true }));
    try {
      const bilan = await syncService.synchroniser({ surProgression: setProgression });
      setDonneesChargees(true);
      return bilan;
    } catch (err) {
      if (!automatique) throw err;
      // Synchronisation automatique : on n'interrompt pas l'agent avec une
      // alerte. L'indicateur de la barre d'état suffit.
      await journaliser('avertissement', 'Synchronisation automatique échouée',
        { message: err.message });
      return { echec: true, message: err.message };
    } finally {
      setProgression(null);
      await rafraichirEtatSync();
    }
  }, [rafraichirEtatSync]);

  // Rafraîchissement périodique de l'indicateur — pas de la synchronisation
  useEffect(() => {
    if (!session) return undefined;
    const t = setInterval(rafraichirEtatSync, 20000);
    return () => clearInterval(t);
  }, [session, rafraichirEtatSync]);

  const valeur = useMemo(() => ({
    pret,
    session,
    utilisateur: session?.utilisateur ?? null,
    connecte: Boolean(session),
    doitChangerMotDePasse: session?.doit_changer_mot_de_passe === true,
    telephoneConnecte: session?.telephone ?? null,
    enLigne,
    connexionFiable,
    donneesChargees,
    etatSync,
    progression,
    connecter,
    deconnecter,
    enregistrerSession,
    lancerSynchronisation,
    rafraichirEtatSync,
    marquerMotDePasseChange: async () => {
      const s = { ...sessionRef.current, doit_changer_mot_de_passe: false };
      await SecureStore.setItemAsync(CLE_SESSION, JSON.stringify(s));
      sessionRef.current = s;
      setSession(s);
    },
  }), [pret, session, enLigne, connexionFiable, donneesChargees, etatSync, progression,
    connecter, deconnecter, enregistrerSession, lancerSynchronisation, rafraichirEtatSync]);

  return <AppContexte.Provider value={valeur}>{children}</AppContexte.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContexte);
  if (!ctx) throw new Error('useApp doit être utilisé dans <FournisseurApp>');
  return ctx;
}
