import { Redis } from "@upstash/redis";

/* Fonction serveur unique de la ligue.
   Elle détient le code : le navigateur ne le voit jamais dans son code source.
   Les données vivent dans deux tables de hachage Redis, ce qui rend chaque
   ajout indépendant — deux collègues peuvent saisir en même temps sans s'écraser. */

const CLE_JOUEURS = "bf:joueurs";
const CLE_MATCHS = "bf:matchs";
const CLE_COEFS = "bf:coefs";

const AN_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_SCORE = -5;
const MAX_SCORE = 10;

// Coefficients par défaut du modèle Elo. Une base déjà en place qui n'a pas
// encore d'entrée "bf:coefs" utilise exactement ces valeurs : rien ne change
// tant que personne ne les modifie.
const COEFS_DEFAUT = {
  depart: 1500,     // Elo de départ
  k: 24,            // facteur K
  plancher: 4,      // variation minimale (gagnant comme perdant)
  partRole: 0.75,   // part de la variation sur le poste tenu (le reste sur l'autre)
  inactiviteJours: 91, // sans match depuis ce nombre de jours → sortie du classement + reset
  // Paliers du multiplicateur d'écart de buts : [écartMini, facteur], du plus grand au plus petit.
  paliers: [
    { ecart: 8, facteur: 5 },
    { ecart: 7, facteur: 4 },
    { ecart: 6, facteur: 3 },
    { ecart: 4, facteur: 2 },
    { ecart: 1, facteur: 1 },
  ],
};

const OUVERT = ["joueur:ajouter", "match:ajouter"];
const PROTEGE = ["verifier", "joueur:renommer", "match:supprimer", "match:modifier", "reinitialiser", "coefs:definir"];
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

/* ── Évaluateur d'expressions sûr (même logique que src/formule.js) ──
   Sert, côté serveur, à refuser une formule invalide ou dangereuse avant
   de la stocker. Aucune exécution de code arbitraire : parseur maison. */
const FN_MATH = {
  abs: Math.abs, min: Math.min, max: Math.max, log: Math.log, log10: Math.log10,
  sqrt: Math.sqrt, exp: Math.exp, pow: Math.pow, sign: Math.sign, round: Math.round,
  floor: Math.floor, ceil: Math.ceil,
};
const CONST_MATH = { pi: Math.PI, e: Math.E };

