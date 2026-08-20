-- ===========================================================================
--  0028 — Canal officiel de contestation
--
--  Sans canal formel, la contestation se fait verbalement auprès de l'agent :
--  rien n'est tracé, la mairie ne sait pas combien de dossiers sont en litige,
--  et l'agent se retrouve à arbitrer seul sur le trottoir. Le litige bloque
--  alors la collecte sur toute une rue.
--
--  Trois étapes, conformes au document : soumission, instruction, résolution.
--
--  L'IDENTIFICATION DU CONTESTATAIRE EST ACQUISE
--  Elle découle de l'authentification au portail — le numéro est déjà vérifié
--  et lié au dossier. Aucune vérification supplémentaire n'est demandée, et
--  les contestations anonymes sont de fait écartées.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app.contestation (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)    ON DELETE RESTRICT,
    redevable_id    uuid        NOT NULL REFERENCES app.redevable(id)  ON DELETE RESTRICT,
    motif_id        uuid        NOT NULL REFERENCES ref.motif_contestation(id) ON DELETE RESTRICT,

    numero          text        NOT NULL,           -- GTFC-CTS-2026-0007

    -- Ce qui est contesté. Une contestation peut viser un avis précis, un
    -- objet taxable, ou le dossier dans son ensemble (double enregistrement).
    avis_id         uuid        REFERENCES app.avis_imposition(id) ON DELETE SET NULL,
    objet_type      app.type_objet_taxable,
    objet_id        uuid,

    description     text        NOT NULL,

    -- --- Origine -----------------------------------------------------------
    canal           text        NOT NULL DEFAULT 'portail',   -- portail | agent | guichet
    -- Renseigné seulement si un agent saisit pour le compte du redevable :
    -- tous les redevables n'ont pas un téléphone qui ouvre un navigateur.
    saisie_par      uuid        REFERENCES app.utilisateur(id),

    statut          app.statut_contestation NOT NULL DEFAULT 'soumise',

    -- --- Instruction -------------------------------------------------------
    instruite_par   uuid        REFERENCES app.utilisateur(id),
    instruite_le    timestamptz,
    date_limite     date,       -- délai fixé par la convention avec la mairie
    visite_id       uuid        REFERENCES app.visite(id) ON DELETE SET NULL,
    notes_instruction text,

    -- --- Résolution --------------------------------------------------------
    resolue_le      timestamptz,
    resolue_par     uuid        REFERENCES app.utilisateur(id),
    motif_decision  text,
    -- Ce qui a effectivement changé dans le dossier, pour que la décision
    -- reste vérifiable quand la fiche aura été modifiée dix fois depuis.
    correction_appliquee jsonb,

    -- Une contestation ne suspend pas le recouvrement par principe : c'est
    -- une décision explicite du superviseur, tracée, et non un effet de bord
    -- du simple dépôt — sinon contester deviendrait un moyen de ne pas payer.
    suspend_recouvrement boolean NOT NULL DEFAULT false,
    suspendu_par    uuid        REFERENCES app.utilisateur(id),

    notifie_le      timestamptz,

    cree_le         timestamptz NOT NULL DEFAULT now(),
    modifie_le      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT contestation_numero_unique UNIQUE (commune_id, numero),
    CONSTRAINT contestation_canal CHECK (canal IN ('portail', 'agent', 'guichet')),
    -- Une saisie par agent doit dire QUEL agent : c'est la contrepartie du
    -- fait que le redevable ne s'est pas authentifié lui-même.
    CONSTRAINT contestation_saisie_tracee CHECK (
        canal = 'portail' OR saisie_par IS NOT NULL
    ),
    -- Un rejet non motivé est un rejet indéfendable.
    CONSTRAINT contestation_decision_motivee CHECK (
        statut NOT IN ('acceptee', 'rejetee')
        OR (resolue_le IS NOT NULL AND motif_decision IS NOT NULL)
    ),
    CONSTRAINT contestation_objet_complet CHECK (
        (objet_type IS NULL AND objet_id IS NULL)
        OR (objet_type IS NOT NULL AND objet_id IS NOT NULL)
    )
);

