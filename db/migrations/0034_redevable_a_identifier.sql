-- ===========================================================================
--  0034 — Un objet peut être recensé avant que son redevable soit connu
--
--  CE QUE LE TERRAIN A RÉVÉLÉ
--
--  Le modèle exigeait un redevable dès la création d'un dispositif
--  d'affichage ou d'un chantier. C'est tenable au bureau, pas sur le trottoir.
--
--  Le document de référence le dit lui-même : pour un panneau publicitaire
--  (AFF-05), « le redevable est souvent une régie, sans commerce rattaché ».
--  L'agent qui remonte une rue voit un panneau 4x3. Il peut le mesurer, le
--  photographier, le géolocaliser. Il ne peut pas deviner quelle société
--  l'exploite — cette information se trouve dans un contrat, à la mairie.
--
--  Même chose pour un chantier : le promoteur se lit sur le permis de
--  construire quand il est affiché, et il ne l'est pas toujours.
--
--  L'ANCIEN COMPORTEMENT AURAIT COÛTÉ CHER
--
--  La synchronisation rejetait l'opération. L'agent voyait « échec » sans
--  comprendre, et le panneau n'était jamais recensé — donc jamais taxé. La
--  contrainte, en voulant garantir qu'une facture ait un destinataire,
--  garantissait surtout qu'il n'y ait pas de facture du tout.
--
--  LE NOUVEAU COMPORTEMENT
--
--  L'objet est enregistré sans redevable. Il n'est pas facturable en l'état
--  — la génération des avis parcourt les redevables, un objet orphelin en est
--  naturellement absent. Il apparaît dans une file de travail pour la mairie,
--  qui rattache le dossier depuis le tableau de bord.
--
--  On échange donc « rien de recensé » contre « recensé, à rattacher ».
-- ===========================================================================

ALTER TABLE app.dispositif_affichage ALTER COLUMN redevable_id DROP NOT NULL;
ALTER TABLE app.chantier            ALTER COLUMN redevable_id DROP NOT NULL;

COMMENT ON COLUMN app.dispositif_affichage.redevable_id IS
'NULL tant que l''annonceur n''est pas identifié — cas courant pour un panneau de régie relevé lors d''un balayage de rue. Un dispositif sans redevable n''est pas facturable.';
COMMENT ON COLUMN app.chantier.redevable_id IS
'NULL tant que le promoteur n''est pas identifié. Le permis de construire n''est pas toujours affiché sur la palissade.';

-- ---------------------------------------------------------------------------
-- Le déclencheur n'exige plus, il déduit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.affichage_heriter_redevable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Une enseigne posée sur une devanture appartient au commerçant : le
    -- ressaisir serait une occasion de se tromper.
    IF NEW.redevable_id IS NULL AND NEW.commerce_id IS NOT NULL THEN
        SELECT c.redevable_id INTO NEW.redevable_id
          FROM app.commerce c WHERE c.id = NEW.commerce_id;
    END IF;

    -- Sans commerce ni redevable, on n'échoue plus : l'objet existe, son
    -- propriétaire reste à établir. Voir app.v_objets_sans_redevable.
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.affichage_heriter_redevable IS
'Déduit le redevable du commerce quand il y en a un. N''échoue plus en son absence : un panneau de régie est recensé avant que son exploitant soit connu.';

-- ---------------------------------------------------------------------------
-- La file de travail de la mairie
--
--  Sans cette vue, les objets orphelins seraient invisibles : recensés, non
--  facturés, et oubliés. C'est exactement le sort qu'on voulait éviter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_objets_sans_redevable AS
SELECT d.commune_id,
       'affichage'::app.type_objet_taxable AS objet_type,
       d.id            AS objet_id,
       d.code,
       coalesce(d.texte_affiche, ta.libelle) AS libelle,
       ta.code         AS type_code,
       ta.libelle      AS type_libelle,
       d.surface_m2,
       r.nom           AS rue,
       q.nom           AS quartier,
       d.adresse_libelle,
       d.date_constat,
       u.nom_complet   AS recense_par,
       ST_X(d.geom)    AS longitude,
       ST_Y(d.geom)    AS latitude
  FROM app.dispositif_affichage d
  JOIN ref.type_affichage ta   ON ta.id = d.type_affichage_id
  LEFT JOIN app.rue r          ON r.id = d.rue_id
  LEFT JOIN app.quartier q     ON q.id = d.quartier_id
  LEFT JOIN app.utilisateur u  ON u.id = d.agent_recenseur_id
 WHERE d.redevable_id IS NULL AND d.archive_le IS NULL AND d.actif
