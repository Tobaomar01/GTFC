#!/usr/bin/env bash
# ============================================================================
#  Rescellement du journal d'audit — À NE PAS LANCER SANS DÉCISION
#
#  La migration 0062 rend l'empreinte indépendante du fuseau de la session.
#  Elle ne touche à aucune ligne déjà écrite : celles-ci restent scellées sous
#  l'ancienne règle, et la vérification les signale donc toutes en rupture.
#
#  Ce script les rescelle. C'est la seule opération du projet qui RÉÉCRIVE un
#  journal réputé inaltérable, et elle mérite d'être traitée comme telle :
#
#    - elle exige d'être propriétaire de la table, car il faut désactiver le
#      garde-fou `trg_journal_inalterable` ;
#    - elle refuse d'agir sans `--je-confirme` ;
#    - elle refuse d'agir si UNE SEULE ligne ne se vérifie pas d'abord sous
#      l'ancienne règle.
#
#  CE DERNIER POINT EST L'ESSENTIEL. On ne rescelle pas un journal dont on
#  ignore s'il était intact : ce serait blanchir une altération au lieu de la
#  découvrir. Le script prouve donc d'abord, ligne à ligne, que chaque
#  empreinte se retrouve sous l'ancienne formule pour UN fuseau — sans quoi il
#  s'arrête et ne réécrit rien. Les données couvertes par l'empreinte
#  (commune, utilisateur, action, entité, valeurs) sont ainsi contrôlées à
#  l'identique ; seul le RENDU de l'horodatage est laissé libre, puisque c'est
#  exactement la variable dont on cherche à se débarrasser.
#
#  Sans --je-confirme, le script se contente de la preuve et du rapport : il
#  dit sous quels fuseaux le journal a été écrit, et sur quelles plages de
#  rangs. C'est le mode à employer pour instruire la décision.
#
#  Usage :
#      bash scripts/resceller-journal-audit.sh [base]                 # rapport
#      bash scripts/resceller-journal-audit.sh [base] --je-confirme   # écriture
#
#  Prérequis : la migration 0062 doit être appliquée.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-gtfc_recette}"
CONFIRME=0
for a in "$@"; do [ "$a" = "--je-confirme" ] && CONFIRME=1; done

GRAS=$'\033[1m'; VERT=$'\033[0;32m'; ROUGE=$'\033[0;31m'
JAUNE=$'\033[0;33m'; GRIS=$'\033[0;90m'; NC=$'\033[0m'

command -v psql >/dev/null || { echo "psql introuvable." >&2; exit 1; }

echo
echo "${GRAS}Rescellement du journal d'audit — base ${BASE}${NC}"
if [ "$CONFIRME" = "1" ]; then
    echo "${ROUGE}Mode ÉCRITURE : les empreintes existantes seront réécrites.${NC}"
else
    echo "${GRIS}Mode rapport : aucune écriture. Ajoutez --je-confirme pour agir.${NC}"
fi

SORTIE="$(mktemp)"
trap 'rm -f "$SORTIE"' EXIT

psql -v ON_ERROR_STOP=1 -d "$BASE" -v confirme="$CONFIRME" <<'SQL' 2>&1 | tee "$SORTIE"
\set QUIET on
BEGIN;

-- La migration 0062 doit être là : sans elle, resceller reviendrait à
-- réécrire les empreintes avec la formule qui a causé le défaut.
DO $garde$
BEGIN
    IF to_regprocedure('audit.horodatage_canonique(timestamptz)') IS NULL THEN
        RAISE EXCEPTION
            'La migration 0062 n''est pas appliquee : audit.horodatage_canonique est absente.';
    END IF;
END
$garde$;

-- Rescellement déjà fait ? La phase 1 relit le journal sous l'ANCIENNE règle ;
-- sur un journal déjà rescellé elle échouerait partout et annoncerait une
-- altération, ce qui serait une fausse accusation. On le constate d'abord.
\set QUIET off
SELECT count(*) = 0 AS deja_rescelle FROM audit.verifier_chaine() \gset
\if :deja_rescelle
\echo ''
\echo 'La chaine se verifie deja sous la nouvelle regle : rien a resceller.'
\quit
\endif
\set QUIET on

