<!--
SYNC IMPACT REPORT
==================
Changement de version : 1.0.0 → 2.0.0

Motif du calibrage : MAJEUR. Deux constitutions distinctes coexistaient, toutes
deux en version 1.0.0, toutes deux se déclarant primer sur toute autre
pratique :

  - « Constitution de la plateforme GTFC », 7 principes, ratifiée le
    2026-08-20, amendée le 2026-08-29, versionnée sur la branche master ;
  - « Revenu Municipal Constitution », 6 articles, ratifiée le 2026-08-28,
    portée par le dépôt de spécification 001-collecte-taxes-municipales.

Elles ne décrivaient pas deux projets rivaux mais le même projet, chacune
couvrant ce que l'autre passait sous silence : la première l'architecture et
l'exploitation, la seconde la gouvernance et l'argent. Le code implémente les
deux. Le présent texte les remplace toutes les deux.

Principes repris de « Plateforme GTFC » (ossature) :
  - Isolation multi-communes garantie par la base    -> II
  - Traçabilité inaltérable                          -> III (fusionné)
  - Le terrain d'abord                               -> V   (amendé)
  - Souveraineté et minimisation                     -> VI  (élargi)
  - La vérité métier vit dans la base                -> VIII
  - Vérification par recette exécutable              -> IX  (élargi)
  - Le français est la langue du projet              -> X

Principes repris de « Revenu Municipal », sans équivalent dans l'ossature :
  - Intégrité de l'argent                            -> I
  - Séparation des pouvoirs et moindre privilège     -> IV
  - Réversibilité                                    -> VI  (fusionné)
  - Accessible au téléphone le plus simple           -> VII

