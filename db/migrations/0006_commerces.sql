-- ===========================================================================
--  0006 — Commerces, photos, QR codes
--
--  Table centrale de la plateforme : ~5 443 lignes attendues pour GTFC.
--  Aucune suppression physique n'est jamais faite : on renseigne archive_le.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app.commerce (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id          uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE RESTRICT,
    zone_id             uuid        NOT NULL REFERENCES app.zone(id)     ON DELETE RESTRICT,
    quartier_id         uuid        NOT NULL REFERENCES app.quartier(id) ON DELETE RESTRICT,
    categorie_id        uuid        NOT NULL REFERENCES ref.categorie_commerce(id) ON DELETE RESTRICT,

    -- Code lisible imprimé sur le sticker : GTFC-Z1-00042
    -- Généré par app.generer_code_commerce() (migration 0012).
    code                text        NOT NULL,
    numero_sequence     integer     NOT NULL,

    -- Identité du commerce
    enseigne            text        NOT NULL,
    enseigne_normalisee text        GENERATED ALWAYS AS (app.normaliser(enseigne)) STORED,
    activite_precise    text,

    -- Gérant
    gerant_nom          text,
    gerant_prenom       text,
    gerant_telephone    text,
    gerant_piece_type   text,          -- CNI, passeport
    gerant_piece_numero text,

    -- Numéro appelé lors du paiement Wave.
    -- C'est LA SEULE donnée personnelle transmise à Wave, avec le montant.
    telephone_paiement  text,

    -- Identifiants administratifs existants
    ninea               text,
    numero_patente      text,
    numero_registre_communal text,

    -- Localisation
    adresse_libelle     text,
    point_repere        text,          -- « en face de la pharmacie », utile sans plaque de rue
    geom                geometry(Point, 4326),
    precision_gps_m     numeric(6,2),
    quartier_detecte_auto boolean     NOT NULL DEFAULT false,

    -- Surfaces et paramètres de taxation
    surface_locale_m2   numeric(8,2),
    todp_surface_m2     numeric(8,2),  -- débordement mesuré sur le trottoir
    enseigne_surface_m2 numeric(8,2),
    enseigne_lumineuse  boolean        NOT NULL DEFAULT false,

    -- Marché (droit de place)
    marche_id           uuid        REFERENCES app.marche(id)           ON DELETE SET NULL,
    type_emplacement_id uuid        REFERENCES ref.type_emplacement(id) ON DELETE SET NULL,
    numero_emplacement  text,

    -- États
    statut              app.statut_commerce NOT NULL DEFAULT 'actif',
    statut_fiscal       app.statut_fiscal   NOT NULL DEFAULT 'inconnu',
    statut_fiscal_calcule_le timestamptz,
    solde_du            numeric(14,0) NOT NULL DEFAULT 0,

    -- Traçabilité terrain
    date_recensement    date        NOT NULL DEFAULT current_date,
    agent_recenseur_id  uuid        REFERENCES app.utilisateur(id),
    derniere_visite_le  timestamptz,
    derniere_visite_par uuid        REFERENCES app.utilisateur(id),
    nb_visites          integer     NOT NULL DEFAULT 0,

    notes               text,

    -- Compteur incrémenté à chaque modification. L'app Android l'envoie lors
    -- de la synchronisation : si la valeur a changé côté serveur entre-temps,
    -- c'est un conflit et non un écrasement silencieux.
    version             integer     NOT NULL DEFAULT 1,

    origine             text        NOT NULL DEFAULT 'terrain',   -- terrain | import | dashboard

    cree_le             timestamptz NOT NULL DEFAULT now(),
    cree_par            uuid        REFERENCES app.utilisateur(id),
    modifie_le          timestamptz NOT NULL DEFAULT now(),
    modifie_par         uuid        REFERENCES app.utilisateur(id),
    archive_le          timestamptz,
    archive_par         uuid        REFERENCES app.utilisateur(id),
    motif_archivage     text,

    CONSTRAINT commerce_code_unique_par_commune UNIQUE (commune_id, code),
    CONSTRAINT commerce_surfaces_positives CHECK (
        coalesce(surface_locale_m2, 0)   >= 0 AND
        coalesce(todp_surface_m2, 0)     >= 0 AND
        coalesce(enseigne_surface_m2, 0) >= 0
    ),
    CONSTRAINT commerce_solde_positif CHECK (solde_du >= 0),
    CONSTRAINT commerce_tel_paiement_format CHECK (
        telephone_paiement IS NULL OR telephone_paiement ~ '^\+?[0-9]{8,15}$'
    ),
    CONSTRAINT commerce_tel_gerant_format CHECK (
        gerant_telephone IS NULL OR gerant_telephone ~ '^\+?[0-9]{8,15}$'
    ),
    -- Un emplacement de marché n'a de sens que rattaché à un marché
    CONSTRAINT commerce_emplacement_coherent CHECK (
        numero_emplacement IS NULL OR marche_id IS NOT NULL
    ),
    CONSTRAINT commerce_archivage_coherent CHECK (
        (archive_le IS NULL) OR (archive_le IS NOT NULL AND motif_archivage IS NOT NULL)
    ),
    CONSTRAINT commerce_origine CHECK (origine IN ('terrain','import','dashboard'))
);