function compilerFormule(expr, variables) {
  if (typeof expr !== "string" || !expr.trim()) return { erreur: "Formule vide." };
  const toks = [];
  let i = 0;
  try {
    while (i < expr.length) {
      const c = expr[i];
      if (c === " " || c === "\t" || c === "\n") { i++; continue; }
      if (/[0-9.]/.test(c)) {
        let j = i; while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
        const nb = expr.slice(i, j);
        if ((nb.match(/\./g) || []).length > 1) throw new Error(`Nombre mal formé : « ${nb} »`);
        toks.push({ t: "nb", v: parseFloat(nb) }); i = j; continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let j = i; while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
        toks.push({ t: "id", v: expr.slice(i, j) }); i = j; continue;
      }
      if ("+-*/^(),".includes(c)) { toks.push({ t: c }); i++; continue; }
      throw new Error(`Caractère non autorisé : « ${c} »`);
    }
    let pos = 0;
    const pic = () => toks[pos], avance = () => toks[pos++];
    const attendre = (t) => { if (!pic() || pic().t !== t) throw new Error(`« ${t} » attendu`); return avance(); };
    function expr_() { let g = terme(); while (pic() && (pic().t === "+" || pic().t === "-")) { const op = avance().t; g = { type: "bin", op, g, d: terme() }; } return g; }
    function terme() { let g = fact(); while (pic() && (pic().t === "*" || pic().t === "/")) { const op = avance().t; g = { type: "bin", op, g, d: fact() }; } return g; }
    function fact() { const b = unaire(); if (pic() && pic().t === "^") { avance(); return { type: "bin", op: "^", g: b, d: fact() }; } return b; }
    function unaire() { if (pic() && pic().t === "-") { avance(); return { type: "neg", e: unaire() }; } if (pic() && pic().t === "+") { avance(); return unaire(); } return primaire(); }
    function primaire() {
      const tk = pic(); if (!tk) throw new Error("Expression incomplète.");
      if (tk.t === "nb") { avance(); return { type: "nb", v: tk.v }; }
      if (tk.t === "(") { avance(); const e = expr_(); attendre(")"); return e; }
      if (tk.t === "id") {
        avance();
        if (pic() && pic().t === "(") {
          avance(); const args = [];
          if (pic() && pic().t !== ")") { args.push(expr_()); while (pic() && pic().t === ",") { avance(); args.push(expr_()); } }
          attendre(")"); return { type: "appel", nom: tk.v, args };
        }
        return { type: "var", nom: tk.v };
      }
      throw new Error("Expression invalide.");
    }
    const arbre = expr_();
    if (pos < toks.length) throw new Error("Expression mal formée (texte en trop).");
    const verif = (n) => {
      if (n.type === "nb") return;
      if (n.type === "neg") return verif(n.e);
      if (n.type === "bin") { verif(n.g); verif(n.d); return; }
      if (n.type === "var") { if (!(n.nom in CONST_MATH) && !variables.includes(n.nom)) throw new Error(`Variable inconnue : « ${n.nom} »`); return; }
      if (n.type === "appel") { if (!(n.nom in FN_MATH)) throw new Error(`Fonction inconnue : « ${n.nom} »`); n.args.forEach(verif); return; }
      throw new Error("Nœud inconnu.");
    };
    verif(arbre);
    const ev = (n, vars) => {
      switch (n.type) {
        case "nb": return n.v;
        case "neg": return -ev(n.e, vars);
        case "var": return n.nom in CONST_MATH ? CONST_MATH[n.nom] : vars[n.nom];
        case "appel": return FN_MATH[n.nom](...n.args.map((a) => ev(a, vars)));
        case "bin": {
          const g = ev(n.g, vars), d = ev(n.d, vars);
          return n.op === "+" ? g + d : n.op === "-" ? g - d : n.op === "*" ? g * d : n.op === "/" ? g / d : Math.pow(g, d);
        }
      }
      throw new Error("Évaluation impossible.");
    };
    return { fn: (vars) => { const r = ev(arbre, vars); if (typeof r !== "number" || !isFinite(r)) throw new Error("Résultat non fini."); return r; } };
  } catch (e) {
    return { erreur: e.message };
  }
}

const VARS_DELTA = ["K", "mult", "E", "res", "ecart"];
const VARS_MULT = ["ecart"];

// Vérifie qu'une formule est valide ET produit un nombre fini sur des cas types.
function formuleSure(expr, variables, cas, label) {
  const { fn, erreur } = compilerFormule(expr, variables);
  if (erreur) return `${label} : ${erreur}`;
  for (const vars of cas) {
    try {
      const r = fn(vars);
      if (typeof r !== "number" || !isFinite(r)) return `${label} : résultat invalide sur un cas test.`;
    } catch (e) {
      return `${label} : ${e.message}`;
    }
  }
  return null;
}

async function litCoefs(redis) {
  let brut = null;
  try { brut = await redis.get(CLE_COEFS); } catch (e) {}
  const c = typeof brut === "string" ? JSON.parse(brut) : brut;
  // Fusion avec les valeurs par défaut : une base ancienne ou un champ manquant
  // retombe sur la valeur d'origine.
  return c && typeof c === "object" ? { ...COEFS_DEFAUT, ...c } : { ...COEFS_DEFAUT };
}

async function etat(redis) {
  const [j, m, coefs] = await Promise.all([
    redis.hgetall(CLE_JOUEURS),
    redis.hgetall(CLE_MATCHS),
    litCoefs(redis),
  ]);
  return {
    joueurs: valeurs(j).sort((a, b) => (a.depuis || "").localeCompare(b.depuis || "")),
    matchs: valeurs(m).sort((a, b) => a.date.localeCompare(b.date)),
    coefs,
  };
}

