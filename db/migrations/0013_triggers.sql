-- ===========================================================================
--  0013 — Déclencheurs : audit automatique et cohérence des montants
--
--  L'audit n'est pas laissé à la bonne volonté de l'API : il est posé sur les
--  tables. Une modification faite depuis psql, un script d'import ou un
--  correctif à chaud laisse exactement la même trace qu'une action de l'app.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Déclencheur d'audit générique
--
-- Ne journalise que les champs RÉELLEMENT modifiés : sur 5 443 commerces
-- visités chaque mois, journaliser la ligne entière saturerait le disque
-- en quelques mois et rendrait le journal illisible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.trg_journaliser()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = app, ref, audit, public
AS $$
DECLARE
    v_action        audit.action_audit;
    -- Lignes complètes, converties une fois pour toutes. On évite
    -- `coalesce(NEW, OLD)` : PostgreSQL ne sait pas résoudre le type d'un
    -- coalesce entre deux variables de type record.
    v_new_json      jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
    v_old_json      jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
    v_ligne         jsonb;
    v_avant         jsonb;
    v_apres         jsonb;
    v_champs        text[];
    v_commune_id    uuid;
    v_entite_id     uuid;
    v_libelle       text;
    v_utilisateur   uuid;
    v_nom           text;
    v_role          app.role_utilisateur;
    v_cle           text;
    -- Champs purement techniques : les journaliser n'apporte rien
    v_ignores       text[] := ARRAY['modifie_le','modifie_par','version',
                                    'statut_fiscal_calcule_le','nb_visites',
                                    'derniere_visite_le','derniere_visite_par',
                                    'nb_scans','dernier_scan_le','nb_verifications'];
BEGIN
    v_ligne := coalesce(v_new_json, v_old_json);

    IF TG_OP = 'INSERT' THEN
        v_action := 'creation';
        v_apres  := v_new_json;
        v_avant  := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
        v_avant := v_old_json;
        v_apres := v_new_json;

        SELECT array_agg(k) INTO v_champs
        FROM jsonb_object_keys(v_apres) AS k
        WHERE NOT (k = ANY (v_ignores))
          AND v_avant -> k IS DISTINCT FROM v_apres -> k;

        -- Rien de significatif n'a changé : on ne pollue pas le journal
        IF v_champs IS NULL OR array_length(v_champs, 1) IS NULL THEN
            RETURN NEW;
        END IF;

        -- L'archivage est une action à part : c'est ce qui s'approche le plus
        -- d'une suppression, et c'est ce qu'un contrôleur cherchera en premier.
        IF v_avant->>'archive_le' IS NULL AND v_apres->>'archive_le' IS NOT NULL THEN
            v_action := 'archivage';
        ELSE
            v_action := 'modification';
        END IF;

        -- On ne conserve que les champs modifiés
        SELECT jsonb_object_agg(k, v_avant -> k) INTO v_avant
          FROM unnest(v_champs) AS k;
        SELECT jsonb_object_agg(k, v_apres -> k) INTO v_apres
          FROM unnest(v_champs) AS k;
    ELSE
        -- Une suppression physique ne devrait jamais arriver : on la journalise
        -- intégralement pour qu'elle soit reconstituable.
        v_action := 'archivage';
        v_avant  := v_old_json;
        v_apres  := NULL;
    END IF;

    -- Identifiants de la ligne concernée
    v_cle := v_ligne ->> 'id';
    BEGIN
        v_entite_id := v_cle::uuid;
    EXCEPTION WHEN OTHERS THEN
        v_entite_id := NULL;      -- clé bigserial (qr_scan, sync_operation)
    END;

    v_commune_id := nullif(coalesce(v_ligne ->> 'commune_id', ''), '')::uuid;

    -- Libellé lisible : sans lui, relire le journal six mois plus tard
    -- oblige à faire des jointures manuelles sur des UUID.
    v_libelle := coalesce(
        v_ligne ->> 'code',
        v_ligne ->> 'numero',
        v_ligne ->> 'enseigne',
        v_ligne ->> 'nom',
        v_ligne ->> 'reference'
    );

    v_utilisateur := app.utilisateur_courant();
    IF v_utilisateur IS NOT NULL THEN
        SELECT u.nom_complet, u.role INTO v_nom, v_role
          FROM app.utilisateur u WHERE u.id = v_utilisateur;
    END IF;

    INSERT INTO audit.journal (
        commune_id, utilisateur_id, utilisateur_nom, utilisateur_role, ip,
        action, entite, entite_id, entite_libelle,
        valeurs_avant, valeurs_apres, champs_modifies,
        montant, reference
    ) VALUES (
        coalesce(v_commune_id, app.commune_courante()),
        v_utilisateur, v_nom, v_role, app.ip_courante(),
        v_action, TG_TABLE_NAME, v_entite_id, v_libelle,
        v_avant, v_apres, v_champs,
        nullif(v_ligne ->> 'montant', '')::numeric,
        v_ligne ->> 'reference'
    );

    -- Déclencheur AFTER : la valeur de retour est ignorée par PostgreSQL.
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION audit.trg_journaliser IS
'Journalise les changements. SECURITY DEFINER : l''application peut écrire dans le journal sans jamais pouvoir le modifier.';

