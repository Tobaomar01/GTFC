-- ===========================================================================
--  0005 — Utilisateurs, rôles, sessions
--
--  4 rôles : agent, superviseur, admin_commune, super_admin.
--  Un utilisateur appartient à UNE commune, sauf le super-admin dont le
--  commune_id est NULL — c'est ce NULL qui lui donne la vue transversale.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app.utilisateur (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id          uuid        REFERENCES app.commune(id) ON DELETE RESTRICT,

    matricule           text,                       -- identifiant agent de la mairie
    nom                 text        NOT NULL,
    prenom              text        NOT NULL,
    nom_complet         text        GENERATED ALWAYS AS (prenom || ' ' || nom) STORED,
    nom_normalise       text        GENERATED ALWAYS AS (app.normaliser(prenom || ' ' || nom)) STORED,

    telephone           text        NOT NULL,       -- sert aussi d'identifiant de connexion
    email               text,
    photo_url           text,

    role                app.role_utilisateur NOT NULL,

    -- Authentification. Le mot de passe est haché avec bcrypt côté API :
    -- la base ne voit jamais le mot de passe en clair.
    mot_de_passe_hash   text        NOT NULL,
    mot_de_passe_change_le timestamptz,
    doit_changer_mdp    boolean     NOT NULL DEFAULT true,

    -- Verrouillage après tentatives infructueuses
    tentatives_echouees smallint    NOT NULL DEFAULT 0,
    verrouille_jusqu_a  timestamptz,
    derniere_connexion  timestamptz,
    derniere_ip         inet,

    -- Terrain
    code_pin_hash       text,                       -- déverrouillage rapide de l'app Android
    appareil_id         text,                       -- app liée à un seul téléphone
    appareil_modele     text,
    version_app         text,
    derniere_sync       timestamptz,

    actif               boolean     NOT NULL DEFAULT true,
    date_embauche       date,
    date_fin            date,

    cree_le             timestamptz NOT NULL DEFAULT now(),
    cree_par            uuid        REFERENCES app.utilisateur(id),
    modifie_le          timestamptz NOT NULL DEFAULT now(),
    modifie_par         uuid        REFERENCES app.utilisateur(id),
    archive_le          timestamptz,

    -- Un agent, un superviseur ou un admin appartient forcément à une commune.
    -- Un super-admin, jamais : c'est ce qui le distingue en base.
    CONSTRAINT utilisateur_commune_coherente CHECK (
        (role = 'super_admin' AND commune_id IS NULL) OR
        (role <> 'super_admin' AND commune_id IS NOT NULL)
    ),
    CONSTRAINT utilisateur_telephone_format CHECK (telephone ~ '^\+?[0-9]{8,15}$'),
    CONSTRAINT utilisateur_email_format CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Le téléphone est l'identifiant de connexion : il doit être unique parmi
-- les comptes actifs, mais un ancien agent parti peut garder le sien archivé.
CREATE UNIQUE INDEX IF NOT EXISTS idx_utilisateur_telephone_actif
    ON app.utilisateur (telephone) WHERE archive_le IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_utilisateur_matricule
    ON app.utilisateur (commune_id, matricule) WHERE matricule IS NOT NULL AND archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_utilisateur_commune_role
    ON app.utilisateur (commune_id, role) WHERE archive_le IS NULL AND actif;
CREATE INDEX IF NOT EXISTS idx_utilisateur_nom
    ON app.utilisateur USING GIN (nom_normalise gin_trgm_ops);

COMMENT ON COLUMN app.utilisateur.commune_id IS
'NULL uniquement pour le super_admin — c''est ce qui lui ouvre la vue multi-communes.';
COMMENT ON COLUMN app.utilisateur.appareil_id IS
'Identifiant du téléphone Android. Une connexion depuis un autre appareil déclenche une alerte dans le journal d''audit.';

-- ---------------------------------------------------------------------------
-- Affectation des agents aux zones
-- Un agent peut couvrir plusieurs zones ; une zone peut être couverte par
-- plusieurs agents. Un agent sans affectation couvre toute la commune.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.affectation_agent (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id uuid        NOT NULL REFERENCES app.utilisateur(id) ON DELETE CASCADE,
    zone_id        uuid        NOT NULL REFERENCES app.zone(id)        ON DELETE CASCADE,
    quartier_id    uuid        REFERENCES app.quartier(id)             ON DELETE CASCADE,
    date_debut     date        NOT NULL DEFAULT current_date,
    date_fin       date,
    principal      boolean     NOT NULL DEFAULT true,
    cree_le        timestamptz NOT NULL DEFAULT now(),
    cree_par       uuid        REFERENCES app.utilisateur(id),

    CONSTRAINT affectation_dates CHECK (date_fin IS NULL OR date_fin >= date_debut)
);

CREATE INDEX IF NOT EXISTS idx_affectation_utilisateur ON app.affectation_agent (utilisateur_id)
    WHERE date_fin IS NULL;
CREATE INDEX IF NOT EXISTS idx_affectation_zone        ON app.affectation_agent (zone_id)
    WHERE date_fin IS NULL;

-- ---------------------------------------------------------------------------
-- Sessions (jetons de rafraîchissement)
--
-- Seule l'EMPREINTE du jeton est stockée. Si la base fuite, les jetons
-- volés restent inutilisables — c'est le même raisonnement que pour les
-- mots de passe.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.session (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id      uuid        NOT NULL REFERENCES app.utilisateur(id) ON DELETE CASCADE,
    jeton_hash          text        NOT NULL UNIQUE,
    appareil_id         text,
    appareil_modele     text,
    ip                  inet,
    user_agent          text,
    cree_le             timestamptz NOT NULL DEFAULT now(),
    expire_le           timestamptz NOT NULL,
    derniere_activite   timestamptz NOT NULL DEFAULT now(),
    revoque_le          timestamptz,
    motif_revocation    text
);

CREATE INDEX IF NOT EXISTS idx_session_utilisateur ON app.session (utilisateur_id)
    WHERE revoque_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_expiration  ON app.session (expire_le)
    WHERE revoque_le IS NULL;

COMMENT ON COLUMN app.session.jeton_hash IS
'SHA-256 du jeton de rafraîchissement. Le jeton en clair n''existe que côté client.';

-- ---------------------------------------------------------------------------
-- Purge des sessions expirées — appelée par le planificateur (phase 5)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.purger_sessions_expirees()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE nb integer;
BEGIN
    DELETE FROM app.session
    WHERE expire_le < now() - interval '30 days'
       OR (revoque_le IS NOT NULL AND revoque_le < now() - interval '90 days');
    GET DIAGNOSTICS nb = ROW_COUNT;
    RETURN nb;
END;
$$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['utilisateur'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_modifie_le ON app.%1$s;
             CREATE TRIGGER trg_%1$s_modifie_le BEFORE UPDATE ON app.%1$s
             FOR EACH ROW EXECUTE FUNCTION app.trg_maj_modifie_le();', t);
    END LOOP;
END
$$;
