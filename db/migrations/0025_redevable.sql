-- ===========================================================================
--  0025 — Le redevable devient l'entité facturée
--
--  CHANGEMENT DE MODÈLE
--
--  Jusqu'ici la plateforme facturait un COMMERCE. Le document de référence
--  déplace le centre de gravité : c'est le REDEVABLE — personne physique ou
--  morale — qui reçoit la facture, et il peut porter plusieurs objets
--  taxables de natures différentes.
--
--  Un tailleur avec une cantine au marché de Colobane et une enseigne reçoit
--  UNE facture couvrant les deux, donc UN seul lien de paiement. Une régie
--  publicitaire portant 8 panneaux et aucun commerce reçoit également une
--  facture, ce que le modèle précédent ne savait pas représenter du tout.
--
--  LE NUMÉRO DE TÉLÉPHONE EST L'IDENTIFIANT
--
--  Un numéro, un redevable, tous ses objets dessous. C'est aussi la clé du
--  portail : sans numéro vérifié, le redevable est injoignable — ni lien de
--  paiement, ni accès à son dossier — et l'erreur ne se découvre qu'à
--  l'échéance, quand il est trop tard pour la corriger sur le terrain.
--
--  D'où la vérification à la source, dès la saisie par l'agent, et
--  l'interdiction de changer le numéro depuis le portail : autoriser la
--  modification en libre-service ouvrirait un vecteur de détournement de
--  compte trivial.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app.redevable (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id) ON DELETE RESTRICT,

    code              text        NOT NULL,          -- GTFC-R-00042
    numero_sequence   integer     NOT NULL,

    type_redevable    app.type_redevable NOT NULL DEFAULT 'personne_physique',

    -- Personne physique : nom + prénom. Personne morale : raison_sociale.
    -- La contrainte plus bas impose qu'au moins l'un des deux soit renseigné.
    nom               text,
    prenom            text,
    raison_sociale    text,
    designation       text        GENERATED ALWAYS AS (
                          coalesce(raison_sociale, trim(coalesce(nom, '') || ' ' || coalesce(prenom, '')))
                      ) STORED,
    designation_normalisee text   GENERATED ALWAYS AS (
                          app.normaliser(coalesce(raison_sociale,
                              trim(coalesce(nom, '') || ' ' || coalesce(prenom, ''))))
                      ) STORED,

    -- --- L'identifiant ----------------------------------------------------
    telephone         text,
    statut_telephone  app.statut_telephone NOT NULL DEFAULT 'non_verifie',
    telephone_verifie_le   timestamptz,
    telephone_verifie_par  uuid REFERENCES app.utilisateur(id),
    -- Second numéro, purement interne : jamais transmis à Wave, jamais utilisé
    -- pour l'authentification. Sert au superviseur qui cherche à joindre
    -- quelqu'un dont le numéro principal ne répond plus.
    telephone_secondaire text,

    -- --- Identité administrative ------------------------------------------
    ninea             text,
    piece_type        text,       -- CNI, passeport
    piece_numero      text,
    registre_commerce text,

    -- --- Rattachement territorial (celui du domicile ou du siège) ---------
    quartier_id       uuid        REFERENCES app.quartier(id) ON DELETE SET NULL,
    rue_id            uuid        REFERENCES app.rue(id)      ON DELETE SET NULL,
    adresse_libelle   text,

    -- --- Situation consolidée, tous objets confondus -----------------------
    statut_fiscal     app.statut_fiscal NOT NULL DEFAULT 'inconnu',
    statut_fiscal_calcule_le timestamptz,
    solde_du          numeric(14,0) NOT NULL DEFAULT 0,
    nb_objets_taxables integer    NOT NULL DEFAULT 0,

    notes             text,
    version           integer     NOT NULL DEFAULT 1,
    origine           text        NOT NULL DEFAULT 'terrain',

    cree_le           timestamptz NOT NULL DEFAULT now(),
    cree_par          uuid        REFERENCES app.utilisateur(id),
    modifie_le        timestamptz NOT NULL DEFAULT now(),
    modifie_par       uuid        REFERENCES app.utilisateur(id),
    archive_le        timestamptz,
    archive_par       uuid        REFERENCES app.utilisateur(id),
    motif_archivage   text,

    CONSTRAINT redevable_code_unique UNIQUE (commune_id, code),
    CONSTRAINT redevable_identite_renseignee CHECK (
        raison_sociale IS NOT NULL OR nom IS NOT NULL
    ),
    -- Une personne morale sans raison sociale n'est pas identifiable ; une
    -- personne physique avec une raison sociale est un classement erroné.
    CONSTRAINT redevable_type_coherent CHECK (
        (type_redevable = 'personne_morale' AND raison_sociale IS NOT NULL)
     OR (type_redevable = 'personne_physique' AND nom IS NOT NULL)
    ),
    CONSTRAINT redevable_tel_format CHECK (
        telephone IS NULL OR telephone ~ '^\+?[0-9]{8,15}$'
    ),
    CONSTRAINT redevable_tel_secondaire_format CHECK (
        telephone_secondaire IS NULL OR telephone_secondaire ~ '^\+?[0-9]{8,15}$'
    ),
    -- Un numéro déclaré vérifié doit porter la date et l'agent qui l'a validé.
    CONSTRAINT redevable_verification_tracee CHECK (
        statut_telephone <> 'verifie'
        OR (telephone IS NOT NULL AND telephone_verifie_le IS NOT NULL)
    ),
    CONSTRAINT redevable_solde_positif CHECK (solde_du >= 0),
    CONSTRAINT redevable_archivage_motive CHECK (
        archive_le IS NULL OR motif_archivage IS NOT NULL
    ),
    CONSTRAINT redevable_origine CHECK (origine IN ('terrain', 'import', 'dashboard', 'reprise'))
);