-- ---------------------------------------------------------------------------
-- Pose du déclencheur sur les tables sensibles
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    t text;
    tables_auditees text[] := ARRAY[
        'commune', 'commune_parametre', 'zone', 'quartier', 'marche',
        'utilisateur', 'affectation_agent',
        'commerce', 'commerce_photo', 'qr_code',
        'bareme_taxe', 'bareme_tranche', 'commerce_taxe', 'exoneration',
        'periode_fiscale', 'avis_imposition', 'avis_ligne',
        'paiement', 'transaction_wave', 'quittance'
    ];
BEGIN
    FOREACH t IN ARRAY tables_auditees LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_audit_%1$s ON app.%1$s;
             CREATE TRIGGER trg_audit_%1$s
             AFTER INSERT OR UPDATE OR DELETE ON app.%1$s
             FOR EACH ROW EXECUTE FUNCTION audit.trg_journaliser();', t);
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Incrémentation du compteur de version du commerce
-- Base de la détection de conflit lors de la synchronisation hors-ligne.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.trg_incrementer_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.version := coalesce(OLD.version, 0) + 1;
    RETURN NEW;
END;
$$;

-- Pas de clause WHEN (OLD.* IS DISTINCT FROM NEW.*) : PostgreSQL l'interdit
-- sur un déclencheur BEFORE d'une table comportant des colonnes générées
-- (ici enseigne_normalisee). La version est donc incrémentée à chaque UPDATE,
-- ce qui va dans le bon sens : la détection de conflit reste prudente.
DROP TRIGGER IF EXISTS trg_commerce_version ON app.commerce;
CREATE TRIGGER trg_commerce_version
    BEFORE UPDATE ON app.commerce
    FOR EACH ROW
    EXECUTE FUNCTION app.trg_incrementer_version();

-- ---------------------------------------------------------------------------
-- Report automatique d'un paiement sur son avis
--
-- Le montant payé d'un avis est TOUJOURS recalculé depuis la somme des
-- paiements non annulés. Aucune addition incrémentale : c'est ce qui évite
-- qu'un webhook Wave rejoué double le montant encaissé.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.trg_maj_avis_apres_paiement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_avis_id  uuid;
    v_paye     numeric;
    v_total    numeric;
    v_commerce uuid;
