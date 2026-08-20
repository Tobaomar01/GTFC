'use client';

/**
 * Gestion multi-communes — réservée au super-administrateur.
 *
 * Chaque commune est un locataire isolé : ses agents, commerces, taxes et
 * paiements ne se mélangent jamais avec ceux d'une autre. L'isolation est
 * garantie par la base (politiques RLS), pas par cet écran.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { nombre } from '@/lib/format';
import { Carte, Chargement, Message, Tableau, Champ, Bouton } from '@/composants/ui';

export default function PageCommunes() {
  const [communes, setCommunes] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState({ code: '', slug: '', nom: '', region: 'Dakar' });
  const [occupe, setOccupe] = useState(false);

  const charger = () => api.get('/communes').then(setCommunes).catch((e) => setErreur(e.message));
  useEffect(() => { charger(); }, []);

  const creer = async (e) => {
    e.preventDefault();
    setOccupe(true); setErreur(null); setMessage(null);
    try {
      const r = await api.post('/communes', {
        code: form.code.toUpperCase(),
        slug: form.slug.toLowerCase(),
        nom: form.nom,
        region: form.region || undefined,
      });
      setMessage(r.rappel ?? 'Commune créée.');
      setForm({ code: '', slug: '', nom: '', region: 'Dakar' });
      await charger();
    } catch (err) { setErreur(err.message); } finally { setOccupe(false); }
  };

  if (erreur && !communes) return <Message type="erreur" titre="Chargement impossible">{erreur}</Message>;
  if (!communes) return <Chargement />;

  return (
    <div className="space-y-5">
      {message && <Message type="succes" titre="Commune créée">{message}</Message>}
      {erreur && <Message type="erreur">{erreur}</Message>}

      <Carte titre={`${communes.length} commune(s) sur la plateforme`}>
        <Tableau cle="id" lignes={communes}
          colonnes={[
            { cle: 'code', titre: 'Code', monospace: true },
            { cle: 'nom', titre: 'Commune' },
            { cle: 'slug', titre: 'Sous-domaine', monospace: true },
            { cle: 'region', titre: 'Région' },
            { cle: 'nb_commerces', titre: 'Commerces', alignement: 'droite', rendu: (l) => nombre(l.nb_commerces) },
            { cle: 'population', titre: 'Population', alignement: 'droite', rendu: (l) => nombre(l.population) },
            {
              cle: 'est_pilote',
              titre: 'Statut',
              rendu: (l) => {
                if (l.est_pilote) return 'Pilote';
                return l.actif ? 'Active' : 'Inactive';
              },
            },
          ]} />
      </Carte>

      <Carte titre="Ajouter une commune"
        sousTitre="Crée un locataire isolé, ses paramètres et l'activation des 5 taxes"
      >
        <form onSubmit={creer} className="grid max-w-2xl gap-3 sm:grid-cols-2">
          <Champ etiquette="Code" value={form.code} required
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            placeholder="PARC" aide="2 à 10 caractères, majuscules" />
          <Champ etiquette="Sous-domaine" value={form.slug} required
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            placeholder="parcelles" aide="Deviendra parcelles.votre-domaine.sn" />
          <Champ etiquette="Nom complet" value={form.nom} required
            onChange={(e) => setForm({ ...form, nom: e.target.value })}
            placeholder="Parcelles Assainies" />
          <Champ etiquette="Région" value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })} />
          <div className="sm:col-span-2">
            <Bouton type="submit" variante="primaire" charge={occupe}>
              Créer la commune
            </Bouton>
            <p className="mt-2 text-[13px] text-encre-attenuee">
              Après création : créez l&apos;enregistrement DNS, puis lancez
              <span className="font-mono"> bash scripts/add-commune-domain.sh &lt;slug&gt;</span> sur
              le serveur pour étendre le certificat SSL.
            </p>
          </div>
        </form>
      </Carte>
    </div>
  );
}
