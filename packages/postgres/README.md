# @orpc-agent/postgres

Postgres reference implementations of the [oRPC Agent](https://orpc-agent.dev) durability seams: `createPgApprovalCoordinator` (restart-surviving approvals with atomic single-use consumption) and `createPgAuditSink` (durable, strict-mode-safe audit trail). Driver-agnostic — bring any `(sql, params) => Promise<{ rows }>` function; DDL ships as exported strings.

> Independent community project, not affiliated with or endorsed by the oRPC maintainers.

## Install

```bash
pnpm add @orpc-agent/postgres @orpc-agent/core
```

Docs: [Postgres persistence guide](https://orpc-agent.dev/adapters/postgres) · [repository](https://github.com/Wiseair-srl/orpc-agent)

## License

[MIT](https://github.com/Wiseair-srl/orpc-agent/blob/main/LICENSE)
