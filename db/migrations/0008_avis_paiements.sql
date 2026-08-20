-- ===========================================================================
--  0008 — Périodes fiscales, avis d'imposition, paiements, quittances
--
--  Le cahier des charges impose « un seul paiement mensuel regroupant toutes
--  les taxes ». C'est le rôle de app.avis_imposition : un avis par commerce
--  et par période, dont app.avis_ligne détaille les taxes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Périodes fiscales (mensuelles par défaut)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.periode_fiscale (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    code              text        NOT NULL,             -- 2026-08
    annee             smallint    NOT NULL,
    mois              smallint,                          -- NULL pour une période annuelle
    periodicite       app.periodicite NOT NULL DEFAULT 'mensuelle',

    date_debut        date        NOT NULL,
    date_fin          date        NOT NULL,             -- inclusive
    date_exigibilite  date        NOT NULL,
    date_penalite     date,                              -- début d'application des pénalités

    -- Une période close ne peut plus recevoir de nouvel avis : c'est ce qui
    -- garantit que les statistiques d'un mois passé ne bougent plus.
    close             boolean     NOT NULL DEFAULT false,
    close_le          timestamptz,
    close_par         uuid        REFERENCES app.utilisateur(id),

    avis_generes      boolean     NOT NULL DEFAULT false,
    avis_generes_le   timestamptz,
    nb_avis           integer     NOT NULL DEFAULT 0,
    montant_attendu   numeric(16,0) NOT NULL DEFAULT 0,
    montant_recouvre  numeric(16,0) NOT NULL DEFAULT 0,

    cree_le           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT periode_code_unique UNIQUE (commune_id, code),
    CONSTRAINT periode_dates       CHECK (date_fin >= date_debut),
    CONSTRAINT periode_mois        CHECK (mois IS NULL OR mois BETWEEN 1 AND 12),
    CONSTRAINT periode_annee       CHECK (annee BETWEEN 2020 AND 2100),
    CONSTRAINT periode_cloture     CHECK ((close = false AND close_le IS NULL)
                                       OR (close = true  AND close_le IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_periode_commune ON app.periode_fiscale (commune_id, annee DESC, mois DESC);

-- ---------------------------------------------------------------------------
-- Avis d'imposition : la facture mensuelle groupée
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.avis_imposition (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)         ON DELETE RESTRICT,
    commerce_id       uuid        NOT NULL REFERENCES app.commerce(id)        ON DELETE RESTRICT,
    periode_id        uuid        NOT NULL REFERENCES app.periode_fiscale(id) ON DELETE RESTRICT,

    numero            text        NOT NULL,             -- GTFC-2026-08-000123

    montant_taxes     numeric(14,0) NOT NULL DEFAULT 0,
    montant_penalite  numeric(14,0) NOT NULL DEFAULT 0,
    montant_remise    numeric(14,0) NOT NULL DEFAULT 0,
    montant_exonere   numeric(14,0) NOT NULL DEFAULT 0,
    montant_total     numeric(14,0) NOT NULL DEFAULT 0,
    montant_paye      numeric(14,0) NOT NULL DEFAULT 0,
    -- Colonne calculée : impossible qu'elle diverge du reste par erreur de code
    montant_restant   numeric(14,0) GENERATED ALWAYS AS (montant_total - montant_paye) STORED,

    statut            app.statut_avis NOT NULL DEFAULT 'brouillon',

    date_emission     date,
    date_exigibilite  date        NOT NULL,
    date_paiement     timestamptz,

    -- Report de la période précédente (arriérés cumulés)
    report_anterieur  numeric(14,0) NOT NULL DEFAULT 0,
    avis_precedent_id uuid        REFERENCES app.avis_imposition(id),

    -- Notifications envoyées au commerçant
    nb_relances       smallint    NOT NULL DEFAULT 0,
    derniere_relance_le timestamptz,

    annule_le         timestamptz,
    annule_par        uuid        REFERENCES app.utilisateur(id),
    motif_annulation  text,

    cree_le           timestamptz NOT NULL DEFAULT now(),
    cree_par          uuid        REFERENCES app.utilisateur(id),
    modifie_le        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT avis_numero_unique       UNIQUE (commune_id, numero),
    CONSTRAINT avis_unique_par_periode  UNIQUE (commerce_id, periode_id),
    CONSTRAINT avis_montants_positifs   CHECK (
        montant_taxes >= 0 AND montant_penalite >= 0 AND montant_remise >= 0 AND
        montant_exonere >= 0 AND montant_total >= 0 AND montant_paye >= 0
    ),
    CONSTRAINT avis_pas_de_surpaiement  CHECK (montant_paye <= montant_total),
    CONSTRAINT avis_annulation_motivee  CHECK (annule_le IS NULL OR motif_annulation IS NOT NULL)
);

COMMENT ON TABLE app.avis_imposition IS
'Un avis par commerce et par période. Regroupe toutes les taxes dues en un seul paiement Wave.';
COMMENT ON CONSTRAINT avis_unique_par_periode ON app.avis_imposition IS
'Empêche la double facturation si la génération mensuelle est relancée par erreur.';

CREATE INDEX IF NOT EXISTS idx_avis_commerce  ON app.avis_imposition (commerce_id, date_exigibilite DESC);
CREATE INDEX IF NOT EXISTS idx_avis_periode   ON app.avis_imposition (periode_id, statut);
CREATE INDEX IF NOT EXISTS idx_avis_commune   ON app.avis_imposition (commune_id, statut) WHERE annule_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_avis_impayes   ON app.avis_imposition (commune_id, date_exigibilite)
    WHERE statut IN ('emis','partiellement_paye') AND annule_le IS NULL;

-- ---------------------------------------------------------------------------
-- Détail de l'avis, une ligne par taxe
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.avis_ligne (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    avis_id           uuid        NOT NULL REFERENCES app.avis_imposition(id) ON DELETE CASCADE,
    type_taxe_id      uuid        NOT NULL REFERENCES ref.type_taxe(id)       ON DELETE RESTRICT,

    -- Barème effectivement appliqué : on garde le lien ET une copie des
    -- valeurs. Si le barème est modifié plus tard, la quittance déjà émise
    -- reste explicable ligne à ligne.
    bareme_id         uuid        REFERENCES app.bareme_taxe(id),
    libelle           text        NOT NULL,
    mode_calcul       app.mode_calcul_taxe NOT NULL,
    base_calcul       numeric(12,2),          -- surface en m², nb de jours...
    unite             text,
    montant_unitaire  numeric(14,2),
    montant_brut      numeric(14,0) NOT NULL,
    taux_exoneration_pct numeric(5,2) NOT NULL DEFAULT 0,
    montant_exonere   numeric(14,0) NOT NULL DEFAULT 0,
    montant           numeric(14,0) NOT NULL,

    exoneration_id    uuid        REFERENCES app.exoneration(id),
    detail_calcul     jsonb,                  -- trace lisible du calcul, pour litige

    ordre             smallint    NOT NULL DEFAULT 0,
    cree_le           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ligne_unique_par_taxe UNIQUE (avis_id, type_taxe_id),
    CONSTRAINT ligne_montants CHECK (montant_brut >= 0 AND montant >= 0 AND montant <= montant_brut)
);

CREATE INDEX IF NOT EXISTS idx_avis_ligne_avis ON app.avis_ligne (avis_id);
CREATE INDEX IF NOT EXISTS idx_avis_ligne_taxe ON app.avis_ligne (type_taxe_id);

COMMENT ON COLUMN app.avis_ligne.detail_calcul IS
'Trace du calcul en JSON (barème, tranche retenue, arrondi). Permet de justifier un montant contesté au guichet.';

-- ---------------------------------------------------------------------------
-- Paiements encaissés
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.paiement (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)         ON DELETE RESTRICT,
    commerce_id       uuid        NOT NULL REFERENCES app.commerce(id)        ON DELETE RESTRICT,
    avis_id           uuid        REFERENCES app.avis_imposition(id)          ON DELETE RESTRICT,

    reference         text        NOT NULL,             -- PAY-GTFC-2026-000123
    montant           numeric(14,0) NOT NULL,
    moyen             app.moyen_paiement NOT NULL,
    devise            text        NOT NULL DEFAULT 'XOF',

    paye_le           timestamptz NOT NULL DEFAULT now(),
    enregistre_le     timestamptz NOT NULL DEFAULT now(),

    -- Encaissement en espèces par un agent : on trace où et par qui, pour
    -- pouvoir rapprocher avec le versement en caisse.
    encaisse_par      uuid        REFERENCES app.utilisateur(id),
    geom              geometry(Point, 4326),
    verse_en_caisse_le timestamptz,
    verse_recu_par    uuid        REFERENCES app.utilisateur(id),

    telephone_payeur  text,
    commentaire       text,

    -- Annulation : un paiement n'est jamais supprimé, il est contre-passé.
    annule_le         timestamptz,
    annule_par        uuid        REFERENCES app.utilisateur(id),
    motif_annulation  text,

    cree_le           timestamptz NOT NULL DEFAULT now(),
    cree_par          uuid        REFERENCES app.utilisateur(id),

    CONSTRAINT paiement_reference_unique UNIQUE (commune_id, reference),
    CONSTRAINT paiement_montant_positif  CHECK (montant > 0),
    CONSTRAINT paiement_annulation_motivee CHECK (annule_le IS NULL OR motif_annulation IS NOT NULL),
    -- Un encaissement en espèces exige de savoir QUI a pris l'argent
    CONSTRAINT paiement_especes_tracable CHECK (moyen <> 'especes' OR encaisse_par IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_paiement_commerce ON app.paiement (commerce_id, paye_le DESC);
CREATE INDEX IF NOT EXISTS idx_paiement_avis     ON app.paiement (avis_id) WHERE annule_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_paiement_commune  ON app.paiement (commune_id, paye_le DESC) WHERE annule_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_paiement_agent    ON app.paiement (encaisse_par, paye_le DESC) WHERE moyen = 'especes';
CREATE INDEX IF NOT EXISTS idx_paiement_non_verse ON app.paiement (encaisse_par)
    WHERE moyen = 'especes' AND verse_en_caisse_le IS NULL AND annule_le IS NULL;

COMMENT ON CONSTRAINT paiement_especes_tracable ON app.paiement IS
'Tout encaissement en espèces est nominatif : c''est le point de contrôle anti-détournement.';

-- ---------------------------------------------------------------------------
-- Transactions Wave (détail phase 5)
--
-- Wave ne reçoit qu'un numéro de téléphone et un montant. Aucune donnée
-- fiscale, aucun nom de commerce, aucune adresse ne lui est transmis.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.transaction_wave (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)        ON DELETE RESTRICT,
    avis_id           uuid        NOT NULL REFERENCES app.avis_imposition(id) ON DELETE RESTRICT,
    paiement_id       uuid        REFERENCES app.paiement(id)                ON DELETE SET NULL,

    -- Identifiants côté Wave
    wave_session_id   text        UNIQUE,
    wave_transaction_id text      UNIQUE,
    checkout_url      text,

    montant           numeric(14,0) NOT NULL,
    devise            text        NOT NULL DEFAULT 'XOF',
    telephone         text,                    -- transmis à Wave, avec le montant

    statut            app.statut_transaction NOT NULL DEFAULT 'initiee',
    environnement     text        NOT NULL DEFAULT 'sandbox',

    initie_le         timestamptz NOT NULL DEFAULT now(),
    expire_le         timestamptz,
    confirme_le       timestamptz,

    -- Réponse brute du webhook, conservée telle quelle pour les litiges
    webhook_recu_le   timestamptz,
    webhook_payload   jsonb,
    webhook_signature text,
    webhook_valide    boolean,

    nb_tentatives     smallint    NOT NULL DEFAULT 0,
    message_erreur    text,

    cree_le           timestamptz NOT NULL DEFAULT now(),
    modifie_le        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT wave_montant_positif CHECK (montant > 0),
    CONSTRAINT wave_environnement   CHECK (environnement IN ('sandbox','production'))
);

CREATE INDEX IF NOT EXISTS idx_wave_avis     ON app.transaction_wave (avis_id, statut);
CREATE INDEX IF NOT EXISTS idx_wave_statut   ON app.transaction_wave (commune_id, statut, initie_le DESC);
CREATE INDEX IF NOT EXISTS idx_wave_en_cours ON app.transaction_wave (expire_le)
    WHERE statut IN ('initiee','en_attente');

COMMENT ON COLUMN app.transaction_wave.webhook_payload IS
'Réponse brute de Wave, conservée intégralement : seule preuve opposable en cas de litige sur un paiement.';

-- ---------------------------------------------------------------------------
-- Quittances (PDF avec QR code intégré)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.quittance (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE RESTRICT,
    paiement_id       uuid        NOT NULL REFERENCES app.paiement(id) ON DELETE RESTRICT,
    commerce_id       uuid        NOT NULL REFERENCES app.commerce(id) ON DELETE RESTRICT,

    numero            text        NOT NULL,
    -- Jeton de vérification encodé dans le QR de la quittance : permet à
    -- n'importe qui de contrôler en ligne qu'une quittance papier est authentique.
    jeton_verification text       NOT NULL UNIQUE,

    bucket            text,
    chemin_pdf        text,
    sha256            text,

    genere_le         timestamptz NOT NULL DEFAULT now(),
    imprime_le        timestamptz,
    nb_impressions    smallint    NOT NULL DEFAULT 0,
    envoye_sms_le     timestamptz,
    nb_verifications  integer     NOT NULL DEFAULT 0,

    CONSTRAINT quittance_numero_unique UNIQUE (commune_id, numero),
    CONSTRAINT quittance_jeton_format  CHECK (jeton_verification ~ '^[A-Z0-9]{10,32}$')
);

CREATE INDEX IF NOT EXISTS idx_quittance_paiement ON app.quittance (paiement_id);
CREATE INDEX IF NOT EXISTS idx_quittance_commerce ON app.quittance (commerce_id, genere_le DESC);

-- ---------------------------------------------------------------------------
-- Notifications envoyées aux commerçants (SMS, demandes de paiement, relances)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.notification (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE CASCADE,
    commerce_id       uuid        REFERENCES app.commerce(id)          ON DELETE CASCADE,
    avis_id           uuid        REFERENCES app.avis_imposition(id)   ON DELETE CASCADE,

    canal             text        NOT NULL DEFAULT 'sms',      -- sms | whatsapp | app
    type              text        NOT NULL,                    -- avis_emis | relance | quittance
    destinataire      text        NOT NULL,
    contenu           text        NOT NULL,

    statut            text        NOT NULL DEFAULT 'en_attente', -- en_attente | envoye | echec
    envoye_le         timestamptz,
    erreur            text,
    nb_tentatives     smallint    NOT NULL DEFAULT 0,

    cree_le           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT notification_canal  CHECK (canal  IN ('sms','whatsapp','app','email')),
    CONSTRAINT notification_statut CHECK (statut IN ('en_attente','envoye','echec','annule'))
);

CREATE INDEX IF NOT EXISTS idx_notification_a_envoyer ON app.notification (statut, cree_le)
    WHERE statut = 'en_attente';
CREATE INDEX IF NOT EXISTS idx_notification_commerce  ON app.notification (commerce_id, cree_le DESC);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['avis_imposition','transaction_wave'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_modifie_le ON app.%1$s;
             CREATE TRIGGER trg_%1$s_modifie_le BEFORE UPDATE ON app.%1$s
             FOR EACH ROW EXECUTE FUNCTION app.trg_maj_modifie_le();', t);
    END LOOP;
END
$$;
