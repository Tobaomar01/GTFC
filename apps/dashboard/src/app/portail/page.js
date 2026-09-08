'use client';

/**
 * Connexion au portail redevable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  DEUX ÉTAPES, ET AUCUN AVEU
 *
 *  Le redevable saisit son numéro, reçoit un code, le saisit. La page ne dit
 *  JAMAIS si le numéro est connu de la mairie : même message, même écran
 *  suivant, qu'il existe un dossier ou non. Sinon cette page deviendrait un
 *  moyen de vérifier qui est enregistré, commerce par commerce.
 *
 *  L'API applique la même règle de son côté ; la répéter ici évite qu'une
 *  amélioration bien intentionnée de l'interface — « dites-lui que le numéro
 *  est inconnu, c'est plus clair » — ne rouvre la faille.
 *
 *  Le message d'aide en bas d'écran couvre le cas réel : un numéro jamais
 *  vérifié par un agent ne recevra rien, et son porteur doit savoir quoi
 *  faire plutôt que de réessayer dix fois.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const COMMUNE = process.env.NEXT_PUBLIC_COMMUNE_SLUG || 'gtfc';

async function appelPortail(chemin, corps = null) {
  const reponse = await fetch(`/api/portail/${chemin}`, {
    method: corps ? 'POST' : 'GET',
    headers: corps ? { 'Content-Type': 'application/json' } : {},
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const json = await reponse.json().catch(() => null);
  return { statut: reponse.status, json, donnees: json?.donnees };
}

export default function ConnexionPortail() {
  const router = useRouter();
  const [etape, setEtape] = useState('numero');
  const [telephone, setTelephone] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [occupe, setOccupe] = useState(false);
  const [codeSimule, setCodeSimule] = useState(null);
  const champCode = useRef(null);

  useEffect(() => {
    if (etape === 'code') champCode.current?.focus();
  }, [etape]);

  const demanderCode = async (e) => {
    e.preventDefault();
    setErreur(null);
    setOccupe(true);
    try {
      const r = await appelPortail('code', { commune: COMMUNE, telephone });
      if (r.statut === 429) {
        setErreur(r.json?.erreur?.message ?? 'Trop de demandes. Patientez avant de réessayer.');
        return;
      }
      if (r.statut !== 200) {
        setErreur(r.json?.erreur?.message ?? 'Numéro invalide.');
        return;
      }
      // Réponse identique que le numéro soit connu ou non : on passe à
      // l'étape suivante dans les deux cas.
      setMessage(r.donnees?.message ?? null);
      setCodeSimule(r.donnees?.code_simule ?? null);
      setEtape('code');
    } catch {
      setErreur('Connexion impossible. Vérifiez votre réseau.');
    } finally {
      setOccupe(false);
    }
  };

  const ouvrirSession = async (e) => {
    e.preventDefault();
    setErreur(null);
    setOccupe(true);
    try {
      const r = await appelPortail('session', { commune: COMMUNE, telephone, code });
      if (r.statut !== 200) {
        setErreur(r.json?.erreur?.message ?? 'Code invalide ou expiré.');
        setCode('');
        return;
      }
      router.push('/portail/dossier');
    } catch {
      setErreur('Connexion impossible. Vérifiez votre réseau.');
    } finally {
      setOccupe(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[20px] font-semibold text-encre">Mon dossier</h1>
        <p className="mt-1 text-[14px] leading-relaxed text-encre-2">
          Consultez ce que vous devez, vos quittances et vos échéances.
        </p>
      </div>

      {etape === 'numero' ? (
        <form onSubmit={demanderCode} className="space-y-4 rounded-xl border border-bordure bg-surface p-4">
          <div>
            <label htmlFor="tel" className="mb-1.5 block text-[13px] font-medium text-encre">
              Votre numéro de téléphone
            </label>
            <input
              id="tel"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={telephone}
              onChange={(e) => setTelephone(e.target.value)}
              placeholder="+221 77 000 00 00"
              className="w-full rounded-lg border border-bordure bg-surface px-3 py-2.5 text-[15px] text-encre outline-none focus:border-marque"
            />
            <p className="mt-1.5 text-[12px] text-encre-attenuee">
              Le numéro que vous avez donné à l&apos;agent de la mairie.
            </p>
          </div>

          {erreur ? <Alerte texte={erreur} /> : null}

          <button
            type="submit"
            disabled={occupe || telephone.length < 8}
            className="w-full rounded-lg bg-marque px-4 py-2.5 text-[15px] font-semibold text-white disabled:opacity-50"
          >
            {occupe ? 'Envoi…' : 'Recevoir un code'}
          </button>
        </form>
      ) : (
        <form onSubmit={ouvrirSession} className="space-y-4 rounded-xl border border-bordure bg-surface p-4">
          {message ? (
            <p className="text-[14px] leading-relaxed text-encre-2">{message}</p>
          ) : null}

          <div>
            <label htmlFor="code" className="mb-1.5 block text-[13px] font-medium text-encre">
              Code reçu par SMS
            </label>
            <input
              id="code"
              ref={champCode}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              required
              value={code}
              // Le bandeau d'erreur disparaît dès qu'on retape. Sinon on lit
              // « Code invalide » EN SAISISSANT le bon — et sur un téléphone, où le
              // clavier masque la moitié de l’écran, on croit que le nouveau code
              // vient d’être refusé lui aussi.
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setErreur(null); }}
              placeholder="000000"
              // Chiffres espacés et grande taille : un code se relit à voix
              // haute, souvent depuis une notification, parfois par quelqu'un
              // d'autre que celui qui tape.
              className="w-full rounded-lg border border-bordure bg-surface px-3 py-3 text-center font-mono text-[24px] tracking-[0.4em] text-encre outline-none focus:border-marque"
            />
            <p className="mt-1.5 text-[12px] text-encre-attenuee">
              Valable quelques minutes. Ne le communiquez à personne.
            </p>
          </div>

          {codeSimule ? (
            <div className="rounded-lg border-l-[3px] border-st-partiel bg-surface-alt px-3 py-2">
              <p className="text-[13px] text-encre">
                Aucun opérateur SMS n&apos;est raccordé. Code de démonstration :
                {' '}
                <span className="font-mono font-semibold">{codeSimule}</span>
              </p>
            </div>
          ) : null}

          {erreur ? <Alerte texte={erreur} /> : null}

          <button
            type="submit"
            disabled={occupe || code.length < 4}
            className="w-full rounded-lg bg-marque px-4 py-2.5 text-[15px] font-semibold text-white disabled:opacity-50"
          >
            {occupe ? 'Vérification…' : 'Ouvrir mon dossier'}
          </button>

          <button
            type="button"
            onClick={() => { setEtape('numero'); setCode(''); setErreur(null); }}
            className="w-full rounded-lg border border-bordure px-4 py-2 text-[14px] text-encre-2"
          >
            Changer de numéro
          </button>
        </form>
      )}

      <div className="rounded-xl border border-bordure bg-surface p-4">
        <p className="text-[13px] font-medium text-encre">Vous ne recevez pas de code ?</p>
        <p className="mt-1 text-[13px] leading-relaxed text-encre-2">
          Votre numéro doit avoir été confirmé par un agent lors du recensement.
          S&apos;il ne l&apos;a pas été, ou s&apos;il a changé, présentez-vous à la
          mairie : la modification ne peut pas se faire depuis ce site.
        </p>
      </div>
    </div>
  );
}

function Alerte({ texte }) {
  return (
    <div role="alert" className="rounded-lg border-l-[3px] border-st-impaye bg-surface-alt px-3 py-2">
      <p className="text-[13px] text-encre">{texte}</p>
    </div>
  );
}
