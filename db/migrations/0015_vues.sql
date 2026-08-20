-- ===========================================================================
--  0015 — Vues de consultation
--
--  Les vues héritent des politiques RLS des tables sous-jacentes : une mairie
--  qui interroge app.v_stats_zone ne voit que ses propres zones, sans qu'aucun
--  filtre supplémentaire ne soit nécessaire côté API.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Données factices restant à remplacer par les données officielles
-- C'est la première vue à consulter tant que la mairie n'a pas fourni ses
-- délibérations : elle liste tout ce qui est encore provisoire.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_donnees_a_remplacer AS
    SELECT 'zone'::text AS entite, z.id, z.commune_id, z.nom AS libelle,
           'Nom de zone provisoire'::text AS a_faire, NULL::numeric AS montant
    FROM app.zone z WHERE z.a_remplacer
UNION ALL
    SELECT 'quartier', q.id, q.commune_id, q.nom,
           CASE WHEN q.geom IS NULL
                THEN 'Nom provisoire + polygone manquant (détection GPS inactive)'
                ELSE 'Nom provisoire' END, NULL
    FROM app.quartier q WHERE q.a_remplacer OR q.geom IS NULL
UNION ALL
    SELECT 'categorie_commerce', c.id, c.commune_id, c.libelle,
           'Libellé provisoire', NULL
    FROM ref.categorie_commerce c WHERE c.a_remplacer
UNION ALL
    SELECT 'bareme_taxe', b.id, b.commune_id,
           b.libelle,
           'TARIF PROVISOIRE — à remplacer par la délibération du conseil municipal',
           coalesce(b.montant_fixe, b.montant_unitaire)
    FROM app.bareme_taxe b WHERE b.a_remplacer
UNION ALL
    SELECT 'bareme_tranche', t.id, b.commune_id,
           coalesce(t.libelle, 'tranche'),
           'TARIF PROVISOIRE', t.montant
    FROM app.bareme_tranche t
    JOIN app.bareme_taxe b ON b.id = t.bareme_id
    WHERE t.a_remplacer
UNION ALL
    SELECT 'marche', m.id, m.commune_id, m.nom, 'Marché provisoire', NULL
    FROM app.marche m WHERE m.a_remplacer
UNION ALL
    SELECT 'type_emplacement', e.id, e.commune_id, e.libelle, 'Libellé provisoire', NULL
    FROM ref.type_emplacement e WHERE e.a_remplacer;

COMMENT ON VIEW app.v_donnees_a_remplacer IS
'Inventaire des valeurs factices issues du seed. Doit être vide avant toute mise en production.';

-- ---------------------------------------------------------------------------
-- Carte : un point par commerce, avec sa couleur
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_commerce_carte AS
SELECT
    c.id,
    c.commune_id,
    c.code,
    c.enseigne,
    cat.libelle              AS categorie,
    z.nom                    AS zone,
    q.nom                    AS quartier,
    ST_X(c.geom)             AS longitude,
    ST_Y(c.geom)             AS latitude,
    c.statut,
    c.statut_fiscal,
    -- Convention du cahier des charges : vert / orange / rouge
    CASE c.statut_fiscal
        WHEN 'a_jour'  THEN 'vert'
        WHEN 'partiel' THEN 'orange'
        WHEN 'impaye'  THEN 'rouge'
        WHEN 'exonere' THEN 'gris'
        ELSE 'bleu'
    END                      AS couleur,
    c.solde_du,
    c.todp_surface_m2,
    c.derniere_visite_le,
    qr.jeton                 AS qr_jeton
FROM app.commerce c
JOIN ref.categorie_commerce cat ON cat.id = c.categorie_id
JOIN app.zone     z ON z.id = c.zone_id
JOIN app.quartier q ON q.id = c.quartier_id
LEFT JOIN app.qr_code qr ON qr.commerce_id = c.id AND qr.actif
WHERE c.archive_le IS NULL
  AND c.geom IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Statistiques par zone
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_stats_zone AS
SELECT
    z.commune_id,
    z.id                                   AS zone_id,
    z.code                                 AS zone_code,
    z.nom                                  AS zone_nom,
    count(c.id)                            AS nb_commerces,
    count(*) FILTER (WHERE c.statut_fiscal = 'a_jour')  AS nb_a_jour,
    count(*) FILTER (WHERE c.statut_fiscal = 'partiel') AS nb_partiel,
    count(*) FILTER (WHERE c.statut_fiscal = 'impaye')  AS nb_impaye,
    count(*) FILTER (WHERE c.statut_fiscal = 'exonere') AS nb_exonere,
    coalesce(sum(c.solde_du), 0)           AS montant_du,
    -- Taux de recouvrement en pourcentage, arrondi à 0,1 %
    round(100.0 * count(*) FILTER (WHERE c.statut_fiscal = 'a_jour')
          / nullif(count(c.id), 0), 1)     AS taux_a_jour_pct
