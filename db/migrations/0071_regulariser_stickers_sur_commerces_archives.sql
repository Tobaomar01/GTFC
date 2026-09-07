-- ===========================================================================
--  Regulariser les stickers restes actifs sur des commerces archives
--
--  Le declencheur trg_qr_suit_archivage (migration 0063) desactive le QR d'un
--  commerce au moment ou il est archive. Il ne reecrit pas le passe : les
--  commerces archives AVANT lui gardent un sticker marque actif.
--
--  Mesure sur la base de recette : 26 lignes.
--
--  Ce n'est pas anodin. La contrainte qr_desactivation_coherente impose qu'un
--  sticker retire porte la date de son retrait ; ces 26 lignes affirment
--  l'inverse — un sticker en circulation sur une devanture qui n'est plus
--  recensee. Tout decompte de stickers poses les compterait.
--
--  LA DATE RETENUE EST CELLE DE L'ARCHIVAGE, pas celle de cette migration : le
--  sticker a cesse d'etre valable le jour ou le commerce a ete archive, pas le
--  jour ou l'on s'en apercoit. Inscrire aujourd'hui serait mentir sur la
--  chronologie.
--
--  Le motif dit d'ou vient la ligne, pour qu'on ne la confonde pas plus tard
--  avec un retrait decide par un agent.
-- ===========================================================================

UPDATE app.qr_code q
   SET actif               = false,
       desactive_le        = c.archive_le,
       motif_desactivation = 'commerce archivé (régularisation, migration 0071)'
  FROM app.commerce c
 WHERE c.id = q.commerce_id
   AND q.actif
   AND c.archive_le IS NOT NULL;
