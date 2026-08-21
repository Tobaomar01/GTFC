-- ===========================================================================
--  0038 — Les marchés du référentiel, et un seul jeu d'emplacements
--
--  DEUX MANQUES RELEVÉS EN RELISANT LE DOCUMENT
--
--  1. LES MARCHÉS. Le référentiel décrit sept entrées — cinq marchés
--     permanents, un marché hebdomadaire, et MAR-00 « hors marché ». La base
--     n'en contenait qu'un seul, provisoire, hérité du jeu initial.
--
--     Un agent ne peut pas rattacher un commerçant à un marché qui n'existe
--     pas dans sa liste. Il aurait choisi le seul disponible, et 5 443
--     fiches auraient désigné le mauvais marché — une erreur qui ne se
--     corrige qu'en repassant sur le terrain.
--
--  2. LES EMPLACEMENTS EN DOUBLE. La migration 0021 a installé EMP-01 à
--     EMP-07 sans retirer les quatre libellés provisoires du jeu initial
--     (CANTINE, ETAL, HANGAR, TABLE). L'agent voyait onze choix, dont
--     « Cantine » deux fois. Deux commerçants identiques auraient été classés
--     différemment selon l'agent, et les statistiques par emplacement
--     seraient devenues ininterprétables.
--
--     Le doublon ne casse rien : il produit des données incohérentes en
--     silence. C'est ce qui le rend coûteux.
--
--  CE QUE LE DOCUMENT NE DONNE PAS : les dénominations. Le PDC recense cinq
--  marchés permanents — deux à Gueule Tapée, un à Fass, deux à Colobane —
--  et un hebdomadaire, SANS LES NOMMER. Seul le marché de Colobane est
--  identifié. Les six autres sont donc créés marqués à remplacer : ils
--  apparaissent dans app.v_donnees_a_remplacer jusqu'à ce que la mairie
--  fournisse les noms officiels.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Les marchés
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.installer_marches(p_commune uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- MAR-00 « hors marché » n'est PAS créé comme un marché : l'absence de
    -- marché se représente par marche_id NULL. Créer une ligne « hors
    -- marché » obligerait chaque requête à l'exclure, et un oubli la ferait
    -- apparaître dans les statistiques comme un marché réel.
    INSERT INTO app.marche (commune_id, code, nom, a_remplacer)
    VALUES
        (p_commune, 'MAR-01', 'À_REMPLACER — Marché de Gueule Tapée (1)', true),
        (p_commune, 'MAR-02', 'À_REMPLACER — Marché de Gueule Tapée (2)', true),
        (p_commune, 'MAR-03', 'À_REMPLACER — Marché de Fass',             true),
        -- Le seul que le document nomme.
        (p_commune, 'MAR-04', 'Marché de Colobane',                       false),
        (p_commune, 'MAR-05', 'À_REMPLACER — Marché de Colobane (2)',     true),
        (p_commune, 'MAR-06', 'À_REMPLACER — Marché hebdomadaire',        true)
    ON CONFLICT (commune_id, code) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION app.installer_marches(uuid) IS
'Installe les six marchés du référentiel. MAR-00 « hors marché » n''est volontairement pas une ligne : l''absence de marché se représente par marche_id NULL.';

-- ---------------------------------------------------------------------------
-- 2. Reprise : les emplacements provisoires cèdent la place aux codes EMP
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    c            uuid;
    v_paire      record;
    v_cible      uuid;
    v_deplaces   integer;
    v_total      integer := 0;

    -- Les quatre libellés du jeu initial et leur code de référentiel.
    correspondance constant text[][] := ARRAY[
        ['TABLE',   'EMP-05'],   -- « Étal / table »
        ['ETAL',    'EMP-05'],
        ['CANTINE', 'EMP-04'],
        ['HANGAR',  'EMP-06']
    ];
BEGIN
    FOR c IN SELECT id FROM app.commune LOOP
        PERFORM app.installer_marches(c);

        FOR v_paire IN
            SELECT correspondance[i][1] AS ancien, correspondance[i][2] AS nouveau
              FROM generate_subscripts(correspondance, 1) AS i
        LOOP
            SELECT id INTO v_cible FROM ref.type_emplacement
             WHERE commune_id = c AND code = v_paire.nouveau;
            CONTINUE WHEN v_cible IS NULL;

            UPDATE app.commerce SET type_emplacement_id = v_cible
             WHERE commune_id = c
               AND type_emplacement_id IN (SELECT id FROM ref.type_emplacement
                                            WHERE commune_id = c AND code = v_paire.ancien);
            GET DIAGNOSTICS v_deplaces = ROW_COUNT;
            v_total := v_total + v_deplaces;

            -- Les tarifs de droit de place suivent leur emplacement, sans
            -- quoi le calcul chercherait un tarif rattaché à un code retiré.
            UPDATE app.bareme_tranche t SET type_emplacement_id = v_cible
             WHERE t.type_emplacement_id IN (SELECT id FROM ref.type_emplacement
                                              WHERE commune_id = c AND code = v_paire.ancien);

            -- Désactivé, jamais supprimé : une quittance déjà émise peut le
            -- mentionner dans son détail de calcul.
            UPDATE ref.type_emplacement
               SET actif = false, a_remplacer = false,
                   libelle = libelle || ' (repris vers ' || v_paire.nouveau || ')',
                   modifie_le = now()
             WHERE commune_id = c AND code = v_paire.ancien AND actif;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'Emplacements : % commerce(s) repointé(s) vers les codes EMP.', v_total;
END
$$;

-- Collapse des tranches devenues concurrentes : TABLE et ETAL rejoignent
-- tous deux EMP-05. Le montant le PLUS BAS est retenu — sur-facturer à cause
-- d'une reprise technique est une faute, sous-facturer se corrige à la
-- prochaine délibération.
WITH doublons AS (
    SELECT t.id,
           row_number() OVER (PARTITION BY t.bareme_id, t.type_emplacement_id
                              ORDER BY t.montant, t.id) AS rang,
           count(*)    OVER (PARTITION BY t.bareme_id, t.type_emplacement_id) AS nb
      FROM app.bareme_tranche t
     WHERE t.type_emplacement_id IS NOT NULL
)
UPDATE app.bareme_tranche t
   SET a_remplacer = true,
       libelle = coalesce(t.libelle, 'tranche') || ' (reprise EMP — à confirmer)'
  FROM doublons d WHERE d.id = t.id AND d.rang = 1 AND d.nb > 1;

WITH doublons AS (
    SELECT t.id,
           row_number() OVER (PARTITION BY t.bareme_id, t.type_emplacement_id
                              ORDER BY t.montant, t.id) AS rang
      FROM app.bareme_tranche t
     WHERE t.type_emplacement_id IS NOT NULL
)
DELETE FROM app.bareme_tranche t USING doublons d WHERE d.id = t.id AND d.rang > 1;

-- ---------------------------------------------------------------------------
-- 2 bis. Le marché provisoire du jeu initial cède la place à MAR-04
--
--  M01 « Marché communal » venait du seed. Il désigne le même lieu que
--  MAR-04 — le marché de Colobane, le seul que le PDC nomme. Les laisser
--  coexister mettrait deux marchés de Colobane dans la liste de l'agent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c uuid; v_m01 uuid; v_mar04 uuid; v_n integer := 0;
BEGIN
    FOR c IN SELECT id FROM app.commune LOOP
        SELECT id INTO v_m01   FROM app.marche WHERE commune_id = c AND code = 'M01';
        SELECT id INTO v_mar04 FROM app.marche WHERE commune_id = c AND code = 'MAR-04';
        CONTINUE WHEN v_m01 IS NULL OR v_mar04 IS NULL;

        UPDATE app.commerce SET marche_id = v_mar04 WHERE marche_id = v_m01;
        GET DIAGNOSTICS v_n = ROW_COUNT;

        -- Archivé, pas supprimé : des avis déjà émis peuvent le mentionner.
        UPDATE app.marche
           SET archive_le = now(), a_remplacer = false,
               nom = nom || ' (repris vers MAR-04)'
         WHERE id = v_m01 AND archive_le IS NULL;

        RAISE NOTICE 'Marché M01 repris vers MAR-04 — % commerce(s) déplacé(s).', v_n;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Un emplacement de marché exige un marché
--
--  Le référentiel le dit : le marché de rattachement est obligatoire pour
--  EMP-04 à EMP-07. Sans cette règle, un droit de place se calculerait pour
--  un commerçant dont personne ne sait dans quel marché il tient sa cantine
--  — et le régisseur du marché ne pourrait pas vérifier sa tournée.
--
--  Déclencheur plutôt que CHECK : la règle porte sur le CODE de
--  l'emplacement, qui vit dans une autre table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.commerce_verifier_marche()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_code text;
BEGIN
    IF NEW.type_emplacement_id IS NULL OR NEW.marche_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT code INTO v_code FROM ref.type_emplacement WHERE id = NEW.type_emplacement_id;

    IF v_code IN ('EMP-04', 'EMP-05', 'EMP-06', 'EMP-07') THEN
        RAISE EXCEPTION
          'Emplacement % : le marché de rattachement est obligatoire.', v_code
          USING HINT = 'Une cantine, un étal, un hangar ou un magasin se trouvent '
                       'nécessairement dans un marché.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commerce_marche ON app.commerce;
CREATE TRIGGER trg_commerce_marche
    BEFORE INSERT OR UPDATE OF type_emplacement_id, marche_id ON app.commerce
    FOR EACH ROW
    EXECUTE FUNCTION app.commerce_verifier_marche();

-- ---------------------------------------------------------------------------
-- 4. Contrôle : plus aucun doublon d'emplacement actif
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_actifs integer; v_attendus integer;
BEGIN
    SELECT count(*) INTO v_actifs
      FROM ref.type_emplacement WHERE actif;
    SELECT count(*) * 7 INTO v_attendus FROM app.commune;

    IF v_actifs <> v_attendus THEN
        RAISE WARNING
          '% emplacement(s) actif(s) pour % commune(s) — attendu % (EMP-01 à EMP-07). '
          'Vérifiez : SELECT code, libelle FROM ref.type_emplacement WHERE actif ORDER BY code;',
          v_actifs, (SELECT count(*) FROM app.commune), v_attendus;
    END IF;
END
$$;