FROM app.zone z
LEFT JOIN app.commerce c ON c.zone_id = z.id AND c.archive_le IS NULL
WHERE z.archive_le IS NULL
GROUP BY z.commune_id, z.id, z.code, z.nom;

-- ---------------------------------------------------------------------------
-- Statistiques par quartier
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_stats_quartier AS
SELECT
    q.commune_id,
    q.id                                   AS quartier_id,
    q.nom                                  AS quartier_nom,
    z.nom                                  AS zone_nom,
    q.nb_commerces_estime,
    count(c.id)                            AS nb_commerces_recenses,
    -- Taux de couverture du recensement : indispensable pour piloter la
    -- campagne terrain et savoir où envoyer les agents.
    round(100.0 * count(c.id) / nullif(q.nb_commerces_estime, 0), 1) AS taux_recensement_pct,
    count(*) FILTER (WHERE c.statut_fiscal = 'a_jour') AS nb_a_jour,
    count(*) FILTER (WHERE c.statut_fiscal = 'impaye') AS nb_impaye,
    coalesce(sum(c.solde_du), 0)           AS montant_du,
    count(*) FILTER (WHERE c.todp_surface_m2 > 0) AS nb_avec_todp,
    coalesce(sum(c.todp_surface_m2), 0)    AS surface_todp_totale_m2
FROM app.quartier q
JOIN app.zone z ON z.id = q.zone_id
LEFT JOIN app.commerce c ON c.quartier_id = q.id AND c.archive_le IS NULL
WHERE q.archive_le IS NULL
GROUP BY q.commune_id, q.id, q.nom, z.nom, q.nb_commerces_estime;

-- ---------------------------------------------------------------------------
-- Activité des agents, par jour
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_activite_agent AS
SELECT
    v.commune_id,
    v.agent_id,
    u.nom_complet                          AS agent,
    v.debute_le::date                      AS journee,
    count(*)                               AS nb_visites,
    count(*) FILTER (WHERE v.resultat = 'enregistrement') AS nb_enregistrements,
    count(*) FILTER (WHERE v.resultat = 'encaissement')   AS nb_encaissements,
    count(*) FILTER (WHERE v.resultat = 'ferme')          AS nb_fermes,
    count(DISTINCT v.commerce_id)          AS nb_commerces_distincts,
    round(avg(v.duree_secondes)::numeric, 0)             AS duree_moyenne_s,
    -- Visites relevées loin du commerce : signal de contrôle, pas une accusation
    count(*) FILTER (WHERE v.distance_commerce_m > 100)  AS nb_visites_eloignees,
    min(v.debute_le)                       AS premiere_visite,
    max(v.debute_le)                       AS derniere_visite
FROM app.visite v
JOIN app.utilisateur u ON u.id = v.agent_id
GROUP BY v.commune_id, v.agent_id, u.nom_complet, v.debute_le::date;

-- ---------------------------------------------------------------------------
-- Recouvrement par période fiscale
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_recouvrement_periode AS
SELECT
    p.commune_id,
    p.id                                   AS periode_id,
    p.code                                 AS periode,
    p.date_debut,
    p.date_exigibilite,
    p.close,
    count(a.id)                            AS nb_avis,
    coalesce(sum(a.montant_total), 0)      AS montant_attendu,
    coalesce(sum(a.montant_paye), 0)       AS montant_recouvre,
    coalesce(sum(a.montant_restant), 0)    AS montant_restant,
    coalesce(sum(a.montant_penalite), 0)   AS montant_penalites,
    coalesce(sum(a.montant_exonere), 0)    AS montant_exonere,
    round(100.0 * coalesce(sum(a.montant_paye), 0)
          / nullif(sum(a.montant_total), 0), 1) AS taux_recouvrement_pct,
    count(*) FILTER (WHERE a.statut = 'paye')               AS nb_payes,
    count(*) FILTER (WHERE a.statut = 'partiellement_paye') AS nb_partiels,
    count(*) FILTER (WHERE a.statut = 'emis')               AS nb_impayes
FROM app.periode_fiscale p
LEFT JOIN app.avis_imposition a ON a.periode_id = p.id AND a.annule_le IS NULL
GROUP BY p.commune_id, p.id, p.code, p.date_debut, p.date_exigibilite, p.close;

-- ---------------------------------------------------------------------------
-- Recouvrement par type de taxe
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_recouvrement_taxe AS
SELECT
    a.commune_id,
    p.code                                 AS periode,
    tt.code                                AS taxe_code,
    tt.libelle_court                       AS taxe,
    count(l.id)                            AS nb_lignes,
    coalesce(sum(l.montant), 0)            AS montant_facture,
    coalesce(sum(l.montant_exonere), 0)    AS montant_exonere,
    -- Répartition proportionnelle de l'encaissement sur les lignes de l'avis :
    -- le commerçant paie un montant global, pas taxe par taxe.
    coalesce(sum(l.montant * a.montant_paye / nullif(a.montant_total, 0)), 0)::numeric(16,0)
                                           AS montant_recouvre_estime
