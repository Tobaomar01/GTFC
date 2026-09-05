-- ===========================================================================
--  Un commerce archivé n'a plus de sticker actif
--
--  ÉTAT DE FAIT. Archiver un commerce posait archive_le, archive_par,
--  motif_archivage et statut, et laissait son QR marqué « actif » : un sticker
--  réputé en circulation sur une devanture qui n'est plus recensée. Mesuré sur
--  la base de recette : 26 stickers actifs sur des commerces archivés.
--
--  POURQUOI ICI ET PAS DANS LE SERVICE. Le correctif avait d'abord été porté
--  dans commerce.service.archiver(). Il était juste et ne suffisait pas : la
--  suite de tests archive ses propres fiches par un UPDATE SQL direct, sans
--  passer par le service, et le compteur a continué de monter — 20 puis 26 au
--  passage suivant. Une règle qui ne vaut que si l'on emprunte la bonne porte
--  n'est pas une règle. Ce schéma sait d'ailleurs déjà faire autrement :
--  qr_desactivation_coherente est une CONTRAINTE, et c'est pour cela qu'elle
--  tient.
--
--  POURQUOI UN DÉCLENCHEUR ET NON UNE CONTRAINTE. Une contrainte pourrait
--  interdire l'état incohérent, mais elle ferait alors ÉCHOUER l'archivage
--  d'un commerce dont le sticker est encore actif — c'est-à-dire le cas
--  nominal. On ne veut pas refuser l'archivage : on veut que le sticker suive.
--
--  POURQUOI SECURITY DEFINER. app.qr_code porte une politique d'isolation par
--  commune. Sans ce mode, l'UPDATE du déclencheur serait filtré par RLS dès
--  qu'une session n'a pas posé gtfc.commune_id — un script d'administration,
--  une migration, une console un soir d'incident — et ne toucherait aucune
--  ligne SANS RIEN DIRE. L'invariant doit tenir quelle que soit la porte, y
--  compris celles qui ne posent pas de contexte. La fonction reste étroite :
--  elle n'écrit que dans qr_code, et seulement pour le commerce archivé.
--
--  DÉSARCHIVAGE. Volontairement non traité. Un sticker désactivé l'a été
--  parce que la devanture ne le porte plus ; le remettre « actif » sur la foi
--  d'un désarchivage affirmerait quelque chose du monde physique qu'on ne sait
--  pas. Un commerce qui revient reçoit un nouveau sticker, daté.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.qr_suit_archivage_commerce()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
BEGIN
    UPDATE app.qr_code
       SET actif               = false,
           desactive_le        = COALESCE(NEW.archive_le, now()),
           motif_desactivation = 'commerce archivé'
     WHERE commerce_id = NEW.id
       AND actif;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.qr_suit_archivage_commerce IS
    'Désactive les stickers d''un commerce au moment où il est archivé. '
    'SECURITY DEFINER pour que l''invariant tienne même sans contexte de commune.';

DROP TRIGGER IF EXISTS trg_qr_suit_archivage ON app.commerce;

CREATE TRIGGER trg_qr_suit_archivage
    AFTER UPDATE OF archive_le ON app.commerce
    FOR EACH ROW
    WHEN (OLD.archive_le IS NULL AND NEW.archive_le IS NOT NULL)
    EXECUTE FUNCTION app.qr_suit_archivage_commerce();

COMMENT ON TRIGGER trg_qr_suit_archivage ON app.commerce IS
    'Un commerce archivé n''a plus de sticker actif, quelle que soit la voie '
    'd''écriture — service, SQL direct, migration ou console.';
