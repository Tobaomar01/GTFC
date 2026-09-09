-- ===========================================================================
--  Le statut fiscal du redevable n'etait jamais calcule
--
--  CE QUI A ETE CONSTATE, en ouvrant le portail sur un vrai telephone.
--
--  L'ecran affichait, cote a cote :
--
--      « Aucun avis emis »                                   (badge, en haut)
--      « A payer : 85 000 FCFA — avis GTFC-2026-000004 »
--
--  Le badge lit app.redevable.statut_fiscal. Or la migration 0035 avait ecrit
--  DEUX fonctions pour l'entretenir — app.recalculer_statut_redevable() et
--  app.recalculer_statuts_redevables() — et PERSONNE ne les appelle. Ni l'API,
--  ni un declencheur, ni le planificateur, ni les seeds. Mesure du 08/09/2026 :
--  129 redevables sur 132 restaient a « inconnu ».
--
--  La colonne prenait sa valeur par defaut a la creation et ne bougeait plus
--  jamais : un commercant qui paie serait reste « inconnu » a vie.
--
--  DEUX DEFAUTS, ET J'AI D'ABORD CONFONDU LES DEUX. Celui-ci — le statut jamais
--  entretenu — est reel et corrige ici. Mais la contradiction VUE A L'ECRAN
--  venait d'autre chose : le portail traduisait « inconnu » par « Aucun avis
--  emis », alors que la fonction rend DELIBEREMENT « inconnu » quand l'avis est
--  emis, son echeance a venir, et rien encore verse. Ce second defaut est
--  corrige cote interface, pas ici.
--
--  POURQUOI CELA N'AVAIT PAS ETE VU. Le statut du COMMERCE, lui, est bien
--  entretenu — declencheur a chaque paiement, passage nocturne. Les deux
--  colonnes portent le meme nom, et le tableau de bord de la mairie lit celle du
--  commerce. Seul le portail du redevable lit l'autre, et il n'avait jamais ete
--  ouvert sur un appareil reel.
--
--  UN DECLENCHEUR SEPARE, ET PAS UNE REECRITURE.
--
--  La tentation etait d'ajouter la ligne manquante dans
--  app.trg_maj_avis_apres_paiement(), qui recalcule deja le commerce. Mais
--  celle-la impute les versements : la reecrire pour y glisser un appel, c'est
--  risquer une faute de transcription sur le chemin de l'argent pour un badge
--  d'affichage. On ajoute donc un declencheur a cote, qui ne touche a rien.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.trg_statut_redevable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, public, pg_catalog
AS $$
DECLARE
    v_redevable uuid;
BEGIN
    -- Sur app.paiement on remonte a l'avis ; sur app.avis_imposition la
    -- colonne est portee directement.
    IF TG_TABLE_NAME = 'paiement' THEN
        SELECT a.redevable_id INTO v_redevable
          FROM app.avis_imposition a
         WHERE a.id = coalesce(NEW.avis_id, OLD.avis_id);
    ELSE
        v_redevable := coalesce(NEW.redevable_id, OLD.redevable_id);
    END IF;

    IF v_redevable IS NOT NULL THEN
        PERFORM app.recalculer_statut_redevable(v_redevable);
    END IF;

    RETURN NULL;
END;
$$;

-- Un versement change ce que le redevable doit.
DROP TRIGGER IF EXISTS trg_statut_redevable_paiement ON app.paiement;
CREATE TRIGGER trg_statut_redevable_paiement
    AFTER INSERT OR UPDATE OR DELETE ON app.paiement
    FOR EACH ROW EXECUTE FUNCTION app.trg_statut_redevable();

-- L'emission, l'annulation ou l'exoneration d'un avis aussi — et c'est meme le
-- cas le plus courant : le badge doit cesser de dire « aucun avis emis » a
-- l'instant ou le premier est emis.
DROP TRIGGER IF EXISTS trg_statut_redevable_avis ON app.avis_imposition;
CREATE TRIGGER trg_statut_redevable_avis
    AFTER INSERT OR DELETE OR UPDATE OF statut, montant_total, annule_le
    ON app.avis_imposition
    FOR EACH ROW EXECUTE FUNCTION app.trg_statut_redevable();

-- ---------------------------------------------------------------------------
--  Rattrapage de l'existant : ces redevables n'ont jamais eu de statut.
-- ---------------------------------------------------------------------------
DO $rattrapage$
DECLARE
    c       record;
    v_total integer := 0;
BEGIN
    FOR c IN SELECT id FROM app.commune LOOP
        v_total := v_total + coalesce(app.recalculer_statuts_redevables(c.id), 0);
    END LOOP;
    RAISE NOTICE 'Statuts de redevables rattrapes : %', v_total;
END
$rattrapage$;

-- ---------------------------------------------------------------------------
--  Verification : le declencheur agit-il vraiment ?
--
--  MA PREMIERE VERIFICATION ETAIT FAUSSE, et elle a fait echouer la migration —
--  ce qui est exactement son role. Je verifiais qu'aucun redevable portant un
--  avis emis ne reste « inconnu ». Or la fonction rend DELIBEREMENT « inconnu »
--  quand l'avis est emis, son echeance a venir, et rien encore verse : afficher
--  ce commercant en rouge serait injuste. 58 redevables etaient dans ce cas.
--
--  Le defaut n'etait donc pas le statut mais le LIBELLE du portail, corrige
--  cote interface. Ce qui reste vrai, et qu'on eprouve ici : un redevable dont
--  l'avis est integralement paye doit passer « a jour ». Sans le declencheur,
--  il restait « inconnu » a vie.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_restants integer;
BEGIN
    SELECT count(*) INTO v_restants
      FROM app.redevable r
     WHERE r.statut_fiscal = 'inconnu'
       AND EXISTS (SELECT 1 FROM app.avis_imposition a
                    WHERE a.redevable_id = r.id
                      AND a.statut = 'paye'
                      AND a.annule_le IS NULL);

    IF v_restants > 0 THEN
        RAISE EXCEPTION
            '% redevable(s) ont un avis integralement paye et restent « inconnu ».',
            v_restants;
    END IF;

    RAISE NOTICE 'Statut du redevable : un avis paye ne laisse plus « inconnu ».';
END
$verif$;
