# Changelog

## [0.7.0](https://github.com/memhtml/memhtml/compare/memhtml-v0.6.0...memhtml-v0.7.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* **cli:** three observable changes to the command surface. The global `--json` flag is removed — it was parsed, advertised and read by nothing, because the typed envelope is the only output — and because flags are now validated per command, passing it exits 2 rather than being ignored; drop it. A boolean flag no longer takes a space-separated value, so `--embed false` and the same spelling for `--detected`, `--fix`, `--check`, `--deep`, `--diff` and `--dry-run` exit 2; use `--embed=false` or `--no-embed`. And `memhtml sleep run` exits 1 when any phase failed, where it exited 0; a caller that treated exit 0 as success was reading an aborted run as a successful one. The envelope is unchanged in all three cases.
* **store:** a write naming an explicit `path` that already holds a memory now fails with `ERR_WRITE_CONFLICT` instead of replacing that memory. This reaches `memhtml write --path`, `memhtml apply`, and the MCP `memory_write` and `memory_write_batch` tools. The single exemption is `memhtml correct`, whose target is the file it is correcting. To replace a memory's content, use `memhtml correct <path>`; to add a new one, omit `--path` and let the store derive it. Callers relying on the old behaviour were relying on silent data loss, since the store's core invariant is that nothing is ever deleted.

### Features

