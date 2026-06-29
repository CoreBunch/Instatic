# Instatic → SaaS Multi-Tenant : Analyse & Feuille de Route

> Analyse du 2026-06-29 — basée sur le code Instatic présent sur `vps-tailscale`
> (`/root/workspace/instatic`) et l'image `ghcr.io/corebunch/instatic:latest` v0.0.6.

---

## 1. Comment fonctionne Instatic

### 1.1 Principe : un seul process Bun pour tout

Instatic est **monolithique et mono-processus**. Un `Bun.serve()` unique
(`server/index.ts`) porte l'intégralité du produit : éditeur visuel, content engine,
publisher, auth, plugins, AI chat, forms, media, DB.

```
┌───────────────── Un seul serveur Bun (port 3001) ─────────────────┐
│  Éditeur visuel (canvas)  │  Content engine  │  Publisher          │
│  Auth + sessions + MFA    │  Plugins         │  Media + variants   │
│  AI chat (Claude bridge)  │  Forms           │  DB (SQLite/PG)     │
└────────────────────────────────────────────────────────────────────┘
```

### 1.2 Stack technique

| Couche          | Techno                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| Runtime         | Bun ≥ 1.3                                                               |
| Server          | TypeScript natif, `Bun.serve` (pas de framework HTTP)                   |
| Frontend        | React + Vite (éditeur canvas)                                           |
| DB              | **SQLite** (défaut) ou **Postgres** — abstraction `DbClient`            |
| Storage         | Volume local `/app/uploads` (+ adaptateurs plugins S3/etc.)            |
| Reverse-proxy   | Caddy (HTTPS auto)                                                      |
| Licence         | **MIT**                                                                 |

### 1.3 La séparation édition / publié (point clé)

Instatic scinde déjà deux modes :

```
   ÉDITEUR (lourd)                    PUBLIÉ (léger)
   ┌─────────────────┐                ┌──────────────────┐
   │ 1 conteneur     │   --publish--> │  Fichiers stat.  │
   │ SQLite/Postgres │                │  dans /app/dist  │
   │ canvas + CMS    │                │  (HTML pur)      │
   └─────────────────┘                └──────────────────┘
```

L'output publié est du **HTML statique sémantique sans runtime** — rien de
l'éditeur ne fuit dans la page servie au visiteur.

### 1.4 La limite actuelle : single-site par conception

Le schéma de données est verrouillé sur **un seul site** :

```sql
create table if not exists site (
  id text primary key default 'default',   -- ← HARDCODÉ à 'default'
  ...
);
```

Et dans `server/repositories/site.ts` :

```ts
select ... from site where id = 'default'   // toujours le même site
insert into site (id, ...) values ('default', ...)
```

Pages, composants, media, users, plugins vivent dans une DB qui sert **un seul
site**. Aucune notion de tenant, de `tenant_id`, ni de multi-site.

---

## 2. Peut-on forker ? Oui, sans obstacle.

1. **Licence MIT** — fork, modification, redistribution commerciale permises
   (juste conserver la notice de copyright).
2. **Déjà fait en pratique** — l'image `instatic-zai` sur EGS est un build custom ;
   le repo est cloné à `/root/workspace/instatic` sur le VPS avec `.git`, `.agents`,
   `.fallowrc.jsonc`.
3. **Code propre et structuré** — séparation nette `server/` (handlers, repositories,
   auth) vs `src/core/` (logique métier), migrations versionnées, abstraction DB
   SQLite↔Postgres interchangeable.

---

## 3. Référence : comment font Framer et Webflow

### 3.1 L'astuce centrale commune

Les deux scindent l'architecture en deux, et exploitent le "Publish" comme une
**compilation** vers du contenu statique poussé sur un CDN :

```
        ┌──── MODE ÉDITION (lourd) ────┐    ┌──── MODE PUBLIÉ (léger) ────┐
        │  Builder / canvas / CMS      │    │  HTML statique sur CDN       │
        │  App multi-tenant            │    │  Pas de serveur d'app        │
        │  Une seule base partagée     │ ──▶│  Servi par edge network      │
        │  Auth, droits, facturation   │    │  Assets sur CDN dédié        │
        └──────────────────────────────┘    └──────────────────────────────┘
```

→ Le trafic public ne touche **jamais** la base de données. C'est ce qui permet
de scaler à des millions de sites.

### 3.2 Framer

