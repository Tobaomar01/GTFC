-- Seed 0007 — Grille de patente, MONTANTS THÉORIQUES
--
-- ⚠ CES MONTANTS NE SONT PAS OFFICIELS.
--
-- La patente est la taxe principale du dispositif et n'avait aucun tarif :
-- la liquidation annuelle ne facturait donc que la TEOM et la TODP. Ces
-- valeurs permettent d'avancer et de démontrer la chaîne complète.
--
-- Elles sont toutes marquées a_remplacer = true et ressortent dans
-- ref.v_a_remplacer, qui DOIT être vide avant la mise en production.
--
-- Échelle retenue, à titre indicatif : sept paliers mensuels, de 3 000 F
-- pour une activité non classée à 25 000 F pour une station d'essence. Le
-- rapport de 1 à 8 reflète l'écart de chiffre d'affaires observable entre un
-- cordonnier et une supérette, sans prétendre à l'exactitude.
--
-- Idempotent.

DO $$
DECLARE
    v_commune uuid;
    v_type    uuid;
    v_bareme  uuid;
BEGIN
    SELECT id INTO v_commune FROM app.commune WHERE code = 'GTFC';
    IF v_commune IS NULL THEN
        RAISE EXCEPTION 'Commune GTFC absente — lancez d''abord le seed 0002.';
    END IF;

    SELECT id INTO v_type FROM ref.type_taxe WHERE code = 'patente';
    IF v_type IS NULL THEN
        RAISE EXCEPTION 'Type de taxe « patente » absent — lancez d''abord le seed 0001.';
    END IF;

    INSERT INTO app.bareme_taxe
        (commune_id, type_taxe_id, libelle, mode_calcul, periodicite,
         date_effet, delib_reference, a_remplacer)
    VALUES (v_commune, v_type, 'Patente professionnelle',
            'par_categorie', 'mensuelle', DATE '2026-01-01',
            'À_ARRÊTER — délibération du conseil municipal', true)
    ON CONFLICT DO NOTHING;

    SELECT id INTO v_bareme
      FROM app.bareme_taxe
     WHERE commune_id = v_commune AND type_taxe_id = v_type
     ORDER BY date_effet DESC LIMIT 1;

    INSERT INTO app.bareme_tranche
        (bareme_id, categorie_id, libelle, montant, ordre, a_remplacer)
    SELECT v_bareme, c.id,
           'THÉORIQUE — ' || c.libelle,
           g.montant, g.ordre, true
      FROM (VALUES
            -- Palier 1 — fort chiffre d'affaires
            ('ACT-05', 25000,  1),   -- Station d'essence
            ('ACT-04', 25000,  2),   -- Grande surface / supérette
            -- Palier 2
            ('ACT-06', 15000,  3),   -- Bijouterie
            ('ACT-02', 15000,  4),   -- Restauration
            ('ACT-14', 15000,  5),   -- Boulangerie / pâtisserie
            -- Palier 3
            ('ACT-15', 12000,  6),   -- Quincaillerie
            ('ACT-22', 12000,  7),   -- Électronique / téléphonie
            ('ACT-19', 12000,  8),   -- Dépôt
            -- Palier 4
            ('ACT-01', 10000,  9),   -- Alimentation
            ('ACT-03', 10000, 10),   -- Dibiterie
            ('ACT-09', 10000, 11),   -- Garage mécanique
            ('ACT-17', 10000, 12),   -- Pressing
            -- Palier 5
            ('ACT-10',  7500, 13),   -- Menuiserie bois
            ('ACT-13',  7500, 14),   -- Salon de coiffure
            ('ACT-18',  7500, 15),   -- Cosmétiques
            ('ACT-20',  7500, 16),   -- Vêtements / friperie
            ('ACT-21',  7500, 17),   -- Chaussures / maroquinerie
            ('ACT-23',  7500, 18),   -- Articles ménagers
            ('ACT-24',  7500, 19),   -- Télécentre / multiservices
            -- Palier 6 — artisanat de proximité
            ('ACT-07',  5000, 20),   -- Cordonnerie
            ('ACT-08',  5000, 21),   -- Forgerie
            ('ACT-11',  5000, 22),   -- Vulcanisation
            ('ACT-12',  5000, 23),   -- Tailleur / couture
            ('ACT-16',  5000, 24),   -- Mercerie
            -- Palier 7 — non classé
            ('ACT-99',  3000, 25)
           ) AS g(code, montant, ordre)
      JOIN ref.categorie_commerce c ON c.code = g.code
     WHERE NOT EXISTS (
        SELECT 1 FROM app.bareme_tranche t
         WHERE t.bareme_id = v_bareme AND t.categorie_id = c.id);

    RAISE NOTICE 'Patente : grille théorique posée (montants à remplacer).';
END
$$;
