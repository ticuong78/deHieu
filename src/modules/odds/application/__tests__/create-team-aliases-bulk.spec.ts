import { describe, expect, it, vi } from 'vitest';
import { CreateTeamAliasesBulkHandler } from '../commands/create-team-aliases-bulk.command.js';
import type { ReindexTeamAliasesHandler } from '../commands/reindex-team-aliases.command.js';
import { TeamNameResolver } from '../team-name.resolver.js';
import { TeamAlias } from '../../domain/team-alias.js';
import type { TeamAliasRepository } from '../../domain/team-alias.repository.js';

const makeRepo = (seed: TeamAlias[] = []) => {
  const items = new Map(seed.map((a) => [a.props.alias, a]));
  const save = vi.fn((alias: TeamAlias) => {
    items.set(alias.props.alias, alias);
    return Promise.resolve({ status: 'SUCEED' as const, data: alias });
  });
  const repo: TeamAliasRepository = {
    save,
    findAll: () => Promise.resolve({ status: 'SUCEED', data: [...items.values()] }),
    findById: () => Promise.resolve({ status: 'NOT_FOUND' }),
    delete: () => Promise.resolve({ status: 'NOT_FOUND' }),
  };
  return { repo, save };
};

describe('CreateTeamAliasesBulkHandler', () => {
  it('bỏ qua trùng lặp và chỉ ghép lại một lần', async () => {
    const existing = TeamAlias.create({ id: 'old', alias: 'navi', canonical: 'natus vincere' });
    const { repo, save } = makeRepo([existing]);
    const reindex = { execute: vi.fn(() => Promise.resolve()) } as unknown as ReindexTeamAliasesHandler;
    const resolver = new TeamNameResolver(repo);
    const result = await new CreateTeamAliasesBulkHandler(repo, resolver, reindex).execute({
      aliases: [
        { alias: 'NAVI', canonical: 'Natus Vincere' },
        { alias: 'GEN G', canonical: 'Generation Gaming' },
        { alias: 'gen g', canonical: 'Generation Gaming' },
        { alias: 'NIP', canonical: 'Ninjas in Pyjamas' },
      ],
    });
    expect(result.status).toBe('SUCEED');
    if (result.status !== 'SUCEED') return;
    expect(result.data.created).toHaveLength(2);
    expect(result.data.unchanged).toEqual(['navi']);
    expect(result.data.failed).toEqual([]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(reindex.execute).toHaveBeenCalledTimes(1);
    expect(resolver.resolve('GEN G')).toBe('generation');
  });

  it('từ chối cả nhóm nếu một bí danh đã trỏ sang tên khác', async () => {
    const existing = TeamAlias.create({ id: 'old', alias: 'nip', canonical: 'ninjas in pyjamas' });
    const { repo, save } = makeRepo([existing]);
    const reindex = { execute: vi.fn(() => Promise.resolve()) } as unknown as ReindexTeamAliasesHandler;
    const result = await new CreateTeamAliasesBulkHandler(repo, new TeamNameResolver(repo), reindex).execute({
      aliases: [
        { alias: 'alpha', canonical: 'alphabet' },
        { alias: 'NIP', canonical: 'another team' },
      ],
    });
    expect(result).toMatchObject({ status: 'FAILED', reason: 'TEAM_ALIAS_ALREADY_MAPPED: nip → ninjasinpyjamas' });
    expect(save).not.toHaveBeenCalled();
    expect(reindex.execute).not.toHaveBeenCalled();
  });
});
