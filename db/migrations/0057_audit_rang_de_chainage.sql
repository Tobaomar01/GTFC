-- 0057 — La chaîne d'audit porte son propre rang
--
-- Troisième et dernier temps de la même correction. Le verrou (0055) empêche
-- deux écritures de lire la même empreinte ; le tri par identifiant (0056)
-- devait rendre la relecture fidèle. Il ne l'est pas, et la raison est
-- instructive.
--
-- `id` vient de `nextval()`, évalué comme valeur par défaut de la colonne —
-- donc AVANT que le déclencheur ne prenne le verrou. L'identifiant est
-- attribué dans l'ordre où les transactions ARRIVENT, le chaînage se fait
-- dans l'ordre où elles OBTIENNENT le verrou. Les deux ordres diffèrent :
--
--     T1 prend l'id 785, obtient le verrou, chaîne, garde le verrou
--     T2 prend l'id 786, attend
--     T1 prend l'id 787, chaîne sur 785, valide, relâche
--     T2 chaîne sur 787  ← alors que son id est 786
--
-- Relue par identifiant, l'entrée 786 s'accroche à une empreinte que la
-- relecture n'a pas encore rencontrée. Rupture signalée, chaîne pourtant
-- intacte.
--
-- Aucune colonne existante ne porte l'ordre du chaînage : ni l'identifiant,
-- attribué trop tôt, ni l'horodatage, qui est l'heure de début de
-- transaction. On lui en donne une, attribuée par le déclencheur lui-même,
-- sous le verrou. Elle est par construction dans l'ordre exact du chaînage,
-- sans trou.
--
-- Ce défaut ne pouvait apparaître qu'en exécution concurrente. Il n'aurait
-- pas été vu avant le terrain, où plusieurs agents synchronisent ensemble —
-- et il aurait alors fait crier l'alarme anti-fraude tous les jours, jusqu'à
-- ce que plus personne ne la regarde.

ALTER TABLE audit.journal ADD COLUMN IF NOT EXISTS rang bigint;

COMMENT ON COLUMN audit.journal.rang IS
  'Position dans la chaîne, attribuée par le déclencheur sous verrou. Seul '
  'ordre fidèle : id est attribué avant le verrou, horodatage est l''heure de '
  'début de transaction.';

-- Reprise de l'existant. Le journal refuse les modifications ; on lève la
-- garde le temps du remplissage, puis on la remet. Les entrées antérieures
-- gardent leur ordre d'identifiant : c'est celui dans lequel elles ont été
-- chaînées, le dispositif n'ayant pas encore connu d'écritures simultanées.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM audit.journal WHERE rang IS NULL) THEN
        ALTER TABLE audit.journal DISABLE TRIGGER trg_journal_inalterable;

        WITH ordonne AS (
            SELECT id, row_number() OVER (ORDER BY id) AS r FROM audit.journal)
        UPDATE audit.journal j SET rang = o.r FROM ordonne o WHERE o.id = j.id;

        ALTER TABLE audit.journal ENABLE TRIGGER trg_journal_inalterable;
    END IF;
END $$;

-- Index NON unique, à regret : le journal est partitionné par horodatage, et
-- PostgreSQL exige que toute contrainte d'unicité porte aussi la clé de
-- partitionnement — ce qui n'assurerait plus l'unicité du rang lui-même.
--
-- L'unicité tient donc par construction : le rang est attribué sous le verrou,
-- comme le maximum plus un. Et si elle venait à manquer malgré tout,
-- `verifier_chaine()` le dirait : la suite attendue des rangs est vérifiée à
-- chaque maillon, un doublon comme un trou décalent la suite.
CREATE INDEX IF NOT EXISTS idx_journal_rang ON audit.journal (rang);

CREATE OR REPLACE FUNCTION audit.chainer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prec text; v_rang bigint;
BEGIN
    -- Le verrou couvre la lecture du dernier maillon ET l'attribution du
    -- rang : les deux doivent être indivisibles, sinon le rang retombe dans
    -- le travers de l'identifiant.
    PERFORM pg_advisory_xact_lock(hashtext('audit.journal.chainage'));

    SELECT j.empreinte, j.rang INTO v_prec, v_rang
      FROM audit.journal j ORDER BY j.rang DESC NULLS LAST LIMIT 1;

    NEW.rang := coalesce(v_rang, 0) + 1;
    NEW.empreinte_precedente := v_prec;
    NEW.empreinte := encode(digest(
        coalesce(v_prec,'') ||
        coalesce(NEW.commune_id::text,'') ||
        coalesce(NEW.utilisateur_id::text,'') ||
        NEW.action::text || NEW.entite ||
        coalesce(NEW.entite_id::text,'') ||
        coalesce(NEW.valeurs_avant::text,'') ||
        coalesce(NEW.valeurs_apres::text,'') ||
        NEW.horodatage::text,
        'sha256'), 'hex');
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION audit.verifier_chaine()
RETURNS TABLE(rupture_id bigint, rupture_horodatage timestamptz, rupture_motif text)
LANGUAGE plpgsql AS $$
DECLARE r record; v_prec text := NULL; v_calc text; v_attendu bigint := 0;
BEGIN
    FOR r IN SELECT * FROM audit.journal ORDER BY rang LOOP
        v_attendu := v_attendu + 1;

        -- Un trou dans les rangs signifie une entrée disparue. Le journal
        -- interdit la suppression ; si elle a tout de même eu lieu, elle ne
        -- doit pas passer inaperçue sous prétexte que les maillons restants
        -- s'enchaînent bien entre eux.
        IF r.rang IS DISTINCT FROM v_attendu THEN
            rupture_id := r.id;
            rupture_horodatage := r.horodatage;
            rupture_motif := format('rang %s attendu, %s trouve : entree manquante',
                                    v_attendu, coalesce(r.rang::text, 'aucun'));
            RETURN NEXT;
            RETURN;
        END IF;

        v_calc := encode(digest(
            coalesce(v_prec,'') ||
            coalesce(r.commune_id::text,'') ||
            coalesce(r.utilisateur_id::text,'') ||
            r.action::text || r.entite ||
            coalesce(r.entite_id::text,'') ||
            coalesce(r.valeurs_avant::text,'') ||
            coalesce(r.valeurs_apres::text,'') ||
            r.horodatage::text,
            'sha256'), 'hex');

        IF r.empreinte IS NULL THEN
            v_prec := NULL;
            CONTINUE;
        END IF;

        IF r.empreinte_precedente IS DISTINCT FROM v_prec THEN
            rupture_id := r.id;
            rupture_horodatage := r.horodatage;
            rupture_motif := 'empreinte precedente incoherente';
            RETURN NEXT;
            RETURN;
        END IF;

        IF r.empreinte IS DISTINCT FROM v_calc THEN
            rupture_id := r.id;
            rupture_horodatage := r.horodatage;
            rupture_motif := 'empreinte recalculee differente';
            RETURN NEXT;
            RETURN;
        END IF;

        v_prec := r.empreinte;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION audit.verifier_chaine IS
  'Relit le journal par rang — le seul ordre fidèle au chaînage — et signale '
  'la première incohérence : maillon manquant, parent incohérent, ou empreinte '
  'ne correspondant pas au contenu.';
