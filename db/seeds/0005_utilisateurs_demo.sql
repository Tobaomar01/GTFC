-- ===========================================================================
--  SEED 0005 — Comptes de démonstration
--
--  ##########################################################################
--  ###  COMPTES DE TEST — MOTS DE PASSE CONNUS                            ###
--  ###                                                                    ###
--  ###  Mot de passe unique pour tous : GtfcDemo2026!                     ###
--  ###                                                                    ###
--  ###  Tous les comptes ont doit_changer_mdp = true : l'API imposera le  ###
--  ###  changement à la première connexion (phase 3).                     ###
--  ###                                                                    ###
--  ###  AVANT LA MISE EN PRODUCTION :                                     ###
--  ###    UPDATE app.utilisateur SET actif = false, archive_le = now()    ###
--  ###     WHERE matricule LIKE 'DEMO-%';                                 ###
--  ###  puis créez les vrais comptes depuis le dashboard.                 ###
--  ##########################################################################
--
--  Le hachage est calculé par pgcrypto (bcrypt, coût 12) directement en base :
--  aucun mot de passe en clair n'est jamais stocké, même en démonstration.
--  Le format produit est compatible avec la bibliothèque bcrypt de Node.js.
-- ===========================================================================

DO $$
DECLARE
    v_commune_id uuid;
    v_hash       text;
    v_agent_id   uuid;
    v_zone       record;
    i            integer;
BEGIN

SELECT id INTO v_commune_id FROM app.commune WHERE code = 'GTFC';
IF v_commune_id IS NULL THEN
    RAISE EXCEPTION 'Commune GTFC absente — lancez d''abord le seed 0002.';
END IF;

v_hash := crypt('GtfcDemo2026!', gen_salt('bf', 12));

-- ---------------------------------------------------------------------------
-- Super-admin (exploitant de la plateforme) — commune_id NULL par construction
-- ---------------------------------------------------------------------------
INSERT INTO app.utilisateur (
    commune_id, matricule, nom, prenom, telephone, email,
    role, mot_de_passe_hash, doit_changer_mdp, actif
) VALUES (
    NULL, 'DEMO-SA01', 'À_REMPLACER', 'Super-admin', '+221700000001',
    'superadmin@example.sn', 'super_admin', v_hash, true, true
)
ON CONFLICT (telephone) WHERE archive_le IS NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- Administrateur de la commune (mairie)
-- ---------------------------------------------------------------------------
INSERT INTO app.utilisateur (
    commune_id, matricule, nom, prenom, telephone, email,
    role, mot_de_passe_hash, doit_changer_mdp, actif
) VALUES (
    v_commune_id, 'DEMO-AD01', 'À_REMPLACER', 'Admin Mairie', '+221700000002',
    'admin@example.sn', 'admin_commune', v_hash, true, true
)
ON CONFLICT (telephone) WHERE archive_le IS NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- Superviseur
-- ---------------------------------------------------------------------------
INSERT INTO app.utilisateur (
    commune_id, matricule, nom, prenom, telephone, email,
    role, mot_de_passe_hash, doit_changer_mdp, actif, date_embauche
) VALUES (
    v_commune_id, 'DEMO-SU01', 'À_REMPLACER', 'Superviseur', '+221700000003',
    'superviseur@example.sn', 'superviseur', v_hash, true, true, current_date
)
ON CONFLICT (telephone) WHERE archive_le IS NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3 agents de terrain — un par zone, comme prévu pour la phase pilote
-- ---------------------------------------------------------------------------
i := 0;
FOR v_zone IN
    SELECT id, code, ordre FROM app.zone
     WHERE commune_id = v_commune_id ORDER BY ordre
LOOP
    i := i + 1;

    INSERT INTO app.utilisateur (
        commune_id, matricule, nom, prenom, telephone,
        role, mot_de_passe_hash, doit_changer_mdp, actif, date_embauche
    ) VALUES (
        v_commune_id,
        format('DEMO-AG%s', lpad(i::text, 2, '0')),
        'À_REMPLACER',
        format('Agent %s', i),
        format('+22170000001%s', i),
        'agent', v_hash, true, true, current_date
    )
    ON CONFLICT (telephone) WHERE archive_le IS NULL DO NOTHING;

    SELECT id INTO v_agent_id FROM app.utilisateur
     WHERE telephone = format('+22170000001%s', i) AND archive_le IS NULL;

    -- Affectation de l'agent à sa zone
    IF v_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM app.affectation_agent a
         WHERE a.utilisateur_id = v_agent_id AND a.zone_id = v_zone.id AND a.date_fin IS NULL
    ) THEN
        INSERT INTO app.affectation_agent (utilisateur_id, zone_id, principal)
        VALUES (v_agent_id, v_zone.id, true);
    END IF;
END LOOP;

RAISE NOTICE '[seed 0005] % comptes de démonstration (mot de passe : GtfcDemo2026!)',
    (SELECT count(*) FROM app.utilisateur WHERE matricule LIKE 'DEMO-%');

END
$$;
