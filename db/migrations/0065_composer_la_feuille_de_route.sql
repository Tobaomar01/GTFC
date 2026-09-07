-- ===========================================================================
--  Composition de la feuille de route quotidienne — FR-072, FR-073, FR-074
--
--  IDEMPOTENTE. Rappelee le meme jour pour le meme agent, elle rend la feuille
--  deja composee sans rien changer. Le planificateur peut donc etre rejoue, et
--  un superviseur qui a retire une ligne ne la voit pas revenir a midi.
--
--  CE QU'ELLE NE FAIT PAS. Elle ne classe pas les commerces par distance : il
--  faudrait pour cela savoir d'ou part l'agent, donc le localiser. La
--  constitution l'ecarte, et FR-077 le redit. L'ordre est celui de l'urgence du
--  motif, pas celui d'un itineraire.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.composer_feuille_route(
    p_agent uuid,
    p_date  date DEFAULT current_date,
    p_par   uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $composer$
DECLARE
    v_commune  uuid;
    v_role     text;
    v_actif    boolean;
    v_objectif integer;
    v_feuille  uuid;
BEGIN
    SELECT u.commune_id, u.role::text, u.actif
      INTO v_commune, v_role, v_actif
      FROM app.utilisateur u WHERE u.id = p_agent;

    IF v_commune IS NULL THEN
        RAISE EXCEPTION 'Agent introuvable : %', p_agent;
    END IF;
    IF NOT v_actif THEN
        RAISE EXCEPTION 'Agent inactif : aucune feuille de route';
    END IF;
    IF v_role <> 'agent' THEN
        RAISE EXCEPTION 'Une feuille de route ne se compose que pour un agent (role : %)', v_role;
    END IF;

    -- Deja composee : on rend l'existante. Voir « IDEMPOTENTE » ci-dessus.
    SELECT f.id INTO v_feuille
      FROM app.feuille_route f
     WHERE f.agent_id = p_agent AND f.date_tournee = p_date;
    IF v_feuille IS NOT NULL THEN
        RETURN v_feuille;
    END IF;

    SELECT coalesce(cp.objectif_visites_jour_agent, 0)
      INTO v_objectif
      FROM app.commune_parametre cp WHERE cp.commune_id = v_commune;
    v_objectif := coalesce(v_objectif, 0);

    INSERT INTO app.feuille_route (commune_id, agent_id, date_tournee, objectif, composee_par)
    VALUES (v_commune, p_agent, p_date, v_objectif, p_par)
    RETURNING id INTO v_feuille;

    -- -----------------------------------------------------------------------
    --  Les candidats : les commerces du territoire de l'agent qui ont un motif.
    --
    --  Un agent peut etre affecte a une ZONE ou a un QUARTIER. Les deux formes
    --  coexistent en base ; ne traiter que la seconde donnerait des feuilles
    --  vides a tous les agents actuels, qui sont affectes par zone.
    -- -----------------------------------------------------------------------
    INSERT INTO app.feuille_route_ligne (feuille_id, commerce_id, motif, ordre)
    SELECT v_feuille, c.commerce_id, c.motif,
           row_number() OVER (ORDER BY c.rang, c.derniere_visite_le NULLS FIRST, c.code)
      FROM (
        SELECT co.id AS commerce_id,
               co.code,
               CASE WHEN fc.id IS NOT NULL
                    THEN 'fiche_a_completer'::app.motif_visite
                    ELSE sp.motif_accompagnement END AS motif,
               CASE
                 -- Sans gerant joignable, rien ne part : ni avis, ni relance.
                 -- C'est le blocage qui precede tous les autres.
                 WHEN fc.id IS NOT NULL                             THEN 1
                 WHEN sp.motif_accompagnement = 'jamais_paye'        THEN 2
                 WHEN sp.motif_accompagnement = 'paiement_interrompu' THEN 3
                 WHEN sp.motif_accompagnement = 'paiement_partiel'   THEN 4
                 ELSE 9
               END AS rang,
               (SELECT max(vi.debute_le) FROM app.visite vi
                 WHERE vi.commerce_id = co.id) AS derniere_visite_le
          FROM app.commerce co
          LEFT JOIN app.v_fiche_a_completer fc ON fc.id = co.id
          LEFT JOIN app.v_situation_paiement sp ON sp.commerce_id = co.id
         WHERE co.commune_id = v_commune
           AND co.archive_le IS NULL
           AND EXISTS (
                 SELECT 1 FROM app.affectation_agent aa
                  WHERE aa.utilisateur_id = p_agent
                    AND aa.date_debut <= p_date
                    AND (aa.date_fin IS NULL OR aa.date_fin >= p_date)
                    AND ( (aa.quartier_id IS NOT NULL AND aa.quartier_id = co.quartier_id)
                       OR (aa.quartier_id IS NULL AND aa.zone_id = co.zone_id) ))
      ) c
     WHERE c.motif IS NOT NULL
       -- Deja vu il y a moins de trente jours : on ne harcele pas.
       AND (c.derniere_visite_le IS NULL
            OR c.derniere_visite_le < (p_date - interval '30 days'))
       -- Deja sur la feuille d'un collegue le meme jour : une seule visite.
       AND NOT EXISTS (
             SELECT 1 FROM app.feuille_route_ligne l
               JOIN app.feuille_route f ON f.id = l.feuille_id
              WHERE f.date_tournee = p_date
                AND f.commune_id = v_commune
                AND l.commerce_id = c.commerce_id
                AND l.retiree_le IS NULL)
     ORDER BY c.rang, c.derniere_visite_le NULLS FIRST, c.code
     LIMIT v_objectif;

    RETURN v_feuille;
END
$composer$;

COMMENT ON FUNCTION app.composer_feuille_route IS
    'Compose la feuille de route du jour d''un agent (FR-072). Idempotente. '
    'L''ordre suit l''urgence du motif, jamais un itineraire : localiser '
    'l''agent est ecarte par la constitution et par FR-077.';