Redéfinitions incompatibles (d'où le MAJEUR) :
  1. PostgreSQL 16 → 17. La 16 refuse de lire les sauvegardes produites par la
     17, et son pg_dump rend un fichier de zéro octet sans le signaler.
  2. « JWT à quatre rôles » → six rôles nommés. Le chef de projet et le maire
     existent depuis le commit c8dc053 ; le texte était en retard sur le code.
  3. Journalisation de la position : « où (position GPS lorsqu'elle existe) »
     devient « la position de l'intervention, jamais celle de l'agent ». Le
     suivi de position des agents a été écarté par le commanditaire ; l'ancienne
     formulation l'autorisait implicitement.
  4. Le principe du hors-ligne reçoit son exception explicite : l'encaissement
     exige la confirmation de l'opérateur et NE DOIT PAS être validé hors ligne.
     Les deux textes se contredisaient sur ce point.

Sections ajoutées : Contraintes d'exploitation (frugalité, protection des
données par conception), reprises de « Revenu Municipal ».

Sections retirées : aucune. Jetons résiduels : aucun. TODO différés : aucun.

Artefacts à mettre en conformité :
  - docker-compose.yml : image postgis/postgis:16-3.4 → 17 (principe VIII et
    Contraintes techniques). Non conforme au présent texte à sa ratification.
  - README.md, docs/PHASE-1-serveur.md, docs/PHASE-3-api.md : mentions de
    PostgreSQL 16.
  - Le dépôt de spécification 001-collecte-taxes-municipales : sa copie de la
    constitution est remplacée par le présent texte.

Date de ratification : 2026-09-01. Les deux ratifications antérieures
(2026-08-20 et 2026-08-28) sont conservées dans l'historique git.
-->

# Constitution de la plateforme GTFC

Plateforme de digitalisation de la collecte des taxes locales — commune de
Gueule Tapée-Fass-Colobane (Dakar, Sénégal). GTFC est la commune pilote ; la
plateforme est conçue dès l'origine pour en héberger plusieurs.

Le dispositif est exploité dans un partenariat public-privé : l'exploitant
technique n'est pas la collectivité. Plusieurs principes ci-dessous n'ont de
sens qu'à la lumière de ce montage, et ne doivent pas être lus comme de la
prudence excessive.

## Principes fondamentaux

### I. Intégrité de l'argent (NON NÉGOCIABLE)

Aucune écriture financière NE DOIT être modifiée ni supprimée. Toute correction
DOIT prendre la forme d'une écriture compensatoire, de sorte que la piste
d'audit reste continue et reconstituable.

- Toute opération de paiement DOIT être idempotente : un rejeu, une double
  notification d'opérateur ou une reprise après coupure NE DOIT jamais produire
  un second débit.
- En cas de désaccord entre le système et l'opérateur de mobile money,
  l'encaissement DOIT être bloqué et présenté comme en attente. Il NE DOIT
  jamais être présumé.
- Les montants DOIVENT être des entiers en francs CFA. Aucun calcul de taxe NE
  DOIT reposer sur un nombre à virgule flottante.

Raison : le système manipule des deniers publics pour le compte d'une commune,
dans un montage où l'exploitant technique n'est pas la collectivité. Une
écriture financière modifiable rend tout contrôle a posteriori sans valeur
probante, et un double débit détruit la confiance des redevables plus vite que
n'importe quelle panne.

### II. Isolation multi-communes garantie par la base (NON NÉGOCIABLE)

L'isolation entre communes DOIT être appliquée par PostgreSQL au moyen du Row
Level Security, jamais par une clause `WHERE` posée dans le code applicatif.

- Toute nouvelle table portant `commune_id` DOIT recevoir sa politique
  `pol_isolation_commune` dans la migration qui la crée, jamais plus tard.
- Tout accès métier DOIT passer par `avecContexte()` ou `requete()`, qui posent
  `gtfc.commune_id` et `gtfc.utilisateur_id` par `SET LOCAL`. Un appel direct à
  `pool.query()` sur une table métier est un défaut, pas un raccourci.
- En l'absence de contexte, le rôle applicatif DOIT ne voir aucune ligne. Un
  défaut de configuration se traduit par « rien », jamais par « tout ».
- L'accueil d'une nouvelle commune NE DOIT exiger ni nouveau serveur, ni nouveau
  code, ni branche conditionnelle : seulement des données et un sous-domaine.

Raison : un oubli dans un point d'entrée de l'API ne doit pas pouvoir exposer
les données fiscales d'une autre mairie. Une garantie tenue par la base survit
aux erreurs du code ; l'inverse n'est pas vrai.

### III. Traçabilité inaltérable et attribution

Toute action sensible — création, modification, clôture, transfert,
encaissement, changement de barème, accès aux données personnelles — DOIT être
journalisée dans le schéma `audit` de façon non modifiable, horodatée, et
attribuable à une personne identifiée : qui, quoi, valeurs avant et après,
quand.

- Le journal DOIT rester en ajout seul et chaîné, de sorte qu'une altération
  soit détectable y compris par qui détient l'accès à la base. Cette propriété
  est tenue à la fois par les droits SQL du rôle applicatif et par des
  déclencheurs `BEFORE UPDATE/DELETE` — deux barrières, parce qu'une seule peut
  être contournée par une connexion superutilisateur faite par erreur.
- Le calcul de l'empreinte NE DOIT dépendre d'aucun réglage de session. Un
  journal qui ne se vérifie que sur la machine qui l'a écrit fait sonner
  l'alarme anti-fraude à chaque restauration, jusqu'à ce que plus personne ne
  la regarde.
- **La position enregistrée est celle de l'intervention, jamais celle de
  l'agent.** Aucun suivi de déplacement NE DOIT être mis en œuvre. Une position
  n'est journalisée que rattachée à un acte métier qui la justifie.
- Aucune fonctionnalité NE DOIT contourner le journal, y compris les tâches
  planifiées, les imports de référentiels et les scripts d'exploitation.
- Le journal DOIT rester lisible : seuls les champs réellement modifiés sont
  enregistrés, et le libellé de l'entité est recopié pour rester compréhensible
  après archivage du compte ou de la fiche.
- Une fonctionnalité livrée sans journalisation de ses actions sensibles est
  réputée incomplète et NE DOIT PAS être considérée comme terminée.

Raison : l'adhésion de la mairie repose sur l'engagement « aucune modification
possible sans laisser de trace ». C'est la réponse au premier risque du métier,
qui est la fraude interne. Sans attribution, aucune irrégularité ne peut être
imputée, et le système offre à la fraude une couverture plutôt qu'un obstacle.

### IV. Séparation des pouvoirs et moindre privilège (NON NÉGOCIABLE)

Aucun rôle NE DOIT cumuler le pouvoir de fixer la dette, de l'encaisser et de la
solder. Les rôles sont `agent`, `superviseur`, `admin_commune`, `super_admin`,
`chef_projet` et `maire` ; leur nombre et leur périmètre relèvent d'un
amendement, pas d'un déploiement.

- L'agent de terrain NE DOIT pouvoir ni modifier un montant dû, ni accorder une
  remise, ni marquer une échéance comme payée.
- Le personnel de l'exploitant technique NE DOIT disposer d'aucun droit sur les
  échéances ni sur le barème. Le `chef_projet` instruit les décisions
  dérogatoires ; il ne les valide pas.
- La remise d'une dette publique est un acte de la commune. Elle DOIT exiger la
  validation du `maire`, et le `maire` NE DOIT rien pouvoir écrire d'autre :
  il consulte, et valide les dérogations.
- Le barème relève d'une délibération du conseil municipal, pas d'un écran.
- Le dépôt d'une contestation NE DOIT PAS suspendre le recouvrement.
- Tout accès DOIT être attribué selon le moindre privilège, et restreint au
  périmètre géographique d'affectation lorsque le rôle en comporte un.
- La restriction attachée à un rôle DOIT être vérifiée à l'intérieur de
  l'authentification, non route par route : un intergiciel monté à part
  s'oublierait sur la prochaine route écrite.

Raison : la collecte municipale de proximité est structurellement exposée au
détournement. La séparation des pouvoirs protège autant la commune que l'agent
lui-même, en le mettant hors d'état d'être sollicité. Et aucune des deux
organisations ne peut, seule, effacer une créance publique.

### V. Le terrain d'abord : hors ligne, idempotent, sans perte

Toute fonction destinée à l'agent de terrain DOIT fonctionner sans réseau et se
synchroniser plus tard.

- Un lot de synchronisation renvoyé après une coupure NE DOIT produire aucun
  effet supplémentaire. L'idempotence s'appuie sur l'identifiant local généré
  par le téléphone, jamais sur une heuristique de ressemblance.
- Une opération invalide NE DOIT PAS faire échouer les autres opérations du
  lot : chacune est traitée dans sa propre sous-transaction et rapporte son sort
  individuellement.
- Un conflit entre la fiche locale et la fiche serveur DOIT être remonté à un
  superviseur pour arbitrage humain. Il NE DOIT JAMAIS être résolu par
  écrasement silencieux.
- **Seule exception, explicite : l'encaissement.** Il exige la confirmation de
  l'opérateur et NE DOIT PAS être validé hors ligne. Un paiement ne se constate
  pas de mémoire.

Raison : l'agent recense en marchant, dans des zones à couverture incertaine, et
dans les marchés denses de Dakar l'absence de réseau est la norme, non
l'incident. Le travail d'une journée ne se perd pas, et une reprise de
synchronisation ne crée ni doublon de commerce ni double taxation. Mais
l'argent, lui, ne souffre pas d'être présumé.

### VI. Souveraineté, minimisation et réversibilité

La plateforme DOIT rester auto-hébergée sur le serveur de la commune, au
Sénégal, sauvegardes et environnements de secours compris.

- Les seuls flux sortants autorisés sont **Wave** — numéro de téléphone et
  montant, jamais de donnée fiscale ni nominative — et **les tuiles
  OpenStreetMap**, qui ne portent aucune donnée de la commune.
- Toute nouvelle dépendance externe en exécution (mesure d'audience, CDN,
  service tiers, service d'intelligence artificielle, télémétrie) DOIT faire
  l'objet d'un amendement explicite avant d'être introduite.
- Le système NE DOIT PAS dépendre d'un service dont la commune ne pourrait pas
  sortir. Un composant qui ne peut pas être hébergé sur l'infrastructure
  communale DOIT être rejeté, quels que soient ses mérites techniques.
- **Les données DOIVENT pouvoir être exportées à tout moment dans un format
  ouvert et documenté, sans outil propriétaire.** La sortie de la commune du
  dispositif est un droit exerçable, pas une clause.
- Les données personnelles collectées DOIVENT se limiter à ce qui est nécessaire
  à l'identification du redevable et au recouvrement.
- Les jetons d'authentification NE DOIVENT JAMAIS atteindre le navigateur :
  l'interface passe par un mandataire côté serveur qui attache le jeton lu dans
  un cookie `httpOnly`.
- Aucun stockage d'objets NE DOIT être public. Les photos ne sont servies que
  par URL pré-signée, générée après vérification du jeton.
- PostgreSQL et MinIO NE DOIVENT écouter que sur `127.0.0.1`.

Raison : ce sont des données fiscales et nominatives de citoyens sénégalais.
Elles n'ont aucune raison de quitter le serveur de la commune, et la commune
doit pouvoir le vérifier elle-même. Dans un partenariat public-privé, la
réversibilité est la seule garantie concrète que la commune reste propriétaire
de son assiette fiscale à la fin du contrat.

### VII. Accessible au téléphone le plus simple

Aucune fonctionnalité destinée au redevable NE DOIT exiger un smartphone, une
application ou la création d'un compte.

- Les canaux SMS et USSD DOIVENT être le canal de référence. Le portail web est
  un confort offert à ceux qui disposent d'un terminal capable de l'ouvrir.
- Une consultation demandée depuis un numéro non vérifié NE DOIT révéler aucune
  information, et sa réponse DOIT être indistinguable de celle servie à un
  numéro inconnu.
- Aucun message sortant NE DOIT exposer de donnée fiscale au-delà de ce que le
  destinataire est en droit de connaître.

Raison : la population visée est composée en grande partie de petits commerçants
équipés de téléphones simples. Concevoir pour le smartphone exclut ceux dont le
recouvrement dépend, et transforme un outil de service public en outil réservé.

### VIII. La vérité métier vit dans la base, pas dans le code

- Barèmes, taux, catégories, quartiers, rues, marchés et autres référentiels
  DOIVENT être des données versionnées en base. Ils NE DOIVENT JAMAIS être des
  constantes en dur dans le code applicatif.
- Toute évolution de schéma DOIT passer par une migration numérotée, exécutée
  dans une transaction unique, appliquée une seule fois, et dont l'empreinte
  SHA-256 est enregistrée. Un fichier déjà appliqué NE DOIT JAMAIS être
  modifié : la correction fait l'objet d'une nouvelle migration.
- Les données métier provisoires DOIVENT rester marquées `À_REMPLACER` et
  restituables d'une seule requête (`app.v_donnees_a_remplacer`). Une donnée
  provisoire non marquée est une dette invisible.
- Aucun avis NE DOIT être émis tant que le barème qui le fonde est provisoire.

Raison : un taux de taxe change par délibération du conseil municipal, pas par
déploiement. Chaque commune a ses propres barèmes ; les figer dans le code
interdirait la seconde commune.

### IX. Vérification par recette exécutable

Toute livraison DOIT être prouvée par une recette exécutable qui exerce le
parcours métier de bout en bout : se connecter, recenser, calculer une taxe,
synchroniser, encaisser, produire une quittance, exporter.

- Une recette CONSTATE, elle n'agit pas : elle DOIT aller jusqu'au bout et
  rapporter tous les écarts, jamais s'arrêter au premier.
- Les données créées par une recette DOIVENT être préfixées et nettoyées en fin
  d'exécution ; une relance après interruption DOIT nettoyer les restes.
- Un vérificateur DOIT rendre un verdict instruisible : le motif d'un échec est
  affiché, et le code de sortie est celui de ce qui a été vérifié. Un contrôle
  qui ne trouve rien parce qu'il cherche mal est pire que pas de contrôle.
- La surveillance des services (`healthcheck`) et la vérification du métier
  (`recette`) DOIVENT rester deux choses distinctes : des services debout ne
  prouvent pas qu'une taxe se calcule.
- L'installation DOIT être éprouvée depuis une base VIDE, et non seulement sur
  la base de travail, qui porte des états qu'une base neuve n'aura jamais.
- **Une sauvegarde jamais restaurée n'est pas une sauvegarde.** La restauration
  complète DOIT être rejouée automatiquement et périodiquement.
- **Un exercice de restauration complète et un exercice de réversibilité DOIVENT
  avoir été menés avec succès avant toute mise en production.** Une réversibilité
  jamais éprouvée est un engagement contractuel invérifiable.

Raison : le risque de ce projet n'est pas la fonction qui plante, c'est la
chaîne fiscale qui ne boucle pas — un avis émis sans paiement possible, une
quittance sans trace, un export qui ne réconcilie pas. Et les défauts de ce
projet se sont tous logés aux jointures : ils ne se voient pas à la lecture,
seulement à l'exécution.

### X. Lisible par la mairie — le français est la langue du projet

- Le code, les noms de tables, de colonnes, de fichiers et de variables, les
  commentaires, les messages d'erreur, les journaux et la documentation DOIVENT
  être en français.
- Les commentaires DOIVENT expliquer *pourquoi*, pas *quoi*. Chaque module ou
  migration DOIT s'ouvrir sur l'exigence métier qu'il tient.
- Un commentaire NE DOIT PAS décrire une protection qui n'existe pas. Un texte
  qui rassure à tort est plus nuisible qu'un silence.
- La documentation destinée aux utilisateurs (guide de l'agent, guide de la
  mairie) DOIT rester utilisable sur le terrain, imprimable, sans jargon.

Raison : la commune doit pouvoir reprendre, auditer et faire évoluer la
plateforme sans dépendre de son prestataire d'origine. Un code qu'elle ne lit
pas est un code qu'elle ne possède pas.

## Contraintes techniques et sécurité

La pile technique est arrêtée et NE DOIT PAS être élargie sans amendement :

- **Données** : PostgreSQL 17 + PostGIS, schémas `app` / `ref` / `audit`. La
  version 17 est un minimum, non une préférence : la 16 refuse de lire les
  sauvegardes produites par la 17, et son `pg_dump` rend un fichier de zéro
  octet sans le signaler. Le client `pg_dump` DOIT être de la même version
  majeure que le serveur.
- **API** : Node.js 20+ et Express, validation des entrées par zod,
  journalisation structurée par pino, authentification JWT.
- **Interface** : Next.js et Tailwind, graphiques faits main plutôt que
  bibliothèque tierce, carte Leaflet sur tuiles OpenStreetMap.
- **Terrain** : React Native et Expo, base SQLite locale et file de
  synchronisation.
- **Exploitation** : Docker pour l'infrastructure, PM2 pour les processus
  applicatifs, Nginx et Let's Encrypt en frontal, MinIO pour les photos.

Exigences de sécurité non négociables :

- Le rôle applicatif NE DOIT posséder ni DDL, ni `DROP`, ni droit de
  modification du schéma. Sur le schéma `audit`, il n'a que `SELECT` et
  `INSERT`.
- Le versionnage MinIO DOIT rester actif : une photo de devanture ne peut pas
  être écrasée en silence.
- L'authentification DOIT rester soumise à une limitation de débit, l'API à une
  limitation globale.
- Le pare-feu NE DOIT exposer que 22, 80 et 443 ; fail2ban et les mises à jour
  de sécurité automatiques DOIVENT rester actifs.
- Aucun secret NE DOIT être versionné. Seul `.env.template` figure au dépôt,
  avec ses valeurs à remplir.
- Les identifiants et paramètres NE DOIVENT JAMAIS être concaténés dans une
  requête SQL ; ils passent en paramètres liés.
- Un mode de repli destiné au développement NE DOIT PAS pouvoir s'activer en
  production sans une déclaration explicite dans la configuration.

## Contraintes d'exploitation

**Frugalité assumée.** Le dispositif est exploité par une équipe réduite sur un
serveur unique. L'architecture DOIT rester simple et monolithique par défaut.
Toute complexité distribuée — découpage en services, file de messages,
orchestration — DOIT être justifiée par un besoin démontré et consigné, jamais
adoptée par anticipation.

**Protection des données par conception.** La conformité aux exigences de la
Commission de protection des données personnelles DOIT être traitée dès la
conception, et non régularisée après la mise en service.

## Cycle de développement et portes de qualité

- Une fonctionnalité DOIT être spécifiée avant d'être écrite. Les phases du
  projet sont documentées sous `docs/`, chacune avec sa procédure de déploiement
  et sa validation.
- Une question métier sans réponse DOIT être consignée dans
  `docs/QUESTIONS-*.md` et posée à la mairie, jamais devinée puis figée dans le
  code.
- **Les tests DOIVENT être écrits avant l'implémentation sur les chemins où un
  défaut coûte de l'argent réel ou de la confiance** : idempotence des
  paiements, imputation des versements, rapprochement avec l'opérateur,
  synchronisation hors ligne et conflits, limites du code à usage unique,
  chaînage du journal d'audit. Un TDD généralisé n'est pas exigé — un principe
  que l'équipe n'appliquera pas sous pression de calendrier décrédibilise tous
  les autres.
- **Toute modification touchant au barème, au paiement ou au journal d'audit
  DOIT être revue par deux personnes distinctes de son auteur.**
- Toute migration DOIT être accompagnée de sa vérification : ce que l'on exécute
  pour constater qu'elle a produit l'effet attendu.
- Le déploiement DOIT rester idempotent, reprenable après coupure, et s'arrêter
  à la première erreur en indiquant quoi faire.
- Une modification de l'API partagée avec l'application de terrain DOIT
  préserver la compatibilité des appareils déjà déployés, ou fournir sa
  procédure de migration : on ne peut pas exiger d'un agent qu'il mette à jour
  son téléphone avant de partir en tournée.
- Toute revue DOIT vérifier la conformité à cette constitution. Un écart DOIT
  être justifié par écrit dans la spécification de la fonctionnalité concernée —
  section *Complexity Tracking* de `plan.md` — en nommant le principe concerné,
  le besoin qui impose l'écart et l'alternative plus simple écartée avec son
  motif. Un écart non consigné est une violation, et un simple commentaire de
  code ne vaut pas consignation.

## Gouvernance

Cette constitution prime sur toute autre pratique, convention ou habitude du
projet. En cas de contradiction entre un document et la constitution, c'est la
constitution qui s'applique, jusqu'à son amendement. En cas de conflit entre une
décision de conception et un principe, c'est la conception qui DOIT être
ajustée — jamais le principe dilué, réinterprété ou silencieusement ignoré.

**Texte unique.** Il NE DOIT exister qu'une seule constitution du projet, à un
seul emplacement : `.specify/memory/constitution.md`. Toute autre copie est une
reproduction, tenue à l'identique, et ne fait pas foi. Deux textes qui priment
l'un et l'autre ne gouvernent rien.

**Amendement.** Un amendement DOIT comporter : la justification écrite du
changement, le texte modifié, la nouvelle version, et le plan de migration des
éléments existants qui deviendraient non conformes. Il est enregistré ici,
accompagné de son Sync Impact Report, daté et approuvé.

**Versionnage.** La constitution suit le versionnage sémantique :

- **MAJEUR** — retrait ou redéfinition incompatible d'un principe. Exemples :
  autoriser un service tiers en exécution, déplacer l'isolation multi-communes
  de la base vers le code, modifier la liste des rôles.
- **MINEUR** — ajout d'un principe ou d'une section, ou extension notable d'une
  règle existante.
- **CORRECTIF** — clarification, reformulation, correction typographique, sans
  effet sur le fond.

**Contrôle de conformité.** La conformité est vérifiée à quatre moments : à la
spécification d'une fonctionnalité, avant la phase de recherche du plan, à la
revue du code, et à la recette avant mise en service. La complexité doit être
justifiée ; à défaut de justification, la solution la plus simple l'emporte.

**Version**: 2.0.0 | **Ratified**: 2026-09-01 | **Last Amended**: 2026-09-01
