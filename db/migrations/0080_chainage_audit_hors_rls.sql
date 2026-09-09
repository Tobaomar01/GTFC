-- ===========================================================================
--  La chaine d'audit se brisait toute seule, en fonctionnement normal
--  Constitution, principe III : tracabilite INALTERABLE.
--
--  CE QUI A ETE CONSTATE le 09/09/2026, apres deux ouvertures de session sur le
--  portail du redevable depuis un telephone :
--
--      rang | quand          | action        | entite
--      4667 | 09-08 22:11:05 | modification  | utilisateur
--      4667 | 09-08 23:02:01 | acces_portail | redevable      <-- DOUBLON
--      4668 | 09-08 22:11:29 | modification  | utilisateur
--      4668 | 09-08 23:11:17 | acces_portail | redevable      <-- DOUBLON
--
--  audit.verifier_chaine() signalait une rupture, et trois tests tombaient.
--
--  LA CAUSE.
--
--  audit.chainer() attribue le rang comme « le maximum plus un », sous verrou
--  consultatif — ce qui est juste. Mais elle n'etait PAS security definer :
--  elle s'executait avec les droits de l'APPELANT. Or audit.journal porte la
--  securite au niveau des lignes, avec deux politiques.
--
--  Le « maximum » etait donc calcule sur ce que l'appelant a le droit de VOIR.
--  Une session applicative dans le contexte d'une commune ne voit pas tout le
--  journal : elle lisait un maximum plus bas et reattribuait un rang deja pris.
--  Deux entrees, deux empreintes, un meme rang — la chaine est rompue.
--
--  CE QUE CELA VAUT. Le journal d'audit est la piece qui rend un controle a
--  posteriori opposable. Une chaine qui se rompt en fonctionnement NORMAL ne
--  prouve plus rien : le jour ou une vraie alteration surviendrait, elle
--  ressemblerait a toutes les ruptures qu'on aura appris a ignorer.
--
--  ET C'EST PIRE QU'UN FAUX POSITIF : le rang ET l'empreinte precedente etaient
--  calcules sur une vue PARTIELLE du journal. Qui maitrise son contexte de
--  commune influe donc sur le chainage.
--
--  ON NE TOUCHE PAS AU CORPS DE LA FONCTION.
--
--  Ma premiere version de cette migration recopiait le corps de audit.chainer()
--  pour y ajouter SECURITY DEFINER. Elle l'a recopie depuis 0057 — et a donc
--  ECRASE la 0062, qui avait rendu l'empreinte independante du fuseau horaire.
--  La verification sur base neuve l'a vu tout de suite : « empreinte recalculee
--  differente » des la premiere entree.
--
--  ALTER FUNCTION ne change QUE l'attribut demande. Le corps reste celui que la
--  derniere migration a laisse, quel qu'il soit. C'est la seule facon sure de
--  modifier un droit sans hériter du corps d'une version périmée.
-- ===========================================================================

ALTER FUNCTION audit.chainer() SECURITY DEFINER;

COMMENT ON FUNCTION audit.chainer() IS
    'Chaine chaque entree a la precedente. SECURITY DEFINER : la lecture du '
    'dernier maillon doit voir TOUT le journal, sans quoi la RLS fait '
    'reattribuer un rang deja pris et rompt la chaine.';

-- La verification souffrait du meme mal : elle relit le journal pour recalculer
-- chaque empreinte. Sous les droits de l'appelant, elle n'en voit qu'une partie
-- et signale comme « entree manquante » ce qui est seulement invisible pour
-- elle. Un controle qui ne voit pas tout ne peut pas conclure.
ALTER FUNCTION audit.verifier_chaine() SECURITY DEFINER;

COMMENT ON FUNCTION audit.verifier_chaine() IS
    'Verifie la chaine maillon par maillon. SECURITY DEFINER : sous RLS elle ne '
    'verrait qu''une partie du journal et signalerait des ruptures inexistantes.';

-- ---------------------------------------------------------------------------
--  Verification : deux contextes differents ne peuvent plus produire le meme
--  rang. C'est exactement la situation qui a casse la chaine.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_commune uuid;
    v_r1      bigint;
    v_r2      bigint;
BEGIN
    SELECT id INTO v_commune FROM app.commune LIMIT 1;
    IF v_commune IS NULL THEN
        RAISE NOTICE 'Aucune commune : chainage non eprouve ici.';
        RETURN;
    END IF;

    PERFORM set_config('gtfc.commune_id', '', true);
    INSERT INTO audit.journal (commune_id, action, entite, entite_id, motif)
    VALUES (v_commune, 'modification', 'epreuve_chainage', NULL, 'epreuve 1')
    RETURNING rang INTO v_r1;

    PERFORM set_config('gtfc.commune_id', v_commune::text, true);
    INSERT INTO audit.journal (commune_id, action, entite, entite_id, motif)
    VALUES (v_commune, 'modification', 'epreuve_chainage', NULL, 'epreuve 2')
    RETURNING rang INTO v_r2;

    PERFORM set_config('gtfc.commune_id', '', true);

    IF v_r2 <> v_r1 + 1 THEN
        RAISE EXCEPTION
            'Chainage rompu : rangs % puis % au lieu de deux consecutifs.', v_r1, v_r2;
    END IF;

    RAISE NOTICE 'Chainage eprouve : rangs % et %, consecutifs quel que soit le contexte.',
        v_r1, v_r2;
END
$verif$;
