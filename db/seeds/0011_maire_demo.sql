-- ===========================================================================
--  SEED 0011 — Compte de démonstration : le maire
--
--  Deux organisations travaillent sur ce dispositif :
--
--    · l'EXPLOITANT, dont le chef de projet détient les décisions
--      dérogatoires — montant forcé, exonération ;
--    · la MUNICIPALITÉ, dont le maire constate la recette qui lui revient.
--
--  Le maire consulte, et rien d'autre. Il ne recense pas, n'encaisse pas, ne
--  remet pas de dette, et ne touche pas au barème — celui-ci relève d'une
--  délibération du conseil municipal, pas d'un écran. La restriction est
--  posée dans l'API, à l'intérieur même de l'authentification.
--
--  Mot de passe : GtfcDemo2026!, comme les autres comptes de démonstration.
--  Voir l'avertissement de mise en production dans le seed 0005.
-- ===========================================================================
DO $$
DECLARE
    v_commune_id uuid;
    v_hash       text;
BEGIN
    SELECT id INTO v_commune_id FROM app.commune WHERE code = 'GTFC';
    IF v_commune_id IS NULL THEN
        RAISE NOTICE '[seed 0011] commune GTFC absente — compte non créé';
        RETURN;
    END IF;

    v_hash := crypt('GtfcDemo2026!', gen_salt('bf', 12));

    INSERT INTO app.utilisateur (
        commune_id, matricule, nom, prenom, telephone, email,
        role, mot_de_passe_hash, doit_changer_mdp, actif
    ) VALUES (
        v_commune_id, 'DEMO-MR01', 'À_REMPLACER', 'Maire',
        '+221700000005', 'maire@example.sn',
        'maire', v_hash, true, true
    )
    ON CONFLICT (telephone) WHERE archive_le IS NULL DO NOTHING;

    RAISE NOTICE '[seed 0011] maire : +221700000005 (GtfcDemo2026!)';
END $$;
