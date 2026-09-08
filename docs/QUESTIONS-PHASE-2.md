# Informations nécessaires pour la phase 2 (base de données)

Le cahier des charges donne les volumes (3 zones, 15 quartiers, 21 catégories,
5 443 commerces) mais pas leur contenu. Je ne peux pas inventer des noms de
quartiers ni des barèmes de taxes : ils figureront sur les quittances remises aux
commerçants et doivent correspondre aux délibérations du conseil municipal.

**Vous pouvez me répondre en vrac, dans le désordre, ou me transmettre un fichier
Excel / une photo d'un document de la mairie — je m'occupe de la mise en forme.**

Ce qui suit peut être fourni **pendant** que la phase 1 s'installe : rien ici ne
bloque le montage du serveur.

---

## 1. Découpage territorial — *bloquant pour la phase 2*

### 1.1 Les 3 zones
Nom officiel de chaque zone, et le quartier qui lui sert de chef-lieu si applicable.

### 1.2 Les 15 quartiers
Pour chacun : **nom officiel** + **zone de rattachement**.

Exemple du format attendu :

| Quartier | Zone |
|---|---|
| Fass Delorme | Zone 1 |
| Colobane | Zone 2 |
| … | … |

### 1.3 Limites géographiques *(souhaitable, non bloquant)*
La détection automatique du quartier à partir du GPS de l'agent a besoin des
**polygones** de chaque quartier. Trois possibilités, par ordre de préférence :

1. Un fichier **GeoJSON**, **Shapefile** ou **KML** fourni par la mairie ou l'ANAT
2. Un export depuis **OpenStreetMap** que je vous indique comment produire
3. **À défaut** : je livre un système où l'agent choisit le quartier dans une liste
   déroulante, avec les coordonnées GPS enregistrées quand même. Les polygones
   pourront être ajoutés plus tard sans refaire la base.

---

## 2. Les 21 catégories de commerces — *bloquant*

La liste officielle utilisée par la mairie (boutique d'alimentation, tailleur,
coiffure, quincaillerie, restaurant, télécentre, mécanicien…).

Pour chaque catégorie, précisez si possible **quelles taxes s'y appliquent
d'office** — par exemple un restaurant avec terrasse est presque toujours redevable
de la TODP, une boutique fermée ne l'est jamais.

---

## 3. Les barèmes de taxes — *bloquant, et le point le plus important*

C'est ce qui déterminera les montants réellement facturés. Il me faut, **pour
chacune des 5 taxes** :

### Ce que la base porte aujourd'hui

Toutes ces valeurs sont **inventées** et marquées `À_REMPLACER` en base.

**Tant que ce tableau n'est pas rempli, le système REFUSE d'émettre le moindre avis.**
La base le vérifie elle-même, à chaque émission : un avis émis est une créance notifiée
à une personne, et elle ne peut pas se fonder sur un montant que le conseil municipal
n'a pas délibéré. Le message est explicite et nomme les taxes en cause.

C'est donc bien ce tableau qui débloque la facturation, et rien d'autre.

| Taxe | Mode de calcul attendu | Tranches à fournir | Fourchette actuelle (inventée) |
|---|---|---|---|
| Patente | par catégorie d'activité | 25 | 3 000 → 25 000 XOF |
| TEOM | par catégorie d'activité | 25 | 2 000 → 5 000 XOF |
| Droit de place | par jour, par type d'emplacement | 7 | tarif unitaire non renseigné |
| TODP | au m², par mois | 3 | tarif unitaire non renseigné |
| Enseignes | au m², par mois | — (tarif unique) | non renseigné |

Les 25 tranches de patente et de TEOM correspondent aux catégories d'activité du §2 :
**une ligne par catégorie**. Si une catégorie disparaît ou s'ajoute au §2, la grille
suit.

### La délibération elle-même

Le système ne stocke pas seulement des montants : chaque taxe porte, en base, la
**référence de la délibération** et sa **date** (`delib_reference`, `delib_date`).
Les deux sont vides aujourd'hui pour les cinq taxes.

Il faut donc, avec la grille :

- le **numéro et la date** de la délibération du conseil municipal qui fixe ces
  montants ;
- sa **date d'entrée en vigueur**, qui peut différer de la date de délibération ;
- et, si les montants ont déjà changé par le passé, les versions antérieures — la
  base sait garder l'historique et retrouver le barème applicable à une date donnée.

Sans cette référence, un commerçant qui conteste un montant n'obtiendrait pour toute
réponse que « c'est ce que dit le logiciel ».

### 3.0 D'ABORD : la patente relève-t-elle de la commune ?

*Cette question précède toutes les suivantes. Y répondre « non » rend le §3.1 sans
objet, et retire une taxe sur cinq du pilote.*

La spécification se contredit sur ce point, et la contradiction est dans le même
document :

- **FR-018** : « Le pilote en compte cinq : la **patente** professionnelle, la TEOM,
  la TODP, le droit de place, la taxe sur les enseignes. »
- **Hors périmètre de la version pilote** : « Les autres recettes municipales
  (**patente**, taxe foncière, droits de place sur les marchés couverts, loyers du
  domaine communal). »
- Et une clarification antérieure : « La contribution économique locale fait-elle
  partie du périmètre ? → Non, elle relève de la Direction générale des impôts et
  des domaines. »

Or la **CEL a remplacé la patente** dans la loi de finances sénégalaise de 2018. Si
les deux désignent le même prélèvement, alors la patente est exclue deux fois — et
FR-018 est un reste d'une version antérieure de la spécification.

