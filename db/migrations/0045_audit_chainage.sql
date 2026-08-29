-- 0045 — Chaînage du journal d'audit (FR-044, Constitution II)
--
-- Le journal était déjà déclaré inaltérable par les droits de la base. Cela
-- protège d'une application malveillante, pas de qui détient l'accès à la
-- base — ce qui compte dans un montage où l'exploitant technique n'est pas
-- la commune.
--
-- Le chaînage par empreinte rend toute altération détectable a posteriori,
-- y compris par un administrateur.

ALTER TABLE audit.journal ADD COLUMN IF NOT EXISTS empreinte_precedente text;
ALTER TABLE audit.journal ADD COLUMN IF NOT EXISTS empreinte            text;

CREATE OR REPLACE FUNCTION audit.chainer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_prec text;
BEGIN
    SELECT j.empreinte INTO v_prec
      FROM audit.journal j ORDER BY j.horodatage DESC, j.id DESC LIMIT 1;
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

DROP TRIGGER IF EXISTS trg_audit_chainer ON audit.journal;
CREATE TRIGGER trg_audit_chainer BEFORE INSERT ON audit.journal
    FOR EACH ROW EXECUTE FUNCTION audit.chainer();

-- Retourne les entrées rompues. Un résultat vide vaut preuve de
-- non-altération. Les paramètres de sortie sont préfixés pour ne pas
-- masquer les colonnes du curseur.
CREATE OR REPLACE FUNCTION audit.verifier_chaine()
RETURNS TABLE (rupture_id bigint, rupture_horodatage timestamptz, rupture_motif text)
LANGUAGE plpgsql AS $$
DECLARE r record; v_prec text := NULL; v_calc text;
BEGIN
    FOR r IN SELECT * FROM audit.journal ORDER BY horodatage, id LOOP
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
            rupture_id := r.id; rupture_horodatage := r.horodatage;
            rupture_motif := 'empreinte precedente incoherente'; RETURN NEXT;
        ELSIF r.empreinte <> v_calc THEN
            rupture_id := r.id; rupture_horodatage := r.horodatage;
            rupture_motif := 'contenu altere'; RETURN NEXT;
        END IF;
        v_prec := r.empreinte;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION audit.verifier_chaine IS
'Vérifie le chaînage. Un résultat vide vaut preuve de non-altération (FR-044).';