CREATE TEMP TABLE resc_preuve(rang bigint PRIMARY KEY, fuseau text) ON COMMIT DROP;

-- ---------------------------------------------------------------------------
-- Phase 1 — la preuve. Aucune écriture.
-- ---------------------------------------------------------------------------
DO $preuve$
DECLARE
    r record; z record;
    v_prec text := NULL;      -- empreinte STOCKÉE du maillon précédent
    v_prefixe text;
    v_zone text := NULL;      -- fuseau retenu pour la ligne précédente
    v_calc text;
    v_trouve boolean;
BEGIN
    FOR r IN SELECT * FROM audit.journal ORDER BY rang LOOP
        IF r.empreinte IS NULL THEN
            v_prec := NULL;
            CONTINUE;
        END IF;

        IF r.empreinte_precedente IS DISTINCT FROM v_prec THEN
            RAISE EXCEPTION
                'Rang % : empreinte precedente incoherente. Le chainage est rompu independamment du fuseau. Rescellement refuse.',
                r.rang;
        END IF;

        v_prefixe := coalesce(v_prec,'') ||
                     coalesce(r.commune_id::text,'') ||
                     coalesce(r.utilisateur_id::text,'') ||
                     r.action::text || r.entite ||
                     coalesce(r.entite_id::text,'') ||
                     coalesce(r.valeurs_avant::text,'') ||
                     coalesce(r.valeurs_apres::text,'');

        v_trouve := false;

        -- Le journal change rarement de fuseau : on tente d'abord celui de la
        -- ligne précédente. Sans cela, chaque ligne balaierait les six cents
        -- fuseaux connus, pour retomber presque toujours sur le même.
        IF v_zone IS NOT NULL THEN
            EXECUTE format('SET LOCAL TimeZone = %L', v_zone);
            v_calc := encode(digest(v_prefixe || r.horodatage::text, 'sha256'), 'hex');
            v_trouve := (v_calc = r.empreinte);
        END IF;

        IF NOT v_trouve THEN
            FOR z IN SELECT name FROM pg_timezone_names LOOP
                EXECUTE format('SET LOCAL TimeZone = %L', z.name);
                v_calc := encode(digest(v_prefixe || r.horodatage::text, 'sha256'), 'hex');
                IF v_calc = r.empreinte THEN
                    v_zone := z.name;
                    v_trouve := true;
                    EXIT;
                END IF;
            END LOOP;
        END IF;

        IF NOT v_trouve THEN
            RAISE EXCEPTION
                'Rang % (id %, %) ne se verifie sous AUCUN fuseau. Le journal a ete altere, ou une autre formule a servi a l''ecrire. Rescellement refuse.',
                r.rang, r.id, r.horodatage;
        END IF;

        INSERT INTO resc_preuve VALUES (r.rang, v_zone);
        v_prec := r.empreinte;
    END LOOP;
END
$preuve$;

RESET TimeZone;

\set QUIET off
\echo ''
\echo 'Preuve : chaque ligne se retrouve sous l''ancienne regle.'
\echo ''
\echo 'Le fuseau ci-dessous est le PREMIER qui reproduise l''empreinte, pas'
\echo 'necessairement celui de la machine : des dizaines de fuseaux partagent'
\echo 'le meme decalage, et c''est le decalage seul qui entre dans le calcul.'
\echo 'Un changement de fuseau d''une plage a l''autre signale un changement de'
\echo 'machine ou de serveur, non une anomalie.'
\echo ''
SELECT fuseau AS fuseau_equivalent,
       (min(j.horodatage) AT TIME ZONE fuseau
        - min(j.horodatage) AT TIME ZONE 'UTC') AS decalage,
       count(*)     AS lignes,
       min(p.rang)  AS du_rang,
       max(p.rang)  AS au_rang
  FROM resc_preuve p
  JOIN audit.journal j ON j.rang = p.rang
 GROUP BY fuseau
 ORDER BY min(p.rang);