COMMENT ON TABLE  app.commerce IS 'Registre communal des commerces. Jamais de suppression physique : archive_le.';
COMMENT ON COLUMN app.commerce.telephone_paiement IS
'Seule donnée nominative transmise à Wave, avec le montant. Aucune information fiscale ne sort du serveur.';
COMMENT ON COLUMN app.commerce.version IS
'Incrémenté à chaque modification. Base de la détection de conflit lors de la synchronisation hors-ligne.';
COMMENT ON COLUMN app.commerce.statut_fiscal IS
'Couleur du marqueur sur la carte : a_jour=vert, partiel=orange, impaye=rouge, exonere=gris.';
COMMENT ON COLUMN app.commerce.quartier_detecte_auto IS
'true = quartier déduit du GPS par PostGIS ; false = choisi manuellement par l''agent.';

CREATE INDEX IF NOT EXISTS idx_commerce_commune       ON app.commerce (commune_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_quartier      ON app.commerce (commune_id, quartier_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_zone          ON app.commerce (commune_id, zone_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_categorie     ON app.commerce (categorie_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_statut_fiscal ON app.commerce (commune_id, statut_fiscal) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_geom          ON app.commerce USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_commerce_enseigne      ON app.commerce USING GIN (enseigne_normalisee gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_commerce_marche        ON app.commerce (marche_id) WHERE marche_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_agent         ON app.commerce (agent_recenseur_id, date_recensement);
CREATE INDEX IF NOT EXISTS idx_commerce_ninea         ON app.commerce (ninea) WHERE ninea IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_todp          ON app.commerce (commune_id)
    WHERE todp_surface_m2 IS NOT NULL AND todp_surface_m2 > 0 AND archive_le IS NULL;

-- ---------------------------------------------------------------------------
-- Photos (stockées dans MinIO, référencées ici)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.commerce_photo (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE RESTRICT,
    commerce_id     uuid        NOT NULL REFERENCES app.commerce(id) ON DELETE RESTRICT,
    type            app.type_photo NOT NULL,

    bucket          text        NOT NULL,
    chemin          text        NOT NULL,      -- commune/annee/mois/commerce/uuid.jpg
    type_mime       text        NOT NULL DEFAULT 'image/jpeg',
    taille_octets   integer,
    largeur_px      integer,
    hauteur_px      integer,

    -- Empreinte du fichier : détecte un doublon (même photo réutilisée pour
    -- deux commerces différents, cas de fraude classique) et prouve qu'un
    -- fichier n'a pas été substitué dans MinIO.
    sha256          text        NOT NULL,

    -- Métadonnées de prise de vue, horodatées par le téléphone
    prise_le        timestamptz NOT NULL,
    geom            geometry(Point, 4326),
    precision_gps_m numeric(6,2),
    agent_id        uuid        REFERENCES app.utilisateur(id),

    commentaire     text,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    archive_le      timestamptz,

    CONSTRAINT photo_chemin_unique UNIQUE (bucket, chemin),
    CONSTRAINT photo_taille CHECK (taille_octets IS NULL OR taille_octets BETWEEN 1 AND 26214400),
    CONSTRAINT photo_sha256_format CHECK (sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_photo_commerce ON app.commerce_photo (commerce_id, type) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_photo_sha256   ON app.commerce_photo (sha256);
CREATE INDEX IF NOT EXISTS idx_photo_agent    ON app.commerce_photo (agent_id, prise_le);
CREATE INDEX IF NOT EXISTS idx_photo_commune  ON app.commerce_photo (commune_id, prise_le DESC);

COMMENT ON COLUMN app.commerce_photo.sha256 IS
'Empreinte du fichier. Deux commerces partageant la même empreinte signalent une photo recyclée.';

-- ---------------------------------------------------------------------------
-- QR codes
--
-- Un seul QR actif par commerce à la fois. Un sticker abîmé ou décollé est
-- remplacé : l'ancien est désactivé mais conservé, pour qu'un scan d'un vieux
-- sticker soit identifié comme périmé plutôt que comme inconnu.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.qr_code (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE RESTRICT,
    commerce_id     uuid        NOT NULL REFERENCES app.commerce(id) ON DELETE RESTRICT,

    -- Jeton unique encodé dans le QR. Aléatoire, non devinable : connaître
    -- le code d'un commerce ne permet pas de deviner celui du voisin.
    jeton           text        NOT NULL UNIQUE,
    url             text        NOT NULL,
    version         smallint    NOT NULL DEFAULT 1,

    -- Image PNG dans MinIO
    bucket          text,
    chemin_png      text,
    chemin_sticker_a6 text,

    actif           boolean     NOT NULL DEFAULT true,
    genere_le       timestamptz NOT NULL DEFAULT now(),
    genere_par      uuid        REFERENCES app.utilisateur(id),
    imprime_le      timestamptz,
    pose_le         timestamptz,
    pose_par        uuid        REFERENCES app.utilisateur(id),
    desactive_le    timestamptz,
    motif_desactivation text,
    remplace_par_id uuid        REFERENCES app.qr_code(id),

    nb_scans        integer     NOT NULL DEFAULT 0,
    dernier_scan_le timestamptz,

    CONSTRAINT qr_jeton_format CHECK (jeton ~ '^[A-Z0-9]{10,32}$'),
    CONSTRAINT qr_desactivation_coherente CHECK (
        (actif = true  AND desactive_le IS NULL) OR
        (actif = false AND desactive_le IS NOT NULL)
    )
);

-- Un seul QR code actif par commerce
CREATE UNIQUE INDEX IF NOT EXISTS idx_qr_actif_unique_par_commerce
    ON app.qr_code (commerce_id) WHERE actif;
CREATE INDEX IF NOT EXISTS idx_qr_commune ON app.qr_code (commune_id);

COMMENT ON COLUMN app.qr_code.jeton IS
'Jeton aléatoire encodé dans le QR. Ne dérive pas du code commerce : impossible de deviner celui du voisin.';

-- ---------------------------------------------------------------------------
-- Journal des scans de QR codes
-- Sert à la fois de statistique d'usage et de preuve de passage de l'agent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.qr_scan (
    id              bigserial   PRIMARY KEY,
    commune_id      uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    qr_code_id      uuid        NOT NULL REFERENCES app.qr_code(id) ON DELETE CASCADE,
    commerce_id     uuid        NOT NULL REFERENCES app.commerce(id) ON DELETE CASCADE,
    utilisateur_id  uuid        REFERENCES app.utilisateur(id),      -- NULL = scan public
    scanne_le       timestamptz NOT NULL DEFAULT now(),
    geom            geometry(Point, 4326),
    ip              inet,
    user_agent      text,
    source          text        NOT NULL DEFAULT 'app'              -- app | navigateur
);

CREATE INDEX IF NOT EXISTS idx_qr_scan_commerce ON app.qr_scan (commerce_id, scanne_le DESC);
CREATE INDEX IF NOT EXISTS idx_qr_scan_agent    ON app.qr_scan (utilisateur_id, scanne_le DESC);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['commerce'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_modifie_le ON app.%1$s;
             CREATE TRIGGER trg_%1$s_modifie_le BEFORE UPDATE ON app.%1$s
             FOR EACH ROW EXECUTE FUNCTION app.trg_maj_modifie_le();', t);
    END LOOP;
END
$$;
