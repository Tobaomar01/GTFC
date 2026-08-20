# Ce que la mairie doit fournir — référentiel des redevables

Ce document reprend les points à trancher du § 10 du *Référentiel des redevables
communaux* (juin 2026), classés **par ordre de blocage** : ce qui empêche le
recensement de commencer d'abord, ce qui empêche de facturer ensuite.

---

## 1. Bloquant pour DÉMARRER le recensement

### Le référentiel des rues — phase 0

C'est le seul point qui doit être réglé **avant** que les agents descendent sur
le terrain. Si la rue est saisie en texte libre, la reprise est manuelle sur
plusieurs milliers de lignes et le suivi de couverture est impossible.

Durée estimée : 2 à 3 jours, en parallèle de la configuration serveur.

Sources à croiser : la carte du PDC 2021-2025 (rues GT 53 à 71, rues 37 à 48
côté Colobane, axes structurants), les données OpenStreetMap de la commune, le
plan de voirie communal si la mairie en dispose.

Le travail de réconciliation — trancher les libellés quand OpenStreetMap et le
PDC divergent — revient à la mairie. Sans validation de sa part, les
statistiques par rue seront contestables.

### Les dénominations des marchés

Le PDC recense 5 marchés permanents (2 à Gueule Tapée, 1 à Fass, 2 à Colobane)
et 1 marché hebdomadaire, **sans les nommer**. Seul le marché de Colobane
(MAR-04) est identifié.

Un agent ne peut pas rattacher un commerçant à « marché — dénomination à
obtenir ».

---

## 2. Bloquant pour FACTURER

Le recensement peut se dérouler entièrement sans ces réponses. Aucun avis ne
doit partir avant de les avoir.

### La délibération du conseil municipal

Elle fixe l'ensemble des taxes et redevances communales et les taux en vigueur.
Son numéro et sa date figureront sur chaque quittance : c'est ce qui permet de
répondre à un commerçant qui conteste un montant.

### Le barème TODP

En FCFA par m² et par an pour les étalages sur trottoir. C'est le tarif le plus
structurant du dispositif.

### Les droits de place

Deux questions distinctes :

- sont-ils **différenciés par type d'emplacement** — cantine, étal, hangar,
  magasin ?
- **varient-ils d'un marché à l'autre**, ou sont-ils uniformes sur la commune ?

La structure actuelle sait faire les deux, mais pas deviner laquelle s'applique.

### La grille de la taxe publicitaire

Par type de dispositif (AFF-01 à AFF-07). Les 20 000 FCFA/m²/an cités dans le
document sont ceux de **Dakar-Ville**, relevés sur le portail Sénégal Services
et donnés à titre indicatif. GTFC dispose de sa propre délibération.

### Le tarif d'occupation pour les chantiers

En FCFA par m² et par jour ou par mois. **Non bloquant** : les chantiers sont
recensés sans être facturés pendant le pilote. Les champs de calcul sont
collectés dès maintenant pour éviter un repassage terrain le jour où la commune
active le tarif.

---

## 3. Décisions à prendre, sans urgence

### Les plaques professionnelles réglementées

Notaires, avocats, médecins. Le code AFF-06 est **réservé et laissé vacant** :
les agents ne les recensent pas. Leurs dimensions et leur contenu relèvent
d'une déontologie professionnelle, et leur assujettissement doit être tranché
avec la municipalité.

### La nomenclature d'activités

Existe-t-il une nomenclature de référence, notamment DGID, à laquelle aligner
les codes ACT ? À défaut, la codification proposée fait foi.

### La répartition de « ventes diverses »

Le poste représente 813 commerces au PDC, dont 589 à Colobane, et n'est pas
exploitable en l'état. Les codes ACT-20 à ACT-24 le décomposent, mais leur
effectif réel sortira du recensement terrain — aucun chiffre n'a été inventé
pour les remplir.

### Les cinq lignes de recettes les plus importantes

Question posée dans le document. La réponse oriente l'ordre de déploiement :
autant commencer par ce qui rapporte.

---

## 4. Ce qui a été retiré du périmètre, et pourquoi

### La patente

Elle a été remplacée en 2018 par la **contribution économique locale** :
CEL-VL, assise sur la valeur locative des locaux professionnels et
intégralement versée à la commune d'implantation, et CEL-VA, assise sur la
valeur ajoutée et redistribuée à l'ensemble des communes.

Dans les deux cas l'impôt est établi et recouvré par la **DGID**. Il ne
transite pas par un agent municipal.

La plateforme la facturait à tous les commerces. Elle ne le fait plus
(migration `0023`). Une société installée dans un immeuble déclare sa CEL à la
DGID, mais reste redevable auprès de la commune de la taxe sur ses dispositifs
d'affichage, de la TEOM, et de la TODP si elle empiète sur le domaine public.

**À arbitrer par la mairie** : les avis déjà émis comportant une ligne de
patente. Ils n'ont pas été modifiés — dégrever ou annuler une créance notifiée
est une décision municipale, pas l'effet d'un script.

```sql
SELECT * FROM app.v_avis_patente_a_regulariser;
```

---

## 5. Un choix technique qui vous revient

### L'opérateur SMS

Le portail du redevable s'authentifie par **code à usage unique envoyé par
SMS**, et la vérification du numéro sur le terrain repose sur le même
mécanisme. Sans opérateur, ni l'un ni l'autre ne fonctionne.

L'opérateur ne reçoit que **le numéro et le code à six chiffres** — jamais un
montant, jamais une donnée fiscale. C'est la même règle que pour Wave, qui ne
reçoit qu'un numéro et un montant.

Choix à faire : Orange SMS Pro, Free Sénégal, ou une passerelle tierce. Dites-moi
lequel et je branche l'envoi ; en attendant, le code s'affiche dans le journal
du serveur, exactement comme le simulateur Wave.