// Valide un jeu de coefficients envoyé par le client. Renvoie {coefs} nettoyé ou {erreur}.
function nettoieCoefs(entree) {
  if (!entree || typeof entree !== "object") return { erreur: "Coefficients absents." };
  const nb = (v) => (typeof v === "number" && isFinite(v) ? v : NaN);
  const depart = nb(entree.depart), k = nb(entree.k), plancher = nb(entree.plancher),
    partRole = nb(entree.partRole), inactiviteJours = nb(entree.inactiviteJours);
  if ([depart, k, plancher, partRole, inactiviteJours].some(Number.isNaN))
    return { erreur: "Chaque coefficient doit être un nombre." };
  if (depart < 100 || depart > 5000) return { erreur: "L'Elo de départ doit être entre 100 et 5000." };
  if (k <= 0 || k > 200) return { erreur: "K doit être entre 1 et 200." };
  if (plancher < 0 || plancher > k) return { erreur: "Le plancher doit être entre 0 et K." };
  if (partRole < 0.5 || partRole > 1) return { erreur: "La part du poste doit être entre 0,5 et 1." };
  if (inactiviteJours < 1 || inactiviteJours > 3650) return { erreur: "L'inactivité doit être entre 1 et 3650 jours." };

  let paliers = Array.isArray(entree.paliers) ? entree.paliers : COEFS_DEFAUT.paliers;
  paliers = paliers
    .map((p) => ({ ecart: nb(p.ecart), facteur: nb(p.facteur) }))
    .filter((p) => !Number.isNaN(p.ecart) && !Number.isNaN(p.facteur) && p.ecart >= 1 && p.facteur > 0)
    .sort((a, b) => b.ecart - a.ecart);
  if (!paliers.length) return { erreur: "Au moins un palier d'écart est nécessaire." };

  const coefs = { depart, k, plancher, partRole, inactiviteJours, paliers };

  // Formules personnalisées optionnelles : validées sur des cas types, sinon refusées.
  // Chaîne vide = retour au calcul standard pour cette formule.
  const casMult = [{ ecart: 1 }, { ecart: 5 }, { ecart: 10 }, { ecart: 0 }];
  const casDelta = [
    { K: k, mult: 1, E: 0.5, res: 1, ecart: 1 },
    { K: k, mult: 5, E: 0.9, res: 0, ecart: 10 },
    { K: k, mult: 2, E: 0.1, res: 1, ecart: 4 },
  ];
  const fmMult = typeof entree.formuleMult === "string" ? entree.formuleMult.trim() : "";
  const fmDelta = typeof entree.formuleDelta === "string" ? entree.formuleDelta.trim() : "";
  if (fmMult) {
    const err = formuleSure(fmMult, VARS_MULT, casMult, "Formule du multiplicateur");
    if (err) return { erreur: err };
    coefs.formuleMult = fmMult;
  }
  if (fmDelta) {
    const err = formuleSure(fmDelta, VARS_DELTA, casDelta, "Formule de Δ");
    if (err) return { erreur: err };
    coefs.formuleDelta = fmDelta;
  }

  return { coefs };
}

const joueursDuMatch = (m) => [m.a.atk, m.a.def, m.b.atk, m.b.def];

function scoreValide(n) {
  return Number.isInteger(n) && n >= MIN_SCORE && n <= MAX_SCORE;
}

// Valide le contenu d'un match. Renvoie une chaîne d'erreur, ou null si tout est bon.
function erreurMatch(m, joueurs) {
  const ids = [m?.a?.atk, m?.a?.def, m?.b?.atk, m?.b?.def];
  if (ids.some((id) => !id) || new Set(ids).size !== 4)
    return "Il faut quatre joueurs différents.";
  if (ids.some((id) => !joueurs.some((j) => j.id === id)))
    return "Un des joueurs n'est plus inscrit.";
  if (!scoreValide(m.sa) || !scoreValide(m.sb))
    return `Les scores vont de ${MIN_SCORE} à ${MAX_SCORE}.`;
  if (m.sa === m.sb) return "Il faut un vainqueur.";
  return null;
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
        const err = erreurMatch(m, joueurs);
        if (err) return res.status(400).json({ erreur: err });
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

      case "match:modifier": {
        const ancien = matchs.find((m) => m.id === corps.id);
        if (!ancien) return res.status(404).json({ erreur: "Match introuvable." });
        const m = corps.match || {};
        const err = erreurMatch(m, joueurs);
        if (err) return res.status(400).json({ erreur: err });
        // On garde l'identifiant et la date d'origine : seuls joueurs et score changent.
        const match = {
          ...ancien,
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

      case "coefs:definir": {
        const { coefs, erreur } = nettoieCoefs(corps.coefs);
        if (erreur) return res.status(400).json({ erreur });
        await redis.set(CLE_COEFS, JSON.stringify(coefs));
        break;
      }
    }

    return res.status(200).json(await etat(redis));
  } catch (e) {
    return res.status(500).json({ erreur: "Erreur serveur : " + e.message });
  }
}