* **cli:** doctor reports entity references written without a type ([5feed66](https://github.com/memhtml/memhtml/commit/5feed66d60509775cb8b1273f51143879d8eddae))
* **cli:** report per-entity last activity, as a report and never a signal ([638a263](https://github.com/memhtml/memhtml/commit/638a2630513875d8b818cddbfa9c04d95a397332))
* **cli:** resolve a moved citation forward, and pin one at a commit ([113e0a2](https://github.com/memhtml/memhtml/commit/113e0a2fe9f5a2dbfdcf9d4f92281dfb872d0cfe))
* **consolidator:** emit each candidate entity as a type and a name ([080c7c7](https://github.com/memhtml/memhtml/commit/080c7c7663b6fb3275ecfef7ed9eb5ebfb9e8206))
* **consolidator:** watermark over the sessions the agent reports reading ([f49b7e6](https://github.com/memhtml/memhtml/commit/f49b7e6abe2a72690214cb61bf7ee4003b7610b6))
* **index:** scope retrieval and listing by authored `<dl>` facets ([d73f537](https://github.com/memhtml/memhtml/commit/d73f537ec546af3ede7d6f2502a99ee8953dc30d))
* **sleep:** answer whether a run would change anything, without running one ([e06db04](https://github.com/memhtml/memhtml/commit/e06db047db588cdfc7cc7bd11755dab2aeb38158))
* **sleep:** stamp the origin session on a single-session consolidated memory ([bf9d573](https://github.com/memhtml/memhtml/commit/bf9d573418a67e5859cbe9e18479250a27a7c55e))
* **sleep:** write a consolidated entity with the corpus's own spelling ([6fdd001](https://github.com/memhtml/memhtml/commit/6fdd0017f25b26754f1e789776a94fff0b29735a))
* **store:** refuse an unusable explicit path when a caller asks for strict placement ([4e5afdb](https://github.com/memhtml/memhtml/commit/4e5afdb46ff13a67897a94dbb987e2bda58f3007))
* the consumer extension surface, and the entity path that made it reachable ([58221a7](https://github.com/memhtml/memhtml/commit/58221a7c2963200e0a38e201670a18c3377f6e28))


### Bug Fixes

* **cli:** fold the entity type the activity report scopes on ([afa026a](https://github.com/memhtml/memhtml/commit/afa026aedc85e4cf8f1245edd4925b575c956fe6))
* **cli:** parse against the flag table, and validate flags per command ([043d0eb](https://github.com/memhtml/memhtml/commit/043d0ebe48046ceeece2c934851082e7533ca763))
* **cli:** point a dead-ended path at the walk that repairs it ([360f106](https://github.com/memhtml/memhtml/commit/360f1066788b4055bf5de39117216ab48c3dfa38))
* **consolidator:** build the agent where it will be served ([f54879e](https://github.com/memhtml/memhtml/commit/f54879ecf363a7d55b6c8b29669d57e59100bfec))
* **consolidator:** measure the watermark's citations over the advancing set ([ee7099e](https://github.com/memhtml/memhtml/commit/ee7099e56e29caba4c763bde803a4e939bfcf2f2))
* **consolidator:** offer a barren answer the decoder accepts ([e18d7c5](https://github.com/memhtml/memhtml/commit/e18d7c537d19b933ff4eebed6678f685bdc2e232))
* **consolidator:** validate that the server answering is eve, and cap what it can lose ([c64433e](https://github.com/memhtml/memhtml/commit/c64433ed4c20ad784610d62d678f83b5431dba45))
* **domain:** remove withCollisionOrdinal's fixed points and make cosine total ([444ebe6](https://github.com/memhtml/memhtml/commit/444ebe6b17032c0ec812a50b64076c91621723eb))
* **html:** make the datetime grammar match the string comparison it feeds ([1994ef1](https://github.com/memhtml/memhtml/commit/1994ef1a36a45352415ed4097defe7c1ba46fda5))
* **index:** drop the predicate that made both edge indexes unusable by the graph walk ([601ea60](https://github.com/memhtml/memhtml/commit/601ea6006623b58a5f0f12af3ee785949edeecf4))
* **index:** find an entity regardless of how its name is capitalized ([6e5b4fa](https://github.com/memhtml/memhtml/commit/6e5b4fa2adf3c98e78d6a18201936790229ffa44))
* **index:** probe the edge index when a search hit reports what superseded it ([51cc2fe](https://github.com/memhtml/memhtml/commit/51cc2fef995b3729b07e109b8f9902f196e1ce82))
* **index:** propagate renames and make an interrupted rebuild detectable ([077ba71](https://github.com/memhtml/memhtml/commit/077ba7100270e8f6f4aeec2d62e9437cc076c43b))
* **llm:** bound a hung Bedrock socket without capping a legitimate answer ([0606f2d](https://github.com/memhtml/memhtml/commit/0606f2d95b63a610b687e7c620d04cd6ada6f4d0))
* **mcp:** resolve multi-segment resource paths and stop leaking absolute paths ([38580fd](https://github.com/memhtml/memhtml/commit/38580fd4123ab8188b297a55d9035760e9bbe8f0))
* **mcp:** withhold a pinned citation for a path its commit does not hold ([53e37dc](https://github.com/memhtml/memhtml/commit/53e37dc02dc00f58f5b4a2457cb25eef369ad74e))
* **sleep:** canonicalize a consolidated entity's name, never its type ([7de5cf1](https://github.com/memhtml/memhtml/commit/7de5cf175a9b210b7d42b451fc18254310cb0124))
* **sleep:** contain a consolidated memory's origin session by the run's batch ([95c4a33](https://github.com/memhtml/memhtml/commit/95c4a337d4eed2f7406156fb94727ac8cbbd662c))
* **sleep:** make the abort real, and stop a failed phase contaminating a later one ([03ab20b](https://github.com/memhtml/memhtml/commit/03ab20b90d6997880a6c7d39d078114f4d6bcda8))
* **sleep:** weigh the plan's counts against the commit they describe ([c202dce](https://github.com/memhtml/memhtml/commit/c202dcedcdd86b6290adc21c41d2aa966c2a74a7))
* **store:** refuse a blank explicit path under strict placement ([4cdaf18](https://github.com/memhtml/memhtml/commit/4cdaf187ca1f75b420aea76b5926ff310d65450c))
* **store:** refuse an explicit path that is taken, and compensate a failed commit ([86acbd3](https://github.com/memhtml/memhtml/commit/86acbd313c2c463e7eaaab20db30f4fca6880e17))
* the v0.6.0 tech-debt sprint ([e679b12](https://github.com/memhtml/memhtml/commit/e679b1257ebba4a87a364933df03efcfeb48e4e7))
* **traces:** a failed transcript read no longer advances the watermark ([f77fedc](https://github.com/memhtml/memhtml/commit/f77fedc444b37ca505a163016bf7d63b476ff89c))

## [0.6.0](https://github.com/memhtml/memhtml/compare/memhtml-v0.5.1...memhtml-v0.6.0) (2026-08-24)


### Features

* **cli:** --deep and --max-llm-calls on sleep run ([702d029](https://github.com/memhtml/memhtml/commit/702d029c8febfabaaf5c282ec8c6671449bf4c1c)), closes [#63](https://github.com/memhtml/memhtml/issues/63)
* **sleep:** deep-sleep cycle — memhtml sleep run --deep ([673e921](https://github.com/memhtml/memhtml/commit/673e921ce1708b2ac8cc5caa6af22f39b1addf18))
* **sleep:** deep-sleep cycle — reach the inbox tail the community gate excludes ([6c0a4d0](https://github.com/memhtml/memhtml/commit/6c0a4d0f808771e173711f02061bfe93f4ff398c)), closes [#63](https://github.com/memhtml/memhtml/issues/63)

## [0.5.1](https://github.com/memhtml/memhtml/compare/memhtml-v0.5.0...memhtml-v0.5.1) (2026-08-23)


### Bug Fixes

* **sleep:** count unresolved model-named keys in the four sibling phases and hold their sweeps back ([7d238ea](https://github.com/memhtml/memhtml/commit/7d238eacf1cd8d1e807c985999c2e36f11bb041a))
* **sleep:** count unresolved model-named keys in the four sibling phases and hold their sweeps back ([bb32af7](https://github.com/memhtml/memhtml/commit/bb32af77ce09c004e98267509e2efbcb3412046e))
* **sleep:** partition compress's skipped count into failed and refused, and log each refusal ([c6dcfea](https://github.com/memhtml/memhtml/commit/c6dcfea272e4be3735ea790ef6f721c9054c67da))
* **sleep:** partition compress's skipped count into failed and refused, and log each refusal ([4a134d7](https://github.com/memhtml/memhtml/commit/4a134d7925126e26c84f1238b5a5a71dd8af3dd1))
* **sleep:** resolve the label-prefixed member-key spelling the batch prompt displays ([9de2b3b](https://github.com/memhtml/memhtml/commit/9de2b3b12be23950862b9078141705c14a63a0ac))
* **sleep:** resolve the label-prefixed member-key spelling the batch prompt displays ([1ec5a32](https://github.com/memhtml/memhtml/commit/1ec5a3275a77597121f20d35089892ac8247443c))

## [0.5.0](https://github.com/memhtml/memhtml/compare/memhtml-v0.4.0...memhtml-v0.5.0) (2026-08-23)


### Features

* **llm:** route structured sleep phases through gpt-5.6-sol strict json_schema ([#55](https://github.com/memhtml/memhtml/issues/55)) ([1dcd320](https://github.com/memhtml/memhtml/commit/1dcd32012941c82aec9d92b72fbc26d129063241))


### Bug Fixes

* **llm:** unwrap one level of JSON-string double-encoding in decodeToolInput ([#54](https://github.com/memhtml/memhtml/issues/54)) ([d17ef98](https://github.com/memhtml/memhtml/commit/d17ef983b0eb03df50b543ca47303d7d6970a88c)), closes [#53](https://github.com/memhtml/memhtml/issues/53)

## [0.4.0](https://github.com/memhtml/memhtml/compare/memhtml-v0.3.0...memhtml-v0.4.0) (2026-08-20)


### Features

* **sleep:** task detection — mint task files from evidence the store already sees ([#48](https://github.com/memhtml/memhtml/issues/48)) ([d647119](https://github.com/memhtml/memhtml/commit/d6471198952c3ae1ac3c1c443dfd96d6309d89cf))


### Bug Fixes

* **consolidator:** verify cited quotes against the transcript, decoded arm included ([#52](https://github.com/memhtml/memhtml/issues/52)) ([6547d9c](https://github.com/memhtml/memhtml/commit/6547d9c17fe1a1ffa8d9e12dcc20d9344986b79d))

## [0.3.0](https://github.com/memhtml/memhtml/compare/memhtml-v0.2.5...memhtml-v0.3.0) (2026-08-19)


### Features

* **sleep:** cluster→batch→structured-list resolution for entity resolution, dedup, and edge typing ([#45](https://github.com/memhtml/memhtml/issues/45)) ([802679f](https://github.com/memhtml/memhtml/commit/802679f45c4fd2942c9b30533559556bdc2803ab))

## [0.2.5](https://github.com/memhtml/memhtml/compare/memhtml-v0.2.4...memhtml-v0.2.5) (2026-08-19)


### Bug Fixes

* **sleep:** rank pair candidates in a decode-once kernel, not an n×n UDF self-join ([e3d5a87](https://github.com/memhtml/memhtml/commit/e3d5a87927d814b81028a7ef0f03d701a30b9f3c))
* **sleep:** rank pair candidates in a decode-once kernel, not an n×n UDF self-join ([98af023](https://github.com/memhtml/memhtml/commit/98af0239c5fee525751a974b7d6aedb51fb5ff14)), closes [#40](https://github.com/memhtml/memhtml/issues/40)

## [0.2.4](https://github.com/memhtml/memhtml/compare/memhtml-v0.2.3...memhtml-v0.2.4) (2026-08-18)


### Bug Fixes

* **mcp:** pin @effect/platform-node-shared into the published Effect set ([f621f69](https://github.com/memhtml/memhtml/commit/f621f6974f4fd35303ef47afa754c026c4ccc61c))

## [0.2.3](https://github.com/memhtml/memhtml/compare/memhtml-v0.2.2...memhtml-v0.2.3) (2026-08-18)


### Bug Fixes

* **docs:** centre the title block's lines on the column, not the prose measure ([bc3220d](https://github.com/memhtml/memhtml/commit/bc3220de5f37d50459c539bc3932f1ba1bdb82f0))
* **docs:** let the title block's lines centre on the column, not the measure ([cd9be5c](https://github.com/memhtml/memhtml/commit/cd9be5c73845aea68675f3684e97bd72b4d7cc32))
* spell the system's own strings in US English ([5323446](https://github.com/memhtml/memhtml/commit/5323446fd86973920ee686b679fa59f5a6e86ad2))

## [0.2.2](https://github.com/memhtml/memhtml/compare/memhtml-v0.2.1...memhtml-v0.2.2) (2026-08-18)


### Bug Fixes

* **ci:** make a betterleaks no-op fail loudly instead of passing green ([ddd0e69](https://github.com/memhtml/memhtml/commit/ddd0e6901dbe0f95987c6475785e0906bcf89761))
* **contracts:** drop a quadratic regex whose safety depended on statement order ([ba2267f](https://github.com/memhtml/memhtml/commit/ba2267ff69943121ac532d9c7f06c7169c5ab984))
* **contracts:** drop a quadratic regex whose safety depended on statement order ([1296e77](https://github.com/memhtml/memhtml/commit/1296e775110ba195cec5182f282318f11717b50e))

## [0.2.1](https://github.com/memhtml/memhtml/compare/memhtml-v0.2.0...memhtml-v0.2.1) (2026-08-17)


### Bug Fixes

* **ci:** give the publish job its toolchain, and make a failed publish retryable ([e80b70a](https://github.com/memhtml/memhtml/commit/e80b70a7ec98a66c6235d418b9fabc399668388a))
* **ci:** give the publish job its toolchain, and make a failed publish retryable ([edb83f7](https://github.com/memhtml/memhtml/commit/edb83f75d9291a44448d80dc490a2fb29f6bdea2))

## [0.2.0](https://github.com/memhtml/memhtml/compare/memhtml-v0.1.0...memhtml-v0.2.0) (2026-08-17)


### Features

* **release:** assemble the workspace into one publishable `memhtml` ([344480b](https://github.com/memhtml/memhtml/commit/344480b4290d5b74db087d99a35e911a5dc5881f))
* **release:** make the twelve private, and gate the artifact by installing it ([215851c](https://github.com/memhtml/memhtml/commit/215851c8ea9e7b88f05f7e4b2649ab6e96e34a8c))
* **release:** publish one `memhtml` package, bundled with tsdown and gated by installing it ([f859d16](https://github.com/memhtml/memhtml/commit/f859d1697867c7aaca4763193ec50d23d7625212))
* **release:** publish the twelve packages to npm on merge to main ([6eb5f2b](https://github.com/memhtml/memhtml/commit/6eb5f2b4159428a4a673748db833c4e5bf78e330))
* **release:** publish the twelve packages to npm on merge to main ([2a044a2](https://github.com/memhtml/memhtml/commit/2a044a26e973065f8d2fa39d39cd5bcb5e5ef11a))
* **security:** supply-chain hardening — scorecard, SBOM, trivy, dependabot, badges ([90e5cc1](https://github.com/memhtml/memhtml/commit/90e5cc1c50e47398e6085cbf5758f9c2ae701f85))
* **security:** supply-chain hardening — scorecard, SBOM, trivy, dependabot, badges ([0fc8188](https://github.com/memhtml/memhtml/commit/0fc8188400eee14987d833bbabaa52b47cb82098))


### Bug Fixes

* **consolidator:** spawn eve through node, so a published install needs no pnpm ([5f66aed](https://github.com/memhtml/memhtml/commit/5f66aed15809a08a1a7016715de6f7460a1a1c82))
* **contracts:** keep two collision ordinals from naming one file at the length cap ([9e20005](https://github.com/memhtml/memhtml/commit/9e20005ce13081763a2ea9c6bb7be83a1aa76a96))
* **contracts:** keep two collision ordinals from naming one file at the length cap ([c470b9c](https://github.com/memhtml/memhtml/commit/c470b9ceb58ee9ac959e7a781c3576e7178e66a5))
* **docs:** declare the one layout shift this site ships, and gate every other one ([c0b4815](https://github.com/memhtml/memhtml/commit/c0b481540086766235643845567555d710522db6))
* **docs:** gate layout stability where the viewport cannot move under the measurement ([b963758](https://github.com/memhtml/memhtml/commit/b9637586510bc7297022347f6addd8d687cd96b5))
* **docs:** gate layout stability where the viewport cannot move under the measurement ([4973615](https://github.com/memhtml/memhtml/commit/4973615b971a118136a296d5ace098c6373166ef))
* **exec:** report a sandbox bridge fault as the runtime's failure, and re-run ([c2369b3](https://github.com/memhtml/memhtml/commit/c2369b3c71189a37c7a09917da51e7c1f494b726))
* **exec:** report a sandbox bridge fault as the runtime's failure, and re-run ([c993f64](https://github.com/memhtml/memhtml/commit/c993f649bab5cfc5869bd4eb8d524f57a564f0bc))
* **index:** persist embedMissing progress per slice, so a throttled pass is resumable ([f9b4ab6](https://github.com/memhtml/memhtml/commit/f9b4ab64c03015e743e8869da7f2ab17a4a7dbdc))
* **index:** persist embedMissing progress per slice, so a throttled pass is resumable ([c2391e1](https://github.com/memhtml/memhtml/commit/c2391e195af6123b921b128a2394d8ae58d336e2))
* **release:** carry guest/ and the consolidator's src/ into the published tarballs ([1022be0](https://github.com/memhtml/memhtml/commit/1022be0027a58c4aab76acfb4050ce339b9b19de))
* **release:** stop suppressing provenance, and bootstrap interactively rather than with a token ([a798967](https://github.com/memhtml/memhtml/commit/a79896752378e7fe0d056dfae2ee7f1839bac960))
* **release:** supply a git identity to the smoke tier, and document why one is needed ([47553d5](https://github.com/memhtml/memhtml/commit/47553d5294f7037a0264c44b9064e9ea51bf139a))
* **security:** resolve the first scan's findings, and set a 72-hour cooldown ([28207f1](https://github.com/memhtml/memhtml/commit/28207f1c9d50687d1153d5e04c525ef0ae66f54b))
* **store:** stop git's background maintenance in fixture repos, so teardown cannot race it ([6c80f19](https://github.com/memhtml/memhtml/commit/6c80f196fcf5aab4002cdfbf8343533388efaacc))
* **store:** stop git's background maintenance in fixture repos, so teardown cannot race it ([4fa54e6](https://github.com/memhtml/memhtml/commit/4fa54e6b154fbd5143b70ce7ba26f8ff7671e535))
