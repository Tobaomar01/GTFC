-- ===========================================================================
--  0029 — Portail du redevable : code à usage unique et session
--
--  Le redevable consulte son dossier depuis un navigateur, sur téléphone
--  comme sur ordinateur. Rien à installer.
--
--  CE QUI EST STOCKÉ, ET CE QUI NE L'EST PAS
--
--  Le code à six chiffres n'est JAMAIS conservé en clair. Seule une empreinte
--  salée l'est. Une lecture de la base — sauvegarde égarée, accès d'un
--  administrateur, incident — ne permet donc pas de se connecter au nom d'un
--  redevable. La même règle vaut pour le jeton de session.
--
--  POURQUOI CES VALEURS
--
--  Six chiffres, cinq minutes, trois tentatives, cinq demandes par heure.
--  Les téléphones sont fréquemment prêtés ou partagés au Sénégal : une
--  session permanente sur un appareil partagé revient à publier le dossier
--  fiscal de son propriétaire. D'où une session de quelques heures, jamais
--  reconduite silencieusement.
--
--  LE QR CODE N'OUVRE RIEN
--  Il est apposé sur la devanture, physiquement accessible à tout passant.
--  Le redevable accède à son dossier par ce portail authentifié, pas en
--  scannant son propre autocollant.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Codes à usage unique
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.code_acces (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)   ON DELETE RESTRICT,
    -- NULL pendant la vérification d'un numéro tout juste saisi par l'agent :
    -- le redevable peut ne pas encore exister en base au moment de l'envoi.
    redevable_id    uuid        REFERENCES app.redevable(id)          ON DELETE CASCADE,
    telephone       text        NOT NULL,

    -- Empreinte SHA-256 de (code || sel). Le code lui-même n'existe que dans
    -- le SMS et dans la tête du redevable.
    code_empreinte  text        NOT NULL,
    sel             text        NOT NULL,

    usage           text        NOT NULL DEFAULT 'connexion',
    -- connexion            : ouverture de session sur le portail
    -- verification_terrain : confirmation du numéro pendant le recensement

    expire_le       timestamptz NOT NULL,
    tentatives      smallint    NOT NULL DEFAULT 0,
    max_tentatives  smallint    NOT NULL DEFAULT 3,
    consomme_le     timestamptz,

    -- Conservés pour détecter un balayage de numéros, pas pour profiler.
    ip_demande      inet,
    ip_consommation inet,

    -- Trace de l'agent qui a déclenché l'envoi sur le terrain.
    demande_par     uuid        REFERENCES app.utilisateur(id),

    cree_le         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT code_usage_connu CHECK (usage IN ('connexion', 'verification_terrain')),
    CONSTRAINT code_tel_format CHECK (telephone ~ '^\+?[0-9]{8,15}$'),
    CONSTRAINT code_tentatives_bornees CHECK (tentatives >= 0 AND tentatives <= max_tentatives),
    CONSTRAINT code_expiration_future CHECK (expire_le > cree_le)
);

COMMENT ON TABLE app.code_acces IS
'Codes à usage unique envoyés par SMS. Le code n''est jamais stocké en clair : seule une empreinte salée l''est.';
COMMENT ON COLUMN app.code_acces.redevable_id IS
'NULL pendant la vérification d''un numéro saisi sur le terrain : le redevable n''existe pas encore au moment de l''envoi.';

CREATE INDEX IF NOT EXISTS idx_code_acces_tel     ON app.code_acces (commune_id, telephone, cree_le DESC);
CREATE INDEX IF NOT EXISTS idx_code_acces_actif   ON app.code_acces (telephone, expire_le)
    WHERE consomme_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_code_acces_purge   ON app.code_acces (expire_le);

-- ---------------------------------------------------------------------------
-- Sessions du portail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.session_redevable (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)   ON DELETE RESTRICT,
    redevable_id    uuid        NOT NULL REFERENCES app.redevable(id) ON DELETE CASCADE,

    -- Comme pour les codes : seule l'empreinte du jeton est conservée.
    jeton_empreinte text        NOT NULL UNIQUE,

    cree_le         timestamptz NOT NULL DEFAULT now(),
    expire_le       timestamptz NOT NULL,
    derniere_activite_le timestamptz NOT NULL DEFAULT now(),
    revoque_le      timestamptz,
    motif_revocation text,

    ip              inet,
    agent_navigateur text,

    CONSTRAINT session_redevable_duree CHECK (expire_le > cree_le)
);

COMMENT ON TABLE app.session_redevable IS
'Sessions du portail redevable. Durée volontairement courte : les téléphones sont souvent prêtés ou partagés.';

CREATE INDEX IF NOT EXISTS idx_session_redevable_actif
    ON app.session_redevable (redevable_id, expire_le) WHERE revoque_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_redevable_purge ON app.session_redevable (expire_le);

