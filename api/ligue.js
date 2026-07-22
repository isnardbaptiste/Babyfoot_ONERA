import { Redis } from "@upstash/redis";

/* Fonction serveur unique de la ligue.
   Elle détient le code : le navigateur ne le voit jamais dans son code source.
   Les données vivent dans deux tables de hachage Redis, ce qui rend chaque
   ajout indépendant — deux collègues peuvent saisir en même temps sans s'écraser. */

const CLE_JOUEURS = "bf:joueurs";
const CLE_MATCHS = "bf:matchs";

const AN_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_SCORE = -5;
const MAX_SCORE = 10;

const OUVERT = ["joueur:ajouter", "match:ajouter"];
const PROTEGE = ["verifier", "joueur:renommer", "match:supprimer", "reinitialiser"];
// Retirer un joueur est ouvert après un an d'inactivité, sinon il faut le code.
const MIXTE = ["joueur:retirer"];

function connexion() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.REDIS_REST_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const valeurs = (h) =>
  Object.values(h || {}).map((v) => (typeof v === "string" ? JSON.parse(v) : v));

async function etat(redis) {
  const [j, m] = await Promise.all([redis.hgetall(CLE_JOUEURS), redis.hgetall(CLE_MATCHS)]);
  return {
    joueurs: valeurs(j).sort((a, b) => (a.depuis || "").localeCompare(b.depuis || "")),
    matchs: valeurs(m).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

const joueursDuMatch = (m) => [m.a.atk, m.a.def, m.b.atk, m.b.def];

function scoreValide(n) {
  return Number.isInteger(n) && n >= MIN_SCORE && n <= MAX_SCORE;
}

export default async function handler(req, res) {
  const redis = connexion();
  if (!redis) {
    return res.status(500).json({
      erreur:
        "Base de données non configurée. Ajoutez l'intégration Upstash Redis au projet Vercel.",
    });
  }

  try {
    if (req.method === "GET") {
      return res.status(200).json(await etat(redis));
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ erreur: "Méthode non autorisée." });
    }

    const corps = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { action, code } = corps;

    if (![...OUVERT, ...PROTEGE, ...MIXTE].includes(action)) {
      return res.status(400).json({ erreur: "Action inconnue." });
    }

    if (PROTEGE.includes(action)) {
      const attendu = process.env.CODE_LIGUE;
      if (!attendu) {
        return res.status(500).json({
          erreur: "Aucun code de ligue défini côté serveur (variable CODE_LIGUE).",
        });
      }
      if (code !== attendu) {
        return res.status(403).json({ erreur: "Code incorrect." });
      }
      if (action === "verifier") return res.status(200).json({ ok: true });
    }

    const { joueurs, matchs } = await etat(redis);

    switch (action) {
      case "joueur:ajouter": {
        const nom = String(corps.nom || "").trim();
        if (!nom) return res.status(400).json({ erreur: "Entrez un nom." });
        if (nom.length > 24) return res.status(400).json({ erreur: "Pseudo trop long." });
        if (joueurs.some((j) => j.nom.toLowerCase() === nom.toLowerCase()))
          return res.status(409).json({ erreur: "Ce pseudo est déjà pris." });
        const joueur = { id: crypto.randomUUID(), nom, depuis: new Date().toISOString() };
        await redis.hset(CLE_JOUEURS, { [joueur.id]: JSON.stringify(joueur) });
        break;
      }

      case "joueur:renommer": {
        const nom = String(corps.nom || "").trim();
        const joueur = joueurs.find((j) => j.id === corps.id);
        if (!joueur) return res.status(404).json({ erreur: "Joueur introuvable." });
        if (!nom) return res.status(400).json({ erreur: "Le pseudo ne peut pas être vide." });
        if (joueurs.some((j) => j.id !== joueur.id && j.nom.toLowerCase() === nom.toLowerCase()))
          return res.status(409).json({ erreur: "Ce pseudo est déjà pris." });
        await redis.hset(CLE_JOUEURS, { [joueur.id]: JSON.stringify({ ...joueur, nom }) });
        break;
      }

      case "joueur:retirer": {
        const joueur = joueurs.find((j) => j.id === corps.id);
        if (!joueur) return res.status(404).json({ erreur: "Joueur introuvable." });
        const siens = matchs.filter((m) => joueursDuMatch(m).includes(joueur.id));
        const dernier = siens.reduce((max, m) => (m.date > max ? m.date : max), joueur.depuis || "");
        const inactifDepuisUnAn = dernier && Date.now() - new Date(dernier).getTime() >= AN_MS;
        if (!inactifDepuisUnAn && code !== process.env.CODE_LIGUE) {
          return res.status(403).json({
            erreur: "Ce joueur a joué il y a moins d'un an : le code de la ligue est nécessaire.",
          });
        }
        await redis.hdel(CLE_JOUEURS, joueur.id);
        if (siens.length) await redis.hdel(CLE_MATCHS, ...siens.map((m) => m.id));
        break;
      }

      case "match:ajouter": {
        const m = corps.match || {};
        const ids = [m?.a?.atk, m?.a?.def, m?.b?.atk, m?.b?.def];
        if (ids.some((id) => !id) || new Set(ids).size !== 4)
          return res.status(400).json({ erreur: "Il faut quatre joueurs différents." });
        if (ids.some((id) => !joueurs.some((j) => j.id === id)))
          return res.status(400).json({ erreur: "Un des joueurs n'est plus inscrit." });
        if (!scoreValide(m.sa) || !scoreValide(m.sb))
          return res.status(400).json({ erreur: `Les scores vont de ${MIN_SCORE} à ${MAX_SCORE}.` });
        if (m.sa === m.sb)
          return res.status(400).json({ erreur: "Il faut un vainqueur." });
        const match = {
          id: crypto.randomUUID(),
          date: new Date().toISOString(),
          a: { atk: m.a.atk, def: m.a.def },
          b: { atk: m.b.atk, def: m.b.def },
          sa: m.sa,
          sb: m.sb,
        };
        await redis.hset(CLE_MATCHS, { [match.id]: JSON.stringify(match) });
        break;
      }

      case "match:supprimer": {
        if (!matchs.some((m) => m.id === corps.id))
          return res.status(404).json({ erreur: "Match introuvable." });
        await redis.hdel(CLE_MATCHS, corps.id);
        break;
      }

      case "reinitialiser": {
        await redis.del(CLE_MATCHS);
        break;
      }
    }

    return res.status(200).json(await etat(redis));
  } catch (e) {
    return res.status(500).json({ erreur: "Erreur serveur : " + e.message });
  }
}
