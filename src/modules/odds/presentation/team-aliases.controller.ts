import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiZodBody } from '../../../shared/presentation/openapi.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { CreateTeamAliasHandler } from '../application/commands/create-team-alias.command.js';
import { CreateTeamAliasesBulkHandler } from '../application/commands/create-team-aliases-bulk.command.js';
import { DeleteTeamAliasHandler } from '../application/commands/delete-team-alias.command.js';
import { ListTeamAliasesHandler } from '../application/queries/list-team-aliases.query.js';
import { ODDS_PERMISSIONS as P } from '../application/odds.permissions.js';
import { RequirePermissions } from '../../auth/presentation/auth.decorators.js';
import { unwrap } from './http-errors.js';

const AliasBody = z.object({
  alias: z.string().min(1),
  canonical: z.string().min(1),
});
const BulkAliasBody = z.object({
  aliases: z.array(AliasBody).min(1).max(100),
});

/** Bí danh tên đội (CRUD). */
@Controller('team-aliases')
@ApiTags('Team aliases')
export class TeamAliasesController {
  constructor(
    @Inject(CreateTeamAliasHandler)
    private readonly _create: CreateTeamAliasHandler,
    @Inject(CreateTeamAliasesBulkHandler)
    private readonly _createBulk: CreateTeamAliasesBulkHandler,
    @Inject(DeleteTeamAliasHandler)
    private readonly _delete: DeleteTeamAliasHandler,
    @Inject(ListTeamAliasesHandler)
    private readonly _list: ListTeamAliasesHandler,
  ) {}

  @Get()
  @RequirePermissions(P.TEAM_ALIASES_READ)
  @ApiOperation({
    summary: 'Danh sách bí danh tên đội',
    description: 'Quyền: team-aliases:read',
  })
  async list() {
    return unwrap(await this._list.execute()).map((a) => a.toSnapShot());
  }

  @Post()
  @RequirePermissions(P.TEAM_ALIASES_WRITE)
  @ApiOperation({
    summary: 'Thêm bí danh (tự chuẩn hóa)',
    description: 'Quyền: team-aliases:write',
  })
  @ApiZodBody(AliasBody, {
    nip: { value: { alias: 'NIP', canonical: 'Ninjas in Pyjamas' } },
  })
  async create(@Body() body: unknown) {
    return unwrap(
      await this._create.execute(AliasBody.parse(body)),
    ).toSnapShot();
  }

  @Post('bulk')
  @RequirePermissions(P.TEAM_ALIASES_WRITE)
  @ApiOperation({
    summary: 'Tạo tối đa 100 bí danh cùng lúc',
    description: 'Kiểm tra trùng và xung đột trước khi ghi; chỉ ghép lại trận một lần sau khi ghi.',
  })
  @ApiZodBody(BulkAliasBody)
  async createBulk(@Body() body: unknown) {
    const result = unwrap(await this._createBulk.execute(BulkAliasBody.parse(body)));
    return {
      created: result.created.map((a) => a.toSnapShot()),
      unchanged: result.unchanged,
      failed: result.failed,
    };
  }

  @Delete(':id')
  @RequirePermissions(P.TEAM_ALIASES_WRITE)
  @ApiOperation({
    summary: 'Xóa bí danh',
    description: 'Quyền: team-aliases:write',
  })
  async remove(@Param('id') id: string) {
    return unwrap(await this._delete.execute({ id }));
  }
}
