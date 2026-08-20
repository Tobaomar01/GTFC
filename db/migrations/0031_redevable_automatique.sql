-- ===========================================================================
--  0031 — Rattachement automatique d'un commerce à son redevable
--
--  LE PROBLÈME DE TRANSITION
--
--  app.commerce.redevable_id est devenu obligatoire en 0025. Or l'API, les
--  seeds et surtout l'APPLICATION MOBILE DÉJÀ INSTALLÉE sur les téléphones
--  des agents ignorent tout du redevable : ils enregistrent un commerce avec
--  un nom de gérant et un numéro de téléphone, comme avant.
--
--  Sans ce déclencheur, la première synchronisation depuis le terrain
--  échouerait sur une violation de contrainte, et l'agent verrait « erreur
--  de synchronisation » sans rien pouvoir y faire — avec la journée de
--  recensement bloquée dans sa file d'attente locale.
--
--  LA RÈGLE APPLIQUÉE
--
--  Elle est celle du document : le numéro de téléphone identifie le
--  redevable. Un commerce enregistré avec un numéro déjà connu rejoint le
--  redevable existant ; un numéro inconnu en crée un nouveau ; sans numéro,
--  un redevable propre au commerce est créé.
--
--  Ce n'est donc pas une commodité technique mais la règle métier elle-même,
--  posée à un seul endroit plutôt que réécrite dans l'API, dans le mobile et
--  dans chaque script d'import.
--
--  CE QUE LE DÉCLENCHEUR NE FAIT PAS
--  Il ne déclare jamais un numéro vérifié. La vérification suppose qu'un code
--  a été envoyé et relu par le redevable ; la déduire d'une saisie serait
--  exactement le mensonge qui rend un redevable injoignable à l'échéance.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.commerce_rattacher_redevable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_tel   text;
    v_code  text;
    v_seq   integer;
    v_id    uuid;
BEGIN
    IF NEW.redevable_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    v_tel := coalesce(nullif(NEW.telephone_paiement, ''), nullif(NEW.gerant_telephone, ''));

    IF v_tel IS NOT NULL THEN
        SELECT r.id INTO v_id
          FROM app.redevable r
         WHERE r.commune_id = NEW.commune_id
           AND r.telephone  = v_tel
           AND r.archive_le IS NULL;
    END IF;

    IF v_id IS NULL THEN
        SELECT g.code, g.numero_sequence INTO v_code, v_seq
          FROM app.generer_code_redevable(NEW.commune_id) g;

        INSERT INTO app.redevable (
            commune_id, code, numero_sequence, type_redevable,
            nom, prenom, telephone, statut_telephone,
            ninea, piece_type, piece_numero,
            quartier_id, rue_id, adresse_libelle, origine, cree_par
        ) VALUES (
            NEW.commune_id, v_code, v_seq, 'personne_physique',
            -- Sans gérant renseigné, l'enseigne fait office de désignation :
            -- un dossier sans nom est introuvable au guichet.
            coalesce(nullif(NEW.gerant_nom, ''), NEW.enseigne),
            nullif(NEW.gerant_prenom, ''),
            v_tel,
            'non_verifie',
            nullif(NEW.ninea, ''),
            nullif(NEW.gerant_piece_type, ''),
            nullif(NEW.gerant_piece_numero, ''),
            NEW.quartier_id, NEW.rue_id, NEW.adresse_libelle,
            coalesce(NEW.origine, 'terrain'), NEW.cree_par
        )
        RETURNING id INTO v_id;
    END IF;

    NEW.redevable_id := v_id;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.commerce_rattacher_redevable IS
'Applique la règle « un numéro de téléphone = un redevable » à l''insertion d''un commerce. Permet à l''API et à l''application mobile existantes de continuer à fonctionner sans connaître le nouveau modèle.';

