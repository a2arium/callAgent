import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { createOperatorAuthRuntime, validateOperatorAuthEnvironment } from './index.js';

const production = process.env.CALLAGENT_MODE === 'production' || process.env.NODE_ENV === 'production';
const { baseURL, secret } = validateOperatorAuthEnvironment(process.env, production);
const store = new WorkingMemorySessionStore();
const prisma = store.getPrismaClient();
const runtime = createOperatorAuthRuntime({ prisma, baseURL, secret, production });
const owner = await (prisma as any).operatorInstallationOwner.findUnique({
  where: { id: 'primary' }, include: { user: true },
});
if (!owner) throw new Error('No installation owner exists');
const url = await runtime.generateResetLink(owner.user.email);
console.log(`Installation owner: ${owner.user.email}`);
console.log(`One-time reset link (expires in 1 hour): ${url}`);
await (prisma as any).$disconnect();
