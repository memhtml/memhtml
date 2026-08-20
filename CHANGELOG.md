# Changelog

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