UNION ALL
SELECT ch.commune_id, 'chantier', ch.id, ch.code,
       coalesce(ch.libelle, 'Chantier'),
       NULL, 'Occupation temporaire',
       ch.surface_m2,
       r.nom, q.nom, ch.adresse_libelle, ch.date_constat,
       u.nom_complet,
       ST_X(ch.geom), ST_Y(ch.geom)
  FROM app.chantier ch
  LEFT JOIN app.rue r         ON r.id = ch.rue_id
  LEFT JOIN app.quartier q    ON q.id = ch.quartier_id
  LEFT JOIN app.utilisateur u ON u.id = ch.agent_recenseur_id
 WHERE ch.redevable_id IS NULL AND ch.archive_le IS NULL
   AND ch.statut IN ('en_cours', 'prolonge');

COMMENT ON VIEW app.v_objets_sans_redevable IS
'Objets recensés sur le terrain dont le propriétaire reste à identifier. Non facturables tant qu''ils y figurent — c''est la file de travail du service des finances, pas une anomalie.';

-- ---------------------------------------------------------------------------
-- Un dispositif orphelin ne doit pas disparaître des radars
--
--  Il entre dans l'inventaire des données à compléter, au même titre qu'un
--  tarif provisoire : le tableau de bord le signale, et la recette refuse de
--  passer au vert tant qu'il en reste.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_donnees_a_remplacer AS
    SELECT 'zone'::text AS entite, z.id, z.commune_id, z.nom AS libelle,
           'Nom de zone provisoire'::text AS a_faire, NULL::numeric AS montant
    FROM app.zone z WHERE z.a_remplacer AND z.archive_le IS NULL
UNION ALL
    SELECT 'quartier', q.id, q.commune_id, q.nom,
           CASE WHEN q.geom IS NULL
                THEN 'Nom provisoire + polygone manquant (détection GPS inactive)'
                ELSE 'Nom provisoire' END, NULL
    FROM app.quartier q
    WHERE (q.a_remplacer OR q.geom IS NULL) AND q.archive_le IS NULL
UNION ALL
    SELECT 'categorie_commerce', c.id, c.commune_id, c.libelle,
           'Libellé provisoire', NULL
    FROM ref.categorie_commerce c WHERE c.a_remplacer AND c.archive_le IS NULL
UNION ALL
    SELECT 'bareme_taxe', b.id, b.commune_id, b.libelle,
           CASE
             WHEN b.date_fin IS NOT NULL
               THEN 'Tarif provisoire, remplacé automatiquement le '
                    || to_char(b.date_fin, 'DD/MM/YYYY')
                    || ' — plus rien à faire'
             ELSE 'TARIF PROVISOIRE — à remplacer par la délibération du conseil municipal'
           END,
           COALESCE(b.montant_fixe, b.montant_unitaire)
    FROM app.bareme_taxe b
    WHERE b.a_remplacer AND (b.date_fin IS NULL OR b.date_fin > current_date)
UNION ALL
    SELECT 'bareme_tranche', t.id, b.commune_id,
           COALESCE(t.libelle, 'tranche'),
           CASE WHEN b.date_fin IS NOT NULL
                THEN 'Tarif provisoire, remplacé le ' || to_char(b.date_fin, 'DD/MM/YYYY')
                ELSE 'TARIF PROVISOIRE' END,
           t.montant
    FROM app.bareme_tranche t
    JOIN app.bareme_taxe b ON b.id = t.bareme_id
    WHERE t.a_remplacer AND (b.date_fin IS NULL OR b.date_fin > current_date)
UNION ALL
    SELECT 'marche', m.id, m.commune_id, m.nom, 'Marché provisoire', NULL
    FROM app.marche m WHERE m.a_remplacer AND m.archive_le IS NULL
UNION ALL
    SELECT 'type_emplacement', e.id, e.commune_id, e.libelle,
           'Libellé provisoire', NULL
    FROM ref.type_emplacement e WHERE e.a_remplacer AND e.actif
UNION ALL
    -- Nouveau : les objets recensés dont personne ne sait à qui envoyer la
    -- facture. Ils ne sont pas « provisoires » au sens d'un tarif inventé,
    -- mais ils appellent exactement le même geste : quelqu'un doit compléter.
    SELECT 'objet_sans_redevable', o.objet_id, o.commune_id,
           o.code || ' — ' || o.libelle,
           'Redevable à identifier : '
             || coalesce(o.rue, o.quartier, 'localisation inconnue'),
           NULL
    FROM app.v_objets_sans_redevable o;

COMMENT ON VIEW app.v_donnees_a_remplacer IS
'Inventaire de ce qui doit être complété avant une facturation réelle : valeurs provisoires encore actives et objets sans redevable identifié.';
