import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserProfileDto } from './dto/user-profile.dto';
import { calculateProfileCompleteness } from './utils/profile-completeness.util';

@Injectable()
export class UserProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, profileData: true, createdAt: true },
    });

    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const profile = (user.profileData as Record<string, any>) ?? {};
    const completeness = calculateProfileCompleteness(profile);

    return { userId: user.id, profile, completeness };
  }

  async updateProfile(userId: string, dto: UpdateUserProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const existing = (user.profileData as Record<string, any>) ?? {};
    const updated = { ...existing, ...dto };

    const result = await this.prisma.user.update({
      where: { id: userId },
      data: { profileData: updated },
      select: { id: true, profileData: true },
    });

    const completeness = calculateProfileCompleteness(
      result.profileData as Record<string, any>,
    );

    return { userId: result.id, profile: result.profileData, completeness };
  }

  async updateAvatar(userId: string, avatarUrl: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const existing = (user.profileData as Record<string, any>) ?? {};
    const updated = { ...existing, avatarUrl };

    const result = await this.prisma.user.update({
      where: { id: userId },
      data: { profileData: updated },
      select: { id: true, profileData: true },
    });

    return { userId: result.id, avatarUrl };
  }

  async searchProfiles(query: string, limit = 20) {
    // Fetch all and filter in-app; replace with DB full-text search in production
    const users = await this.prisma.user.findMany({
      take: limit * 5,
      select: { id: true, profileData: true },
    });

    return users
      .filter(u => {
        const profile = (u.profileData as Record<string, any>) ?? {};
        const name = (profile.displayName ?? '').toLowerCase();
        const bio = (profile.bio ?? '').toLowerCase();
        return name.includes(query.toLowerCase()) || bio.includes(query.toLowerCase());
      })
      .slice(0, limit);
  }
}