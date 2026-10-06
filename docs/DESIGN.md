# Design

Arena should look like a trading terminal someone chose to build, not a template. The rules below were set after auditing the first version against [Taste Skill](https://github.com/Leonxlnx/taste-skill)'s list of AI-generated UI tells. Taste Skill targets landing pages and excludes dashboards, so its tell list applies everywhere (intro, Wrapped, copy, type, colour, icons), and the desk follows its "cockpit" density guidance instead.

**Read:** an interactive trading simulator for engineers and hiring teams, in the sober language of a professional terminal. Variance 4, motion 3, density 7.

| Area | Rule |
|------|------|
| Colour | Neutral surfaces. Green and red only for buy/sell and profit/loss. One accent, amber, that always means "you": your orders, your primary actions, your progress. No gradients, glows or blur. |
| Shape | Panes are square and divided by 1px hairlines. Controls 6px radius, the intro dialog 10px. Nothing else is rounded. |
| Type | Geist for text, Geist Mono for every number (tabular figures). Sentence-case labels; no uppercase eyebrows. Fonts are bundled (the CSP allows no font CDN). |
| Icons | Phosphor only. No text glyphs (◆ ✓ ▲ ● ❚❚) standing in for icons. |
| Copy | Plain sentences, no em or en dashes, at most one middle dot per line, no cute headlines. Numbers are real, from the engine. |
| Motion | Only when something changed: a quantity tint, a note arriving, a depth bar easing. All of it is off under `prefers-reduced-motion`. |
| Stability | Fixed ladder slots and fixed-size boxes: nothing moves while the market moves (cumulative layout shift 0.009; a Playwright test keeps it under 0.05). |
| Themes | Dark and light, from the device setting; axe-core passes in both. |

## What the audit changed

| Before | After |
|--------|-------|
| Six equal cards in Wrapped | An asymmetric result page: the number, then advice, a hairline figure strip, a charges receipt and the audit trail |
| Three equal "under the hood" boxes | The journal gets the wide column |
| Intro with an eyebrow, two paragraphs, four bold-lead bullets, small print | A title, one sentence, two actions, one line of small print |
| "The market charged you for the lesson." | "Session result after charges" |
| `—` as the empty value | Words ("Flat", "None") or nothing |
| Gradient lesson strip, blurred backdrop | Flat bar, solid scrim |
| Two accents (blue and yellow) | One (amber) |
| Dark only | Dark and light |

Two tests guard this: `e2e_no_dashes_or_symbol_glyphs_in_visible_text` and `e2e_layout_stays_still_while_the_market_moves`.
