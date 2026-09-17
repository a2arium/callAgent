import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { assertTrustedOriginMutation, trustedOriginsFor } from './originPolicy.js';

export { trustedOriginsFor } from './originPolicy.js';

export type OperatorRole = 'viewer' | 'operator' | 'admin';

export type OperatorPrincipal = {
  tenantId: string;
  actorId: string;
  actorType: 'user';
  production: boolean;
  email: string;
  role: OperatorRole;
  sessionId: string;
  sessionCreatedAt: Date;
  installationOwner: boolean;
  mustChangePassword: boolean;
};

type PrismaLike = any;

export type OperatorAuthRuntimeOptions = {
  prisma: PrismaLike;
  baseURL: string;
  secret: string;
  production?: boolean;
  log?: (message: string) => void;
};

const internalSignup = new AsyncLocalStorage<boolean>();
const resetDelivery = new AsyncLocalStorage<{ resolve: (url: string) => void }>();
const ROLE_WEIGHT: Record<OperatorRole, number> = { viewer: 1, operator: 2, admin: 3 };

export function createOperatorAuthRuntime(options: OperatorAuthRuntimeOptions) {
  const { prisma, baseURL, secret } = options;
  const trustedOrigins = trustedOriginsFor(baseURL, options.production === true);
  const auth = betterAuth({
    appName: 'callAgent Observer',
    baseURL,
    basePath: '/operator-api/auth',
    secret,
    trustedOrigins,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    user: {
      modelName: 'OperatorAuthUser',
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
      additionalFields: {
        mustChangePassword: { type: 'boolean', required: false, defaultValue: false, input: false },
        bootstrapCredentialExpiresAt: { type: 'date', required: false, input: false },
      },
    },
    session: {
      modelName: 'OperatorAuthSession',
      expiresIn: 60 * 60 * 24,
      updateAge: 60 * 60,
      freshAge: 60 * 15,
    },
    account: {
      modelName: 'OperatorAuthAccount',
      accountLinking: { enabled: true, disableImplicitLinking: true },
    },
    verification: {
      modelName: 'OperatorAuthVerification',
      storeIdentifier: 'hashed',
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      autoSignIn: false,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ token }) => {
        const delivery = resetDelivery.getStore();
        if (!delivery) throw new APIError('FORBIDDEN', { message: 'Password reset delivery is disabled' });
        delivery.resolve(`${baseURL.replace(/\/$/, '')}/operator/reset-password?token=${encodeURIComponent(token)}`);
      },
      onPasswordReset: async ({ user }) => {
        await prisma.operatorAuthUser.update({
          where: { id: user.id },
          data: { mustChangePassword: false, bootstrapCredentialExpiresAt: null },
        });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email' && internalSignup.getStore() !== true) {
          throw new APIError('FORBIDDEN', { message: 'Public registration is disabled' });
        }
        if (ctx.path === '/request-password-reset' && !resetDelivery.getStore()) {
          throw new APIError('FORBIDDEN', { message: 'Self-service password reset is disabled' });
        }
      }),
    },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: options.production === true,
      },
    },
  });

  const sessionFor = async (req: Request) => {
    return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  };

  const ownerId = async (): Promise<string | undefined> => {
    const owner = await prisma.operatorInstallationOwner.findUnique({ where: { id: 'primary' } });
    return owner?.userId;
  };

  const resolvePrincipal = async (req: Request, minimumRole: OperatorRole = 'viewer'): Promise<OperatorPrincipal> => {
    const session = await sessionFor(req);
    if (!session) throw new OperatorHttpError(401, 'AUTH_REQUIRED', 'Sign in is required');
    const user = session.user as typeof session.user & { mustChangePassword?: boolean; bootstrapCredentialExpiresAt?: Date | string | null };
    if (user.mustChangePassword) {
      const expiresAt = user.bootstrapCredentialExpiresAt ? new Date(user.bootstrapCredentialExpiresAt) : undefined;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw new OperatorHttpError(403, 'BOOTSTRAP_CREDENTIAL_EXPIRED', 'Use the owner recovery command');
      }
      throw new OperatorHttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change the temporary password first');
    }
    const tenantId = normalizedHeader(req, 'x-tenant-id');
    if (!tenantId) throw new OperatorHttpError(400, 'TENANT_REQUIRED', 'Select a tenant');
    const membership = await prisma.operatorTenantMembership.findUnique({
      where: { userId_tenantId: { userId: user.id, tenantId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new OperatorHttpError(403, 'MEMBERSHIP_REQUIRED', 'An active tenant membership is required');
    }
    const role = fromDbRole(membership.role);
    if (ROLE_WEIGHT[role] < ROLE_WEIGHT[minimumRole]) {
      throw new OperatorHttpError(403, 'ROLE_REQUIRED', `${minimumRole} access is required`);
    }
    return {
      tenantId,
      actorId: user.id,
      actorType: 'user',
      production: options.production === true,
      email: user.email,
      role,
      sessionId: session.session.id,
      sessionCreatedAt: validSessionDate(session.session.createdAt),
      installationOwner: (await ownerId()) === user.id,
      mustChangePassword: false,
    };
  };

  const operatorMiddleware: RequestHandler = async (req, res, next) => {
    try {
      assertTrustedOriginMutation(req, trustedOrigins);
      const role = requiredRole(req);
      const principal = await resolvePrincipal(req, role);
      (req as Request & { operatorContext?: OperatorPrincipal }).operatorContext = principal;
      next();
    } catch (error) {
      respondError(res, error);
    }
  };

  const router = createManagementRouter({ auth, prisma, baseURL, trustedOrigins, sessionFor, resolvePrincipal, ownerId });

  return {
    auth,
    authHandler: toNodeHandler(auth),
    managementRouter: router,
    operatorMiddleware,
    bootstrap: () => bootstrapFirstOwner({ auth, prisma, options }),
    generateResetLink: (email: string) => generateResetLink(auth, email, baseURL),
  };
}

function createManagementRouter(ctx: any): Router {
  const router = Router();

  router.get('/session', asyncRoute(async (req, res) => {
    const session = await ctx.sessionFor(req);
    if (!session) {
      res.status(401).json({ error: 'AUTH_REQUIRED' });
      return;
    }
    const user = session.user as any;
    const memberships = await ctx.prisma.operatorTenantMembership.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { tenantId: 'asc' },
    });
    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      mustChangePassword: user.mustChangePassword === true,
      bootstrapCredentialExpiresAt: user.bootstrapCredentialExpiresAt ?? null,
      installationOwner: (await ctx.ownerId()) === user.id,
      memberships: memberships.map((m: any) => ({ id: m.id, tenantId: m.tenantId, role: fromDbRole(m.role) })),
    });
  }));

  router.post('/complete-bootstrap-password', asyncRoute(async (req, res) => {
    assertTrustedOriginMutation(req, ctx.trustedOrigins);
    const session = await ctx.sessionFor(req);
    if (!session) throw new OperatorHttpError(401, 'AUTH_REQUIRED', 'Sign in is required');
    const user = await ctx.prisma.operatorAuthUser.findUnique({ where: { id: session.user.id } });
    if (!user?.mustChangePassword) throw new OperatorHttpError(409, 'PASSWORD_CHANGE_NOT_REQUIRED', 'The account does not have a temporary password');
    if (user.bootstrapCredentialExpiresAt && user.bootstrapCredentialExpiresAt.getTime() <= Date.now()) {
      throw new OperatorHttpError(403, 'BOOTSTRAP_CREDENTIAL_EXPIRED', 'Use the owner recovery command');
    }
    await ctx.auth.api.changePassword({
      headers: fromNodeHeaders(req.headers),
      body: { currentPassword: String(req.body?.currentPassword ?? ''), newPassword: String(req.body?.newPassword ?? ''), revokeOtherSessions: true },
    });
    await ctx.prisma.operatorAuthUser.update({
      where: { id: session.user.id }, data: { mustChangePassword: false, bootstrapCredentialExpiresAt: null },
    });
    res.json({ changed: true });
  }));

  router.get('/access', asyncRoute(async (req, res) => {
    const principal = await ctx.resolvePrincipal(req, 'admin');
    const [memberships, invitations] = await Promise.all([
      ctx.prisma.operatorTenantMembership.findMany({
        where: { tenantId: principal.tenantId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.prisma.operatorInvitation.findMany({
        where: { tenantId: principal.tenantId, status: { in: ['PENDING', 'CLAIMING'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    res.json({
      memberships: memberships.map(publicMembership),
      invitations: invitations.map(publicInvitation),
    });
  }));

  router.post('/access/invitations', asyncRoute(async (req, res) => {
    assertTrustedOriginMutation(req, ctx.trustedOrigins);
    const principal = await ctx.resolvePrincipal(req, 'admin');
    assertFresh(principal);
    const email = normalizeEmail(req.body?.email);
    const role = parseRole(req.body?.role);
    await ctx.prisma.operatorInvitation.updateMany({
      where: { tenantId: principal.tenantId, email, status: { in: ['PENDING', 'CLAIMING'] }, expiresAt: { lte: new Date() } },
      data: { status: 'REVOKED', revokedAt: new Date(), claimId: null, claimExpiresAt: null },
    });
    const rawToken = randomBytes(32).toString('base64url');
    const invitation = await ctx.prisma.$transaction(async (tx: any) => {
      const created = await tx.operatorInvitation.create({
        data: {
          tenantId: principal.tenantId,
          email,
          role: toDbRole(role),
          tokenHash: tokenHash(rawToken),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdByUserId: principal.actorId,
        },
      });
      await audit(tx, principal, 'access.invitation.created', { invitationId: created.id, role });
      return created;
    });
    res.status(201).json({
      invitation: publicInvitation(invitation),
      url: `${ctx.baseURL.replace(/\/$/, '')}/operator/invitations/accept?token=${encodeURIComponent(rawToken)}`,
    });
  }));

  router.post('/access/invitations/:id/revoke', asyncRoute(async (req, res) => {
    assertTrustedOriginMutation(req, ctx.trustedOrigins);
    const principal = await ctx.resolvePrincipal(req, 'admin');
    assertFresh(principal);
    const result = await ctx.prisma.$transaction(async (tx: any) => {
      const changed = await tx.operatorInvitation.updateMany({
        where: { id: req.params.id, tenantId: principal.tenantId, status: { in: ['PENDING', 'CLAIMING'] } },
        data: { status: 'REVOKED', revokedAt: new Date(), claimId: null, claimExpiresAt: null },
      });
      if (changed.count === 1) await audit(tx, principal, 'access.invitation.revoked', { invitationId: req.params.id });
      return changed;
    });
    if (result.count !== 1) throw new OperatorHttpError(404, 'INVITATION_NOT_FOUND', 'Invitation is not active');
    res.json({ revoked: true });
  }));

  router.patch('/access/memberships/:id', asyncRoute(async (req, res) => {
    assertTrustedOriginMutation(req, ctx.trustedOrigins);
    const principal = await ctx.resolvePrincipal(req, 'admin');
    assertFresh(principal);
    const updated = await ctx.prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `operator-admin:${principal.tenantId}`);
      const membership = await tx.operatorTenantMembership.findFirst({ where: { id: req.params.id, tenantId: principal.tenantId } });
      if (!membership) throw new OperatorHttpError(404, 'MEMBERSHIP_NOT_FOUND', 'Membership was not found');
      const role = req.body?.role === undefined ? fromDbRole(membership.role) : parseRole(req.body.role);
      const status = req.body?.status === undefined ? membership.status : parseMembershipStatus(req.body.status);
      const removesAdmin = membership.role === 'ADMIN' && membership.status === 'ACTIVE' && (role !== 'admin' || status !== 'ACTIVE');
      if (removesAdmin) {
        const admins = await tx.operatorTenantMembership.count({ where: { tenantId: principal.tenantId, role: 'ADMIN', status: 'ACTIVE' } });
        if (admins <= 1) throw new OperatorHttpError(409, 'LAST_ADMIN', 'Another active admin is required');
      }
      const owner = await tx.operatorInstallationOwner.findUnique({ where: { id: 'primary' } });
      if (owner?.userId === membership.userId && status !== 'ACTIVE') throw new OperatorHttpError(409, 'INSTALLATION_OWNER', 'Transfer installation ownership before disabling this membership');
      const changed = await tx.operatorTenantMembership.update({
        where: { id: membership.id }, data: { role: toDbRole(role), status },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      await audit(tx, principal, 'access.membership.updated', { membershipId: membership.id, role, status });
      return changed;
    });
    res.json(publicMembership(updated));
  }));

  router.post('/access/users/:userId/reset-link', asyncRoute(async (req, res) => {
    assertTrustedOriginMutation(req, ctx.trustedOrigins);
    const principal = await ctx.resolvePrincipal(req, 'admin');
    assertFresh(principal);
    if (!principal.installationOwner) throw new OperatorHttpError(403, 'INSTALLATION_OWNER_REQUIRED', 'Installation owner access is required');
    const user = await ctx.prisma.operatorAuthUser.findUnique({ where: { id: req.params.userId } });
    if (!user) throw new OperatorHttpError(404, 'USER_NOT_FOUND', 'User was not found');
    const url = await generateResetLink(ctx.auth, user.email, ctx.baseURL);
    await audit(ctx.prisma, { ...principal, tenantId: null }, 'access.password-reset.created', { targetUserId: user.id });
    res.json({ url });
  }));

  router.post('/access/owner/transfer', asyncRoute(async (req, res) => {
    assertTrustedOriginMutation(req, ctx.trustedOrigins);
    const principal = await ctx.resolvePrincipal(req, 'admin');
    assertFresh(principal);
    if (!principal.installationOwner) throw new OperatorHttpError(403, 'INSTALLATION_OWNER_REQUIRED', 'Installation owner access is required');
    const target = await ctx.prisma.operatorTenantMembership.findFirst({
      where: { userId: req.body?.userId, role: 'ADMIN', status: 'ACTIVE' },
    });
    if (!target) throw new OperatorHttpError(400, 'OWNER_TARGET_INVALID', 'The new owner must be an active tenant admin');
    await ctx.prisma.$transaction(async (tx: any) => {
      await tx.operatorInstallationOwner.update({ where: { id: 'primary' }, data: { userId: target.userId } });
      await audit(tx, { ...principal, tenantId: null }, 'access.owner.transferred', { targetUserId: target.userId });
    });
    res.json({ transferred: true, userId: target.userId });
  }));

  router.get('/invitations/inspect', asyncRoute(async (req, res) => {
    const invitation = await activeInvitation(ctx.prisma, String(req.query.token ?? ''));
    res.json({ emailHint: maskEmail(invitation.email), tenantId: invitation.tenantId, role: fromDbRole(invitation.role), expiresAt: invitation.expiresAt });
  }));

  router.post('/invitations/accept', asyncRoute(async (req, res) => {
    assertTrustedOriginMutation(req, ctx.trustedOrigins);
    const rawToken = String(req.body?.token ?? '');
    const invitation = await activeInvitation(ctx.prisma, rawToken);
    const claimId = randomUUID();
    const claimed = await ctx.prisma.operatorInvitation.updateMany({
      where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: 'CLAIMING', claimId, claimExpiresAt: new Date(Date.now() + 5 * 60 * 1000) },
    });
    if (claimed.count !== 1) throw new OperatorHttpError(410, 'LINK_EXPIRED_OR_USED', 'Invitation is no longer available');
    try {
      let user = await ctx.prisma.operatorAuthUser.findUnique({ where: { email: invitation.email } });
      if (user) {
        const session = await ctx.sessionFor(req);
        if (!session || normalizeEmail(session.user.email) !== invitation.email) {
          throw new OperatorHttpError(401, 'AUTH_REQUIRED', 'Sign in as the invited user to accept this membership');
        }
      } else {
        const name = String(req.body?.name ?? '').trim();
        const password = String(req.body?.password ?? '');
        if (!name) throw new OperatorHttpError(400, 'NAME_REQUIRED', 'Name is required');
        await internalSignup.run(true, () => ctx.auth.api.signUpEmail({ body: { name, email: invitation.email, password } }));
        user = await ctx.prisma.operatorAuthUser.findUnique({ where: { email: invitation.email } });
      }
      if (!user) throw new OperatorHttpError(500, 'IDENTITY_CREATE_FAILED', 'Identity was not created');
      await ctx.prisma.$transaction(async (tx: any) => {
        await tx.operatorTenantMembership.upsert({
          where: { userId_tenantId: { userId: user.id, tenantId: invitation.tenantId } },
          create: { userId: user.id, tenantId: invitation.tenantId, role: invitation.role, status: 'ACTIVE', createdByUserId: invitation.createdByUserId },
          update: { role: invitation.role, status: 'ACTIVE' },
        });
        await tx.operatorInvitation.update({
          where: { id: invitation.id },
          data: { status: 'ACCEPTED', acceptedByUserId: user.id, acceptedAt: new Date(), claimId: null, claimExpiresAt: null },
        });
        await tx.operatorAuditEvent.create({
          data: { tenantId: invitation.tenantId, action: 'access.invitation.accepted', actorType: 'user', actorId: user.id, accepted: true, requestedAt: new Date(), metadata: { invitationId: invitation.id } },
        });
      });
      res.json({ accepted: true, tenantId: invitation.tenantId });
    } catch (error) {
      await ctx.prisma.operatorInvitation.updateMany({
        where: { id: invitation.id, claimId, status: 'CLAIMING' },
        data: { status: 'PENDING', claimId: null, claimExpiresAt: null },
      });
      throw error;
    }
  }));

  return router;
}

async function bootstrapFirstOwner({ auth, prisma, options }: any): Promise<{ created: boolean; email?: string }> {
  if (await prisma.operatorInstallationOwner.findUnique({ where: { id: 'primary' } })) return { created: false };
  const claimId = randomUUID();
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  await prisma.operatorBootstrapState.upsert({
    where: { id: 'primary' },
    create: { id: 'primary', status: 'IDLE' },
    update: {},
  });
  const claimed = await prisma.operatorBootstrapState.updateMany({
    where: { id: 'primary', completedAt: null, OR: [{ status: 'IDLE' }, { claimExpiresAt: { lt: now } }] },
    data: { status: 'CLAIMING', claimedBy: claimId, claimExpiresAt },
  });
  if (claimed.count !== 1) return { created: false };
  const email = normalizeEmail(process.env.CALLAGENT_OPERATOR_BOOTSTRAP_EMAIL ?? 'admin@callagent.local');
  const tenantId = String(process.env.CALLAGENT_OPERATOR_BOOTSTRAP_TENANT_ID ?? 'default').trim() || 'default';
  const configuredPassword = process.env.CALLAGENT_OPERATOR_BOOTSTRAP_PASSWORD;
  const password = configuredPassword ?? randomBytes(24).toString('base64url');
  if (password.length < 12) throw new Error('CALLAGENT_OPERATOR_BOOTSTRAP_PASSWORD must contain at least 12 characters');
  let user = await prisma.operatorAuthUser.findUnique({ where: { email } });
  if (!user) {
    await internalSignup.run(true, () => auth.api.signUpEmail({ body: { name: 'Installation Owner', email, password } }));
    user = await prisma.operatorAuthUser.findUnique({ where: { email } });
  }
  if (!user) throw new Error('Failed to create the initial operator identity');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.$transaction(async (tx: any) => {
    await tx.operatorAuthUser.update({ where: { id: user.id }, data: { mustChangePassword: true, bootstrapCredentialExpiresAt: expiresAt } });
    await tx.operatorTenantMembership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId } },
      create: { userId: user.id, tenantId, role: 'ADMIN', status: 'ACTIVE' },
      update: { role: 'ADMIN', status: 'ACTIVE' },
    });
    await tx.operatorInstallationOwner.upsert({ where: { id: 'primary' }, create: { id: 'primary', userId: user.id }, update: { userId: user.id } });
    await tx.operatorBootstrapState.update({ where: { id: 'primary' }, data: { status: 'COMPLETED', completedAt: new Date(), claimedBy: null, claimExpiresAt: null } });
  });
  options.log?.(`Observer bootstrap email: ${email}`);
  if (!configuredPassword) options.log?.(`Observer temporary password (shown once, expires in 1 hour): ${password}`);
  return { created: true, email };
}

async function generateResetLink(auth: any, email: string, baseURL: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Better Auth did not produce a reset link')), 5000);
    resetDelivery.run({ resolve: (url) => { clearTimeout(timeout); resolve(url); } }, async () => {
      try {
        await auth.api.requestPasswordReset({ body: { email, redirectTo: `${baseURL.replace(/\/$/, '')}/operator/reset-password` } });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

class OperatorHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => { void handler(req, res).catch((error) => respondError(res, error)); };
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof OperatorHttpError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  const maybe = error as { status?: number; statusCode?: number; message?: string; code?: string };
  const status = maybe?.status ?? maybe?.statusCode ?? 500;
  res.status(status).json({ error: maybe?.code ?? 'OPERATOR_AUTH_ERROR', message: status >= 500 ? 'Operator authentication failed' : maybe?.message });
}

function requiredRole(req: Request): OperatorRole {
  if (/^\/agent-schedules\/[^/]+\/payload$/.test(req.path)) return 'operator';
  if (req.path === '/agent-schedules' && req.method === 'POST') return 'admin';
  if (/^\/agent-schedules\/[^/]+\/(replace|reschedule)$/.test(req.path)) return 'admin';
  if (/^\/agent-schedules\/[^/]+\/(run-now|pause|resume)$/.test(req.path)) return 'operator';
  if (req.method === 'DELETE') return 'admin';
  if (req.method === 'PATCH') return 'operator';
  if (/\/cancel$/.test(req.path)) return 'operator';
  if (req.path === '/rpc') {
    return req.body?.method === 'tasks/resubscribe' ? 'viewer' : 'operator';
  }
  return 'viewer';
}

function assertFresh(principal: OperatorPrincipal): void {
  if (Date.now() - principal.sessionCreatedAt.getTime() > 15 * 60 * 1000) {
    throw new OperatorHttpError(403, 'AUTH_REAUTH_REQUIRED', 'Sign in again before changing access');
  }
}

async function activeInvitation(prisma: PrismaLike, rawToken: string): Promise<any> {
  if (!rawToken) throw new OperatorHttpError(410, 'LINK_EXPIRED_OR_USED', 'Invitation is no longer available');
  let invitation = await prisma.operatorInvitation.findUnique({ where: { tokenHash: tokenHash(rawToken) } });
  if (invitation?.status === 'CLAIMING' && invitation.claimExpiresAt?.getTime() <= Date.now()) {
    invitation = await prisma.operatorInvitation.update({
      where: { id: invitation.id }, data: { status: 'PENDING', claimId: null, claimExpiresAt: null },
    });
  }
  if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt.getTime() <= Date.now()) {
    throw new OperatorHttpError(410, 'LINK_EXPIRED_OR_USED', 'Invitation is no longer available');
  }
  return invitation;
}

async function audit(prisma: PrismaLike, principal: any, action: string, metadata: Record<string, unknown>): Promise<void> {
  await prisma.operatorAuditEvent.create({
    data: { tenantId: principal.tenantId ?? null, action, actorType: 'user', actorId: principal.actorId, accepted: true, requestedAt: new Date(), metadata },
  });
}

function publicMembership(value: any) {
  return { id: value.id, tenantId: value.tenantId, role: fromDbRole(value.role), status: String(value.status).toLowerCase(), user: value.user };
}
function publicInvitation(value: any) {
  return { id: value.id, email: value.email, tenantId: value.tenantId, role: fromDbRole(value.role), status: String(value.status).toLowerCase(), expiresAt: value.expiresAt };
}
function tokenHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedHeader(req: Request, name: string): string | undefined { const value = req.header(name)?.trim(); return value || undefined; }
function normalizeEmail(value: unknown): string { const email = String(value ?? '').trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) throw new OperatorHttpError(400, 'EMAIL_INVALID', 'A valid email is required'); return email; }
function parseRole(value: unknown): OperatorRole { if (value === 'viewer' || value === 'operator' || value === 'admin') return value; throw new OperatorHttpError(400, 'ROLE_INVALID', 'Role must be viewer, operator, or admin'); }
function parseMembershipStatus(value: unknown): 'ACTIVE' | 'DISABLED' { if (value === 'active') return 'ACTIVE'; if (value === 'disabled') return 'DISABLED'; throw new OperatorHttpError(400, 'STATUS_INVALID', 'Status must be active or disabled'); }
function toDbRole(value: OperatorRole): string { return value.toUpperCase(); }
function fromDbRole(value: unknown): OperatorRole { return String(value).toLowerCase() as OperatorRole; }
function maskEmail(email: string): string { const [local, domain] = email.split('@'); return `${(local ?? '').slice(0, 1)}***@${domain ?? ''}`; }
function validSessionDate(value: unknown): Date { const date = new Date(value as string | number | Date); if (Number.isNaN(date.getTime())) throw new OperatorHttpError(403, 'AUTH_REAUTH_REQUIRED', 'Sign in again before changing access'); return date; }

export function validateOperatorAuthEnvironment(env: NodeJS.ProcessEnv, production: boolean): { baseURL: string; secret: string } {
  if (production && env.CALLAGENT_OPERATOR_AUTH_TOKEN) throw new Error('CALLAGENT_OPERATOR_AUTH_TOKEN was removed; configure named Observer users');
  const baseURL = env.CALLAGENT_PUBLIC_URL ?? (production ? undefined : 'http://127.0.0.1:8790');
  const secret = env.BETTER_AUTH_SECRET;
  if (!baseURL) throw new Error('CALLAGENT_PUBLIC_URL is required in production');
  if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  return { baseURL, secret };
}
