# Répéter le déploiement sur un VPS

Ce document sert à **s'entraîner** avant l'installation définitive. Vous
déployez la plateforme entière sur une machine louée à quelques milliers de
FCFA par mois, vous découvrez ce qui coince, et vous refaites le geste sur le
Mini PC de la mairie en connaissance de cause.

L'installation cible reste celle décrite dans
[PHASE-1-serveur.md](PHASE-1-serveur.md) : un Mini PC à la mairie, pour que
les données fiscales restent physiquement chez elle. Ce document ne la
remplace pas — il permet de ne pas la découvrir le jour J.

> **Ne mettez aucune donnée réelle sur ce VPS.** Ni barèmes délibérés, ni
> registre de commerçants. C'est un banc d'essai : il sera détruit.

---

## Ce que le VPS change par rapport au Mini PC

| | Mini PC à la mairie | VPS |
|---|---|---|
| Adresse publique | IP statique Sonatel à demander (1 à 3 semaines) | fournie immédiatement |
| Ports 80 et 443 | à rediriger sur la box | directement exposés |
| Coupure de courant | onduleur indispensable | sans objet |
| Données | restent à la mairie | chez l'hébergeur — d'où l'essai seulement |

Le reste est identique : mêmes scripts, mêmes commandes, même recette.

---

## 1. Commander la machine

**4 vCPU, 8 Go de RAM, 80 Go de SSD, Ubuntu Server 24.04 LTS.**

C'est en dessous de la cible finale (16 Go), et c'est suffisant pour une
répétition avec le jeu de démonstration. Ne payez pas 16 Go pour un banc
d'essai.

Choisissez un centre de données **en Europe** plutôt qu'en Amérique du Nord :
la latence depuis Dakar est deux à trois fois moindre, ce qui se sent sur le
tableau de bord.

À la commande, demandez une **clé SSH** plutôt qu'un mot de passe.

---

## 2. Un nom de domaine

Il en faut un, même pour l'essai : Let's Encrypt ne délivre pas de certificat
pour une adresse IP, et sans HTTPS ni le paiement Wave ni le portail ne
fonctionnent.

Prenez un `.com` chez n'importe quel registrar — quelques euros l'année. Le
`.sn` au NIC Sénégal est pour l'installation définitive.

Créez trois enregistrements **A** pointant vers l'IP du VPS :

| Nom | Type | Valeur |
|---|---|---|
| `api.votredomaine.com` | A | l'IP du VPS |
| `gtfc.votredomaine.com` | A | l'IP du VPS |
| `portail.votredomaine.com` | A | l'IP du VPS |

La propagation prend de quelques minutes à deux heures. Vérifiez avant de
continuer :

```bash
dig +short api.votredomaine.com
```

Tant que cette commande ne renvoie pas l'IP du VPS, l'étape 4 du déploiement
échouera — et ce sera normal.

---

## 3. Préparer la machine

Connectez-vous et installez les prérequis :

```bash
ssh gtfc@IP_DU_VPS

sudo apt update && sudo apt install -y git
git clone VOTRE_DEPOT gtfc && cd gtfc

sudo bash scripts/install-ubuntu.sh
```

Le script installe Docker, Node.js, PM2, le pare-feu `ufw` et les mises à jour
de sécurité automatiques. Il n'ouvre que trois ports : 22, 80 et 443.

**Déconnectez-vous et reconnectez-vous ensuite.** Sans cela votre compte
n'appartient pas encore au groupe `docker`, et toutes les étapes suivantes
échoueront sur des refus de permission.

```bash
exit
ssh gtfc@IP_DU_VPS
cd gtfc
docker ps          # doit répondre sans sudo
```

---

## 4. Déployer

```bash
cp .env.template .env
nano .env
```

À renseigner au minimum :

```
APP_DOMAIN=votredomaine.com
DB_PASSWORD=…              # openssl rand -base64 24
DB_SUPERUSER_PASSWORD=…
JWT_SECRET=…               # openssl rand -base64 48
MINIO_ACCESS_KEY=…
MINIO_SECRET_KEY=…
CORS_ORIGINS=https://gtfc.votredomaine.com
```

Laissez Wave et SMS en simulation : `WAVE_ACTIF=false`, `SMS_ACTIF=false`.
Toute la chaîne fonctionne, les liens de paiement sont fabriqués localement
et les codes SMS s'affichent dans le journal du serveur.

Puis :

```bash
bash scripts/deployer.sh --simulation   # ce qui va se passer, sans rien faire
bash scripts/deployer.sh                # pour de vrai
```

Douze étapes. Le script est **reprenable** : s'il s'arrête à l'étape 4 faute
de DNS, corrigez et relancez — il repart d'où il en était.

```bash
bash scripts/deployer.sh --etat         # où en suis-je ?
bash scripts/deployer.sh --depuis 5     # forcer la reprise à une étape
```

---

## 5. Vérifier

```bash
bash scripts/recette.sh
```

Elle demande le mot de passe du compte administrateur créé à l'étape 8 et
enchaîne une trentaine de contrôles : connexion, isolation entre communes,
détection GPS, calcul de taxe, création de commerce, synchronisation
hors-ligne, encaissement, quittance, exports, page publique.

Deux alertes sont **attendues** et normales :

- « données encore provisoires » — les barèmes du jeu initial sont inventés,
  c'est précisément ce que l'import de la délibération remplacera ;
- « encaissements espèces non versés » — si vous avez chargé le jeu de
  démonstration.

Tout le reste doit être vert. Si quelque chose est rouge, envoyez-moi la
sortie : c'est exactement pour ça qu'on répète.

---

## 6. Ce qu'il reste à éprouver, et qui ne se voit qu'ici

Ces trois points ne peuvent pas être vérifiés en local. C'est la raison d'être
de cette répétition.

**Le certificat HTTPS.** Let's Encrypt appelle votre serveur depuis
l'extérieur. Un port 443 fermé ou un DNS mal propagé ne se voit qu'à ce
moment-là.

**Le webhook Wave.** Même en simulation, vérifiez que l'URL est joignable
depuis internet — c'est elle que vous déclarerez à Wave :

```bash
curl https://api.votredomaine.com/webhooks/wave
```

Elle doit répondre en JSON. Si elle ne répond pas, aucun paiement ne sera
jamais rapproché en production, et l'argent partira du téléphone du
commerçant sans que la commune en ait trace.

**L'application mobile.** Compilez l'APK avec l'URL du VPS et installez-la sur
un téléphone. C'est le seul moyen de vérifier que la synchronisation
fonctionne sur une vraie connexion mobile, avec ses coupures.

---

## 7. Après

Quand le Mini PC arrive, vous refaites exactement les mêmes gestes — seules
changent l'adresse et la redirection de ports sur la box. Comptez une heure,
sans surprise.

**Détruisez ensuite le VPS.** Il aura contenu des mots de passe et un jeu de
données ; il n'a aucune raison de survivre à l'essai.
