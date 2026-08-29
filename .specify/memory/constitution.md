<!--
SYNC IMPACT REPORT
==================
Changement de version : (gabarit non rempli) → 1.0.0
Motif : première ratification. Le fichier ne contenait que le gabarit vierge
(tous les jetons [ALL_CAPS] intacts) ; il ne s'agit donc pas d'un amendement
mais de l'adoption initiale.

Principes ajoutés (aucun n'existait auparavant) :
  - I.   Isolation multi-communes garantie par la base (NON-NÉGOCIABLE)
  - II.  Traçabilité inaltérable
  - III. Le terrain d'abord : hors-ligne, idempotent, sans perte
  - IV.  Souveraineté et minimisation des données
  - V.   La vérité métier vit dans la base, pas dans le code
  - VI.  Vérification par recette exécutable
  - VII. Lisible par la mairie — le français est la langue du projet

Le gabarit propose 5 emplacements de principes ; 7 ont été retenus, les deux
derniers correspondant à des pratiques déjà constantes dans le dépôt
(recettes exécutables, francisation intégrale) qu'il serait trompeur de
reléguer en simple contrainte.

Sections ajoutées :
  - Contraintes techniques et sécurité (emplacement SECTION_2)
  - Cycle de développement et portes de qualité (emplacement SECTION_3)
  - Gouvernance

Sections retirées : aucune.
Jetons résiduels : aucun. Aucun TODO différé.

Sources d'inférence : README.md ; db/migrations/0010, 0014, 0019 ;
db/migrate.sh ; apps/api/src/config/database.js ;
apps/api/src/services/sync.service.js ;
apps/dashboard/src/app/api/proxy/[...chemin]/route.js ; scripts/recette.sh ;
scripts/deployer.sh ; scripts/add-commune-domain.sh ; docs/.

Date de ratification : 2026-08-20, date du premier commit du dépôt
(069e3ec « Plateforme de collecte des taxes locales — GTFC »).
-->

# Constitution de la plateforme GTFC

Plateforme de digitalisation de la collecte des taxes locales — commune de
Gueule Tapée-Fass-Colobane (Dakar, Sénégal). GTFC est la commune pilote ; la
plateforme est conçue dès l'origine pour en héberger plusieurs.

## Principes fondamentaux

### I. Isolation multi-communes garantie par la base (NON-NÉGOCIABLE)

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

### II. Traçabilité inaltérable

Toute mutation métier DOIT laisser une trace dans le schéma `audit` : qui, quoi,
valeurs avant et après, où (position GPS lorsqu'elle existe), quand.

- Le schéma `audit` DOIT rester en ajout seul. Cette propriété est tenue à la
  fois par les droits SQL du rôle applicatif et par des déclencheurs
  `BEFORE UPDATE/DELETE` — deux barrières, parce qu'une seule peut être
  contournée par une connexion superutilisateur faite par erreur.
- Aucune fonctionnalité NE DOIT contourner le journal, y compris les tâches
  planifiées, les imports de référentiels et les scripts d'exploitation.
- Le journal DOIT rester lisible : seuls les champs réellement modifiés sont
  enregistrés, et le libellé de l'entité est recopié pour rester compréhensible
  après archivage du compte ou de la fiche.

Raison : l'adhésion de la mairie repose sur l'engagement « aucune modification
possible sans laisser de trace ». C'est la réponse au risque de fraude interne,
qui est le premier risque du métier.

### III. Le terrain d'abord : hors-ligne, idempotent, sans perte

Toute fonction destinée à l'agent de terrain DOIT fonctionner sans réseau et se
synchroniser plus tard.

- Un lot de synchronisation renvoyé après une coupure NE DOIT produire aucun
  effet supplémentaire. L'idempotence s'appuie sur l'identifiant local généré
  par le téléphone, jamais sur une heuristique de ressemblance.
- Une opération invalide NE DOIT PAS faire échouer les autres opérations du
  lot : chacune est traitée dans sa propre sous-transaction et rapporte son sort
  individuellement.
- Un conflit entre la fiche locale et la fiche serveur DOIT être signalé à un
  superviseur. Il NE DOIT JAMAIS être résolu par écrasement silencieux.

Raison : l'agent recense en marchant, dans des zones à couverture incertaine. Le
travail d'une journée ne se perd pas, et une reprise de synchronisation ne crée
ni doublon de commerce ni double taxation.

### IV. Souveraineté et minimisation des données

La plateforme DOIT rester auto-hébergée sur le serveur de la commune.

- Les seuls flux sortants autorisés sont **Wave** — numéro de téléphone et
  montant, jamais de donnée fiscale ni nominative — et **les tuiles
  OpenStreetMap**, qui ne portent aucune donnée de la commune.
- Toute nouvelle dépendance externe en exécution (mesure d'audience, CDN,
  service tiers, service d'intelligence artificielle, télémétrie) DOIT faire
  l'objet d'un amendement explicite de cette constitution avant d'être
  introduite.
- Les jetons d'authentification NE DOIVENT JAMAIS atteindre le navigateur :
  l'interface passe par un mandataire côté serveur qui attache le jeton lu dans
  un cookie `httpOnly`.
- Aucun stockage d'objets NE DOIT être public. Les photos ne sont servies que
  par URL pré-signée, générée après vérification du jeton.
- PostgreSQL et MinIO NE DOIVENT écouter que sur `127.0.0.1`.

Raison : ce sont des données fiscales et nominatives de citoyens sénégalais.
Elles n'ont aucune raison de quitter le serveur de la commune, et la commune
doit pouvoir le vérifier elle-même.

### V. La vérité métier vit dans la base, pas dans le code

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
- Les montants DOIVENT être des entiers en francs CFA. Aucun calcul de taxe NE
  DOIT reposer sur un nombre à virgule flottante.

Raison : un taux de taxe change par délibération du conseil municipal, pas par
déploiement. Chaque commune a ses propres barèmes ; les figer dans le code
interdirait la seconde commune.

### VI. Vérification par recette exécutable

Toute livraison DOIT être prouvée par une recette exécutable qui exerce le
parcours métier de bout en bout : se connecter, recenser, calculer une taxe,
synchroniser, encaisser, produire une quittance, exporter.

- Une recette CONSTATE, elle n'agit pas : elle DOIT aller jusqu'au bout et
  rapporter tous les écarts, jamais s'arrêter au premier.
- Les données créées par une recette DOIVENT être préfixées et nettoyées en fin
  d'exécution ; une relance après interruption DOIT nettoyer les restes.
- La surveillance des services (`healthcheck`) et la vérification du métier
  (`recette`) DOIVENT rester deux choses distinctes : des services debout ne
  prouvent pas qu'une taxe se calcule.
- Une sauvegarde jamais restaurée n'est pas une sauvegarde. La restauration
  complète DOIT être rejouée automatiquement et périodiquement.

Raison : le risque de ce projet n'est pas la fonction qui plante, c'est la
chaîne fiscale qui ne boucle pas — un avis émis sans paiement possible, une
quittance sans trace, un export qui ne réconcilie pas.

### VII. Lisible par la mairie — le français est la langue du projet

- Le code, les noms de tables, de colonnes, de fichiers et de variables, les
  commentaires, les messages d'erreur, les journaux et la documentation DOIVENT
  être en français.
- Les commentaires DOIVENT expliquer *pourquoi*, pas *quoi*. Chaque module ou
  migration DOIT s'ouvrir sur l'exigence métier qu'il tient.
- La documentation destinée aux utilisateurs (guide de l'agent, guide de la
  mairie) DOIT rester utilisable sur le terrain, imprimable, sans jargon.

Raison : la commune doit pouvoir reprendre, auditer et faire évoluer la
plateforme sans dépendre de son prestataire d'origine. Un code qu'elle ne lit
pas est un code qu'elle ne possède pas.

## Contraintes techniques et sécurité

La pile technique est arrêtée et NE DOIT PAS être élargie sans amendement :

- **Données** : PostgreSQL 16 + PostGIS, schémas `app` / `ref` / `audit`.
- **API** : Node.js 20+ et Express, validation des entrées par zod,
  journalisation structurée par pino, authentification JWT à quatre rôles.
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

## Cycle de développement et portes de qualité

- Une fonctionnalité DOIT être spécifiée avant d'être écrite. Les phases du
  projet sont documentées sous `docs/`, chacune avec sa procédure de déploiement
  et sa validation.
- Une question métier sans réponse DOIT être consignée dans
  `docs/QUESTIONS-*.md` et posée à la mairie, jamais devinée puis figée dans le
  code.
- Toute migration DOIT être accompagnée de sa vérification : ce que l'on exécute
  pour constater qu'elle a produit l'effet attendu.
- Le déploiement DOIT rester idempotent, reprenable après coupure, et s'arrêter
  à la première erreur en indiquant quoi faire.
- Une modification de l'API partagée avec l'application de terrain DOIT
  préserver la compatibilité des appareils déjà déployés, ou fournir sa
  procédure de migration : on ne peut pas exiger d'un agent qu'il mette à jour
  son téléphone avant de partir en tournée.
- Toute revue DOIT vérifier la conformité à cette constitution. Un écart DOIT
  être justifié dans la spécification de la fonctionnalité concernée, jamais
  dans un simple commentaire de code.

## Gouvernance

Cette constitution prime sur toute autre pratique, convention ou habitude du
projet. En cas de contradiction entre un document et la constitution, c'est la
constitution qui s'applique, jusqu'à son amendement.

**Amendement.** Un amendement DOIT comporter : la justification écrite du
changement, le texte modifié, la nouvelle version, et le plan de migration des
éléments existants qui deviendraient non conformes. Il est enregistré dans
`.specify/memory/constitution.md`, accompagné de son Sync Impact Report.

**Versionnage.** La constitution suit le versionnage sémantique :

- **MAJEUR** — retrait ou redéfinition incompatible d'un principe. Exemples :
  autoriser un service tiers en exécution, déplacer l'isolation multi-communes
  de la base vers le code.
- **MINEUR** — ajout d'un principe ou d'une section, ou extension notable d'une
  règle existante.
- **CORRECTIF** — clarification, reformulation, correction typographique, sans
  effet sur le fond.

**Contrôle de conformité.** La conformité est vérifiée à trois moments : à la
spécification d'une fonctionnalité, à la revue du code, et à la recette avant
mise en service. La complexité doit être justifiée ; à défaut de justification,
la solution la plus simple l'emporte.

**Version**: 1.0.0 | **Ratified**: 2026-08-20 | **Last Amended**: 2026-08-29
