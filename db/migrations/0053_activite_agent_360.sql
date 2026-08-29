-- 0053 — Le relevé d'activité des agents, vu à 360°
--
-- La vue ne comptait que trois natures d'intervention sur les dix que connaît
-- `app.resultat_visite`. Un agent passant sa journée en contrôles et en mises
-- à jour apparaissait donc presque inactif : le rapport mesurait le
-- recensement, pas le travail.
--
-- Elle sert à deux lectures qu'il faut tenir ensemble : le pilotage de la
-- campagne — où en est-on, qui a besoin d'aide — et la reconnaissance du
-- travail fourni. Une vue qui ne compte que ce qui est facile à compter finit
-- par pousser les agents vers ce qui est compté.
--
-- Ce qu'elle ne fait PAS, et ne fera pas : suivre les déplacements. Le suivi
-- de position des agents a été écarté par le commanditaire (FR-051a, FR-051b).
-- Les seules positions ici sont celles RATTACHÉES à une intervention, et la
-- seule qui soit exploitée est l'écart entre le point de la visite et celui du
-- commerce — un contrôle de qualité de la donnée, pas une trace de parcours.
--
-- Les colonnes existantes gardent leur nom, leur ordre et leur sens : la page
-- Agents du tableau de bord et `GET /agents/:id/activite` s'appuient dessus.

CREATE OR REPLACE VIEW app.v_activite_agent AS
SELECT v.commune_id,
       v.agent_id,
       u.nom_complet                        AS agent,
       v.debute_le::date                    AS journee,
       count(*)                             AS nb_visites,
       count(*) FILTER (WHERE v.resultat = 'enregistrement') AS nb_enregistrements,
       count(*) FILTER (WHERE v.resultat = 'encaissement')   AS nb_encaissements,
       count(*) FILTER (WHERE v.resultat = 'ferme')          AS nb_fermes,
       count(DISTINCT v.commerce_id)        AS nb_commerces_distincts,
       round(avg(v.duree_secondes), 0)      AS duree_moyenne_s,
       count(*) FILTER (WHERE v.distance_commerce_m > 100)   AS nb_visites_eloignees,
       min(v.debute_le)                     AS premiere_visite,
       max(v.debute_le)                     AS derniere_visite,

       -- --- Ajouts : les natures d'intervention jusque-là invisibles -------
       count(*) FILTER (WHERE v.resultat = 'mise_a_jour')    AS nb_mises_a_jour,
       count(*) FILTER (WHERE v.resultat = 'controle')       AS nb_controles,
       count(*) FILTER (WHERE v.resultat = 'refus')          AS nb_refus,
       count(*) FILTER (WHERE v.resultat = 'introuvable')    AS nb_introuvables,
       count(*) FILTER (WHERE v.resultat IN ('recensement_affichage',
                                             'recensement_chantier',
                                             'constat_fin_chantier'))
                                                             AS nb_autres_objets,

       -- Temps effectivement passé en intervention, en minutes. La somme dit
       -- ce que la moyenne cache : dix visites de trente secondes et dix
       -- visites de dix minutes ne sont pas la même journée.
       round(sum(v.duree_secondes) / 60.0, 0)                AS minutes_intervention,

       -- Amplitude de la journée, bornes de la première et de la dernière
       -- intervention. Ce n'est pas un pointage : rien n'est enregistré entre
       -- les deux.
       round(EXTRACT(epoch FROM max(v.debute_le) - min(v.debute_le)) / 3600.0, 1)
                                                             AS amplitude_h,

       count(*) FILTER (WHERE v.hors_ligne)                  AS nb_hors_ligne
  FROM app.visite v
  JOIN app.utilisateur u ON u.id = v.agent_id
 GROUP BY v.commune_id, v.agent_id, u.nom_complet, v.debute_le::date;

COMMENT ON VIEW app.v_activite_agent IS
  'Relevé d''activité par agent et par journée, toutes natures d''intervention. '
  'Ne contient aucune trace de déplacement : seules les positions rattachées à '
  'une intervention existent, et seul l''écart au commerce en est tiré.';

GRANT SELECT ON app.v_activite_agent TO gtfc_app;
