-- 0062 — L'empreinte du journal ne doit plus dépendre du fuseau de la session
--
-- La chaîne d'audit se calculait sur `horodatage::text`. Or le rendu texte
-- d'un timestamptz dépend du réglage TimeZone DE LA SESSION : la même ligne,
-- relue depuis une machine réglée autrement, produit une autre empreinte.
--
-- Conséquence : la chaîne ne se vérifiait que sur la machine qui l'avait
-- écrite. Mesuré sur la sauvegarde du 29/08/2026, restaurée ailleurs — 1172
-- lignes, écrites sous UTC+3 :
--
--     SET TimeZone='Etc/GMT-3'  ->  0 rupture
--     SET TimeZone='Etc/UTC'    ->  rupture au rang 1, aucune ligne conforme
--     SET TimeZone='Africa/Dakar' (le fuseau de production) -> rupture
--
-- C'est le pire des défauts pour un dispositif anti-fraude : il ne se tait
-- pas, il crie. Sur le serveur de Dakar, l'alarme aurait sonné dès la première
-- ligne, tous les jours, pour une raison innocente — jusqu'à ce que plus
-- personne ne la regarde. Le commit 0057 avait déjà écarté ce piège pour
-- l'ORDRE des maillons ; il restait entier pour leur CONTENU.
--
-- Le rendu est désormais imposé : instant converti en UTC, format explicite,
-- précision à la microseconde. `to_char` avec un masque entièrement numérique
-- ne dépend ni de TimeZone, ni de DateStyle, ni de lc_time.
--
-- ATTENTION — cette migration ne réécrit AUCUNE empreinte existante. Les
-- lignes déjà au journal restent scellées sous l'ancienne règle et seront donc
-- signalées en rupture. Les resceller est un acte distinct, délibéré, réservé
-- au propriétaire de la table : voir scripts/resceller-journal-audit.sh. Une
-- migration qui réécrirait d'elle-même un journal réputé inaltérable serait
-- précisément ce que ce journal existe pour empêcher.

-- ---------------------------------------------------------------------------
-- Le rendu canonique, en un seul endroit : les deux fonctions ci-dessous
-- DOIVENT s'accorder, et le seul moyen sûr est qu'elles appellent la même.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.horodatage_canonique(p_instant timestamptz)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT to_char(p_instant AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

COMMENT ON FUNCTION audit.horodatage_canonique(timestamptz) IS
'Rendu texte d''un instant, indépendant du fuseau et du format de la session. '
'Utilisé pour le calcul des empreintes du journal d''audit : deux machines '
'réglées différemment doivent obtenir la même chaîne.';

-- ---------------------------------------------------------------------------
-- Écriture d'un maillon
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.chainer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
        audit.horodatage_canonique(NEW.horodatage),
        'sha256'), 'hex');
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Relecture de la chaîne
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.verifier_chaine()
RETURNS TABLE(rupture_id bigint, rupture_horodatage timestamptz, rupture_motif text)
LANGUAGE plpgsql
AS $$
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
            audit.horodatage_canonique(r.horodatage),
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
