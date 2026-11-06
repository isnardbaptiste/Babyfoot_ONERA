# BabyFoot — Onera pro ligue du midi

Classement Elo du baby-foot de la pause de midi. Interface React, données partagées
par une petite fonction serveur, hébergement Vercel.

## Ce qu'il y a dans le dossier

```
index.html            page d'entrée
src/App.jsx           toute l'interface et le calcul Elo
src/api.js            appels vers la fonction serveur
api/ligue.js          fonction serveur : lecture, écriture, contrôle du code
package.json          dépendances et commandes
```

## Déploiement, une fois pour toutes (≈ 15 minutes)

### 1. Mettre le dossier sur GitHub

Depuis le dossier, une fois Git installé :

```bash
git init
git add .
git commit -m "Ligue de baby-foot"
```

Créez un dépôt vide sur github.com, puis suivez les deux lignes que GitHub affiche
(`git remote add origin …` et `git push -u origin main`).

### 2. Créer le projet Vercel

Sur vercel.com : **Add New → Project**, choisissez le dépôt. Vercel reconnaît Vite
tout seul — ne touchez pas aux réglages de compilation. Cliquez **Deploy**.
Le site sort sur une adresse en `.vercel.app`.

### 3. Brancher la base de données

Dans le projet Vercel : onglet **Storage → Create Database → Upstash (Redis)**.
Vercel provisionne la base et injecte les identifiants tout seul, il n'y a rien à copier.

### 4. Poser le code de la ligue

**Settings → Environment Variables**, ajoutez :

| Nom | Valeur |
| --- | --- |
| `CODE_LIGUE` | le code de votre choix, par exemple `Navierstockes95!` |

Cochez les trois environnements, enregistrez, puis **Deployments → … → Redeploy**
pour que la variable soit prise en compte.

C'est fini. Partagez l'adresse à vos collègues.

### Travailler en local (facultatif)

```bash
npm install
npm i -g vercel
vercel link      # rattache le dossier au projet
vercel env pull  # récupère les variables dans .env.local
vercel dev       # lance l'interface et la fonction serveur ensemble
```

`npm run dev` seul lance l'interface mais pas la fonction serveur : le classement
resterait vide.

## Comment les droits sont répartis

Ouvert à tous : consulter les classements, inscrire un joueur, enregistrer un match.

Sous le code de la ligue : renommer un joueur, modifier ou supprimer un match, réinitialiser le
classement, changer les coefficients et les formules du modèle Elo. Retirer un joueur est ouvert après un an sans match, et demande le code avant.

Le code est vérifié **dans la fonction serveur**, pas dans le navigateur. Contrairement
à un contrôle côté client, il n'apparaît nulle part dans le code source de la page.
Changez-le quand vous voulez dans les variables d'environnement, sans retoucher le code.

## Points à connaître

**Le forfait Hobby de Vercel est réservé à un usage personnel et non commercial.** Une
ligue de baby-foot ne rapporte rien, mais elle est hébergée dans un cadre professionnel :
la formulation de Vercel est assez large pour que la question se pose. Si votre service
informatique veut être strict, le forfait Pro est à 20 $ par mois, ou Cloudflare Pages
offre un équivalent gratuit sans cette restriction.

**Les données ne sont pas sauvegardées.** L'offre gratuite Upstash n'inclut pas de
sauvegarde automatique. Le contenu est minuscule : un appel à `/api/ligue` renvoie tout
le classement en JSON, gardez-en une copie de temps en temps.

**Les écritures concurrentes sont sûres.** Joueurs et matchs sont stockés séparément,
chacun sous sa propre clé : deux personnes qui saisissent en même temps ne s'écrasent pas.

**Tout est recalculé depuis l'historique.** Supprimer un match ou un joueur corrige
rétroactivement les Elo de chacun, sans dérive possible.

## Les règles du classement

- Départ à 1500 en attaque et en défense, général = moyenne des deux.
- Force d'une équipe = moyenne de l'Elo attaque de l'attaquant et de l'Elo défense du défenseur.
- K = 24, variation minimale de 4 points pour le vainqueur comme pour le perdant.
- Multiplicateur d'écart de buts : ×1 de 1 à 3 · ×2 de 4 à 5 · ×3 à 6 · ×4 à 7 · ×5 à partir de 8.
- Le poste tenu reçoit 3/4 de la variation, l'autre poste 1/4.
- Scores de −5 à 10, égalité refusée.
- Inactivité : sans match depuis plus de 3 mois, un joueur quitte le classement ; à son retour son Elo repart de 1500 (ses anciens matchs restent dans l'historique et ses statistiques de saison).

Ces valeurs sont regroupées en haut de `src/App.jsx` (`START`, `K`, `PLANCHER`,
`PART_ROLE`, `facteurEcart`) et dans `api/ligue.js` pour les bornes de score.
Si vous changez les bornes, modifiez les deux fichiers.
