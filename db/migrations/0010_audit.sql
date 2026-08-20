-- ===========================================================================
--  0010 — Journal d'audit anti-fraude
--
--  Exigence du cahier des charges : « Aucune modification possible sans
--  laisser de trace ». Elle est tenue par la BASE, pas par le code applicatif :
--    1. le rôle gtfc_app n'a que SELECT et INSERT sur le schéma audit
--       (migration 0002 de la phase 1, init/02-app-role.sh) ;
--    2. des déclencheurs BEFORE UPDATE/DELETE rejettent toute tentative,
--       y compris si quelqu'un se connecte en superutilisateur par erreur ;
--    3. la table est partitionnée par mois — on peut archiver un mois entier
--       sans jamais toucher aux lignes.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS audit.journal (
    id                bigserial   NOT NULL,
    commune_id        uuid,                       -- NULL pour une action super-admin globale

    -- Qui
    utilisateur_id    uuid,
    utilisateur_nom   text,                       -- copié : reste lisible même si le compte est archivé
    utilisateur_role  app.role_utilisateur,
    ip                inet,
    user_agent        text,
    appareil_id       text,

    -- Quoi
    action            audit.action_audit NOT NULL,
    entite            text        NOT NULL,       -- nom de la table concernée
    entite_id         uuid,
    entite_libelle    text,                       -- « Boutique Ndiaye — GTFC-Z1-00042 »

    -- Détail du changement : uniquement les champs réellement modifiés,
    -- pour que le journal reste lisible et raisonnable en volume.
    valeurs_avant     jsonb,
    valeurs_apres     jsonb,
    champs_modifies   text[],

    -- Où et quand
    geom              geometry(Point, 4326),
    horodatage        timestamptz NOT NULL DEFAULT now(),

    -- Contexte métier
    montant           numeric(14,0),              -- renseigné pour les actions de paiement
    reference         text,                       -- n° de transaction Wave, n° de quittance
    motif             text,
    commentaire       text,

    PRIMARY KEY (id, horodatage)
) PARTITION BY RANGE (horodatage);

COMMENT ON TABLE audit.journal IS
'Journal inaltérable. Aucune mise à jour ni suppression n''est possible, y compris par le propriétaire des tables.';
COMMENT ON COLUMN audit.journal.utilisateur_nom IS
'Nom recopié au moment de l''action : le journal reste lisible même si le compte agent est archivé plus tard.';

CREATE INDEX IF NOT EXISTS idx_audit_commune     ON audit.journal (commune_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS idx_audit_utilisateur ON audit.journal (utilisateur_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entite      ON audit.journal (entite, entite_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit.journal (action, horodatage DESC);
CREATE INDEX IF NOT EXISTS idx_audit_geom        ON audit.journal USING GIST (geom);

-- ---------------------------------------------------------------------------
-- Partitions mensuelles
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.creer_partitions_journal(nb_mois_avant integer DEFAULT 1,
                                                           nb_mois_apres integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    i integer; debut date; fin date; nom text; creees integer := 0;
BEGIN
    FOR i IN -nb_mois_avant..nb_mois_apres LOOP
        debut := date_trunc('month', current_date + (i || ' months')::interval)::date;
        fin   := (debut + interval '1 month')::date;
        nom   := format('journal_%s', to_char(debut, 'YYYY_MM'));

        IF NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'audit' AND c.relname = nom
        ) THEN
            EXECUTE format(
                'CREATE TABLE audit.%I PARTITION OF audit.journal
                 FOR VALUES FROM (%L) TO (%L);', nom, debut, fin);
            creees := creees + 1;
        END IF;
    END LOOP;
    RETURN creees;
END;
$$;

SELECT audit.creer_partitions_journal(2, 6);

-- ---------------------------------------------------------------------------
-- Inaltérabilité : refus catégorique des UPDATE et DELETE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.trg_refuser_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Le journal d''audit est inaltérable : % interdit sur %.%',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Pour corriger une information erronée, ajoutez une nouvelle entrée au journal.';
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_inalterable ON audit.journal;
CREATE TRIGGER trg_journal_inalterable
    BEFORE UPDATE OR DELETE ON audit.journal
    FOR EACH STATEMENT EXECUTE FUNCTION audit.trg_refuser_modification();

-- ---------------------------------------------------------------------------
-- Journal des connexions (séparé : volumétrie et durée de conservation
-- différentes du journal métier)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.connexion (
    id                bigserial   PRIMARY KEY,
    commune_id        uuid,
    utilisateur_id    uuid,
    telephone_saisi   text,                    -- conservé même en cas d'échec
    reussie           boolean     NOT NULL,
    motif_echec       text,                    -- mdp_invalide | compte_verrouille | compte_inactif

    ip                inet,
    user_agent        text,
    appareil_id       text,
    appareil_modele   text,
    version_app       text,
    geom              geometry(Point, 4326),

    -- Un agent qui se connecte depuis un téléphone inhabituel mérite un
    -- coup d'œil : le drapeau est posé ici, l'alerte est faite au dashboard.
    appareil_inhabituel boolean   NOT NULL DEFAULT false,

    horodatage        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connexion_utilisateur ON audit.connexion (utilisateur_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS idx_connexion_echecs      ON audit.connexion (ip, horodatage DESC) WHERE NOT reussie;
CREATE INDEX IF NOT EXISTS idx_connexion_inhabituel  ON audit.connexion (commune_id, horodatage DESC)
    WHERE appareil_inhabituel;

DROP TRIGGER IF EXISTS trg_connexion_inalterable ON audit.connexion;
CREATE TRIGGER trg_connexion_inalterable
    BEFORE UPDATE OR DELETE ON audit.connexion
    FOR EACH STATEMENT EXECUTE FUNCTION audit.trg_refuser_modification();

-- ---------------------------------------------------------------------------
-- Exports de données (RGPD-like : savoir qui a extrait quoi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.export (
    id                bigserial   PRIMARY KEY,
    commune_id        uuid        NOT NULL,
    utilisateur_id    uuid        NOT NULL,
    format            text        NOT NULL,        -- excel | pdf | csv
    entite            text        NOT NULL,
    filtres           jsonb,
    nb_lignes         integer,
    ip                inet,
    horodatage        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT export_format CHECK (format IN ('excel','pdf','csv','json'))
);

CREATE INDEX IF NOT EXISTS idx_export_commune ON audit.export (commune_id, horodatage DESC);

DROP TRIGGER IF EXISTS trg_export_inalterable ON audit.export;
CREATE TRIGGER trg_export_inalterable
    BEFORE UPDATE OR DELETE ON audit.export
    FOR EACH STATEMENT EXECUTE FUNCTION audit.trg_refuser_modification();

-- ---------------------------------------------------------------------------
-- Droits : ajout seulement pour l'application
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA audit TO gtfc_app';
        EXECUTE 'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO gtfc_app';
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA audit FROM gtfc_app';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO gtfc_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_readonly') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA audit TO gtfc_readonly';
        EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA audit TO gtfc_readonly';
    END IF;
END
$$;
