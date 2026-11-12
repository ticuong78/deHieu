import { normalizeTeamName } from '../domain/team-name.js';
import type { TeamAliasRepository } from '../domain/team-alias.repository.js';

/**
 * Application service: tên đội thô của tenant → tên chuẩn dùng làm khóa room.
 * Quy tắc chuẩn hóa (domain) + bảng bí danh (Postgres, điền qua API).
 */
export class TeamNameResolver {
  private _aliases = new Map<string, string>();

  constructor(private readonly _repo: TeamAliasRepository) {}

  /** Gọi lúc khởi động và sau mỗi lần thêm/xóa bí danh. */
  async reload(): Promise<void> {
    const r = await this._repo.findAll();
    if (r.status !== 'SUCEED') throw new Error('Cannot reload team aliases');
    this._aliases = new Map(
      r.data.map((a) => [a.props.alias, a.props.canonical]),
    );
  }

  resolve(raw: string): string {
    const n = normalizeTeamName(raw);
    return this._aliases.get(n) ?? n;
  }

  hasAlias(raw: string): boolean {
    return this._aliases.has(normalizeTeamName(raw));
  }
}