- Compile vers du **React hydraté** (`hydrateRoot()`), pas du HTML brut.
- Hébergement **AWS** + edge network global, assets servis depuis
  `framerusercontent.com` (CDN dédié). 99.99 % uptime, déploiements <1 s.
- Les effets visuels (`whileHover`, scroll animations…) sont générés en **JS à
  l'exécution**, pas en CSS → runtime **non portable** → lock-in fort.
- **Modèle** : vend de l'hébergement, pas du code. Tu ne peux pas partir avec tes
  fichiers. Volontaire.

### 3.3 Webflow

- Compile vers du **HTML/CSS statique sémantique**, pas de framework runtime dans
  le rendu final.
- CDN global + AWS en backend ; SSR disponible pour les code components.
- Output **portable** (export possible au plan Workspace).
- Plus proche d'Instatic que de Framer — d'où le slogan Instatic :
  *"the pages it ships are clean enough to read in view-source"*.

### 3.4 Comparatif

|                       | Framer              | Webflow              | Instatic                |
| --------------------- | ------------------- | -------------------- | ----------------------- |
| Output publié         | React hydraté       | HTML statique        | HTML statique ✅        |
| Runtime dans la page  | Oui (~800 Ko JS)    | Minimal              | **0** ✅                |
| Séparation édit./pub. | Oui                 | Oui                  | **Oui** ✅              |
| Multi-tenant          | DB centralisée      | DB centralisée       | **Non** ❌              |
| Routage par domaine   | Dynamique (edge)    | Dynamique (edge)     | Statique (`PUBLIC_ORIGIN`) ❌ |
| CDN dédié             | `framerusercontent.com` | Webflow CDN      | Volume Docker local ❌  |
| Lock-in hébergement   | Fort                | Moyen                | **Aucun** (self-host MIT) ✅ |

**Verdict :** Instatic est structurellement plus proche de **Webflow** que de
Framer. Excellent point de départ pour un SaaS.

---

## 4. Gérer 1000 instances : les 3 modèles

### Option A — Silo : 1 conteneur par tenant

Chaque client = son propre conteneur Instatic + sa propre DB SQLite.

| Pour 1000 instances | Total estimé            |
| ------------------- | ----------------------- |
| RAM                 | ~245 Go (idle, ~245 Mo/instance) |
| Disque image        | ~336 Mo (1 image shared + data par tenant) |
| CPU                 | absorbé si faible trafic |

- ✅ Zéro refonte du code, isolation parfaite (sécurité + data), scale horizontal
  trivial, un tenant qui crash n'impacte personne.
- ❌ Ops lourde : 1000 conteneurs + 1000 Caddy + 1000 certificats TLS + 1000
  backups + 1000 upgrades. Nécessite Coolify/K8s + automatisation DNS/TLS
  (Caddy On-Demand TLS ou Traefik wildcard). Facture infra élevée.

> Modèle type Webflow/Sanity en self-hosted : un tenant = un déploiement.

### Option B — Multi-tenant natif (réécriture du cœur)

Un seul process Instatic sert 1000 sites, avec `tenant_id` partout.

Refonte profonde car le single-site est enraciné :

- Ajouter `tenant_id` sur **toutes** les tables (`data_rows`, `media_assets`,
  `users`, `site`, `published_runtime_assets`…).
- Revoir `site.ts` (le `where id = 'default'` partout).
- Resolver tenant par domaine (`PUBLIC_ORIGIN` dynamique).
- Isolation des uploads, plugins, credentials AI.
- Auth multi-tenant, quotas, facturation.

- ✅ RAM/CPU massivement mutualisés, ops centralisées, upgrades en une fois,
  coûts infra faibles.
- ❌ Refonte longue, risque de fuite de données entre tenants (un bug = tout le
  monde touché), contredit la philosophie du projet, dur à sync avec l'upstream.

### Option C — Hybride : pool + DB par tenant (recommandé)

Quelques instances Instatic partagées (mode Postgres), mais **1 schéma/DB par
tenant** pour l'isolation.

```
                    ┌─ Routeur tenant (domaine → instance + DB) ─┐
   *.nexio.work ───▶│  instatic-prod-1  ──▶  tenant_db_001       │
                    │  instatic-prod-2  ──▶  tenant_db_002 ...   │
                    └────────────────────────────────────────────┘
```

