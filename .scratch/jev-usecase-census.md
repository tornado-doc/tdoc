# What people build on Jev — GitHub census, 2026-09-21

Method: GitHub search for repositories mentioning Jev/TypeSafe created since 2026-09-15 (launch week): **675 repos, 40,400 stars total**. Each repo was classified into one of 16 categories by Jev itself (one Choice question per repo, batched 40 per request, 398k input tokens ≈ $0.017); 54 of 675 labels had confidence < 0.5 and were left as-is. This counts *builders on GitHub*, not X posts or views — a demo can be viral on X and produce zero repos.

| Category | Repos | % | Stars | Top repos |
|---|---:|---:|---:|---|
| SDKs / MCP servers / wrappers / awesome-lists | 176 | 26.1% | 4,567 | yibie/awesome-jev (654), v-modal/awesome-jev-tools (562), AbdelStark/awesome-typesafe (400) |
| Routing, gating, verification, judging | 110 | 16.3% | 1,879 | kerpopule/hermes-jev-skills (282), gargpratyush/jev-router (262), y0usaf/pi-jev (123) |
| Other / unclear | 60 | 8.9% | 2,280 | vinnylarouge/jevlike (1091), Sac-Y/Jev-cu (488), dabit3/jev-experiments (344) |
| Classification, triage, moderation | 57 | 8.4% | 737 | sutro-sh/jev-align (241), brainstormity/Jev-X-Sentiment-Analysis (139), giuliosmall/pg_typesafe (80) |
| Code review / dev tooling | 51 | 7.6% | 1,539 | thruwire/foreman (441), devagrawal09/jev-review (417), NiazMorshed2007/jev-review (186) |
| Games / real-time control | 41 | 6.1% | 596 | fhshaik/typesafe-mario (301), standardagents/jevpilot (129), phyous/tsai-sc (19) |
| Open clones / reimplementations | 41 | 6.1% | 6,118 | TheoLeeCJ/SemIf (2503), TianyuCodings/NanoJev (1486), featherless-ai/simple-jev (400) |
| Extraction, search, RAG | 33 | 4.9% | 945 | superagents-lab/jev-search (318), realZachi/pg-jev (249), uehaj/jev-semgrep (118) |
| Browser / web agents | 23 | 3.4% | 13,259 | browser-use/jev-ultrafast (12370), wy-coliney/jev-browser-use (264), jkudish/jev-browser (188) |
| Context pruning / compaction | 22 | 3.3% | 5,682 | tamaratran/fast-jev-compaction (5310), tamaratran/jev-pruner (128), hyperspaceai/jevcache (59) |
| Finance / trading | 19 | 2.8% | 1,685 | jarrodwatts/jev-trader (1568), aowang-ai/jev-trade (54), zadescoxp/Jev-Trades (21) |
| Computer / phone use | 15 | 2.2% | 527 | droidrun/mobile-jev (280), savka777/jev-use (74), yikangy873-gif/jev-desktop (45) |
| Voice / chat / support | 10 | 1.5% | 115 | w3cj/jev-chat (66), kyle-pena-nlp/jevchat (32), harshil1712/slidepilot (4) |
| Robotics / VLA / drones | 10 | 1.5% | 291 | FBddcz/embodied-jev (109), RomanSlack/jev-drone (87), Dimweaker/jev-libero (28) |
| Video / vision | 4 | 0.6% | 141 | ChetasLua/jevmeter (76), achimala/jev-paint (42), IamBusy/OpenJev-Vision (21) |
| SEO / content | 3 | 0.4% | 39 | AkashPriyadarshii/jev-seo (21), stas4000/jev-linkmap (16), kitze/pagegrade (2) |

## Reading the table
- **By number of builders**, the top uses are plumbing (SDKs/MCP/wrappers 26%) and the two "decision inside code" patterns: routing/gating/verification (16%) and classification/triage (8%). That is the boring, high-volume use.
- **By attention (stars)**, browser agents dominate: 23 repos hold 13.3k stars — a third of all stars — almost entirely browser-use/jev-ultrafast (12.4k). Next: clones (6.1k), context compaction (5.7k, mostly fast-jev-compaction 5.3k), finance/trading (1.7k, one repo).
- **Robotics/VLA/drones (10 repos, 291 stars), video/vision (4, 141), SEO (3, 39) are small on GitHub.** They are visible on X because the demos are spectacular (piano hands, drones, Mario), not because many people build them. jev-linkmap, the SEO repo quoted in the brief, has 16 stars.
- Computer/phone use is 15 repos / 527 stars (droidrun/mobile-jev 280 is the largest) — the space our simulator work sits in.
- Caveats: keyword search misses repos that don't say "Jev" in name/description; stars measure attention, not production use; categories were assigned by a model (spot-checked: jevlike is really a clone, dabit3/jev-experiments is a demo collection).

