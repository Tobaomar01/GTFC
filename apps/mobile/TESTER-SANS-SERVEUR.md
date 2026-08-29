# Éprouver l'application sur un vrai téléphone, sans serveur

Le recensement ne dépend ni des tarifs, ni de Wave, ni de l'USSD. Il peut donc
être testé sur le terrain **avant** que le serveur n'existe — contre l'API qui
tourne sur le poste de développement, par le Wi-Fi.

C'est le test le plus instructif qui reste à faire, et le seul qui apprenne
quelque chose qu'aucun test écrit ne peut donner.

---

## Voie 1 — Expo Go, aujourd'hui, sans rien installer

Aucun compte, aucun APK, cinq minutes.

**Sur le poste**, deux services :

```bash
# L'API, ouverte au réseau local et non à la seule boucle locale
cd apps/api && HOST=0.0.0.0 DB_NAME=gtfc_recette npm start

# L'application, dans un autre terminal
cd apps/mobile && npx expo start
```

**Sur le téléphone** : installer *Expo Go* depuis le Play Store, puis scanner
le QR affiché par la commande précédente. Le téléphone et le poste doivent
être sur le même Wi-Fi.

Ce que cette voie permet : recenser, relever une position GPS, ajuster le
point sur la carte, photographier, synchroniser, lire un QR. C'est-à-dire tout
le travail de l'agent.

Ce qu'elle ne permet pas : sortir de la portée du Wi-Fi. Pour marcher dans une
rue, il faut la voie 2.

## Voie 2 — un APK autonome

Il faut un compte Expo, gratuit. Une seule fois :

```bash
cd apps/mobile
npx eas-cli login       # à taper vous-même : le mot de passe ne transite pas ailleurs
npx eas-cli init        # crée le projet et inscrit son identifiant dans app.json
```

Puis, à chaque fois :

```bash
npx eas-cli build --platform android --profile development
```

La compilation se fait chez Expo et rend un lien de téléchargement. L'APK
s'installe directement sur le téléphone, sans passer par le Play Store.

Le profil `development` pointe sur l'adresse du poste, dans `eas.json`. Elle
est renseignée à la valeur détectée au moment de l'écriture de ce fichier —
**vérifiez-la** : elle change quand le poste change de réseau.

```bash
ipconfig getifaddr en0     # sur macOS
```

Le profil `preview` produit l'APK des vrais tests terrain. Il pointe sur le
domaine du serveur, encore à renseigner.

---

## Le piège qu'on a fermé

Un APK emporte l'adresse de son serveur au moment de la compilation. Construit
avec le mauvais profil, il part sur le terrain, l'agent recense sa journée, et
chaque synchronisation échoue en parlant de réseau — alors que le réseau va
très bien : c'est l'adresse qui ne mène nulle part. Il rentrerait en pensant
que le serveur est tombé.

L'écran de connexion le dit maintenant avant la première saisie. Si vous voyez
« Cet APK n'est pas prêt pour le terrain », ne partez pas avec.

---

## Ce qu'il faut regarder pendant l'essai

Moins les fonctions que les frottements. Une fiche prend combien de temps ?
Le GPS se cale en combien de secondes sous les tôles d'un marché ? Le point
tombe-t-il sur la bonne devanture, ou faut-il le déplacer à chaque fois ? Le
gérant est-il là ? Accepte-t-il de donner son numéro ?

Cette dernière question décide de tout : sans numéro, aucun avis ne part.
