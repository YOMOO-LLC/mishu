# Mishu (working name)

A private phone secretary for people, and an HTTP `/v1` API for other agents. Mishu answers and acts inside the Owner's authority, blocks abuse, and escalates to a human only when needed. Desktop keeps keys on the machine. The same engine runs as a headless reference host. Official builds disclose that the caller is speaking with AI; campaigns cannot turn that off.

**Status:** developer preview, pre-release. Not a production SLA.

Copyright and trademarks: YOMOO LLC. The working name is pending counsel review; this README does not claim a registered trademark.

## Architecture

One engine, one `/v1` contract, five ports, replaceable adapters. Diagram and package map: [docs/en/architecture.md](docs/en/architecture.md).

## Quickstart

Clone, `pnpm install`, `pnpm check`, then mock desktop or the headless reference host: [docs/en/quickstart.md](docs/en/quickstart.md).

## License

MIT. See [LICENSE](LICENSE).

## Trademark

The MIT license does not grant rights in the Mishu name, logo, or wordmark. See [TRADEMARK.md](TRADEMARK.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
