-- ===========================================================================
--  0037 — La quittance suit le redevable
--
--  Suite directe de 0036. Le paiement d'une régie publicitaire s'enregistrait
--  enfin, puis échouait une ligne plus loin : app.quittance.commerce_id était
--  NOT NULL à son tour.
--
--  L'HYPOTHÈSE ÉTAIT ENFOUIE À PLUSIEURS NIVEAUX. « Tout part d'un commerce »
--  n'était pas écrit à un endroit, mais reproduit dans chaque table de la
--  chaîne d'encaissement. La corriger une fois ne suffisait pas.
--
--  D'où l'inventaire complet fait à cette occasion :
--
--    commerce_photo   — une photo EST celle d'un commerce. Inchangé ;
--                       les dispositifs et chantiers ont leurs propres
--                       photos, rattachées autrement.
--    commerce_taxe    — le lien commerce/taxe. Inchangé par construction.
--    exoneration      — accordée sur un commerce précis. Inchangé pour
--                       l'instant : exonérer un panneau n'a pas encore de
--                       sens métier tranché avec la mairie.
--    qr_code, qr_scan — le QR est apposé sur une devanture. Inchangé.
--    quittance        — CORRIGÉ ici : c'est une facture qu'on acquitte, et
--                       une facture est adressée à un redevable.
--
--  Les cinq premières restent volontairement liées au commerce. Ce n'est pas
--  un oubli : ce sont des objets qui n'existent que pour un commerce.
-- ===========================================================================

ALTER TABLE app.quittance
    ADD COLUMN IF NOT EXISTS redevable_id uuid REFERENCES app.redevable(id) ON DELETE RESTRICT;

-- La quittance ne connaît pas l'avis : elle est rattachée au PAIEMENT, qui
-- lui-même porte l'avis. Deux sauts, pas un.
UPDATE app.quittance q
   SET redevable_id = coalesce(p.redevable_id, a.redevable_id)
  FROM app.paiement p
  LEFT JOIN app.avis_imposition a ON a.id = p.avis_id
 WHERE q.paiement_id = p.id AND q.redevable_id IS NULL;

UPDATE app.quittance q
   SET redevable_id = c.redevable_id
  FROM app.commerce c
 WHERE q.commerce_id = c.id AND q.redevable_id IS NULL;

ALTER TABLE app.quittance ALTER COLUMN commerce_id DROP NOT NULL;

DO $$
DECLARE v_orphelines integer;
BEGIN
    SELECT count(*) INTO v_orphelines FROM app.quittance WHERE redevable_id IS NULL;
    IF v_orphelines > 0 THEN
        RAISE WARNING '% quittance(s) sans redevable rattachable.', v_orphelines;
    ELSE
        ALTER TABLE app.quittance ALTER COLUMN redevable_id SET NOT NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_quittance_redevable
    ON app.quittance (redevable_id, genere_le DESC);

COMMENT ON COLUMN app.quittance.commerce_id IS
'Objet concerné quand il y en a un seul. NULL pour une régie publicitaire ou une quittance consolidée.';

-- Même garde-fou que pour le paiement : la quittance est produite par le
-- webhook, par le planificateur et par une réimpression au guichet.
CREATE OR REPLACE FUNCTION app.quittance_completer_redevable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.redevable_id IS NULL AND NEW.paiement_id IS NOT NULL THEN
        SELECT coalesce(p.redevable_id, a.redevable_id) INTO NEW.redevable_id
          FROM app.paiement p
          LEFT JOIN app.avis_imposition a ON a.id = p.avis_id
         WHERE p.id = NEW.paiement_id;
    END IF;
    IF NEW.redevable_id IS NULL AND NEW.commerce_id IS NOT NULL THEN
        SELECT c.redevable_id INTO NEW.redevable_id
          FROM app.commerce c WHERE c.id = NEW.commerce_id;
    END IF;
    IF NEW.redevable_id IS NULL THEN
        RAISE EXCEPTION 'Quittance sans redevable : impossible de savoir qui a acquitté. '
            'Renseignez le paiement ou le commerce.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quittance_redevable ON app.quittance;
CREATE TRIGGER trg_quittance_redevable
    BEFORE INSERT ON app.quittance
    FOR EACH ROW
    EXECUTE FUNCTION app.quittance_completer_redevable();

-- ---------------------------------------------------------------------------
-- Contrôle de cohérence, à rejouer après toute évolution du modèle
--
--  Recense les tables de la chaîne d'encaissement qui exigeraient encore un
--  commerce. Sans ce garde-fou, le défaut se redécouvre là où il coûte le
--  plus cher : au moment où quelqu'un a déjà payé.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_tables_exigeant_commerce AS
SELECT c.table_name, c.column_name,
       CASE c.table_name
         WHEN 'commerce_photo' THEN 'Normal — une photo de devanture est celle d''un commerce'
         WHEN 'commerce_taxe'  THEN 'Normal — table de liaison commerce/taxe'
         WHEN 'exoneration'    THEN 'À revoir si la commune exonère un jour un panneau ou un chantier'
         WHEN 'qr_code'        THEN 'Normal — le QR est apposé sur une devanture'
         WHEN 'qr_scan'        THEN 'Normal — trace de scan d''un QR de devanture'
         ELSE 'À VÉRIFIER — cette table est-elle sur le chemin d''une facture ?'
       END AS analyse
  FROM information_schema.columns c
 WHERE c.table_schema = 'app'
   AND c.column_name = 'commerce_id'
   AND c.is_nullable = 'NO';

COMMENT ON VIEW app.v_tables_exigeant_commerce IS
'Tables exigeant encore un commerce. Toute ligne marquée « À VÉRIFIER » est un endroit où une facture de redevable sans commerce échouera.';
