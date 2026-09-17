import { describe, expect, it } from 'vitest';
import { hatchetRunUrl } from './client';

describe('hatchetRunUrl', () => {
  it('uses configured dashboard and tenant values with safe path encoding', () => {
    expect(hatchetRunUrl('run/with spaces', {
      hatchetDashboardUrl: 'http://hatchet.example.test///',
      hatchetDashboardTenantId: 'tenant/one',
    })).toBe('http://hatchet.example.test/tenants/tenant%2Fone/runs/run%2Fwith%20spaces');
  });

  it('uses local dashboard defaults when configuration is unavailable', () => {
    expect(hatchetRunUrl('run-1', {})).toBe(
      'http://127.0.0.1:8080/tenants/707d0855-80ab-4e1f-a156-f1c4546cbf52/runs/run-1',
    );
  });
});
