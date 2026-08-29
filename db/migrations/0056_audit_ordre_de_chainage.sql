-- 0056 — La chaîne d'audit se vérifie dans l'ordre où elle a été écrite
--
-- Le verrou de la migration 0055 empêche bien deux écritures de s'accrocher au
-- même parent. La chaîne restait pourtant signalée comme rompue, pour une
-- raison différente et plus subtile : elle était PARCOURUE dans un ordre qui
-- n'est pas celui de son écriture.
--
-- `horodatage` vaut `now()`, c'est-à-dire l'heure de DÉBUT de la transaction,
-- pas celle de l'insertion. Deux transactions qui se chevauchent produisent
-- donc des horodatages dont l'ordre ne suit pas celui des écritures :
--
--     T1 commence à 10:00:00,00   ─────────────┐ écrit à 10:00:00,42
--     T2 commence à 10:00:00,15   ──┐ attend le verrou │
--                                   └── écrit à 10:00:00,55
--
-- T2 s'accroche correctement à la dernière entrée de T1, mais son horodatage
-- est ANTÉRIEUR. Trié par horodatage, T2 passe avant T1 : la vérification
-- constate une empreinte précédente qui ne correspond pas, et crie à
-- l'altération alors que la chaîne est intacte.
--
-- L'ordre qui fait foi est celui de la séquence. Sous le verrou de 0055, une
-- transaction tient le verrou de sa première écriture jusqu'à sa validation :
-- aucune autre ne peut s'intercaler, et les identifiants suivent donc
-- exactement l'ordre du chaînage. C'est cet ordre-là qu'il faut suivre, à
-- l'écriture comme à la relecture.
--
-- L'horodatage reste dans l'empreinte : il est signé, donc infalsifiable. Il
-- cesse seulement de servir de critère de tri.

CREATE OR REPLACE FUNCTION audit.chainer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prec text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('audit.journal.chainage'));

    -- Par identifiant seul : c'est l'ordre d'écriture. Voir l'en-tête.
    SELECT j.empreinte INTO v_prec
      FROM audit.journal j ORDER BY j.id DESC LIMIT 1;

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
DECLARE r record; v_prec text := NULL; v_calc text;
BEGIN
    FOR r IN SELECT * FROM audit.journal ORDER BY id LOOP
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
            -- Entrée antérieure au chaînage : signalée, non traitée en rupture.
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
  'Relit le journal dans l''ordre de la séquence — celui de l''écriture — et '
  'signale la première incohérence. Trier par horodatage serait faux : cette '
  'colonne porte l''heure de début de transaction, pas celle de l''écriture.';
