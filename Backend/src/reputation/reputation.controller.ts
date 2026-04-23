import { Controller, Get, Post, Param, NotFoundException } from '@nestjs/common';
import { ReputationService } from './reputation.service';
import { PrismaService } from '../prisma.service';

@Controller('users')
export class ReputationController {
  constructor(
    private readonly reputationService: ReputationService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/reputation')
  async getReputation(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const reputation = await this.reputationService.getReputation(id);
    return {
      userId: id,
      reputation,
    };
  }

  @Get(':id/reputation/history')
  async getReputationHistory(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const history = await this.reputationService.getReputationHistory(id);
    return {
      userId: id,
      history,
    };
  }

  @Post(':id/reputation/recalculate')
  async recalculateReputation(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const breakdown = await this.reputationService.updateReputationScore(id);
    return {
      userId: id,
      message: 'Reputation recalculated successfully',
      breakdown,
    };
  }
}
