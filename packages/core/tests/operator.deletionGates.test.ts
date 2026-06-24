import {
    assertDeletionGateRegistryValid,
    deletionGateSurfaces,
    validateDeletionGate,
    type DeletionGateSurface,
} from '../src/operator/deletionGates.js';

describe('deletion gate registry', () => {
    it('keeps current surfaces as candidates until approval evidence exists', () => {
        expect(deletionGateSurfaces.length).toBeGreaterThan(0);
        expect(() => assertDeletionGateRegistryValid()).not.toThrow();
        expect(deletionGateSurfaces.every((surface) => surface.status === 'candidate')).toBe(true);
    });

    it('rejects approved surfaces without complete evidence', () => {
        const surface: DeletionGateSurface = {
            id: 'test',
            description: 'test surface',
            files: ['x.ts'],
            replacementPath: 'replacement',
            status: 'approved',
        };

        expect(validateDeletionGate(surface)).toEqual(expect.arrayContaining([
            'parityTest',
            'failureDrill',
            'rollbackFlag',
            'metricsCoverage',
            'retentionBehavior',
            'approver',
            'approvedAt',
        ]));
        expect(() => assertDeletionGateRegistryValid([surface])).toThrow('Deletion gate approval evidence is incomplete');
    });
});
