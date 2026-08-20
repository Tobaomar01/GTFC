-- ===========================================================================
--  0018 — La vue des données provisoires ne compte plus l'historique
--
--  Défaut corrigé : app.v_donnees_a_remplacer comptait TOUS les barèmes
--  marqués provisoires, y compris ceux qui avaient été CLOS lors de l'import
--  des tarifs officiels.
--
--  Conséquence : après un import parfaitement réussi, le tableau de bord
--  continuait d'afficher « 54 données provisoires » et la recette refusait
--  de passer au vert. L'exploitant n'avait aucun moyen de savoir que
--  l'alerte portait sur de l'histoire, pas sur un travail à faire.
--
--  Un barème clos est une trace : il explique les quittances émises pendant
--  sa période de validité et ne doit surtout pas être supprimé. Mais il n'y
--  a plus rien à y remplacer.
-- ===========================================================================

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
    -- Seuls les barèmes ENCORE EN VIGUEUR comptent. Un barème clos garde son
    -- drapeau `a_remplacer` — c'est ainsi qu'on sait, des années plus tard,
    -- qu'une quittance de 2026 reposait sur un tarif d'attente.
    SELECT 'bareme_taxe', b.id, b.commune_id, b.libelle,
           CASE
             -- Un tarif officiel a déjà été importé et prendra le relais :
             -- il n'y a plus rien à faire, seulement à attendre la date.
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
    FROM ref.type_emplacement e WHERE e.a_remplacer AND e.actif;

COMMENT ON VIEW app.v_donnees_a_remplacer IS
'Inventaire des valeurs provisoires ENCORE ACTIVES. Doit être vide avant toute émission réelle d''avis. Les barèmes clos en sont exclus : ce sont des traces, pas du travail restant.';

-- ---------------------------------------------------------------------------
-- Vue jumelle : l'historique des tarifs, pour justifier une ancienne quittance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_historique_baremes AS
SELECT b.commune_id,
       t.code                AS taxe_code,
       t.libelle_court       AS taxe,
       b.libelle,
       b.mode_calcul,
       b.date_effet,
       b.date_fin,
       (b.date_fin IS NULL OR b.date_fin > current_date) AS en_vigueur,
       b.a_remplacer         AS etait_provisoire,
       b.delib_reference,
       b.delib_date,
       COALESCE(b.montant_fixe, b.montant_unitaire) AS montant,
       b.unite,
       (SELECT count(*) FROM app.bareme_tranche tr WHERE tr.bareme_id = b.id) AS nb_tranches,
       (SELECT count(*) FROM app.avis_ligne l WHERE l.bareme_id = b.id)       AS nb_avis_emis
  FROM app.bareme_taxe b
  JOIN ref.type_taxe t ON t.id = b.type_taxe_id
 ORDER BY t.ordre_affichage, b.date_effet DESC;

COMMENT ON VIEW app.v_historique_baremes IS
'Tous les tarifs, en vigueur et passés, avec le nombre d''avis émis sous chacun. Sert à justifier un montant contesté sur une quittance ancienne.';
