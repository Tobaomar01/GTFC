/**
 * Les requêtes qui décident du sort d'une photo, isolées du reste.
 *
 * POURQUOI DANS LEUR PROPRE FICHIER.
 *
 * Elles répondent à deux questions dont dépend ce que l'agent voit : combien de
 * photos vont partir, et lesquelles ne partiront plus. Une erreur d'ordre de
 * paramètres ou une parenthèse mal placée ne se verrait qu'au téléphone, sur le
 * cas rare — la photo bloquée — c'est-à-dire jamais pendant les essais.
 *
 * `sync.repo.js` ne peut pas être chargé hors d'un téléphone : il tire
 * expo-sqlite, donc React Native. Ce fichier-ci ne contient que des CHAÎNES.
 * `outils/epreuve-file-photos.js` les exécute sur un vrai SQLite, avec les cinq
 * situations qu'un agent rencontre.
 *
 * C'est la seule façon d'avoir une épreuve qui porte sur le code employé, et
 * non sur une copie de ce code qui continuerait de passer après une
 * modification.
 */

/**
 * Une photo attend son commerce, ou elle est bloquée. Ce n'est pas pareil.
 *
 * Une photo dont le commerce n'est pas encore parti est NORMALE : la fiche
 * passera à la prochaine synchronisation et la photo suivra. Elle n'est bloquée
 * que si la fiche elle-même ne partira plus — rejetée, en conflit, ou ayant
 * épuisé ses tentatives.
 *
 * Confondre les deux ferait crier le contrôle sur le cas ordinaire, et un
 * avertissement qui se déclenche toujours ne se lit plus.
 *
 * Un paramètre : le nombre maximum de tentatives.
 */
export const SQL_COMMERCE_BLOQUE = `
  c.id_serveur IS NULL AND EXISTS (
    SELECT 1 FROM operation_sync o
     WHERE o.identifiant_local = c.id_local
       AND o.entite = 'commerce'
       AND (o.statut IN ('conflit', 'rejetee') OR o.tentatives >= ?))`;

/**
 * Ce qui peut encore partir. Deux paramètres : tentatives max, deux fois.
 *
 * Le compte doit porter sur exactement ce que l'envoi traitera — sinon le
 * bandeau annonce des envois qui n'auront jamais lieu. Il comptait toutes les
 * photos non envoyées, y compris celles qui ont épuisé leurs tentatives et
 * celles dont le commerce ne remontera plus : le bandeau orange « N élément(s)
 * à envoyer » ne retombait JAMAIS à zéro, et la déconnexion restait refusée en
 * permanence. Un agent apprend vite à ignorer un avertissement qui ne s'éteint
 * pas, et le jour où il compte vraiment, il ne le voit plus.
 */
export const SQL_COMPTER_PHOTOS_EN_ATTENTE = `
    SELECT count(*) AS n
      FROM photo_locale p
      JOIN commerce c ON c.id_local = p.commerce_local
     WHERE p.envoyee = 0
       AND p.tentatives < ?
       AND NOT (${SQL_COMMERCE_BLOQUE})`;

/**
 * Ce qui ne partira plus tout seul. Trois paramètres : tentatives max, trois
 * fois — une pour la cause affichée, deux pour la sélection.
 *
 * Ces photos n'apparaissaient nulle part : la liste « à examiner » ne lit que
 * la file d'opérations, et le compteur les portait sans jamais pouvoir les
 * envoyer. Une photo de devanture est la preuve d'un recensement ; perdue en
 * silence, elle emporte la preuve avec elle.
 */
export const SQL_PHOTOS_BLOQUEES = `
  SELECT p.id_local, p.type, p.prise_le, p.tentatives, p.derniere_erreur,
         c.enseigne,
         CASE WHEN p.tentatives >= ? THEN 'envoi_refuse'
              ELSE 'fiche_bloquee' END AS cause
    FROM photo_locale p
    JOIN commerce c ON c.id_local = p.commerce_local
   WHERE p.envoyee = 0
     AND (p.tentatives >= ? OR (${SQL_COMMERCE_BLOQUE}))
   ORDER BY p.prise_le DESC LIMIT 50`;

/**
 * Au-delà, on cesse de réessayer automatiquement : l'opération est
 * probablement invalide et il faut l'avis d'un humain.
 *
 * La constante vit ici, avec les requêtes qui s'en servent, pour que
 * database.js puisse l'employer sans importer sync.repo.js — lequel importe
 * database.js. `sync.repo` la réexporte, tous ses appelants sont inchangés.
 */
export const TENTATIVES_MAX = 5;

/**
 * Tout ce qui n'est pas remonté, y compris ce qui ne remontera plus.
 *
 * C'est un compte DIFFÉRENT de SQL_COMPTER_PHOTOS_EN_ATTENTE, et les confondre
 * était le défaut. Celui-ci garde la remise à zéro du téléphone : elle efface
 * les fichiers, donc elle doit compter les photos bloquées — ce sont
 * précisément celles qu'on perdrait pour de bon.
 *
 * L'autre garde le bandeau et la déconnexion : annoncer des envois qui
 * n'auront jamais lieu rend l'avertissement inaudible.
 */
export const SQL_COMPTER_PHOTOS_NON_REMONTEES =
  'SELECT count(*) AS n FROM photo_locale WHERE envoyee = 0';