- Switch SQLite → **Postgres** (déjà supporté — `migrations-pg.ts` existe).
- Frontend de provisionnement : `POST /api/tenants` → crée un schéma PG +
  sous-domaine + DNS + TLS auto + redirige le bon process vers la bonne DB.
- ✅ Isolation des données sans 1000 conteneurs, scaling réel, coûts maîtrisés.
- ❌ Demande de la glue (router tenant, provisioning, DNS/TLS automatisé), mais
  moins de refonte que B.

### Architecture cible (façon Framer/Webflow)

```
   *.nexio.work ──┐                       ┌── CDN (R2/Cloudflare)
                  ├── Edge router ────────┤    /sites/tenant-42/*.html
   custom.com ────┘   (Caddy/Traefik)     │
                                        └── reverse-proxies to:

   ┌──────────────────────────────────────────────┐
   │  Instatic ÉDITEUR (1 process, multi-tenant)  │
   │  Postgres : table site (N lignes au lieu de 1)│
   │  + tenant_id partout                         │
   │  + resolver domaine → tenant                 │
   └──────────────────────────────────────────────┘
```

---

## 5. Recommandation

| Objectif                                       | Choix                    |
| ---------------------------------------------- | ------------------------ |
| Lancer vite, clients isolés, peu de budget dev | **Option A** (silo auto) |
| SaaS premium low-cost, dispo à investir code   | **Option C** (hybride PG) |
| Réinventer le produit                          | Option B (MT natif)      |

**Trajectoire conseillée : A court terme → C moyen terme.**

L'Option A permet de lancer dès maintenant avec l'image existante (0 refonte).
On migre vers C quand le volume justifie la mutualisation.

L'écart à combler pour un vrai SaaS façon Framer/Webflow n'est pas l'éditeur,
mais :

1. **Multi-tenant dans le modèle de données** — `tenant_id` partout, faire sauter
   le `where id = 'default'`.
2. **Séparation du stockage publié** — pousser le rendu vers CDN (R2/Cloudflare)
   au lieu du volume Docker local.
3. **Routing par domaine** — edge layer (Caddy/Traefik/Cloudflare worker).

Framer et Webflow valident cette architecture : ils scindent eux aussi l'édition
(multi-tenant) du rendu (statique/CDN). Instatic fait déjà le bon output ; il
lui manque le multi-tenant + le CDN.

---

## 6. Constats de mesure (VPS `vps-tailscale`)

### Conteneur `instatic-prod-app-1`

| Ressource        | Valeur                              |
| ---------------- | ----------------------------------- |
| CPU              | 0.48 %                              |
| RAM              | 244.5 MiB / 11.68 GiB (2.04 %)      |
| Réseau I/O       | 26.4 MB ↓ / 17.4 MB ↑               |
| Disque I/O       | 120 MB lus / 47.2 MB écrits         |
| PID              | 15                                  |
| Uptime           | 36 h (healthy)                      |

### Setup

| Élément        | Valeur                                                       |
| -------------- | ------------------------------------------------------------ |
| Domaine        | `https://builder.nexio.work` (`PUBLIC_ORIGIN`)              |
| Port exposé    | host `4001` → conteneur `3001`                               |
| Image          | `ghcr.io/corebunch/instatic:latest` (v0.0.6, officielle)    |
| DB             | SQLite (`/app/data/cms.db`)                                  |
| Volumes        | `uploads` + `data`                                           |
| Compose        | `/root/workspace/instatic/` (`compose.prod.yml` + sqlite + override) |

### Sources

- [Guide to Framer's Hosting Infrastructure](https://www.framer.com/help/articles/guide-to-framer-hosting-infrastructure/)
- [Hosting with Amazon CloudFront (Framer)](https://www.framer.com/help/articles/hosting-with-amazon-cloudfront/)
- [Why Framer Uses React to Build Sites](https://www.framer.com/blog/why-framer-uses-react-to-build-sites/)
- [I reverse-engineered Framer's React runtime (dev.to)](https://dev.to/ankur_khandlwal/i-reverse-engineered-framers-react-runtime-to-export-sites-as-static-html-b75)
- [Tech Behind Framer Websites (groenn)](https://groenn.framer.website/blog/framer-tech)
- [Webflow Component architecture / SSR (docs dev)](https://developers.webflow.com/code-components/component-architecture)
- [Webflow – DXP Scorecard](https://www.dxpscorecard.com/platform/webflow)
