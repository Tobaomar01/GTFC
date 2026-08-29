#!/usr/bin/env python3
"""
Contrôle de cohérence de docker-compose.yml, sans Docker.

`docker compose config` valide le fichier — encore faut-il Docker installé.
Ce contrôle-ci tourne partout, y compris sur le poste de développement, et
vérifie ce qui casse réellement un déploiement :

  · un service qui en attend un autre, absent ;
  · un volume monté mais jamais déclaré ;
  · deux services qui publient le même port de l'hôte ;
  · une variable ${...} attendue mais absente de .env.template — le cas le
    plus traître, car Docker la remplace alors par une chaîne vide et le
    service démarre avec un mot de passe vide plutôt que de refuser.

Il ne remplace pas `docker compose config` : il l'anticipe.

    python3 scripts/verifier-compose.py [docker-compose.yml]
"""
import os
import re
import sys

import yaml

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPOSE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RACINE, 'docker-compose.yml')
GABARIT = os.path.join(RACINE, '.env.template')

anomalies = []


def signaler(quoi):
    anomalies.append(quoi)
    print(f'  ANOMALIE  {quoi}')


with open(COMPOSE, encoding='utf-8') as f:
    brut = f.read()
compose = yaml.safe_load(brut)

services = compose.get('services') or {}
volumes_declares = set((compose.get('volumes') or {}).keys())
reseaux_declares = set((compose.get('networks') or {}).keys())

print(f'\n{len(services)} service(s) : ' + ', '.join(sorted(services)))

# --- Dépendances ------------------------------------------------------------
for nom, svc in services.items():
    dep = svc.get('depends_on') or {}
    cibles = dep.keys() if isinstance(dep, dict) else dep
    for cible in cibles:
        if cible not in services:
            signaler(f'{nom} attend le service « {cible} », qui n\'existe pas')

# --- Volumes ----------------------------------------------------------------
for nom, svc in services.items():
    for montage in svc.get('volumes') or []:
        if not isinstance(montage, str):
            continue
        source = montage.split(':')[0]
        # Un chemin (absolu ou relatif) est un montage d'hôte, pas un volume
        # nommé : il n'a pas à être déclaré.
        if source.startswith(('.', '/', '$')):
            continue
        if source not in volumes_declares:
            signaler(f'{nom} monte le volume « {source} », jamais déclaré')

# --- Réseaux ----------------------------------------------------------------
for nom, svc in services.items():
    reseaux = svc.get('networks') or []
    cibles = reseaux.keys() if isinstance(reseaux, dict) else reseaux
    for cible in cibles:
        if cible not in reseaux_declares:
            signaler(f'{nom} rejoint le réseau « {cible} », jamais déclaré')

# --- Ports de l'hôte --------------------------------------------------------
occupes = {}
for nom, svc in services.items():
    for p in svc.get('ports') or []:
        texte = str(p if not isinstance(p, dict) else p.get('published', ''))
        m = re.match(r'^(?:[\d.]+:)?(\d+):', texte)
        if not m:
            continue
        port = m.group(1)
        if port in occupes:
            signaler(f'port {port} publié par {occupes[port]} ET {nom}')
        occupes[port] = nom
print('  ports publiés : ' + (', '.join(sorted(occupes)) or 'aucun'))

# --- Variables d'environnement ---------------------------------------------
attendues = set(re.findall(r'\$\{([A-Z_][A-Z0-9_]*)', brut))
fournies = set()
if os.path.exists(GABARIT):
    with open(GABARIT, encoding='utf-8') as f:
        fournies = set(re.findall(r'^([A-Z_][A-Z0-9_]*)=', f.read(), re.M))
else:
    signaler('.env.template introuvable')

# Une variable avec valeur par défaut ${X:-…} n'a pas besoin d'être fournie.
avec_defaut = set(re.findall(r'\$\{([A-Z_][A-Z0-9_]*):[-?]', brut))
manquantes = sorted(attendues - fournies - avec_defaut)
for v in manquantes:
    # Docker remplace une variable absente par une CHAÎNE VIDE, sans rien
    # dire. Un mot de passe vide démarre le service au lieu de le refuser.
    signaler(f'{v} attendue par compose, absente de .env.template — '
             f'Docker la remplacerait par une chaîne vide')

print(f'  variables attendues : {len(attendues)}, dont {len(avec_defaut)} avec défaut')

# --- Redémarrage et santé ---------------------------------------------------
for nom, svc in services.items():
    if 'restart' not in svc and 'deploy' not in svc:
        print(f'  note      {nom} n\'a pas de politique de redémarrage')

print()
if anomalies:
    print(f'{len(anomalies)} anomalie(s) : le déploiement échouerait ou démarrerait mal.')
    sys.exit(1)
print('docker-compose.yml cohérent.')