COMMENT ON TABLE app.contestation IS
'Canal officiel de contestation, en trois étapes. Sans lui, le litige se règle oralement sur le trottoir et bloque la collecte.';
COMMENT ON COLUMN app.contestation.suspend_recouvrement IS
'Suspension explicite et tracée. Ne découle jamais du simple dépôt : sinon contester deviendrait le moyen le plus simple de ne pas payer.';

CREATE INDEX IF NOT EXISTS idx_contestation_redevable ON app.contestation (redevable_id, cree_le DESC);
CREATE INDEX IF NOT EXISTS idx_contestation_commune   ON app.contestation (commune_id, statut);
CREATE INDEX IF NOT EXISTS idx_contestation_avis      ON app.contestation (avis_id) WHERE avis_id IS NOT NULL;
-- Dossiers en retard d'instruction : la question que le receveur pose chaque semaine.
CREATE INDEX IF NOT EXISTS idx_contestation_en_retard ON app.contestation (commune_id, date_limite)
    WHERE statut IN ('soumise', 'en_instruction', 'visite_demandee');

-- ---------------------------------------------------------------------------
-- Pièces jointes (stockées dans MinIO, référencées ici)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.contestation_piece (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    contestation_id uuid        NOT NULL REFERENCES app.contestation(id) ON DELETE CASCADE,
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)      ON DELETE RESTRICT,
    objet_minio     text        NOT NULL,
    nom_fichier     text,
    type_mime       text,
    taille_octets   integer,
    -- Une pièce déposée par le redevable n'a pas la même valeur probante
    -- qu'un constat versé par l'agent instructeur.
    deposee_par_redevable boolean NOT NULL DEFAULT true,
    deposee_par     uuid        REFERENCES app.utilisateur(id),
    cree_le         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT piece_taille_raisonnable CHECK (taille_octets IS NULL OR taille_octets <= 10485760)
);

CREATE INDEX IF NOT EXISTS idx_contestation_piece ON app.contestation_piece (contestation_id);

-- ---------------------------------------------------------------------------
-- Numérotation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.generer_numero_contestation(p_commune_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_prefixe text;
    v_annee   text := to_char(current_date, 'YYYY');
    v_seq     integer;
BEGIN
    SELECT coalesce(p.prefixe_code_commerce, c.code) INTO v_prefixe
      FROM app.commune c
      LEFT JOIN app.commune_parametre p ON p.commune_id = c.id
     WHERE c.id = p_commune_id;

    PERFORM pg_advisory_xact_lock(hashtext('contestation' || p_commune_id::text || v_annee));

    SELECT count(*) + 1 INTO v_seq
      FROM app.contestation
     WHERE commune_id = p_commune_id
       AND numero LIKE v_prefixe || '-CTS-' || v_annee || '-%';

    RETURN format('%s-CTS-%s-%s', v_prefixe, v_annee, lpad(v_seq::text, 4, '0'));
END;
$$;

-- ---------------------------------------------------------------------------
-- Suivi pour le superviseur
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_contestations_a_traiter AS
SELECT ct.commune_id, ct.id, ct.numero, ct.statut, ct.cree_le, ct.date_limite,
       (ct.date_limite IS NOT NULL AND ct.date_limite < current_date) AS en_retard,
       CASE WHEN ct.date_limite IS NULL THEN NULL
            ELSE (ct.date_limite - current_date) END AS jours_restants,
       m.libelle       AS motif,
       m.visite_recommandee,
       m.escalade_receveur,
       r.code          AS redevable_code,
       r.designation   AS redevable,
       r.telephone,
       a.numero        AS avis,
       a.montant_total,
       ct.description,
       u.nom_complet   AS instructeur,
       (SELECT count(*) FROM app.contestation_piece p WHERE p.contestation_id = ct.id) AS nb_pieces
  FROM app.contestation ct
  JOIN ref.motif_contestation m ON m.id = ct.motif_id
  JOIN app.redevable r          ON r.id = ct.redevable_id
  LEFT JOIN app.avis_imposition a ON a.id = ct.avis_id
  LEFT JOIN app.utilisateur u   ON u.id = ct.instruite_par
 WHERE ct.statut IN ('soumise', 'en_instruction', 'visite_demandee', 'transmise_receveur')
 ORDER BY ct.date_limite NULLS LAST, ct.cree_le;

COMMENT ON VIEW app.v_contestations_a_traiter IS
'File d''instruction des contestations, la plus urgente en tête. Le retard est calculé, pas déclaré.';