DROP TRIGGER IF EXISTS trg_commerce_redevable ON app.commerce;
CREATE TRIGGER trg_commerce_redevable
    BEFORE INSERT ON app.commerce
    FOR EACH ROW
    EXECUTE FUNCTION app.commerce_rattacher_redevable();

-- ---------------------------------------------------------------------------
-- Le compteur d'objets du redevable suit les commerces
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.commerce_maj_compteur_redevable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM app.rafraichir_nb_objets(NEW.redevable_id);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM app.rafraichir_nb_objets(OLD.redevable_id);
    ELSE
        -- Un commerce peut changer de mains : les deux dossiers bougent.
        PERFORM app.rafraichir_nb_objets(OLD.redevable_id);
        IF NEW.redevable_id IS DISTINCT FROM OLD.redevable_id THEN
            PERFORM app.rafraichir_nb_objets(NEW.redevable_id);
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_commerce_compteur_redevable ON app.commerce;
CREATE TRIGGER trg_commerce_compteur_redevable
    AFTER INSERT OR DELETE OR UPDATE OF redevable_id, archive_le ON app.commerce
    FOR EACH ROW
    EXECUTE FUNCTION app.commerce_maj_compteur_redevable();

-- ---------------------------------------------------------------------------
-- Un dispositif d'affichage rattaché à un commerce hérite de son redevable
--
--  L'agent qui recense une enseigne sur une devanture n'a aucune raison de
--  ressaisir le propriétaire : il est déjà sur la fiche du commerce.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.affichage_heriter_redevable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.redevable_id IS NULL AND NEW.commerce_id IS NOT NULL THEN
        SELECT c.redevable_id INTO NEW.redevable_id
          FROM app.commerce c WHERE c.id = NEW.commerce_id;
    END IF;

    IF NEW.redevable_id IS NULL THEN
        RAISE EXCEPTION
          'Un dispositif d''affichage doit avoir un redevable : c''est lui qui reçoit la facture. '
          'Rattachez-le à un commerce, ou désignez l''annonceur (régie, profession libérale).';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_affichage_redevable ON app.dispositif_affichage;
CREATE TRIGGER trg_affichage_redevable
    BEFORE INSERT ON app.dispositif_affichage
    FOR EACH ROW
    EXECUTE FUNCTION app.affichage_heriter_redevable();

-- ---------------------------------------------------------------------------
-- Compteur de couverture par rue
--
--  Tenu par la base plutôt que par l'API : le recensement arrive aussi par
--  synchronisation hors-ligne et par import, et un compteur mis à jour à
--  trois endroits finit toujours par être faux à l'un d'eux.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.rue_maj_compteur()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_rues uuid[];
BEGIN
    v_rues := ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[
        CASE WHEN TG_OP <> 'INSERT' THEN OLD.rue_id END,
        CASE WHEN TG_OP <> 'DELETE' THEN NEW.rue_id END
    ]) AS x WHERE x IS NOT NULL);

    UPDATE app.rue r
       SET nb_objets_recenses = (
             SELECT count(*) FROM app.commerce c
              WHERE c.rue_id = r.id AND c.archive_le IS NULL)
           + (SELECT count(*) FROM app.dispositif_affichage d
               WHERE d.rue_id = r.id AND d.archive_le IS NULL)
     WHERE r.id = ANY(v_rues);

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_commerce_compteur_rue ON app.commerce;
CREATE TRIGGER trg_commerce_compteur_rue
    AFTER INSERT OR DELETE OR UPDATE OF rue_id, archive_le ON app.commerce
    FOR EACH ROW EXECUTE FUNCTION app.rue_maj_compteur();

DROP TRIGGER IF EXISTS trg_affichage_compteur_rue ON app.dispositif_affichage;
CREATE TRIGGER trg_affichage_compteur_rue
    AFTER INSERT OR DELETE OR UPDATE OF rue_id, archive_le ON app.dispositif_affichage
    FOR EACH ROW EXECUTE FUNCTION app.rue_maj_compteur();
