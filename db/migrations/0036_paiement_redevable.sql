-- ===========================================================================
--  0036 — Un paiement peut ne pas porter sur un commerce
--
--  CE QUI ÉTAIT CASSÉ, ET COMMENT ON L'A VU
--
--  app.paiement.commerce_id était NOT NULL, héritage du modèle où tout
--  tournait autour du commerce.
--
--  Depuis la migration 0027, une facture peut être adressée à un redevable
--  qui n'en possède aucun : une régie publicitaire exploitant huit panneaux
--  sur un boulevard est redevable de la taxe d'affichage sans tenir la
--  moindre boutique.
--
--  Le lien de paiement se créait correctement. Le redevable payait. Et le
--  webhook Wave échouait à l'enregistrement, en journalisant « À REPRENDRE
--  MANUELLEMENT ».
--
--  C'est le pire scénario possible : l'argent est parti du téléphone du
--  redevable, il a la confirmation Wave sous les yeux, et la commune n'a
--  aucune trace de l'encaissement. Le commerçant revient au guichet avec son
--  SMS, et personne ne peut lui donner raison.
--
--  Le défaut ne se voyait que sur ce cas précis — un payeur sans commerce —
--  et seulement au moment de l'encaissement, pas à la facturation.
--
--  CE QUI CHANGE
--
--  Le paiement porte désormais le REDEVABLE, qui est toujours présent, et le
--  commerce devient facultatif. C'est l'ordre naturel : on paie une facture,
--  et une facture est adressée à quelqu'un.
-- ===========================================================================

ALTER TABLE app.paiement
    ADD COLUMN IF NOT EXISTS redevable_id uuid REFERENCES app.redevable(id) ON DELETE RESTRICT;

-- Reprise : le redevable se déduit de l'avis, ou à défaut du commerce.
UPDATE app.paiement p
   SET redevable_id = a.redevable_id
  FROM app.avis_imposition a
 WHERE p.avis_id = a.id AND p.redevable_id IS NULL;

UPDATE app.paiement p
   SET redevable_id = c.redevable_id
  FROM app.commerce c
 WHERE p.commerce_id = c.id AND p.redevable_id IS NULL;

-- Le commerce cesse d'être obligatoire.
ALTER TABLE app.paiement ALTER COLUMN commerce_id DROP NOT NULL;

-- Un encaissement sans destinataire connu serait un encaissement qu'on ne
-- sait rattacher à personne : c'est le redevable qui devient obligatoire.
DO $$
DECLARE v_orphelins integer;
BEGIN
    SELECT count(*) INTO v_orphelins FROM app.paiement WHERE redevable_id IS NULL;
    IF v_orphelins > 0 THEN
        RAISE WARNING
          '% paiement(s) sans redevable rattachable — colonne laissée facultative. '
          'Vérifiez : SELECT * FROM app.paiement WHERE redevable_id IS NULL;', v_orphelins;
    ELSE
        ALTER TABLE app.paiement ALTER COLUMN redevable_id SET NOT NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_paiement_redevable
    ON app.paiement (redevable_id, paye_le DESC);

COMMENT ON COLUMN app.paiement.redevable_id IS
'Qui a payé. Toujours renseigné : c''est la facture qu''on solde, et une facture est adressée à un redevable.';
COMMENT ON COLUMN app.paiement.commerce_id IS
'Objet concerné quand il y en a un seul. NULL pour une régie publicitaire ou une facture consolidée sur plusieurs objets.';

-- ---------------------------------------------------------------------------
-- Le déclencheur qui remplit le redevable quand l'appelant l'oublie
--
--  Trois chemins écrivent dans cette table : le webhook Wave, l'encaissement
--  en espèces par un agent, et la synchronisation hors-ligne. Compter sur
--  chacun pour renseigner la colonne, c'est accepter qu'un des trois oublie.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.paiement_completer_redevable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.redevable_id IS NULL AND NEW.avis_id IS NOT NULL THEN
        SELECT a.redevable_id INTO NEW.redevable_id
          FROM app.avis_imposition a WHERE a.id = NEW.avis_id;
    END IF;

    IF NEW.redevable_id IS NULL AND NEW.commerce_id IS NOT NULL THEN
        SELECT c.redevable_id INTO NEW.redevable_id
          FROM app.commerce c WHERE c.id = NEW.commerce_id;
    END IF;

    IF NEW.redevable_id IS NULL THEN
        RAISE EXCEPTION
          'Paiement sans redevable : impossible de savoir qui a payé. '
          'Renseignez l''avis ou le commerce.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_paiement_redevable ON app.paiement;
CREATE TRIGGER trg_paiement_redevable
    BEFORE INSERT ON app.paiement
    FOR EACH ROW
    EXECUTE FUNCTION app.paiement_completer_redevable();

COMMENT ON FUNCTION app.paiement_completer_redevable IS
'Déduit le payeur de l''avis ou du commerce. Évite qu''un des trois chemins d''encaissement — Wave, espèces, synchronisation — oublie de le renseigner.';
