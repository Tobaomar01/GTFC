/**
 * Helpers de réponse et de pagination.
 *
 * Format uniforme pour toute l'API : l'app Android et le dashboard n'ont
 * qu'une seule forme de réponse à savoir lire.
 *
 *   Succès  : { succes: true, donnees: ..., pagination?: {...} }
 *   Échec   : { succes: false, erreur: { code, message, details? } }
 */
'use strict';

/** Enveloppe un handler async pour que ses rejets partent vers next(). */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function ok(res, donnees, extra = {}) {
  return res.json({ succes: true, donnees, ...extra });
}

function cree(res, donnees) {
  return res.status(201).json({ succes: true, donnees });
}

function sansContenu(res) {
  return res.status(204).end();
}

/**
 * Pagination par décalage.
 *
 * Volontairement plafonnée à 500 : sans limite, un export du dashboard
 * ramènerait les 5 443 commerces avec leurs jointures dans une seule
 * réponse, ce qui étoufferait un téléphone en 3G.
 */
function lirePagination(query, { defaut = 50, max = 500 } = {}) {
  const limite = Math.min(Math.max(parseInt(query.limite, 10) || defaut, 1), max);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limite, decalage: (page - 1) * limite, page };
}

function pagine(res, lignes, { page, limite }, total) {
  const totalNum = Number(total ?? lignes.length);
  return res.json({
    succes: true,
    donnees: lignes,
    pagination: {
      page,
      limite,
      total: totalNum,
      pages: Math.max(Math.ceil(totalNum / limite), 1),
    },
  });
}

/**
 * Construit une clause ORDER BY sûre.
 * Le nom de colonne ne peut pas être paramétré en SQL : on le valide donc
 * contre une liste blanche plutôt que de le concaténer tel quel.
 */
function ordreSur(champsAutorises, champDemande, sensDemande, defaut) {
  const champ = champsAutorises.includes(champDemande) ? champDemande : defaut;
  const sens = String(sensDemande).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `${champ} ${sens}`;
}

module.exports = { asyncHandler, ok, cree, sansContenu, lirePagination, pagine, ordreSur };
