# dlartcompany.com

Marketing site for **DLARTCOMPANY LLC** — an independent studio making games, technical books,
and art.

Built with [Astro](https://astro.build) and [Tailwind CSS](https://tailwindcss.com), deployed as
a static site to GitHub Pages.

## Local development

Requires Node 22+ (see `.nvmrc`).

```bash
npm install
npm run dev      # dev server at http://localhost:4321
npm run build    # production build into dist/
npm run preview  # serve the production build locally
npm run check    # TypeScript / Astro diagnostics
```

## Editing the site

### Copy

**All text on the site lives in [`src/data/content.ts`](src/data/content.ts).** Nothing else
needs to be touched to reword the page.

| What to change | Where |
| --- | --- |
| Studio name, tagline, contact email | `site` |
| Hero eyebrow, headline lines, intro | `hero` |
| Games / Books / Art statements | `sections` |
| About statement | `about` |
| Contact heading, blurb, button label | `contact` |
| Social links | `socials` |

Each entry in `sections` has an `eyebrow`, `heading`, `lede`, a `body` array of paragraphs, and
three short `notes` shown as pills. Adding a fourth section to the array automatically adds it to
both navs — `navItems` is derived from the same data, so they can't drift apart.

Entries in `socials` with an empty `href` are skipped at render time, so it's safe to leave a
placeholder in the list until the account exists.

The contact address is set once in `site.email` and used by the hero link, the contact button,
and the structured-data block.

### Imagery

Section visuals are generated SVG/gradient motifs in
[`src/components/Motif.astro`](src/components/Motif.astro) — deliberately atmospheric rather than
literal, so the page looks finished without real artwork. To swap in actual art, drop files in
`src/assets/` and replace a motif variant with Astro's `<Image />` component:

```astro
---
import { Image } from 'astro:assets';
import gamesArt from '../assets/games.jpg';
---
<Image src={gamesArt} alt="…" class="aspect-[4/5] w-full object-cover" />
```

Other assets:

- `public/favicon.svg` — favicon
- `public/og.png` — social share image, regenerate with `node scripts/generate-og.mjs`

### Theme

Colors, fonts, and fluid type scales are defined as Tailwind theme tokens at the top of
[`src/styles/global.css`](src/styles/global.css).

### Newsletter

Signup is intentionally not wired up yet. [`src/components/Contact.astro`](src/components/Contact.astro)
contains a commented-out form with instructions for pointing it at Buttondown, Mailchimp, or Kit
when you're ready — a third-party endpoint is required since the site is statically hosted.

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds and publishes to GitHub
Pages on every push to `main`.

Pages is already enabled on the repo (**Source: GitHub Actions**) and the custom domain is
already registered with GitHub, so the only outstanding step is DNS.

### Remaining setup: point DNS at GitHub

`dlartcompany.com` currently resolves to Squarespace. Update these records at the registrar
(Google Domains has migrated to Squarespace Domains) to move the domain to GitHub Pages.

Apex `dlartcompany.com` — replace the existing `A` records with these four:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

Optionally add the matching `AAAA` records for IPv6:

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

Subdomain `www` — repoint the `CNAME` record:

```
www  →  safreita.github.io
```

### After DNS propagates

Propagation can take up to 24h. Once it completes, GitHub issues a certificate automatically.
Then go to **Settings → Pages**, confirm the domain shows as verified, and tick
**Enforce HTTPS** (it can't be enabled before the certificate exists).

> **Note:** the repo is public because GitHub Pages requires a paid plan to publish from a
> private repository.

## Project structure

```
public/            static files served as-is (CNAME, favicon, og.png, robots.txt)
scripts/           one-off asset generation
src/
  components/      Nav, Hero, Section, StatementSection, Motif, Contact, Footer
  data/content.ts  all site copy
  layouts/         BaseLayout with SEO + Open Graph metadata
  pages/index.astro
  styles/global.css
```

The site is a single page with anchor sections. If a specific game, book, or artwork is ever
worth featuring on its own, add a file under `src/pages/` — the landing page doesn't need to
change.