\set QUIET on

-- ---------------------------------------------------------------------------
-- Phase 2 — le rescellement. Seulement sur confirmation explicite.
-- ---------------------------------------------------------------------------
\if :confirme

ALTER TABLE audit.journal DISABLE TRIGGER trg_journal_inalterable;

DO $resceller$
DECLARE r record; v_prec text := NULL; v_nouvelle text; v_n bigint := 0;
BEGIN
    FOR r IN SELECT * FROM audit.journal ORDER BY rang LOOP
        IF r.empreinte IS NULL THEN
            v_prec := NULL;
            CONTINUE;
        END IF;

        v_nouvelle := encode(digest(
            coalesce(v_prec,'') ||
            coalesce(r.commune_id::text,'') ||
            coalesce(r.utilisateur_id::text,'') ||
            r.action::text || r.entite ||
            coalesce(r.entite_id::text,'') ||
            coalesce(r.valeurs_avant::text,'') ||
            coalesce(r.valeurs_apres::text,'') ||
            audit.horodatage_canonique(r.horodatage),
            'sha256'), 'hex');

        UPDATE audit.journal
           SET empreinte_precedente = v_prec,
               empreinte            = v_nouvelle
         WHERE id = r.id AND horodatage = r.horodatage;

        v_prec := v_nouvelle;
        v_n := v_n + 1;
    END LOOP;
    RAISE NOTICE 'Lignes rescellees : %', v_n;
END
$resceller$;

ALTER TABLE audit.journal ENABLE TRIGGER trg_journal_inalterable;

-- Le garde-fou invite, pour corriger une information, à AJOUTER une entrée
-- plutôt qu'à en modifier une. On s'y conforme : l'opération elle-même entre
-- au journal, et elle y entre sous la nouvelle règle.
INSERT INTO audit.journal (action, entite, entite_libelle, motif, commentaire, horodatage)
VALUES ('modification', 'audit.journal', 'Rescellement du journal',
        'Migration 0062 : empreinte rendue independante du fuseau de la session',
        'Chaque ligne anterieure avait ete verifiee sous l''ancienne regle avant reecriture.',
        now());

-- Le contrôle final. S'il échoue, tout est annulé : mieux vaut un journal
-- resté en rupture connue qu'un journal réécrit de travers.
DO $controle$
DECLARE v_n integer;
BEGIN
    SELECT count(*) INTO v_n FROM audit.verifier_chaine();
    IF v_n > 0 THEN
        RAISE EXCEPTION 'La chaine ne se verifie toujours pas apres rescellement. Annulation.';
    END IF;
    RAISE NOTICE 'Chaine verifiee : aucune rupture.';
END
$controle$;

\endif

COMMIT;
SQL

# Le code de sortie est celui de psql, pas celui de tee.
statut=${PIPESTATUS[0]}
echo
if [ "$statut" -ne 0 ]; then
    echo "${ROUGE}Échec — rien n'a été écrit (la transaction est annulée).${NC}"
    exit 1
fi

# psql sort en 0 quand il s'arrête sur \quit : sans ce contrôle, un journal
# déjà rescellé s'entendrait annoncer un rescellement qui n'a pas eu lieu.
if grep -q "rien a resceller" "$SORTIE"; then
    echo "${VERT}Journal déjà rescellé — aucune écriture.${NC}"
    exit 0
fi

if [ "$CONFIRME" = "1" ]; then
    echo "${VERT}Journal rescellé, chaîne vérifiée.${NC}"
    echo "${GRIS}Prenez une sauvegarde : les empreintes des sauvegardes antérieures"
    echo "suivent l'ancienne règle et seront signalées en rupture.${NC}"
else
    echo "${JAUNE}Aucune écriture. Relancez avec --je-confirme pour resceller.${NC}"
fi
