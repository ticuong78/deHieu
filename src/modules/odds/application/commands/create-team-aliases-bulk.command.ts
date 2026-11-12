import { randomUUID } from 'node:crypto';
import type { CommandHandler } from '../../../../shared/application/cqrs.js';
import type { OperationStatus } from '../../../../shared/domain/domain-repository.js';
import { TeamAlias } from '../../domain/team-alias.js';
import type { TeamAliasRepository } from '../../domain/team-alias.repository.js';
import type { TeamNameResolver } from '../team-name.resolver.js';
import type { ReindexTeamAliasesHandler } from './reindex-team-aliases.command.js';

export interface CreateTeamAliasesBulkCommand {
  readonly aliases: readonly { alias: string; canonical: string }[];
}

export interface CreateTeamAliasesBulkResult {
  readonly created: TeamAlias[];
  readonly unchanged: string[];
  readonly failed: { alias: string; reason: string }[];
}

/** Ghi nhiều bí danh nhưng chỉ nạp resolver và ghép lại các trận một lần. */
export class CreateTeamAliasesBulkHandler implements CommandHandler<
  CreateTeamAliasesBulkCommand,
  OperationStatus<CreateTeamAliasesBulkResult>
> {
  constructor(
    private readonly _repo: TeamAliasRepository,
    private readonly _resolver: TeamNameResolver,
    private readonly _reindex: ReindexTeamAliasesHandler,
  ) {}

  async execute(cmd: CreateTeamAliasesBulkCommand): Promise<OperationStatus<CreateTeamAliasesBulkResult>> {
    const current = await this._repo.findAll();
    if (current.status !== 'SUCEED') return current.status === 'FAILED'
      ? current
      : { status: 'FAILED', reason: 'TEAM_ALIASES_UNAVAILABLE' };

    const known = new Map(current.data.map((a) => [a.props.alias, a.props.canonical]));
    const requested = new Map<string, TeamAlias>();
    const unchanged: string[] = [];
    for (const item of cmd.aliases) {
      let alias: TeamAlias;
      try {
        alias = TeamAlias.create({ id: randomUUID(), ...item });
      } catch {
        return { status: 'FAILED', reason: `TEAM_ALIAS_INVALID: ${item.alias} → ${item.canonical}` };
      }
      const { alias: name, canonical } = alias.props;
      const earlier = requested.get(name)?.props.canonical;
      if (earlier && earlier !== canonical)
        return { status: 'FAILED', reason: `TEAM_ALIAS_CONFLICT_IN_BATCH: ${name}` };
      const existing = known.get(name);
      if (existing && existing !== canonical)
        return { status: 'FAILED', reason: `TEAM_ALIAS_ALREADY_MAPPED: ${name} → ${existing}` };
      if (existing) unchanged.push(name);
      else requested.set(name, alias);
    }

    const created: TeamAlias[] = [];
    const failed: { alias: string; reason: string }[] = [];
    for (const alias of requested.values()) {
      const saved = await this._repo.save(alias);
      if (saved.status === 'SUCEED') created.push(saved.data);
      else failed.push({ alias: alias.props.alias, reason: saved.status === 'FAILED' ? saved.reason : 'NOT_FOUND' });
    }
    if (created.length) {
      await this._resolver.reload();
      await this._reindex.execute();
    }
    return { status: 'SUCEED', data: { created, unchanged: [...new Set(unchanged)], failed } };
  }
}