BEGIN
    v_avis_id  := coalesce(NEW.avis_id, OLD.avis_id);
    v_commerce := coalesce(NEW.commerce_id, OLD.commerce_id);

    IF v_avis_id IS NOT NULL THEN
        SELECT coalesce(sum(p.montant), 0)
          INTO v_paye
          FROM app.paiement p
         WHERE p.avis_id = v_avis_id AND p.annule_le IS NULL;

        SELECT a.montant_total INTO v_total
          FROM app.avis_imposition a WHERE a.id = v_avis_id;

        -- Un versement supérieur au dû (arrondi Wave, paiement anticipé)
        -- est plafonné : le trop-perçu se règle par un avoir, pas par un
        -- montant_paye incohérent.
        v_paye := least(v_paye, v_total);

        UPDATE app.avis_imposition
           SET montant_paye  = v_paye,
               statut = (CASE
                            WHEN v_paye >= v_total AND v_total > 0 THEN 'paye'
                            WHEN v_paye > 0                        THEN 'partiellement_paye'
                            ELSE 'emis'
                         END)::app.statut_avis,
               date_paiement = CASE WHEN v_paye >= v_total AND v_total > 0
                                    THEN coalesce(date_paiement, now()) END
         WHERE id = v_avis_id;
    END IF;

    IF v_commerce IS NOT NULL THEN
        PERFORM app.recalculer_statut_fiscal(v_commerce);
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_paiement_maj_avis ON app.paiement;
CREATE TRIGGER trg_paiement_maj_avis
    AFTER INSERT OR UPDATE OR DELETE ON app.paiement
    FOR EACH ROW EXECUTE FUNCTION app.trg_maj_avis_apres_paiement();

-- ---------------------------------------------------------------------------
-- Mise à jour du compteur de visites du commerce
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.trg_maj_commerce_apres_visite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.commerce_id IS NOT NULL THEN
        UPDATE app.commerce
           SET nb_visites          = nb_visites + 1,
               derniere_visite_le  = NEW.debute_le,
               derniere_visite_par = NEW.agent_id
         WHERE id = NEW.commerce_id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_visite_maj_commerce ON app.visite;
CREATE TRIGGER trg_visite_maj_commerce
    AFTER INSERT ON app.visite
    FOR EACH ROW EXECUTE FUNCTION app.trg_maj_commerce_apres_visite();

-- ---------------------------------------------------------------------------
-- Calcul automatique de l'écart entre l'agent et le commerce
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.trg_calculer_distance_visite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_geom geometry;
BEGIN
    IF NEW.geom IS NOT NULL AND NEW.commerce_id IS NOT NULL THEN
        SELECT geom INTO v_geom FROM app.commerce WHERE id = NEW.commerce_id;
        NEW.distance_commerce_m := app.distance_metres(NEW.geom, v_geom);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_visite_distance ON app.visite;
CREATE TRIGGER trg_visite_distance
    BEFORE INSERT ON app.visite
    FOR EACH ROW EXECUTE FUNCTION app.trg_calculer_distance_visite();

-- ---------------------------------------------------------------------------
-- Cohérence : le quartier d'un commerce doit appartenir à sa zone,
-- et la zone à sa commune. Sans ce contrôle, un commerce peut se retrouver
-- comptabilisé dans deux zones différentes selon la statistique consultée.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.trg_verifier_coherence_territoire()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_zone_commune    uuid;
    v_quartier_zone   uuid;
    v_quartier_commune uuid;
BEGIN
    SELECT commune_id INTO v_zone_commune FROM app.zone WHERE id = NEW.zone_id;
    SELECT zone_id, commune_id INTO v_quartier_zone, v_quartier_commune
      FROM app.quartier WHERE id = NEW.quartier_id;

    IF v_zone_commune <> NEW.commune_id THEN
        RAISE EXCEPTION 'La zone % n''appartient pas à la commune %', NEW.zone_id, NEW.commune_id;
    END IF;
    IF v_quartier_commune <> NEW.commune_id THEN
        RAISE EXCEPTION 'Le quartier % n''appartient pas à la commune %', NEW.quartier_id, NEW.commune_id;
    END IF;
    IF v_quartier_zone <> NEW.zone_id THEN
        RAISE EXCEPTION 'Le quartier % appartient à la zone % et non à la zone %',
            NEW.quartier_id, v_quartier_zone, NEW.zone_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commerce_coherence ON app.commerce;
CREATE TRIGGER trg_commerce_coherence
    BEFORE INSERT OR UPDATE OF commune_id, zone_id, quartier_id ON app.commerce
    FOR EACH ROW EXECUTE FUNCTION app.trg_verifier_coherence_territoire();
