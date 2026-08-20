# ===========================================================================
#  Plateforme de collecte des taxes locales — GTFC
#  Raccourcis d'exploitation (à exécuter sur le serveur Ubuntu)
#
#  Tapez simplement :  make
# ===========================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help install ssl up down restart logs ps health backup backup-photos \
        restore psql shell-db shell-minio nginx-test nginx-reload cron \
        clean-logs status commune

## ---------------------------------------------------------------------------
help:  ## Affiche cette aide
	@echo ""
	@echo "  Plateforme taxes locales GTFC — commandes disponibles"
	@echo "  ---------------------------------------------------------------"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

## --- Installation ----------------------------------------------------------
install:  ## Installe le serveur (Docker, Node, PM2, pare-feu) — une seule fois
	sudo bash scripts/install-ubuntu.sh

ssl:  ## Obtient les certificats Let's Encrypt (après configuration du DNS)
	bash scripts/init-ssl.sh

commune:  ## Ajoute le sous-domaine d'une commune — usage : make commune SLUG=parcelles
	@test -n "$(SLUG)" || (echo "Usage : make commune SLUG=<slug>"; exit 1)
	bash scripts/add-commune-domain.sh $(SLUG)

cron:  ## Installe les sauvegardes automatiques
	bash scripts/install-cron.sh

## --- Exploitation ----------------------------------------------------------
up:  ## Démarre l'infrastructure
	docker compose up -d
	@sleep 3 && $(MAKE) ps

down:  ## Arrête l'infrastructure (les données sont conservées)
	docker compose down

restart:  ## Redémarre l'infrastructure
	docker compose restart
	@sleep 3 && $(MAKE) ps

ps:  ## État des conteneurs
	@docker compose ps

status: health  ## Alias de « health »

health:  ## Contrôle de santé complet
	@bash scripts/healthcheck.sh

logs:  ## Suit les journaux — usage : make logs [S=nginx]
	docker compose logs -f --tail=100 $(S)

## --- Base de données -------------------------------------------------------
migrate:  ## Applique les migrations SQL en attente
	bash db/migrate.sh

migrate-seed:  ## Applique les migrations + les données de démonstration
	bash db/migrate.sh --seed

migrate-status:  ## Affiche l'état des migrations sans rien appliquer
	bash db/migrate.sh --status

db-reset:  ## REMET LA BASE À ZÉRO puis rejoue tout — DESTRUCTIF
	bash db/migrate.sh --reset

db-check:  ## Contrôles de cohérence métier + données provisoires restantes
	@set -a; source .env; set +a; \
	docker exec -e PGPASSWORD=$$DB_SUPERUSER_PASSWORD gtfc-postgres \
	  psql -X -U $$DB_SUPERUSER -d $$DB_NAME \
	  -c "SELECT * FROM app.verifier_coherence();" \
	  -c "SELECT entite, count(*) FROM app.v_donnees_a_remplacer GROUP BY 1 ORDER BY 2 DESC;"

psql:  ## Ouvre une session psql sur la base
	@set -a; source .env; set +a; \
	docker exec -it gtfc-postgres psql -U $$DB_SUPERUSER -d $$DB_NAME

shell-db:  ## Ouvre un shell dans le conteneur PostgreSQL
	docker exec -it gtfc-postgres bash

backup:  ## Sauvegarde immédiate de la base
	bash scripts/backup-postgres.sh

backup-photos:  ## Sauvegarde immédiate des photos MinIO
	bash scripts/backup-minio.sh

restore:  ## Restaure une sauvegarde (menu interactif) — DESTRUCTIF
	bash scripts/restore-postgres.sh

## --- Nginx / MinIO ---------------------------------------------------------
nginx-test:  ## Vérifie la configuration Nginx
	docker exec gtfc-nginx nginx -t

nginx-reload:  ## Recharge Nginx sans coupure
	docker exec gtfc-nginx nginx -s reload

shell-minio:  ## Relance l'initialisation des buckets MinIO
	docker compose run --rm minio-init

## --- Entretien -------------------------------------------------------------
clean-logs:  ## Vide les journaux Docker (à faire si le disque se remplit)
	sudo sh -c 'truncate -s 0 /var/lib/docker/containers/*/*-json.log'
	@echo "Journaux Docker vidés."