Ce n'est pas une question de rédaction. **Le système facture aujourd'hui la patente
sur 61 avis de démonstration sur 61, pour 3 372 500 XOF**, et le barème de patente
compte 25 tranches à remplir. Si la commune n'est pas fondée à la percevoir, ces
avis seraient sans base légale.

**Question :** la commune perçoit-elle une patente en son nom propre, distincte de la
CEL recouvrée par la DGID ? Si oui, sous quelle base légale ? Si non, nous
désactivons `patente` pour la commune et le pilote passe à quatre taxes.

### 3.1 Patente professionnelle

*(À traiter seulement si la réponse au §3.0 est « oui ».)*

- Montant fixe, ou variable selon la catégorie / la surface / le chiffre d'affaires ?
- Grille complète des montants en **XOF**
- Périodicité : annuelle ? mensuelle ? trimestrielle ?
- Existe-t-il des exonérations (nouveaux commerces, associations, handicap…) ?

### 3.2 TODP — occupation du domaine public
- **Tarif au m² par mois** (c'est la donnée centrale)
- Le tarif varie-t-il selon la zone ou l'artère (axe passant vs ruelle) ?
- Y a-t-il une **surface minimale facturée** (ex. tout débordement facturé au moins 2 m²) ?
- Y a-t-il un **plafond** ?
- Comment arrondit-on une surface mesurée à 3,4 m² : au m² supérieur, au dixième ?

### 3.3 TEOM — enlèvement des ordures
- Montant fixe par commerce, ou selon la catégorie / le volume produit ?
- Périodicité

### 3.4 Droit de place (marchés)
- Tarif journalier ? mensuel ?
- Varie-t-il selon le marché et selon le type d'emplacement (table, étal, cantine) ?
- Quels marchés sont concernés dans la commune ?

### 3.5 Taxe sur les enseignes
- Tarif au m² d'enseigne, ou forfait ?
- Distinction enseigne lumineuse / non lumineuse ?

### 3.6 Règles transverses
- **Pénalités de retard** : pourcentage, à partir de combien de jours ?
- **Date d'exigibilité** mensuelle : le 5 ? le 10 ? le dernier jour du mois ?
- Existe-t-il des **remises** (paiement anticipé, paiement annuel groupé) ?
- Un commerce peut-il être **exonéré totalement** ? Qui décide, et faut-il tracer
  la décision dans le journal d'audit ?

---

## 4. Organisation des agents — *bloquant pour la phase 3*

- Combien d'**agents collecteurs** au total (le brief parle de 3 pour le pilote) ?
- Combien de **superviseurs** ?
- Un agent est-il affecté à **une zone fixe**, ou peut-il travailler partout dans
  la commune ?
- Un superviseur voit-il **toutes** les zones ou seulement les siennes ?
- Faut-il un **quota** ou un **objectif** par agent (nombre de visites/jour,
  montant collecté) ? Le dashboard peut l'afficher.

---

## 5. Registre existant — *à clarifier avant la phase 2*

- La mairie possède-t-elle déjà un **fichier des 5 443 commerces** (Excel, papier,
  autre logiciel) ?
  - **Si oui** : envoyez-moi le fichier ou juste ses en-têtes de colonnes. Je génère
    un script d'import, ce qui évite aux agents de tout ressaisir sur le terrain.
  - **Si non** : le recensement se fera intégralement par les agents via l'app. Il
    faut alors prévoir cette charge dans le planning des tests terrain (phase 7).
- Existe-t-il un **numéro d'identification** officiel par commerce (NINEA, numéro de
  patente, numéro de registre communal) ? Il servira de clé lors des rapprochements.

---

## 6. Décisions techniques que je propose de prendre par défaut

Sauf objection de votre part, je pars sur ces choix. Dites-moi simplement si l'un
d'eux ne convient pas.

| Sujet | Décision par défaut | Raison |
|---|---|---|
| Devise et arrondi | XOF, entiers, **aucun centime** | Le franc CFA n'a pas de subdivision en usage |
| Période fiscale | **Mensuelle**, du 1er au dernier jour du mois | Aligné sur le paiement Wave mensuel groupé |
| Identifiant de commerce | UUID interne + **code lisible** `GTFC-Z1-00042` | L'UUID pour la base, le code pour le sticker QR et l'oral |
| Contenu du QR code | URL signée `https://gtfc.<domaine>/c/<code>` | Fonctionne aussi si on le scanne avec l'appareil photo natif |
| Historique des barèmes | Les tarifs sont **versionnés par date d'effet** | Un changement de barème ne doit pas réécrire les quittances passées |
| Suppression de données | **Jamais de suppression physique**, seulement `archived_at` | Exigence du journal d'audit anti-fraude |
| Langue de l'interface | **Français** | Langue administrative ; le wolof pourra être ajouté ensuite |
| Fuseau horaire | `Africa/Dakar` (UTC+0) stocké en UTC | Standard, évite les ambiguïtés à minuit |

---

## Ordre de priorité

Si vous ne pouvez répondre qu'à une partie, traitez dans cet ordre :

1. **Sections 1.1, 1.2 et 3** (zones, quartiers, barèmes) — sans elles, la phase 2 est bloquée
2. **Section 2** (catégories) — je peux démarrer le schéma sans, mais pas le seed data
3. **Sections 4, 5 et 1.3** — nécessaires pour les phases 3 et 4, pas pour la 2

Je peux aussi générer le schéma avec des **données factices clairement marquées**
`À_REMPLACER`, pour que vous puissiez tester l'enchaînement complet pendant que la
mairie rassemble les documents officiels. Dites-moi si vous préférez cette approche.