-- ---------------------------------------------------------------------------
-- Limitation du débit : cinq demandes par heure et par numéro
--
--  Sans plafond, l'envoi de SMS devient un moyen de harceler un numéro à
--  moindre frais, et une facture pour la commune.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.code_acces_autorise(
    p_commune   uuid,
    p_telephone text,
    p_max_heure smallint DEFAULT 5
)
RETURNS TABLE (autorise boolean, demandes_recentes integer, prochaine_possible timestamptz)
LANGUAGE sql
STABLE
AS $$
    WITH recents AS (
        SELECT cree_le FROM app.code_acces
         WHERE commune_id = p_commune
           AND telephone  = p_telephone
           AND cree_le > now() - interval '1 hour'
         ORDER BY cree_le
    )
    SELECT (count(*) < p_max_heure),
           count(*)::integer,
           CASE WHEN count(*) < p_max_heure THEN NULL
                ELSE (SELECT min(cree_le) FROM recents) + interval '1 hour' END
      FROM recents;
$$;

COMMENT ON FUNCTION app.code_acces_autorise IS
'Plafond de demandes de code par numéro et par heure. Retourne aussi l''instant du prochain envoi possible, pour l''afficher au redevable plutôt qu''un refus sec.';

-- ---------------------------------------------------------------------------
-- Purge : un code expiré n'a plus aucune utilité
--
--  Les conserver ne servirait qu'à grossir une table contenant des numéros
--  de téléphone. On garde 30 jours pour l'analyse d'incident, pas au-delà.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.purger_acces_expires(p_retention_jours integer DEFAULT 30)
RETURNS TABLE (codes_purges integer, sessions_purgees integer)
LANGUAGE plpgsql
AS $$
DECLARE v_codes integer; v_sessions integer;
BEGIN
    DELETE FROM app.code_acces
     WHERE expire_le < now() - make_interval(days => p_retention_jours);
    GET DIAGNOSTICS v_codes = ROW_COUNT;

    DELETE FROM app.session_redevable
     WHERE expire_le < now() - make_interval(days => p_retention_jours);
    GET DIAGNOSTICS v_sessions = ROW_COUNT;

    RETURN QUERY SELECT v_codes, v_sessions;
END;
$$;

-- ---------------------------------------------------------------------------
-- Paramètres du portail, réglables par commune
-- ---------------------------------------------------------------------------
ALTER TABLE app.commune_parametre
    ADD COLUMN IF NOT EXISTS otp_longueur          smallint    NOT NULL DEFAULT 6,
    ADD COLUMN IF NOT EXISTS otp_validite_minutes  smallint    NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS otp_max_tentatives    smallint    NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS otp_max_par_heure     smallint    NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS session_portail_heures smallint   NOT NULL DEFAULT 4,
    ADD COLUMN IF NOT EXISTS contestation_delai_jours smallint NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS portail_actif         boolean     NOT NULL DEFAULT true;

-- Les bornes sont dans la base et pas seulement dans le code applicatif :
-- un paramètre se modifie aussi par une requête, un soir de mise en service.
ALTER TABLE app.commune_parametre
    DROP CONSTRAINT IF EXISTS parametre_otp_raisonnable;
ALTER TABLE app.commune_parametre
    ADD CONSTRAINT parametre_otp_raisonnable CHECK (
        otp_longueur BETWEEN 4 AND 8
        AND otp_validite_minutes BETWEEN 1 AND 30
        AND otp_max_tentatives BETWEEN 1 AND 5
        AND otp_max_par_heure BETWEEN 1 AND 20
        AND session_portail_heures BETWEEN 1 AND 24
    );

COMMENT ON COLUMN app.commune_parametre.session_portail_heures IS
'Durée d''une session du portail. Plafonnée à 24 h par contrainte : une session permanente sur un téléphone partagé publierait le dossier fiscal de son propriétaire.';

-- ---------------------------------------------------------------------------
-- Le changement de numéro passe obligatoirement par un agent
--
--  Autoriser la modification en libre-service depuis le portail ouvrirait un
--  détournement de compte trivial : il suffirait d'un accès de quelques
--  minutes au téléphone pour rediriger définitivement le dossier.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.changement_telephone (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)   ON DELETE RESTRICT,
    redevable_id    uuid        NOT NULL REFERENCES app.redevable(id) ON DELETE CASCADE,
    ancien_telephone text,
    nouveau_telephone text      NOT NULL,
    motif           text        NOT NULL,
    -- Toujours renseigné : c'est tout l'objet de la table.
    effectue_par    uuid        NOT NULL REFERENCES app.utilisateur(id),
    verifie_par_code boolean    NOT NULL DEFAULT false,
    cree_le         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT changement_tel_format CHECK (nouveau_telephone ~ '^\+?[0-9]{8,15}$'),
    CONSTRAINT changement_tel_different CHECK (
        ancien_telephone IS NULL OR ancien_telephone <> nouveau_telephone
    )
);

CREATE INDEX IF NOT EXISTS idx_changement_tel_redevable
    ON app.changement_telephone (redevable_id, cree_le DESC);

COMMENT ON TABLE app.changement_telephone IS
'Historique des changements de numéro. Toujours à l''initiative d''un agent, jamais du portail : le numéro est l''identifiant, le modifier en libre-service serait un vecteur de détournement de compte.';
