# What sells contractor websites, and what they cost — October 2026

Research behind the azcontractorpro.net rebuild and the pricing decision.

## The market, by price

| Option | Up front | Monthly | First year | Notes |
|---|---|---|---|---|
| Agency custom build | $2,500–10,000 typical mid-range | $50–150 upkeep | $3,100–11,800 | 4–8 weeks; $15k–60k at the top end ([PipelineOn, Feb 2026](https://pipelineon.com/blog/contractor-website-cost/)) |
| Contractor marketing agencies | — | $2,000–15,000+ retainers | $24k+ | Hook Agency SEO from $2,800/mo, PPC from $2,000/mo ([PipelineOn, Oct 2026](https://pipelineon.com/blog/scorpion-vs-hook-agency/)) |
| Done-for-you subscriptions | usually $0 | $249–449 list | $2,988–5,388 | Topline Pro $249/$349/$399 (≈20% off yearly), month-to-month ([pricing](https://www.toplinepro.com/pricing)); GoSite $299/$349 ([PricingSaaS](https://pricingsaas.com/companies/gosite)); Hibu from $449, reviews describe trouble cancelling ([Capterra](https://www.capterra.com/p/207701/Hibu/pricing/)); 180Sites $195–300 on a 24-month term per a competitor's comparison ([Rebolt](https://rebolthq.com/alternatives/hook-agency-alternatives)) |
| Low-cost done-for-you | $199–499 | $59–125 | $907–1,700 | UENI $199 + $59/$125 ([UENI](https://get.ueni.com/wordpress/contractors/)); Jottful $199 setup if you sign within 48 h of the free sample, else $499, + $65/mo ([Jottful](https://jottful.com)) |
| DIY builders | $0–500 | $16–46 | $192–1,052 | Wix/Squarespace $16–46/mo ([PipelineOn](https://pipelineon.com/blog/contractor-website-cost/)); $0–500 up front and you do the work ([Northwest](https://northwest.net/learn/contractor-website-cost-washington-2026)); AI builders like Durable $15–95/mo ([Durable, Jan 2026](https://durable.com/blog/how-much-does-an-ai-website-builder-cost)) |
| **AZ Contractor Pro** | **$497 / $997 / $1,997** | **$49 / $99 / $199** | **$1,085 / $2,185 / $4,385** | no contract, buyer keeps the files |

First year = setup + 12 monthly charges (monthly starts 14 days after checkout, so 12
charges land inside the first year).

## Pricing decision: keep the current prices

* **Pro ($2,185 first year, $1,188 after)** is below every done-for-you subscription found
  ($2,988+) and below a typical agency build, and it is the only one in the set that
  hands over the files. That is the headline comparison on the site.
* **Starter ($1,085)** sits with the low-cost done-for-you players (UENI $907, Jottful
  $979–1,279) while being built for Arizona ROC contractors specifically. Its $497 setup
  is the highest setup in that group; the free live demo is what offsets it.
* **Kit ($4,385)** is in line with Topline Pro's top plan and well under any agency.
* Costs per customer are near zero with the autopilot, so these prices hold their margin.

Not changed, worth testing later:

1. **Demo-decision discount.** Jottful prices setup at $199 inside 48 hours of the free
   sample and $499 after. The same shape here — e.g. $200 off setup if you buy within 7
   days of your demo — gives the follow-up emails a real deadline. Needs a Stripe coupon
   and a 10-line change in `checkout.js`.
2. **Annual prepay.** Topline (~20%) and Rebolt (25%) discount yearly billing. A "2 months
   free" yearly price per tier improves cash flow and retention. Needs three new Stripe
   prices.

## What converts, and what the new site does about it

| Finding | On the site |
|---|---|
| Lead response speed: in a 15,000-lead study the odds of qualifying a lead fell ~21× between a 5- and a 30-minute response ([Search Influence summary](https://www.searchinfluence.com/blog/internet-form-response-times/)) | The demo is built and shown on the page in ~3 minutes instead of "within a day"; the follow-ups run on their own |
| Demo/contact forms convert ~3.8% median, 6.1% top quartile ([ClickMinded 2026](https://www.clickminded.com/landing-page-conversion-benchmark/)) | Track the hero work order against those numbers once traffic flows |
| Free samples before payment are a proven model (Jottful, UENI) | The free demo is the product: the buyer pays for the site they already saw |
| Arizona: since Sept 2021 certain ads may omit the ROC # if they show a web address whose **home page** shows the name and ROC # prominently, not just in the footer ([AZ ROC](https://www.azroc.gov/news/changes-arizona-law-regarding-advertising-requirements-contractors)) | New section: every site puts both in the header and first screen |
| Reviews: 74% of consumers want reviews from the last 3 months; 80% favour businesses that reply to all reviews ([BrightLocal 2026 via PinMeTo](https://www.pinmeto.com/news/brightlocal-local-consumer-review-survey-2026/)) | Cited on the Pro reviews line |
| Buyers distrust contracts and cancellation traps (Hibu reviews, 24-month terms elsewhere) | "No contract, cancel in the portal, keep your files" in the hero, pricing and FAQ |
| Contractors call | Phone number in the header, the form and the footer |

## The one risk the research surfaced

The ROC active list in the repo is a 2026-09-08 snapshot. The target buyer is a
*newly* licensed contractor, so every licence issued after that date is refused by the
three-minute demo and falls back to "we'll build it by hand". Refresh it monthly
(see AUTOPILOT.md).
