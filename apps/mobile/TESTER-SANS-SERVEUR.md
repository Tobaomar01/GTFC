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
# L'API, ouverte au réseau local et non à la seule boucle locale.
# La variable est API_HOST : le serveur ne lit pas HOST.
cd apps/api && API_HOST=0.0.0.0 DB_NAME=gtfc_recette npm start

# L'application, dans un autre terminal
cd apps/mobile && npx expo start
```

**L'adresse de l'API est lue dans `apps/mobile/.env`**, pas devinée. Sans ce
fichier, l'application retombe sur `extra.apiUrl` d'`app.json` —
`https://api.exemple.sn`, une adresse de remplissage — et l'écran de connexion
affiche « Cet APK n'est pas prêt pour le terrain » sans rien laisser saisir.
Metro n'inline les `EXPO_PUBLIC_*` qu'au démarrage : après modification du
fichier, relancer `expo start`.

```bash
cd apps/mobile && cp .env.example .env
# puis y porter l'adresse du poste relevée plus bas, port 4000
```

La base doit tourner. Si elle est en conteneur, son nom n'est pas devinable —
le relever plutôt que le recopier :

```bash
docker ps -a --format '{{.Names}}	{{.Status}}	{{.Ports}}'   # ex. gtfc-pg17
docker start gtfc-pg17
```

**Sur le téléphone** : installer *Expo Go* depuis le Play Store, puis scanner
le QR affiché par la commande précédente. Le téléphone et le poste doivent
être sur le même Wi-Fi.

**Sous Windows, deux obstacles de plus.** Le pare-feu classe la plupart des
réseaux Wi-Fi en « Public » et bloque alors tout entrant : ni l'API sur 4000,
ni Metro sur 8081 ne seront joignables depuis le téléphone. Dans un PowerShell
administrateur, une fois :

```powershell
New-NetFirewallRule -DisplayName "GTFC API 4000"   -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "GTFC Metro 8081" -Direction Inbound -LocalPort 8081 -Protocol TCP -Action Allow
```

Si vous préférez ne rien ouvrir, `npx expo start --tunnel` fait passer Metro
par les serveurs d'Expo et se dispense de la règle 8081 — mais l'API, elle,
reste à joindre directement.

Pour relever l'adresse du poste :

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' }).IPAddress
```

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

Le profil `development` pointe sur l'adresse du poste, dans `eas.json`. Elle y
figure désormais comme un marqueur `A_REMPLIR_ADRESSE_DU_POSTE`, à remplacer
avant chaque compilation — elle change dès que le poste change de réseau.

Le marqueur est délibéré. Une ancienne adresse, plausible, produit un APK qui
part sur le terrain et échoue en silence ; un marqueur, lui, déclenche
« Cet APK n'est pas prêt pour le terrain » dès l'écran de connexion. Mieux vaut
un refus visible qu'une adresse crédible et morte.

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' }).IPAddress   # Windows
```

```bash
ipconfig getifaddr en0     # macOS
hostname -I                # Linux
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
