# SKILL: Ayuub Mahad — visual design standard

My personal design language for portfolio work (Kassa, Vakt, Kompass and beyond).
Use THIS instead of any generic/default template. Goal: work that looks like a senior
engineer-designer made it — opinionated, editorial, not AI-templated.

- **Date set:** 2026-08-24

## The direction: "Technical Editorial"

Present engineering work like a **Swiss technical journal / spec sheet**: rigorous modular
grid, asymmetry for energy, huge type doing the hierarchy, hairline rules that mean something,
generous whitespace, one decisive color. Precision *is* the brand.

## Hard bans (these read as AI-generated — never use)

- Rounded cards with drop shadows; pill "chips"; everything centered.
- Teal / mint accents; warm-cream (#F4F1EA) + serif + terracotta; purple→blue gradients.
- Inter or Space Grotesk as the primary face; emoji as section markers.
- A single acid-green/vermilion "pop" floating on near-black.

## Palette — warm bone / warm ink / signal red

Role-based tokens, defined for light (default), `prefers-color-scheme: dark`, and
`[data-theme]` stamps. Warm neutrals throughout (never pure grey), color used *structurally*.

```
/* light */            /* dark */
--bg:  #ECE9E1;        #121009
--bg-2:#E2DED2;        #1B1811
--fg:  #17150F;        #ECE7DB
--fg-2:#5B5749;        #968F7C
--rule:#C7C2B4;        #2E2B20   /* hairline */
--rule-2: var(--fg);             /* strong 1.5–3px rule */
--accent:  #D23A18;    #FF5B38   /* signal red — used boldly, not as a timid dot */
--on-accent:#F2EFE7;   #121009
```

The accent appears in: one word of the headline, one emphasized metric, section index
numbers of a real sequence, dotted-leader values, links. Never spray it.

## Type — Bricolage Grotesque / Hanken Grotesk / Space Mono

```
--display: "Bricolage Grotesque"  // characterful, NOT neutral. 700–800. letter-spacing -.02 to -.05em, line-height .9–1
--body:    "Hanken Grotesk"       // the workhorse. 400–600.
--mono:    "Space Mono"           // labels, data, indices, spec values. uppercase labels get .1–.14em tracking
```

Google Fonts (the only allowed host):
`https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Hanken+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap`

Type scale: hero `clamp(46px,10vw,118px)`; section h2 `clamp(28px,4.4vw,52px)`; body 18px;
mono labels 12–13px. Headings get `text-wrap: balance`, digits `tabular-nums`.

## Layout rules

- Modular grid via CSS `grid`/`gap`; **asymmetric** placement, left-aligned, wide max ~1180px.
- Structure with **hairline rules and negative space**, never boxes/cards.
- Metrics = big type in a grid split by 1px vertical rules + a 3px top rule. No containers.
- Numbered indices (01–05) ONLY for a real sequence (e.g. a request flow). Never as decoration.
- Engineering facts = a **dotted-leader spec list** (`LABEL …… value`), not chips.
- Footer = an oversized wordmark (`clamp(52px,13vw,168px)`) with the accent as the full stop.
- Squared corners everywhere (radius 0). Buttons are a bordered row, primary filled with accent.

## Non-negotiables (carry from good craft)

- Design all three theme states at the token level; `body` sets an explicit `background`.
- ~65-char measure for running text; visible keyboard focus; respect `prefers-reduced-motion`.
- Motion is minimal and earned (link underlines, one subtle reveal) — Swiss leans static.
- Real content only, written from the reader's side. Title the page like a product.

## Reference implementation

`kassa/docs/index.html` — the Kassa showcase built entirely from this standard.

## Reuse across projects

Keep the palette + type + layout system identical across Kassa / Vakt / Kompass so the three
read as one portfolio by one person. Vary only the accent's *role* and the content — not the
system. That consistency is itself the signal of a designer who has a standard.
