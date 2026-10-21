# Caitlin McCollom · portfolio

[![Test and deploy](https://github.com/adenjessee/cait-portfolio/actions/workflows/pages.yml/badge.svg)](https://github.com/adenjessee/cait-portfolio/actions/workflows/pages.yml)

A static site with no build step: plain HTML and JavaScript, with three.js loaded from a CDN.

**Live:** https://adenjessee.github.io/cait-portfolio/

## What's here

| Path | What it is |
|---|---|
| `index.html` | The page: hero, three interactive case studies, experience, contact |
| `js/sim.js` | The simulations behind the interactive pieces (delivery network, deployment pipeline, order engine). Pure, seeded and deterministic, with no DOM or WebGL, so they can be tested |
| `tests/sim.test.js` | 15 unit tests for the simulations |
| `assets/` | The hibiscus model (`hibiscus.glb`) and images |
| `tools/prepare-flower.sh` | Optimizes a 3D model for the web and builds the `file://` fallback |
| `.github/workflows/pages.yml` | CI/CD: every push runs the tests; only a passing build on `main` is deployed to GitHub Pages |

## Run it locally

```bash
npm test                      # simulation tests (Node 18+)
python3 -m http.server 8000   # then open http://localhost:8000
```

Opening `index.html` directly from disk works too, after running `tools/prepare-flower.sh assets/hibiscus.glb` once to build the base64 fallback for the model.

## Honesty notes

- Every simulation is labelled as illustrative.
- The Delivery Challenge is scaled down from about 200 clients to 24 and is not TAG Chemical's data or software.
- The game's deployment pipeline is planned and not yet connected to GitHub.
- Coursework is labelled as coursework.

## Credits

- Hibiscus 3D model generated with Tripo3D.
- [three.js](https://threejs.org) (MIT).
- Fonts: Fraunces, IBM Plex Sans and IBM Plex Mono (SIL Open Font License), served by Google Fonts.