COMMENT ON TABLE app.redevable IS
'Personne physique ou morale à qui la facture est adressée. Porte un ou plusieurs objets taxables ; reçoit une facture consolidée par période.';
COMMENT ON COLUMN app.redevable.telephone IS
'Identifiant du redevable et seule donnée nominative transmise à Wave, avec le montant. Vérifié par code à usage unique lors du recensement.';
COMMENT ON COLUMN app.redevable.telephone_secondaire IS
'Numéro de repli interne. Jamais transmis à Wave, jamais accepté pour l''authentification au portail.';

-- Un numéro identifie UN redevable et un seul, au sein d'une commune.
-- Index partiel : les redevables archivés libèrent leur numéro, un commerce
-- repris par un tiers ne doit pas rester bloqué par un dossier clos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_redevable_telephone_unique
    ON app.redevable (commune_id, telephone)
    WHERE telephone IS NOT NULL AND archive_le IS NULL;

CREATE INDEX IF NOT EXISTS idx_redevable_commune  ON app.redevable (commune_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_redevable_statut   ON app.redevable (commune_id, statut_fiscal) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_redevable_nom      ON app.redevable USING GIN (designation_normalisee gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_redevable_ninea    ON app.redevable (ninea) WHERE ninea IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_redevable_non_verifie
    ON app.redevable (commune_id) WHERE statut_telephone <> 'verifie' AND archive_le IS NULL;

-- ---------------------------------------------------------------------------
-- Numérotation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.generer_code_redevable(p_commune_id uuid)
RETURNS TABLE (code text, numero_sequence integer)
LANGUAGE plpgsql
AS $$
DECLARE
    v_prefixe text;
    v_seq     integer;
BEGIN
    SELECT coalesce(p.prefixe_code_commerce, c.code)
      INTO v_prefixe
      FROM app.commune c
      LEFT JOIN app.commune_parametre p ON p.commune_id = c.id
     WHERE c.id = p_commune_id;

    IF v_prefixe IS NULL THEN
        RAISE EXCEPTION 'Commune % introuvable', p_commune_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('redevable' || p_commune_id::text));

    SELECT coalesce(max(r.numero_sequence), 0) + 1
      INTO v_seq
      FROM app.redevable r
     WHERE r.commune_id = p_commune_id;

    RETURN QUERY SELECT
        format('%s-R-%s', v_prefixe, lpad(v_seq::text, 5, '0')),
        v_seq;
END;
$$;

COMMENT ON FUNCTION app.generer_code_redevable IS
'Numérotation séquentielle des redevables par commune, protégée par un verrou consultatif.';

-- ===========================================================================
--  Reprise : un redevable pour chaque commerce existant
--
--  Règle de regroupement : les commerces partageant le MÊME numéro de
--  téléphone appartiennent au même redevable. C'est exactement la définition
--  du document — un numéro, un redevable.
--
--  Les commerces sans aucun numéro reçoivent chacun leur propre redevable.
--  Les regrouper sur le nom du gérant serait tentant, mais deux « Mamadou
--  Diop » sans téléphone ne sont pas la même personne, et fusionner deux
--  dossiers à tort est bien plus coûteux à défaire que d'en avoir deux.
-- ===========================================================================
ALTER TABLE app.commerce
    ADD COLUMN IF NOT EXISTS redevable_id uuid REFERENCES app.redevable(id) ON DELETE RESTRICT;

DO $$
DECLARE
    v_commerce   record;
    v_redevable  uuid;
    v_code       text;
    v_seq        integer;
    v_tel        text;
    v_crees      integer := 0;
    v_groupes    integer := 0;
BEGIN
    FOR v_commerce IN
        SELECT c.id, c.commune_id, c.enseigne,
               c.gerant_nom, c.gerant_prenom,
               coalesce(nullif(c.telephone_paiement, ''), nullif(c.gerant_telephone, '')) AS tel,
               c.ninea, c.gerant_piece_type, c.gerant_piece_numero,
               c.quartier_id, c.adresse_libelle, c.cree_par
          FROM app.commerce c
         WHERE c.redevable_id IS NULL
         ORDER BY c.commune_id, c.cree_le
    LOOP
        v_tel := v_commerce.tel;
        v_redevable := NULL;

        -- Un redevable existe-t-il déjà pour ce numéro ?
        IF v_tel IS NOT NULL THEN
            SELECT r.id INTO v_redevable
              FROM app.redevable r
             WHERE r.commune_id = v_commerce.commune_id
               AND r.telephone = v_tel
               AND r.archive_le IS NULL;
        END IF;

        IF v_redevable IS NOT NULL THEN
            v_groupes := v_groupes + 1;
        ELSE
            SELECT g.code, g.numero_sequence INTO v_code, v_seq
              FROM app.generer_code_redevable(v_commerce.commune_id) g;

            INSERT INTO app.redevable (
                commune_id, code, numero_sequence, type_redevable,
                nom, prenom, telephone, statut_telephone,
                ninea, piece_type, piece_numero,
                quartier_id, adresse_libelle, origine, cree_par
            ) VALUES (
                v_commerce.commune_id, v_code, v_seq, 'personne_physique',
                -- Sans nom de gérant, on retombe sur l'enseigne : un dossier
                -- doit toujours porter une désignation lisible au guichet.
                coalesce(nullif(v_commerce.gerant_nom, ''), v_commerce.enseigne),
                nullif(v_commerce.gerant_prenom, ''),
                v_tel,
                -- Aucun numéro repris n'a été confirmé par un code : les
                -- déclarer vérifiés serait un mensonge qui se paierait à
                -- l'échéance, quand les liens de paiement partiraient dans le vide.
                'non_verifie',
                nullif(v_commerce.ninea, ''),
                nullif(v_commerce.gerant_piece_type, ''),
                nullif(v_commerce.gerant_piece_numero, ''),
                v_commerce.quartier_id, v_commerce.adresse_libelle,
                'reprise', v_commerce.cree_par
            )
            RETURNING id INTO v_redevable;
            v_crees := v_crees + 1;
        END IF;

        UPDATE app.commerce SET redevable_id = v_redevable WHERE id = v_commerce.id;
    END LOOP;

    RAISE NOTICE 'Reprise redevables : % créé(s), % commerce(s) rattaché(s) à un redevable existant.',
                 v_crees, v_groupes;
END
$$;

-- Le rattachement devient obligatoire : à partir d'ici, un commerce sans
-- redevable est un commerce que personne ne peut payer.
ALTER TABLE app.commerce ALTER COLUMN redevable_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commerce_redevable ON app.commerce (redevable_id) WHERE archive_le IS NULL;

COMMENT ON COLUMN app.commerce.redevable_id IS
'Propriétaire fiscal du commerce. La facture part au redevable, pas au commerce.';

-- ---------------------------------------------------------------------------
-- Compteur d'objets taxables, tenu par la base
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.rafraichir_nb_objets(p_redevable uuid)
RETURNS void
LANGUAGE sql
AS $$
    UPDATE app.redevable r
       SET nb_objets_taxables = (
             SELECT count(*) FROM app.commerce c
              WHERE c.redevable_id = r.id AND c.archive_le IS NULL)
     WHERE r.id = p_redevable;
$$;

UPDATE app.redevable r
   SET nb_objets_taxables = (
         SELECT count(*) FROM app.commerce c
          WHERE c.redevable_id = r.id AND c.archive_le IS NULL);