FROM app.avis_ligne l
JOIN app.avis_imposition a ON a.id = l.avis_id AND a.annule_le IS NULL
JOIN app.periode_fiscale p ON p.id = a.periode_id
JOIN ref.type_taxe tt ON tt.id = l.type_taxe_id
GROUP BY a.commune_id, p.code, tt.code, tt.libelle_court, tt.ordre_affichage
ORDER BY p.code DESC, tt.ordre_affichage;

COMMENT ON VIEW app.v_recouvrement_taxe IS
'Le montant recouvré par taxe est une ESTIMATION proportionnelle : un paiement Wave règle l''avis global, pas une taxe en particulier.';

-- ---------------------------------------------------------------------------
-- Journal d'audit lisible (pour l'écran de consultation du dashboard)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_journal_audit AS
SELECT
    j.id,
    j.commune_id,
    j.horodatage,
    j.action,
    j.entite,
    j.entite_libelle,
    coalesce(j.utilisateur_nom, 'système')  AS auteur,
    j.utilisateur_role                      AS role,
    j.ip,
    j.champs_modifies,
    j.montant,
    j.reference,
    j.motif,
    ST_X(j.geom)                            AS longitude,
    ST_Y(j.geom)                            AS latitude,
    j.valeurs_avant,
    j.valeurs_apres
FROM audit.journal j;

-- ---------------------------------------------------------------------------
-- Encaissements en espèces non encore versés en caisse
-- Le contrôle anti-détournement le plus direct du dispositif.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_especes_non_versees AS
SELECT
    p.commune_id,
    p.encaisse_par                          AS agent_id,
    u.nom_complet                           AS agent,
    count(*)                                AS nb_paiements,
    sum(p.montant)                          AS montant_total,
    min(p.paye_le)                          AS plus_ancien,
    max(p.paye_le)                          AS plus_recent,
    round(EXTRACT(EPOCH FROM (now() - min(p.paye_le))) / 86400)::integer AS anciennete_jours
FROM app.paiement p
JOIN app.utilisateur u ON u.id = p.encaisse_par
WHERE p.moyen = 'especes'
  AND p.verse_en_caisse_le IS NULL
  AND p.annule_le IS NULL
GROUP BY p.commune_id, p.encaisse_par, u.nom_complet;

-- ---------------------------------------------------------------------------
-- Tableau de bord synthétique d'une commune
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_tableau_bord AS
SELECT
    c.id                                    AS commune_id,
    c.nom                                   AS commune,
    (SELECT count(*) FROM app.commerce  x WHERE x.commune_id = c.id AND x.archive_le IS NULL) AS nb_commerces,
    (SELECT count(*) FROM app.commerce  x WHERE x.commune_id = c.id AND x.archive_le IS NULL
                                            AND x.statut_fiscal = 'a_jour')                  AS nb_a_jour,
    (SELECT count(*) FROM app.commerce  x WHERE x.commune_id = c.id AND x.archive_le IS NULL
                                            AND x.statut_fiscal = 'impaye')                  AS nb_impayes,
    (SELECT coalesce(sum(x.solde_du), 0) FROM app.commerce x
                                          WHERE x.commune_id = c.id AND x.archive_le IS NULL) AS montant_du_total,
    (SELECT count(*) FROM app.utilisateur u WHERE u.commune_id = c.id AND u.role = 'agent'
                                              AND u.actif AND u.archive_le IS NULL)           AS nb_agents,
    (SELECT count(*) FROM app.visite v WHERE v.commune_id = c.id
                                         AND v.debute_le::date = current_date)                AS nb_visites_aujourdhui,
    (SELECT coalesce(sum(p.montant), 0) FROM app.paiement p
        WHERE p.commune_id = c.id AND p.annule_le IS NULL
          AND p.paye_le::date = current_date)                                                 AS encaisse_aujourdhui,
    (SELECT coalesce(sum(p.montant), 0) FROM app.paiement p
        WHERE p.commune_id = c.id AND p.annule_le IS NULL
          AND p.paye_le >= date_trunc('month', current_date))                                 AS encaisse_ce_mois,
    (SELECT count(*) FROM app.sync_operation s
        WHERE s.commune_id = c.id AND s.statut = 'conflit')                                   AS nb_conflits_sync,
    (SELECT count(*) FROM app.v_donnees_a_remplacer d WHERE d.commune_id = c.id)              AS nb_donnees_provisoires
FROM app.commune c
WHERE c.archive_le IS NULL;

COMMENT ON VIEW app.v_tableau_bord IS
'Chiffres d''accueil du dashboard. nb_donnees_provisoires doit tomber à 0 avant la mise en production.';
