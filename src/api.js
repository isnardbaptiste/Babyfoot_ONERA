// Seul point de contact entre l'interface et le serveur.
// Le code de la ligue n'est jamais stocké : il voyage avec les requêtes protégées.

const ROUTE = "/api/ligue";

async function lire() {
  const r = await fetch(ROUTE);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.erreur || "Le classement n'a pas pu être chargé.");
  return data;
}

async function envoyer(action, corps = {}, code) {
  const r = await fetch(ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, code, ...corps }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.erreur || "L'enregistrement a échoué.");
  return data;
}

export const api = {
  lire,
  verifier: (code) => envoyer("verifier", {}, code),
  ajouterJoueur: (nom) => envoyer("joueur:ajouter", { nom }),
  renommerJoueur: (id, nom, code) => envoyer("joueur:renommer", { id, nom }, code),
  retirerJoueur: (id, code) => envoyer("joueur:retirer", { id }, code),
  ajouterMatch: (match) => envoyer("match:ajouter", { match }),
  supprimerMatch: (id, code) => envoyer("match:supprimer", { id }, code),
  modifierMatch: (id, match, code) => envoyer("match:modifier", { id, match }, code),
  reinitialiser: (code) => envoyer("reinitialiser", {}, code),
  definirCoefs: (coefs, code) => envoyer("coefs:definir", { coefs }, code),
};
